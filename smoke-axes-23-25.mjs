/**
 * 轴线 23/24/25 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/forecast（遗忘预测）、cognition/rhythm（节律自适应）、
 * cognition/load（认知负荷调度）、spaced 的 ease 扩展、
 * insights/pulse 的元认知信号提供者。
 */
import assert from 'node:assert/strict'
import {
  forecastForgetting,
  predictRetention,
  estimateStabilityDays,
  daysToThreshold,
  memoryZone,
  retentionIndex,
  RETENTION_THRESHOLD,
  CRITICAL_RETENTION,
} from './lib/core/cognition/forecast.js'
import {
  adaptiveIntervalDays,
  clampEase,
  emptyRhythm,
  projectedLadder,
  rhythmHitRate,
  rhythmSummary,
  sanitizeRhythmProfile,
  updateRhythm,
  EASE_MAX,
  EASE_MIN,
  TARGET_HIT_RATE,
} from './lib/core/cognition/rhythm.js'
import {
  planReviewLoad,
  reviewPriority,
  DEFAULT_DAILY_CAP,
} from './lib/core/cognition/load.js'
import {
  dueReviews,
  gradeReview,
  nextDueAt,
  sanitizeReviewState,
} from './lib/core/cognition/spaced.js'
import {
  forgettingForecastInsights,
  loadInsights,
  rhythmInsights,
} from './lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000

/** 构造片段记录的捷径。 */
function episodeRecord(daysAgo, count = 1) {
  return {
    createdAt: NOW - daysAgo * DAY,
    episodes: Array.from({ length: count }, (_, i) => ({
      id: `hash${i}`,
      problem: `问题 ${i}`,
      solution: `解法 ${i}`,
      shape: { constraints: [], resolutions: [] },
    })),
  }
}

console.log('轴线 23：cognition/forecast（遗忘预测引擎）')

ok('稳定性：档位间隔 × 节律 × 标定因子', () => {
  const stability = estimateStabilityDays({ episodeId: 'x', lastReviewedAt: NOW, stage: 3 }, 1)
  // 14 天 × 1 × (1 / -ln 0.7) ≈ 39.25
  assert.ok(Math.abs(stability - 14 / -Math.log(RETENTION_THRESHOLD)) < 1e-6)
  // 无状态按第 0 档（1 天）计
  assert.ok(Math.abs(estimateStabilityDays(undefined, 1) - 1 / -Math.log(RETENTION_THRESHOLD)) < 1e-6)
  // 节律 0.6 → 稳定性压缩 40%
  assert.ok(
    Math.abs(
      estimateStabilityDays({ episodeId: 'x', lastReviewedAt: NOW, stage: 3 }, 0.6) - stability * 0.6,
    ) < 1e-6,
  )
})

ok('保持率：刚复习 ≈ 1；到期时刻 = 阈值（与调度自洽）', () => {
  const state = { episodeId: 'x', lastReviewedAt: NOW, stage: 3 }
  assert.ok(predictRetention(state, NOW, NOW, 1) > 0.999)
  const dueMoment = NOW + 14 * DAY
  const atDue = predictRetention(state, NOW, dueMoment, 1)
  assert.ok(Math.abs(atDue - RETENTION_THRESHOLD) < 1e-9)
})

ok('保持率：从未复习的旧片段滑入深度遗忘', () => {
  // 60 天前创建、无复习状态 → 保持率 ≈ e^(-60/2.8) ≈ 0
  const retention = predictRetention(undefined, NOW - 60 * DAY, NOW, 1)
  assert.ok(retention < 0.01)
})

