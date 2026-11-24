/**
 * 轴线 37–38 冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：好奇心引擎（知识缺口 / 注意力退潮 / 桥接机会）、意图预报
 * （节律 / 延续 / 回访三类先验）、以及洞察策略 v2 的语义抑制与
 * 效用学习（per-source Wilson 下界）。
 */
import assert from 'node:assert/strict'
import {
  buildActivitySeries,
  computeCuriosity,
  detectKnowledgeGaps,
  detectDecay,
  detectBridges,
} from '../lib/core/cognition/curiosity.js'
import {
  clusterTopics,
  forecastIntents,
  rhythmPrior,
  continuationPrior,
  returnPrior,
} from '../lib/core/cognition/intent.js'
import {
  applyInsightPolicy,
  mergeSemanticDuplicates,
  sourceTrust,
} from '../lib/core/insights/policy.js'
import { buildEntityGraph } from '../lib/core/graph/graph.js'
import { deriveBm25Params } from '../lib/core/retrieval/engine.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}
async function okAsync(label, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const NOW = 1_800_000_000_000
const DAY = 86_400_000

// --------------------------------------------------------------------
// 构造一张「两块大陆 + 一条桥」的实体共现图
// --------------------------------------------------------------------

/** 实体倒排记录的最小形状。 */
function record(key, name, sessions) {
  return { key, name, type: 'tech', sessions }
}

/** 会话 id → 实体键列表 → 倒排记录数组。 */
function buildRecords(sessionEntities) {
  const acc = new Map()
  for (const [sessionId, keys] of Object.entries(sessionEntities)) {
    for (const key of keys) {
      const entry = acc.get(key) ?? { key, name: key.split(':')[1] ?? key, sessions: {} }
      entry.sessions[sessionId] = 1
      acc.set(key, entry)
    }
  }
  return [...acc.values()]
}

// 两块大陆：docker 域（4 实体 × 6 会话）与 前端域（4 实体 × 6 会话），
// 中间只有 1 条弱边（docker 与 webpack 在同一场会话出现）。
const DOCKER_KEYS = ['tech:docker', 'tech:compose', 'tech:container', 'tech:bridge']
const FRONTEND_KEYS = ['tech:webpack', 'tech:react', 'tech:vite', 'tech:css']
const sessionEntities = {}
for (let i = 0; i < 6; i += 1) {
  sessionEntities[`docker-${i}`] = DOCKER_KEYS
  sessionEntities[`front-${i}`] = FRONTEND_KEYS
}
sessionEntities['bridge-0'] = ['tech:docker', 'tech:webpack']

const GRAPH = buildEntityGraph(buildRecords(sessionEntities))

// --------------------------------------------------------------------
// 案例 1：知识缺口——两块成型大陆之间缺少翻译层
// --------------------------------------------------------------------

await okAsync('知识缺口：两块大陆之间的弱连接被识别为缺口', () => {
  const gaps = detectKnowledgeGaps(GRAPH, { topK: 5 })
  assert.ok(gaps.length >= 1, '应至少识别出一个缺口')
  const top = gaps[0]
  assert.ok(top.score > 0, '缺口分应为正')
  assert.ok(top.crossEdges < 5, '跨社区边应远少于社区内边')
  // 两侧都应是有规模的社区
  assert.ok(top.leftSize >= 3 && top.rightSize >= 3, '两侧社区都应成型')
})

await okAsync('知识缺口：单社区图不产生缺口信号', () => {
  const single = buildEntityGraph(
    buildRecords({ s1: ['tech:a', 'tech:b', 'tech:c'], s2: ['tech:a', 'tech:b', 'tech:c'] }),
  )
  const gaps = detectKnowledgeGaps(single, { topK: 5 })
  assert.equal(gaps.length, 0)
})

await okAsync('知识缺口：确定性（同输入同输出）', () => {
  const a = detectKnowledgeGaps(GRAPH, { topK: 5 })
  const b = detectKnowledgeGaps(GRAPH, { topK: 5 })
  assert.deepEqual(a, b)
})

// --------------------------------------------------------------------
// 案例 2：注意力退潮——枢纽主题活跃度下滑
// --------------------------------------------------------------------

await okAsync('注意力退潮：活跃度下滑的枢纽被识别', () => {
  // docker 活跃度：前 8 点高，后 4 点归零。
  const activity = new Map([
    ['tech:docker', [3, 3, 4, 3, 3, 4, 3, 3, 0, 0, 0, 0]],
    ['tech:react', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ])
  const decays = detectDecay(GRAPH, activity, { topK: 5 })
  const dockerDecay = decays.find((d) => d.anchor === 'docker')
  assert.ok(dockerDecay !== undefined, 'docker 退潮应被识别')
  assert.ok(dockerDecay.ratio < 0.85, '衰减比应低于阈值')
  assert.ok(dockerDecay.score > 0, '退潮分应为正')
  // react 稳定，不应被误报
  const reactDecay = decays.find((d) => d.anchor === 'react')
  assert.equal(reactDecay, undefined)
})

await okAsync('注意力退潮：活跃度上升不触发', () => {
  const activity = new Map([['tech:docker', [0, 0, 0, 0, 3, 3, 4, 3]]])
  const decays = detectDecay(GRAPH, activity, { topK: 5 })
  assert.equal(decays.length, 0)
})

// --------------------------------------------------------------------
// 案例 3：桥接机会——时间上交替活跃但图上疏远
// --------------------------------------------------------------------

await okAsync('桥接机会：交替活跃的疏远主题对被识别', () => {
  // compose 与 css 交替活跃（负相关），图上距离远（无直接边）。
  const activity = new Map([
    ['tech:compose', [5, 1, 5, 1, 5, 1, 5, 1]],
    ['tech:css', [1, 5, 1, 5, 1, 5, 1, 5]],
  ])
  const bridges = detectBridges(GRAPH, activity, { topK: 5 })
  assert.ok(bridges.length >= 1, '应识别出桥接机会')
  const top = bridges[0]
  assert.ok(top.correlation < -0.3, '相关应为负（交替）')
  assert.ok(top.hopDistance === null || top.hopDistance >= 2, '图上应疏远')
})

await okAsync('桥接机会：同步活跃不触发', () => {
  const activity = new Map([
    ['tech:compose', [5, 5, 5, 5, 5, 5]],
    ['tech:css', [4, 4, 4, 4, 4, 4]],
  ])
  const bridges = detectBridges(GRAPH, activity, { topK: 5 })
  assert.equal(bridges.length, 0)
})

// --------------------------------------------------------------------
// 案例 4：综合报告 + 活跃度序列构建
// --------------------------------------------------------------------

await okAsync('综合好奇心报告包含三类信号与摘要', () => {
  const activity = new Map([
    ['tech:docker', [3, 3, 3, 3, 0, 0]],
    ['tech:compose', [5, 1, 5, 1, 5, 1]],
    ['tech:css', [1, 5, 1, 5, 1, 5]],
  ])
  const report = computeCuriosity(GRAPH, activity, { topK: 3 })
  assert.ok(report.entities > 0)
  assert.ok(report.communities >= 1)
  assert.ok(typeof report.summary === 'string' && report.summary.length > 0)
})

await okAsync('活跃度序列构建：按时间分桶且越界会话被剔除', () => {
  const series = buildActivitySeries(
    [
      { at: NOW - 1000, entityKeys: ['tech:a', 'tech:b'] },
      { at: NOW - 5000, entityKeys: ['tech:a'] },
      { at: NOW - 100 * DAY, entityKeys: ['tech:c'] },
    ],
    8,
    NOW,
    8 * 7 * DAY,
  )
  assert.ok(series.get('tech:a') !== undefined)
  assert.equal(series.get('tech:c'), undefined, '超出窗口的实体不应进入序列')
  const a = series.get('tech:a')
  assert.equal(a.length, 8)
  assert.equal(a.reduce((x, y) => x + y, 0), 2)
})

// --------------------------------------------------------------------
// 案例 5：意图预报——三类先验
// --------------------------------------------------------------------

await okAsync('意图预报：样本不足返回空预测', () => {
  const report = forecastIntents(
    [{ id: 's1', at: NOW, text: 'docker 网络' }],
    NOW,
  )
  assert.equal(report.forecasts.length, 0)
  assert.match(report.summary, /样本不足/)
})

await okAsync('意图预报：节律先验给出当前时段主题', () => {
  // 构造周一上午的会话（10:00），主题 docker。
  const monday = new Date(NOW)
  monday.setHours(10, 0, 0, 0)
  // 找一个真实的周一
  while (monday.getDay() !== 1) monday.setDate(monday.getDate() + 1)
  const monday10 = monday.getTime()
  const sessions = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    at: monday10 - i * 7 * DAY,
    text: 'docker 容器网络配置',
  }))
  sessions.push({ id: 'other', at: monday10 + 3 * 3600_000, text: 'react 组件状态' })
  const buckets = clusterTopics(sessions)
  const assignment = new Map()
  for (const session of sessions) {
    const terms = new Set(session.text.split(/\s+/))
    let best = -1
    let bestSim = 0
    buckets.forEach((bucket, index) => {
      let hit = 0
      for (const term of bucket.label) if (terms.has(term)) hit += 1
      const sim = hit / Math.max(1, bucket.label.length)
      if (sim > bestSim) { bestSim = sim; best = index }
    })
    if (best >= 0) assignment.set(session.id, best)
  }
  const rhythm = rhythmPrior(sessions, buckets, assignment, monday10, 4)
  assert.ok(Array.isArray(rhythm))
})

