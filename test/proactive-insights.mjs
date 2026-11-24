/** 主动智能策略与 Center 闭环回归（驱动 lib 编译产物）。 */
import assert from 'node:assert/strict'
import { InsightCenter } from '../lib/core/insights/center.js'
import {
  applyInsightPolicy,
  emptyInsightState,
  insightId,
  pruneInsightStates,
  reduceInsightFeedback,
  sanitizeInsightState,
} from '../lib/core/insights/policy.js'

let passed = 0
async function ok(label, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const card = (overrides = {}) => ({
  category: 'review',
  severity: 'info',
  text: '默认正文',
  source: '测试源',
  key: 'default',
  ...overrides,
})

await ok('稳定指纹不随正文和建议计数变化', () => {
  const a = card({ text: '3 条到期', action: '立即复习 3 条' })
  const b = card({ text: '9 条到期', action: '立即复习 9 条' })
  assert.equal(insightId(a), insightId(b))
  assert.match(insightId(a), /^ins_[0-9a-f]{16}$/)
  assert.notEqual(insightId(a), insightId(card({ key: 'other' })))
})

await ok('首轮通知最多三条，feed 不被通知配额截断', () => {
  // 五张**异主题**卡片（语义合并不应介入）。
  const texts = [
    'docker 容器网络配置失败需要排查',
    'react 组件状态管理方案对比',
    'typescript 类型推断优化技巧',
    'kubernetes 部署流水线配置',
    '数据库查询性能调优实践',
  ]
  const cards = texts.map((text, index) => card({ key: `k${index}`, text }))
  const result = applyInsightPolicy(cards, new Map(), NOW)
  assert.equal(result.cards.length, 5, '异主题卡片不应被语义合并')
  assert.equal(result.notifications.length, 3)
  assert.equal(result.unreadCount, undefined)
  assert.equal(result.cards.filter((item) => item.unread).length, 3)
  assert.equal(result.mergedCount, 0)
})

await ok('语义合并：同主题不同源的冗余卡折叠为一张（v2 升级）', () => {
  const cards = [
    card({ key: 'a', source: '源 A', text: '你有 5 条知识保持率跌破 70%，建议复习' }),
    card({ key: 'b', source: '源 B', text: '你有 5 条知识保持率跌破 70%，需要巩固' }),
  ]
  const result = applyInsightPolicy(cards, new Map(), NOW)
  assert.equal(result.cards.length, 1, '同主题卡应折叠为一张')
  assert.equal(result.mergedCount, 1)
  assert.equal(result.cards[0].mergedCount, 1)
})

await ok('冷却期内不重复通知，严重度升级可突破冷却', () => {
  const first = applyInsightPolicy([card()], new Map(), NOW)
  const cooled = applyInsightPolicy([card()], first.nextStates, NOW + 1000)
  assert.equal(cooled.notifications.length, 0)
  const escalated = applyInsightPolicy(
    [card({ severity: 'watch' })],
    first.nextStates,
    NOW + 1000,
  )
  assert.deepEqual(escalated.notifications, [insightId(card())])
  assert.equal(escalated.cards[0].notificationCount, 2)
})

await ok('确认清除未读，稍后一天抑制且恢复可逆', () => {
  const id = insightId(card())
  const first = applyInsightPolicy([card()], new Map(), NOW)
  const acknowledged = reduceInsightFeedback(first.nextStates.get(id), 'acknowledge', NOW + 1)
  const afterAck = applyInsightPolicy([card()], new Map([[id, acknowledged]]), NOW + 2)
  assert.equal(afterAck.cards[0].unread, false)
  const snoozed = reduceInsightFeedback(afterAck.nextStates.get(id), 'snooze', NOW + 3)
  const suppressed = applyInsightPolicy([card()], new Map([[id, snoozed]]), NOW + 4)
  assert.equal(suppressed.cards.length, 0)
  assert.equal(suppressed.snoozedCount, 1)
  const restored = reduceInsightFeedback(suppressed.nextStates.get(id), 'restore', NOW + 5)
  const visible = applyInsightPolicy([card()], new Map([[id, restored]]), NOW + 6)
  assert.equal(visible.cards.length, 1)
})

await ok('忽略退出 feed，恢复后重新出现；resolved 保留处理结果', () => {
  const id = insightId(card())
  const first = applyInsightPolicy([card()], new Map(), NOW)
  const dismissed = reduceInsightFeedback(first.nextStates.get(id), 'dismiss', NOW + 1)
  assert.equal(dismissed.outcome, 'dismissed')
  const hidden = applyInsightPolicy([card()], new Map([[id, dismissed]]), NOW + 2)
  assert.equal(hidden.cards.length, 0)
  assert.equal(hidden.dismissedCount, 1)
  const restored = reduceInsightFeedback(hidden.nextStates.get(id), 'restore', NOW + 3)
  assert.equal(restored.dismissed, false)
  const resolved = reduceInsightFeedback(restored, 'resolved', NOW + 4)
  assert.equal(resolved.outcome, 'resolved')
  assert.equal(resolved.dismissed, true)
})

await ok('有用反馈提升同严重度排序，无用反馈降低排序', () => {
  // 两张卡必须**异主题**，否则语义合并会先折叠掉一张。
  const a = card({ key: 'a', severity: 'watch', text: 'docker 容器网络配置问题' })
  const b = card({ key: 'b', severity: 'watch', text: 'react 组件状态管理方案' })
  const aId = insightId(a)
  const bId = insightId(b)
  const previous = new Map([
    [aId, reduceInsightFeedback(emptyInsightState(NOW), 'unhelpful', NOW)],
    [bId, reduceInsightFeedback(emptyInsightState(NOW), 'helpful', NOW)],
  ])
  const result = applyInsightPolicy([a, b], previous, NOW + 1)
  assert.equal(result.cards[0].id, bId)
  assert.ok(result.cards[0].priority > result.cards[1].priority)
})

await ok('状态回收与不可信记录净化有明确边界', () => {
  const stale = { ...emptyInsightState(NOW - 91 * DAY), lastSeenAt: NOW - 91 * DAY }
  const states = new Map([
    ['stale', stale],
    ['dismissed', { ...stale, dismissed: true }],
  ])
  const pruned = pruneInsightStates(states, new Set(), NOW)
  assert.equal(pruned.has('stale'), false)
  assert.equal(pruned.has('dismissed'), true)
  assert.equal(sanitizeInsightState(null), undefined)
  assert.equal(sanitizeInsightState({ ...stale, notificationCount: -1 }), undefined)
  assert.equal(sanitizeInsightState(stale)?.firstSeenAt, stale.firstSeenAt)
})

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

await ok('Center 隔离 Provider 失败并共享缓存与单航班', async () => {
  const table = memoryTable()
  let now = NOW
  let calls = 0
  let notifications = 0
  const center = new InsightCenter(async () => table, {
    now: () => now,
    cacheMs: 1000,
    onNotifications: (cards) => { notifications += cards.length },
  })
  const dispose = center.register(async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return [card({ text: '本地正文，不应落盘' })]
  })
  center.register(async () => { throw new Error('单一信号源故障') })
  const first = await center.feed()
  assert.equal(first.cards.length, 1)
  assert.equal(first.providerFailures, 1)
  assert.equal(first.unreadCount, 1)
  assert.equal(notifications, 1)
  await center.feed()
  assert.equal(calls, 1)
  await Promise.all([center.feed(true), center.feed(true)])
  assert.equal(calls, 2)
  const id = first.cards[0].id
  const persisted = JSON.stringify(table.entries())
  assert.equal(persisted.includes('本地正文，不应落盘'), false)
  assert.equal(persisted.includes('默认正文'), false)

  assert.equal(await center.acknowledge({ ids: [id] }), 1)
  assert.equal((await center.feed()).cards[0].unread, false)
  assert.equal(await center.feedback(id, 'helpful'), true)
  assert.equal((await center.feed()).cards[0].feedback, 'helpful')
  assert.equal(await center.feedback(id, 'snooze'), true)
  assert.equal((await center.feed()).cards.length, 0)
  assert.equal(await center.feedback(undefined, 'restore-all'), true)
  assert.equal((await center.feed()).cards.length, 1)
  assert.equal(await center.feedback(id, 'dismiss'), true)
  assert.equal((await center.feed()).dismissedCount, 1)
  assert.equal(await center.feedback(undefined, 'restore-all'), true)
  assert.equal((await center.feed()).cards.length, 1)
  assert.equal(await center.feedback('ins_0000000000000000', 'helpful'), false)

  now += 1001
  dispose()
  dispose()
  const afterDispose = await center.feed(true)
  assert.equal(afterDispose.cards.length, 0)
  assert.equal(afterDispose.providerFailures, 1)
})

console.log(`\n全部通过：${passed} 项断言`)
