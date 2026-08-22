import type { Provider, ModelGroup } from './types'

export const SITE_CONFIG = {
  title: 'AI Gateway Pro',
  subtitle: '统一的 AI 管理平台',
  author: '小鸢',
  authorUrl: 'https://github.com/bmzsmh/ai-gateway-pro',
  blogUrl: '',
  description: 'AI 提供商 API 代理网关 — 统一 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_cf_'

export const OPENCODE_DEFAULT_URL = 'https://opencode.ai/zen/v1'

// Key 降权后自动恢复的冷却时间 (毫秒)
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// 连续失败多少次后降权
export const KEY_HEALTH_MAX_FAILURES = 5

// Gateway 请求安全/稳定性默认值；可通过 Worker 环境变量覆盖。
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_GROUP_ATTEMPTS = 6

// 仅允许安全的 Provider / Group ID，避免被拼入 URL / HTML / JS 上下文。
export const SAFE_RESOURCE_ID_RE = /^[A-Za-z0-9_-]+$/
export const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/

// 请求体 model 字段的最大长度（"提供商ID/模型ID" 整体）。防止构造超长字符串
// 污染遥测 KV key、或在未来代码里被拼接使用时放大风险。管理端创建 provider/model
// 时已按各自字段做过校验，这里是运行时入口的兜底。
export const MAX_MODEL_STRING_LENGTH = 300

// 遥测：环形请求日志每个 provider 最多保留的条数
export const TELEMETRY_LOG_MAX_ENTRIES = 80
// 遥测：用量聚合记录的 KV TTL（约35天，避免历史数据无限堆积）
export const TELEMETRY_USAGE_TTL_SECONDS = 35 * 24 * 60 * 60

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  OPENCODE_MIGRATION: 'migration:opencode-default:v1',
  MODEL_GROUP_LIST: 'model_group_list',
  TELEMETRY_LOG_PREFIX: 'telemetry:log:',
  TELEMETRY_ACTIVE_PREFIX: 'telemetry:active:',
  TELEMETRY_USAGE_PREFIX: 'telemetry:usage:',
} as const

/** 模型组 KV key 前缀 */
export const MODEL_GROUP_KEY = (groupId: string) => `model_group:${groupId}`

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys: [{ key: 'public', enabled: true }],
    models: [
      { id: 'deepseek-v4-flash-free', enabled: true },
      { id: 'mimo-v2.5-free', enabled: true },
      { id: 'nemotron-3-ultra-free', enabled: true },
      { id: 'hy3-free', enabled: true },
    ],
    enabled: true,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// 默认模型组种子：新部署 KV 首次运行时自动创建三类型基础分组。
// 与 DEFAULT_PROVIDERS 一样，仅在前端/后台无任何分组数据时写入一次。
// 成员仅引用 DEFAULT_PROVIDERS 中存在的模型，保证开箱即用。
export const DEFAULT_MODEL_GROUPS: ModelGroup[] = [
  {
    id: 'auto-task',
    name: '主力模型池',
    enabled: true,
    type: 'primary',
    multimodal: false,
    members: ['opencode/deepseek-v4-flash-free', 'opencode/nemotron-3-ultra-free'],
  },
  {
    id: 'auto-task-backup',
    name: '备用模型池',
    enabled: true,
    type: 'backup',
    multimodal: false,
    members: ['opencode/hy3-free'],
  },
  {
    id: 'vision-pool',
    name: '多模态模型池',
    enabled: true,
    type: 'multimodal',
    multimodal: true,
    members: ['opencode/mimo-v2.5-free'],
  },
]
