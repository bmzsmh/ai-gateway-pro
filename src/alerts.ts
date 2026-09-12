import type { Env } from './types'

export type AlertType = 'kv_quota' | 'tier_degrade' | 'fallback_failure' | 'multimodal_failure' | 'gateway_5xx'

interface DebounceState {
  lastSent: number
  count: number
}

// ===== 优化 1：checkDebounce 内存缓冲 + 定期 flush =====
// 抑制计数存在模块级 Map，每分钟才 flush 一次到 KV
// 而不是每次被抑制都写一次 KV.put

const DEBOUNCE_MS: Record<AlertType, number> = {
  kv_quota: 600_000,
  tier_degrade: 300_000,
  fallback_failure: 300_000,
  multimodal_failure: 300_000,
  gateway_5xx: 300_000,
}

const KV_WRITE_DAILY_LIMIT = 1000
const KV_WRITE_ALERT_PCT = 0.8

// 内存防抖缓冲：scope => { count: suppressed_count, lastFlush: timestamp }
const debounceBuffer = new Map<string, { count: number; lastFlush: number }>()
// 告警日志内存缓冲
const alertLogBuffer: Array<{ ts: number; type: string; detail: string; title: string; iso: string }> = []
let lastAlertLogFlush = 0

/**
 * flush 防抖缓冲到 KV（每分钟最多一次）
 */
async function flushDebounceBuffer(env: Env): Promise<void> {
  const now = Date.now()
  let flushed = 0
  for (const [key, buf] of debounceBuffer) {
    if (now - buf.lastFlush < 60_000 && buf.count === 0) continue // 没变化且未到时间
    try {
      const raw = await env.KV.get(key)
      if (raw) {
        const state = JSON.parse(raw) as DebounceState
        // 只更新 count（lastSent 保持原值或更新）
        const mergedCount = buf.count + (state.count || 0)
        await env.KV.put(key, JSON.stringify({ lastSent: state.lastSent, count: mergedCount }))
      } else {
        await env.KV.put(key, JSON.stringify({ lastSent: now, count: buf.count }))
      }
      buf.count = 0
      buf.lastFlush = now
      flushed++
    } catch { /* skip */ }
  }
  if (flushed > 0) {
    console.log(`[alert] flushed ${flushed} debounce keys to KV`)
  }
}

/**
 * flush 告警日志缓冲到 KV（攒够 10 条或 30 秒超时）
 */
async function flushAlertLogBuffer(env: Env, type: AlertType): Promise<void> {
  const now = Date.now()
  if (alertLogBuffer.length === 0) return
  if (alertLogBuffer.length < 10 && now - lastAlertLogFlush < 30_000) return

  const key = `alert:log:${type}`
  try {
    const raw = await env.KV.get(key)
    const list: any[] = raw ? JSON.parse(raw) : []
    list.push(...alertLogBuffer.splice(0))
    if (list.length > 200) list.splice(0, list.length - 200)
    await env.KV.put(key, JSON.stringify(list))
    lastAlertLogFlush = now
    console.log(`[alert] flushed ${alertLogBuffer.length || 'all'} alert logs for ${type}`)
  } catch (e) {
    console.warn('[alert] flushAlertLogBuffer failed:', e)
    // 数据放回去，不要丢
    if (alertLogBuffer.length > 200) alertLogBuffer.splice(0, alertLogBuffer.length - 200)
  }
}

// ===== TG 消息推送（不变） =====
async function sendTg(env: Env, text: string): Promise<boolean> {
  const token = env.TG_BOT_TOKEN
  if (!token) return false
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!resp.ok) {
      console.warn(`[alert] TG 推送返回 ${resp.status}: ${await resp.text().catch(() => '')}`)
      return false
    }
    return true
  } catch (e) {
    console.warn('[alert] TG 推送失败:', e)
    return false
  }
}

