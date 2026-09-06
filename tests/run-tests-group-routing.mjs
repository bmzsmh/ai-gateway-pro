// ============================================================
// S1–S4 组路由重构单元测试（2026-09-06）
// S1 随机起点（回归上游原版）/ S2 分层遍历全部成员 / S3 任何失败都继续
// S4 流式首包 SSE error 探测正则
//
// 反漂移设计：SSE_ERROR_RE 与 MAX_GROUP_SUBREQUEST_BUDGET 直接从 src/ 源码里
// 抽取真实字面量，不在测试里重抄一遍——源码改了测试立刻跟着变。
// ============================================================
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROXY_SRC = readFileSync(join(HERE, '../src/proxy.ts'), 'utf8')
const CONFIG_SRC = readFileSync(join(HERE, '../src/config.ts'), 'utf8')

let pass = 0
const ok = (msg) => { pass++; console.log(`✅ ${msg}`) }

// ===== 从源码抽取真实常量/正则（反漂移） =====
const budgetMatch = CONFIG_SRC.match(/export const MAX_GROUP_SUBREQUEST_BUDGET = (\d+)/)
assert.ok(budgetMatch, 'config.ts 必须定义 MAX_GROUP_SUBREQUEST_BUDGET')
const MAX_GROUP_SUBREQUEST_BUDGET = Number(budgetMatch[1])

// S11：proxy.ts 的函数/常量已加 export（供 run-tests-integration.mjs 直接调用真实实现），
// 所以这里的抽取正则要容忍可选的 `export ` 前缀。
const reMatch = PROXY_SRC.match(/^(?:export )?const SSE_ERROR_RE = (\/.*\/)$/m)
assert.ok(reMatch, 'proxy.ts 必须定义 SSE_ERROR_RE 单行正则字面量')
const SSE_ERROR_RE = new Function(`return ${reMatch[1]}`)()

console.log('=== S0：源码级回归断言（旧缺陷不得复活） ===')

// S0-1: 旧的共享预算常量与粘滞指针必须已从实现里消失
{
  assert.ok(!/MAX_TOTAL_GROUP_ATTEMPTS/.test(PROXY_SRC), 'proxy.ts 不得再引用 MAX_TOTAL_GROUP_ATTEMPTS')
  assert.ok(!/readGroupPointer\s*\(/.test(PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '')), '不得再调用 readGroupPointer')
  assert.ok(!/writeGroupPointer\s*\(/.test(PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '')), '不得再调用 writeGroupPointer')
  ok('S0-1 A4 粘滞指针与共享预算常量已从实现中彻底移除')
}

// S0-2: tryMember 里不得再有 isRetryableGroupStatus 短路（S3）
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/if\s*\(!isRetryableGroupStatus\([^)]*\)\)\s*return\s+resp/.test(code),
    'tryMember 不得再因不可重试状态码 return resp（终结整组）')
  ok('S0-2 S3 生效：不可重试状态码不再短路终结整组')
}

// S0-3: A3 429 语义必须保留（多账号锁死的解药，不得回退）
{
  const fn = PROXY_SRC.match(/function applyRateLimitHealth[\s\S]*?\n}/)[0]
  assert.ok(/failures:\s*base\.failures\s*\|\|\s*0/.test(fn), '429 不得累加 failures')
  assert.ok(!/demotedAt/.test(fn), '429 不得设置 demotedAt')
  assert.ok(/cooldownUntil:\s*now \+ cooldownMs/.test(fn), '429 必须只设 cooldownUntil')
  ok('S0-3 A3 保留：429 只设 cooldown，不累加 failures、不降权（多账号 429 锁死解药）')
}

// S0-4: 流式假成功必须记 markKeyFailure（旧代码在这里反而 delete 清零）
{
  const probeBlock = PROXY_SRC.match(/if \(probe\.isError\) \{[\s\S]*?continue\n\s*\}/)[0]
  assert.ok(/markKeyFailure/.test(probeBlock), '假成功分支必须调用 markKeyFailure')
  assert.ok(!/delete healthData\[apiKey\]/.test(probeBlock), '假成功分支不得清零健康度')
  assert.ok(/continue/.test(probeBlock), '假成功必须 continue 继续轮转，不得返回给客户端')
  ok('S0-4 S4 生效：流式假成功记失败 + 继续轮转（不再清零 failures、不再直传给客户端）')
}

