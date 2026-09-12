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

// A3（2026-09-04）：429 未带 Retry-After 时的默认精确冷却时长。
// 429 属于「上游限流」而非「key 失效」，只冷却、不累加 failures、不触发 demotedAt 降权。
// 上游给了 Retry-After 就按它冷却（parseRetryAfter 已按 KEY_HEALTH_COOLDOWN_MS 截顶）。
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000

// ===== 错误分类冷却矩阵（2026-09-09，参考 m365 Copilot2API account_health.go CooldownForCategory）=====
// 语义：不同 HTTP 错误代表不同上游状态，冷却时长应分级，而不是一律 failures 累加等 5 次才降权。
// 原则：401/403 是「key 确定性失效」，重复试无意义 → 直接长冷却，不累加 failures（避免把 key 彻底降权导致自愈丢失）；
//       5xx/503/408 是「上游过载/抖动」，短冷却 + 累加 failures（可恢复，冷却后自动回归）；
// 所有时长可通过 Worker 环境变量覆盖（参数配置化，CPA 风格）：
//   KEY_COOLDOWN_401_MS / KEY_COOLDOWN_403_MS / KEY_COOLDOWN_503_MS / KEY_COOLDOWN_408_MS
export const KEY_COOLDOWN_401_MS = 10 * 60 * 1000     // 401 认证过期/失效：10min
export const KEY_COOLDOWN_403_MS = 30 * 60 * 1000     // 403 禁止/封禁：30min（比 401 更重）
export const KEY_COOLDOWN_503_MS = 30 * 1000          // 503/5xx 过载：30s 短冷却（可恢复）
export const KEY_COOLDOWN_408_MS = 15 * 1000          // 408 超时：15s 短冷却（可恢复）

// Gateway 请求安全/稳定性默认值；可通过 Worker 环境变量覆盖。
export const DEFAULT_REQUEST_TIMEOUT_MS = 25_000
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024

// S2（2026-09-06）：替代旧 MAX_TOTAL_GROUP_ATTEMPTS = 6。
// 旧语义是「主力 + backup 共享 6 次路由预算」——主力成员数 > 6 时 backup 一次机会都拿不到（饿死）。
// 新语义：**路由预算按层各自的成员数**（主力遍历 primaryMembers.length、backup 遍历各自 subPrimary.length），
// 这里的常量退化为**纯防御性熔断**，只用来兜住 CF Workers 单请求 subrequest 上限（免费版 50 / 付费 1000），
// 绝不参与正常路由决策。取 20：cc(7) + xx(4) = 11 个成员即使每个都试也远低于它。
export const MAX_GROUP_SUBREQUEST_BUDGET = 20

// S9（2026-09-06）：假成功（HTTP 200 + 流内 error）专用冷却时长。
//
// 为什么需要它 —— S4/S6/S8 只解决了「识破 + 换成员」，没解决「记住」：
//   writeHealth 的 P1 过滤只持久化 `failures>=5 || cooldownUntil>now` 的 key，
//   而每个请求是独立 isolate、healthMemoryCache 不跨 isolate 共享，
//   于是 failures 永远停在 1，**永不落 KV** → 下一个请求的新 isolate 读到空健康度
//   → 坏成员以 1/N 概率再次被选中 → 每次都要重新付一次探测代价。
//   实测：opencode 连打 6 次，`key:health:opencode` 始终不存在。
//
// 解法不动 P1 阈值（那是为省 KV 写配额的既有取舍），而是给假成功一个**短冷却**：
//   · `cooldownUntil > now` 本来就在 P1 白名单里 → 自动落 KV，零阈值改动
//   · `isMemberCoolingDown` 据此跳过该成员 → 主力全假成功时 candidates 直接为空 → 立刻降级 backup
//   · 冷却期满自动回到轮转 → 这就是「CC 降 XX 后再返回 CC」的自愈路径
// 取 60s 与 429 默认冷却对齐：够短（不误伤偶发抖动）、够长（覆盖 KV ~60s 边缘缓存传播窗口）。
export const FAKE_SUCCESS_COOLDOWN_MS = 60 * 1000

// 仅允许安全的 Provider / Group ID，避免被拼入 URL / HTML / JS 上下文。
export const SAFE_RESOURCE_ID_RE = /^[A-Za-z0-9_-]+$/
export const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/

// 请求体 model 字段的最大长度（ProviderId/MODELID 整体）。防止构造超长字符串
// 被不当使用。管理端创建 provider/model 时已按各自字段做过校验。
export const MAX_MODEL_STRING_LENGTH = 300

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  OPENCODE_MIGRATION: 'migration:opencode-default:v1',
  MODEL_GROUP_LIST: 'model_group_list',
} as const

/** 模型组 KV key 前缀 */
export const MODEL_GROUP_KEY = (groupId: string) => `model_group:${groupId}`

/**
 * S1（2026-09-06）：已删除 A4 顺序轮转持久化指针 `GROUP_POINTER_KEY`。
 *
 * 删除原因（实测根因）：粘滞指针是故障放大器。指针停在一个「HTTP 200 + SSE 流内 error」
 * 的假成功成员上时，tryMember 永远判成功 → 指针永不推进 → 每个请求都命中同一黑洞，
 * 且不触发任何降级、不发告警。回归上游原版（yutian81/ai-gateway，私仓 v1.0 封箱基线）的
 * 随机起点后，单个坏成员的影响面被摊薄到 1/N，不再形成持久锁死。
 *
 * 遗留数据：KV 中旧的 `group:<id>:pointer` 键不再被读写，属无害孤儿键，可手动清理。
 */

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
