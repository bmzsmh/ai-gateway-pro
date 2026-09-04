// ============================================================
// A3（429 精确冷却不降权）+ A4（顺序轮转持久化指针）单元测试
// 2026-09-04
// 逻辑与 src/proxy.ts / src/config.ts 实现保持同步（逐行对照移植）
// ============================================================
import assert from 'assert'

const KEY_HEALTH_MAX_FAILURES = 5
const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000

let pass = 0
const ok = (msg) => { pass++; console.log(`✅ ${msg}`) }

// ===== 移植自 src/proxy.ts markKeyFailure（未改动，作为对照） =====
function markKeyFailure(h, now = Date.now()) {
  const health = h && typeof h === 'object' ? { ...h } : { failures: 0, lastFailed: false }
  health.failures = (health.failures || 0) + 1
  health.lastFailed = true
  if (health.failures >= KEY_HEALTH_MAX_FAILURES) {
    if (!health.demotedAt || now - health.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
      health.demotedAt = now
    }
  }
  return health
}

// ===== A3：移植自 src/proxy.ts applyRateLimitHealth（本次改造） =====
function applyRateLimitHealth(h, retryAfterMs, now = Date.now()) {
  const base = h && typeof h === 'object' ? { ...h } : { failures: 0, lastFailed: false }
  const cooldownMs = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS
  return {
    ...base,
    failures: base.failures || 0,
    lastFailed: true,
    cooldownUntil: now + cooldownMs,
  }
}

// ===== 移植自 src/proxy.ts L457-470 的 key 分类（未改动） =====
function classifyKey(h, now = Date.now()) {
  if (!h) return 'healthy'
  if (h.cooldownUntil && h.cooldownUntil > now) return 'demoted'
  if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
    if (!h.demotedAt) h.demotedAt = now
    if (now - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) return 'probation'
    return 'demoted'
  }
  if (h.lastFailed) return 'unhealthy'
  return 'healthy'
}

// ===== 移植自 src/proxy.ts parseRetryAfter（未改动） =====
function parseRetryAfter(value) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, KEY_HEALTH_COOLDOWN_MS)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), KEY_HEALTH_COOLDOWN_MS))
  return 0
}

// ===== A4：模拟 KV + 移植 readGroupPointer / writeGroupPointer / buildRotationOrder =====
class FakeKV {
  constructor(initial = {}) { this.store = { ...initial }; this.writes = 0 }
  async get(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null }
  async put(k, v) { this.store[k] = v; this.writes++ }
  async delete(k) { delete this.store[k] }
}
const GROUP_POINTER_KEY = (g) => `group:${g}:pointer`
const HEALTH_KEY = (p) => `key:health:${p}`

async function readGroupPointer(kv, groupId) {
  try {
    const raw = await kv.get(GROUP_POINTER_KEY(groupId))
    if (raw) {
      const parsed = JSON.parse(raw)
      const idx = Number(parsed?.idx)
      if (Number.isInteger(idx) && idx >= 0) return idx
    }
  } catch { /* 损坏 → 0 */ }
  return 0
}
async function writeGroupPointer(kv, groupId, idx) {
  try { await kv.put(GROUP_POINTER_KEY(groupId), JSON.stringify({ idx })) } catch { /* 忽略 */ }
}
function parseModelId(model) {
  const i = model.indexOf('/')
  if (i <= 0 || i === model.length - 1) return null
  return { providerId: model.substring(0, i), modelId: model.substring(i + 1) }
}
// ===== 移植自 src/proxy.ts（2026-09-04 A3+A4 改造后版本） =====
// isMemberCoolingDown：全部 enabled key 冷却才算冷却（避免多 key provider 被单 key 误伤）
async function isMemberCoolingDown(kv, member, providerMap, now = Date.now()) {
  const parsed = parseModelId(member)
  if (!parsed) return false
  const provider = providerMap.get(parsed.providerId)
  if (!provider) return false
  const enabledKeys = (provider.apiKeys || []).filter((k) => k.enabled && k.key)
  if (enabledKeys.length === 0) return false
  try {
    const raw = await kv.get(HEALTH_KEY(parsed.providerId))
    const healthData = raw ? JSON.parse(raw) : {}
    return enabledKeys.every((k) => {
      const h = healthData[k.key]
      return !!(h?.cooldownUntil && h.cooldownUntil > now)
    })
  } catch {
    return false
  }
}

