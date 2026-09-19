/**
 * 主题漂移检测引擎（轴线 30）：贝叶斯在线变点检测（BOCPD）。
 *
 * 设计动机：前 29 条轴线把历史当作「平铺的语料」——检索按相似度取回、
 * 知识按实体聚合，但没有一个组件回答「你的注意力**何时**从 A 主题
 * 切换到了 B 主题」。时间结构是认知的一等信息：主题段是工作记忆的
 * 「情节单元」，段边界是天然的交接点、回顾锚点、也是复习日程的
 * 自然分组。
 *
 * 本引擎把对话流建模为隐马尔可夫变点过程（Adams & MacKay 2007 的
 * 生成式精确形式）：
 *
 * - **状态**：运行长度 r_t = 当前主题段内、x_t 之前的观测单元数；
 * - **发射**：一元语言模型（Dirichlet 平滑的 unigram LM）——
 *   π_t(r) = P(x_t | 段内前 r 个单元)，词表限定为窗口内 df ≥ 2 的
 *   高频词（重复出现的词才有主题区分力，单现词是噪声）；
 * - **转移**：恒定危险率 h = 1/λ（λ = 期望段长），段内生长
 *   r → r+1 概率 1−h，变点 r → 0 概率 h；
 * - **推断**：
 *   1. 前向（α）：逐单元更新运行长度后验（归一化 log 域，数值稳定）；
 *   2. 后向（β）：log 域行归一化的反向信息向量；
 *   3. 平滑变点概率：P(变点@t | 全部数据) ∝ α_t(0)·β_t(0)——
 *      这是**回看**意义上的变点置信度，数据敏感（恒定危险率下
 *      纯前向边际 R_t(0)≡h，与数据无关，这是本实现选择精确
 *      生成式转移 + 前向后向的关键原因）；
 *   4. MAP 分段（Viterbi）：最大后验路径给出主题段切分。
 *
 * 复杂度 O(T²·|x|)（T = 窗口单元数）：相邻段历史计数用逐 r 增量
 * 维护，无 T×V 前缀矩阵；300 单元窗口在毫秒级完成。
 *
 * 产出：变点列表（置信度 + 前后段关键词 + JS 散度跳变强度）、
 * 主题段（时间范围 + 提升度关键词）、当前段长度、最近单元的
 * 「意外度」（当前主题下每词元的交叉熵，bit/token）。
 */

import { tokenize } from '../retrieval/tokenize.js'

/** 漂移检测的观测单元：一条消息、或一个会话的摘要文本。 */
export interface DriftUnit {
  /** 单元 id（会话 id、消息 id 或任意稳定标识）。 */
  readonly id: string
  /** 时间戳（毫秒）。 */
  readonly at: number
  /** 文本（标题 / 首若干条消息拼接 / 实体串联——调用方决定粒度）。 */
  readonly text: string
}

/** 漂移检测配置。 */
export interface DriftOptions {
  /** 期望段长（单元数）——危险率 λ⁻¹ 的先验；缺省 24。 */
  readonly hazardLambda?: number
  /** Dirichlet 平滑系数；缺省 0.1。 */
  readonly alpha?: number
  /** 滑窗单元上限；缺省 300（时间近端优先）。 */
  readonly maxUnits?: number
  /** 入词表的最小文档频（df）；缺省 2。 */
  readonly minDf?: number
  /** 词表容量上限（按 tf 取头部）；缺省 2048。 */
  readonly maxVocab?: number
  /** 每段/每变点展示的关键词数；缺省 5。 */
  readonly topTerms?: number
  /** 变点采纳阈值（平滑概率低于此值的 MAP 切分并入前段）；缺省 0.5。 */
  readonly changepointThreshold?: number
}

/** 一次检测到的主题切换。 */
export interface DriftChangepoint {
  /** 变点单元下标（该单元是新主题段的第一个单元）。 */
  readonly index: number
  /** 变点单元 id。 */
  readonly id: string
  /** 变点时间戳。 */
  readonly at: number
  /** 平滑变点概率 P(变点@t | 全部数据)。 */
  readonly probability: number
  /** 前后段一元分布的 JS 散度（bit，0..1）——切换强度。 */
  readonly jump: number
  /** 前一段特征词（提升度排序）。 */
  readonly beforeTerms: readonly string[]
  /** 后一段特征词。 */
  readonly afterTerms: readonly string[]
}

