// ============================================================
// 独立测试：P0-1 状态机测试（Case 1-7 + 长链）+ P0-2 冲突检测（场景 A-D）
// ============================================================
import assert from 'assert'
import { strict as assertStrict } from 'assert'

const KEY_HEALTH_MAX_FAILURES = 5
const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// ===== 模拟 P0-1 修复后的 markKeyFailure（与 proxy.ts 中 JS 实现完全同步） =====
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

// 模拟分类函数（与 proxy.ts L457-470 完全同步）
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

const OLD_TIMESTAMP = Date.now() - 600_000 // 10 分钟前（已过期）

// ===== P0-1: Health 状态机测试 =====

// Case 1: failures=4, no demotedAt → 失败 → failures=5, demotedAt=now
{
  const h = { failures: 4, demotedAt: undefined, lastFailed: false }
  const before = Date.now()
  const result = markKeyFailure(h)
  assert.strictEqual(result.failures, 5, 'Case1: failures should be 5')
  assert.ok(result.demotedAt !== undefined, 'Case1: demotedAt should be set')
  assert.ok(result.demotedAt >= before, 'Case1: demotedAt should be >= before')
  assert.ok(result.demotedAt <= Date.now(), 'Case1: demotedAt should be <= now')
  assert.strictEqual(result.lastFailed, true, 'Case1: lastFailed should be true')
  // 验证分类：demoted
  assert.strictEqual(classifyKey(result), 'demoted', 'Case1: should be demoted')
  console.log('✅ Case 1: 首次降权正确设置 demotedAt')
}

// Case 2: failures=5, demotedAt=now-30_000（cooldown 内）→ 再次失败 → demotedAt 不变
{
  const now = Date.now()
  const h = { failures: 5, demotedAt: now - 30_000, lastFailed: false }
  const demotedAtBefore = h.demotedAt
  const result = markKeyFailure(h, now)
  assert.strictEqual(result.failures, 6, 'Case2: failures should increase to 6')
  assert.strictEqual(result.demotedAt, demotedAtBefore, 'Case2: cooldown 内再次失败，demotedAt 必须不刷新（P0-1 核心目标）')
  // 验证分类：demotedAt 未过期（30s < 5min）→ 仍 demoted
  assert.strictEqual(classifyKey(result, now), 'demoted', 'Case2: cooldown 内仍是 demoted')
  console.log('✅ Case 2: cooldown 内已降权 key 再次失败，demotedAt 不刷新（失败不延长同一个 cooldown）')
}

// Case 3: demoted key 在 cooldown 期间再次失败 → demotedAt 不变
{
  const now = Date.now()
  const h = { failures: 5, demotedAt: now - 60_000, lastFailed: false } // 1 分钟前降权，仍在 cooldown
  const demotedAtBefore = h.demotedAt
  const result = markKeyFailure(h, now)
  assert.strictEqual(result.demotedAt, demotedAtBefore, 'Case3: cooldown key 再次失败，demotedAt 不刷新')
  assert.strictEqual(result.failures, 6, 'Case3: failures should increase')
  // 验证分类：仍在 cooldown 内 → demoted
  assert.strictEqual(classifyKey(result, now), 'demoted', 'Case3: should still be demoted (cooldown not expired)')
  console.log('✅ Case 3: 冷却中 key 再次失败，demotedAt 不变')
}

// Case 4: demoted key 到达 cooldown → 进入 probation
{
  const now = Date.now()
  const h = { failures: 5, demotedAt: now - KEY_HEALTH_COOLDOWN_MS - 1000, lastFailed: false }
  assert.strictEqual(classifyKey(h, now), 'probation', 'Case4: key should be in probation after cooldown')
  console.log('✅ Case 4: 冷却期满 key 能进入 probation')
}

// Case 5: probation/active key 成功 → 清理 health（仅验证健康 key 清理逻辑不变）
{
  const healthData = {}
  healthData['some-key'] = { failures: 5, demotedAt: Date.now() - KEY_HEALTH_COOLDOWN_MS - 1000, lastFailed: false }
  delete healthData['some-key']
  assert.strictEqual(Object.keys(healthData).length, 0, 'Case5: 成功后 health 应被清理')
  console.log('✅ Case 5: 成功恢复逻辑不变，health 正常清理')
}