// buildRotationOrder：排除冷却成员（不回退尝试冷却中的成员，全部冷却则 candidates 为空 → 降级）
async function buildRotationOrder(kv, primaryMembers, startIdx, providerMap, now = Date.now()) {
  const candidates = []
  let coolingCount = 0
  for (let k = 0; k < primaryMembers.length; k++) {
    const idx = (startIdx + k) % primaryMembers.length
    const member = primaryMembers[idx]
    if (await isMemberCoolingDown(kv, member, providerMap, now)) coolingCount++
    else candidates.push({ member, idx })
  }
  return { candidates, coolingCount }
}

// 默认 providerMap：每个成员 provider 单 key（与旧测试兼容）
function defaultProviderMap(members) {
  const map = new Map()
  for (const m of members) {
    const p = parseModelId(m)
    if (p && !map.has(p.providerId)) map.set(p.providerId, { id: p.providerId, apiKeys: [{ key: `key-${p.providerId}`, enabled: true }] })
  }
  return map
}

// 模拟 handleProxy 主力组轮转段（src/proxy.ts L393-422），返回命中的成员与最终指针
async function runGroupRotation(kv, groupId, primaryMembers, responder, now = Date.now(), maxAttempts = 6, providerMap = null) {
  const pMap = providerMap || defaultProviderMap(primaryMembers)
  const pointerIdx = await readGroupPointer(kv, groupId)
  const startIdx = pointerIdx % primaryMembers.length
  const { candidates, coolingCount } = await buildRotationOrder(kv, primaryMembers, startIdx, pMap, now)
  let attempts = 0
  const tried = []
  for (const cand of candidates) {
    if (attempts >= maxAttempts) break
    attempts++
    tried.push(cand.member)
    const success = responder(cand.member)
    if (success) {
      if (cand.idx !== pointerIdx) await writeGroupPointer(kv, groupId, cand.idx)
      return { hit: cand.member, hitIdx: cand.idx, pointer: await readGroupPointer(kv, groupId), tried, coolingCount, degraded: false }
    }
    await writeGroupPointer(kv, groupId, (cand.idx + 1) % primaryMembers.length)
  }
  return { hit: null, pointer: await readGroupPointer(kv, groupId), tried, coolingCount, degraded: true }
}

// 匿名 fixture：4 个主力成员，idx0/idx1 共享同一 provider（复现「同 provider 多模型」结构）
const CC = ['alpha/model-a', 'alpha/model-b', 'beta/model-a', 'gamma/model-a']

console.log('=== A3：429 精确冷却，不累加 failures、不降权 ===')

// A3-1: 429 带 Retry-After=30 → 精确冷却 30s，failures 不增
{
  const now = 1_000_000
  const h = applyRateLimitHealth({ failures: 3, lastFailed: false }, parseRetryAfter('30'), now)
  assert.strictEqual(h.failures, 3, 'failures 不得累加')
  assert.strictEqual(h.cooldownUntil, now + 30_000, 'cooldownUntil = now + 30s')
  assert.strictEqual(h.demotedAt, undefined, '不得设置 demotedAt')
  assert.strictEqual(classifyKey(h, now), 'demoted', '冷却内分类为 demoted（被跳过）')
  assert.strictEqual(classifyKey(h, now + 31_000), 'unhealthy', '冷却期满后不再 demoted（failures<5）')
  ok('A3-1 带 Retry-After：精确冷却 30s，failures 不变，无 demotedAt，期满即恢复')
}

// A3-2: 429 无 Retry-After → 默认 60s 冷却，failures 不增
{
  const now = 2_000_000
  const h = applyRateLimitHealth({ failures: 4, lastFailed: true }, parseRetryAfter(null), now)
  assert.strictEqual(h.failures, 4, 'failures 不得累加')
  assert.strictEqual(h.cooldownUntil, now + DEFAULT_RATE_LIMIT_COOLDOWN_MS, '默认冷却 60s')
  assert.strictEqual(h.demotedAt, undefined, '不得设置 demotedAt')
  ok('A3-2 无 Retry-After：默认 60s 冷却，failures 不变（旧实现会 +1 并可能触发降权）')
}