/** 一个主题段（两个变点之间的连续单元）。 */
export interface DriftSegment {
  /** 起止单元下标（含端点）。 */
  readonly startIndex: number
  readonly endIndex: number
  /** 起止时间戳。 */
  readonly startAt: number
  readonly endAt: number
  /** 段内单元数。 */
  readonly units: number
  /** 段内词表内 token 总数。 */
  readonly tokenCount: number
  /** 特征词（段内频次 × 窗口提升度）。 */
  readonly topTerms: readonly string[]
}

/** 主题漂移报告。 */
export interface DriftReport {
  /** 报告基准时间（最后单元时间戳）。 */
  readonly now: number
  /** 窗口内单元数。 */
  readonly unitCount: number
  /** 主题词表大小。 */
  readonly vocabSize: number
  /** MAP 分段得到的变点（时间序）。 */
  readonly changepoints: readonly DriftChangepoint[]
  /** 主题段（与变点一致切分；至少 1 段）。 */
  readonly segments: readonly DriftSegment[]
  /** 当前段已持续单元数。 */
  readonly currentRunLength: number
  /** 当前段特征词。 */
  readonly currentRunTopTerms: readonly string[]
  /** 最近单元在当前主题下的意外度（bit/token；高 = 偏离当前主题）。 */
  readonly lastUnitSurprise: number
  /** 终末运行长度后验均值（单元）。 */
  readonly meanRunLength: number
  /** 危险率（1/λ）。 */
  readonly hazard: number
  /** 人话摘要。 */
  readonly summary: string
}

/** logsumexp 二元。 */
function logPlus(a: number, b: number): number {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const hi = a > b ? a : b
  return hi + Math.log(Math.exp(a - hi) + Math.exp(b - hi))
}

/**
 * 主题漂移检测主入口。
 *
 * @param units 观测单元（任意顺序；内部按时间稳定排序后取近端滑窗）。
 * @param options 配置（见 DriftOptions）。
 */
