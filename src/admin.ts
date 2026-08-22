import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  getModelGroups,
  getModelGroup,
  saveModelGroup,
  deleteModelGroup,
  testProviderStatus,
  setProviderStatus,
} from './storage'
import { testModelConnection } from './proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL, SAFE_RESOURCE_ID_RE, SAFE_MODEL_ID_RE } from './config'
import { getRequestLog, getLastActive, getUsage } from './telemetry'
import { getAlertHistory } from './alerts'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  ModelGroup,
} from './types'


const MAX_PROVIDER_NAME_LENGTH = 120
const MAX_API_KEYS = 100
const MAX_MODELS = 200
const MAX_GROUP_MEMBERS = 100

function validResourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80 && SAFE_RESOURCE_ID_RE.test(value)
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && SAFE_MODEL_ID_RE.test(value)
}

function validateBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const hostRaw = url.hostname.toLowerCase()
    const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw
    if (
      host === 'localhost'
      || host === 'localhost.localdomain'
      || host === 'metadata.google.internal'
      || host === '169.254.169.254'
      || host === '::1'
      || host === '0.0.0.0'
      || /^127\./.test(host)
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      // C6 修复：IPv6 私有/链路本地/映射地址补漏
      || /^fd[0-9a-f]{2}:/i.test(host)       // fd00::/8 ULA
      || /^fe[89ab][0-9a-f]:/i.test(host)    // fe80::/10 链路本地
    ) return false
    // C6 修复：IPv4-mapped IPv6 (::ffff:a.b.c.d 或 Node 规范化的 ::ffff:hexi:hexj)
    // 仅拦内网映射，公网映射放行
    const mappedMatch = /^::ffff:((?:\d+\.){3}\d+|(?:[0-9a-f]{1,4}:){1,2}[0-9a-f]{1,4})$/.exec(host)
    if (mappedMatch) {
      let ipv4: string | null = null
      const mapped = mappedMatch[1]
      if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
        ipv4 = mapped
      } else {
        // 十六进制分组还原 IPv4：1-2 组 hex，每组分高低 8 位
        const hexParts = mapped.split(':').map(p => parseInt(p, 16))
        const bytes: number[] = []
        for (let i = 0; i < hexParts.length; i++) {
          bytes.push((hexParts[i] >> 8) & 0xff, hexParts[i] & 0xff)
        }
        ipv4 = bytes.join('.')
      }
      if (ipv4) {
        const v4 = ipv4
        if (
          /^127\./.test(v4)
          || /^10\./.test(v4)
          || /^192\.168\./.test(v4)
          || /^172\.(1[6-9]|2\d|3[0-1])\./.test(v4)
          || v4 === '169.254.169.254'
          || v4 === '0.0.0.0'
        ) return false
      }
    }
    return true
  } catch {
    return false
  }
}

function normalizeProviderBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function upstreamV1Url(baseUrl: string, path: string): string {
  const base = normalizeProviderBaseUrl(baseUrl)
  const normalizedPath = path.replace(/^\/+/, '')
  return `${base}${/\/v\d+$/i.test(base) ? '' : '/v1'}/${normalizedPath}`
}

function normalizeApiKeys(items: unknown): Array<{ key: string; enabled: boolean }> {
  const result = normalizeArray(items, (k) => ({ key: k.trim(), enabled: true }))
  return result
    .filter(k => typeof k?.key === 'string' && k.key.length > 0 && k.key.length <= 500)
    .map(k => ({ key: k.key.trim(), enabled: k.enabled !== false }))
    .slice(0, MAX_API_KEYS)
}


async function hasGroupCycle(env: Env, groupId: string, members: string[], visiting = new Set<string>()): Promise<boolean> {
  if (visiting.has(groupId)) return true
  const nextVisiting = new Set(visiting)
  nextVisiting.add(groupId)
  for (const member of members) {
    if (!member.startsWith('group/')) continue
    const childId = member.slice('group/'.length)
    if (childId === groupId) return true
    const child = await getModelGroup(env, childId)
    if (child && await hasGroupCycle(env, childId, child.members, nextVisiting)) return true
  }
  return false
}

function normalizeModels(items: unknown): Array<{ id: string; enabled: boolean }> {
  return normalizeArray(items, (m) => ({ id: m.trim(), enabled: true }))
    .filter(m => validModelId(m.id))
    .slice(0, MAX_MODELS)
}

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 遥测查询（第1层：先只提供只读接口验证数据，UI 面板留待第2层） =====

