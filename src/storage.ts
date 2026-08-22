import { KV_KEYS } from './config'
import { MODEL_GROUP_KEY } from './config'
import type { Env, ModelGroup, Provider, ProxyKey, Session, ProviderStatus } from './types'

// ===== 提供商 CRUD =====

export async function getProviders(env: Env): Promise<Provider[]> {
  const data = await env.KV.get(KV_KEYS.PROVIDERS, { cacheTtl: 60 })
  return data ? JSON.parse(data) : []
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

export async function setProviders(env: Env, providers: Provider[]): Promise<void> {
  await env.KV.put(KV_KEYS.PROVIDERS, JSON.stringify(providers))
}

export async function addProvider(env: Env, provider: Provider): Promise<void> {
  const providers = await getProviders(env)
  providers.push(provider)
  await setProviders(env, providers)
}

export async function updateProvider(env: Env, id: string, updates: Partial<Provider>): Promise<Provider | null> {
  const providers = await getProviders(env)
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return null
  providers[index] = { ...providers[index], ...updates, updatedAt: new Date().toISOString() }
  await setProviders(env, providers)
  return providers[index]
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const providers = await getProviders(env)
  const filtered = providers.filter((p) => p.id !== id)
  if (filtered.length === providers.length) return false
  await setProviders(env, filtered)
  return true
}


// ===== Provider 状态管理 =====

export async function setProviderStatus(
  env: Env,
  id: string,
  status: ProviderStatus,
  reason?: string
): Promise<Provider | null> {
  const provider = await getProvider(env, id)
  if (!provider) return null

  const history = [...(provider.statusHistory || [])]
  history.push({
    status,
    reason: reason || (status === 'active' ? '验证通过' : status === 'pending' ? '待验证' : '已禁用'),
    timestamp: new Date().toISOString(),
  })
  if (history.length > 20) history.splice(0, history.length - 20)

  const updates: Partial<Provider> = {
    status,
    statusReason: reason,
    statusHistory: history,
  }
  if (status === 'active') {
    updates.updatedAt = new Date().toISOString()
  }

  return updateProvider(env, id, updates)
}

export async function getActiveProviders(env: Env): Promise<Provider[]> {
  const providers = await getProviders(env)
  // active 与 pending 均可参与路由（pending 仅标记，配了有效 key 即可用），只排除 disabled
  return providers.filter((p) => p.enabled && p.status !== 'disabled')
}

export async function testProviderStatus(
  env: Env,
  id: string,
  testEndpoint: 'models' | 'chat' = 'models'
): Promise<{ success: boolean; reason: string }> {
  const provider = await getProvider(env, id)
  if (!provider) {
    return { success: false, reason: 'Provider not found' }
  }

  // 检查是否有可用的 key
  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (enabledKeys.length === 0) {
    return { success: false, reason: 'No enabled API keys' }
  }

  try {
    const cleanBase = provider.baseUrl.replace(/\/+$/, '')
    const v1Base = /\/v\d+$/i.test(cleanBase) ? cleanBase : `${cleanBase}/v1`
    const endpoint = testEndpoint === 'models' ? 'models' : (provider.apiType === 'anthropic' ? 'messages' : 'chat/completions')

    let okCount = 0
    const failures: string[] = []

    // 遍历所有 enabled key，逐 key 探测；任一 key 可用即视为 provider 整体 active。
    // 多 key provider（llmhost 5 key / sensenova 2 key）若只测第一个 key，其余 key 失效
    // 会被面板掩盖——这是 TD-02 修复：全 key 探测，面板能反映"几/n key 有效"。
    for (const k of enabledKeys) {
      let response: Response
      try {
        if (testEndpoint === 'models') {
          response = await fetch(`${v1Base}/models`, {
            method: 'GET',
            headers: provider.apiType === 'anthropic'
              ? { 'x-api-key': k.key, 'anthropic-version': '2023-06-01' }
              : { 'Authorization': `Bearer ${k.key}` },
            signal: AbortSignal.timeout(10000),
          })
        } else {
          response = await fetch(`${v1Base}/${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(provider.apiType === 'anthropic'
                ? { 'x-api-key': k.key, 'anthropic-version': '2023-06-01' }
                : { 'Authorization': `Bearer ${k.key}` }),
            },
            body: JSON.stringify({
              model: provider.models[0]?.id || 'test',
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
            }),
            signal: AbortSignal.timeout(10000),
          })
        }

        if (response.ok) {
          okCount++
        } else {
          const errorText = await response.text().catch(() => '')
          failures.push(`key #${enabledKeys.indexOf(k) + 1}: HTTP ${response.status} ${errorText.slice(0, 120)}`)
        }
      } catch (err) {
        failures.push(`key #${enabledKeys.indexOf(k) + 1}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (okCount > 0) {
      // 任一 key 可用 → active；附上"x/y key 有效"信息（部分 key 失效时提示，非错误）
      const partial = okCount < enabledKeys.length
        ? `${okCount}/${enabledKeys.length} key 有效，${enabledKeys.length - okCount} 个失效`
        : `${enabledKeys.length}/${enabledKeys.length} key 有效`
      return { success: true, reason: partial }
    } else {
      return { success: false, reason: `全部 ${enabledKeys.length} 个 key 均失败。${failures.join(' | ')}` }
    }
  } catch (err) {
    return { success: false, reason: `Error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ===== Session 管理 =====

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  await env.KV.put(KV_KEYS.SESSION_PREFIX + sessionId, JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  })
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await env.KV.get(KV_KEYS.SESSION_PREFIX + sessionId)
  if (!data) return null
  const session: Session = JSON.parse(data)
  if (session.expiresAt < Date.now()) {
    await deleteSession(env, sessionId)
    return null
  }
  return session
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.KV.delete(KV_KEYS.SESSION_PREFIX + sessionId)
}

// ===== 转发 Key =====

export async function getProxyKeys(env: Env): Promise<ProxyKey[]> {
  const data = await env.KV.get(KV_KEYS.PROXY_KEYS)
  return data ? JSON.parse(data) : []
}

export async function setProxyKeys(env: Env, keys: ProxyKey[]): Promise<void> {
  await env.KV.put(KV_KEYS.PROXY_KEYS, JSON.stringify(keys))
}

export async function addProxyKey(env: Env, key: ProxyKey): Promise<void> {
  const keys = await getProxyKeys(env)
  keys.push(key)
  await setProxyKeys(env, keys)
}

export async function deleteProxyKey(env: Env, id: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  const filtered = keys.filter((k) => k.id !== id)
  if (filtered.length === keys.length) return false
  await setProxyKeys(env, filtered)
  return true
}

export async function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const idx = keys.findIndex(k => k.id === id)
  if (idx === -1) return null
  keys[idx] = { ...keys[idx], ...updates }
  await setProxyKeys(env, keys)
  return keys[idx]
}

export async function validateProxyKey(env: Env, key: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  return keys.some((k) => {
    if (k.key !== key || !k.enabled) return false
    if (k.expiresAt) {
      const now = Date.now()
      const expires = new Date(k.expiresAt).getTime()
      if (now >= expires) return false
    }
    return true
  })
}

// ===== 初始数据填充 =====

import { DEFAULT_PROVIDERS, DEFAULT_MODEL_GROUPS, PROXY_KEY_PREFIX } from './config'

export async function seedInitialData(env: Env): Promise<void> {
  const providers = await getProviders(env)
  const migrationCompleted = await env.KV.get(KV_KEYS.OPENCODE_MIGRATION)
  const opencode = DEFAULT_PROVIDERS.find((provider) => provider.id === 'opencode')

  if (!migrationCompleted) {
    if (opencode && !providers.some((provider) => provider.id === opencode.id)) {
      await setProviders(env, [
        ...providers,
        {
          ...opencode,
          apiKeys: opencode.apiKeys.map((key) => ({ ...key })),
          models: opencode.models.map((model) => ({ ...model })),
        },
      ])
    }
    await env.KV.put(KV_KEYS.OPENCODE_MIGRATION, '1')
  }

  // 仅首次运行时创建测试转发 Key
  if (providers.length === 0 && !migrationCompleted) {
    const keys = await getProxyKeys(env)
    if (keys.length === 0) {
      const testKey = {
        id: crypto.randomUUID(),
        key: `${PROXY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
        name: '测试 Key',
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      await addProxyKey(env, testKey)
    }
  }

  // 首次运行时创建默认三类型模型组（仅在无任何分组时）
  const groupIds = await getModelGroupIds(env)
  if (groupIds.length === 0) {
    for (const g of DEFAULT_MODEL_GROUPS) {
      await saveModelGroup(env, { ...g, members: [...g.members] })
    }
  }
}

// ===== 模型组 CRUD =====

export async function getModelGroup(env: Env, groupId: string): Promise<ModelGroup | null> {
  const raw = await env.KV.get(MODEL_GROUP_KEY(groupId), { cacheTtl: 60 })
  return raw ? JSON.parse(raw) : null
}

export async function getModelGroupIds(env: Env): Promise<string[]> {
  const raw = await env.KV.get(KV_KEYS.MODEL_GROUP_LIST)
  return raw ? JSON.parse(raw) : []
}

export async function saveModelGroup(env: Env, group: ModelGroup): Promise<void> {
  await env.KV.put(MODEL_GROUP_KEY(group.id), JSON.stringify(group))
  const ids = await getModelGroupIds(env)
  if (!ids.includes(group.id)) {
    ids.push(group.id)
    await env.KV.put(KV_KEYS.MODEL_GROUP_LIST, JSON.stringify(ids))
  }
}

export async function deleteModelGroup(env: Env, groupId: string): Promise<void> {
  await env.KV.delete(MODEL_GROUP_KEY(groupId))
  const ids = await getModelGroupIds(env)
  await env.KV.put(KV_KEYS.MODEL_GROUP_LIST, JSON.stringify(ids.filter((id) => id !== groupId)))
}

export async function getModelGroups(env: Env): Promise<ModelGroup[]> {
  const ids = await getModelGroupIds(env)
  const groups = await Promise.all(ids.map((id) => getModelGroup(env, id)))
  return groups.filter((g): g is ModelGroup => g !== null)
}