export function detectTopicDrift(
  units: readonly DriftUnit[],
  options: DriftOptions = {},
): DriftReport {
  const hazardLambda = Math.max(2, options.hazardLambda ?? 24)
  const alpha = Math.max(0.01, options.alpha ?? 0.1)
  const maxUnits = Math.max(8, options.maxUnits ?? 300)
  const minDf = Math.max(2, options.minDf ?? 2)
  const maxVocab = Math.max(64, options.maxVocab ?? 2048)
  const topK = Math.max(1, options.topTerms ?? 5)
  const cpThreshold = Math.min(0.95, Math.max(0.05, options.changepointThreshold ?? 0.5))

  // 时间稳定排序 + 近端滑窗（近端优先：漂移关心的是「现在」）。
  const ordered = [...units].sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const window = ordered.slice(-maxUnits)
  const count = window.length
  const now = count > 0 ? window[count - 1].at : 0
  if (count < 2) return trivialReport(now, count)

  // ---- 词表：df ≥ minDf 的高频词，按 tf 截断 ----
  const unitTerms = window.map((unit) => tokenize(unit.text))
  const dfMap = new Map<string, number>()
  const tfMap = new Map<string, number>()
  for (const terms of unitTerms) {
    for (const term of new Set(terms)) dfMap.set(term, (dfMap.get(term) ?? 0) + 1)
    for (const term of terms) tfMap.set(term, (tfMap.get(term) ?? 0) + 1)
  }
  const candidates = [...dfMap.entries()]
    .filter(([, df]) => df >= minDf)
    .sort((a, b) => (tfMap.get(b[0]) ?? 0) - (tfMap.get(a[0]) ?? 0) || (a[0] < b[0] ? -1 : 1))
  if (candidates.length === 0) return trivialReport(now, count)
  const vocab = new Map<string, number>()
  const vocabTerms: string[] = []
  for (const [term] of candidates.slice(0, maxVocab)) {
    vocab.set(term, vocabTerms.length)
    vocabTerms.push(term)
  }
  const vocabSize = vocabTerms.length

  // 单元 → 词表内 token 序列（multiset 保留重复；OOV 剔除）。
  const unitIds: number[][] = unitTerms.map((terms) => {
    const ids: number[] = []
    for (const term of terms) {
      const id = vocab.get(term)
      if (id !== undefined) ids.push(id)
    }
    return ids
  })
  const tokenCounts = unitIds.map((ids) => ids.length)

  // ---- 发射概率：π_t(r) = log P(x_t | 段内前 r 个单元)，r ∈ 0..t ----
  // 增量维护：r → r+1 时把单元 (t−r) 并入历史（history(r) = x_{t−r..t−1}）。
  const stride = count + 1
  const logPi = new Float64Array(count * stride) // [t·stride + r]
  for (let t = 0; t < count; t += 1) {
    const base = t * stride
    const xt = unitIds[t]
    if (xt.length === 0) {
      for (let r = 0; r <= t; r += 1) logPi[base + r] = 0
      continue
    }
    const counts = new Map<number, number>()
    let total = 0
    for (let r = 0; r <= t; r += 1) {
      const logDenom = Math.log(total + alpha * vocabSize)
      let lp = 0
      for (const w of xt) {
        lp += Math.log((counts.get(w) ?? 0) + alpha) - logDenom
      }
      logPi[base + r] = lp
      const extend = unitIds[t - r]
      for (const w of extend) {
        counts.set(w, (counts.get(w) ?? 0) + 1)
        total += 1
      }
    }
  }

  const hazard = 1 / hazardLambda
  const logH = Math.log(hazard)
  const logStay = Math.log(1 - hazard)

  // ---- 前向 α：运行长度后验（log 域，逐步归一）----
  // 锚定初始化：窗口首单元必为新段起点（state (0,0) 概率 1）。
  const logAlphaPost = new Float64Array(count * stride).fill(-Infinity)
  const logR = new Float64Array(stride).fill(-Infinity)
  logR[0] = 0
  logAlphaPost[0] = 0
  const weights = new Float64Array(stride)

  // ---- Viterbi：MAP 分段（非归一 log 联合）----
  const score = new Float64Array(stride).fill(-Infinity)
  score[0] = 0
  const cpPrev = new Int32Array(count)

  for (let t = 1; t < count; t += 1) {
    const base = t * stride
    // 变点分支：进入 (t,0)，发射 π_t(0)，前驱为 t−1 时刻任意状态。
    const logCp = logPi[base] + logH
    weights[0] = logCp
    // 生长分支：进入 (t,k)，发射 π_t(k)，前驱 (t−1,k−1)。
    for (let k = 1; k <= t; k += 1) {
      weights[k] = logR[k - 1] + logPi[base + k] + logStay
    }
    // logsumexp 归一。
    let maxW = -Infinity
    for (let k = 0; k <= t; k += 1) {
      if (weights[k] > maxW) maxW = weights[k]
    }
    let sumExp = 0
    for (let k = 0; k <= t; k += 1) {
      sumExp += Math.exp(weights[k] - maxW)
    }
    const logZ = maxW + Math.log(sumExp)
    for (let k = t; k >= 1; k -= 1) logR[k] = weights[k] - logZ
    logR[0] = logCp - logZ
    const alphaBase = t * stride
    for (let k = 0; k <= t; k += 1) logAlphaPost[alphaBase + k] = logR[k]

    // Viterbi：变点前驱 = t−1 时刻 Viterbi 分最高的状态（发射项同值）。
    let bestScore = -Infinity
    let bestPrev = 0
    for (let r = 0; r < t; r += 1) {
      if (score[r] > bestScore) {
        bestScore = score[r]
        bestPrev = r
      }
    }
    cpPrev[t] = bestPrev
    for (let k = t; k >= 1; k -= 1) {
      score[k] = score[k - 1] + logPi[base + k] + logStay
    }
    score[0] = bestScore + logPi[base] + logH
  }

  // ---- 后向 β：P(x_{t+1..} | state (t,k))，log 域按行最大值归一 ----
  // （常数缩放在后验比值中消去，只防下溢。）
  const logBeta = new Float64Array(count * stride).fill(-Infinity)
  const lastBase = (count - 1) * stride
  for (let k = 0; k <= count - 1; k += 1) logBeta[lastBase + k] = 0
  for (let t = count - 2; t >= 0; t -= 1) {
    const nextBase = (t + 1) * stride
    const base = t * stride
    const logCpBranch = logPi[nextBase] + logH + logBeta[nextBase]
    let rowMax = -Infinity
    for (let k = 0; k <= t; k += 1) {
      const grow = logPi[nextBase + k + 1] + logStay + logBeta[nextBase + k + 1]
      const value = logPlus(grow, logCpBranch)
      logBeta[base + k] = value
      if (value > rowMax) rowMax = value
    }
    if (rowMax !== -Infinity && rowMax !== 0) {
      for (let k = 0; k <= t; k += 1) logBeta[base + k] -= rowMax
    }
  }

  // ---- 平滑变点概率：P(state (t,0) | 全部数据) ----
  const cpProb = new Float64Array(count)
  cpProb[0] = 1
  for (let t = 1; t < count; t += 1) {
    const base = t * stride
    let logNorm = -Infinity
    for (let k = 0; k <= t; k += 1) {
      logNorm = logPlus(logNorm, logAlphaPost[base + k] + logBeta[base + k])
    }
    if (logNorm === -Infinity) {
      cpProb[t] = 0
      continue
    }
    cpProb[t] = Math.exp(logAlphaPost[base] + logBeta[base] - logNorm)
  }

  // ---- MAP 分段回溯 ----
  let finalState = 0
  for (let k = 1; k <= count - 1; k += 1) {
    if (score[k] > score[finalState]) finalState = k
  }
  const cpIndices: number[] = []
  let state = finalState
  for (let t = count - 1; t >= 1; t -= 1) {
    if (state === 0) {
      cpIndices.push(t)
      state = cpPrev[t]
    } else {
      state -= 1
    }
  }
  cpIndices.reverse()
  // 置信度剪枝：平滑概率低于阈值的 MAP 切分并入前段——
  // Viterbi 对边界±1 敏感，剪枝后只保留数据强烈支持的切换。
  const adopted = cpIndices.filter((index) => cpProb[index] >= cpThreshold)

  // ---- 段统计 + 特征词 ----
  const globalTf = new Float64Array(vocabSize)
  let globalTot = 0
  for (const ids of unitIds) {
    for (const w of ids) {
      globalTf[w] += 1
      globalTot += 1
    }
  }
  const bounds = [0, ...adopted, count]
  const segments: DriftSegment[] = []
  const segmentTf: Array<{ tf: Map<number, number>; total: number }> = []
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const a = bounds[i]
    const b = bounds[i + 1] - 1
    const tf = new Map<number, number>()
    let total = 0
    for (let t = a; t <= b; t += 1) {
      for (const w of unitIds[t]) {
        tf.set(w, (tf.get(w) ?? 0) + 1)
        total += 1
      }
    }
    segmentTf.push({ tf, total })
    segments.push({
      startIndex: a,
      endIndex: b,
      startAt: window[a].at,
      endAt: window[b].at,
      units: b - a + 1,
      tokenCount: total,
      topTerms: topTermsOf(tf, total, globalTf, globalTot, vocabTerms, topK),
    })
  }

  const changepoints: DriftChangepoint[] = adopted.map((index) => {
    const segIndex = bounds.indexOf(index) - 1
    const before = segmentTf[segIndex]
    const after = segmentTf[segIndex + 1]
    const jump =
      before !== undefined && after !== undefined && before.total > 0 && after.total > 0
        ? jsDivergence(before.tf, before.total, after.tf, after.total)
        : 0
    return {
      index,
      id: window[index].id,
      at: window[index].at,
      probability: Number(cpProb[index].toFixed(4)),
      jump: Number(jump.toFixed(4)),
      beforeTerms: segments[segIndex]?.topTerms ?? [],
      afterTerms: segments[segIndex + 1]?.topTerms ?? [],
    }
  })

  // ---- 终末统计 ----
  let meanRun = 0
  const finalBase = (count - 1) * stride
  for (let k = 0; k <= count - 1; k += 1) {
    meanRun += k * Math.exp(logAlphaPost[finalBase + k])
  }
  const lastSeg = segments[segments.length - 1]
  const lastSurprise =
    tokenCounts[count - 1] > 0
      ? (-logPi[(count - 1) * stride + finalState] / Math.LN2) / tokenCounts[count - 1]
      : 0

  return {
    now,
    unitCount: count,
    vocabSize,
    changepoints,
    segments,
    currentRunLength: lastSeg?.units ?? count,
    currentRunTopTerms: lastSeg?.topTerms ?? [],
    lastUnitSurprise: Number(lastSurprise.toFixed(2)),
    meanRunLength: Number(meanRun.toFixed(1)),
    hazard: Number(hazard.toFixed(4)),
    summary: summarizeDrift(count, changepoints.length, lastSeg, lastSurprise),
  }
}