export async function handleGetTelemetryLog(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('providerId')
  if (!validResourceId(providerId)) {
    return c.json<ApiResponse>({ success: false, message: 'providerId 格式非法' }, 400)
  }
  const log = await getRequestLog(c.env, providerId)
  return c.json<ApiResponse>({ success: true, data: log })
}

export async function handleGetLastActive(c: Context<{ Bindings: Env }>) {
  // scope 可能是 "group/auto-task" 这类带斜杠的 routeKey，用 query 参数而非路径参数以避免路由分段问题。
  const scope = c.req.query('scope')
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > 200) {
    return c.json<ApiResponse>({ success: false, message: 'scope 参数非法（请用 ?scope= 查询参数）' }, 400)
  }
  const info = await getLastActive(c.env, scope)
  return c.json<ApiResponse>({ success: true, data: info })
}

export async function handleGetUsage(c: Context<{ Bindings: Env }>) {
  const providerId = c.req.param('providerId')
  if (!validResourceId(providerId)) {
    return c.json<ApiResponse>({ success: false, message: 'providerId 格式非法' }, 400)
  }
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ApiResponse>({ success: false, message: 'date 参数格式应为 YYYY-MM-DD' }, 400)
  }
  const usage = await getUsage(c.env, providerId, date)
  return c.json<ApiResponse>({ success: true, data: usage })
}

