/** 预算预授权与交接血缘的并发/世代回归（驱动 lib 编译产物）。 */
import assert from 'node:assert/strict'
import { BudgetGuard } from '../lib/modules/cost/budget.js'
import { ArmedStore } from '../lib/modules/handoff/armed.js'
import { HandoffChunkStore } from '../lib/modules/handoff/hierarchical.js'
import { LineageStore } from '../lib/modules/handoff/lineage.js'
import { fnv1a32 } from '../lib/core/retrieval/tokenize.js'

let passed = 0
async function ok(label, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const NOW = 1_800_000_000_000

function memoryDomain() {
  const tables = new Map()
  return {
    tables,
    domain: {
      table(name) {
        if (!tables.has(name)) {
          const data = new Map()
          tables.set(name, {
            get: (key) => data.get(key),
            keys: () => [...data.keys()],
            entries: () => [...data.entries()],
            get size() { return data.size },
            async put(key, value) { data.set(key, value) },
            async delete(key) { data.delete(key) },
            async update(key, fn) {
              const next = fn(data.get(key))
              if (next === undefined) data.delete(key)
              else data.set(key, next)
            },
          })
        }
        return tables.get(name)
      },
    },
  }
}

await ok('预算 TTL 过期仍占额，真实 release/settle 后才释放且句柄幂等', async () => {
  const originalNow = Date.now
  let now = NOW
  Date.now = () => now
  try {
    const { domain } = memoryDomain()
    const emptyTotal = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      costCny: 0,
      savedCny: 0,
      deferredCalls: 0,
    }
    const usage = {
      range: () => [],
      month: () => [],
      total: () => ({ ...emptyTotal }),
    }
    const ctx = {
      emit: () => undefined,
      companion: { notice: () => undefined },
    }
    const guard = new BudgetGuard(ctx, domain, usage, () => ({
      devMode: true,
      peakScheduling: false,
      modelRouting: false,
      dailyBudgetCny: 0,
      monthlyBudgetCny: 1,
      simpleModel: 'deepseek-chat',
      complexModel: 'deepseek-reasoner',
      customRules: [],
    }))

    const first = guard.reserve(0.6, false, 10)
    assert.throws(
      () => guard.reserve(0.5, false, 10),
      (error) => error?.code === 'INSUFFICIENT_BALANCE',
    )
    now += 11
    assert.equal(guard.reservedTotalCny(), 0.6)
    // 0.6 + 0.4 恰好达到预算：旧实现会在 TTL 后错误释放并放行这笔调用。
    assert.throws(
      () => guard.reserve(0.4, false, 10),
      (error) => error?.code === 'INSUFFICIENT_BALANCE',
    )

    first.release()
    first.release()
    assert.equal(guard.reservedTotalCny(), 0)
    const second = guard.reserve(0.4, false, 5)
    now += 6
    assert.equal(guard.reservedTotalCny(), 0.4)
    second.settle(0.7)
    second.settle(0.7)
    second.release()
    assert.equal(guard.reservedTotalCny(), 0)
    const third = guard.reserve(0.99, false, 1)
    third.release()
    assert.equal(guard.reservedTotalCny(), 0)
  } finally {
    Date.now = originalNow
  }
})

await ok('同毫秒 re-arm 世代唯一，旧过期回调不得删除新 pending', async () => {
  const originalNow = Date.now
  Date.now = () => NOW
  try {
    const { domain } = memoryDomain()
    const armed = new ArmedStore(domain)
    const first = await armed.arm(null, '第一代摘要', { ttlMs: 10 })
    const second = await armed.arm(null, '第二代摘要', { ttlMs: 10 })
    assert.notEqual(first.armedAt, second.armedAt)
    await armed.expirePending({ armedAt: first.armedAt, summary: first.summary })
    assert.equal(armed.peekPending()?.summary, '第二代摘要')
    assert.equal(armed.peekPending()?.armedAt, second.armedAt)
  } finally {
    Date.now = originalNow
  }
})

await ok('血缘悬边只由同世代消费认领，旧世代清理不影响新边', async () => {
  const originalNow = Date.now
  Date.now = () => NOW
  try {
    const { domain, tables } = memoryDomain()
    const armed = new ArmedStore(domain)
    const lineage = new LineageStore(domain)
    const first = await armed.arm(null, '旧摘要')
    await lineage.recordEdge('source', null, '旧摘要', first.armedAt)
    const second = await armed.arm(null, '新摘要')
    await lineage.recordEdge('source', null, '新摘要', second.armedAt)

    await lineage.deletePendingEdges(first.armedAt)
    let pending = tables.get('handoff-lineage').entries()
      .map(([, edge]) => edge)
      .filter((edge) => edge.targetSessionId === null)
    assert.deepEqual(pending.map((edge) => edge.pendingArmedAt), [second.armedAt])

    await lineage.resolvePendingTargets('target', first.armedAt)
    pending = tables.get('handoff-lineage').entries()
      .map(([, edge]) => edge)
      .filter((edge) => edge.targetSessionId === null)
    assert.equal(pending.length, 1)
    assert.equal(lineage.listEdges().length, 0)

    await lineage.resolvePendingTargets('target', second.armedAt)
    const resolved = lineage.listEdges()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].sourceSessionId, 'source')
    assert.equal(resolved[0].targetSessionId, 'target')
    assert.equal(resolved[0].excerpt, '新摘要')
  } finally {
    Date.now = originalNow
  }
})

await ok('分层摘要缓存不受已知 FNV-1a 32 位碰撞影响', async () => {
  // 这两个确定输入在旧缓存键算法下具有完全相同的 32 位哈希。
  const first = 'chunk:1702ooy0ypy1530rh0qaq0yc1z1d0ev5lxg0gpum0p19fq1ie1nllfh01c3szp705danvk1ab6ozu1r1b7im'
  const second = 'chunk:01zdfxp1adfq3509l3vzg050mwc01rcb4sp013sixp0mjy7rx1lnpa500rlj3jv11t8kjf0kjxfo70fl4gon'
  assert.equal(fnv1a32(first), fnv1a32(second))
  const { domain } = memoryDomain()
  const cache = new HandoffChunkStore(domain)
  await cache.put(first, undefined, '第一段专属摘要', 'model-a')
  await cache.put(second, undefined, '第二段专属摘要', 'model-b')
  assert.equal(cache.get(first, undefined)?.summary, '第一段专属摘要')
  assert.equal(cache.get(second, undefined)?.summary, '第二段专属摘要')
  assert.equal(cache.get(first, '不同焦点'), undefined)
})

console.log(`\n全部通过：${passed} 项断言`)