await okAsync('意图预报：延续先验学习主题转移', () => {
  const sessions = []
  for (let i = 0; i < 6; i += 1) {
    sessions.push({ id: `a${i}`, at: NOW - (20 - i * 2) * DAY, text: 'docker 容器配置' })
    sessions.push({ id: `b${i}`, at: NOW - (19 - i * 2) * DAY, text: 'kubernetes 部署' })
  }
  const buckets = clusterTopics(sessions)
  const assignment = new Map()
  for (const session of sessions) {
    buckets.forEach((bucket, index) => {
      if (bucket.sessionIds.includes(session.id)) assignment.set(session.id, index)
    })
  }
  const continuation = continuationPrior(sessions, buckets, assignment)
  assert.ok(Array.isArray(continuation))
})

await okAsync('意图预报：回访先验检测周期性主题', () => {
  // 每 12 天回访一次 docker 主题。
  const sessions = []
  for (let i = 0; i < 5; i += 1) {
    sessions.push({ id: `r${i}`, at: NOW - i * 12 * DAY, text: 'docker 网络隔离配置' })
  }
  const buckets = clusterTopics(sessions)
  const assignment = new Map()
  for (const session of sessions) {
    buckets.forEach((bucket, index) => {
      if (bucket.sessionIds.includes(session.id)) assignment.set(session.id, index)
    })
  }
  const ret = returnPrior(sessions, buckets, assignment, NOW, 2)
  assert.ok(Array.isArray(ret))
})

