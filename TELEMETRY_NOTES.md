# 本轮改动说明（typecheck 修复 + 监控可视化）

在 v1.1.0-hardened 基础上新增，未改动原有安全加固逻辑。

**v1.2.1 更新：应用户要求，已完整移除"消耗门槛/配额拦截"功能。**
原因：该功能基于 KV 聚合计数做判断，在并发请求下存在"读-改-写"竞态，
无法做到严格的硬限额（外部审查也指出了这一点）。与其保留一个名不副实
的"软限制"、需要在文档里反复解释语义，不如直接去掉，保持系统行为可预期。
「今日用量」的**纯展示**部分予以保留——它只是看个数，不做任何拦截判断，
不存在这个问题。

## 1. Typecheck 修复
- `admin.ts` normalizeArray 泛型推导问题（原仓库就有，非本次引入）
- `proxy.ts` lastErr 闭包类型窄化丢失导致的 2 个新增报错
全部通过 `npx tsc --noEmit` 实测验证为 0 报错。

## 2. 统一遥测记录层（新增 src/telemetry.ts）
- `recordRequestEvent`：每个 provider 一份环形日志，最多 80 条
- `updateLastActive`：记录某个 provider / 某个 group 路由当前活跃的 provider+model+key
- `recordUsage` / `getUsage`：按天累加 token 用量与请求次数，35 天 TTL，**仅用于展示**
所有写入通过 `waitUntil` 异步执行，不阻塞转发响应。

已知限制：环形日志是 read-modify-write，高并发下可能互相覆盖丢条目（只影响
观测展示，不影响转发正确性）。个人/小规模场景可接受，未来量大可迁移到
Durable Object。

## 3. 监控面板（管理后台新增"监控"导航项）
- 两个梯队（auto-task / auto-task-backup）当前活跃模型卡片
- 按 provider 查看最近请求日志，状态码染色（2xx绿/429黄/4xx5xx红）
- 按 provider 查看今日用量（tokens、请求次数）——纯统计，不拦截、不限制

## 只读 API（供自行集成/排查用，均需 admin session 鉴权）
- GET /admin/api/telemetry/log/:providerId
- GET /admin/api/telemetry/last-active?scope=<providerId 或 group/xxx>
- GET /admin/api/telemetry/usage/:providerId?date=YYYY-MM-DD

## v1.2.2 更新：两处稳定性修复（非功能性，不改变任何行为，只改正确性）

1. **`model` 请求字段运行时校验**：之前只在 admin 后台创建 provider/model 时
   校验格式，请求时的 `model` 字段本身完全没做长度或格式限制。现在
   `parseModelId()` 增加：整体长度上限 300 字符、providerId 必须匹配
   `SAFE_RESOURCE_ID_RE`、modelId 必须匹配 `SAFE_MODEL_ID_RE`——和管理端
   创建时用的是同一套正则，所以不会拒绝任何已经合法配置的模型，只会拒绝
   构造出来的超长/非法字符串（这类字符串目前会被写进遥测 KV key，属于
   污染面）。

2. **错误响应状态码不再靠字符串前缀猜**：原来 `handleProxy` 的 catch 块
   用 `error.message.startsWith('请求体过大')` 来判断该返回 413 还是 400，
   这意味着任何真正的内部异常（KV 故障、未预期的 bug）都会被误判成
   客户端的 400 错误。现在改成两个具体的错误类
   `PayloadTooLargeError` / `InvalidJsonError`，用 `instanceof` 精确匹配；
   真正未识别的异常统一返回 500 并打印到日志，不再冒充成客户端的问题。

验证：新写的独立单元测试覆盖了 12 组 `parseModelId` 边界输入（含超长、
非法字符、group 路由、Bedrock 风格带冒号的 model ID）和 4 种错误分类
场景，全部按预期通过；全量 `tsc --noEmit` 保持 0 错误。


