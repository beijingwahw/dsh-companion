/**
 * 轴线 17/18/19 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：synthesis/evolution（知识演化追踪）、retrieval/blindspots
 * （盲区分析）、insights/pulse（主动洞察引擎）。
 */
import assert from 'node:assert/strict'
import { analyzeEvolution, compareVersions } from '../lib/core/synthesis/evolution.js'
import { analyzeBlindSpots, sanitizeMissRecord } from '../lib/core/retrieval/blindspots.js'
import {
  blindSpotInsights,
  composePulse,
  indexInsights,
  learningInsights,
} from '../lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000

console.log('轴线 17：synthesis/evolution（知识演化追踪）')

ok('版本升级检测：同主题跨会话 v1→v2 = upgrade', () => {
  const report = analyzeEvolution([
    { sessionId: 's1', createdAt: NOW - 60 * DAY, text: '项目使用 docker v1.2 部署' },
    { sessionId: 's2', createdAt: NOW - 10 * DAY, text: '项目使用 docker v2.0 部署' },
  ])
  assert.equal(report.events.length, 1)
  const [event] = report.events
  assert.equal(event.kind, 'upgrade')
  assert.equal(event.anchor, 'docker')
  assert.equal(event.from, 'v1.2')
  assert.equal(event.to, 'v2.0')
  assert.equal(event.fromSession, 's1')
  assert.equal(event.toSession, 's2')
})

ok('语义化版本排序：v2.10 > v2.9（数字段比较，非字典序）', () => {
  // 语义：从 a 到 b 的方向。2.9→2.10 升级、2.10→2.9 降级（数字段比，
  // 字典序会把 "10" < "9" 排错）。
  assert.equal(compareVersions('v2.9', 'v2.10'), 'upgrade')
  assert.equal(compareVersions('v2.10', 'v2.9'), 'downgrade')
  assert.equal(compareVersions('v1.0', 'v1.0.0'), 'change') // 等值不可比 → change
})

ok('数值变化检测：参数变化 = change 事件', () => {
  const report = analyzeEvolution([
    { sessionId: 's1', createdAt: NOW - 90 * DAY, text: '超时设置为 30 秒比较合适' },
    { sessionId: 's2', createdAt: NOW - 5 * DAY, text: '超时设置为 60 秒比较合适' },
  ])
  assert.ok(report.events.length >= 1)
  const timeoutEvent = report.events.find((event) => event.kind === 'change')
  assert.ok(timeoutEvent !== undefined)
  assert.equal(timeoutEvent.to, '60')
})

ok('同一会话内的表述差异不算演化（跨会话才是时间维度）', () => {
  const report = analyzeEvolution([
    {
      sessionId: 's1',
      createdAt: NOW - 10 * DAY,
      text: '先用 v1.2 试试，不行再升 v2.0',
    },
  ])
  assert.equal(report.events.length, 0)
})

ok('值一致 → 无演化事件', () => {
  const report = analyzeEvolution([
    { sessionId: 's1', createdAt: NOW - 60 * DAY, text: '当前版本 v2.0' },
    { sessionId: 's2', createdAt: NOW - 10 * DAY, text: '用的还是 v2.0' },
  ])
  assert.equal(report.events.length, 0)
  assert.ok(report.summary.includes('未检测到信念变化'))
})

ok('事件按时间升序（最新信念在末尾）', () => {
  const report = analyzeEvolution([
    { sessionId: 's3', createdAt: NOW - 5 * DAY, text: 'nginx v1.25 配置' },
    { sessionId: 's1', createdAt: NOW - 90 * DAY, text: 'nginx v1.21 配置' },
    { sessionId: 's2', createdAt: NOW - 40 * DAY, text: 'nginx v1.23 配置' },
  ])
  assert.ok(report.events.length >= 2)
  for (let i = 1; i < report.events.length; i += 1) {
    assert.ok(report.events[i].toAt >= report.events[i - 1].toAt)
  }
})