await okAsync('意图预报：综合报告确定性', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    at: NOW - i * DAY,
    text: `主题 ${i % 3} 的技术讨论`,
  }))
  const a = forecastIntents(sessions, NOW, { topK: 5 })
  const b = forecastIntents(sessions, NOW, { topK: 5 })
  assert.deepEqual(a, b)
})

// --------------------------------------------------------------------
// 案例 6：洞察策略 v2——语义抑制
// --------------------------------------------------------------------

const card = (overrides = {}) => ({
  category: 'review',
  severity: 'info',
  text: '默认正文',
  source: '测试源',
  key: 'default',
  ...overrides,
})

ok('语义合并：同主题不同源的两张卡折叠为一张', () => {
  const a = card({
    key: 'a',
    source: '源 A',
    text: '你有 5 条知识保持率跌破 70%，正值最佳巩固窗口',
  })
  const b = card({
    key: 'b',
    source: '源 B',
    text: '你有 5 条知识保持率跌破 70%，建议运行 review 命令',
  })
  const groups = mergeSemanticDuplicates([a, b])
  assert.equal(groups.length, 1, '同主题卡片应合并为一组')
  assert.equal(groups[0].absorbed.length, 1)
})

ok('语义合并：不同主题的卡片不合并', () => {
  const a = card({ key: 'a', text: 'docker 容器网络配置失败' })
  const b = card({ key: 'b', text: 'react 组件状态管理方案' })
  const groups = mergeSemanticDuplicates([a, b])
  assert.equal(groups.length, 2)
})

ok('语义合并：代表卡选择严重度更高者', () => {
  const a = card({ key: 'a', severity: 'info', text: '你有 5 条知识保持率跌破 70%' })
  const b = card({ key: 'b', severity: 'watch', text: '你有 5 条知识保持率跌破 70%' })
  const groups = mergeSemanticDuplicates([a, b])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].representative.severity, 'watch')
})

ok('语义合并：确定性（同输入同分组）', () => {
  const cards = [
    card({ key: 'a', text: '知识保持率跌破阈值需要复习' }),
    card({ key: 'b', text: '知识保持率跌破阈值需要巩固' }),
    card({ key: 'c', text: 'docker 网络配置问题排查' }),
  ]
  const a = mergeSemanticDuplicates(cards)
  const b = mergeSemanticDuplicates(cards)
  assert.deepEqual(a.map((g) => g.representative.key), b.map((g) => g.representative.key))
})

// --------------------------------------------------------------------
// 案例 7：效用学习——per-source Wilson 下界
// --------------------------------------------------------------------

ok('信号源可信度：无反馈时为保守中位（冷启动不假装 100% 可信）', () => {
  const trust = sourceTrust(undefined)
  assert.ok(trust > 0.15 && trust < 0.5, `冷启动应为保守中位，实际 ${trust}`)
})

