/**
 * 临界预警引擎（轴线 35）：复杂系统临界转换的先行信号检测
 * （Early-Warning Signals，Scheffer et al. 2009, Nature）。
 *
 * 设计动机：轴线 30（BOCPD）在切换**发生后**定位变点——那是考古；
 * 没有任何组件回答「注意力是否**正在逼近**一次主题相变」。复杂系统
 * 在逼近分岔点时普遍出现**临界慢化**（critical slowing down）：主导
 * 特征值趋零 → 系统从扰动中回弹变慢 → 在观测序列上表现为两条统计
 * 律——滞后 1 自相关（AR(1)）系统性上升、方差系统性放大。
 *
 * 本引擎把会话流的新奇度（每场对话与其前 W 场基线的一元分布
 * JS 散度）作为指示序列，在其上检验三证据：
 *
 * - **持续性**（AR(1) 上升）：新奇度涨了之后**停留**得更久——
 *   系统对扰动的恢复力在减弱（AR(1) 是主导特征值的矩估计）；
 * - **发散性**（方差上升）：新奇度波动的振幅在放大——系统在
 *   相变边缘「晃得更远」；
 * - **漂移性**（近期斜率上升）：新奇度水平本身在爬升——注意力
 *   正在离开当前主题的吸引盆。
 *
 * 三证据加权融合为 [0,1] 预警分：持续 45% + 发散 30% + 漂移 25%。
 * warning 级额外要求**至少两类证据在场**（证据值 > 0.1 计数）——这是
 * Scheffer 2009 的多指标纪律：任何单一先行指标都可能误报，共现才是
 * 相变的指纹。一次性跳变后回落会被漂移方向与方差对比否决——那是
 * 轴线 30 的变点，不是临界慢化。
 *
 * 与相邻轴线的分工：轴线 30 看浪（变点定位，后视），本轴看洋流的
 * 拐点（相变逼近，前瞻）；轴线 23 的遗忘预测作用于记忆侧，本轴
 * 作用于注意力侧。行动出口：warning 级建议立即为当前主题生成交接
 * 摘要（模块 B）——趁注意力盆地切换前把上下文存档。
 *
 * 全部计算纯本地、确定性、零 LLM、零网络。
 */

import { tokenize } from '../retrieval/tokenize.js'

/** 临界预警的观测单元（与主题漂移同构：会话标题 + 实体名投影）。 */
export interface EarlyWarningUnit {
  /** 单元 id（会话 id 或任意稳定标识）。 */
  readonly id: string
  /** 时间戳（毫秒）。 */
  readonly at: number
  /** 文本（调用方决定粒度；与 drift 单元同源）。 */
  readonly text: string
}

/** 临界预警配置。 */
export interface EarlyWarningOptions {
  /** 期望段内回看基线窗口（单元数）——新奇度参照系；缺省 16。 */
  readonly baselineUnits?: number
  /** 进入分析的最小序列长度（不足 → insufficient）；缺省 40。 */
  readonly minUnits?: number
  /** 滑窗单元上限（时间近端优先）；缺省 240。 */
  readonly maxUnits?: number
  /** 基线成立所需的最少前置单元；缺省 6。 */
  readonly minBaselineUnits?: number
}

/** 一段（基线半 / 近期半）的指示序列统计。 */
export interface EarlyWarningHalfStats {
  /** 半窗样本数。 */
  readonly units: number
  /** 滞后 1 自相关（AR(1)；零方差记 0）。 */
  readonly ar1: number
  /** 方差（总体口径）。 */
  readonly variance: number
}

/** 临界预警报告。 */
export interface EarlyWarningReport {
  /** 报告基准时间（最后单元时间戳）。 */
  readonly now: number
  /** 窗口内单元数。 */
  readonly unitCount: number
  /** 进入统计的新奇度序列长度。 */
  readonly seriesLength: number
  /** 基线半统计（序列前半）。 */
  readonly baseline: EarlyWarningHalfStats
  /** 近期半统计（序列后半）。 */
  readonly recent: EarlyWarningHalfStats
  /** AR(1) 变化量（近期 − 基线）。 */
  readonly ar1Delta: number
  /** 方差比（近期 / 基线；基线零方差时按 ε 稳压）。 */
  readonly varianceRatio: number
  /** 近期半 OLS 斜率（单位：新奇度/单元，标准化见 summary）。 */
  readonly slope: number
  /** 回弹率 = 1 − 近期 AR(1)（主导特征值到临界点的距离，[0,2]；小 = 逼近）。 */
  readonly returnRate: number
  /** 三证据融合预警分 [0,1]。 */
  readonly score: number
  /** 预警分级。 */
  readonly level: 'insufficient' | 'calm' | 'watch' | 'warning'
  /** 近端新奇度序列（供客户端迷你图；封顶 64 点）。 */
  readonly novelty: readonly number[]
  /** 人话摘要。 */
  readonly summary: string
  /** 行动建议（watch/warning 级附；其余为 undefined）。 */
  readonly advice?: string
}

