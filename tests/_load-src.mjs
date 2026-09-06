// ============================================================
// S11（2026-09-06）真实源码加载器 —— 让单测调用 src/ 里**真正的函数**。
//
// 解决的遗留问题：旧 tests/run-tests-rotation.mjs 自己重实现了一份
// readGroupPointer / writeGroupPointer / buildRotationOrder，不读 src/。
// 结果 S1 把粘滞指针整个删掉之后，那份测试依然 16/16 全绿 ——
// 它测的是**已经不存在的行为**。这类测试比没有测试更危险。
//
// 做法：用项目自带的 esbuild 把 src/proxy.ts 打成 ESM 临时文件再 import。
// 不是"移植逻辑"，是**加载实现本身**：源码改了，测试立刻跟着变。
// ============================================================
import { build } from 'esbuild'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SRC_DIR = join(HERE, '../src')

/** 读源码原文（给「源码级断言」用，例如"某个旧写法不得复活"）。 */
export function readSrc(name) {
  return readFileSync(join(SRC_DIR, name), 'utf8')
}

/**
 * 打包并 import src/proxy.ts，返回其全部 export。
 * external: hono —— 只在类型层用到 Context，运行时不需要，声明为 external 免得把整个框架拖进来。
 */
export async function loadProxyModule() {
  const dir = mkdtempSync(join(tmpdir(), 'agwtest-'))
  const out = join(dir, 'proxy.mjs')
  await build({
    entryPoints: [join(SRC_DIR, 'proxy.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['hono', 'hono/*'],
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  return mod
}

/** 内存 KV 假实现，接口与 Workers KV 一致；统计读/写/删次数用于断言"零多余 KV 写"。 */
export class FakeKV {
  constructor(initial = {}) {
    this.store = { ...initial }
    this.reads = 0
    this.writes = 0
    this.deletes = 0
  }

  async get(k) {
    this.reads++
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }

  async put(k, v) {
    this.writes++
    this.store[k] = v
  }

  async delete(k) {
    this.deletes++
    delete this.store[k]
  }

  async list() {
    return { keys: Object.keys(this.store).map(name => ({ name })), list_complete: true }
  }
}

/** 造一个最小 Env（只含测试用到的 KV 绑定）。 */
export function fakeEnv(kv) {
  return { KV: kv }
}

/** 造 provider：id + 若干 key。 */
export function provider(id, keyCount = 1, extra = {}) {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com`,
    enabled: true,
    status: 'active',
    apiKeys: Array.from({ length: keyCount }, (_, i) => ({ key: `k_${id}_${i}`, enabled: true })),
    models: [],
    ...extra,
  }
}

/** providerMap（isMemberCoolingDown / buildRotationOrder 的入参形态）。 */
export function providerMap(...ps) {
  return new Map(ps.map(p => [p.id, p]))
}

/** 造一个 SSE 流式 Response（用于 probeStreamHead 真函数测试）。 */
export function sseResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': contentType } })
}
