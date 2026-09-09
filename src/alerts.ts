import type { Env } from './types'

export type AlertType = 'kv_quota' | 'tier_degrade' | 'fallback_failure' | 'multimodal_failure' | 'gateway_5xx'

interface DebounceState {
  lastSent: number
  /**
   * S5（2026-09-06）语义修正：`count` = **自上次实际推送以来被抑制（静默丢弃）的次数**。
   *
   * 旧语义是"累计总次数、从不清零"，导致告警文案说谎：生产 KV 实测
   * `alert:debounce:tier_degrade:group:cc` = {"lastSent":1788543450363,"count":71}，
   * lastSent 是 2026-09-05 01:37:30 CST，而文案写死"过去 5 分钟内该问题共发生 71 次" ——
   * 71 是这个键创建以来的全时段总数，不是 5 分钟内的数字。
   * 告警是用户观测降级的唯一入口，数字说谎会直接误导故障判断。
   *
   * 新语义：推送后清零，下个窗口重新累计；文案改为"距上次通知期间"并带上真实窗口长度。
   */
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
/**
 * S5（2026-09-06）：返回 `suppressed`（被抑制次数）+ `silentMs`（距上次推送的真实间隔），
 * 供调用方生成不说谎的文案；推送后 count 清零。
 */
async function checkDebounce(env: Env, type: AlertType, scope: string): Promise<{ ok: boolean; suppressed: number; silentMs: number }> {
  const key = `alert:debounce:${type}:${scope}`
  const raw = await env.KV.get(key)
  const now = Date.now()
  const windowMs = DEBOUNCE_MS[type]

  if (raw) {
    try {
      const state = JSON.parse(raw) as DebounceState
      const suppressed = Number.isFinite(state.count) ? state.count : 0
      if (now - state.lastSent < windowMs) {
        // 窗口期内：累计被抑制次数，不发送
        await env.KV.put(key, JSON.stringify({ lastSent: state.lastSent, count: suppressed + 1 }))
        await countKvWrite(env)
        return { ok: false, suppressed: suppressed + 1, silentMs: now - state.lastSent }
      }
      // 窗口已过：推送，并把被抑制计数清零（S5：不再无限累加）
      await env.KV.put(key, JSON.stringify({ lastSent: now, count: 0 }))
      await countKvWrite(env)
      return { ok: true, suppressed, silentMs: now - state.lastSent }
    } catch { /* fall through */ }
  }

  // 首次触发
  await env.KV.put(key, JSON.stringify({ lastSent: now, count: 0 }))
  await countKvWrite(env)
  return { ok: true, suppressed: 0, silentMs: 0 }
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
    await countKvWrite(env)
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
  const { ok, suppressed, silentMs } = await checkDebounce(env, type, scope)
  if (!ok) {
    // 防抖窗口内不推送，但仍记录后台日志
    await recordAlert(env, type, detail, title)
    return
  }

  let text = `${title}\n${detail}`
  if (suppressed > 0) {
    // S5（2026-09-06）：文案基于真实的静默区间，不再写死"过去 5 分钟"。
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

// ===== KV 写计数器（buffer 20 才读+写，2026-09-09 优化） =====
let kvWriteBuffer = 0

export async function countKvWrite(env: Env): Promise<void> {
  kvWriteBuffer++
  const today = new Date().toISOString().slice(0, 10)
  const key = `alert:kv_count:${today}`

  // 2026-09-09 优化：buffer 未满 20 时完全不碰 KV（原来每次调用都 KV.get 检查阈值，
  // 失败风暴时 countKvWrite 被高频调用 → 每次 KV.get 放大 → CPU 尖峰 → 1102 元凶之一）。
  // 现在攒满 20 次才读+写（含阈值检查），把 KV 读放大降到 1/20。
  if (kvWriteBuffer < 20) return

  // 每 20 次批量读+写（含阈值检查）
  try {
    const raw = await env.KV.get(key)
    const stored = raw ? parseInt(raw, 10) : 0
    const total = stored + kvWriteBuffer

    if (total >= Math.floor(KV_WRITE_DAILY_LIMIT * KV_WRITE_ALERT_PCT)) {
      const warnedKey = `alert:kv_warned:${today}`
      const warned = await env.KV.get(warnedKey)
      if (!warned) {
        // 【修复互递归】先写 warnedKey，再调用 sendAlert
        // sendAlert -> checkDebounce -> countKvWrite 会再次进到这里
        // 如果不先写，递归层会读到 warned=null，无限递归
        await env.KV.put(warnedKey, '1', { expirationTtl: 86400 })
        await sendAlert(env, 'kv_quota', 'global',
          `⚠️ <b>KV 写入配额预警</b>`,
          `当前写入量约 ${total} / ${KV_WRITE_DAILY_LIMIT} (${Math.round(total / KV_WRITE_DAILY_LIMIT * 100)}%)\n每日剩余配额：${KV_WRITE_DAILY_LIMIT - total} 次`
        )
      }
    }

    // 批量写回 KV
    await env.KV.put(key, String(total), { expirationTtl: 86400 * 2 })
    kvWriteBuffer = 0
  } catch { /* skip */ }
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