/** 段特征词：段内频次 × log 提升度（lift ≤ 1 记 0——全语料通用词无主题性）。 */
function topTermsOf(
  tf: ReadonlyMap<number, number>,
  total: number,
  globalTf: Float64Array,
  globalTot: number,
  vocabTerms: readonly string[],
  topK: number,
): string[] {
  if (total === 0 || globalTot === 0) return []
  const scored: Array<{ term: string; score: number }> = []
  for (const [w, c] of tf) {
    const lift = c / Math.max(0.25, (globalTf[w] / globalTot) * total)
    if (lift <= 1) continue
    scored.push({ term: vocabTerms[w], score: c * Math.log2(lift) })
  }
  scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
  return scored.slice(0, topK).map((s) => s.term)
}

/** 相邻段一元分布的 JS 散度（bit，[0,1]）。 */
function jsDivergence(
  p: ReadonlyMap<number, number>,
  pTot: number,
  q: ReadonlyMap<number, number>,
  qTot: number,
): number {
  let js = 0
  for (const [w, pc] of p) {
    const pw = pc / pTot
    const qw = (q.get(w) ?? 0) / qTot
    const m = (pw + qw) / 2
    js += 0.5 * pw * Math.log2(pw / m)
  }
  for (const [w, qc] of q) {
    if ((p.get(w) ?? 0) > 0) continue
    const qw = qc / qTot
    js += 0.5 * qw // log2(qw / (qw/2)) = 1
  }
  return js
}

