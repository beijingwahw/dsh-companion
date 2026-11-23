/**
 * 轴线 35 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/earlywarning（临界预警：新奇度序列的临界慢化先行
 * 信号——AR(1) 持续性 + 方差发散 + 漂移斜率三证据融合、分级、
 * 跳变与慢化的概念区分、确定性）与主动脉搏接线
 * （insights/pulse 的 earlywarning 分类，对齐 0.4.0 回声脉搏模式）。
 */
import assert from 'node:assert/strict'
import { detectEarlyWarning } from '../lib/core/cognition/earlywarning.js'
import { earlyWarningInsights } from '../lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 主题 A 词池（docker 网络域）。 */
const TOPIC_A = ['docker', 'compose', 'network', 'bridge', 'container', 'volume']
/** 主题 B 词池（k8s 服务网格域）。 */
const TOPIC_B = ['kubernetes', 'service', 'istio', 'helm', 'pod', 'ingress']

/** 确定性 LCG 伪随机（Lehmer 生成器，可复现）。 */
function lcg(seed) {
  let s = (seed + 17) % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 48271) % 2147483647
    return s / 2147483647
  }
}

/** 第 i 个单元从词池确定性采样 count 个词（无奇偶振荡的微扰分布）。 */
function draw(pool, i, count) {
  const rnd = lcg(i * 7919)
  const words = []
  for (let k = 0; k < count; k += 1) {
    words.push(pool[Math.floor(rnd() * pool.length)])
  }
  return words.join(' ')
}

/** 构造单元：时间戳按小时递增。 */
function unit(i, text) {
  return { id: `s${i}`, at: 1_700_000_000_000 + i * 3_600_000, text }
}

// --------------------------------------------------------------------
// 案例 1：样本不足 → insufficient
// --------------------------------------------------------------------
const tiny = []
for (let i = 0; i < 10; i += 1) tiny.push(unit(i, draw(TOPIC_A, i, 24)))
const tinyReport = detectEarlyWarning(tiny)
ok('样本不足 → insufficient（预警不启动）', () => {
  assert.equal(tinyReport.level, 'insufficient')
  assert.equal(tinyReport.score, 0)
  assert.deepEqual(tinyReport.novelty, [])
})
ok('insufficient 摘要可读且含序列长度', () => {
  assert.ok(tinyReport.summary.length > 0)
  assert.ok(tinyReport.summary.includes(`${tinyReport.seriesLength}`))
})

// --------------------------------------------------------------------
// 案例 2：稳定主题（同分布 iid 微扰）→ calm
// --------------------------------------------------------------------
const stable = []
for (let i = 0; i < 60; i += 1) stable.push(unit(i, draw(TOPIC_A, i, 24)))
const calmReport = detectEarlyWarning(stable)
ok('稳定主题 → calm（预警分低）', () => {
  assert.equal(calmReport.level, 'calm')
  assert.ok(calmReport.score < 0.3)
})
ok('报告数值全部有限（无 NaN 泄漏）', () => {
  const values = [
    calmReport.ar1Delta,
    calmReport.varianceRatio,
    calmReport.slope,
    calmReport.returnRate,
    calmReport.score,
    calmReport.baseline.ar1,
    calmReport.recent.ar1,
    ...calmReport.novelty,
  ]
  for (const v of values) assert.ok(Number.isFinite(v), `非有限值: ${v}`)
})
ok('双半样本拼回序列长度', () => {
  assert.equal(calmReport.baseline.units + calmReport.recent.units, calmReport.seriesLength)
})
ok('novelty 迷你图封顶 64 点', () => {
  assert.ok(calmReport.novelty.length <= 64)
})