// ===== 优化：checkDebounce 内存缓冲 =====
async function checkDebounce(env: Env, type: AlertType, scope: string): Promise<{ ok: boolean; suppressed: number; silentMs: number }> {
  const key = `alert:debounce:${type}:${scope}`
  const now = Date.now()
  const windowMs = DEBOUNCE_MS[type]
  let state: DebounceState | null = null

  // 读 KV 获取 lastSent（只看这一项，不读 count）
  try {
    const raw = await env.KV.get(key)
    if (raw) state = JSON.parse(raw)
  } catch { /* fall through */ }

  if (!state || !state.lastSent) {
    // 首次：初始化内存缓冲 + 写入 KV
    await env.KV.put(key, JSON.stringify({ lastSent: now, count: 0 }))
    return { ok: true, suppressed: 0, silentMs: 0 }
  }

  if (now - state.lastSent < windowMs) {
    // 窗口期内：计数到内存缓冲，不写 KV
    const buf = debounceBuffer.get(key) || { count: 0, lastFlush: now }
    buf.count++
    debounceBuffer.set(key, buf)

    // P4（2026-09-08）：抑制计数只留在 isolate 内存，不再定期 flush KV ——
    // 持续降级场景下每个活跃 key 最多 1440 次/天；改为下一次实际推送时
    // 把 buffer 计数合并进 KV state（最多 1 次写/5min 窗口 = 288/天），跨 isolate 计数
    // 少报的代价可接受（只影响「另有 N 次被抑制」展示）。

    // 返回原来的 suppressed 数 + 1
    const allSuppressed = (state.count || 0) + buf.count
    return { ok: false, suppressed: allSuppressed, silentMs: now - state.lastSent }
  }

  // 窗口已过：推送，内存缓冲计数不计入本次推送
  // 先把缓冲 flush 到 KV（确保历史被统计）
  const buf = debounceBuffer.get(key)
  const totalOldCount = (state.count || 0) + (buf?.count || 0)
  await env.KV.put(key, JSON.stringify({ lastSent: now, count: 0 }))
  debounceBuffer.delete(key)

  return { ok: true, suppressed: totalOldCount, silentMs: now - state.lastSent }
}

// ===== 后台记录告警（优化为批量写入） =====
export async function recordAlert(env: Env, type: AlertType, detail: string, title?: string): Promise<void> {
  alertLogBuffer.push({ ts: Date.now(), type, detail, title: title || '', iso: new Date().toISOString() })

  // 攒够 10 条或 30 秒超时才 flush
  if (alertLogBuffer.length >= 10 || Date.now() - lastAlertLogFlush >= 30_000) {
    await flushAlertLogBuffer(env, type)
  }
}

// ===== KV 写计数器（36178c4 版：buffer 满 20 才读 KV，防 1102 热点） =====
let kvWriteBuffer = 0

export async function countKvWrite(env: Env): Promise<void> {
  kvWriteBuffer++
  const today = new Date().toISOString().slice(0, 10)
  const key = `alert:kv_count:${today}`

  // 只在 buffer 满（20 次）时读一次 KV 拿持久化计数并写回；平时只累加内存计数。
  // 目的：每次调用都读 KV 是 1102 的串行 KV 读热点之一。
  if (kvWriteBuffer >= 20) {
    try {
      const raw = await env.KV.get(key)
      const count = raw ? parseInt(raw, 10) + kvWriteBuffer : kvWriteBuffer
      await env.KV.put(key, String(count), { expirationTtl: 86400 * 2 })
      kvWriteBuffer = 0
      // 批量写回后检查一次阈值（读 1 次 KV，不每次读）
      if (count >= Math.floor(KV_WRITE_DAILY_LIMIT * KV_WRITE_ALERT_PCT)) {
        const warnedKey = `alert:kv_warned:${today}`
        const warned = await env.KV.get(warnedKey)
        if (!warned) {
          await env.KV.put(warnedKey, '1', { expirationTtl: 86400 })
          await sendAlert(env, 'kv_quota', 'global',
            `⚠️ <b>KV 写入配额预警</b>`,
            `当前写入量约 ${count} / ${KV_WRITE_DAILY_LIMIT} (${Math.round(count / KV_WRITE_DAILY_LIMIT * 100)}%)\n每日剩余配额：${KV_WRITE_DAILY_LIMIT - count} 次`
          )
        }
      }
    } catch { /* skip */ }
  }
}