// A3-3: 连续 10 次 429 无 Retry-After → 永不进入 demotedAt 永久降权（对比旧行为）
{
  let now = 3_000_000
  let hNew = undefined
  let hOld = undefined
  for (let i = 0; i < 10; i++) {
    now += 61_000 // 每次都在上次冷却期满后
    hNew = applyRateLimitHealth(hNew, null, now)
    hOld = markKeyFailure(hOld, now) // 旧实现：无 Retry-After 走 markKeyFailure
  }
  assert.strictEqual(hNew.failures, 0, '新实现：10 次 429 后 failures 仍为 0')
  assert.strictEqual(hNew.demotedAt, undefined, '新实现：从不设置 demotedAt')
  assert.strictEqual(classifyKey(hNew, now + 61_000), 'unhealthy', '新实现：冷却期满即可用（非 demoted）')
  assert.strictEqual(hOld.failures, 10, '旧实现：failures 累积到 10')
  assert.ok(hOld.demotedAt, '旧实现：已设置 demotedAt（永久降权链）')
  assert.ok(['demoted', 'probation'].includes(classifyKey(hOld, now)), '旧实现：陷入 demoted/probation 降权循环')
  ok('A3-3 连续 10 次 429：新实现 failures=0 无降权；旧实现 failures=10 已降权（根因 L2 已消除）')
}

// A3-4: 5xx / 超时仍走 markKeyFailure 降权（A3 不影响真实故障判定）
{
  const now = 4_000_000
  let h = undefined
  for (let i = 0; i < 5; i++) h = markKeyFailure(h, now)
  assert.strictEqual(h.failures, 5, '5xx 连续 5 次 → failures=5')
  assert.strictEqual(h.demotedAt, now, '5xx 达阈值 → 设置 demotedAt')
  assert.strictEqual(classifyKey(h, now), 'demoted', '5xx 降权生效')
  ok('A3-4 5xx/超时路径不受影响：仍累加 failures 并在第 5 次降权')
}

console.log('\n=== A4：顺序轮转持久化指针 ===')

// A4-1: Worker 冷启动 / 指针不存在 → 从模型 1（idx=0）开始
{
  const kv = new FakeKV()
  const r = await runGroupRotation(kv, 'cc', CC, () => true)
  assert.strictEqual(r.hitIdx, 0, '指针缺失 → 从 idx=0 起')
  assert.strictEqual(r.hit, CC[0], '命中第一个成员')
  assert.strictEqual(kv.store[GROUP_POINTER_KEY('cc')], undefined, 'idx 与已存指针(默认0)一致 → 不产生 KV 写')
  ok('A4-1 冷启动/指针缺失：从模型 1（idx=0）开始，且不产生多余 KV 写')
}

// A4-2: 指针损坏（非法 JSON / 负数 / 非整数）→ 回退 idx=0
{
  for (const bad of ['{not json', '{"idx":-3}', '{"idx":"abc"}', '{"idx":1.5}', '{}']) {
    const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: bad })
    const idx = await readGroupPointer(kv, 'cc')
    assert.strictEqual(idx, 0, `损坏指针 ${bad} → 回退 0`)
  }
  ok('A4-2 指针数据损坏（5 种非法形态）：全部安全回退到 idx=0')
}

// A4-3: 粘滞——指针指向的成员可用就一直用，连发 20 次不漂移
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 2 }) })
  const hits = []
  for (let i = 0; i < 20; i++) {
    const r = await runGroupRotation(kv, 'cc', CC, () => true)
    hits.push(r.hit)
  }
  assert.strictEqual(new Set(hits).size, 1, '20 次请求必须全部命中同一成员')
  assert.strictEqual(hits[0], CC[2], '命中指针指向的 idx=2 成员')
  assert.strictEqual(kv.writes, 0, '全程无 KV 写（指针未变）')
  ok(`A4-3 粘滞：20 次请求全部命中 ${CC[2]}，0 次 KV 写（旧随机实现会散布到 4 个成员）`)
}

// A4-4: 报错才推进——当前成员失败 → 指针推进到下一个，成功后粘住新成员
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 0 }) })
  // 第 1 次：idx=0 失败，idx=1 成功
  const r1 = await runGroupRotation(kv, 'cc', CC, (m) => m !== CC[0])
  assert.strictEqual(r1.hit, CC[1], '第 1 次：idx=0 失败后落到 idx=1')
  assert.strictEqual(r1.pointer, 1, '指针推进并停在 idx=1')
  // 第 2 次：idx=1 可用 → 直接命中，不再试 idx=0
  const r2 = await runGroupRotation(kv, 'cc', CC, (m) => m !== CC[0])
  assert.strictEqual(r2.hit, CC[1], '第 2 次：直接命中 idx=1')
  assert.deepStrictEqual(r2.tried, [CC[1]], '第 2 次只尝试了 1 个成员（不重试已知坏的 idx=0）')
  ok('A4-4 报错才推进：失败 → 指针+1；成功后粘住新成员，后续不再撞已失败成员')
}

