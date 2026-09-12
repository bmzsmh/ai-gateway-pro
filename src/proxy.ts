import { Context } from 'hono'
import { getProvider, getProviders, getModelGroup, getModelGroups, getActiveProviders } from './storage'
import {
  KV_KEYS,
  KEY_HEALTH_COOLDOWN_MS,
  KEY_HEALTH_MAX_FAILURES,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_GROUP_SUBREQUEST_BUDGET,
  FAKE_SUCCESS_COOLDOWN_MS,
  KEY_COOLDOWN_401_MS,
  KEY_COOLDOWN_403_MS,
  KEY_COOLDOWN_503_MS,
  KEY_COOLDOWN_408_MS,
  SAFE_RESOURCE_ID_RE,
  SAFE_MODEL_ID_RE,
  MAX_MODEL_STRING_LENGTH,
} from './config'
import type { Env, ProxyRequestBody, Provider } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { maskKey } from './telemetry'
import { sendAlert, countKvWrite, detectMultimodalFailure, hasImageContent, type AlertType } from './alerts'

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number
  cooldownUntil?: number
}
type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

function getRequestId(c: Context<{ Bindings: Env }>): string {
  return (c as any).get('requestId') || c.req.header('X-Request-ID') || crypto.randomUUID()
}

/** 遥测写入一律异步、不阻塞响应；没有 ExecutionContext（如测试环境）时退化为 fire-and-forget。 */
function safeWaitUntil(c: Context<{ Bindings: Env }>, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise)
  } catch {
    promise.catch((err) => console.warn('[telemetry] 后台任务失败:', err))
  }
}

function getPositiveInt(value: string | undefined, fallback: number, max?: number): number {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return max ? Math.min(parsed, max) : parsed
}

function getRequestTimeoutMs(env: Env): number {
  return getPositiveInt(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 600_000)
}

// ===== P0-1 状态机辅助（2026-08-25 第二轮审查修复） =====
// 语义：
//   failures 累加无上限；demotedAt 只设置一次（降权起点）。
//   失败发生在 cooldown 内（now - demotedAt < COOLDOWN）→ 不刷新 demotedAt（P0-1 原始目标：失败不持续延长同一个 cooldown）。
//   失败发生在 probation 阶段（now - demotedAt >= COOLDOWN，即冷却已到期、key 正在被试用）→ 重置 demotedAt = now，
//   启动一个新的完整 cooldown（第二轮审查补充：probation 失败后必须重新冷却，否则旧 demotedAt 过期会导致每个请求都立即再次 probation）。
export function markKeyFailure(h: KeyHealth | undefined, now = Date.now()): KeyHealth {
  const health = h && typeof h === 'object' ? { ...h } : { failures: 0, lastFailed: false }
  health.failures = (health.failures || 0) + 1
  health.lastFailed = true
  if (health.failures >= KEY_HEALTH_MAX_FAILURES) {
    if (!health.demotedAt || now - health.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
      health.demotedAt = now
    }
  }
  return health
}

/**
 * S9（2026-09-06）：假成功专用健康度标记 —— 让「识破」变成「记住」。
 *
 * 与 markKeyFailure 的区别：额外设 `cooldownUntil = now + FAKE_SUCCESS_COOLDOWN_MS`。
 * 这一个字段带来三个连锁效果，全部依赖既有机制、无需改动它们：
 *   1. `writeHealth` 的 P1 过滤白名单包含 `cooldownUntil > now` → **立刻落 KV**，
 *      跨 isolate 可见（原来 failures=1 永远不落库，坏成员的失败记忆每请求归零）。
 *   2. `isMemberCoolingDown` 判定该 provider 全 key 冷却 → `buildRotationOrder` 跳过该成员；
 *      主力全部假成功时 candidates 为空 → 直接降级 backup，**零无效上游调用**。
 *   3. 冷却期满后 `cooldownUntil <= now` → 成员自动回到候选池 → **CC 自愈返回**。
 *
 * failures 仍然累加（与 markKeyFailure 一致）：假成功是**真故障**，不同于 429 限流，
 * 累计到 KEY_HEALTH_MAX_FAILURES 应当进入 demoted 降权，这与既有语义一致。
 */
export function markFakeSuccess(h: KeyHealth | undefined, now = Date.now()): KeyHealth {
  const health = markKeyFailure(h, now)
  health.cooldownUntil = now + FAKE_SUCCESS_COOLDOWN_MS
  return health
}

/** 429 带 Retry-After：按上游指定精确时间冷却；无头则走失败计数（markKeyFailure）。 */
/**
 * A3（2026-09-04）：429 = 上游限流，不是 key 失效。
 * - 带 Retry-After → 按上游指定时间精确冷却
 * - 不带 Retry-After → 用 DEFAULT_RATE_LIMIT_COOLDOWN_MS（60s）兜底冷却
 * 两种情况都**不累加 failures、不设置 demotedAt**：避免「额度满但一时限流」的账号
 * 被 failures 无限累积推入永久降权（上游账号级 TPM 限流场景）。
 * 冷却期满自动恢复；冷却状态由 cooldownUntil 单独表达，指针轮转据此决定是否跳过。
 */
export function applyRateLimitHealth(h: KeyHealth | undefined, retryAfterMs: number | null, now = Date.now()): KeyHealth {
  const base = h && typeof h === 'object' ? { ...h } : { failures: 0, lastFailed: false }
  const cooldownMs = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
  return {
    ...base,
    // failures 保持原值（不累加）——429 不计入降权计数
    failures: base.failures || 0,
    lastFailed: true,
    cooldownUntil: now + cooldownMs,
  }
}

// ===== 错误分类冷却（2026-09-09，参考 m365 Copilot2API CooldownForCategory）=====
// 辅助：从 env 读取可覆盖的冷却时长（参数配置化）
function getEnvCooldownMs(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key] as unknown
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

/**
 * 错误分类冷却：为 401/403/5xx/408 分配差异化冷却时长。
 *
 * 设计依据（m365 实战验证）：
 *   · 401（认证过期/key 失效）与 403（禁止/封禁）是「key 确定性失效」——
 *     重复请求只会继续失败，且这类错误**不随上游恢复而恢复**（key 本身坏了）。
 *     处理：设置较长冷却 + 保留 failures 累积（仍可触达降权），冷却期内 isMemberCoolingDown
 *     直接跳过该 key → 零无效上游调用。
 *   · 503/5xx（上游过载）与 408（超时）是「临时抖动」——上游可能 30 秒后就恢复。
 *     处理：短冷却 + 保留 failures 累积（冷却期满自动回归候选池 → CC 自愈）。
 *
 * 与 429 的区别：429 不累加 failures（限流是「额度问题」，冷却后自然恢复）；
 * 本函数对 401/403/5xx/408 **保留 failures 累积**（这些是「质量问题」，5 次后应降权淘汰）。
 */