ok('daysToThreshold：到期前为正、到期时为零、过期为负', () => {
  const stability = estimateStabilityDays({ episodeId: 'x', lastReviewedAt: NOW, stage: 2 }, 1)
  const before = predictRetention({ episodeId: 'x', lastReviewedAt: NOW, stage: 2 }, NOW, NOW + 3 * DAY, 1)
  assert.ok(daysToThreshold(before, stability) > 3.9 && daysToThreshold(before, stability) < 4.1)
  const atDue = predictRetention({ episodeId: 'x', lastReviewedAt: NOW, stage: 2 }, NOW, NOW + 7 * DAY, 1)
  assert.ok(Math.abs(daysToThreshold(atDue, stability)) < 1e-6)
  const after = predictRetention({ episodeId: 'x', lastReviewedAt: NOW, stage: 2 }, NOW, NOW + 9 * DAY, 1)
  assert.ok(daysToThreshold(after, stability) < -1.9)
})

ok('分区边界：critical / warning / stable', () => {
  assert.equal(memoryZone(0.29), 'critical')
  assert.equal(memoryZone(CRITICAL_RETENTION), 'warning')
  assert.equal(memoryZone(0.5), 'warning')
  assert.equal(memoryZone(RETENTION_THRESHOLD), 'stable')
  assert.equal(memoryZone(0.95), 'stable')
})

ok('节律漂移预警：按旧节律排程未到期，按新节律已滑落', () => {
  // 8 天前按 ease 1.5 评分至 stage 2 → 排程 7×1.5 ≈ 11 天后到期。
  const state = { episodeId: 'x', lastReviewedAt: NOW - 8 * DAY, stage: 2, ease: 1.5 }
  const dueAt = nextDueAt(state)
  assert.ok(dueAt > NOW, '按旧节律尚未到期')
  // 当前节律跌到 0.6：稳定性 = 7 × 0.6 × 2.8 ≈ 11.8 天，8 天已衰减到 ~0.51。
  const retention = predictRetention(state, NOW - 8 * DAY, NOW, 0.6)
  assert.ok(retention < RETENTION_THRESHOLD && retention >= CRITICAL_RETENTION)
  assert.ok(daysToThreshold(retention, estimateStabilityDays(state, 0.6)) < 0)
})

ok('retentionIndex：全量片段的保持率查表', () => {
  const episodes = new Map([
    ['s1', episodeRecord(30)],
    ['s2', episodeRecord(2)],
  ])
  const states = new Map([
    ['s1:hash0', { episodeId: 's1:hash0', lastReviewedAt: NOW - 1 * DAY, stage: 4 }],
  ])
  const index = retentionIndex(episodes, states, NOW, 1)
  assert.equal(index.size, 2)
  assert.ok(index.get('s1:hash0') > 0.9)
  assert.ok(index.get('s2:hash0') < 0.5)
})

ok('forecastForgetting：分桶 + 计数 + 排序 + 摘要', () => {
  const episodes = new Map([
    ['old', episodeRecord(90)],      // 从未复习 → critical
    ['mid', episodeRecord(6)],       // 从未复习 6 天 → e^(-6/2.8) ≈ 0.12 → critical
    ['fresh', episodeRecord(0.1)],   // 刚创建 → stable
  ])
  const states = new Map([
    ['mid:hash0', { episodeId: 'mid:hash0', lastReviewedAt: NOW - 4 * DAY, stage: 2 }], // 4/19.6 → ~0.83 stable
  ])
  const report = forecastForgetting(episodes, states, NOW, 1)
  assert.equal(report.criticalCount, 1)
  assert.equal(report.warningCount, 0)
  assert.equal(report.stableCount, 2)
  assert.ok(report.summary.includes('深度遗忘'))
  assert.equal(report.critical[0].sessionId, 'old')
})

ok('forecastForgetting：滑落区按保持率升序（最危险在前）', () => {
  const episodes = new Map([
    ['a', episodeRecord(3)],  // e^(-3/2.8) ≈ 0.34 warning
    ['b', episodeRecord(2)],  // e^(-2/2.8) ≈ 0.49 warning
    ['c', episodeRecord(1)],  // e^(-1/2.8) ≈ 0.70 stable（边界）
  ])
  const report = forecastForgetting(episodes, new Map(), NOW, 1)
  assert.equal(report.warningCount, 2)
  assert.ok(report.warning[0].retention <= report.warning[1].retention)
  assert.equal(report.warning[0].sessionId, 'a')
})

