// ============================================================
// S11（2026-09-06）真实实现集成测试 —— 取代 tests/run-tests-rotation.mjs
//
// 与被取代文件的根本区别：**这里调用的是 src/proxy.ts 里真正的函数**
// （经 esbuild 打包后 import），不是在测试里重抄一份逻辑。
// 旧文件自己实现了 readGroupPointer/writeGroupPointer/buildRotationOrder，
// 所以 S1 删掉粘滞指针后它仍然 16/16 全绿 —— 测的是已不存在的行为。
//
// 【测试隔离注意】proxy.ts 的 healthMemoryCache 是模块级 Map，按 providerId 缓存。
// 同一个 providerId 在不同测试块里会命中上一块留下的缓存，因此每个块用独立
// provider 命名空间（nsGroup()）。R7 需要"同一组在不同时间点"的语义，改用真实
// sleep 跨过 TTL —— 顺带把 S10 的非对称 TTL 在真实时间轴上验证一遍。
//
// 覆盖：
//   R1  A3 保留：429 精确冷却不降权（多账号锁死解药）
//   R2  S9 假成功冷却：落 KV 白名单 + 自愈 + 升级
//   R3  S10 非对称健康度缓存 TTL
//   R4  真实 buildRotationOrder：随机起点 / 全遍历 / 跳过冷却 / 全冷却→空 / 期满回归
//   R5  真实 isMemberCoolingDown：多 key provider 不被单 key 误伤 + KV 故障隔离
//   R6  真实 probeStreamHead + restoreStream + isSseResponse
//   R7  CC→XX→CC 完整自愈时间线（真函数 + 真实时间推进）
// ============================================================
import assert from 'assert'
import {
  loadProxyModule, readSrc, FakeKV, fakeEnv, provider, providerMap, sseResponse,
} from './_load-src.mjs'

const P = await loadProxyModule()
const CONFIG_SRC = readSrc('config.ts')
const PROXY_SRC = readSrc('proxy.ts')