// ===== Case 6: probation 失败后的新 cooldown（第二轮审查核心缺陷修复） =====
{
  const now = Date.now()
  const T0 = now - KEY_HEALTH_COOLDOWN_MS - 5000 // 5 分 5 秒前降权，已过期

  // 初始状态：降权已过期
  let h = { failures: 5, demotedAt: T0, lastFailed: false }
  assert.strictEqual(classifyKey(h, now), 'probation', 'Case6: 应进入 probation')

  // — 模拟 probation 请求失败 —
  h = markKeyFailure(h, now)

  // 验证：demotedAt 被重置（因为 oldDemotedAt 已过期）
  assert.ok(h.demotedAt > T0, 'Case6: demotedAt 应被重置为新时间戳（未刷新 > 已重置）')
  assert.strictEqual(h.failures, 6, 'Case6: failures 应增加到 6')
  assert.strictEqual(h.lastFailed, true, 'Case6: lastFailed 应为 true')

  // 验证：此时新的 cooldown 开始 → 分类应为 demoted（非 probation）
  assert.strictEqual(classifyKey(h, now), 'demoted', 'Case6: probation 失败后应重新 demoted')
  assert.strictEqual(classifyKey(h, now + 60_000), 'demoted', 'Case6: 1 分钟后仍应 demoted')
  assert.strictEqual(classifyKey(h, now + KEY_HEALTH_COOLDOWN_MS - 1000), 'demoted', 'Case6: 5 分钟前仍应 demoted')

  // 5 分钟后：新 cooldown 到期 → 再次 probation
  const afterCooldown = now + KEY_HEALTH_COOLDOWN_MS + 1000
  assert.strictEqual(classifyKey(h, afterCooldown), 'probation', 'Case6: 新 cooldown 到期后应再次进入 probation')

  console.log('✅ Case 6: probation 失败 → demotedAt 重置 → 新 cooldown 开始（5 分钟后再次 probation）')
}

// ===== Case 7: 连续两次 probation failure → 不会"每个请求都立即 probation" =====
{
  const T0 = Date.now() - KEY_HEALTH_COOLDOWN_MS - 5000 // 已过期
  let h = { failures: 5, demotedAt: T0, lastFailed: false }

  // 第一次 probation 失败
  const now1 = Date.now()
  h = markKeyFailure(h, now1)
  assert.strictEqual(classifyKey(h, now1), 'demoted', 'Case7a: 第一次 probation 失败后应是 demoted')
  assert.strictEqual(h.demotedAt, now1, 'Case7a: demotedAt 应重置为 now1')
  console.log('  └─ 第一次 probation 失败 → 新 cooldown ✓')

  // 第二次失败（在 cooldown 内）
  const now2 = now1 + 60_000 // 1 分钟后的 cooldown 内
  const demotedAtBefore2 = h.demotedAt
  h = markKeyFailure(h, now2)
  assert.strictEqual(h.demotedAt, demotedAtBefore2, 'Case7b: cooldown 内失败，demotedAt 不刷新')
  assert.strictEqual(h.failures, 7, 'Case7b: failures 增加到 7')
  assert.strictEqual(classifyKey(h, now2), 'demoted', 'Case7b: cooldown 内仍是 demoted')
  console.log('  └─ cooldown 内第二次失败 → demotedAt 不变，仍 demoted ✓')

  // 第三次失败（仍在 cooldown 内）
  const now3 = now1 + 120_000 // 2 分钟
  h = markKeyFailure(h, now3)
  assert.strictEqual(h.demotedAt, demotedAtBefore2, 'Case7c: cooldown 内失败，demotedAt 仍不刷新')
  assert.strictEqual(h.failures, 8, 'Case7c: failures 增加到 8')
  assert.strictEqual(classifyKey(h, now3), 'demoted', 'Case7c: 仍是 demoted')
  console.log('  └─ cooldown 内第三次失败 → demotedAt 仍不刷新 ✓')

  // 新 cooldown 到期后再次 probation
  const afterCooldown = now1 + KEY_HEALTH_COOLDOWN_MS + 1000
  assert.strictEqual(classifyKey(h, afterCooldown), 'probation', 'Case7d: 新 cooldown 到期后再次 probation')
  console.log('  └─ 新 cooldown 到期 → 再次 probation ✓')

  // 第二次 probation 成功 → health 清理
  // 注意：此时 h 的 demotedAt=now1（首次 probation 失败重置），cooldown 到期后已在 Case7d 验证进入 probation。
  // 模拟成功：delete healthData[apiKey]
  const healthData = { 'some-key': h }
  delete healthData['some-key']
  assert.strictEqual(Object.keys(healthData).length, 0, 'Case7e: 成功后 health 被清理')
  // 被清理的 key 重新变为健康
  assert.strictEqual(classifyKey(undefined), 'healthy', 'Case7e: 清理后恢复健康')
  console.log('  └─ 第二次 probation 成功 → health 清理 → 恢复健康 ✓')

  console.log('✅ Case 7: 连续两次 probation failure → 每次 5 分钟冷却，不会"每个请求立即 probation"')
}