ok('forecastForgetting：空库摘要', () => {
  const report = forecastForgetting(new Map(), new Map(), NOW, 1)
  assert.equal(report.criticalCount, 0)
  assert.equal(report.stableCount, 0)
  assert.ok(report.summary.includes('尚无可预测'))
})

console.log('轴线 24：cognition/rhythm（个体节律自适应）')

ok('空档案：ease 1 冷启动', () => {
  const profile = emptyRhythm()
  assert.equal(profile.ease, 1)
  assert.equal(profile.remembered, 0)
  assert.equal(rhythmHitRate(profile), 0)
  assert.ok(rhythmSummary(profile).includes('冷启动'))
})

ok('冷启动保护：样本不足 3 次不动系数', () => {
  let profile = emptyRhythm()
  profile = updateRhythm(profile, true, NOW)
  profile = updateRhythm(profile, true, NOW)
  assert.equal(profile.ease, 1)
  assert.equal(profile.remembered, 2)
})

ok('高命中 → ease 上调（间隔拉长）', () => {
  let profile = { remembered: 8, forgotten: 0, ease: 1, updatedAt: null }
  profile = updateRhythm(profile, true, NOW)
  // 命中率 9/9 = 1 → ease += (1 - 0.85) × 1.5 = 1.225
  assert.ok(Math.abs(profile.ease - 1.225) < 1e-9)
})

ok('低命中 → ease 下调（间隔压缩）', () => {
  let profile = { remembered: 1, forgotten: 5, ease: 1, updatedAt: null }
  profile = updateRhythm(profile, false, NOW)
  // 命中率 1/7 ≈ 0.143 → 未收敛值 ≈ -0.06 → 触底 EASE_MIN
  assert.ok(profile.ease < 1)
  assert.equal(profile.ease, EASE_MIN)
  // 温和下修不触底：7/(7+2+1) = 0.7 → ease = 1 + (0.7-0.85)×1.5 = 0.775
  let mild = { remembered: 7, forgotten: 2, ease: 1, updatedAt: null }
  mild = updateRhythm(mild, false, NOW)
  assert.ok(Math.abs(mild.ease - 0.775) < 1e-9)
})

ok('ease 收敛区间：clamp 上下限', () => {
  assert.equal(clampEase(0.1), EASE_MIN)
  assert.equal(clampEase(9), EASE_MAX)
  let profile = { remembered: 100, forgotten: 0, ease: 1.95, updatedAt: null }
  profile = updateRhythm(profile, true, NOW)
  assert.equal(profile.ease, EASE_MAX)
})

ok('自适应间隔：四舍五入 + 最小 1 天', () => {
  assert.equal(adaptiveIntervalDays(7, 1.3), 9)
  assert.equal(adaptiveIntervalDays(1, 0.5), 1)
  assert.equal(adaptiveIntervalDays(30, 2), 60)
})

ok('gradeReview ease 扩展：间隔缩放 + 状态记录排程节律', () => {
  const base = { episodeId: 'x', lastReviewedAt: null, stage: 1 }
  const result = gradeReview(base, true, NOW, 1.4)
  assert.equal(result.nextIntervalDays, 10) // 7 × 1.4 = 9.8 → 10
  assert.equal(result.state.ease, 1.4)
  assert.equal(result.state.stage, 2)
  // 纯函数重算到期时间与排程一致。
  assert.equal(nextDueAt(result.state), NOW + 10 * DAY)
  // ease 缺省 1 → 与固定阶梯行为一致（向后兼容）。
  const standard = gradeReview(base, true, NOW)
  assert.equal(standard.nextIntervalDays, 7)
  assert.equal(standard.state.ease, 1)
})

