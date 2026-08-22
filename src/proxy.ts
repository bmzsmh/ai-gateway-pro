import { Context } from 'hono'
import { getProvider, getProviders, getModelGroup, getModelGroups, getActiveProviders } from './storage'
import {
  KV_KEYS,
  KEY_HEALTH_COOLDOWN_MS,
  KEY_HEALTH_MAX_FAILURES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_TOTAL_GROUP_ATTEMPTS,
  SAFE_RESOURCE_ID_RE,
  SAFE_MODEL_ID_RE,
  MAX_MODEL_STRING_LENGTH,
} from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { recordRequestEvent, updateLastActive, recordUsage, maskKey, type RequestEvent } from './telemetry'
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

function getMaxBodyBytes(env: Env): number {
  return getPositiveInt(env.MAX_REQUEST_BODY_BYTES, DEFAULT_MAX_REQUEST_BODY_BYTES, 20 * 1024 * 1024)
}

/** Key 健康度内存缓存：isolate 级 Map，短 TTL（5s）。读时先查内存命中则省一次 KV 读；
 *  写入仍同步 await 写 KV（不改为 waitUntil 异步，避免更新丢失），同时同步更新内存缓存，
 *  本 isolate 内后续请求立刻可见。跨 isolate 最多 5s 不一致窗口，个人场景可接受。
 *  注意：内存 Map 会随 isolate 生命周期回收，低流量时命中率可能不高——收益实测算。 */