export function applyClassifiedHealth(
  env: Env,
  h: KeyHealth | undefined,
  status: number,
  now = Date.now(),
): KeyHealth {
  const base = h && typeof h === 'object' ? { ...h } : { failures: 0, lastFailed: false }
  let cooldownMs: number
  switch (status) {
    case 401:
      cooldownMs = getEnvCooldownMs(env, 'KEY_COOLDOWN_401_MS', KEY_COOLDOWN_401_MS)
      break
    case 403:
      cooldownMs = getEnvCooldownMs(env, 'KEY_COOLDOWN_403_MS', KEY_COOLDOWN_403_MS)
      break
    case 503:
    case 500:
    case 502:
    case 504:
      cooldownMs = getEnvCooldownMs(env, 'KEY_COOLDOWN_503_MS', KEY_COOLDOWN_503_MS)
      break
    case 408:
      cooldownMs = getEnvCooldownMs(env, 'KEY_COOLDOWN_408_MS', KEY_COOLDOWN_408_MS)
      break
    default:
      cooldownMs = KEY_HEALTH_COOLDOWN_MS
  }
  return {
    ...base,
    failures: (base.failures || 0) + 1,
    lastFailed: true,
    cooldownUntil: now + cooldownMs,
  }
}

function getMaxBodyBytes(env: Env): number {
  return getPositiveInt(env.MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_REQUEST_BODY_BYTES, 20 * 1024 * 1024)
}

/** Key 健康度内存缓存：isolate 级 Map，短 TTL。读时先查内存命中则省一次 KV 读；
 *  写入仍同步 await 写 KV（不改为 waitUntil 异步，避免更新丢失），同时同步更新内存缓存，
 *  本 isolate 内后续请求立刻可见。
 *
 *  S10（2026-09-06）**非对称 TTL** —— 修「冷却期内偶发 1 次无效上游调用」：
 *
 *  旧行为：无论内容一律缓存 5s。风险场景是「缓存里是空健康度」——
 *    isolate A 在 t=0 读到空健康度并缓存到 t=5s；t=1s 时 isolate B 发现成员坏了、写入冷却；
 *    t=2s 请求又落到 isolate A → 命中它那份**已过时的空缓存** → 明知有冷却却仍打一次坏成员。
 *    L5-3 实测就是这 1 次多余调用。
 *
 *  新行为：按内容分档，风险大的那一档几乎不缓存。
 *    · 非空（存在降权/冷却 key）→ 5s：这份缓存**已经包含**坏 key 信息，续用是安全的，
 *      而且这正是高频跳过判定的热路径，缓存收益最大。
 *    · 空（全部健康）→ 1s：恰恰是「我以为都好其实不好」的危险档，把陈旧窗口压到 1/5。
 *
 *  代价：全健康时每 provider 每秒最多多 1 次 KV 读。KV 读免费额度 10 万/日、且读不是
 *  当初 P1 优化的约束对象（P1 省的是**写**），个人量级完全可接受。
 *
 *  诚实的边界：这是**收窄**而非**消除**。跨 isolate + KV 最终一致性下，
 *  1s 内的竞态窗口在架构上无法归零；要归零得引入 Durable Object 强一致状态，
 *  那是架构改造，不在本次范围。 */
const HEALTH_CACHE_TTL_DIRTY_MS = 5_000
const HEALTH_CACHE_TTL_CLEAN_MS = 1_000
const healthMemoryCache = new Map<string, { data: HealthMap; expiresAt: number }>()
/** P2（2026-09-08）：同 isolate 内已清空的 provider 集合 —— 避免健康 member 恢复后每请求都 delete KV。 */
const clearedHealthKeys = new Set<string>()
/** P3（2026-09-08）：请求内 provider 健康数据缓存 —— buildRotationOrder 遍历同一 provider 的多个成员时只读一次 KV。 */
const requestHealthCache = new Map<string, HealthMap>()

/** S10：按健康度内容选 TTL —— 有坏 key 记录可放心久缓存，全健康则只缓存极短时间。 */
export function healthCacheTtl(data: HealthMap): number {
  return Object.keys(data).length > 0 ? HEALTH_CACHE_TTL_DIRTY_MS : HEALTH_CACHE_TTL_CLEAN_MS
}

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const cached = healthMemoryCache.get(providerId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data
  }
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  let data: HealthMap = {}
  if (raw) {
    try {
      data = JSON.parse(raw) as HealthMap
    } catch {
      console.warn(`[health] invalid health data for provider ${providerId}; resetting`)
      data = {}
    }
  }
  healthMemoryCache.set(providerId, { data, expiresAt: Date.now() + healthCacheTtl(data) })
  return data
}

/**
 * P4（2026-09-08）：健康度规范化 —— 排序 key 后输出稳定 JSON，用于跨次写入的内容 diff。
 * 不做规范化会因对象 key 插入顺序不同产生假差异（同一状态被判为"变了"而重复写 KV）。
 */