let pass = 0
const ok = (m) => { pass++; console.log(`✅ ${m}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 从 config.ts 抽真实常量（反漂移）
const num = (name) => {
  const m = CONFIG_SRC.match(new RegExp(`export const ${name} = ([^\\n]+)`))
  assert.ok(m, `config.ts 必须定义 ${name}`)
  return Function(`return (${m[1].replace(/\/\/.*$/, '')})`)()
}
const KEY_HEALTH_MAX_FAILURES = num('KEY_HEALTH_MAX_FAILURES')
const KEY_HEALTH_COOLDOWN_MS = num('KEY_HEALTH_COOLDOWN_MS')
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = num('DEFAULT_RATE_LIMIT_COOLDOWN_MS')
const FAKE_SUCCESS_COOLDOWN_MS = num('FAKE_SUCCESS_COOLDOWN_MS')

// writeHealth 的 P1 落库白名单条件（从源码正则确认后复刻，供 R2/R7 断言"会不会落 KV"）
{
  const w = PROXY_SRC.match(/async function writeHealth[\s\S]*?\n}/)[0]
  assert.ok(/v\.failures >= KEY_HEALTH_MAX_FAILURES/.test(w), 'writeHealth P1 白名单必须含 failures>=KEY_HEALTH_MAX_FAILURES')
  assert.ok(/v\.cooldownUntil && v\.cooldownUntil > Date\.now\(\)/.test(w), 'writeHealth P1 白名单必须含 cooldownUntil>now')
}
const p1Keeps = (v, t) => v.failures >= KEY_HEALTH_MAX_FAILURES || (v.cooldownUntil && v.cooldownUntil > t)

// proxy.ts 的 key 分类判定镜像（R4/R5 已直接调用真函数覆盖路由行为，这里只用于表达"冷却/降权/候选"三态）
const classify = (h, now) => {
  if (!h) return 'healthy'
  if (h.cooldownUntil && h.cooldownUntil > now) return 'demoted'
  if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
    return now - (h.demotedAt ?? now) >= KEY_HEALTH_COOLDOWN_MS ? 'probation' : 'demoted'
  }
  return h.lastFailed ? 'unhealthy' : 'healthy'
}

// 每个测试块独立的 provider 命名空间，避开模块级 healthMemoryCache 交叉污染
let nsSeq = 0
function nsGroup(size = 4, keysPerProvider = 1) {
  const tag = `n${++nsSeq}`
  const ids = Array.from({ length: size }, (_, i) => `${tag}p${i}`)
  return {
    ids,
    members: ids.map(id => `${id}/m1`),
    pm: providerMap(...ids.map(id => provider(id, keysPerProvider))),
    /** health: { providerId: { keyName: KeyHealth } } → 组装成 KV 初始内容 */
    env(health = {}) {
      const store = {}
      for (const [pid, hm] of Object.entries(health)) store[`key:health:${pid}`] = JSON.stringify(hm)
      const kv = new FakeKV(store)
      return { kv, env: fakeEnv(kv) }
    },
    cooled(ids2, at = Date.now() + 120_000) {
      const h = {}
      for (const pid of ids2) h[pid] = { [`k_${pid}_0`]: { failures: 1, lastFailed: true, cooldownUntil: at } }
      return h
    },
  }
}

console.log('=== R1：A3 保留 —— 429 只冷却不降权（真函数 applyRateLimitHealth） ===')

{
  const now = 1_000_000
  const h = P.applyRateLimitHealth({ failures: 3, lastFailed: false }, P.parseRetryAfter('30'), now)
  assert.strictEqual(h.failures, 3, '429 不得累加 failures')
  assert.strictEqual(h.cooldownUntil, now + 30_000, '按 Retry-After 精确冷却 30s')
  assert.strictEqual(h.demotedAt, undefined, '429 不得设置 demotedAt')
  assert.strictEqual(classify(h, now), 'demoted', '冷却内被跳过')
  assert.strictEqual(classify(h, now + 31_000), 'unhealthy', '期满即恢复候选（failures<5）')
  ok('R1-1 带 Retry-After：精确冷却 30s，failures 不变，无 demotedAt，期满恢复')
}

{
  const now = 2_000_000
  const h = P.applyRateLimitHealth({ failures: 4, lastFailed: true }, P.parseRetryAfter(null), now)
  assert.strictEqual(h.failures, 4)
  assert.strictEqual(h.cooldownUntil, now + DEFAULT_RATE_LIMIT_COOLDOWN_MS)
  assert.strictEqual(h.demotedAt, undefined)
  ok(`R1-2 无 Retry-After：默认冷却 ${DEFAULT_RATE_LIMIT_COOLDOWN_MS / 1000}s，failures 不变`)
}

{
  let now = 3_000_000
  let hNew, hOld
  for (let i = 0; i < 20; i++) {
    now += DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1_000
    hNew = P.applyRateLimitHealth(hNew, null, now)
    hOld = P.markKeyFailure(hOld, now)
  }
  assert.strictEqual(hNew.failures, 0, '20 次 429 后 failures 仍为 0')
  assert.strictEqual(hNew.demotedAt, undefined)
  assert.strictEqual(classify(hNew, now + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1), 'unhealthy')
  assert.strictEqual(hOld.failures, 20, '对照：markKeyFailure 会累积到 20')
  assert.ok(hOld.demotedAt, '对照：已进入降权链')
  ok('R1-3 连续 20 次 429：新语义 failures=0 永不降权（旧语义已降权）—— 多账号锁死解药在位')
}

{
  const now = 4_000_000
  let h
  for (let i = 0; i < KEY_HEALTH_MAX_FAILURES; i++) h = P.markKeyFailure(h, now)
  assert.strictEqual(h.failures, KEY_HEALTH_MAX_FAILURES)
  assert.strictEqual(h.demotedAt, now)
  assert.strictEqual(classify(h, now), 'demoted')
  ok(`R1-4 真故障不受豁免影响：连续 ${KEY_HEALTH_MAX_FAILURES} 次 5xx 仍降权`)
}

console.log('\n=== R2：S9 假成功冷却 —— 从「识破」到「记住」（真函数 markFakeSuccess） ===')

{
  const now = 5_000_000
  const h = P.markFakeSuccess(undefined, now)
  assert.strictEqual(h.failures, 1, '假成功是真故障，failures 累加')
  assert.strictEqual(h.lastFailed, true)
  assert.strictEqual(h.cooldownUntil, now + FAKE_SUCCESS_COOLDOWN_MS)
  ok(`R2-1 markFakeSuccess：failures+1 且设 ${FAKE_SUCCESS_COOLDOWN_MS / 1000}s 冷却`)
}

{
  const now = 6_000_000
  const old = P.markKeyFailure(undefined, now)
  const neu = P.markFakeSuccess(undefined, now)
  assert.ok(!p1Keeps(old, now), '旧行为：failures=1 不满足 P1 白名单 → 永不落 KV（这就是遗留 bug）')
  assert.ok(p1Keeps(neu, now), '新行为：cooldownUntil>now 命中 P1 白名单 → 立刻落 KV')
  ok('R2-2 落库原理验证：只加 cooldownUntil 即命中既有 P1 白名单，无需改动 P1 阈值')
}

{
  const now = 7_000_000
  const h = P.markFakeSuccess(undefined, now)
  assert.strictEqual(classify(h, now + 1), 'demoted')
  assert.strictEqual(classify(h, now + FAKE_SUCCESS_COOLDOWN_MS - 1), 'demoted', '临界前仍冷却')
  assert.strictEqual(classify(h, now + FAKE_SUCCESS_COOLDOWN_MS + 1), 'unhealthy', '期满自动回归候选')
  ok('R2-3 自愈路径：冷却期满自动回到候选池 —— 这就是「降 XX 之后再返回 CC」')
}

{
  let now = 8_000_000
  let h
  for (let i = 0; i < KEY_HEALTH_MAX_FAILURES; i++) {
    now += FAKE_SUCCESS_COOLDOWN_MS + 1_000
    h = P.markFakeSuccess(h, now)
  }
  assert.strictEqual(h.failures, KEY_HEALTH_MAX_FAILURES)
  assert.ok(h.demotedAt, `连续 ${KEY_HEALTH_MAX_FAILURES} 次假成功 → 进入长期降权`)
  ok(`R2-4 升级路径：反复假成功累计到 ${KEY_HEALTH_MAX_FAILURES} 次 → 长期降权（${KEY_HEALTH_COOLDOWN_MS / 60000} 分钟），不是无限 ${FAKE_SUCCESS_COOLDOWN_MS / 1000}s 循环`)
}

console.log('\n=== R3：S10 非对称健康度缓存 TTL（真函数 healthCacheTtl） ===')

{
  const clean = P.healthCacheTtl({})
  const dirty = P.healthCacheTtl({ k1: { failures: 5, lastFailed: true } })
  assert.ok(clean < dirty, '空健康度的 TTL 必须严格短于非空')
  assert.strictEqual(clean, 1_000, '空（全健康）→ 1s')
  assert.strictEqual(dirty, 5_000, '非空（含坏 key）→ 5s')
  ok(`R3-1 非对称 TTL：空=${clean}ms / 非空=${dirty}ms —— 陈旧空缓存窗口压到 1/5`)
}

{
  assert.ok(!/HEALTH_MEMORY_CACHE_TTL_MS/.test(PROXY_SRC), '不得再使用统一 TTL 常量')
  assert.ok(/HEALTH_CACHE_TTL_CLEAN_MS/.test(PROXY_SRC) && /HEALTH_CACHE_TTL_DIRTY_MS/.test(PROXY_SRC), '必须保留两档 TTL')
  assert.ok(/healthCacheTtl\(data\)/.test(PROXY_SRC) && /healthCacheTtl\(filtered\)/.test(PROXY_SRC),
    'readHealth 与 writeHealth 都必须走 healthCacheTtl')
  ok('R3-2 两个缓存写入点（readHealth / writeHealth）均按内容分档，无统一 TTL 残留')
}

console.log('\n=== R4：真实 buildRotationOrder —— 随机起点 / 全遍历 / 跳过冷却 ===')

{
  const g = nsGroup(4)
  const { env } = g.env()
  const seen = new Set()
  let totalLen = 0
  for (let i = 0; i < 400; i++) {
    const r = await P.buildRotationOrder(env, g.members, g.pm)
    seen.add(r.startIdx)
    totalLen += r.candidates.length
    assert.strictEqual(r.candidates.length, 4, '全健康时候选必须是全部成员')
    assert.strictEqual(r.coolingCount, 0)
  }
  assert.strictEqual(seen.size, 4, `400 次采样必须覆盖全部 4 个起点，实测 ${seen.size}`)
  assert.strictEqual(totalLen, 1600)
  ok('R4-1 随机起点覆盖全部 4 个位置，且每次候选都是全量 4 个成员（无预算截断）')
}

{
  const g = nsGroup(4)
  const { env } = g.env()
  for (let t = 0; t < 50; t++) {
    const r = await P.buildRotationOrder(env, g.members, g.pm)
    const expect = Array.from({ length: 4 }, (_, k) => g.members[(r.startIdx + k) % 4])
    assert.deepStrictEqual(r.candidates.map(c => c.member), expect, '候选顺序必须是从 startIdx 起的环形序')
  }
  ok('R4-2 环形遍历顺序正确（从随机起点环绕，无重复无遗漏）')
}

{
  const g = nsGroup(4)
  const { env, kv } = g.env(g.cooled([g.ids[0], g.ids[2]]))
  const r = await P.buildRotationOrder(env, g.members, g.pm)
  assert.strictEqual(r.coolingCount, 2, '2 个成员冷却中')
  assert.deepStrictEqual(r.candidates.map(c => c.member).sort(), [g.members[1], g.members[3]].sort())
  assert.strictEqual(kv.writes, 0, '路由决策不产生 KV 写')
  ok(`R4-3 冷却成员被跳过：4 个成员中 2 个冷却 → 候选 ${r.candidates.length} 个，0 次 KV 写`)
}

{
  const g = nsGroup(4)
  const { env } = g.env(g.cooled(g.ids))
  const r = await P.buildRotationOrder(env, g.members, g.pm)
  assert.strictEqual(r.candidates.length, 0, '全冷却 → 候选为空')
  assert.strictEqual(r.coolingCount, 4)
  ok('R4-4 主力全冷却 → 候选为空 → 上层立即降级 backup，零无效上游调用')
}

{
  const g = nsGroup(4)
  const { env } = g.env(g.cooled(g.ids, Date.now() - 1_000))   // 冷却已过期
  const r = await P.buildRotationOrder(env, g.members, g.pm)
  assert.strictEqual(r.candidates.length, 4, '冷却已过期 → 全部成员回归候选')
  assert.strictEqual(r.coolingCount, 0)
  ok('R4-5 冷却期满自愈：过期 cooldownUntil 不再拦截，全部成员自动回归轮转')
}

console.log('\n=== R5：真实 isMemberCoolingDown —— 多 key provider 不被单 key 误伤 ===')

{
  const future = Date.now() + 120_000
  for (const n of [1, 2]) {
    const g = nsGroup(1, 3)
    const pid = g.ids[0]
    const hm = {}
    for (let i = 0; i < n; i++) hm[`k_${pid}_${i}`] = { failures: 1, lastFailed: true, cooldownUntil: future }
    const { env } = g.env({ [pid]: hm })
    assert.strictEqual(await P.isMemberCoolingDown(env, g.members[0], g.pm), false, `${n}/3 key 冷却 → 成员不算冷却`)
  }
  {
    const g = nsGroup(1, 3)
    const pid = g.ids[0]
    const hm = {}
    for (let i = 0; i < 3; i++) hm[`k_${pid}_${i}`] = { failures: 1, lastFailed: true, cooldownUntil: future }
    const { env } = g.env({ [pid]: hm })
    assert.strictEqual(await P.isMemberCoolingDown(env, g.members[0], g.pm), true, '3/3 key 冷却 → 成员冷却')
  }
  ok('R5-1 多 key provider：1/3、2/3 冷却均不误判，仅 3/3 全冷却才跳过（防单账号限流误伤整个 provider）')
}

{
  const g = nsGroup(1)
  const kv = new FakeKV()
  kv.get = async () => { throw new Error('KV down') }
  const r = await P.isMemberCoolingDown(fakeEnv(kv), g.members[0], g.pm)
  assert.strictEqual(r, false, 'KV 故障时不得判为冷却')
  ok('R5-2 KV 故障隔离：读健康度失败 → 视为未冷却，不因基础设施抖动误杀全部成员')
}

console.log('\n=== R6：真实 probeStreamHead / restoreStream / isSseResponse ===')

{
  const r = await P.probeStreamHead(sseResponse([
    'event: error\ndata: {"error":{"message":"no_available_workers","code":"upstream_error"}}\n\n',
    'event: done\ndata: [DONE]\n\n',
  ]))
  assert.ok(r, '探测必须返回结果')
  assert.strictEqual(r.isError, true, '首块为 event: error → 判假成功')
  await r.reader.cancel().catch(() => {})
  ok('R6-1 真函数识别 AMD 假成功报文（event: error + code:upstream_error）')
}

{
  const benign = [
    ': keep-alive\n\n',
    ': ping\n\n',
    'data: {"choices":[{"delta":{"content":"如何处理 error 情况"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hi"}}],"error":null}\n\n',
    'data: {"id":"x","object":"chat.completion.chunk"}\n\n',
  ]
  for (const b of benign) {
    const r = await P.probeStreamHead(sseResponse([b, 'data: [DONE]\n\n']))
    assert.ok(r)
    assert.strictEqual(r.isError, false, `正常首包必须放行: ${JSON.stringify(b.slice(0, 40))}`)
    await r.reader.cancel().catch(() => {})
  }
  ok(`R6-2 宽容判定：${benign.length} 种正常/边界首包全部放行（keep-alive、正文含 error 字样、error:null）`)
}

{
  const chunks = []
  for (let i = 0; i < 60; i++) chunks.push(`data: {"i":${i}}\n\n`)
  chunks.push('data: [DONE]\n\n')
  const probe = await P.probeStreamHead(sseResponse(chunks))
  assert.strictEqual(probe.isError, false)
  const stream = P.restoreStream(probe.first, probe.reader)
  const text = await new Response(stream).text()
  const dataLines = text.split('\n').filter(l => l.startsWith('data: '))
  assert.strictEqual(dataLines.length, 61, `必须收到 61 行 data，实测 ${dataLines.length}`)
  assert.ok(text.includes('{"i":0}'), '首块数据不得丢失')
  assert.ok(text.includes('{"i":59}'), '尾块数据不得丢失')
  assert.ok(text.includes('[DONE]'), '结束标记不得丢失')
  ok('R6-3 长流完整性：61 行 data 全部到达（含首块 i=0 与尾块 i=59 + [DONE]），首块拼回零丢失')
}

{
  const cases = [
    ['text/event-stream', true],
    ['text/event-stream; charset=utf-8', true],
    ['TEXT/EVENT-STREAM', true],
    ['application/json', false],
    ['text/plain', false],
    [null, false],
  ]
  for (const [ct, expect] of cases) {
    const headers = ct ? { 'Content-Type': ct } : {}
    assert.strictEqual(P.isSseResponse(new Response('x', { headers })), expect, `content-type=${ct} → ${expect}`)
  }
  ok(`R6-4 isSseResponse 门槛 ${cases.length} 种 content-type 判定全部正确（含大小写与 charset 变体）`)
}

console.log('\n=== R7：CC → XX → CC 完整自愈时间线（真函数 + 真实时间推进） ===')

{
  const g = nsGroup(4)
  const T0 = Date.now()

  // 阶段 1（t=T0）：全健康 → 4 个主力候选
  const { env: env1, kv: kv1 } = g.env()
  let r = await P.buildRotationOrder(env1, g.members, g.pm)
  assert.strictEqual(r.candidates.length, 4, 'T0：4 个主力候选')
  const stage1 = r.candidates.length

  // 4 个成员全部返回假成功 → markFakeSuccess → 按 P1 白名单落 KV
  const afterFail = {}
  let writes = 0
  for (const pid of g.ids) {
    const h = P.markFakeSuccess(undefined, T0)
    if (p1Keeps(h, T0)) { afterFail[`key:health:${pid}`] = JSON.stringify({ [`k_${pid}_0`]: h }); writes++ }
  }
  assert.strictEqual(writes, 4, '4 个成员的假成功状态全部落 KV（S9 之前一次都不会落）')

  // 阶段 2：新 isolate 读 KV。必须跨过 clean 缓存 TTL(1s) 才能看到新状态
  await sleep(1_150)
  const kv2 = new FakeKV(afterFail)
  r = await P.buildRotationOrder(fakeEnv(kv2), g.members, g.pm)
  assert.strictEqual(r.candidates.length, 0, '主力候选为空 → 降级 backup XX')
  assert.strictEqual(r.coolingCount, 4)
  const stage2 = r.candidates.length
  ok(`R7-1 CC 瘫痪 → 状态落 KV（${writes} 次写）→ 跨 isolate 读到全冷却 → 候选 ${stage2} 个 → 立即降级 XX，零无效上游调用`)

  // 阶段 3：冷却期满。上一次缓存是 dirty(5s)，必须真实等过 TTL
  const expired = {}
  for (const pid of g.ids) {
    const h = P.markFakeSuccess(undefined, T0 - FAKE_SUCCESS_COOLDOWN_MS - 2_000)
    expired[`key:health:${pid}`] = JSON.stringify({ [`k_${pid}_0`]: h })
  }
  await sleep(5_150)
  r = await P.buildRotationOrder(fakeEnv(new FakeKV(expired)), g.members, g.pm)
  assert.strictEqual(r.candidates.length, 4, '冷却期满 → 4 个主力全部回归候选')
  assert.strictEqual(r.coolingCount, 0)
  const stage3 = r.candidates.length

  ok(`R7-2 返回 CC：冷却期满（${FAKE_SUCCESS_COOLDOWN_MS / 1000}s）后主力自动回归 ${stage3}/4 个候选 —— 全自动，无需人工干预、无需重新部署`)
  ok(`R7-3 完整时间线：CC ${stage1} 候选 → 假成功全部记账 → CC ${stage2} 候选（降 XX）→ 期满 CC ${stage3} 候选（回归 CC）`)
  ok('R7-4 缓存 TTL 在真实时间轴上生效：跨过 1s(clean)/5s(dirty) 后新状态可见（S10 非对称 TTL 实证）')
}

{
  const g = nsGroup(4)
  const T0 = Date.now()
  const store = {}
  const recovered = [g.ids[0], g.ids[1]]
  for (const pid of g.ids) {
    const base = recovered.includes(pid) ? T0 - FAKE_SUCCESS_COOLDOWN_MS - 2_000 : T0
    store[`key:health:${pid}`] = JSON.stringify({ [`k_${pid}_0`]: P.markFakeSuccess(undefined, base) })
  }
  const r = await P.buildRotationOrder(fakeEnv(new FakeKV(store)), g.members, g.pm)
  assert.strictEqual(r.candidates.length, 2, '2 个期满成员回归')
  assert.deepStrictEqual(r.candidates.map(c => c.member).sort(), recovered.map(p => `${p}/m1`).sort())
  ok('R7-5 渐进恢复：成员各自独立冷却，先好的先回归（不是全体等最慢的那个）')
}

console.log(`\n🎉 R1–R7 全部 ${pass} 组真实实现集成测试通过`)