console.log('\n=== S1：随机起点（回归上游原版 Math.random） ===')

// 移植 src/proxy.ts buildRotationOrder（随机版）
function parseModelId(model) {
  const i = model.indexOf('/')
  if (i <= 0 || i === model.length - 1) return null
  return { providerId: model.substring(0, i), modelId: model.substring(i + 1) }
}
function isMemberCoolingDown(member, providerMap, health, now) {
  const p = parseModelId(member)
  if (!p) return false
  const provider = providerMap.get(p.providerId)
  if (!provider) return false
  const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled && k.key)
  if (enabledKeys.length === 0) return false
  const h = health[p.providerId] || {}
  return enabledKeys.every(k => !!(h[k.key]?.cooldownUntil && h[k.key].cooldownUntil > now))
}
function buildRotationOrder(primaryMembers, providerMap, health = {}, now = Date.now(), rnd = Math.random) {
  const candidates = []
  let coolingCount = 0
  const startIdx = primaryMembers.length ? Math.floor(rnd() * primaryMembers.length) : 0
  for (let k = 0; k < primaryMembers.length; k++) {
    const idx = (startIdx + k) % primaryMembers.length
    const member = primaryMembers[idx]
    if (isMemberCoolingDown(member, providerMap, health, now)) coolingCount++
    else candidates.push({ member, idx })
  }
  return { candidates, coolingCount, startIdx }
}
function defaultProviderMap(members) {
  const map = new Map()
  for (const m of members) {
    const p = parseModelId(m)
    if (p && !map.has(p.providerId)) map.set(p.providerId, { id: p.providerId, apiKeys: [{ key: `key-${p.providerId}`, enabled: true }] })
  }
  return map
}

// 模拟 handleProxy 组路由段（S1+S2+S3 后的实现）
function runGroupRouting(cc, xx, responder, opts = {}) {
  const { health = {}, now = Date.now(), rnd = Math.random } = opts
  const pMapCC = defaultProviderMap(cc)
  let attempts = 0
  const tried = []
  let lastErr = null
  const tryMember = (member) => {
    if (attempts >= MAX_GROUP_SUBREQUEST_BUDGET) return null
    attempts++
    tried.push(member)
    const status = responder(member)
    if (status < 400) return { status, member }
    lastErr = status
    return null // S3：任何失败都继续
  }
  const { candidates, coolingCount, startIdx } = buildRotationOrder(cc, pMapCC, health, now, rnd)
  for (const cand of candidates) {
    const r = tryMember(cand.member)
    if (r) return { ...r, tried, coolingCount, startIdx, tier: 'primary', lastErr }
  }
  let wentToBackup = false
  if (xx && xx.length && attempts < MAX_GROUP_SUBREQUEST_BUDGET) {
    wentToBackup = true
    const subStart = Math.floor(rnd() * xx.length)
    for (let k = 0; k < xx.length; k++) {
      const r = tryMember(xx[(subStart + k) % xx.length])
      if (r) return { ...r, tried, coolingCount, startIdx, tier: 'backup', wentToBackup, lastErr }
    }
  }
  return { status: null, tried, coolingCount, startIdx, tier: null, wentToBackup, lastErr }
}

const CC = ['amd/m1', 'moto/m2', 'goro/m3', 'goro/m4', 'sense/m5', 'sense0/m5', 'amd/m6']
const XX = ['hc/s1', 'oc/n1', 'oc/n2', 'oc/n3']

// S1-1: 1000 次采样，起点覆盖全部成员且分布接近均匀
{
  const hits = new Array(CC.length).fill(0)
  for (let i = 0; i < 1000; i++) hits[runGroupRouting(CC, XX, () => 200).startIdx]++
  assert.ok(hits.every(h => h > 0), `每个起点都被采样到，实际=${hits.join(',')}`)
  const expect = 1000 / CC.length
  assert.ok(hits.every(h => Math.abs(h - expect) < expect * 0.5), `分布接近均匀（±50%），实际=${hits.join(',')}`)
  ok(`S1-1 随机起点 1000 次采样覆盖全部 ${CC.length} 个成员，分布=${hits.join(',')}`)
}