/** 滞后 1 自相关（AR(1)）：x_t 与 x_{t+1} 的皮尔森相关；零方差记 0。 */
function lag1Autocorrelation(values: readonly number[]): number {
  const n = values.length
  if (n < 3) return 0
  let mean = 0
  for (const v of values) mean += v
  mean /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - mean
    den += d * d
    if (i + 1 < n) num += d * (values[i + 1] - mean)
  }
  if (den <= 0) return 0
  return num / den
}

/** 总体方差。 */
function populationVariance(values: readonly number[]): number {
  const n = values.length
  if (n === 0) return 0
  let mean = 0
  for (const v of values) mean += v
  mean /= n
  let acc = 0
  for (const v of values) acc += (v - mean) * (v - mean)
  return acc / n
}

/** OLS 斜率（y 对序号）。 */
function olsSlope(values: readonly number[]): number {
  const n = values.length
  if (n < 2) return 0
  let meanX = (n - 1) / 2
  let meanY = 0
  for (const v of values) meanY += v
  meanY /= n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (values[i] - meanY)
    den += (i - meanX) * (i - meanX)
  }
  if (den <= 0) return 0
  return num / den
}

/** clamp 到 [0,1]。 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 临界预警主入口。
 *
 * @param units 观测单元（任意顺序；内部按时间稳定排序后取近端滑窗）。
 * @param options 配置（见 EarlyWarningOptions）。
 */
export function detectEarlyWarning(
  units: readonly EarlyWarningUnit[],
  options: EarlyWarningOptions = {},
): EarlyWarningReport {
  const baselineWindow = Math.max(4, options.baselineUnits ?? 16)
  const minUnits = Math.max(8, options.minUnits ?? 40)
  const maxUnits = Math.max(16, options.maxUnits ?? 240)
  const minBaseline = Math.max(2, options.minBaselineUnits ?? 6)

  // 时间稳定排序 + 近端滑窗（与 drift 同一纪律：预警关心「现在」）。
  const ordered = [...units].sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const window = ordered.slice(-maxUnits)
  const count = window.length
  const now = count > 0 ? window[count - 1].at : 0

  // ---- 词表：df ≥ 2 的高频词（单现词无主题区分力，与轴线 30 同纪律）。
  const unitTerms = window.map((unit) => tokenize(unit.text))
  const dfMap = new Map<string, number>()
  for (const terms of unitTerms) {
    for (const term of new Set(terms)) dfMap.set(term, (dfMap.get(term) ?? 0) + 1)
  }
  const vocab = new Set<string>()
  for (const [term, df] of dfMap) {
    if (df >= 2) vocab.add(term)
  }
  const unitIds = unitTerms.map((terms) => terms.filter((t) => vocab.has(t)))

  // ---- 新奇度序列：单元分布 vs 前 W 单元基线分布的 JS 散度。
  // 滑动基线：窗口在序列上滚动（前 minBaseline 个单元不产出，进入统计后
  // 基线只含更早单元——新奇度永远「对着过去」量，无未来信息泄漏）。
  const novelty: number[] = []
  for (let t = minBaseline; t < count; t += 1) {
    const from = Math.max(0, t - baselineWindow)
    const baseCounts = new Map<string, number>()
    let baseTotal = 0
    for (let b = from; b < t; b += 1) {
      for (const term of unitIds[b]) {
        baseCounts.set(term, (baseCounts.get(term) ?? 0) + 1)
        baseTotal += 1
      }
    }
    if (baseTotal === 0) {
      novelty.push(0)
      continue
    }
    novelty.push(jsDivergence(unitIds[t], baseCounts, baseTotal))
  }

  const seriesLength = novelty.length
  if (seriesLength < minUnits) {
    return insufficientReport(now, count, seriesLength, '会话流不足，临界预警待启动')
  }

  // ---- 双半对比：基线半（前半）vs 近期半（后半）。
  const half = Math.floor(seriesLength / 2)
  const baseHalf = novelty.slice(0, half)
  const recentHalf = novelty.slice(half)
  const baselineStats: EarlyWarningHalfStats = {
    units: baseHalf.length,
    ar1: round4(lag1Autocorrelation(baseHalf)),
    variance: round6(populationVariance(baseHalf)),
  }
  const recentStats: EarlyWarningHalfStats = {
    units: recentHalf.length,
    ar1: round4(lag1Autocorrelation(recentHalf)),
    variance: round6(populationVariance(recentHalf)),
  }

  const ar1Delta = round4(recentStats.ar1 - baselineStats.ar1)
  const varianceRatio = round2(recentStats.variance / Math.max(baselineStats.variance, 1e-9))
  const slope = round6(olsSlope(recentHalf))

  if (baselineStats.variance <= 0 && recentStats.variance <= 0) {
    return insufficientReport(now, count, seriesLength, '新奇度序列无波动（注意力高度稳定），无预警意义')
  }

  // ---- 三证据融合。
  // 持续性：AR(1) 须先过绝对门槛（低 AR(1) 谈不上「慢化」），再看上升量。
  const persistence =
    recentStats.ar1 >= 0.35 ? clamp01((ar1Delta - 0.12) / 0.55) : 0
  // 发散性：方差比（基线零方差 → 比值发散，按满证据处理）。
  const divergence =
    baselineStats.variance <= 0 && recentStats.variance > 0
      ? 1
      : clamp01((varianceRatio - 1.6) / 2.4)
  // 漂移性：近期半相对爬升（斜率 × 半窗长 / 序列均值——尺度无关）。
  const seriesMean = novelty.reduce((a, b) => a + b, 0) / seriesLength
  const relativeRise = (slope * recentHalf.length) / Math.max(seriesMean, 1e-9)
  const driftEvidence = slope > 0 ? clamp01(relativeRise / 0.4) : 0

  const score = round2(0.45 * persistence + 0.3 * divergence + 0.25 * driftEvidence)
  // 多指标纪律（Scheffer 2009）：warning 要求分数达标且至少两类证据共现
  // （单指标满权最多 watch——任何单一先行指标都可能误报）。
  const evidenceCount =
    (persistence > 0.1 ? 1 : 0) + (divergence > 0.1 ? 1 : 0) + (driftEvidence > 0.1 ? 1 : 0)
  const level: EarlyWarningReport['level'] =
    score >= 0.55 && evidenceCount >= 2
      ? 'warning'
      : score >= 0.3
        ? 'watch'
        : 'calm'

  const returnRate = round4(1 - Math.min(1, Math.max(-1, recentStats.ar1)))

  return {
    now,
    unitCount: count,
    seriesLength,
    baseline: baselineStats,
    recent: recentStats,
    ar1Delta,
    varianceRatio,
    slope,
    returnRate,
    score,
    level,
    novelty: novelty.slice(-64).map((v) => round4(v)),
    summary: summarize(level, count, seriesLength, ar1Delta, varianceRatio, returnRate),
    advice:
      level === 'warning'
        ? '注意力盆地可能正在切换边缘：建议现在为当前主题生成交接摘要（模块 B「交接摘要」），把已建立的上下文存档——切换后再补写会丢失细节'
        : level === 'watch'
          ? '临界慢化信号初现：可考虑提前导出当前主题的关键对话，或在未来几天有意识地收尾未竟线索'
          : undefined,
  }
}