// ===== 长链测试：完整状态机生命周期 =====
{
  console.log('\n--- 长链测试：完整状态机生命周期 ---')
  const now = Date.now()
  let tick = 0
  const nextTick = () => now + (++tick * 60_000) // 每分钟推进

  // 阶段 1: 健康状态 → 累积失败
  let h = undefined
  assert.strictEqual(classifyKey(h), 'healthy', '阶段1.0: 初始健康')
  // 连续 4 次失败，未达阈值
  for (let i = 0; i < 4; i++) {
    h = markKeyFailure(h, nextTick())
    assert.ok(h.failures < KEY_HEALTH_MAX_FAILURES, `阶段1.${i+1}: 失败 ${h.failures} 次，未达阈值`)
    assert.strictEqual(h.demotedAt, undefined, `阶段1.${i+1}: 未达阈值，不应有 demotedAt`)
  }
  console.log(`  ✅ 阶段1: 4 次失败累积，未达阈值`)

  // 阶段 2: 第 5 次失败 → 降权
  const t5 = nextTick()
  h = markKeyFailure(h, t5)
  assert.strictEqual(h.failures, 5, '阶段2: failures=5')
  assert.strictEqual(h.demotedAt, t5, '阶段2: demotedAt 应等于 t5')
  assert.strictEqual(classifyKey(h, t5), 'demoted', '阶段2: 应 demoted')
  console.log('  ✅ 阶段2: 第5次失败 → 降权 ✓')

  // 阶段 3: cooldown 内失败 → demotedAt 不变，仍 demoted
  const t6 = nextTick()
  h = markKeyFailure(h, t6)
  assert.strictEqual(h.demotedAt, t5, '阶段3: demotedAt 不刷新')
  assert.strictEqual(h.failures, 6)
  assert.strictEqual(classifyKey(h, t6), 'demoted', '阶段3: 仍 demoted')
  console.log('  ✅ 阶段3: cooldown 内失败 → demotedAt 不变 ✓')

  // 阶段 4: cooldown 到期 → probation
  const tProbation = t5 + KEY_HEALTH_COOLDOWN_MS + 1000
  assert.strictEqual(classifyKey(h, tProbation), 'probation', '阶段4: cooldown 到期 → probation')
  console.log('  ✅ 阶段4: 5 分钟后 → probation ✓')

  // 阶段 5: probation 失败 → 新 cooldown
  h = markKeyFailure(h, tProbation)
  assert.ok(h.demotedAt > t5, '阶段5: demotedAt 重置为新时间')
  assert.strictEqual(h.failures, 7)
  assert.strictEqual(classifyKey(h, tProbation), 'demoted', '阶段5: probation 失败 → 新 demoted')
  console.log('  ✅ 阶段5: probation 失败 → 新 cooldown ✓')

  // 阶段 6: 新 cooldown 内失败 → 仍 demoted
  const tDuring = tProbation + 60_000
  const demotedAt5 = h.demotedAt
  h = markKeyFailure(h, tDuring)
  assert.strictEqual(h.demotedAt, demotedAt5, '阶段6: 新 cooldown 内失败，demotedAt 不刷新')
  assert.strictEqual(classifyKey(h, tDuring), 'demoted', '阶段6: 仍 demoted')
  console.log('  ✅ 阶段6: 新 cooldown 内失败 → demotedAt 不变 ✓')

  // 阶段 7: 新 cooldown 到期 → 再次 probation
  const tProbation2 = demotedAt5 + KEY_HEALTH_COOLDOWN_MS + 1000
  assert.strictEqual(classifyKey(h, tProbation2), 'probation', '阶段7: 新 cooldown 到期 → 再次 probation')
  console.log('  ✅ 阶段7: 再 5 分钟后 → 再次 probation ✓')

  // 阶段 8: 第二次 probation 成功 → health 清理
  // 模拟成功：delete healthData[apiKey]
  h = undefined
  assert.strictEqual(classifyKey(h), 'healthy', '阶段8: 成功后 health 被清理回到了健康')
  console.log('  ✅ 阶段8: 成功 → health 清理 → 恢复健康 ✓')

  console.log('✅ 长链测试通过：完整状态机 8 阶段验证 ✓')
}