// S1-2: 坏成员影响面 = 1/N —— 单个「假成功黑洞」不再持久占据全部流量
{
  const blackhole = 'amd/m1'
  let hitBlackhole = 0
  for (let i = 0; i < 1000; i++) {
    // 黑洞判失败（S4 已能识破），其余成功
    const r = runGroupRouting(CC, XX, (m) => (m === blackhole ? 502 : 200))
    if (r.tried[0] === blackhole) hitBlackhole++
    assert.ok(r.status === 200, '每次请求最终都成功（黑洞被跳过）')
  }
  const ratio = hitBlackhole / 1000
  assert.ok(ratio > 0.05 && ratio < 0.25, `首选命中黑洞比例 ≈1/7=0.14，实际=${ratio}`)
  ok(`S1-2 黑洞影响面摊薄：首选命中率=${(ratio * 100).toFixed(1)}%（≈1/${CC.length}），1000/1000 请求仍全部成功`)
}

// S1-3: 无 KV 读写 —— 随机起点不依赖任何持久化状态
{
  const src = PROXY_SRC.match(/async function buildRotationOrder[\s\S]*?\n}/)[0]
  assert.ok(!/KV\.(get|put)/.test(src), 'buildRotationOrder 内不得有 KV 读写')
  assert.ok(/Math\.floor\(Math\.random\(\) \* primaryMembers\.length\)/.test(src), '必须是原版随机起点')
  ok('S1-3 随机起点零 KV 开销：buildRotationOrder 内无 KV.get/KV.put（旧版每次路由 1 读 + 失败时 1 写）')
}

console.log('\n=== S2：分层遍历全部成员，backup 不再饿死 ===')

// S2-1: 7 成员主力全败 → backup 必然拿到机会（旧版 6 次预算下拿不到）
{
  const r = runGroupRouting(CC, XX, (m) => (XX.includes(m) ? 200 : 503))
  assert.strictEqual(r.tier, 'backup', '主力全败后必须降级到 backup 并成功')
  assert.strictEqual(r.tried.length, CC.length + 1, `主力 ${CC.length} 个全试完 + backup 第 1 个成功 = ${CC.length + 1} 次`)
  assert.ok(XX.includes(r.member), `最终命中 backup 成员，实际=${r.member}`)
  ok(`S2-1 backup 不再饿死：主力 ${CC.length} 个全败 → 第 ${r.tried.length} 次命中 backup ${r.member}`)
}

// S2-2: 旧版 6 次共享预算的对照复现 —— 证明缺陷真实存在
{
  let attempts = 0
  const OLD_BUDGET = 6
  const triedOld = []
  for (const m of [...CC, ...XX]) {
    if (attempts >= OLD_BUDGET) break
    attempts++
    triedOld.push(m)
  }
  assert.strictEqual(triedOld.length, 6, '旧预算只允许 6 次尝试')
  assert.ok(!triedOld.some(m => XX.includes(m)), `旧版 backup 一个成员都轮不到，实际尝试=${triedOld.join(',')}`)
  ok(`S2-2 旧缺陷对照：共享预算 6 < 主力 ${CC.length} → backup 0 个成员被尝试（新版 ${XX.length} 个全可达）`)
}

// S2-3: 主力 + backup 全败 → 用尽全部 11 个成员才放弃
{
  const r = runGroupRouting(CC, XX, () => 503)
  assert.strictEqual(r.status, null, '全败')
  assert.strictEqual(r.tried.length, CC.length + XX.length, `全部 ${CC.length + XX.length} 个成员都被尝试`)
  assert.ok(r.wentToBackup, '标记已进入 backup')
  ok(`S2-3 全败路径：${r.tried.length}/${CC.length + XX.length} 个成员全部尝试后才返回失败（旧版只试 6 个）`)
}