// A4-5: 环形——idx=3（最后一个）失败 → 回到 idx=0
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 3 }) })
  const r = await runGroupRotation(kv, 'cc', CC, (m) => m === CC[0])
  assert.strictEqual(r.hit, CC[0], 'idx=3 失败 → 环回 idx=0 成功')
  assert.strictEqual(r.pointer, 0, '指针环回 0')
  assert.deepStrictEqual(r.tried, [CC[3], CC[0]], '尝试顺序 3 → 0（环形）')
  ok('A4-5 环形轮转：最后一个成员失败后回到模型 1（idx=3 → idx=0）')
}

// A4-6: 连续 429 切换（用户要求场景）——每个成员被 429 冷却后依次推进到下一个健康成员
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 0 }) })
  let t = 10_000_000
  const sequence = []
  const pMap = defaultProviderMap(CC)
  // 模拟上游依次对「当前指针成员」返回 429（写 A3 冷却），每轮时间推进 61s
  //（60s 默认冷却 + 1s），让更早的冷却过期 → 从而验证「冷却跳过 + 冷却期满自动恢复」
  for (let round = 0; round < 3; round++) {
    const ptr = await readGroupPointer(kv, 'cc')
    const target = CC[ptr % CC.length]
    const pid = parseModelId(target).providerId
    const existing = JSON.parse((await kv.get(HEALTH_KEY(pid))) || '{}')
    existing[`key-${pid}`] = applyRateLimitHealth(existing[`key-${pid}`], null, t)
    await kv.put(HEALTH_KEY(pid), JSON.stringify(existing))
    const r = await runGroupRotation(kv, 'cc', CC, () => true, t, 6, pMap)
    sequence.push(r.hit)
    t += 61_000
  }
  assert.strictEqual(sequence[0], CC[2], '轮次1：alpha 429 → idx0/idx1 同 provider 双双跳过 → 环到 beta')
  assert.strictEqual(sequence[1], CC[3], '轮次2：beta 429 → 一跳 gamma')
  assert.strictEqual(sequence[2], CC[0], '轮次3：gamma 429，alpha 冷却已过期 → 环回 alpha（自动恢复，A3 生效）')
  ok(`A4-6 连续 429 切换：${sequence.join(' → ')}（指针环形推进 + 冷却中跳过 + 冷却期满自动恢复）`)
}

// A4-7: 全部成员冷却 → 降级（返回 degraded），指针不被重置
{
  const now = 20_000_000
  const store = { [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 2 }) }
  for (const m of CC) {
    const pid = parseModelId(m).providerId
    store[HEALTH_KEY(pid)] = JSON.stringify({ [`key-${pid}`]: { failures: 0, lastFailed: true, cooldownUntil: now + 60_000 } })
  }
  const kv = new FakeKV(store)
  const { coolingCount } = await buildRotationOrder(kv, CC, 2, defaultProviderMap(CC), now)
  assert.strictEqual(coolingCount, CC.length, '全部 4 个成员识别为冷却中')
  const r = await runGroupRotation(kv, 'cc', CC, () => false, now)
  assert.strictEqual(r.degraded, true, 'CC 全灭 → 进入降级路径（交给现有 backup 逻辑）')
  ok('A4-7 CC 全部冷却：识别 4/4 冷却 → 走现有降级到 XX 路径（未改动降级逻辑）')
}

// A4-8: 降级到 XX 后恢复 CC → 不重置指针，从停留位置继续（用户明确要求）
{
  const now = 30_000_000
  // 阶段1：指针停在 idx=2，全部成员冷却 → 降级
  const store = { [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 2 }) }
  for (const m of CC) {
    const pid = parseModelId(m).providerId
    store[HEALTH_KEY(pid)] = JSON.stringify({ [`key-${pid}`]: { failures: 0, lastFailed: true, cooldownUntil: now + 60_000 } })
  }
  const kv = new FakeKV(store)
  const rDegraded = await runGroupRotation(kv, 'cc', CC, () => false, now)
  assert.strictEqual(rDegraded.degraded, true, '阶段1：降级成立')
  const ptrAfterDegrade = await readGroupPointer(kv, 'cc')
  // 阶段2：冷却全部期满（CC 自动恢复），指针必须仍在原位
  const later = now + 61_000
  const rRecovered = await runGroupRotation(kv, 'cc', CC, () => true, later)
  assert.strictEqual(rRecovered.hit, CC[ptrAfterDegrade % CC.length], '阶段2：从指针停留位置继续，未重置为模型 1')
  assert.notStrictEqual(rRecovered.hit, CC[0], '阶段2：确认不是回到 idx=0')
  ok(`A4-8 降级→恢复：指针停留 idx=${ptrAfterDegrade}，恢复后从 ${rRecovered.hit} 继续（未重置）`)
}