ok('投影阶梯：标准 → 你的', () => {
  const ladder = projectedLadder(1.25)
  assert.equal(ladder.length, 6)
  assert.deepEqual(
    ladder.map((step) => step.adaptedDays),
    [1, 4, 9, 18, 38, 75],
  )
})

ok('节律摘要：三向文案', () => {
  assert.ok(rhythmSummary({ remembered: 9, forgotten: 0, ease: 1.3, updatedAt: NOW }).includes('记得牢'))
  assert.ok(rhythmSummary({ remembered: 2, forgotten: 8, ease: 0.7, updatedAt: NOW }).includes('压缩'))
  assert.ok(rhythmSummary({ remembered: 8, forgotten: 2, ease: 1.0, updatedAt: NOW }).includes('基本一致'))
})

ok('节律净化：合法通过 / ease 越界收敛 / 计数非法丢弃', () => {
  const clean = sanitizeRhythmProfile({ remembered: 5, forgotten: 2, ease: 1.1, updatedAt: NOW })
  assert.ok(clean !== undefined)
  assert.equal(clean.ease, 1.1)
  const drifted = sanitizeRhythmProfile({ remembered: 5, forgotten: 2, ease: 9 })
  assert.ok(drifted !== undefined)
  assert.equal(drifted.ease, EASE_MAX)
  assert.equal(sanitizeRhythmProfile({ remembered: -1, forgotten: 2, ease: 1 }), undefined)
  assert.equal(sanitizeRhythmProfile({ remembered: 1, forgotten: 'x', ease: 1 }), undefined)
  assert.equal(sanitizeRhythmProfile(null), undefined)
})

ok('复习状态净化：ease 字段校验', () => {
  const clean = sanitizeReviewState({ episodeId: 'x', lastReviewedAt: NOW, stage: 2, ease: 1.4 })
  assert.ok(clean !== undefined)
  assert.equal(clean.ease, 1.4)
  assert.equal(sanitizeReviewState({ episodeId: 'x', lastReviewedAt: NOW, stage: 2 }).ease, undefined)
  assert.equal(sanitizeReviewState({ episodeId: 'x', lastReviewedAt: NOW, stage: 2, ease: -1 }), undefined)
  assert.equal(sanitizeReviewState({ episodeId: 'x', lastReviewedAt: NOW, stage: 2, ease: 'fast' }), undefined)
})

console.log('轴线 25：cognition/load（认知负荷调度）')

ok('分诊打分：可救窗口 × 巩固投资', () => {
  const slipping = reviewPriority(
    { episodeId: 'a', sessionId: 's', problem: '', solution: '', dueAt: NOW, overdueDays: 1, fresh: false, strength: 0.4, createdAt: NOW },
    0.5,
  )
  assert.ok(slipping.priority > 0)
  assert.ok(slipping.reason.includes('最佳巩固窗口'))
  const lost = reviewPriority(
    { episodeId: 'b', sessionId: 's', problem: '', solution: '', dueAt: NOW, overdueDays: 30, fresh: true, strength: 0, createdAt: NOW },
    0.05,
  )
  assert.ok(lost.reason.includes('深度遗忘'))
  const healthy = reviewPriority(
    { episodeId: 'c', sessionId: 's', problem: '', solution: '', dueAt: NOW, overdueDays: 0, fresh: false, strength: 0, createdAt: NOW },
    0.9,
  )
  assert.ok(healthy.reason.includes('刚到期'))
})

ok('负荷计划：滑落区优先于逾期更久的深度遗忘', () => {
  const mk = (id, overdueDays, strength) => ({
    episodeId: id,
    sessionId: 's',
    problem: `问题 ${id}`,
    solution: `解法 ${id}`,
    dueAt: NOW - overdueDays * DAY,
    overdueDays,
    fresh: false,
    strength,
    createdAt: NOW - 100 * DAY,
  })
  const due = [mk('lost', 40, 0), mk('slipping', 2, 0.6)]
  const plan = planReviewLoad(due, (id) => (id === 'lost' ? 0.05 : 0.5), 8)
  assert.equal(plan.today[0].review.episodeId, 'slipping')
  assert.equal(plan.totalDue, 2)
  assert.equal(plan.deferredCount, 0)
  assert.equal(plan.health, 'normal')
})

