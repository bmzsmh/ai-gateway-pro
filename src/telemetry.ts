import { KV_KEYS, TELEMETRY_LOG_MAX_ENTRIES, TELEMETRY_USAGE_TTL_SECONDS } from './config'
import type { Env } from './types'

// ===== 第1层：统一遥测记录层 =====
// 目的：给后续的「请求可视化」「当前活跃模型」「消耗额度」三个功能提供同一份数据源，
// 避免各自在 proxy.ts 里插一份记录逻辑。
//
// 已知限制（KV 特性决定，个人/小规模场景可接受）：
// 1. 环形日志用 read-modify-write 实现，高并发下并发写可能互相覆盖丢条目 —— 这里只做
//    观测用途，不影响转发正确性，可接受。未来量大可迁移到 Durable Object。
// 2. 所有写入都应通过 c.executionCtx?.waitUntil() 触发，不阻塞对客户端的响应。

export interface RequestEvent {
  ts: number
  providerId: string
  modelId: string
  keyMasked: string
  status: number
  latencyMs: number
  requestId: string
  outcome: 'success' | 'retry' | 'fail'
  routeKey: string // 用户实际请求的 model 字段原文，如 "group/auto-task" 或 "openai/gpt-4o"
  tokensIn?: number
  tokensOut?: number
}

export interface LastActiveInfo {
  providerId: string
  modelId: string
  keyMasked: string
  ts: number
}

export interface UsageRecord {
  tokensIn: number
  tokensOut: number
  requests: number
}

const LOG_KEY = (providerId: string) => KV_KEYS.TELEMETRY_LOG_PREFIX + providerId
const LAST_ACTIVE_KEY = (scope: string) => KV_KEYS.TELEMETRY_ACTIVE_PREFIX + scope
const USAGE_KEY = (providerId: string, date: string) => KV_KEYS.TELEMETRY_USAGE_PREFIX + providerId + ':' + date

/** 掩码展示 Key，日志/UI 里绝不出现完整 Key。 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 追加一条请求事件到该 provider 的环形日志（最多保留 TELEMETRY_LOG_MAX_ENTRIES 条）。 */
export async function recordRequestEvent(env: Env, event: RequestEvent): Promise<void> {
  try {
    const key = LOG_KEY(event.providerId)
    const raw = await env.KV.get(key)
    const list: RequestEvent[] = raw ? JSON.parse(raw) : []
    list.push(event)
    if (list.length > TELEMETRY_LOG_MAX_ENTRIES) {
      list.splice(0, list.length - TELEMETRY_LOG_MAX_ENTRIES)
    }
    await env.KV.put(key, JSON.stringify(list))
  } catch (err) {
    // 遥测失败绝不能影响主转发链路，这里只打日志。
    console.warn(`[telemetry] recordRequestEvent 失败 (${event.providerId}):`, err)
  }
}

/** 记录某个「路由范围」当前正在使用的 provider/model/key。scope 可以是 providerId 本身，
 * 也可以是用户请求的原始 routeKey（比如 group/auto-task），两者都会各自维护一份。 */
export async function updateLastActive(env: Env, scope: string, info: LastActiveInfo): Promise<void> {
  try {
    await env.KV.put(LAST_ACTIVE_KEY(scope), JSON.stringify(info))
  } catch (err) {
    console.warn(`[telemetry] updateLastActive 失败 (${scope}):`, err)
  }
}

export async function getLastActive(env: Env, scope: string): Promise<LastActiveInfo | null> {
  const raw = await env.KV.get(LAST_ACTIVE_KEY(scope))
  return raw ? (JSON.parse(raw) as LastActiveInfo) : null
}

export async function getRequestLog(env: Env, providerId: string): Promise<RequestEvent[]> {
  const raw = await env.KV.get(LOG_KEY(providerId))
  return raw ? (JSON.parse(raw) as RequestEvent[]) : []
}

/** 按天累加某 provider 的 token 用量与请求次数（仅非流式且能解析出 usage 字段时才会有 token 数）。 */
export async function recordUsage(env: Env, providerId: string, tokensIn: number, tokensOut: number): Promise<void> {
  try {
    const key = USAGE_KEY(providerId, todayKey())
    const raw = await env.KV.get(key)
    const cur: UsageRecord = raw ? JSON.parse(raw) : { tokensIn: 0, tokensOut: 0, requests: 0 }
    cur.tokensIn += tokensIn
    cur.tokensOut += tokensOut
    cur.requests += 1
    await env.KV.put(key, JSON.stringify(cur), { expirationTtl: TELEMETRY_USAGE_TTL_SECONDS })
  } catch (err) {
    console.warn(`[telemetry] recordUsage 失败 (${providerId}):`, err)
  }
}

export async function getUsage(env: Env, providerId: string, date: string): Promise<UsageRecord | null> {
  const raw = await env.KV.get(USAGE_KEY(providerId, date))
  return raw ? (JSON.parse(raw) as UsageRecord) : null
}