// --------------------------------------------------------------------
// 案例 3：渐近相变（B 主题占比加速爬升）→ warning（临界慢化三证据共现）
//
// 数据形态要点（JS 散度修正后仍真实成立的慢化形状，不是凑阈值）：
// - 占比爬升取**加速**（平方）曲线：新奇度是单元对前 16 单元滑动
//   基线的散度，线性爬升下「单元份额 − 尾随基线份额」之差近似
//   常数，新奇度平台化、方差比过不了 1.6；加速爬升让当前与过去
//   的差距随时间放大——这才是方差发散（发散性证据）的来源；
// - B 词以旋转偏移的确定性构成渗入（而非逐单元重抽随机子集）：
//   随机重抽把逐单元采样噪声叠在爬升信号上，新奇度高频抖动、
//   滞后 1 自相关被负化；旋转构成让相邻单元分布缓慢形变——
//   这正是临界慢化「扰动后停留更久」的持续性（AR(1) 上升）特征。
// --------------------------------------------------------------------
const approaching = []
for (let i = 0; i < 60; i += 1) {
  if (i < 30) {
    approaching.push(unit(i, draw(TOPIC_A, i, 24)))
  } else {
    const mix = (i - 29) / 30 // 0.03..1.0
    const fromB = Math.round(mix * mix * 24) // 加速爬升：0→24 个词位
    const offset = i % TOPIC_B.length
    const words = []
    for (let j = 0; j < 24; j += 1) {
      words.push(
        j < fromB
          ? TOPIC_B[(offset + j) % TOPIC_B.length]
          : TOPIC_A[(offset + j) % TOPIC_A.length],
      )
    }
    approaching.push(unit(i, words.join(' ')))
  }
}
const warningReport = detectEarlyWarning(approaching)
ok('渐近相变 → warning（先行信号检出）', () => {
  assert.equal(warningReport.level, 'warning')
})
ok('预警分过 warning 线（≥ 0.55）', () => {
  assert.ok(warningReport.score >= 0.55)
})
ok('AR(1) 方向性：近期半 > 基线半', () => {
  assert.ok(warningReport.recent.ar1 > warningReport.baseline.ar1)
})
ok('方差发散：varianceRatio > 1.6', () => {
  assert.ok(warningReport.varianceRatio > 1.6)
})
ok('近期半 AR(1) 为正（涨落持续性方向向上）', () => {
  assert.ok(warningReport.recent.ar1 > 0)
})
ok('warning 附行动建议且指向交接（模块 B 出口）', () => {
  assert.ok(warningReport.advice !== undefined)
  assert.ok(warningReport.advice.includes('交接'))
})

// --------------------------------------------------------------------
// 案例 4：一次性跳变后稳定（A→B 硬切）→ calm（变点 ≠ 临界慢化——
// 轴线 30 的领地，本引擎必须保持沉默）
// --------------------------------------------------------------------
const settled = []
for (let i = 0; i < 60; i += 1) {
  settled.push(unit(i, i < 26 ? draw(TOPIC_A, i, 24) : draw(TOPIC_B, i, 24)))
}
const settledReport = detectEarlyWarning(settled)
ok('一次性跳变后稳定 → 不报警（跳变是轴线 30 的变点，不是慢化）', () => {
  assert.equal(settledReport.level, 'calm')
})
ok('跳变场景近期斜率不为正（新奇度在回落）', () => {
  assert.ok(settledReport.slope <= 0)
})

// --------------------------------------------------------------------
// 确定性：同输入两次运行结果逐字段一致
// --------------------------------------------------------------------
ok('确定性：同输入两次运行 deepEqual', () => {
  assert.deepEqual(
    detectEarlyWarning(approaching),
    detectEarlyWarning(approaching),
  )
})

// --------------------------------------------------------------------
// 主动脉搏接线（轴线 35 → 轴线 18，对齐 0.4.0 回声脉搏模式）：
// warning → critical 卡（先行信号已共现 + 交接指引），
// watch → watch 卡，calm / insufficient 静默（推送克制）。
// --------------------------------------------------------------------
ok('warning 报告 → earlywarning 分类 critical 卡（行动指向交接）', () => {
  const cards = earlyWarningInsights(warningReport)
  assert.equal(cards.length, 1)
  assert.equal(cards[0].category, 'earlywarning')
  assert.equal(cards[0].severity, 'critical')
  assert.ok(cards[0].text.includes(`${warningReport.unitCount}`))
  assert.ok(cards[0].text.includes(warningReport.score.toFixed(2)))
  assert.ok(cards[0].action.includes('交接'))
  assert.ok(cards[0].source.includes('轴 35'))
})
ok('watch 级 → watch 卡（临界慢化迹象知会）', () => {
  const cards = earlyWarningInsights({
    level: 'watch',
    score: 0.42,
    unitCount: 80,
    seriesLength: 74,
    ar1Delta: 0.31,
    varianceRatio: 2.1,
    returnRate: 0.35,
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].category, 'earlywarning')
  assert.equal(cards[0].severity, 'watch')
  assert.ok(cards[0].text.includes('临界慢化'))
  assert.ok(cards[0].action.includes('earlywarning'))
})
ok('calm / insufficient 静默（预警未到值得打扰的程度不开口）', () => {
  const calmStats = {
    level: 'calm',
    score: calmReport.score,
    unitCount: calmReport.unitCount,
    seriesLength: calmReport.seriesLength,
    ar1Delta: calmReport.ar1Delta,
    varianceRatio: calmReport.varianceRatio,
    returnRate: calmReport.returnRate,
  }
  assert.deepEqual(earlyWarningInsights(calmStats), [])
  assert.deepEqual(earlyWarningInsights({ ...calmStats, level: 'insufficient' }), [])
})

console.log(`全部通过：${passed} 项断言`)