// S2-4: 防御性熔断仍在（不会无限）——远大于真实成员数，不参与正常决策
{
  const many = Array.from({ length: 40 }, (_, i) => `p${i}/m`)
  const r = runGroupRouting(many, [], () => 503)
  assert.strictEqual(r.tried.length, MAX_GROUP_SUBREQUEST_BUDGET, `熔断在 ${MAX_GROUP_SUBREQUEST_BUDGET} 次生效`)
  assert.ok(MAX_GROUP_SUBREQUEST_BUDGET > CC.length + XX.length, `预算 ${MAX_GROUP_SUBREQUEST_BUDGET} > 真实成员数 ${CC.length + XX.length}，不影响正常路由`)
  ok(`S2-4 防御性熔断：40 成员组止于 ${MAX_GROUP_SUBREQUEST_BUDGET} 次（CF subrequest 保护），真实 11 成员完全不受限`)
}

console.log('\n=== S3：任何失败都继续下一个成员 ===')

// S3-1: 单成员 400/404（旧版视为不可重试 → 终结整组）现在继续轮转
{
  for (const badStatus of [400, 404, 413, 422, 451]) {
    const r = runGroupRouting(CC, XX, (m) => (m === CC[0] ? badStatus : 200))
    assert.strictEqual(r.status, 200, `HTTP ${badStatus} 不得终结整组`)
  }
  // 首选恰好是坏成员时也必须继续（固定 rnd=0 让起点确定落在 CC[0]）
  const r0 = runGroupRouting(CC, XX, (m) => (m === CC[0] ? 404 : 200), { rnd: () => 0 })
  assert.strictEqual(r0.tried[0], CC[0], '强制起点=CC[0]')
  assert.strictEqual(r0.status, 200, '首选 404 后继续轮转并成功')
  assert.strictEqual(r0.tried.length, 2, '第 2 个成员即成功')
  ok('S3-1 不可重试状态码（400/404/413/422/451）不再终结整组，继续轮转到下一个成员')
}

// S3-2: 一个成员配错模型名（404）不再打死整组 —— 真实故障形态
{
  const r = runGroupRouting(CC, XX, (m) => (m === 'amd/m6' ? 404 : (m === CC[0] ? 404 : 200)), { rnd: () => 0 })
  assert.strictEqual(r.status, 200, '两个成员 404 仍能成功')
  ok('S3-2 配错模型名的成员被跳过：2 个成员 404，组仍正常服务')
}

console.log('\n=== S4：流式首包 SSE error 探测正则 ===')

// S4-1: 真实故障报文（AMD 上游原文）必须命中
{
  const real = 'event: error\ndata: {"error":{"message":"Error from provider self-dploy: 503 Service Unavailable {\\"error\\":{\\"type\\":\\"Service Unavailable\\",\\"code\\":\\"no_available_workers\\"}}","code":"upstream_error"}}\n\nevent: done\ndata: [DONE]\n'
  assert.ok(SSE_ERROR_RE.test(real), '必须识别 AMD 真实假成功报文')
  ok('S4-1 真实故障报文命中：AMD「HTTP 200 + event: error + no_available_workers」被判失败')
}

// S4-2: 各种 error 变体命中
{
  const variants = [
    ['纯 event: error', 'event: error\ndata: {}\n'],
    ['前导空白', '  event:  error \ndata: {}\n'],
    ['无 event 仅 error 对象', 'data: {"error":{"message":"quota exceeded"}}\n'],
    ['error 为字符串值', 'data: {"error":"rate limited"}\n'],
    ['error 在第二行', ': keep-alive\n\nevent: error\ndata: {}\n'],
  ]
  for (const [name, payload] of variants) {
    assert.ok(SSE_ERROR_RE.test(payload), `变体应命中: ${name}`)
  }
  ok(`S4-2 error 变体全部命中（${variants.length} 种）：event 名 / error JSON key / 换行位置`)
}

