/**
 * 认知引擎确定性算法完整性回归测试（驱动 lib/ 编译产物，ESM）。
 *
 * 覆盖六处已确认的算法缺陷修复：
 *
 * 1. spaced.dueReviews：到期复习按逾期天数**降序**（注释与负荷分诊
 *    均约定「逾期越久越靠前」，比较器曾误为升序），同逾期按会话
 *    时间新→旧；
 * 2. prospective.dueIntentions：到期意图同样按超期降序，同超期按
 *    到期时间新→旧；
 * 3. drift 段间 JS 散度：重叠支撑集上 q 侧的 0.5·q·log2(q/m) 不再
 *    漏加（漏项会系统性低估切换强度）——通过公开报告 changepoint
 *    .jump 与独立参考实现比对验证（纯内部函数不扩大 API）；
 * 4. earlywarning 新奇度 JS 散度：同上，通过公开报告 novelty 序列
 *    与独立参考实现比对验证；
 * 5. brokerage 中介对预算：单节点超预算只跳过该候选（continue），
 *    后续度数更小的候选仍被扫描（原 break 误杀全表）；
 * 6. consolidation：两个空 token 集的 Jaccard 为 0（空文本不再
 *    抱团成近重复簇）；maxItems 截断按时间近端优先（缺 at 视为最旧），
 *    不再是 id 字典序的偶然结果。
 */
import assert from 'node:assert/strict'
import { dueReviews } from '../lib/core/cognition/spaced.js'
import { dueIntentions } from '../lib/core/cognition/prospective.js'
import { detectTopicDrift } from '../lib/core/cognition/drift.js'
import { detectEarlyWarning } from '../lib/core/cognition/earlywarning.js'
import { detectBrokerage } from '../lib/core/cognition/brokerage.js'
import { consolidateMemories, jaccard } from '../lib/core/cognition/consolidation.js'
import { tokenize } from '../lib/core/retrieval/tokenize.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY_MS = 24 * 3600_000
const T0 = 1_700_000_000_000

// --------------------------------------------------------------------
// 参考实现：数学正确的 JS 散度（双侧）与漏项版（修复前行为），
// 用于验证公开报告数值不低估重叠支撑集上的真实散度。
// --------------------------------------------------------------------
function jsReference(p, pTot, q, qTot) {
  let js = 0
  for (const [w, pc] of p) {
    const pw = pc / pTot
    const qw = (q.get(w) ?? 0) / qTot
    const m = (pw + qw) / 2
    js += 0.5 * pw * Math.log2(pw / m)
    if (qw > 0) js += 0.5 * qw * Math.log2(qw / m)
  }
  for (const [w, qc] of q) {
    if ((p.get(w) ?? 0) > 0) continue
    js += 0.5 * (qc / qTot)
  }
  return Math.min(1, Math.max(0, js))
}

function jsBuggy(p, pTot, q, qTot) {
  let js = 0
  for (const [w, pc] of p) {
    const pw = pc / pTot
    const qw = (q.get(w) ?? 0) / qTot
    const m = (pw + qw) / 2
    js += 0.5 * pw * Math.log2(pw / m)
  }
  for (const [w, qc] of q) {
    if ((p.get(w) ?? 0) > 0) continue
    js += 0.5 * (qc / qTot)
  }
  return Math.min(1, Math.max(0, js))
}