/** 单元词表内 token 与滑动基线分布的 JS 散度（bit，[0,1]）。 */
function jsDivergence(
  unitTerms: readonly string[],
  baseCounts: ReadonlyMap<string, number>,
  baseTotal: number,
): number {
  const unitCounts = new Map<string, number>()
  for (const term of unitTerms) unitCounts.set(term, (unitCounts.get(term) ?? 0) + 1)
  const unitTotal = unitTerms.length
  if (unitTotal === 0) return 0
  let js = 0
  for (const [term, uc] of unitCounts) {
    const pw = uc / unitTotal
    const qw = (baseCounts.get(term) ?? 0) / baseTotal
    const m = (pw + qw) / 2
    js += 0.5 * pw * Math.log2(pw / m)
  }
  for (const [term, bc] of baseCounts) {
    if (unitCounts.has(term)) continue
    const qw = bc / baseTotal
    js += 0.5 * qw // log2(qw / (qw/2)) = 1
  }
  return Math.min(1, Math.max(0, js))
}

/** 数据不足 / 无波动时的平凡报告。 */
function insufficientReport(
  now: number,
  unitCount: number,
  seriesLength: number,
  reason: string,
): EarlyWarningReport {
  return {
    now,
    unitCount,
    seriesLength,
    baseline: { units: 0, ar1: 0, variance: 0 },
    recent: { units: 0, ar1: 0, variance: 0 },
    ar1Delta: 0,
    varianceRatio: 1,
    slope: 0,
    returnRate: 1,
    score: 0,
    level: 'insufficient',
    novelty: [],
    summary: `${reason}（新奇度序列 ${seriesLength} 点，阈值 40）`,
  }
}

/** 预警报告人话摘要。 */
function summarize(
  level: EarlyWarningReport['level'],
  count: number,
  seriesLength: number,
  ar1Delta: number,
  varianceRatio: number,
  returnRate: number,
): string {
  const stats = `AR(1) 变化 ${ar1Delta >= 0 ? '+' : ''}${ar1Delta.toFixed(2)}，方差比 ${varianceRatio.toFixed(1)}×，回弹率 ${returnRate.toFixed(2)}`
  if (level === 'warning') {
    return `近 ${count} 场对话的新奇度呈临界慢化特征——${stats}：注意力切换的先行信号已经共现，建议尽快交接当前主题`
  }
  if (level === 'watch') {
    return `近 ${count} 场对话出现临界慢化迹象——${stats}：继续观察，留意主题切换征兆`
  }
  return `近 ${count} 场对话注意力稳定（${seriesLength} 点新奇度序列无慢化特征；${stats}）`
}

/** 保留 4 位小数。 */
function round4(value: number): number {
  return Number(value.toFixed(4))
}

/** 保留 6 位小数。 */
function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** 保留 2 位小数。 */
function round2(value: number): number {
  return Number(value.toFixed(2))
}