// S4-3: 正常首包绝不误杀（宽容原则）
{
  const benign = [
    ['SSE keep-alive 注释', ': keep-alive\n\n'],
    ['SSE ping 注释', ': ping\n\n'],
    ['标准 OpenAI 首块', 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'],
    ['正文提到 error 字样', 'data: {"choices":[{"delta":{"content":"如何处理 error 和异常"}}]}\n\n'],
    ['正文含 error: 冒号', 'data: {"choices":[{"delta":{"content":"try/catch error: null"}}]}\n\n'],
    ['finish_reason 正常收尾', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
    ['error 为 null（部分上游习惯）', 'data: {"error":null,"choices":[{"delta":{"content":"hi"}}]}\n\n'],
    ['字段名含 error 但非 error key', 'data: {"error_count":0,"choices":[{"delta":{"content":"hi"}}]}\n\n'],
    ['空首包', ''],
  ]
  for (const [name, payload] of benign) {
    assert.ok(!SSE_ERROR_RE.test(payload), `正常报文不得误杀: ${name} → ${payload.substring(0, 60)}`)
  }
  ok(`S4-3 宽容判定：${benign.length} 种正常/边界首包全部放行（keep-alive、正文含 error 字样、error:null）`)
}

// S4-4: 探测门槛存在且是「响应侧 SSE 判定」（S8 已把 isStreamRequest 裸门槛改掉）
// 原 S4-4 断言的是 `isStreamRequest && response.body`，那正是 S8 修掉的盲区写法，
// 断言随实现一起更新；「JSON 响应不被探测」的保证移交 S8-3 的语义仿真覆盖。
{
  const block = PROXY_SRC.match(/if \(response\.ok\) \{[\s\S]*?if \(\(isStreamRequest \|\| isSseResponse\(response\)\) && response\.body\) \{/)
  assert.ok(block, '首包探测门槛必须是 (isStreamRequest || isSseResponse(response))')
  ok('S4-4 探测门槛存在且为响应侧 SSE 判定（普通 JSON 响应仍不进探测，见 S8-3）')
}

console.log('\n=== S5：冷却跳过语义保留（A3/A4 有效部分不得回退） ===')

// S5-1: 多 key provider —— 部分 key 冷却不算成员冷却
{
  const now = 40_000_000
  const members = ['multi/m', 'solo/m']
  const pMap = new Map([
    ['multi', { id: 'multi', apiKeys: [{ key: 'k1', enabled: true }, { key: 'k2', enabled: true }] }],
    ['solo', { id: 'solo', apiKeys: [{ key: 's1', enabled: true }] }],
  ])
  const partial = { multi: { k1: { cooldownUntil: now + 60_000 } } }
  assert.strictEqual(buildRotationOrder(members, pMap, partial, now, () => 0).coolingCount, 0, '部分 key 冷却 → 成员可用')
  const full = { multi: { k1: { cooldownUntil: now + 60_000 }, k2: { cooldownUntil: now + 60_000 } } }
  const r2 = buildRotationOrder(members, pMap, full, now, () => 0)
  assert.strictEqual(r2.coolingCount, 1, '全部 key 冷却 → 成员冷却')
  assert.strictEqual(r2.candidates[0].member, 'solo/m', '冷却成员被跳过')
  ok('S5-1 多 key provider：部分 key 冷却不误判；全部 key 冷却才跳过（防单 key 限流误伤整个成员）')
}

// S5-2: 共同提供商多账号 429 场景 —— sensenova/sensenova0 同上游各 1 key
{
  const now = 50_000_000
  const members = ['sense/dsv4', 'sense0/dsv4', 'hc/step']
  const pMap = new Map([
    ['sense', { id: 'sense', apiKeys: [{ key: 'a1', enabled: true }] }],
    ['sense0', { id: 'sense0', apiKeys: [{ key: 'a2', enabled: true }] }],
    ['hc', { id: 'hc', apiKeys: [{ key: 'h1', enabled: true }] }],
  ])
  // sense 撞 429 冷却中，sense0 正常
  const health = { sense: { a1: { failures: 0, cooldownUntil: now + 60_000 } } }
  const r = buildRotationOrder(members, pMap, health, now, () => 0)
  assert.strictEqual(r.coolingCount, 1, '限流账号被跳过')
  assert.ok(!r.candidates.some(c => c.member === 'sense/dsv4'), '冷却中的账号不在候选内')
  assert.ok(r.candidates.some(c => c.member === 'sense0/dsv4'), '同上游另一账号仍可用')
  // 冷却期满 → 自动恢复，无需人工干预（A3：failures 未累加，不会永久降权）
  const later = buildRotationOrder(members, pMap, health, now + 61_000, () => 0)
  assert.strictEqual(later.coolingCount, 0, '60s 冷却期满自动恢复全部候选')
  ok('S5-2 多账号 429 不锁死：限流账号冷却期内被跳过、同上游另一账号继续服务、60s 后自动全量恢复')
}

// S5-3: 全部成员冷却 → candidates 为空 → 直接降级 backup（不空转）
{
  const now = 60_000_000
  const health = {}
  for (const m of CC) {
    const p = parseModelId(m)
    health[p.providerId] = { [`key-${p.providerId}`]: { cooldownUntil: now + 60_000 } }
  }
  const r = runGroupRouting(CC, XX, (m) => (XX.includes(m) ? 200 : 503), { health, now, rnd: () => 0 })
  assert.strictEqual(r.coolingCount, CC.length, '主力全部冷却')
  assert.strictEqual(r.tier, 'backup', '直接降级 backup')
  assert.ok(!r.tried.some(m => CC.includes(m)), '冷却成员一次都没被调用（不主动撞限流）')
  ok(`S5-3 主力全冷却：0 次无效尝试，直接降级到 backup 并命中 ${r.member}`)
}

console.log('\n=== S6：opencode 路径也做流式假成功探测（backup 层堵洞） ===')

// S6-1: opencode 分支必须在盲转之前调用 probeStreamHead
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  const ocBlock = code.match(/if \(isOpenCodeProvider\(providerId\)\) \{[\s\S]*?\n    \}/)
  assert.ok(ocBlock, '必须能定位 opencode 分支')
  const oc = ocBlock[0]
  assert.ok(/probeStreamHead\(response\)/.test(oc), 'opencode 分支必须调用 probeStreamHead')
  assert.ok(/restoreStream\(/.test(oc), 'opencode 分支必须用 restoreStream 把首块拼回')
  assert.ok(/markKeyFailure/.test(oc), 'opencode 假成功必须记 markKeyFailure')
  // 探测块必须出现在盲转 new Response(response.body 之前
  const probeAt = oc.indexOf('probeStreamHead')
  const blindAt = oc.indexOf('new Response(response.body')
  assert.ok(probeAt > -1 && blindAt > -1 && probeAt < blindAt,
    'probeStreamHead 必须在 new Response(response.body 盲转之前')
  ok('S6-1 opencode 分支：探测先于盲转，假成功记失败 + 首块拼回')
}

// S6-2: opencode 假成功必须返回 >=400，否则组路由的 tryMember 会当成功
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  const oc = code.match(/if \(isOpenCodeProvider\(providerId\)\) \{[\s\S]*?\n    \}/)[0]
  const errBlock = oc.match(/if \(!probe \|\| probe\.isError\) \{[\s\S]*?\n        \}/)[0]
  const statusMatch = errBlock.match(/status:\s*(\d{3})/)
  assert.ok(statusMatch, 'opencode 假成功分支必须显式设置 status')
  const st = Number(statusMatch[1])
  assert.ok(st >= 400, `假成功状态码必须 >=400（实测 ${st}），否则 tryMember 的 resp.status < 400 会判成功`)
  ok(`S6-2 opencode 假成功返回 HTTP ${st} → 组路由 tryMember 判失败并继续换成员`)
}

// S6-3: isStreamRequest 只声明一次且在 opencode 分支之前（否则 TDZ 运行时报错）
{
  const decls = [...PROXY_SRC.matchAll(/const isStreamRequest = /g)]
  assert.strictEqual(decls.length, 1, `isStreamRequest 必须只声明一次（实测 ${decls.length} 次）`)
  const declAt = PROXY_SRC.indexOf('const isStreamRequest = ')
  const ocAt = PROXY_SRC.indexOf('if (isOpenCodeProvider(providerId))')
  assert.ok(declAt < ocAt, 'isStreamRequest 必须在 opencode 分支之前声明（避免 TDZ）')
  ok('S6-3 isStreamRequest 单一声明且位于 opencode 分支之前（无 TDZ 风险）')
}

console.log('\n=== S7：死代码清理 ===')

// S7-1: isRetryableGroupStatus 函数定义已删除（S3 后无调用方）
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/function isRetryableGroupStatus/.test(code),
    'isRetryableGroupStatus 函数定义应已删除（S3 后无调用方）')
  assert.ok(!/isRetryableGroupStatus\s*\(/.test(code), '不得残留任何调用')
  ok('S7-1 死代码 isRetryableGroupStatus 已删除（组路由不再有状态码白名单）')
}

// S7-2: opencode 镜像回退的 isRetryableMirrorStatus 必须保留（不是死代码，别误删）
{
  const OC_SRC = readFileSync(join(HERE, '../src/opencode.ts'), 'utf8')
  assert.ok(/function isRetryableMirrorStatus/.test(OC_SRC), 'isRetryableMirrorStatus 必须保留')
  assert.ok(/isRetryableMirrorStatus\(response\.status\)/.test(OC_SRC), '必须仍有调用点（镜像回退在用）')
  ok('S7-2 opencode 镜像回退 isRetryableMirrorStatus 未被误删，仍在使用')
}

console.log('\n=== S5：告警防抖计数语义（数字不得说谎） ===')

// 移植 src/alerts.ts checkDebounce 的新语义
const ALERTS_SRC = readFileSync(join(HERE, '../src/alerts.ts'), 'utf8')

function makeDebounce(windowMs) {
  let store = null
  return function checkDebounce(now) {
    if (store) {
      const suppressed = store.count
      if (now - store.lastSent < windowMs) {
        store = { lastSent: store.lastSent, count: suppressed + 1 }
        return { ok: false, suppressed: suppressed + 1, silentMs: now - store.lastSent }
      }
      const silentMs = now - store.lastSent
      store = { lastSent: now, count: 0 }
      return { ok: true, suppressed, silentMs }
    }
    store = { lastSent: now, count: 0 }
    return { ok: true, suppressed: 0, silentMs: 0 }
  }
}

// S5-4: 推送后计数清零，不再无限累加（生产实测 count=71 / lastSent 24 小时前）
{
  assert.ok(/count:\s*0\s*\}\)\)/.test(ALERTS_SRC) || /count: 0 \}/.test(ALERTS_SRC),
    'checkDebounce 必须在推送时把 count 写 0')
  assert.ok(!/state\.count\+\+/.test(ALERTS_SRC), '不得再原地累加 state.count（旧的无限累加语义）')
  const cd = makeDebounce(300_000)
  let t = 1_000_000
  assert.strictEqual(cd(t).ok, true, '首次必须推送')
  for (let i = 1; i <= 5; i++) assert.strictEqual(cd(t + i * 1000).ok, false, '窗口内抑制')
  const after = cd(t + 400_000)
  assert.strictEqual(after.ok, true, '窗口过后推送')
  assert.strictEqual(after.suppressed, 5, `被抑制次数应为 5（实测 ${after.suppressed}）`)
  const next = cd(t + 800_000)
  assert.strictEqual(next.suppressed, 0, '上次推送后应清零，不再把历史次数带进下一条告警')
  ok('S5-4 防抖计数推送后清零：5 次抑制如实上报，下一条不再累积历史（修 count=71 说谎）')
}