ok('负荷计划：封顶 + 顺延 + overload 判定', () => {
  const due = Array.from({ length: 20 }, (_, i) => ({
    episodeId: `e${i}`,
    sessionId: 's',
    problem: `问题 ${i}`,
    solution: `解法 ${i}`,
    dueAt: NOW,
    overdueDays: i,
    fresh: true,
    strength: 0,
    createdAt: NOW - (100 - i) * DAY,
  }))
  const plan = planReviewLoad(due, () => 0.5, 8)
  assert.equal(plan.today.length, 8)
  assert.equal(plan.deferredCount, 12)
  assert.equal(plan.health, 'overload')
  assert.ok(plan.summary.includes('洪峰'))
  assert.ok(plan.summary.includes('顺延'))
})

ok('负荷计划：查不到保持率按阈值中性处理', () => {
  const due = [
    { episodeId: 'x', sessionId: 's', problem: '', solution: '', dueAt: NOW, overdueDays: 0, fresh: true, strength: 0, createdAt: NOW },
  ]
  const plan = planReviewLoad(due, () => undefined, 8)
  assert.equal(plan.today[0].retention, RETENTION_THRESHOLD)
  assert.ok(plan.today[0].reason.includes('刚到期'))
})

ok('负荷计划：空到期 → clear', () => {
  const plan = planReviewLoad([], () => undefined, DEFAULT_DAILY_CAP)
  assert.equal(plan.health, 'clear')
  assert.equal(plan.totalDue, 0)
  assert.ok(plan.summary.includes('认知负荷为零'))
})

console.log('轴线 18 扩展：元认知信号提供者')

ok('遗忘预测信号：critical / watch / info / 静默 四态', () => {
  const critical = forgettingForecastInsights({ criticalCount: 5, warningCount: 3, stableCount: 10 })
  assert.equal(critical[0].severity, 'critical')
  assert.ok(critical[0].text.includes('5 条'))
  const watch = forgettingForecastInsights({ criticalCount: 0, warningCount: 4, stableCount: 10 })
  assert.equal(watch[0].severity, 'watch')
  assert.ok(watch[0].text.includes('最佳巩固窗口'))
  const info = forgettingForecastInsights({ criticalCount: 0, warningCount: 0, stableCount: 12 })
  assert.equal(info[0].severity, 'info')
  assert.equal(forgettingForecastInsights({ criticalCount: 0, warningCount: 0, stableCount: 0 }).length, 0)
})

ok('节律信号：冷启动静默 / 显著偏离才播报', () => {
  assert.equal(rhythmInsights({ remembered: 1, forgotten: 1, ease: 1 }).length, 0)
  const strong = rhythmInsights({ remembered: 30, forgotten: 1, ease: 1.5 })
  assert.equal(strong[0].severity, 'info')
  assert.ok(strong[0].text.includes('记得牢'))
  const weak = rhythmInsights({ remembered: 3, forgotten: 12, ease: 0.6 })
  assert.equal(weak[0].severity, 'watch')
  assert.ok(weak[0].text.includes('压缩'))
  assert.equal(rhythmInsights({ remembered: 17, forgotten: 3, ease: 1.0 }).length, 0)
})

ok('负荷信号：只在顺延发生时开口', () => {
  assert.equal(loadInsights({ totalDue: 5, todayCount: 5, deferredCount: 0 }).length, 0)
  const card = loadInsights({ totalDue: 23, todayCount: 8, deferredCount: 15 })[0]
  assert.equal(card.severity, 'watch')
  assert.ok(card.text.includes('23 条到期'))
  assert.ok(card.action.includes('今日 8 条'))
})

console.log(`\n全部通过：${passed} 项断言`)
