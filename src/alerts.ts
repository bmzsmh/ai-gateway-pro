import type { Env } from './types'

export type AlertType = 'kv_quota' | 'tier_degrade' | 'fallback_failure' | 'multimodal_failure' | 'gateway_5xx'

interface DebounceState {
  lastSent: number
  count: number
}

const DEBOUNCE_MS: Record<AlertType, number> = {
  kv_quota: 600_000,          // 10分钟
  tier_degrade: 300_000,      // 5分钟
  fallback_failure: 300_000,  // 5分钟
  multimodal_failure: 300_000, // 5分钟
  gateway_5xx: 300_000,       // 5分钟
}

const KV_WRITE_DAILY_LIMIT = 1000
const KV_WRITE_ALERT_PCT = 0.8

// ===== TG 消息推送 =====
async function sendTg(env: Env, text: string): Promise<boolean> {
  const token = env.TG_BOT_TOKEN
  if (!token) return false
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID || '8030792418',
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

// ===== 防抖检查 =====
async function checkDebounce(env: Env, type: AlertType, scope: string): Promise<{ ok: boolean; count: number }> {
  const key = `alert:debounce:${type}:${scope}`
  const raw = await env.KV.get(key)
  const now = Date.now()
  const windowMs = DEBOUNCE_MS[type]

  if (raw) {
    try {
      const state = JSON.parse(raw) as DebounceState
      if (now - state.lastSent < windowMs) {
        // 窗口期内：累计计数，不发送
        state.count++
        await env.KV.put(key, JSON.stringify(state))
        return { ok: false, count: state.count }
      }
      // 窗口已过：如果之前有累计，发送汇总消息
      state.count++
      state.lastSent = now
      await env.KV.put(key, JSON.stringify(state))
      return { ok: true, count: state.count }
    } catch { /* fall through */ }
  }

  // 首次触发
  await env.KV.put(key, JSON.stringify({ lastSent: now, count: 1 }))
  return { ok: true, count: 1 }
}

// ===== 后台记录告警 =====
export async function recordAlert(env: Env, type: AlertType, detail: string, title?: string): Promise<void> {
  const key = `alert:log:${type}`
  try {
    const raw = await env.KV.get(key)
    const list: any[] = raw ? JSON.parse(raw) : []
    list.push({ ts: Date.now(), type, detail, title: title || '', iso: new Date().toISOString() })
    if (list.length > 200) list.splice(0, list.length - 200)
    await env.KV.put(key, JSON.stringify(list))
  } catch (e) {
    console.warn('[alert] 记录告警失败:', e)
  }
}

// ===== 主动推送告警（带防抖 + 后台记录） =====
export async function sendAlert(
  env: Env,
  type: AlertType,
  scope: string,
  title: string,
  detail: string,
): Promise<void> {
  const { ok, count } = await checkDebounce(env, type, scope)
  if (!ok) {
    // 防抖窗口内不推送，但仍记录后台日志
    await recordAlert(env, type, detail, title)
    return
  }

  let text = `${title}\n${detail}`
  if (count > 1) {
    text += `\n\n📊 过去 5 分钟内该问题共发生 <b>${count}</b> 次`
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

      // 假成功：返回200但模型说没看到图片
      if (content.includes('没有看到图片') || content.includes('没有提供图片') || content.includes('未附上图片')) {
        return '假成功：返回200但模型未识别到图片（可能不支持图片）'
      }
      // reasoning 模型 token 预算不足
      if (finishReason === 'length' && reasoningTokens > 0 && textTokens === 0) {
        return `reasoning 模型 token 预算不足：finish_reason=length, reasoning_tokens=${reasoningTokens}, text_tokens=0（配置问题，非模型故障）`
      }
    } catch { /* not JSON, skip */ }
  }
  return null
}

// ===== KV 写计数器（每次读 KV 检查阈值，每 20 次写回持久化） =====
let kvWriteBuffer = 0

export async function countKvWrite(env: Env): Promise<void> {
  kvWriteBuffer++
  const today = new Date().toISOString().slice(0, 10)
  const key = `alert:kv_count:${today}`

  // 每次调用都检查阈值（读 KV 获取已持久化的计数）
  try {
    const raw = await env.KV.get(key)
    const stored = raw ? parseInt(raw, 10) : 0
    const total = stored + kvWriteBuffer

    if (total >= Math.floor(KV_WRITE_DAILY_LIMIT * KV_WRITE_ALERT_PCT)) {
      const warnedKey = `alert:kv_warned:${today}`
      const warned = await env.KV.get(warnedKey)
      if (!warned) {
        await sendAlert(env, 'kv_quota', 'global',
          `⚠️ <b>KV 写入配额预警</b>`,
          `当前写入量约 ${total} / ${KV_WRITE_DAILY_LIMIT} (${Math.round(total / KV_WRITE_DAILY_LIMIT * 100)}%)\n每日剩余配额：${KV_WRITE_DAILY_LIMIT - total} 次`
        )
        await env.KV.put(warnedKey, '1', { expirationTtl: 86400 })
      }
    }
  } catch { /* skip */ }

  // 每 20 次批量写回 KV（减少写入次数）
  if (kvWriteBuffer >= 20) {
    try {
      const raw = await env.KV.get(key)
      const count = raw ? parseInt(raw, 10) + kvWriteBuffer : kvWriteBuffer
      await env.KV.put(key, String(count), { expirationTtl: 86400 * 2 })
      kvWriteBuffer = 0
    } catch { /* skip */ }
  }
}

// ===== 获取告警历史 =====
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