/** 数据不足时的平凡报告。 */
function trivialReport(now: number, count: number): DriftReport {
  return {
    now,
    unitCount: count,
    vocabSize: 0,
    changepoints: [],
    segments: [],
    currentRunLength: count,
    currentRunTopTerms: [],
    lastUnitSurprise: 0,
    meanRunLength: count,
    hazard: 0,
    summary:
      count < 2
        ? '对话单元不足 2 个，主题漂移检测待启动'
        : '窗口内没有重复出现的词汇，无法建立主题模型——积累更多对话后自动启用',
  }
}

/** 漂移报告人话摘要。 */
function summarizeDrift(
  count: number,
  cpCount: number,
  lastSeg: DriftSegment | undefined,
  lastSurprise: number,
): string {
  if (cpCount === 0) {
    const terms = lastSeg?.topTerms.slice(0, 3).join('、') ?? ''
    const termPart = terms.length > 0 ? `（当前关键词：${terms}）` : ''
    return `近 ${count} 个对话单元未检测到主题切换——注意力持续在同一主题${termPart}`
  }
  const surprisePart =
    lastSurprise > 8 ? `；最近一条内容偏离当前主题较远（${lastSurprise.toFixed(1)} bit/词元）` : ''
  return `近 ${count} 个对话单元检测到 ${cpCount} 次主题切换，当前主题段已持续 ${lastSeg?.units ?? 0} 个单元${surprisePart}`
}