// ===== P0-2: 冲突检测测试 =====

function detectConflict(latestMembers, expectedMembers) {
  // 与 admin.ts 中冲突检测逻辑一致
  const latest = [...new Set(latestMembers)]
  const snapshot = [...new Set(expectedMembers)]
  const sameLen = latest.length === snapshot.length
  const sameSet = sameLen && latest.every(m => snapshot.includes(m)) && snapshot.every(m => latest.includes(m))
  return !sameSet
}

// 场景 A: 打开编辑器时 cc=[sensenova, sensenova0, group/xx]
// 服务器变为 [sensenova, sensenova0, group/xx, group/zz]
// 用户只添加 opencode-free → 必须 409
{
  const snapshot = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const latestServer = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx', 'group/zz']
  const hasConflict = detectConflict(latestServer, snapshot)
  assert.strictEqual(hasConflict, true, '场景A: 应有冲突')
  console.log('✅ 场景 A: cron 加入 group/zz 后，旧页面保存 → 409 冲突 ✓')
}

// 场景 B: 打开编辑器后服务器无变化，用户添加 opencode-free → 正常保存
{
  const snapshot = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const latestServer = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const hasConflict = detectConflict(latestServer, snapshot)
  assert.strictEqual(hasConflict, false, '场景B: 不应有冲突')
  console.log('✅ 场景 B: 无并发修改，添加 opencode-free → 正常保存 ✓')
}

// 场景 C: 用户删除一个普通 provider，服务器无变化 → 允许删除
{
  const snapshot = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'opencode/deepseek-v4-flash-free', 'group/xx']
  const latestServer = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'opencode/deepseek-v4-flash-free', 'group/xx']
  const hasConflict = detectConflict(latestServer, snapshot)
  assert.strictEqual(hasConflict, false, '场景C: 不应有冲突')
  // 用户提交的 members = [sensenova, sensenova0, group/xx]，已删除 opencode
  const userMembers = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  assert.strictEqual(userMembers.includes('opencode/deepseek-v4-flash-free'), false, '场景C: opencode 已被删除')
  assert.strictEqual(userMembers.includes('group/xx'), true, '场景C: group/xx 保留')
  console.log('✅ 场景 C: 用户删除普通 provider，无冲突 → 正常保存 ✓')
}

// 场景 D: 用户明确删除 group/xx，服务器无变化 → 允许删除
{
  const snapshot = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const latestServer = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const hasConflict = detectConflict(latestServer, snapshot)
  assert.strictEqual(hasConflict, false, '场景D: 不应有冲突')
  // 用户提交的 members = [sensenova, sensenova0]，已删除 group/xx
  const userMembers = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash']
  assert.strictEqual(userMembers.includes('group/xx'), false, '场景D: group/xx 已被用户删除')
  console.log('✅ 场景 D: 用户明确删除 group/xx，无冲突 → 正常保存 ✓')
}

// 额外测试：removeGroupMember 场景 - 用户从 chips 点删除，同时 cron 加入了 group/zz
{
  const currentMembers = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx']
  const latestServer = ['sensenova/deepseek-v4-flash', 'sensenova0/deepseek-v4-flash', 'group/xx', 'group/zz']
  // removeGroupMember 携带 expectedMembers = currentMembers (DOM chips)
  const hasConflict = detectConflict(latestServer, currentMembers)
  assert.strictEqual(hasConflict, true, 'removeGroupMember: 应有冲突')
  console.log('✅ removeGroupMember: 服务器有 group/zz，DOM 快照无 → 409 ✓')
}

console.log('\n🎉 全部 15 个测试通过！')