ok('证据不足（<2 块）→ 空报告', () => {
  const report = analyzeEvolution([
    { sessionId: 's1', createdAt: NOW, text: '版本 v1.0' },
  ])
  assert.deepEqual(report.events, [])
  assert.ok(report.summary.includes('证据不足'))
})

ok('时间乱序输入 → 内部按时间排序后正确判定新旧', () => {
  // 输入顺序故意颠倒（新会话在前），事件方向仍应正确。
  const report = analyzeEvolution([
    { sessionId: 'sNew', createdAt: NOW, text: 'node v20 是 LTS' },
    { sessionId: 'sOld', createdAt: NOW - 100 * DAY, text: 'node v14 是 LTS' },
  ])
  const [event] = report.events
  assert.equal(event.kind, 'upgrade')
  assert.equal(event.fromSession, 'sOld')
  assert.equal(event.toSession, 'sNew')
})

console.log('轴线 19：retrieval/blindspots（检索盲区分析）')

ok('反复搜索的主题聚成盲区：次数累计 + 建议生成', () => {
  const report = analyzeBlindSpots(
    [
      { query: 'rust 错误处理', count: 3, lastAt: NOW - 2 * DAY },
      { query: 'rust 所有权', count: 2, lastAt: NOW - 5 * DAY },
    ],
    { now: NOW },
  )
  assert.ok(report.totalMisses >= 5)
  const rust = report.blindSpots.find((spot) => spot.anchor === 'rust')
  assert.ok(rust !== undefined)
  assert.equal(rust.searches, 5) // 两查询共享 rust 锚 → 累计
  assert.ok(rust.advice.length > 0)
})

ok('孤例失败不进盲区列表（MIN_SEARCHES=2 门槛）', () => {
  const report = analyzeBlindSpots([{ query: '一次性查询', count: 1, lastAt: NOW }], { now: NOW })
  assert.equal(report.blindSpots.length, 0)
})

ok('盲区排序：反复且最近的排前面', () => {
  const report = analyzeBlindSpots(
    [
      { query: '老主题 aaa', count: 3, lastAt: NOW - 300 * DAY },
      { query: '新主题 bbb', count: 3, lastAt: NOW - 1 * DAY },
    ],
    { now: NOW },
  )
  assert.ok(report.blindSpots.length >= 2)
  // 同查询拆出的锚（新主题/bbb）得分并列，第一名必属新主题组。
  assert.ok(['新主题', 'bbb'].includes(report.blindSpots[0].anchor))
  // 新主题组的每个锚都压过老主题组的每个锚（新近度主导排序）。
  const rank = (anchor) => report.blindSpots.findIndex((spot) => spot.anchor === anchor)
  assert.ok(rank('新主题') < rank('老主题'))
  assert.ok(rank('bbb') < rank('aaa'))
})

ok('空日志 → 零盲区报告', () => {
  const report = analyzeBlindSpots([], { now: NOW })
  assert.equal(report.totalMisses, 0)
  assert.deepEqual(report.blindSpots, [])
})

ok('sanitizeMissRecord：非法记录丢弃，合法记录通过', () => {
  assert.equal(sanitizeMissRecord(null), undefined)
  assert.equal(sanitizeMissRecord({ query: '', count: 1, lastAt: 1 }), undefined)
  assert.equal(sanitizeMissRecord({ query: 'ok', count: 0, lastAt: 1 }), undefined)
  assert.deepEqual(sanitizeMissRecord({ query: ' ok ', count: 2, lastAt: 100 }), {
    query: 'ok',
    count: 2,
    lastAt: 100,
  })
  // firstAt 合法时透传；晚于 lastAt（时间线矛盾）丢弃。
  assert.deepEqual(sanitizeMissRecord({ query: 'ok', count: 2, firstAt: 50, lastAt: 100 }), {
    query: 'ok',
    count: 2,
    firstAt: 50,
    lastAt: 100,
  })
  assert.equal(sanitizeMissRecord({ query: 'ok', count: 2, firstAt: 200, lastAt: 100 }), undefined)
})