// S5-5: 文案不再写死"过去 5 分钟"，改用真实静默区间
{
  // 注意：必须先剥掉注释——注释里为了说明缘由引用了旧文案原文，
  // 直接对全文 grep 会把说明性引用误判成实际代码（第一版断言就在这里假失败）。
  const alertsCode = ALERTS_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/过去 5 分钟内该问题共发生/.test(alertsCode), '实际代码不得再写死"过去 5 分钟"文案')
  assert.ok(/距上次通知约/.test(alertsCode), '必须使用真实静默区间文案')
  assert.ok(/silentMs/.test(alertsCode), '必须基于 silentMs 计算区间')
  // 24 小时静默 + 71 次抑制 → 文案应显示"小时"而非"5 分钟"
  const mins = Math.round(86_400_000 / 60_000)
  const span = mins >= 60 ? `${(mins / 60).toFixed(1)} 小时` : `${mins} 分钟`
  assert.strictEqual(span, '24.0 小时', `24h 静默应渲染为小时（实测 ${span}）`)
  ok(`S5-5 文案改为真实区间：24h 静默 + 71 次抑制 → "距上次通知约 ${span}"，不再谎称 5 分钟`)
}

// S5-6: 抑制期内仍写后台日志（可观测性不得因防抖丢失）
{
  const sendAlertFn = ALERTS_SRC.match(/export async function sendAlert[\s\S]*?\n}/)[0]
  const suppressedBranch = sendAlertFn.match(/if \(!ok\) \{[\s\S]*?return\n\s*\}/)[0]
  assert.ok(/recordAlert/.test(suppressedBranch), '防抖抑制分支仍必须 recordAlert（后台日志不丢）')
  ok('S5-6 防抖抑制期内仍写 alert:log（TG 静默但后台可追溯）')
}

