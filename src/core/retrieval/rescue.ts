/**
 * 零命中救援（轴线 16）：检索失败时的自动放宽与重试。
 *
 * 设计动机：零命中是检索体验最痛的失败模式——用户面对「未找到相关对话」
 * 只能干瞪眼。但零命中往往不是「语料里真没有」，而是查询写法问题：
 *
 * - **拼写错误**：perfomance 之类笔误让词法通道整路失效（轴线 8 的
 *   纠错阈值 0.55 偏保守——正常检索里误纠的代价是污染查询，宁可漏）；
 * - **噪声词稀释**：长查询里混着语料中不存在的词（版本号、临时缩写），
 *   语义通道的形状匹配被无关 trigram 稀释，整体相似度跌破阈值。
 *
 * 救援在「已经零命中」的前提下工作——此时放宽阈值没有代价（最坏也
 * 就维持零命中），因此：
 *
 * - **宽阈值纠错**：trigram 余弦阈值从 0.55 降到 0.35，专救拼写灾难；
 * - **噪声剔除**：语料中不存在（df=0）且无可信纠错的词元直接剔除，
 *   让幸存的有效词元重新主导两路通道；
 * - **替换而非追加**：与轴线 8 的「只追加」相反——原查询已证明失败，
 *   纠错词直接替换原词，不让拼错的词继续占用形状空间。
 *
 * 救援结果明确标注（rescued），客户端提示「已自动放宽查询」，
 * 用户知情且可点击回退原始查询。
 */
import { charTrigrams, tokenize } from './tokenize.js'
import { trigramCosine } from './query.js'

/** 救援模式的纠错余弦阈值（比轴线 8 的 0.55 宽松；零命中下无误纠代价）。 */
const RESCUE_MIN_COSINE = 0.35

/** 救援纠错候选的最低文档频率。 */
const RESCUE_MIN_DF = 1

/** 救援词表扫描上限。 */
const VOCABULARY_SCAN_CAP = 60_000

/** 剔除噪声后要求的最少幸存词元（全灭则救援无意义）。 */
const MIN_SURVIVING_TERMS = 1

/** 救援动作类型。 */
export type RescueActionKind = 'correction' | 'removal'

/** 单条救援动作溯源。 */
export interface RescueAction {
  readonly kind: RescueActionKind
  /** 原查询词。 */
  readonly from: string
  /** 纠错后的替换词（removal 时缺省）。 */
  readonly to?: string
}

/** 查询放宽结果。 */
export interface RelaxedQuery {
  /** 放宽后的查询文本（纠错替换 + 噪声剔除后的幸存词序列）。 */
  readonly queryText: string
  /** 救援动作溯源（UI 可解释性）。 */
  readonly actions: readonly RescueAction[]
  /** 是否实际改写了查询（false = 无可放宽之处）。 */
  readonly applied: boolean
}

/**
 * 放宽一个零命中查询：宽阈值纠错 + 噪声词剔除。
 * 纯函数；语料统计由调用方注入。
 *
 * @param queryText 原始查询（已产生零命中的那个）。
 * @param termDf 语料词表（词元 → 文档频率）。
 * @returns 放宽结果；applied=false 表示原查询已无可放宽（语料真空）。
 */
export function relaxQuery(
  queryText: string,
  termDf: ReadonlyMap<string, number>,
): RelaxedQuery {
  const terms = [...new Set(tokenize(queryText))]
  if (terms.length === 0) return { queryText, actions: [], applied: false }
  const actions: RescueAction[] = []
  const survivors: string[] = []
  for (const term of terms) {
    // 语料中真实存在的词：直接幸存（它是有效信号，不动）。
    if ((termDf.get(term) ?? 0) > 0) {
      survivors.push(term)
      continue
    }
    // 语料外的词：宽阈值纠错（零命中下放宽阈值没有误纠代价）。
    const correction = rescueNearestTerm(term, termDf)
    if (correction !== undefined && !survivors.includes(correction)) {
      survivors.push(correction)
      actions.push({ kind: 'correction', from: term, to: correction })
    } else {
      // 纠不回来：噪声剔除（继续留着只会稀释语义形状）。
      actions.push({ kind: 'removal', from: term })
    }
  }
  if (actions.length === 0) return { queryText, actions: [], applied: false }
  if (survivors.length < MIN_SURVIVING_TERMS) {
    // 全部词元被判噪声且无可纠：返回原查询并标记未改写
    // （调用方据此外推「语料真空」结论，而非「查询写错」）。
    return { queryText, actions, applied: false }
  }
  return { queryText: survivors.join(' '), actions, applied: true }
}

/**
 * 宽阈值最近邻：与轴线 8 的 nearestVocabularyTerm 同构，
 * 阈值 0.35 / df ≥ 1 / 无最短长度限制（零命中下宁滥勿缺）。
 */
function rescueNearestTerm(
  term: string,
  termDf: ReadonlyMap<string, number>,
): string | undefined {
  if (termDf.size > VOCABULARY_SCAN_CAP) return undefined
  const queryGrams = charTrigrams(term)
  if (queryGrams.size === 0) return undefined
  let best: string | undefined
  let bestCosine = RESCUE_MIN_COSINE
  for (const [candidate, df] of termDf) {
    if (df < RESCUE_MIN_DF) continue
    const cosine = trigramCosine(queryGrams, charTrigrams(candidate))
    if (cosine > bestCosine) {
      bestCosine = cosine
      best = candidate
    }
  }
  return best
}