export async function handleGetAlertHistory(c: Context<{ Bindings: Env }>) {
  const type = c.req.param('type') || undefined
  const result = await getAlertHistory(c.env, type)
  return c.json<ApiResponse>(result)
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!validResourceId(body.id)) {
    return c.json<ApiResponse>({ success: false, message: 'id 只能包含字母、数字、下划线和短横线，长度 1-80' }, 400)
  }
  if (!body.name || body.name.length > MAX_PROVIDER_NAME_LENGTH) {
    return c.json<ApiResponse>({ success: false, message: 'name 为必填项且不能超过 120 个字符' }, 400)
  }
  if (!validateBaseUrl(body.baseUrl)) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 HTTP(S) 地址，且不能指向本机/内网地址' }, 400)
  }
  if (body.apiType && body.apiType !== 'openai' && body.apiType !== 'anthropic') {
    return c.json<ApiResponse>({ success: false, message: 'apiType 必须是 openai 或 anthropic' }, 400)
  }
  // C2 修复：校验 groupId 是否存在
  if (body.groupId) {
    const g = await getModelGroup(c.env, body.groupId)
    if (!g) {
      return c.json<ApiResponse>({ success: false, message: `目标模型组 "${body.groupId}" 不存在，请先创建该模型组` }, 400)
    }
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: normalizeProviderBaseUrl(body.baseUrl),
    apiType: body.apiType || 'openai',
apiKeys: normalizeApiKeys(body.apiKeys),
    models: body.models ? normalizeModels(body.models) : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    status: body.status || 'pending',
    groupId: body.groupId,       // 梯队 group（写回持久化）
    tier: body.tier,             // 梯队级别（写回持久化）
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)

  // 处理梯队分配
  if (body.groupId) {
    const group = await getModelGroup(c.env, body.groupId)
    if (group) {
      // 统一获取第一个模型 ID（兼容 string[] 和对象数组两种格式）
      const modelArray = body.models
        ? normalizeArray(body.models, (m) => m)
        : []
      const firstModel = modelArray[0]
      const firstModelId = typeof firstModel === 'string' ? firstModel : (firstModel && (firstModel as { id?: string }).id)
      const memberId = firstModelId ? `${body.id}/${firstModelId}` : null
      if (memberId) {
        if (body.tier === 'primary') {
          // 一梯队：直接加入指定 group 的 members
          if (!group.members.includes(memberId)) {
            group.members.push(memberId)
            await saveModelGroup(c.env, group)
          }
        } else if (body.tier === 'backup') {
          // 二梯队：写入独立的 backup group（auto-task-backup）
          // groupId=auto-task → auto-task-backup；groupId=auto-task-backup → 写它自己
          const backupGroupId = body.groupId === 'auto-task' ? 'auto-task-backup' : body.groupId
          if (backupGroupId !== 'auto-task' && backupGroupId !== 'auto-task-backup') {
            return c.json<ApiResponse>({ success: false, message: `不支持的 groupId "${body.groupId}" 与 tier=backup 组合` }, 400)
          }
          const backupGroup = await getModelGroup(c.env, backupGroupId)
          if (backupGroup) {
            if (!backupGroup.members.includes(memberId)) {
              backupGroup.members.push(memberId)
              await saveModelGroup(c.env, backupGroup)
            }
          }
        }
      }
    }
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  if (body.name !== undefined && (!body.name || body.name.length > MAX_PROVIDER_NAME_LENGTH)) {
    return c.json<ApiResponse>({ success: false, message: 'name 不能为空且不能超过 120 个字符' }, 400)
  }
  if (body.baseUrl !== undefined && !validateBaseUrl(body.baseUrl)) {
    return c.json<ApiResponse>({ success: false, message: 'baseUrl 必须是合法的 HTTP(S) 地址，且不能指向本机/内网地址' }, 400)
  }
  if (body.apiType !== undefined && body.apiType !== 'openai' && body.apiType !== 'anthropic') {
    return c.json<ApiResponse>({ success: false, message: 'apiType 必须是 openai 或 anthropic' }, 400)
  }
  if (body.status !== undefined && !['pending', 'active', 'disabled'].includes(body.status)) {
    return c.json<ApiResponse>({ success: false, message: 'status 无效' }, 400)
  }
  if (body.tier !== undefined && body.tier !== 'primary' && body.tier !== 'backup') {
    return c.json<ApiResponse>({ success: false, message: 'tier 无效' }, 400)
  }
  if (body.groupId !== undefined && body.groupId && !validResourceId(body.groupId)) {
    return c.json<ApiResponse>({ success: false, message: 'groupId 格式无效' }, 400)
  }

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = normalizeProviderBaseUrl(body.baseUrl)
  if (body.apiType !== undefined) updates.apiType = body.apiType
if (body.apiKeys !== undefined) {
    // 防呆：空数组覆盖 apiKeys 必须带 confirmClearKeys: true（pitfall 31 防护）
    if (Array.isArray(body.apiKeys) && body.apiKeys.length === 0 && !body.confirmClearKeys) {
      return c.json<ApiResponse>({ success: false, message: 'apiKeys 为空数组且未设置 confirmClearKeys: true，拒绝覆盖（如确有清空需求，请设置 confirmClearKeys: true）' }, 400)
    }
    updates.apiKeys = normalizeApiKeys(body.apiKeys)
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.status !== undefined) updates.status = body.status
  if (body.statusReason !== undefined) updates.statusReason = body.statusReason
  if (body.models !== undefined) {
    updates.models = normalizeModels(body.models)
  }
  if (body.groupId !== undefined) updates.groupId = body.groupId
  if (body.tier !== undefined) updates.tier = body.tier

  // 梯队迁移：旧 group 移除引用 + 新 group 加入引用
  const tierChanged = body.groupId !== undefined
  if (tierChanged) {
    const provider = await getProvider(c.env, id)
    if (!provider) {
      return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
    }

    // 计算该 provider 的所有 member 引用（providerId/modelId，models 可能多个）
    const effectiveModels = updates.models || provider.models
    const memberIds = effectiveModels
      .map((m) => `${id}/${m.id}`)
    const groups = await getModelGroups(c.env)

    // 目标 groupId：显式传入优先，否则沿用现有（tier 变更时目标 group 不变）
    const targetGroupId = body.groupId !== undefined ? body.groupId : provider.groupId
    // 目标 tier：显式传入优先，否则沿用现有
    const targetTier = body.tier !== undefined ? body.tier : provider.tier

    if (targetGroupId && !groups.some(g => g.id === targetGroupId) && !(targetTier === 'backup' && targetGroupId === 'auto-task')) {
      return c.json<ApiResponse>({ success: false, message: `目标模型组 "${targetGroupId}" 不存在` }, 400)
    }

    // 边界防护：老 provider 无 groupId 时，禁止只传 tier 不传 groupId
    if (!targetGroupId) {
      return c.json<ApiResponse>({ success: false, message: `目标 groupId 不能为空：请先选择要加入的梯队组（当前 provider 没有已关联的梯队，无法仅通过 tier 变更迁移）` }, 400)
    }

    // 校验合法性
    if (targetTier === 'backup') {
      const backupGroupId = targetGroupId === 'auto-task' ? 'auto-task-backup' : targetGroupId
      if (backupGroupId !== 'auto-task' && backupGroupId !== 'auto-task-backup') {
        return c.json<ApiResponse>({ success: false, message: `不支持的 groupId "${targetGroupId}" 与 tier=backup 组合` }, 400)
      }
    }

    // 1. 从所有 group 移除此 provider 的所有引用（按前缀匹配，确保已删除模型也被清理）
    const prefix = id + '/'
    for (const group of groups) {
      const before = group.members.length
      group.members = group.members.filter((m) => !m.startsWith(prefix))
      if (group.members.length !== before) {
        await saveModelGroup(c.env, group)
      }
    }

    // 2. 加入目标 group（tier=primary → 目标 group；tier=backup → auto-task-backup 映射）
    if (targetGroupId) {
      let destGroupId = targetGroupId
      if (targetTier === 'backup') {
        destGroupId = targetGroupId === 'auto-task' ? 'auto-task-backup' : targetGroupId
      }
      const destGroup = await getModelGroup(c.env, destGroupId)
      if (destGroup) {
        for (const memberId of memberIds) {
          if (!destGroup.members.includes(memberId)) {
            destGroup.members.push(memberId)
          }
        }
        await saveModelGroup(c.env, destGroup)
      }
    }

    // 写回 provider 的 groupId/tier（含从 backup 映射回原始 groupId）
    if (targetTier === 'backup' && targetGroupId) {
      updates.groupId = targetGroupId
    }
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)

  // 先从所有 group 中清理引用，再删除 provider
  const groups = await getModelGroups(c.env)
  for (const group of groups) {
    const newMembers = group.members.filter((m) => {
      // 解析 member 引用，检查是否属于此 provider
      const memberToCheck = m.startsWith('group/') ? m.substring(6) : m
      const slashIdx = memberToCheck.indexOf('/')
      if (slashIdx === -1) return true
      const providerId = memberToCheck.substring(0, slashIdx)
      return providerId !== id
    })
    if (newMembers.length !== group.members.length) {
      group.members = newMembers
      await saveModelGroup(c.env, group)
    }
  }

  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(provider.baseUrl, enabledKeys[0].key, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { 'Authorization': `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  if (!url || (!apiKey && !(providerId && isOpenCodeProvider(providerId)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }
  if (!validateBaseUrl(url)) {
    return c.json<ApiResponse>({ success: false, message: 'URL 无效或不允许访问本机/内网地址' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.data,
      },
    })
  }

  const cleanBase = normalizeProviderBaseUrl(url)
  try {
    const response = await fetch(upstreamV1Url(cleanBase, 'models'), {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !isOpenCodeProvider(providerId || ''))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }
  if (!validateBaseUrl(url) || !validModelId(model)) {
    return c.json<ApiResponse>({ success: false, message: 'URL 或模型 ID 无效' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = normalizeProviderBaseUrl(url)
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== 模型组管理 =====

export async function handleGetModelGroups(c: Context<{ Bindings: Env }>) {
  const groups = await getModelGroups(c.env)
  return c.json<ApiResponse>({ success: true, data: groups })
}

export async function handleCreateModelGroup(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<Partial<ModelGroup>>()
  if (!validResourceId(body.id)) {
    return c.json<ApiResponse>({ success: false, message: '模型组 id 格式无效' }, 400)
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > MAX_PROVIDER_NAME_LENGTH)) {
    return c.json<ApiResponse>({ success: false, message: '模型组名称无效' }, 400)
  }
  if (!Array.isArray(body.members) || body.members.length === 0 || body.members.length > MAX_GROUP_MEMBERS) {
    return c.json<ApiResponse>({ success: false, message: `members 必须包含 1-${MAX_GROUP_MEMBERS} 个成员` }, 400)
  }
  if (!body.members.every(m => typeof m === 'string' && m.length <= 300 && (m.startsWith('group/') ? validResourceId(m.slice(6)) : validResourceId(m.split('/')[0]) && validModelId(m.slice(m.indexOf('/') + 1))))) {
    return c.json<ApiResponse>({ success: false, message: 'members 包含非法 Provider/Model 引用' }, 400)
  }
  if (body.members.includes(`group/${body.id}`)) {
    return c.json<ApiResponse>({ success: false, message: '模型组不能引用自身' }, 400)
  }
  if (await hasGroupCycle(c.env, body.id, body.members)) {
    return c.json<ApiResponse>({ success: false, message: '模型组引用形成循环依赖' }, 400)
  }
  // C3 修复：校验 members 中的 provider 引用是否存在（排除 group/ 嵌套组）
  const providers = await getProviders(c.env)
  const providerIds = new Set(providers.map(p => p.id))
  for (const member of body.members) {
    if (member.startsWith('group/')) continue // 嵌套组引用，稍后由 hasGroupCycle 校验
    const providerId = member.split('/')[0]
    if (!providerIds.has(providerId)) {
      return c.json<ApiResponse>({ success: false, message: `成员 "${member}" 引用的提供商 "${providerId}" 不存在` }, 400)
    }
  }
  const group: ModelGroup = {
    id: body.id,
    name: body.name || body.id,
    enabled: true,
    members: [...new Set(body.members)],
    type: body.type && ['primary', 'backup', 'multimodal'].includes(body.type) ? body.type : undefined,
    multimodal: body.multimodal === true || body.type === 'multimodal',
  }
  await saveModelGroup(c.env, group)
  return c.json<ApiResponse>({ success: true, data: group, message: '模型组已创建' }, 201)
}

export async function handleUpdateModelGroup(c: Context<{ Bindings: Env }>) {
  const groupId = c.req.param('id')
  if (!groupId) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const existing = await getModelGroup(c.env, groupId)
  if (!existing) {
    return c.json<ApiResponse>({ success: false, message: '模型组不存在' }, 404)
  }
  const body = await c.req.json<Partial<ModelGroup>>()
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > MAX_PROVIDER_NAME_LENGTH)) {
    return c.json<ApiResponse>({ success: false, message: '模型组名称无效' }, 400)
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return c.json<ApiResponse>({ success: false, message: 'enabled 必须是布尔值' }, 400)
  }
  if (body.members !== undefined) {
    if (!Array.isArray(body.members) || body.members.length === 0 || body.members.length > MAX_GROUP_MEMBERS) {
      return c.json<ApiResponse>({ success: false, message: `members 必须包含 1-${MAX_GROUP_MEMBERS} 个成员` }, 400)
    }
    if (!body.members.every(m => typeof m === 'string' && m.length <= 300)) {
      return c.json<ApiResponse>({ success: false, message: 'members 包含非法值' }, 400)
    }
    if (body.members.includes(`group/${existing.id}`)) {
      return c.json<ApiResponse>({ success: false, message: '模型组不能引用自身' }, 400)
    }
  }
  const nextMembers = body.members !== undefined ? [...new Set(body.members)] : existing.members
  if (await hasGroupCycle(c.env, existing.id, nextMembers)) {
    return c.json<ApiResponse>({ success: false, message: '模型组引用形成循环依赖' }, 400)
  }
  const updated: ModelGroup = {
    id: existing.id,
    name: body.name !== undefined ? body.name : existing.name,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    members: nextMembers,
    type: body.type !== undefined
      ? (['primary', 'backup', 'multimodal'].includes(body.type) ? body.type : existing.type)
      : existing.type,
    multimodal: body.multimodal !== undefined ? body.multimodal === true : (body.type === 'multimodal' ? true : existing.multimodal),
  }
  await saveModelGroup(c.env, updated)
  return c.json<ApiResponse>({ success: true, data: updated, message: '模型组已更新' })
}

export async function handleDeleteModelGroup(c: Context<{ Bindings: Env }>) {
  const groupId = c.req.param('id')
  if (!groupId) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const existing = await getModelGroup(c.env, groupId)
  if (!existing) {
    return c.json<ApiResponse>({ success: false, message: '模型组不存在' }, 404)
  }
  await deleteModelGroup(c.env, groupId)
  return c.json<ApiResponse>({ success: true, message: '模型组已删除' })
}

// ===== Provider 状态管理端点 =====

export async function handleTestProviderStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { message: '缺少 provider id' } }, 400)
  }

  const result = await testProviderStatus(c.env, id)

  if (result.success) {
    await setProviderStatus(c.env, id, 'active', '验证通过')
    // 将 testProviderStatus 返回的 reason（"x/n key 有效"）透传给前端
    const reasonMsg = result.reason || ''
    return c.json({
      success: true,
      data: { status: 'active', reason: reasonMsg },
      message: 'Provider 验证通过，状态已更新为 active' + (reasonMsg ? `（${reasonMsg}）` : ''),
    })
  } else {
    await setProviderStatus(c.env, id, 'pending', result.reason)
    return c.json({
      success: false,
      data: { status: 'pending', reason: result.reason },
      message: 'Provider 验证失败，保持 pending 状态',
    }, 400)
  }
}

export async function handleSetProviderStatus(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  const { status, reason } = await c.req.json()

  if (!id || !status) {
    return c.json({ error: { message: '缺少必要参数' } }, 400)
  }

  if (!['pending', 'active', 'disabled'].includes(status)) {
    return c.json({ error: { message: '无效的状态值' } }, 400)
  }

  const provider = await setProviderStatus(c.env, id, status, reason)
  if (!provider) {
    return c.json({ error: { message: 'Provider not found' } }, 404)
  }

  return c.json({
    success: true,
    data: provider,
    message: `Provider 状态已更新为 ${status}`,
  })
}
