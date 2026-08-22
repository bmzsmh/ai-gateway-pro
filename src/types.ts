export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

// Provider 状态：pending（待验证）/ active（可用）/ disabled（禁用）
export type ProviderStatus = 'pending' | 'active' | 'disabled'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  status: ProviderStatus  // 新增：provider 验证状态
  statusReason?: string   // 新增：失败原因（pending 状态时记录）
  statusHistory?: {      // 新增：状态变更历史
    status: ProviderStatus
    reason: string
    timestamp: string
  }[]
  groupId?: string          // 所属梯队 group（持久化，供管理查看/迁移）
  tier?: 'primary' | 'backup'  // 梯队级别（持久化）
  createdAt: string
  updatedAt: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
}

export interface ModelGroup {
  id: string
  name: string
  enabled: boolean
  members: string[]
  // 分组类型：第一梯队(primary) / 第二梯队(backup) / 多模态(multimodal)
  // type 替代隐式命名约定，让梯队分类显式表达；旧数据无 type 时按 multimodal 推导
  type?: 'primary' | 'backup' | 'multimodal'
  // 多模态分组标记：标识此模型组用于视觉/图片/视频等多模态任务，供管理端与外部系统(如 Hermes auxiliary.vision)识别
  multimodal?: boolean
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  messages?: Array<{ role: string; content: string }>
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  status?: ProviderStatus
  // 梯队选择
  groupId?: string  // 加入的目标 model group ID
  tier?: 'primary' | 'backup'  // 梯队级别
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  confirmClearKeys?: boolean  // 显式确认清空 apiKeys，否则空数组不覆盖
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  status?: ProviderStatus
  statusReason?: string
  groupId?: string  // 梯队 group 变更（迁移 members 并写回）
  tier?: 'primary' | 'backup'  // 梯队级别变更
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  OPENCODE_MIRRORS_URL?: string
  OPENCODE_MIRROR_FALLBACK?: string
  REQUEST_TIMEOUT_MS?: string
  MAX_REQUEST_BODY_BYTES?: string
  CORS_ORIGINS?: string
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
}