/** 词表内 token 计数（复刻 drift/earlywarning 的 df ≥ 2 过滤纪律）。 */
function vocabFilteredCounts(texts) {
  const termLists = texts.map((text) => tokenize(text))
  const df = new Map()
  for (const terms of termLists) {
    for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return termLists.map((terms) => {
    const counts = new Map()
    let total = 0
    for (const term of terms) {
      if ((df.get(term) ?? 0) < 2) continue
      counts.set(term, (counts.get(term) ?? 0) + 1)
      total += 1
    }
    return { counts, total }
  })
}

// --------------------------------------------------------------------
// 1. spaced.dueReviews：逾期降序 + 次级键
// --------------------------------------------------------------------
const spacedEpisodes = new Map([
  [
    'sess-recent',
    {
      createdAt: T0,
      episodes: [{ id: 'ep1', problem: '问题一', solution: '解法一', shape: 'qa' }],
    },
  ],
  [
    'sess-stale',
    {
      createdAt: T0 - 5 * DAY_MS,
      episodes: [{ id: 'ep2', problem: '问题二', solution: '解法二', shape: 'qa' }],
    },
  ],
  [
    // 与 sess-recent 同逾期天数（不足一天的差被 floor 吃掉）、createdAt 更早：
    // 用于验证同逾期时新会话优先。
    'sess-tie',
    {
      createdAt: T0 - 3600_000,
      episodes: [{ id: 'ep3', problem: '问题三', solution: '解法三', shape: 'qa' }],
    },
  ],
])
const spacedDue = dueReviews(spacedEpisodes, new Map(), T0 + 2 * DAY_MS)
ok('spaced：逾期越久越靠前（降序），同逾期按会话时间新→旧', () => {
  assert.equal(spacedDue.length, 3)
  assert.deepEqual(
    spacedDue.map((d) => d.episodeId),
    ['sess-stale:ep2', 'sess-recent:ep1', 'sess-tie:ep3'],
  )
  assert.ok(spacedDue[0].overdueDays > spacedDue[1].overdueDays)
  assert.equal(spacedDue[1].overdueDays, spacedDue[2].overdueDays)
  assert.ok(spacedDue[1].createdAt > spacedDue[2].createdAt)
})

// --------------------------------------------------------------------
// 2. prospective.dueIntentions：超期降序 + 次级键
// --------------------------------------------------------------------
const intentionRecords = new Map([
  [
    'sess-a',
    {
      createdAt: T0,
      intentions: [
        { text: '明天试试这个方案', marker: '明天', horizonDays: 1, explicit: true },
        { text: '下周再优化性能', marker: '下周', horizonDays: 7, explicit: true },
      ],
    },
  ],
])
const intentionsNow = T0 + 10 * DAY_MS
const intentionDue = dueIntentions(intentionRecords, intentionsNow)
ok('prospective：超期越久越靠前（降序）', () => {
  assert.equal(intentionDue.length, 2)
  assert.deepEqual(
    intentionDue.map((d) => d.marker),
    ['明天', '下周'],
  )
  assert.ok(intentionDue[0].overdueDays > intentionDue[1].overdueDays)
})

const tieRecords = new Map([
  [
    'sess-early-due',
    {
      createdAt: T0,
      intentions: [{ text: '回头验证一下', marker: '回头', horizonDays: 4, explicit: false }],
    },
  ],
  [
    // dueAt 晚 12 小时但 floor 后超期天数相同：同超期时到期时间新者优先。
    'sess-late-due',
    {
      createdAt: T0 + 12 * 3600_000,
      intentions: [{ text: '回头整理笔记', marker: '回头', horizonDays: 4, explicit: false }],
    },
  ],
])
const tieDue = dueIntentions(tieRecords, T0 + 6.5 * DAY_MS)
ok('prospective：同超期按到期时间新→旧', () => {
  assert.equal(tieDue.length, 2)
  assert.equal(tieDue[0].overdueDays, tieDue[1].overdueDays)
  assert.ok(tieDue[0].dueAt > tieDue[1].dueAt)
  assert.equal(tieDue[0].sessionId, 'sess-late-due')
})

// --------------------------------------------------------------------
// 3. drift：重叠支撑集（词频不对称）上的 JS 散度不低估
//    块 A「alpha×3 shared beta」×10，块 B「shared×3 gamma delta」×10——
//    共享词 shared 两侧频次相反（qw > pw），漏项版会低估约 0.06 bit。
// --------------------------------------------------------------------
const driftUnits = []
for (let i = 0; i < 10; i += 1) {
  driftUnits.push({ id: `a${i}`, at: T0 + (i + 1) * DAY_MS, text: 'alpha alpha alpha shared beta' })
}
for (let i = 0; i < 10; i += 1) {
  driftUnits.push({ id: `b${i}`, at: T0 + (i + 11) * DAY_MS, text: 'shared shared shared gamma delta' })
}
const driftReport = detectTopicDrift(driftUnits, { hazardLambda: 6 })
ok('drift：检测到主题切换且 jump 与数学正确的 JS 散度一致（不低估）', () => {
  assert.equal(driftReport.changepoints.length, 1)
  const cp = driftReport.changepoints[0]
  assert.ok(cp.probability >= 0.5)
  const before = driftReport.segments.find((s) => s.endIndex === cp.index - 1)
  const after = driftReport.segments.find((s) => s.startIndex === cp.index)
  assert.ok(before !== undefined && after !== undefined)
  const filtered = vocabFilteredCounts(driftUnits.map((u) => u.text))
  const merge = (seg) => {
    const counts = new Map()
    let total = 0
    for (let i = seg.startIndex; i <= seg.endIndex; i += 1) {
      for (const [term, c] of filtered[i].counts) counts.set(term, (counts.get(term) ?? 0) + c)
      total += filtered[i].total
    }
    return { counts, total }
  }
  const p = merge(before)
  const q = merge(after)
  const correct = jsReference(p.counts, p.total, q.counts, q.total)
  const buggy = jsBuggy(p.counts, p.total, q.counts, q.total)
  // 用例有效性：该支撑集形态下漏项版确实更低（否则测试无判别力）。
  assert.ok(correct - buggy > 0.02, `用例判别力不足：correct=${correct} buggy=${buggy}`)
  assert.ok(Math.abs(cp.jump - correct) <= 0.001, `jump=${cp.jump}，参考值=${correct}`)
})

// --------------------------------------------------------------------
// 4. earlywarning：新奇度序列的 JS 散度不低估
//    基线「shared×2 alpha」，探针单元「shared beta×2」——共享词
//    shared 基线侧更重（qw > pw），漏项版 0.4025 vs 正确 0.5409。
// --------------------------------------------------------------------
const ewUnits = []
for (let i = 0; i < 10; i += 1) {
  ewUnits.push({ id: `u${i}`, at: T0 + (i + 1) * DAY_MS, text: 'shared shared alpha' })
}
ewUnits.push({ id: 'u10', at: T0 + 11 * DAY_MS, text: 'shared beta beta' })
ewUnits.push({ id: 'u11', at: T0 + 12 * DAY_MS, text: 'shared beta beta' })
const ewReport = detectEarlyWarning(ewUnits, { minUnits: 8, minBaselineUnits: 2 })
ok('earlywarning：探针单元新奇度与数学正确的 JS 散度一致（不低估）', () => {
  assert.equal(ewReport.seriesLength, 10)
  assert.equal(ewReport.novelty.length, 10)
  // t = 10（novelty 下标 8）：基线 = 单元 0..9（全为 shared×2 alpha）。
  const filtered = vocabFilteredCounts(ewUnits.map((u) => u.text))
  const base = new Map()
  let baseTotal = 0
  for (let b = 0; b < 10; b += 1) {
    for (const [term, c] of filtered[b].counts) base.set(term, (base.get(term) ?? 0) + c)
    baseTotal += filtered[b].total
  }
  const probe = filtered[10]
  const correct = jsReference(probe.counts, probe.total, base, baseTotal)
  const buggy = jsBuggy(probe.counts, probe.total, base, baseTotal)
  assert.ok(correct - buggy > 0.05, `用例判别力不足：correct=${correct} buggy=${buggy}`)
  assert.ok(Math.abs(ewReport.novelty[8] - correct) <= 0.001, `novelty=${ewReport.novelty[8]}，参考值=${correct}`)
})

// --------------------------------------------------------------------
// 5. brokerage：首候选（病态枢纽）超预算后，后续小候选仍被扫描
// --------------------------------------------------------------------
const HUB_NEIGHBORS = 11 // 11×10 = 110 中介对 > 100（pairBudget 下限）
const graphNodes = [
  { key: 'term:hub', name: 'hub', type: 'term', sessions: new Set(['s0']) },
  { key: 'term:bridge', name: 'bridge', type: 'term', sessions: new Set(['s1']) },
]
for (let i = 0; i < HUB_NEIGHBORS; i += 1) {
  graphNodes.push({ key: `term:n${i}`, name: `n${i}`, type: 'term', sessions: new Set(['s0']) })
}
for (const leaf of ['x', 'y', 'z']) {
  graphNodes.push({ key: `term:${leaf}`, name: leaf, type: 'term', sessions: new Set(['s1']) })
}
const adjacency = new Map()
const link = (a, b, w) => {
  if (!adjacency.has(a)) adjacency.set(a, new Map())
  if (!adjacency.has(b)) adjacency.set(b, new Map())
  adjacency.get(a).set(b, w)
  adjacency.get(b).set(a, w)
}
for (let i = 0; i < HUB_NEIGHBORS; i += 1) link('term:hub', `term:n${i}`, 1)
for (const leaf of ['x', 'y', 'z']) link('term:bridge', `term:${leaf}`, 1)
const brokerageReport = detectBrokerage(
  { nodes: graphNodes, adjacency, totalWeight: HUB_NEIGHBORS + 3, edgeCount: HUB_NEIGHBORS + 3 },
  { pairBudget: 100 },
)
ok('brokerage：单节点超预算只熔断自身，后续候选仍入统', () => {
  assert.equal(brokerageReport.budgetExhausted, true)
  assert.equal(brokerageReport.candidates, 1)
  assert.equal(brokerageReport.brokers.length, 1)
  assert.equal(brokerageReport.brokers[0].key, 'term:bridge')
  assert.equal(brokerageReport.brokers[0].degree, 3)
})

// --------------------------------------------------------------------
// 6. consolidation：空 token 集不成簇 + maxItems 近端优先截断
// --------------------------------------------------------------------
ok('consolidation：jaccard(∅, ∅) = 0（空集无可比较的支撑集）', () => {
  assert.equal(jaccard(new Set(), new Set()), 0)
  assert.equal(jaccard(new Set(['a']), new Set()), 0)
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1)
})