ok('停留时长按首末跨度计：同次数同新近，长期反复的主题得分更高', () => {
  const report = analyzeBlindSpots(
    [
      { query: '短期主题', count: 3, firstAt: NOW - 2 * DAY, lastAt: NOW - 1 * DAY },
      { query: '长期主题', count: 3, firstAt: NOW - 200 * DAY, lastAt: NOW - 1 * DAY },
    ],
    { now: NOW },
  )
  assert.equal(report.blindSpots[0].anchor, '长期主题')
})

console.log('轴线 18：insights/pulse（主动洞察引擎）')

ok('composePulse：聚合多个提供者，严重度降序排列', () => {
  const report = composePulse(
    [
      () => [
        { category: 'index', severity: 'info', text: 'info 卡片', source: 'a' },
        { category: 'index', severity: 'watch', text: 'watch 卡片', source: 'a' },
      ],
      () => [{ category: 'blindspot', severity: 'critical', text: 'critical 卡片', source: 'b' }],
    ],
    NOW,
  )
  assert.equal(report.cards.length, 3)
  assert.equal(report.cards[0].severity, 'critical')
  assert.equal(report.cards[1].severity, 'watch')
  assert.equal(report.cards[2].severity, 'info')
  assert.ok(report.summary.includes('3 条洞察'))
})

ok('单个提供者抛异常不拖垮整体脉搏（信号隔离）', () => {
  const report = composePulse(
    [
      () => {
        throw new Error('provider boom')
      },
      () => [{ category: 'index', severity: 'info', text: '正常卡片', source: 'ok' }],
    ],
    NOW,
  )
  assert.equal(report.cards.length, 1)
  assert.equal(report.cards[0].text, '正常卡片')
})

ok('盲区洞察：有盲区 → watch/info 卡片带建议', () => {
  const cards = blindSpotInsights({
    blindSpots: [{ anchor: 'rust', searches: 6, advice: '值得专门补齐' }],
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].category, 'blindspot')
  assert.equal(cards[0].severity, 'watch')
  assert.ok(cards[0].text.includes('rust'))
  assert.equal(cards[0].action, '值得专门补齐')
  // 无盲区 → 无卡片。
  assert.deepEqual(blindSpotInsights({ blindSpots: [] }), [])
})

ok('学习洞察：画像未建立/建立/成熟 三态措辞', () => {
  const cold = learningInsights({ profiledSessions: 0, totalClicks: 0 })
  assert.ok(cold[0].text.includes('尚未建立'))
  const warm = learningInsights({ profiledSessions: 3, totalClicks: 5 })
  assert.ok(warm[0].text.includes('已启动'))
  const mature = learningInsights({ profiledSessions: 10, totalClicks: 30 })
  assert.ok(mature[0].text.includes('运转中'))
})

ok('索引洞察：空索引 → watch；覆盖不足 → 低于阈值提示', () => {
  const empty = indexInsights({ indexedSessions: 0, totalSessions: 0, lastSyncAt: null, now: NOW })
  assert.equal(empty[0].severity, 'watch')
  assert.ok(empty[0].text.includes('语义索引为空'))
  const partial = indexInsights({
    indexedSessions: 4,
    totalSessions: 10,
    lastSyncAt: NOW,
    now: NOW,
  })
  assert.ok(partial[0].text.includes('40%'))
})

ok('洞察卡片总数封顶 6（推送克制）', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    category: 'index',
    severity: 'info',
    text: `卡片 ${i}`,
    source: 'x',
  }))
  const report = composePulse([() => many], NOW)
  assert.equal(report.cards.length, 6)
})

console.log(`\n全部通过：${passed} 项断言`)