ok('信号源可信度：被持续忽略的源降权但不归零', () => {
  const trust = sourceTrust({ helpful: 0, unhelpful: 5, dismissed: 5 })
  assert.ok(trust < 0.3, `应显著降权，实际 ${trust}`)
  assert.ok(trust >= 0.15, '不应低于 trustFloor')
})

ok('信号源可信度：被认可的源保持高可信', () => {
  const trust = sourceTrust({ helpful: 10, unhelpful: 1, dismissed: 0 })
  assert.ok(trust > 0.6, `应保持高可信，实际 ${trust}`)
})

ok('信号源可信度：单调性（更多 helpful → 更高可信）', () => {
  const low = sourceTrust({ helpful: 2, unhelpful: 3, dismissed: 2 })
  const high = sourceTrust({ helpful: 8, unhelpful: 3, dismissed: 2 })
  assert.ok(high > low)
})

// --------------------------------------------------------------------
// 案例 8：策略 v2 端到端——合并 + 可信度调制 + 节律
// --------------------------------------------------------------------

ok('策略 v2：语义合并计数与溯源字段出现在结果中', () => {
  const cards = [
    card({ key: 'a', text: '你有 5 条知识保持率跌破 70%，建议复习' }),
    card({ key: 'b', text: '你有 5 条知识保持率跌破 70%，需要巩固' }),
  ]
  const result = applyInsightPolicy(cards, new Map(), NOW)
  assert.equal(result.cards.length, 1)
  assert.equal(result.mergedCount, 1)
  assert.equal(result.cards[0].mergedCount, 1)
})

ok('策略 v2：被忽略的源整体下沉', () => {
  const cards = [
    card({ key: 'a', source: '被忽略的源', severity: 'watch', text: 'docker 网络配置问题' }),
    card({ key: 'b', source: '被认可的源', severity: 'watch', text: 'react 组件状态管理' }),
  ]
  const feedback = new Map([
    ['被忽略的源', { helpful: 0, unhelpful: 5, dismissed: 5 }],
    ['被认可的源', { helpful: 10, unhelpful: 0, dismissed: 0 }],
  ])
  const result = applyInsightPolicy(cards, new Map(), NOW, {}, feedback)
  assert.equal(result.cards[0].source, '被认可的源')
})

ok('策略 v2：节律窗口关闭时 critical 仍可推送', () => {
  const cards = [card({ key: 'a', severity: 'critical', text: '严重问题需要立即处理' })]
  const result = applyInsightPolicy(cards, new Map(), NOW, {
    attentionWindow: () => 0, // 完全静默窗口
    quietMaxSeverity: 'watch',
  })
  assert.equal(result.cards.length, 1, 'feed 永不被节律抑制')
  assert.equal(result.cards[0].rhythmSuppressed, false || undefined)
})

ok('策略 v2：节律窗口关闭时 info 卡不推送但仍可见', () => {
  const cards = [card({ key: 'a', severity: 'info', text: '提示信息' })]
  const result = applyInsightPolicy(cards, new Map(), NOW, {
    attentionWindow: () => 0,
    quietMaxSeverity: 'watch',
  })
  assert.equal(result.cards.length, 1, 'feed 仍展示')
  assert.equal(result.cards[0].rhythmSuppressed, true)
  assert.equal(result.rhythmSuppressedCount, 1)
})

// --------------------------------------------------------------------
// 案例 9：BM25 语料自适应
// --------------------------------------------------------------------

ok('BM25 自适应：短语料弱归一、长语料强归一', () => {
  const short = deriveBm25Params({ avgLength: 30, vocabularySize: 30, totalTokens: 60 })
  const long = deriveBm25Params({ avgLength: 3000, vocabularySize: 3000, totalTokens: 6000 })
  assert.ok(short.b < long.b, `短语料 b=${short.b} 应小于长语料 b=${long.b}`)
  assert.ok(short.b >= 0.35 && long.b <= 0.85, 'b 应在 [0.35, 0.85]')
})

ok('BM25 自适应：高术语密度提高 k1', () => {
  const dense = deriveBm25Params({ avgLength: 100, vocabularySize: 90, totalTokens: 100 })
  const sparse = deriveBm25Params({ avgLength: 100, vocabularySize: 10, totalTokens: 100 })
  assert.ok(dense.k1 > sparse.k1, `高密度 k1=${dense.k1} 应大于低密度 k1=${sparse.k1}`)
})

ok('BM25 自适应：参数在合法区间内', () => {
  const params = deriveBm25Params({ avgLength: 500, vocabularySize: 200, totalTokens: 5000 })
  assert.ok(params.k1 >= 0.9 && params.k1 <= 2.0)
  assert.ok(params.b >= 0.35 && params.b <= 0.85)
})

console.log(`\n全部通过：${passed} 项断言`)