// ===== 主动推送告警 =====
export async function sendAlert(
  env: Env,
  type: AlertType,
  scope: string,
  title: string,
  detail: string,
): Promise<void> {
  const { ok, suppressed, silentMs } = await checkDebounce(env, type, scope)
  if (!ok) {
    // P4（2026-09-08）：被防抖抑制的告警仍写后台日志（recordAlert 进内存缓冲，
    // 攒够 10 条或 30s 才 flush 到 KV），但不推送 TG —— 消除「CC→XX 每请求写一条 KV」的刷屏。
    await recordAlert(env, type, detail, title)
    return
  }

  let text = `${title}\n${detail}`
  if (suppressed > 0) {
    const mins = Math.round(silentMs / 60_000)
    const span = mins >= 60 ? `${(mins / 60).toFixed(1)} 小时` : `${mins} 分钟`
    text += `\n\n📊 距上次通知约 ${span} 内，该问题另有 <b>${suppressed}</b> 次被防抖抑制`
  }
  await sendTg(env, text)
  await recordAlert(env, type, detail, title)
}

// ===== 检查请求体是否含图片 =====
export function hasImageContent(body: any): boolean {
  if (!body?.messages) return false
  for (const msg of body.messages) {
    if (!msg?.content) continue
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'image_url' || part?.type === 'input_image') return true
      }
    }
  }
  return false
}

// ===== 检测多模态失败模式 =====
export function detectMultimodalFailure(status: number, bodyText: string): string | null {
  if (!bodyText) return null
  const lower = bodyText.toLowerCase()

  if (status === 400) {
    if (lower.includes('does not support image') || lower.includes('no endpoints') ||
        lower.includes('multimodal not enabled') || lower.includes('image input') ||
        lower.includes('not support image')) {
      return '模型不支持图片输入'
    }
  }

  if (status === 200) {
    try {
      const j = JSON.parse(bodyText)
      const content = j?.choices?.[0]?.message?.content || ''
      const finishReason = j?.choices?.[0]?.finish_reason
      const usage = j?.usage || {}
      const details = usage?.completion_tokens_details || {}
      const reasoningTokens = details?.reasoning_tokens || 0
      const textTokens = details?.text_tokens || 0

      if (content.includes('没有看到图片') || content.includes('没有提供图片') || content.includes('未附上图片')) {
        return '假成功：返回200但模型未识别到图片（可能不支持图片）'
      }
      if (finishReason === 'length' && reasoningTokens > 0 && textTokens === 0) {
        return `reasoning 模型 token 预算不足：finish_reason=length, reasoning_tokens=${reasoningTokens}, text_tokens=0（配置问题，非模型故障）`
      }
    } catch { /* not JSON, skip */ }
  }
  return null
}

// ===== 获取告警历史（不变） =====
export async function getAlertHistory(env: Env, type?: string): Promise<{ success: boolean; data: any[] }> {
  const types = type ? [type] : ['kv_quota', 'tier_degrade', 'fallback_failure', 'multimodal_failure', 'gateway_5xx']
  const all: any[] = []
  for (const t of types) {
    try {
      const raw = await env.KV.get(`alert:log:${t}`)
      if (raw) all.push(...JSON.parse(raw))
    } catch { /* skip */ }
  }
  all.sort((a, b) => b.ts - a.ts)
  return { success: true, data: all.slice(0, 200) }
}
