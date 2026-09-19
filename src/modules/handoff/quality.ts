/**
 * 交接摘要质量评分（上下文工程质检）：本地可解释的摘要体检报告。
 *
 * 设计动机：模块 B 把整场对话压进 ≤500 字的四段式摘要，但压缩是有损
 * 的——用户拿到摘要时没有任何信号回答"这份摘要**丢了什么**"。质量
 * 评分引擎在摘要生成后做一次纯本地体检，四个维度全部可解释：
 *
 * - **词元覆盖**（权重 50%）：源转录按词频 × 长度取头部显著词
 *   （停用词与过短词天然被低频/长度过滤），摘要覆盖了其中多少——
 *   `missingTerms` 直接列出漏掉的头部词（"该带走的背景没带走"）；
 * - **结构完整**（20%）：四段式契约标题（核心结论 / 已解决 / 背景 /
 *   待办）逐项在场——缺段 = 下一段对话缺那类上下文；
 * - **长度纪律**（15%）：≤ 预算（缺省 500 字）满分；每超 10% 扣一分
 *   （超长摘要塞回新对话本身就是上下文压力）；
 * - **压缩充分**（15%）：压缩比（源/摘）≥ 3× 满分——交接摘要的
 *   存在意义就是压缩；接近 1:1 说明"摘要"只是复述。
 *
 * verdict 三档：strong（≥80）/ fair（60–79）/ weak（<60）。
 * 纯函数、无状态、零 LLM——评分针对文本本身，与生成模型无关
 * （换模型、换模板、改 Prompt 后同一把尺子可横向比较）。
 */

import { tokenize } from '../../core/retrieval/tokenize.js'

/** 质量评分参数。 */
export interface HandoffQualityOptions {
  /** 摘要长度预算（字符）；缺省 500（与模块 B 契约一致）。 */
  readonly budgetChars?: number
  /** 头部显著词数量（覆盖率的评估口径）；缺省 15。 */
  readonly salientTerms?: number
}

/** 质量体检报告。 */
export interface HandoffQuality {
  /** 综合分（0–100）。 */
  readonly score: number
  /** 档位：strong（≥80）/ fair（60–79）/ weak（<60）。 */
  readonly verdict: 'strong' | 'fair' | 'weak'
  /** 词元覆盖率（0–1；源转录无显著词时为 1）。 */
  readonly termCoverage: number
  /** 摘要漏掉的头部显著词（按显著性降序）。 */
  readonly missingTerms: readonly string[]
  /** 四段式契约标题在场情况。 */
  readonly structure: Readonly<Record<SectionKey, boolean>>
  /** 摘要字符数与预算。 */
  readonly summaryChars: number
  readonly budgetChars: number
  /** 压缩比（源字符 / 摘要字符；摘要为空时为 0）。 */
  readonly compression: number
  /** 人话结论。 */
  readonly summary: string
}

/** 四段式契约的段键。 */
export type SectionKey = 'conclusion' | 'resolved' | 'context' | 'todo'

/** 契约标题候选（固定 Prompt 与模板的常见写法）。 */
const SECTION_MARKERS: Readonly<Record<SectionKey, readonly string[]>> = {
  conclusion: ['核心结论', '结论'],
  resolved: ['已解决', '已解决的问题', '解决'],
  context: ['关键背景', '背景'],
  todo: ['待办', '未解决'],
}

/** 长度纪律扣分斜率：每超预算 10% 扣 1 分（15 分维度内）。 */
const LENGTH_PENALTY_PER_10PCT = 1

/** 转录格式噪声词：角色标签等格式产物不是内容显著词，评分前剔除。 */
const STOP_TERMS = new Set(['用户', '助手', '系统', '工具', 'user', 'assistant', 'system', 'tool'])

/** 短源中立线（字符）：源不足此长度时压缩维度按满分计——没什么可压缩。 */
const COMPRESSION_NEUTRAL_SOURCE_CHARS = 1000

/**
 * 摘要质量体检主入口。
 * @param sourceText 源转录全文（formatTranscript 产物）。
 * @param summaryText 待检摘要。
 * @param options 评分参数。
 */
