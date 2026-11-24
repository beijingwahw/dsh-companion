/**
 * 洞察中心 v2 契约测试：健康可观测性、溯源元数据、节律门、
 * per-source 可信度闭环。
 */
import assert from 'node:assert/strict'
import { InsightCenter } from '../lib/core/insights/center.js'
import { insightId, applyInsightPolicy, aggregateSourceFeedback } from '../lib/core/insights/policy.js'

let passed = 0
async function ok(label, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const NOW = 1_800_000_000_000

function memoryTable() {
  const data = new Map()
  return {
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
  }
}

const card = (overrides = {}) => ({
  category: 'review',
  severity: 'info',
  text: '默认正文',
  source: '测试源',
  key: 'default',
  ...overrides,
})

await ok('Center 暴露健康报告：初始成功率 1、Provider 数正确', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now })
  const before = center.health()
  assert.equal(before.providers, 0)
  assert.equal(before.refreshes, 0)
  assert.equal(before.providerSuccessRate, 1)
  center.register(async () => [card({ text: 'docker 容器网络配置问题' })])
  assert.equal(center.health().providers, 1)
})

await ok('Center 健康报告统计失败 Provider 与刷新轮次', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now })
  center.register(async () => { throw new Error('boom') })
  await center.feed(true)
  const health = center.health()
  assert.equal(health.refreshes, 1)
  assert.equal(health.providerFailures, 1)
  assert.ok(health.providerSuccessRate < 1)
  assert.equal(health.failedProviders, 1)
})

await ok('Center 为每张卡附溯源元数据（来源/可信度/延迟）', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now })
  center.register(async () => [card({ key: 'a', text: 'docker 容器网络配置问题' })])
  const feed = await center.feed(true)
  assert.equal(feed.cards.length, 1)
  const provenance = feed.provenance[feed.cards[0].id]
  assert.ok(provenance !== undefined, '应附溯源元数据')
  assert.equal(provenance.source, '测试源')
  assert.ok(typeof provenance.trust === 'number')
  assert.equal(provenance.merged, 0)
})

await ok('Center 在 feed 中暴露 sourceTrust 快照', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now })
  center.register(async () => [card({ key: 'a', text: 'docker 容器网络配置问题' })])
  const feed = await center.feed(true)
  assert.ok(feed.sourceTrust['测试源'] !== undefined)
})

await ok('Center 报告 mergedCount 与 rhythmSuppressedCount', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now })
  center.register(async () => [
    card({ key: 'a', text: '你有 5 条知识保持率跌破 70%，建议复习' }),
    card({ key: 'b', text: '你有 5 条知识保持率跌破 70%，需要巩固' }),
  ])
  const feed = await center.feed(true)
  assert.equal(feed.cards.length, 1)
  assert.equal(feed.mergedCount, 1)
  assert.equal(typeof feed.rhythmSuppressedCount, 'number')
})

await ok('节律门：短时间内不重复通知，critical 可突破', async () => {
  const table = memoryTable()
  let now = NOW
  const notifications = []
  const center = new InsightCenter(async () => table, {
    now: () => now,
    quietMs: 60_000,
    cacheMs: 0,
    onNotifications: (cards) => { notifications.push(...cards.map((c) => c.severity)) },
  })
  center.register(async () => [card({ key: 'a', severity: 'watch', text: 'docker 容器网络配置问题' })])
  await center.feed(true)
  assert.equal(notifications.length, 1)
  // 同一时刻再刷新：节律门应拦下（未超过 quietMs）。
  await center.feed(true)
  assert.equal(notifications.length, 1, '节律门应拦下短间隔重复通知')
  // critical 升级可突破节律门。
  center.register(async () => [
    card({ key: 'b', severity: 'critical', text: 'react 组件状态管理严重故障' }),
  ])
  await center.feed(true)
  assert.ok(notifications.includes('critical'), 'critical 应突破节律门')
})

await ok('aggregateSourceFeedback 从指纹状态派生 per-source 计数', () => {
  const a = card({ key: 'a', source: '源 A' })
  const b = card({ key: 'b', source: '源 B' })
  const aId = insightId(a)
  const bId = insightId(b)
  const states = new Map([
    [aId, { ...states0(NOW), feedback: 'helpful' }],
    [bId, { ...states0(NOW), feedback: 'unhelpful', outcome: 'dismissed' }],
  ])
  const counts = aggregateSourceFeedback(states, new Map([[aId, '源 A'], [bId, '源 B']]))
  assert.equal(counts.get('源 A')?.helpful, 1)
  assert.equal(counts.get('源 B')?.unhelpful, 1)
  assert.equal(counts.get('源 B')?.dismissed, 1)
})

function states0(now) {
  return {
    firstSeenAt: now,
    lastSeenAt: now,
    dismissed: false,
    notificationCount: 0,
    updatedAt: now,
  }
}

await ok('策略 v2 的 sourceTrust 影响排序（端到端）', () => {
  const cards = [
    card({ key: 'a', source: '低信源', severity: 'watch', text: 'docker 容器网络配置问题' }),
    card({ key: 'b', source: '高信源', severity: 'watch', text: 'react 组件状态管理方案' }),
  ]
  const feedback = new Map([
    ['低信源', { helpful: 0, unhelpful: 5, dismissed: 5 }],
    ['高信源', { helpful: 10, unhelpful: 0, dismissed: 0 }],
  ])
  const result = applyInsightPolicy(cards, new Map(), NOW, {}, feedback)
  assert.equal(result.cards[0].source, '高信源')
  assert.ok(result.sourceTrust.get('高信源') > result.sourceTrust.get('低信源'))
})

await ok('Center 在多轮刷新后累计健康统计', async () => {
  const table = memoryTable()
  let now = NOW
  const center = new InsightCenter(async () => table, { now: () => now, cacheMs: 0 })
  center.register(async () => [card({ key: 'a', text: 'docker 容器网络配置问题' })])
  await center.feed(true)
  now += 100
  await center.feed(true)
  now += 100
  await center.feed(true)
  const health = center.health()
  assert.equal(health.refreshes, 3)
  assert.ok(health.avgRefreshMs >= 0)
  assert.ok(health.lastRefreshAt !== null)
})

console.log(`\n全部通过：${passed} 项断言`)