function canonicalHealth(data: HealthMap): string {
  const keys = Object.keys(data).sort()
  const out: HealthMap = {} as HealthMap
  for (const k of keys) {
    const v = data[k]
    // 归一化：省略 undefined 字段，数值统一（避免 0 与 undefined 造成假差异）
    out[k] = {
      failures: v.failures || 0,
      lastFailed: !!v.lastFailed,
      ...(v.demotedAt ? { demotedAt: v.demotedAt } : {}),
      ...(v.cooldownUntil ? { cooldownUntil: v.cooldownUntil } : {}),
    }
  }
  return JSON.stringify(out)
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    // P1-2026-08-24：只有达到降权阈值（failures>=5）或冷却中的 key 才写 KV。
    // 1~4 次普通失败仅内存缓存（isolate 内短 TTL），不落 KV —— 消除偶发失败的 KV 写入。
    // 降权（demotedAt）与冷却（cooldownUntil）是路由必需状态，仍需持久化跨 isolate 生效。
    // S9（2026-09-06）：假成功走 markFakeSuccess 会设 cooldownUntil → 命中本白名单 → 自动落 KV。
    if (v.failures >= KEY_HEALTH_MAX_FAILURES || (v.cooldownUntil && v.cooldownUntil > Date.now())) filtered[k] = v
  }
  // 先同步更新内存缓存，本 isolate 内后续请求立刻可见（S10：TTL 按内容分档）
  healthMemoryCache.set(providerId, { data: filtered, expiresAt: Date.now() + healthCacheTtl(filtered) })
  if (Object.keys(filtered).length > 0) {
    // P4（2026-09-08）：canonical diff —— 与 KV 里已持久化的内容做精确比对，
    // 只在「规范化后的 JSON 不同」时才写。这样：
    //   · 429 刷新冷却窗口（failures/cooldownUntil 变化）→ 内容变了，正常写（路由必需）
    //   · 同一冷却期内重复失败（failures 5→6→7…）→ 内容未变，跳过写
    //   · 首次跨过降权阈值 → 内容从 {} 变为有值，写
    // 稳态（成员持续坏/持续好）下每个 provider 每个冷却周期只写 1 次。
    const canonical = canonicalHealth(filtered)
    try {
      const prevRaw = await env.KV.get(HEALTH_KEY(providerId))
      let prevCanonical = ''
      if (prevRaw) {
        try { prevCanonical = canonicalHealth(JSON.parse(prevRaw) as HealthMap) } catch { /* ignore */ }
      }
      if (prevCanonical !== canonical) {
        clearedHealthKeys.delete(providerId)
        await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
        await countKvWrite(env)
      }
      // 内容未变 → 保持 KV 原样，不重复写
    } catch { /* skip */ }
  } else {
    // 全部健康 → 清理 KV 残留。
    // P4（2026-09-08）：delete 必须先确认 KV 里真有值；没有值则 delete 是 no-op，
    // 既不该写 KV 也不该计入配额（CF 对删除不存在的 key 不计费）。
    if (!clearedHealthKeys.has(providerId)) {
      try {
        const prevRaw = await env.KV.get(HEALTH_KEY(providerId))
        const prevHad = !!prevRaw && Object.keys(JSON.parse(prevRaw) as HealthMap).length > 0
        if (prevHad) {
          await env.KV.delete(HEALTH_KEY(providerId))
          await countKvWrite(env)
        }
        // 无论 KV 里有没有值，本 isolate 都已确认过，标记避免下次重复探测
        clearedHealthKeys.add(providerId)
      } catch {
        clearedHealthKeys.add(providerId)
      }
    }
  }
}

/** 只允许明确的客户端业务 Header，避免把认证/连接级 Header 泄露给上游。 */
function buildForwardHeaders(c: Context<{ Bindings: Env }>, providerApiType: string | undefined, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': c.req.header('Content-Type') || 'application/json',
  }

  const passthrough = [
    'accept',
    'user-agent',
    'x-request-id',
    'anthropic-beta',
    'openai-beta',
    'openai-organization',
    'openai-project',
  ]
  for (const name of passthrough) {
    const value = c.req.header(name)
    if (value) headers[name] = value
  }

  if (providerApiType === 'anthropic') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = c.req.header('anthropic-version') || '2023-06-01'
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * S7（2026-09-06）：删除死代码 `isRetryableGroupStatus`。
 *
 * S3 已移除唯一调用点（`tryMember` 里的 `if (!isRetryableGroupStatus(resp.status)) return resp`）。
 * 组路由现在的语义是「任何 >=400 都换下一个成员」，不再区分状态码是否可重试，
 * 因此这个函数没有任何调用方。保留它会让后来的人误以为组路由仍有状态码白名单。
 *
 * 注意：opencode.ts 里另有一个 `isRetryableMirrorStatus`，那是镜像回退用的，**仍在使用**，不要动。
 */

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId }。
 * 运行时入口的兜底校验：长度上限 + 格式白名单，防止构造超长/非法字符串
 * 污染遥测 KV key 或在未来代码路径中被拼接使用。管理端创建 provider/group
 * 时已按 SAFE_RESOURCE_ID_RE / SAFE_MODEL_ID_RE 校验过，这里对请求时的
 * providerId 做同样强度的校验，modelId 用更宽松的 SAFE_MODEL_ID_RE（它是
 * SAFE_RESOURCE_ID_RE 的超集，group 场景下 modelId 即 groupId 也能通过）。 */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  if (model.length > MAX_MODEL_STRING_LENGTH) return null
  const slashIndex = model.indexOf('/')
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null
  const providerId = model.substring(0, slashIndex)
  const modelId = model.substring(slashIndex + 1)
  if (!SAFE_RESOURCE_ID_RE.test(providerId)) return null
  if (!SAFE_MODEL_ID_RE.test(modelId)) return null
  return { providerId, modelId }
}

/** 请求体超出大小限制。区分于其他异常，让 catch 块能精确映射到 413 而不用猜字符串。 */
class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

/** 请求体不是合法 JSON，属于客户端输入错误（400），区分于内部异常（500）。 */
class InvalidJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidJsonError'
  }
}