console.log('\n=== S8：探测门槛按响应 content-type 判定（非流式盲区） ===')

// S8-1: 必须存在 isSseResponse 并基于 content-type 判定
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(/function isSseResponse/.test(code), '必须存在 isSseResponse 判定函数')
  const fn = code.match(/function isSseResponse[\s\S]*?\n}/)[0]
  assert.ok(/content-type/i.test(fn), 'isSseResponse 必须读 content-type 头')
  assert.ok(/text\\\/event-stream/i.test(fn) || /text\/event-stream/i.test(fn),
    'isSseResponse 必须匹配 text/event-stream')
  ok('S8-1 isSseResponse 按响应 content-type 判定 SSE（不依赖请求侧 stream 参数）')
}

// S8-2: 两个探测点（通用 + opencode）都必须用 (isStreamRequest || isSseResponse(response))
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const gates = code.match(/if \(\(isStreamRequest \|\| isSseResponse\(response\)\)[^)]*\)/g) || []
  assert.strictEqual(gates.length, 2,
    `通用分支 + opencode 分支共 2 处探测门槛必须都用响应侧判定（实测 ${gates.length} 处）`)
  // 不得残留只看 isStreamRequest 的裸门槛（探测分支）
  assert.ok(!/if \(isStreamRequest && response\.body\)/.test(code),
    '不得残留 S4 初版的 `isStreamRequest && response.body` 裸门槛')
  assert.ok(!/if \(isStreamRequest && response\.ok && response\.body\)/.test(code),
    '不得残留 S6 初版的 `isStreamRequest && response.ok && response.body` 裸门槛')
  ok(`S8-2 两处探测门槛（通用 + opencode）均改为响应侧判定，无裸 isStreamRequest 残留`)
}