const emptyPlan = consolidateMemories([
  { id: 'e1', text: '', at: T0 + 10 },
  { id: 'e2', text: '   ', at: T0 + 11 },
  { id: 'g1', text: '相同的知识条目文本', at: T0 + 12 },
  { id: 'g2', text: '相同的知识条目文本', at: T0 + 13 },
])
ok('consolidation：空文本不成近重复簇，真实重复对正常归簇', () => {
  assert.equal(emptyPlan.clusters.length, 1)
  assert.deepEqual(emptyPlan.clusters[0].memberIds, ['g1', 'g2'])
  assert.equal(emptyPlan.duplicates, 1)
  assert.equal(emptyPlan.unique, 2)
})

// 旧条目 id 字典序**靠后**但时间最旧：按 id 截断（旧行为）会错误保留
// 旧重复对、丢掉新条目；按时间近端截断（修复后）应保留 a01..a10。
const recencyItems = [
  { id: 'z-old-1', text: '重复的旧知识条目内容', at: 1 },
  { id: 'z-old-2', text: '重复的旧知识条目内容', at: 2 },
]
for (let i = 1; i <= 10; i += 1) {
  const id = `a${String(i).padStart(2, '0')}`
  recencyItems.push({
    id,
    // 填充项必须彼此真正不相似（否则自身归簇干扰截断断言）。
    text: i >= 9 ? '重复的新知识条目内容' : `filler${i}qx distinct${i}zw vocab${i}jk`,
    at: 100 + i,
  })
}
const recencyPlan = consolidateMemories(recencyItems, { maxItems: 10 })
ok('consolidation：maxItems 截断近端优先（近期输入保留，最旧条目被淘汰）', () => {
  assert.equal(recencyPlan.items, 10)
  assert.equal(recencyPlan.clusters.length, 1)
  assert.deepEqual(recencyPlan.clusters[0].memberIds, ['a09', 'a10'])
  assert.equal(recencyPlan.duplicates, 1)
  assert.equal(recencyPlan.unique, 8)
})

console.log(`全部通过：${passed} 项断言`)