export function scoreHandoffQuality(
  sourceText: string,
  summaryText: string,
  options: HandoffQualityOptions = {},
): HandoffQuality {
  const budget = Math.max(50, options.budgetChars ?? 500)
  const salientCount = Math.max(5, options.salientTerms ?? 15)

  // ---- 词元覆盖：源转录头部显著词的在场率 ----
  const sourceFreq = new Map<string, number>()
  for (const term of tokenize(sourceText)) {
    if (STOP_TERMS.has(term)) continue
    sourceFreq.set(term, (sourceFreq.get(term) ?? 0) + 1)
  }
  const summaryTerms = new Set(tokenize(summaryText))
  const salient = [...sourceFreq.entries()]
    // 显著性 = 频次 × 长度加成（≥2 字词 ×2、≥3 字 ×3）——短功能词天然沉底；
    // 短词（≤2 字）额外要求频次 ≥2（单次出现的双字组合多为虚词）。
    .filter(([term, freq]) => term.length > 2 || freq >= 2)
    .map(([term, freq]) => ({ term, weight: freq * salienceMultiplier(term) }))
    .sort((a, b) => b.weight - a.weight || (a.term < b.term ? -1 : 1))
    .slice(0, salientCount)
  const missing = salient.filter((entry) => !summaryTerms.has(entry.term))
  const termCoverage = salient.length === 0 ? 1 : (salient.length - missing.length) / salient.length

  // ---- 结构完整：四段式标题逐项在场 ----
  const structure = {} as Record<SectionKey, boolean>
  let structureHits = 0
  for (const [key, markers] of Object.entries(SECTION_MARKERS) as Array<[SectionKey, readonly string[]]>) {
    const present = markers.some((marker) => summaryText.includes(marker))
    structure[key] = present
    if (present) structureHits += 1
  }

  // ---- 长度纪律与压缩充分 ----
  const summaryChars = summaryText.length
  const sourceChars = sourceText.length
  const compression = summaryChars === 0 ? 0 : sourceChars / summaryChars
  const overRatio = summaryChars > budget ? summaryChars / budget - 1 : 0
  const lengthScore = Math.max(0, 15 - overRatio * 10 * LENGTH_PENALTY_PER_10PCT)
  // 短源没有压缩义务（千字以内的对话摘要等长是正常的）——中立满分。
  const compressionScore =
    sourceChars < COMPRESSION_NEUTRAL_SOURCE_CHARS
      ? 15
      : compression >= 3
        ? 15
        : compression <= 1
          ? 0
          : ((compression - 1) / 2) * 15

  const score = Math.round(
    termCoverage * 50 + (structureHits / 4) * 20 + lengthScore + compressionScore,
  )
  const verdict: HandoffQuality['verdict'] = score >= 80 ? 'strong' : score >= 60 ? 'fair' : 'weak'

  return {
    score,
    verdict,
    termCoverage: Number(termCoverage.toFixed(4)),
    missingTerms: missing.map((entry) => entry.term),
    structure,
    summaryChars,
    budgetChars: budget,
    compression: Number(compression.toFixed(2)),
    summary: summarizeQuality(verdict, score, termCoverage, missing.map((m) => m.term), structureHits),
  }
}

/** 词元长度加成：长词更可能是领域显著词。 */
function salienceMultiplier(term: string): number {
  if (term.length >= 3) return 3
  if (term.length === 2) return 2
  return 1
}

/** 质量报告人话摘要。 */
function summarizeQuality(
  verdict: HandoffQuality['verdict'],
  score: number,
  coverage: number,
  missing: readonly string[],
  structureHits: number,
): string {
  const head = `摘要体检 ${score} 分（${verdict}）`
  const parts: string[] = []
  if (coverage < 0.8) {
    parts.push(`头部显著词覆盖率 ${Math.round(coverage * 100)}%`)
  }
  if (missing.length > 0) {
    parts.push(`漏掉：${missing.slice(0, 5).join('、')}`)
  }
  if (structureHits < 4) {
    parts.push(`四段式缺 ${4 - structureHits} 段`)
  }
  if (parts.length === 0) return `${head}——覆盖、结构、长度、压缩全部达标，可放心交接`
  return `${head}：${parts.join('；')}`
}