async function parseProxyBody(c: Context<{ Bindings: Env }>): Promise<ProxyRequestBody | null> {
  const contentLength = Number(c.req.header('Content-Length') || 0)
  const maxBytes = getMaxBodyBytes(c.env)
  if (contentLength > maxBytes) {
    return null
  }
  const raw = await c.req.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new PayloadTooLargeError(`请求体过大，最大允许 ${Math.floor(maxBytes / 1024 / 1024)} MB`)
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as ProxyRequestBody
    // CPU 优化（2026-09-12）：缓存原始 raw，零拷贝转发时复用（避免大 body 二次 stringify）
    ;(parsed as ProxyRequestBody & { __rawBody?: string }).__rawBody = raw
    return parsed
  } catch {
    throw new InvalidJsonError('请求体不是合法 JSON')
  }
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (response.ok) return { success: true, message: '连接成功', statusCode: response.status }

    const errorBody = await response.text().catch(() => '')
    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return { success: false, message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}` }
  }
}

/**
 * S1（2026-09-06）：回归上游原版随机起点，已删除 A4 的 readGroupPointer / writeGroupPointer。
 * 保留 isMemberCoolingDown（A4 的有效部分）——它与随机起点不冲突，且是多账号 429 隔离的关键。
 */

/**
 * 判断组内成员（provider/model）是否处于「冷却中」。
 * 判定口径：该 provider 的**全部 enabled key** 都在 cooldownUntil 未到状态才算冷却。
 * 只要还有任意一把 key 可用，成员就不算冷却（避免多 key provider 被单 key 限流误伤）。
 */
export async function isMemberCoolingDown(env: Env, member: string, providerMap: Map<string, Provider>): Promise<boolean> {
  const parsed = parseModelId(member)
  if (!parsed) return false
  const provider = providerMap.get(parsed.providerId)
  if (!provider) return false
  const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled && k.key)
  if (enabledKeys.length === 0) return false
  try {
    // P3（2026-09-08）：请求内缓存 —— buildRotationOrder 遍历同一 provider 的多个成员时只读一次 KV。
    let healthData = requestHealthCache.get(parsed.providerId)
    if (!healthData) {
      healthData = await readHealth(env, parsed.providerId)
      requestHealthCache.set(parsed.providerId, healthData)
    }
    const now = Date.now()
    return enabledKeys.every(k => {
      const h = healthData![k.key]
      return !!(h?.cooldownUntil && h.cooldownUntil > now)
    })
  } catch {
    return false
  }
}

/**
 * S1（2026-09-06）随机轮转候选构建 —— 回归上游原版 `Math.random()` 起点语义。
 *
 * CPU 优化（2026-09-12）：批量冷却检查。
 * 原实现：对每个成员串行调用 isMemberCoolingDown → 每成员 1 次 KV.get + JSON.parse。
 * N 个成员 = N 次串行 KV 读，是 1102 CPU 超限的根因之一。
 * 现实现：收集去重 providerId，并行读取每个 provider 的 health（1 次/provider），
 * 然后在内存中判定冷却。KV 读次数从 N 降到 P（P = 去重 provider 数，通常 ≤ 3）。
 */
export async function buildRotationOrder(
  env: Env,
  primaryMembers: string[],
  providerMap: Map<string, Provider>,
): Promise<{ candidates: Array<{ member: string; idx: number }>; coolingCount: number; startIdx: number }> {
  // P3（2026-09-08）：每次构建轮转顺序前清空请求内缓存，避免跨请求污染。
  requestHealthCache.clear()
  const candidates: Array<{ member: string; idx: number }> = []
  let coolingCount = 0
  const startIdx = primaryMembers.length ? Math.floor(Math.random() * primaryMembers.length) : 0

  // 批量预取：收集所有成员涉及的 providerId，去重后并行读 health
  const providerIds = new Set<string>()
  for (const member of primaryMembers) {
    const parsed = parseModelId(member)
    if (parsed) providerIds.add(parsed.providerId)
  }
  const healthMap = new Map<string, HealthMap>()
  const now = Date.now()
  await Promise.all(
    Array.from(providerIds).map(async (pid) => {
      try {
        healthMap.set(pid, await readHealth(env, pid))
      } catch {
        healthMap.set(pid, {} as HealthMap)
      }
    })
  )

  // 在内存中判定冷却，无额外 KV 读
  for (let k = 0; k < primaryMembers.length; k++) {
    const idx = (startIdx + k) % primaryMembers.length
    const member = primaryMembers[idx]
    const parsed = parseModelId(member)
    if (!parsed) { candidates.push({ member, idx }); continue }
    const provider = providerMap.get(parsed.providerId)
    if (!provider) { candidates.push({ member, idx }); continue }
    const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled && k.key)
    if (enabledKeys.length === 0) { candidates.push({ member, idx }); continue }
    const healthData = healthMap.get(parsed.providerId) || {}
    const allCooling = enabledKeys.every(k => {
      const h = healthData[k.key]
      return !!(h?.cooldownUntil && h.cooldownUntil > now)
    })
    if (allCooling) coolingCount++
    else candidates.push({ member, idx })
  }
  return { candidates, coolingCount, startIdx }
}

/** 处理 /v1/chat/completions 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  const requestId = getRequestId(c)
  try {
    const body = await parseProxyBody(c)
    if (body === null) {
      return c.json({ error: { message: `请求体过大，最大允许 ${Math.floor(getMaxBodyBytes(c.env) / 1024 / 1024)} MB`, type: 'invalid_request_error', request_id: requestId } }, 413)
    }
    const model = body.model
    if (!model || typeof model !== 'string') {
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error', request_id: requestId } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({ error: { message: `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`, type: 'invalid_request_error', request_id: requestId } }, 400)
    }

    const { providerId, modelId } = parsed

    if (providerId === 'group') {
      const group = await getModelGroup(c.env, modelId)
      if (!group) return c.json({ error: { message: `模型组 "${modelId}" 不存在`, type: 'invalid_request_error', request_id: requestId } }, 404)
      if (!group.enabled) return c.json({ error: { message: `模型组 "${modelId}" 已禁用`, type: 'group_disabled', request_id: requestId } }, 403)
      if (group.members.length === 0) return c.json({ error: { message: `模型组 "${modelId}" 未配置成员模型`, type: 'configuration_error', request_id: requestId } }, 500)

      const isImageReq = hasImageContent(body)
      const activeProviders = await getActiveProviders(c.env)
      const activeProviderIds = new Set(activeProviders.map(p => p.id))
      const primaryMembers = group.members.filter(m => !m.startsWith('group/'))
      const backupGroups = group.members.filter(m => m.startsWith('group/'))
      let lastErr: Response | null = null
      let attempts = 0
      // 记录进入 backup 的标记（用于 fallback_failure 告警）
      let wentToBackup = false

      /**
       * S3（2026-09-06）：任何失败都继续下一个成员 —— 回归上游原版语义。
       *
       * 旧行为（v1.2.2 引入的回归）：`if (!isRetryableGroupStatus(resp.status)) return resp`
       * 把单个成员的「不可重试」状态码（400/404/413/422 等）直接返回给客户端，
       * 整组其余成员和 backup 组全部被跳过——一个成员配错模型名就能打死整组。
       *
       * 新行为：`resp.status < 400` 才算成功；其余一律记入 lastErr 并 `return null`（继续轮转）。
       * 组路由的语义本来就是「这个成员不行就换下一个」，不需要区分错误可否重试。
       * 客户端参数错误（缺 model / model 格式错）在进入组路由之前已被拦截，
       * 所以这里剩下的 4xx 基本都是「该成员自身的问题」而非「请求本身的问题」。
       */
      const tryMember = async (member: string): Promise<Response | null> => {
        if (attempts >= MAX_GROUP_SUBREQUEST_BUDGET) return null
        const memberParsed = parseModelId(member)
        if (!memberParsed) return null
        if (!activeProviderIds.has(memberParsed.providerId)) {
          console.log(`[proxy][group:${modelId}] 跳过非 active provider: ${memberParsed.providerId}`)
          return null
        }
        attempts++
        const resp = await forwardToProviderModel(c, memberParsed.providerId, memberParsed.modelId, body, model)
        if (resp.status < 400) return resp
        lastErr = resp
        console.log(`[proxy][group:${modelId}] 成员 ${member} 失败 HTTP ${resp.status}，尝试下一个`)
        return null
      }

      if (primaryMembers.length > 0) {
        // —— S1/S2（2026-09-06）：随机起点 + 遍历全部主力成员 ——
        //   · 起点随机（回归上游原版），坏成员影响面 = 1/N，不再有粘滞指针放大故障
        //   · 遍历**全部**候选，不再受「主力+backup 共享 6 次」预算限制 → backup 必然拿到机会
        //   · 仍跳过全 key 冷却成员（A3 429 精确冷却在此生效）
        //   · 无 KV 读写：省掉每次路由的指针读 + 推进写
        const providerMap = new Map(activeProviders.map(p => [p.id, p]))
        const { candidates, coolingCount, startIdx } = await buildRotationOrder(c.env, primaryMembers, providerMap)
        if (coolingCount > 0) {
          console.log(`[proxy][group:${modelId}] 随机起点=${startIdx}，${coolingCount}/${primaryMembers.length} 成员冷却中（已跳过）`)
        }
        for (const cand of candidates) {
          const resp = await tryMember(cand.member)
          if (resp) return resp
        }
      }

      // —— 主力组全部失败告警（即使 backup 组可能成功） ——
      if (primaryMembers.length > 0 && backupGroups.length > 0) {
        safeWaitUntil(c, sendAlert(c.env, 'tier_degrade', `group:${modelId}`,
          `⚠️ <b>梯队已降级</b>：${modelId} → ${backupGroups.join(', ')}`,
          `主力组 ${primaryMembers.length} 个成员全部不可用（降权/禁用），请求已自动降级到备用组 ${backupGroups.join(', ')}\n${isImageReq ? '⚠️ 原始请求含图片，备用组可能不支持图片识别' : ''}`
        ))
      }

      for (const subRef of backupGroups) {
        if (attempts >= MAX_GROUP_SUBREQUEST_BUDGET) break
        const subParsed = parseModelId(subRef)
        if (!subParsed || subParsed.providerId !== 'group') continue
        const subGroup = await getModelGroup(c.env, subParsed.modelId)
        if (!subGroup?.enabled || subGroup.members.length === 0) continue
        wentToBackup = true
        const subPrimary = subGroup.members.filter(m => !m.startsWith('group/'))
        // S1/S2（2026-09-06）：backup 组同样随机起点 + 遍历全部成员。
        // 与主力一致的语义（旧版 backup 也是 Math.random 起点，但与主力共享 6 次预算而饿死）。
        const subStart = subPrimary.length ? Math.floor(Math.random() * subPrimary.length) : 0
        console.log(`[proxy][group:${modelId}] 降级到 backup ${subRef}，随机起点=${subStart}/${subPrimary.length}`)
        for (let k = 0; k < subPrimary.length; k++) {
          const resp = await tryMember(subPrimary[(subStart + k) % subPrimary.length])
          if (resp) return resp
        }
      }

      if (lastErr) {
        // —— fallback_failure 告警：primary 全败且 backup 也未能成功 ——
        const finalErr = lastErr as Response
        const detail = await finalErr.text().catch(() => '')
        const status = finalErr.status || 502
        if (backupGroups.length > 0) {
          safeWaitUntil(c, sendAlert(c.env, 'fallback_failure', `group:${modelId}`,
            `🚨 <b>自动切换失败</b>：${modelId}`,
            `原始请求 ${isImageReq ? '（含图片）' : '（文本）'} 已从主力降级到备用组，但备用组也未返回成功\n路径：${modelId} → ${backupGroups.join(', ')}\n备用组尝试成员失败，最终错误：HTTP ${status} ${detail.substring(0, 200)}`
          ))
        } else {
          safeWaitUntil(c, sendAlert(c.env, 'tier_degrade', `group:${modelId}`,
            `⚠️ <b>梯队已无可用成员</b>：${modelId}`,
            `主力组 ${primaryMembers.length} 个成员全部不可用（降权/禁用），且该组未配置 backup 组\n请检查 provider 状态`
          ))
        }
        return c.json({
          error: {
            message: `模型组 "${modelId}" 内所有可重试模型均失败`,
            type: 'group_exhausted',
            code: 'GROUP_EXHAUSTED',
            detail: detail.substring(0, 500),
            request_id: requestId,
          },
        }, status as Parameters<typeof c.json>[1])
      }
      return c.json({ error: { message: '模型组内没有可用模型', type: 'configuration_error', request_id: requestId } }, 500)
    }

    const directProvider = await getProvider(c.env, providerId)
    if (directProvider?.status === 'disabled') {
      return c.json({ error: { message: `提供商 "${directProvider.name}" 已禁用`, type: 'provider_disabled', request_id: requestId } }, 403)
    }

    return await forwardToProviderModel(c, providerId, modelId, body, model)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return c.json({ error: { message: err.message, type: 'request_too_large', request_id: requestId } }, 413)
    }
    if (err instanceof InvalidJsonError) {
      return c.json({ error: { message: err.message, type: 'invalid_request_error', request_id: requestId } }, 400)
    }
    // 未识别的异常（KV 故障、程序 bug 等）不是客户端输入的问题，不应该报 400。
    const error = err as Error
    console.error('[proxy] handleProxy 未预期的内部异常:', error)
    safeWaitUntil(c, sendAlert(c.env, 'gateway_5xx', 'handleProxy',
      `🔴 <b>网关内部异常</b>`,
      `位置：handleProxy\n错误：${error.message || error}`
    ))
    return c.json({ error: { message: '代理转发内部错误', type: 'internal_error', request_id: requestId } }, 500)
  }
}

/**
 * S4（2026-09-06）流式首包 SSE error 探测 —— 本次故障的**根因修复**。
 *
 * 问题：上游（实测 AMD `developer.amd.com.cn`）在忙时返回 `HTTP 200 + text/event-stream`，
 * 但流的第一个事件就是 `event: error` / `data: {"error":{...}}`。旧代码 `if (response.ok)`
 * 判成功 → 直传 body → 还把该 key 的 failures 清零 → 客户端 openai SDK 在
 * `_streaming.py:__stream__` 抛 APIError。网关**自认为成功**，因此：
 *   · 不推进/不换成员、不降级 backup 组、不发 tier_degrade 告警、不记 markKeyFailure
 * 这就是「CC 组不降 XX、零告警、直接跌客户端保底」的真正机制。
 *
 * 修复：只读第一个 chunk 做判定，然后把它拼回流继续转发（零额外延迟、不缓冲全流）。
 *   · 命中 error 结构 → 视为该成员失败（markKeyFailure + lastError），继续轮转下一个 key/成员
 *   · 未命中 → 用 ReadableStream 把首块 enqueue 回去，其余 chunk 原样透传
 *
 * 宽容判定原则（避免误杀）：只在**明确匹配 SSE error 事件或 error 对象**时判失败。
 *   · `: keep-alive` / `: ping` 等 SSE 注释行 → 放行
 *   · 正常 `data: {"choices":[...]}` → 放行
 *   · 正文里恰好出现 "error" 字样（如模型在讲错误处理）→ 不匹配（要求 error 是 JSON key 或 event 名）
 *
 * S8（2026-09-06）门槛修正 —— **必须按响应侧 content-type 判定，不能只看请求侧 stream 参数**。
 *
 * 实测依据：AMD 上游在 `stream: false` 时**同样**返回 `HTTP 200 + content-type: text/event-stream`
 * + `event: error`（本地 mock 复现 6/6）。S4 初版把门槛写成 `if (isStreamRequest && …)`，
 * 导致非流式请求命中假成功成员时，探测被完全跳过：
 *   · 客户端收到 `HTTP 200 + text/event-stream + event: error`（非流式 SDK 直接解析失败）
 *   · 更糟的是走到下面的 `delete healthData[apiKey]` 把该 key 的失败计数**清零**
 *     —— 正是本次故障"网关自认为成功、永不降级"的同一条机制，只是换了非流式入口
 *
 * 修正后的门槛：`isStreamRequest || 响应 content-type 含 text/event-stream`。
 * 非 SSE 的普通 JSON 响应完全不进探测分支，多模态检测（response.clone().text()）路径不受影响。
 */
export const SSE_ERROR_RE = /(^|\n)\s*event:\s*error\b|"error"\s*:\s*[{"]/

/** 响应是否为 SSE 流（与请求是否声明 stream 无关）——S8 门槛判定依据。 */
export function isSseResponse(response: Response): boolean {
  return /text\/event-stream/i.test(response.headers.get('content-type') || '')
}

/** 读首块做 error 判定，返回 { isError, first, reader }。首块为空（立即 EOF）不判错。 */
export async function probeStreamHead(response: Response): Promise<{
  isError: boolean
  headText: string
  first: Uint8Array | undefined
  reader: ReadableStreamDefaultReader<Uint8Array>
} | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  try {
    const { value, done } = await reader.read()
    if (done || !value) return { isError: false, headText: '', first: undefined, reader }
    const headText = new TextDecoder().decode(value)
    return { isError: SSE_ERROR_RE.test(headText), headText, first: value, reader }
  } catch {
    // 首包读取失败（连接中断等）→ 交回调用方按失败处理
    try { await reader.cancel() } catch { /* ignore */ }
    return null
  }
}

/** 把已消费的首块拼回流，其余 chunk 原样透传。 */
export function restoreStream(first: Uint8Array | undefined, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first) controller.enqueue(first)
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) { controller.close(); return }
        if (value) controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    cancel(reason) {
      try { void reader.cancel(reason) } catch { /* ignore */ }
    },
  })
}

async function forwardToProviderModel(c: Context<{ Bindings: Env }>, providerId: string, modelId: string, body: ProxyRequestBody, routeKey: string): Promise<Response> {
  const requestId = getRequestId(c)
  try {
    const provider = await getProvider(c.env, providerId)
    if (!provider) return c.json({ error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error', request_id: requestId } }, 404)
    if (provider.status === 'disabled') return c.json({ error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled', request_id: requestId } }, 403)
    if (!provider.enabled) return c.json({ error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled', request_id: requestId } }, 403)

    const modelConfig = provider.models.find(m => m.id === modelId)
    if (!modelConfig) return c.json({ error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error', request_id: requestId } }, 404)
    if (!modelConfig.enabled) return c.json({ error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled', request_id: requestId } }, 403)

    const enabledKeys = provider.apiKeys.filter(k => k.enabled && k.key)
    // CPU 优化（2026-09-12）：零拷贝转发。
    // 原实现 `{ ...body, model: modelId }` 展开大 body + JSON.stringify(forwardBody) = 两次大对象操作。
    // 若 body.model === modelId（组路由透传成员模型时通常一致），直接复用原始 raw 字符串，零序列化。
    const rawBody = (body as ProxyRequestBody & { __rawBody?: string }).__rawBody
    const bodyModelSame = body.model === modelId
    const forwardBody = bodyModelSame && rawBody ? body : { ...body, model: modelId }
    const forwardBodyStr = bodyModelSame && rawBody
      ? rawBody
      : JSON.stringify(forwardBody)
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'
    const timeoutMs = getRequestTimeoutMs(c.env)
    // S6（2026-09-06）：上移到此处，让 opencode 分支也能用（原先声明在 opencode 分支之后）。
    const isStreamRequest = !!(body as { stream?: unknown }).stream || !!(forwardBody as { stream?: unknown }).stream

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method: c.req.method,
        subPath,
        search: url.search,
        body: forwardBodyStr,
        mirrorUrls: resolveOpenCodeUrls(c.env),
        timeoutMs,
      })
      const keyMasked = maskKey(enabledKeys[0]?.key || '')
      const opencodeKey = enabledKeys[0]?.key || 'public'

      /**
       * S6（2026-09-06）：opencode 路径的流式假成功探测。
       *
       * 必要性：`opencode/*-free` 是 backup 组 `group/xx` 的实际主力成员。S4 只覆盖了通用
       * provider 分支，opencode 走独立的 `proxyOpenCodeRequest`（官方 key 轮换 + 镜像回退），
       * 返回后同样是 `new Response(response.body, …)` 盲转 —— 同一个「HTTP 200 + 流内 error」
       * 黑洞在 backup 层没有被堵住。若 backup 成员也吐假成功，S4 修好的主力降级会重新落空。
       *
       * 处理：命中 error → 记 markKeyFailure 并返回 502，让组路由的 tryMember 看到 >=400
       * 继续换下一个成员；未命中 → 首块拼回流原样透传。
       */
      if ((isStreamRequest || isSseResponse(response)) && response.ok && response.body && c.env.FAKE_SUCCESS_PROBE === 'on') {
        const probe = await probeStreamHead(response)
        if (!probe || probe.isError) {
          try { await probe?.reader.cancel() } catch { /* ignore */ }
          const headSnippet = (probe?.headText || '').substring(0, 300)
          console.log(`[proxy] opencode/${modelId} key=${keyMasked} 假成功（HTTP 200 + 流内 error），判失败继续轮转: ${headSnippet.replace(/\s+/g, ' ')}`)
          safeWaitUntil(c, (async () => {
            const healthData = await readHealth(c.env, providerId)
            // S9（2026-09-06）：opencode 路径同样用 markFakeSuccess（落 KV + 60s 冷却 + 自愈）。
            healthData[opencodeKey] = markFakeSuccess(healthData[opencodeKey])
            await writeHealth(c.env, providerId, healthData)
          })())
          return new Response(JSON.stringify({
            error: {
              message: 'OpenCode 上游返回 HTTP 200 但流内为错误事件（假成功）',
              type: 'upstream_stream_error',
              detail: headSnippet,
              request_id: requestId,
            },
          }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-ID': requestId } })
        }
        const streamHeaders = copySafeResponseHeaders(response.headers)
        streamHeaders.set('X-Request-ID', requestId)
        return new Response(restoreStream(probe.first, probe.reader), {
          status: response.status,
          statusText: response.statusText,
          headers: streamHeaders,
        })
      }

      const headers = copySafeResponseHeaders(response.headers)
      headers.set('X-Request-ID', requestId)
      const clientResponse = new Response(response.body, { status: response.status, statusText: response.statusText, headers })

      // 非阻塞：健康度降权记录（2026-08-24 决策：已删遥测，仅保留健康度）
      safeWaitUntil(c, (async () => {
        // 健康度记录：424（镜像全部失败）或 5xx 记录失败
        if (response.status === 424 || response.status >= 500) {
          const healthData = await readHealth(c.env, providerId)
          healthData[opencodeKey] = markKeyFailure(healthData[opencodeKey])
          await writeHealth(c.env, providerId, healthData)
        }
      })())

      return clientResponse
    }

    if (enabledKeys.length === 0) return c.json({ error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error', request_id: requestId } }, 500)

    const cleanBase = provider.baseUrl.replace(/\/+$/, '')
    const apiBase = /\/v\d+$/i.test(cleanBase) ? cleanBase : `${cleanBase}/v1`
    const forwardUrl = `${apiBase}/${subPath}${url.search}`
    const healthData = await readHealth(c.env, providerId)
    const now = Date.now()
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []

    for (let i = 0; i < enabledKeys.length; i++) {
      const h = healthData[enabledKeys[i].key]
      if (h?.cooldownUntil && h.cooldownUntil > now) {
        demoted.push(i)
      } else if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
        if (!h.demotedAt) h.demotedAt = now
        if (now - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) probation.push(i)
        else demoted.push(i)
      } else if (h?.lastFailed) {
        unhealthy.push(i)
      } else {
        healthy.push(i)
      }
    }

    for (let i = healthy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[healthy[i], healthy[j]] = [healthy[j], healthy[i]]
    }
    const keyOrder = [...healthy, ...unhealthy, ...probation]
    // 只有所有正常/试用 key 都不可用时才强制尝试冷却中的 key，避免主动撞限流/坏 key。
    if (keyOrder.length === 0) keyOrder.push(...demoted)
    if (demoted.length > 0) console.log(`[proxy] ${providerId}: ${demoted.length} key(s) cooling/downranked`)
    // 降权/冷却中的 key 大概率还是会失败，没必要等满全额超时才失败转移到下一个候选——
    // 缩短它的超时能让"发现这个 provider 已经不行了 → 尝试下一个梯队成员/保底链"这个
    // 过程明显加快，只影响降权 key 的等待时间，不影响健康 key 的正常超时预算。
    const demotedSet = new Set(demoted)
    const demotedTimeoutMs = Math.max(Math.floor(timeoutMs / 4), 15_000)

    let lastError: Response | null = null
    let healthUpdated = false
    // S6（2026-09-06）：isStreamRequest 已上移到函数顶部（opencode 分支之前），此处不再重复声明。

    for (const keyIndex of keyOrder) {
      const apiKey = enabledKeys[keyIndex].key
      const keyMasked = maskKey(apiKey)
      const attemptStarted = Date.now()
      const effectiveTimeoutMs = demotedSet.has(keyIndex) ? demotedTimeoutMs : timeoutMs
      try {
        const forwardHeaders = buildForwardHeaders(c, provider.apiType, apiKey)
        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: forwardHeaders,
          body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : forwardBodyStr,
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        })

        if (response.ok) {
          // —— S4（2026-09-06）：流式请求先探测首包，识破「HTTP 200 + 流内 error」假成功 ——
          // S8（2026-09-06）：门槛改为「请求声明 stream **或** 响应 content-type 是 SSE」，
          // 因为 AMD 类上游在 stream:false 时同样返回 SSE + event: error（实测 6/6）。
          // CPU 优化（2026-09-12）：FAKE_SUCCESS_PROBE 开关，默认关闭。
          // 关闭时跳过 probeStreamHead（每响应一次 TextDecoder.decode + 拼流），
          // 成功响应直接透传，消除最大 CPU 热点。
          // 开启时恢复完整假成功探测逻辑（不变）。
          const probeEnabled = c.env.FAKE_SUCCESS_PROBE === 'on'
          if (probeEnabled && (isStreamRequest || isSseResponse(response)) && response.body) {
            const probe = await probeStreamHead(response)
            if (!probe) {
              // 首包读取失败：按该 key 失败处理，继续下一个 key
              healthData[apiKey] = markKeyFailure(healthData[apiKey])
              healthUpdated = true
              lastError = new Response(JSON.stringify({ error: { message: '流式响应首包读取失败', type: 'stream_head_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
              continue
            }
            if (probe.isError) {
              // 假成功：上游 HTTP 200 但流内立刻是 error 事件。
              // 关键点：**必须记 markKeyFailure**（旧代码在这里反而 delete 掉了失败计数），
              // 并且 return null 语义（continue）让上层组路由继续换成员/降级 backup。
              try { await probe.reader.cancel() } catch { /* ignore */ }
              // S9（2026-09-06）：markKeyFailure → markFakeSuccess，额外设 60s 冷却。
              // 只加一个 cooldownUntil 字段就让 writeHealth 的 P1 白名单收下它 → 落 KV 跨 isolate 可见
              // → 下个请求 isMemberCoolingDown 直接跳过该成员（零无效调用），冷却期满自动回归轮转。
              healthData[apiKey] = markFakeSuccess(healthData[apiKey])
              healthUpdated = true
              const headSnippet = probe.headText.substring(0, 300)
              console.log(`[proxy] ${providerId}/${modelId} key=${keyMasked} 假成功（HTTP 200 + 流内 error），判失败继续轮转: ${headSnippet.replace(/\s+/g, ' ')}`)
              lastError = new Response(JSON.stringify({
                error: {
                  message: `上游返回 HTTP 200 但流内为错误事件（假成功）`,
                  type: 'upstream_stream_error',
                  detail: headSnippet,
                },
              }), { status: 502, headers: { 'Content-Type': 'application/json' } })
              continue
            }
            // 真成功：清理健康度 + 把首块拼回流转发
            if (healthData[apiKey]?.failures > 0 || healthData[apiKey]?.cooldownUntil) {
              delete healthData[apiKey]
              healthUpdated = true
            }
            const streamHeaders = copySafeResponseHeaders(response.headers)
            streamHeaders.set('X-Request-ID', requestId)
            if (healthUpdated) await writeHealth(c.env, providerId, healthData)
            return new Response(restoreStream(probe.first, probe.reader), {
              status: response.status,
              statusText: response.statusText,
              headers: streamHeaders,
            })
          }

          if (healthData[apiKey]?.failures > 0 || healthData[apiKey]?.cooldownUntil) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          // —— 多模态"假成功"检测：200 但模型未识别图片 / reasoning token 预算不足 ——
          if (!isStreamRequest && hasImageContent(forwardBody) && c.env.FAKE_SUCCESS_PROBE === 'on') {
            safeWaitUntil(c, (async () => {
              try {
                const bodyText = await response.clone().text()
                const issue = detectMultimodalFailure(200, bodyText)
                if (issue) {
                  await sendAlert(c.env, 'multimodal_failure', `${providerId}:${modelId}`,
                    `🖼️ <b>多模态异常</b>：${providerId}/${modelId}`,
                    `${issue}\n请求模型：${providerId}/${modelId}`
                  )
                }
              } catch { /* 读取失败忽略 */ }
            })())
          }
          const headers = copySafeResponseHeaders(response.headers)
          headers.set('X-Request-ID', requestId)
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          // 2026-08-24 决策：已删遥测（请求日志/活跃/用量）记录，正常请求不再产生 KV 写。
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        }

        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
          healthData[apiKey] = applyRateLimitHealth(healthData[apiKey], retryAfter)
          healthUpdated = true
          lastError = response
          continue
        }

        if (response.status === 401 || response.status === 403 || response.status >= 500 || response.status === 408) {
          // 2026-09-09：错误分类冷却（参考 m365 CooldownForCategory）
          // 401/403 → 长冷却（10min/30min，key 确定性失效，避免反复试坏 key）
          // 5xx/503/408 → 短冷却（30s/15s，上游临时抖动，冷却后自动回归）
          // 保留 failures 累积（质量问题 5 次后降权淘汰），同时设 cooldownUntil 立即隔离
          healthData[apiKey] = applyClassifiedHealth(c.env, healthData[apiKey], response.status)
          healthUpdated = true
          lastError = response
          continue
        }

        const errorBody = await response.text().catch(() => '')
        const result = (() => {
          try { return JSON.parse(errorBody) } catch { return { error: { message: errorBody || `HTTP ${response.status}` } } }
        })()
        // —— 多模态 400 错误检测 ——
        if (hasImageContent(forwardBody)) {
          const multimodalIssue = detectMultimodalFailure(response.status, errorBody)
          if (multimodalIssue) {
            safeWaitUntil(c, sendAlert(c.env, 'multimodal_failure', `${providerId}:${modelId}`,
              `🖼️ <b>多模态异常</b>：${providerId}/${modelId}`,
              `${multimodalIssue}\n请求模型：${providerId}/${modelId}\nHTTP ${response.status}`
            ))
          }
        }
        return c.json(result, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        healthData[apiKey] = markKeyFailure(healthData[apiKey])
        healthUpdated = true
        lastError = new Response(JSON.stringify({ error: { message: error.message || '请求失败', type: 'proxy_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
        continue
      }
    }

    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'X-Request-ID': requestId })
      return new Response(JSON.stringify({
        error: {
          message: `所有 API Key 已用完，最后一次错误: HTTP ${lastError.status}`,
          type: 'key_exhausted',
          code: 'KEY_EXHAUSTED',
          detail: errorBody.substring(0, 500),
          request_id: requestId,
        },
      }), { status: lastError.status || 502, headers })
    }

    return c.json({ error: { message: '没有可用的 API Key', type: 'configuration_error', request_id: requestId } }, 500)
  } catch (err) {
    const error = err as Error
    return c.json({ error: { message: error.message || '代理转发内部错误', type: 'server_error', request_id: requestId } }, 500)
  }
}

export function parseRetryAfter(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, KEY_HEALTH_COOLDOWN_MS)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), KEY_HEALTH_COOLDOWN_MS))
  return 0
}

function copySafeResponseHeaders(source: Headers): Headers {
  const out = new Headers()
  source.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (
      lower === 'content-type'
      || lower === 'cache-control'
      || lower === 'retry-after'
      || lower === 'x-request-id'
      || lower.startsWith('anthropic-')
      || lower.startsWith('openai-')
    ) out.set(name, value)
  })
  if (!out.has('Cache-Control')) out.set('Cache-Control', 'no-store')
  return out
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀），仅 active provider */
export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getActiveProviders(c.env)
  const groups = await getModelGroups(c.env)
  const models: Array<{ id: string; provider: string; provider_name: string; object: string; created: number; owned_by: string }> = []

  // 兼容历史默认组；以后新增的 group 也自动展示。
  for (const group of groups) {
    if (!group.enabled || group.members.length === 0) continue
    models.push({
      id: `group/${group.id}`,
      provider: 'group',
      provider_name: `${group.name} [${group.members.length}个成员]`,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'group',
    })
  }

  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({ object: 'list', data: models })
}