// S8-3: 语义仿真——非流式请求 + SSE 响应必须进探测
{
  const gate = (isStreamRequest, contentType) =>
    isStreamRequest || /text\/event-stream/i.test(contentType || '')

  const cases = [
    // [请求stream, 响应content-type, 期望是否探测, 说明]
    [true,  'text/event-stream',        true,  '流式请求 + SSE 响应'],
    [false, 'text/event-stream',        true,  '★非流式请求 + SSE 响应（S4 初版盲区，6/6 复现）'],
    [true,  'application/json',         true,  '流式请求 + JSON 响应（上游降级为非流，仍探测）'],
    [false, 'application/json',         false, '非流式 + JSON（普通响应，不进探测）'],
    [false, 'text/event-stream; charset=utf-8', true, 'SSE 带 charset 参数'],
    [false, 'TEXT/EVENT-STREAM',        true,  'content-type 大小写不敏感'],
    [false, null,                       false, '无 content-type 头'],
    [false, 'text/plain',               false, '纯文本响应'],
  ]
  for (const [s, ct, want, desc] of cases) {
    assert.strictEqual(gate(s, ct), want, `门槛判定错误：${desc}`)
  }
  ok(`S8-3 门槛语义 8 种组合全部正确（含关键盲区：非流式 + SSE → 必须探测）`)
}

// S8-4: 多模态非流式检测不得被 S8 破坏（response.clone().text() 路径仍在 !isStreamRequest 下）
{
  const code = PROXY_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(/if \(!isStreamRequest && hasImageContent\(forwardBody\)\)/.test(code),
    '多模态非流式检测必须保留 !isStreamRequest 门槛（与 S8 探测互不干扰）')
  ok('S8-4 多模态非流式检测路径未被 S8 影响')
}

console.log(`\n🎉 S1–S8 全部 ${pass} 组测试通过`)