// A4-9: 指针 >= 成员数（成员被删减）→ 取模安全回绕，不越界
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 99 }) })
  const r = await runGroupRotation(kv, 'cc', CC, () => true)
  assert.strictEqual(r.hitIdx, 99 % CC.length, 'idx=99 → 取模 = 3')
  assert.ok(r.hit, '未越界，正常命中成员')
  const kv2 = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 3 }) })
  const r2 = await runGroupRotation(kv2, 'cc', CC.slice(0, 2), () => true)
  assert.strictEqual(r2.hitIdx, 3 % 2, '成员从 4 缩到 2，idx=3 → 取模 = 1')
  ok('A4-9 指针越界/成员数变化：取模安全回绕（99→3、成员缩减 3→1），无数组越界')
}

// A4-10: MAX_TOTAL_GROUP_ATTEMPTS 上限仍生效（不因轮转打破 attempts 预算）
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 0 }) })
  const many = Array.from({ length: 10 }, (_, i) => `p${i}/m${i}`)
  const r = await runGroupRotation(kv, 'cc', many, () => false, Date.now(), 6)
  assert.strictEqual(r.tried.length, 6, '最多尝试 MAX_TOTAL_GROUP_ATTEMPTS=6 个成员')
  ok('A4-10 attempts 预算：10 成员组最多尝试 6 次，上限未被轮转改造破坏')
}

// A4-11: KV 写入次数——粘滞期 0 写，仅切换时写（KV 配额友好）
{
  const kv = new FakeKV({ [GROUP_POINTER_KEY('cc')]: JSON.stringify({ idx: 0 }) })
  for (let i = 0; i < 50; i++) await runGroupRotation(kv, 'cc', CC, () => true)
  assert.strictEqual(kv.writes, 0, '50 次成功请求（指针不变）→ 0 次 KV 写')
  const before = kv.writes
  await runGroupRotation(kv, 'cc', CC, (m) => m !== CC[0]) // 触发一次切换
  assert.ok(kv.writes > before, '发生切换时才写 KV')
  ok(`A4-11 KV 写入友好：50 次粘滞请求 0 写；切换时写 ${kv.writes - before} 次`)
}

// A4-12: 多 key provider —— 只有部分 key 冷却时，成员不算冷却（不被误跳过）
{
  const now = 40_000_000
  const members = ['multi/model-a', 'solo/model-b']
  const pMap = new Map([
    ['multi', { id: 'multi', apiKeys: [{ key: 'k1', enabled: true }, { key: 'k2', enabled: true }] }],
    ['solo', { id: 'solo', apiKeys: [{ key: 's1', enabled: true }] }],
  ])
  // multi 只有 k1 冷却，k2 健康 → 不算冷却
  const kv = new FakeKV({
    [GROUP_POINTER_KEY('t')]: JSON.stringify({ idx: 0 }),
    [HEALTH_KEY('multi')]: JSON.stringify({ k1: { failures: 0, lastFailed: true, cooldownUntil: now + 60_000 } }),
  })
  const r1 = await buildRotationOrder(kv, members, 0, pMap, now)
  assert.strictEqual(r1.coolingCount, 0, '部分 key 冷却 → 成员不算冷却')
  assert.strictEqual(r1.candidates[0].member, 'multi/model-a', '仍优先使用指针指向的成员')
  // 两把 key 都冷却 → 才算冷却
  await kv.put(HEALTH_KEY('multi'), JSON.stringify({
    k1: { failures: 0, lastFailed: true, cooldownUntil: now + 60_000 },
    k2: { failures: 0, lastFailed: true, cooldownUntil: now + 60_000 },
  }))
  const r2 = await buildRotationOrder(kv, members, 0, pMap, now)
  assert.strictEqual(r2.coolingCount, 1, '全部 key 冷却 → 成员算冷却')
  assert.strictEqual(r2.candidates[0].member, 'solo/model-b', '冷却成员被跳过，落到下一个')
  ok('A4-12 多 key provider：部分 key 冷却不误判；全部 key 冷却才跳过（防单 key 限流误伤）')
}

console.log(`\n🎉 A3+A4 全部 ${pass} 组测试通过`)
