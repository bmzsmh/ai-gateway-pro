import type { Env } from './types'

// ===== 遥测记录层（已裁剪，仅保留 maskKey） =====
// 2026-08-24 决策：删除遥测展示（请求日志/活跃模型/日用量）。
// 原因：这些数据仅用于后台监控页展示，价值低；但每次请求 4 次 KV 写，
// 导致 CF 免费层 KV 配额（1000 写/天）半天烧完，连带告警/健康度写入也失败。
// 保留：TG 告警（alerts.ts）、健康度降权（proxy.ts writeHealth）、KV 配额预警（countKvWrite）。
// 用户确认方向：遥测展示可删，TG 告警+健康度+配额预警是核心附属必须保留。
// maskKey 仍被 proxy.ts 使用（脱敏展示转发 Key），保留在此处。

/** 掩码展示 Key，日志/UI 里绝不出现完整 Key。 */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}