const HEALTH_MEMORY_CACHE_TTL_MS = 5_000
const healthMemoryCache = new Map<string, { data: HealthMap; expiresAt: number }>()

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const cached = healthMemoryCache.get(providerId)
  if (cached && cached.expiresAt > Date.now()) {
    // console.log(`[health][${providerId}] readHealth: MEMORY`)  // 验证用临时日志（已删）
    return cached.data
  }
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  // console.log(`[health][${providerId}] readHealth: KV`)        // 验证用临时日志（已删）
  let data: HealthMap = {}
  if (raw) {
    try {
      data = JSON.parse(raw) as HealthMap
    } catch {
      console.warn(`[health] invalid health data for provider ${providerId}; resetting`)
      data = {}
    }
  }
  healthMemoryCache.set(providerId, { data, expiresAt: Date.now() + HEALTH_MEMORY_CACHE_TTL_MS })
  return data
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0 || (v.cooldownUntil && v.cooldownUntil > Date.now())) filtered[k] = v
  }
  // 先同步更新内存缓存，本 isolate 内后续请求立刻可见
  healthMemoryCache.set(providerId, { data: filtered, expiresAt: Date.now() + HEALTH_MEMORY_CACHE_TTL_MS })
  // 同步写 KV（非 waitUntil 异步，避免 isolate 回收时更新丢失）
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
    await countKvWrite(env)
  } else {
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
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

function isRetryableGroupStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504 || status >= 500 || status === 401 || status === 403
}

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
    return JSON.parse(raw) as ProxyRequestBody
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

      const tryMember = async (member: string): Promise<Response | null> => {
        if (attempts >= MAX_TOTAL_GROUP_ATTEMPTS) return null
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
        if (!isRetryableGroupStatus(resp.status)) return resp
        console.log(`[proxy][group:${modelId}] 成员 ${member} 可重试失败 HTTP ${resp.status}，继续`)
        return null
      }

      if (primaryMembers.length > 0) {
        const startIdx = Math.floor(Math.random() * primaryMembers.length)
        for (let k = 0; k < primaryMembers.length && attempts < MAX_TOTAL_GROUP_ATTEMPTS; k++) {
          const resp = await tryMember(primaryMembers[(startIdx + k) % primaryMembers.length])
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
        if (attempts >= MAX_TOTAL_GROUP_ATTEMPTS) break
        const subParsed = parseModelId(subRef)
        if (!subParsed || subParsed.providerId !== 'group') continue
        const subGroup = await getModelGroup(c.env, subParsed.modelId)
        if (!subGroup?.enabled || subGroup.members.length === 0) continue
        wentToBackup = true
        const subPrimary = subGroup.members.filter(m => !m.startsWith('group/'))
        const subStart = subPrimary.length ? Math.floor(Math.random() * subPrimary.length) : 0
        for (let k = 0; k < subPrimary.length && attempts < MAX_TOTAL_GROUP_ATTEMPTS; k++) {
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
    const forwardBody = { ...body, model: modelId }
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'
    const timeoutMs = getRequestTimeoutMs(c.env)

    if (isOpenCodeProvider(providerId)) {
      const attemptStarted = Date.now()
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method: c.req.method,
        subPath,
        search: url.search,
        body: JSON.stringify(forwardBody),
        mirrorUrls: resolveOpenCodeUrls(c.env),
        timeoutMs,
      })
      const latencyMs = Date.now() - attemptStarted
      const keyMasked = maskKey(enabledKeys[0]?.key || '')
      const opencodeKey = enabledKeys[0]?.key || 'public'

      // 在返回前 clone response，供 telemetry 解析使用
      const telemetryClone = response.clone()

      const headers = copySafeResponseHeaders(response.headers)
      headers.set('X-Request-ID', requestId)
      const clientResponse = new Response(response.body, { status: response.status, statusText: response.statusText, headers })

      // 非阻塞：记录 telemetry 和健康度
      safeWaitUntil(c, (async () => {
        // 记录请求事件
        await recordRequestEvent(c.env, {
          ts: Date.now(), providerId, modelId, keyMasked,
          status: response.status, latencyMs, requestId,
          outcome: response.status < 500 ? 'success' : 'retry',
          routeKey,
        })
        await updateLastActive(c.env, providerId, { providerId, modelId, keyMasked, ts: Date.now() })
        await updateLastActive(c.env, routeKey, { providerId, modelId, keyMasked, ts: Date.now() })

        // 尝试解析 usage（非流式响应）
        if (response.status < 500) {
          try {
            const json: any = await telemetryClone.json()
            const usage = json?.usage
            if (usage) {
              await recordUsage(c.env, providerId, usage.input_tokens ?? usage.prompt_tokens ?? 0, usage.output_tokens ?? usage.completion_tokens ?? 0)
            }
          } catch { /* not JSON, skip usage */ }
        }

        // 健康度记录：424（镜像全部失败）或 5xx 记录失败
        if (response.status === 424 || response.status >= 500) {
          const healthData = await readHealth(c.env, providerId)
          const h = healthData[opencodeKey] || { failures: 0, lastFailed: false }
          h.failures = (h.failures || 0) + 1
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) h.demotedAt = Date.now()
          h.lastFailed = true
          healthData[opencodeKey] = h
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
    const isStreamRequest = !!(forwardBody as { stream?: unknown }).stream

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
          body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        })

        if (response.ok) {
          if (healthData[apiKey]?.failures > 0 || healthData[apiKey]?.cooldownUntil) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          // —— 多模态"假成功"检测：200 但模型未识别图片 / reasoning token 预算不足 ——
          if (!isStreamRequest && hasImageContent(forwardBody)) {
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

          // 非流式响应尝试解析 usage 字段做 token 统计；clone 出去读，不影响返回给客户端的 body。
          const latencyMs = Date.now() - attemptStarted
          const usageProbe = isStreamRequest ? Promise.resolve<{ tokensIn?: number; tokensOut?: number }>({}) : (async () => {
            try {
              const json: any = await response.clone().json()
              const usage = json?.usage
              if (!usage) return {}
              return {
                tokensIn: usage.input_tokens ?? usage.prompt_tokens,
                tokensOut: usage.output_tokens ?? usage.completion_tokens,
              }
            } catch {
              return {}
            }
          })()
          safeWaitUntil(c, (async () => {
            const { tokensIn, tokensOut } = await usageProbe
            const event: RequestEvent = {
              ts: Date.now(), providerId, modelId, keyMasked,
              status: response.status, latencyMs, requestId, outcome: 'success',
              routeKey, tokensIn, tokensOut,
            }
            await recordRequestEvent(c.env, event)
            const activeInfo = { providerId, modelId, keyMasked, ts: event.ts }
            await updateLastActive(c.env, providerId, activeInfo)
            await updateLastActive(c.env, routeKey, activeInfo)
            // 用量统计需要覆盖所有成功响应（含流式请求，token 数未知时按 0 记入 requests 计数）。
            // 这里只做展示用的统计，不做任何限制或拦截。
            await recordUsage(c.env, providerId, tokensIn || 0, tokensOut || 0)
          })())

          return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        }

        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          if (retryAfter > 0) {
            // 有 Retry-After：按上游给的精确时间冷却
            h.cooldownUntil = Date.now() + retryAfter
          } else {
            // 无头：走原来的失败计数逻辑，累加 failures，达标后降权
            h.failures++
            if (h.failures >= KEY_HEALTH_MAX_FAILURES) h.demotedAt = Date.now()
          }
          h.lastFailed = true
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          safeWaitUntil(c, recordRequestEvent(c.env, {
            ts: Date.now(), providerId, modelId, keyMasked,
            status: response.status, latencyMs: Date.now() - attemptStarted, requestId,
            outcome: 'retry', routeKey,
          }))
          continue
        }

        if (response.status === 401 || response.status === 403 || response.status >= 500 || response.status === 408) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) h.demotedAt = Date.now()
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          safeWaitUntil(c, recordRequestEvent(c.env, {
            ts: Date.now(), providerId, modelId, keyMasked,
            status: response.status, latencyMs: Date.now() - attemptStarted, requestId,
            outcome: 'retry', routeKey,
          }))
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
        safeWaitUntil(c, recordRequestEvent(c.env, {
          ts: Date.now(), providerId, modelId, keyMasked,
          status: response.status, latencyMs: Date.now() - attemptStarted, requestId,
          outcome: 'fail', routeKey,
        }))
        return c.json(result, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) h.demotedAt = Date.now()
        healthData[apiKey] = h
        healthUpdated = true
        lastError = new Response(JSON.stringify({ error: { message: error.message || '请求失败', type: 'proxy_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
        safeWaitUntil(c, recordRequestEvent(c.env, {
          ts: Date.now(), providerId, modelId, keyMasked,
          status: 502, latencyMs: Date.now() - attemptStarted, requestId,
          outcome: 'retry', routeKey,
        }))
        continue
      }
    }

    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      safeWaitUntil(c, recordRequestEvent(c.env, {
        ts: Date.now(), providerId, modelId, keyMasked: 'N/A',
        status: lastError.status || 502, latencyMs: 0, requestId,
        outcome: 'fail', routeKey,
      }))
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

function parseRetryAfter(value: string | null): number {
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
