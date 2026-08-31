/**
 * 查询建议引擎（轴线 14）：输入框的自动补全——「你的语料会告诉你该搜什么」。
 * 纯本地、纯统计，零 LLM、零网络。
 *
 * 设计动机：面对几百个历史会话，用户最大的痛点不是「搜不到」而是
 * 「不知道用什么词搜」。传统 autocomplete 依赖全局热门词表（与本机语料
 * 无关），本模块让建议完全从你自己的数据里长出来：
 *
 * - **前缀补全**（Latin 输入中）：输入「部署 d」→ 进行中前缀「d」在语料
 *   词表中按 df 找候选（docker、deploy…），你聊得越多的词越先出现；
 * - **点击画像加权**：曾导致点击的查询词（反馈画像聚合）获得额外权重
 *   ——你搜过并点开过的词，是最强的高价值信号；
 * - **共现续写**（任意输入）：已完成词元的最强共现词（「部署」→
 *   「docker」），把轴线 8 的共现学习前移到输入阶段；
 * - **中文友好**：CJK 无空格分界，字符级前缀建议无从谈起，自动切换为
 *   共现续写模式（输入「部署」→ 建议「部署 docker」）。
 *
 * 三路候选合并去重、封顶 5 条，按 (来源权重 × df × 画像频次) 降序。
 */
import { tokenize } from './tokenize.js'

/** 建议条数上限。 */
const MAX_SUGGESTIONS = 5

/** 前缀补全要求的最低词元文档频率（孤例词不值得建议）。 */
const PREFIX_MIN_DF = 2

/** 共现续写要求的最低共现文档数。 */
const COOCCURRENCE_MIN_DOCS = 2

/** 共现扫描的文档数上限。 */
const COOCCURRENCE_SCAN_CAP = 400

/** 词表前缀扫描上限（超大规模词表跳过前缀补全，优雅降级）。 */
const VOCABULARY_SCAN_CAP = 60_000

/** 建议来源（打分基础权重：你点过的 > 你聊过的 > 语料共现）。 */
export type SuggestionSource = 'profile' | 'prefix' | 'cooccurrence'

/** 单条查询建议。 */
export interface QuerySuggestion {
  /** 完整建议查询文本（可直接作为检索输入）。 */
  readonly text: string
  /** 建议补入的核心词。 */
  readonly term: string
  /** 建议来源。 */
  readonly source: SuggestionSource
  /** 建议强度（降序展示）。 */
  readonly score: number
}

/** 建议引擎的语料视图（与查询智能共用同一注入契约）。 */
export interface SuggestCorpusView {
  /** 语料文档总数。 */
  readonly docCount: number
  /** 词元 → 文档频率（全量词表）。 */
  readonly termDf: ReadonlyMap<string, number>
  /** 词元 → 包含它的文档迭代器（倒排表直达）。 */
  readonly docsWithTerm: (term: string) => Iterable<{ readonly termFreqs: Record<string, number> }>
}

/** 建议选项。 */
export interface SuggestOptions {
  /** 点击画像聚合词频（词 → 总点击次数；曾导致点击的查询词）。 */
  readonly profileTerms?: ReadonlyMap<string, number>
  /** 建议条数上限（缺省 5）。 */
  readonly limit?: number
}

/**
 * 查询建议主入口。
 * @param input 输入框当前内容（任意中英混合，可能含未完成的尾部词）。
 * @param corpus 语料视图。
 * @param options 点击画像词频与条数上限。
 * @returns 建议列表（强度降序；无合格建议时为空）。
 */
export function suggestQueries(
  input: string,
  corpus: SuggestCorpusView,
  options: SuggestOptions = {},
): QuerySuggestion[] {
  const limit = Math.max(1, Math.min(options.limit ?? MAX_SUGGESTIONS, MAX_SUGGESTIONS))
  const trimmed = input.trim()
  if (trimmed.length === 0 || corpus.termDf.size === 0) return []
  // 拆解输入：进行中前缀（Latin 尾部序列）+ 已完成词元。
  const pending = pendingPrefixOf(trimmed)
  const completed = tokenizeWithoutTail(trimmed, pending)
  if (completed.length === 0 && pending.length === 0) return []
  const seen = new Set(completed)
  const candidates = new Map<string, QuerySuggestion>()
  /** 候选合并：同词取高分，来源保留更强者。 */
  const offer = (term: string, source: SuggestionSource, score: number, base: string): void => {
    if (seen.has(term)) return
    const text = base.length > 0 ? `${base} ${term}` : term
    const prev = candidates.get(term)
    if (prev !== undefined && prev.score >= score) return
    candidates.set(term, { text, term, source, score })
  }
  const base = completed.join(' ')
  const profileTerms = options.profileTerms
  // 1) 前缀补全：语料词表 + 点击画像中的前缀匹配（Latin 输入中）。
  if (pending.length >= 1) {
    if (corpus.termDf.size <= VOCABULARY_SCAN_CAP) {
      for (const [term, df] of corpus.termDf) {
        if (df < PREFIX_MIN_DF) continue
        if (!term.startsWith(pending) || term.length <= pending.length) continue
        const profileCount = profileTerms?.get(term) ?? 0
        const source: SuggestionSource = profileCount > 0 ? 'profile' : 'prefix'
        // 打分：df 对数（量级压缩）× 画像点击次数（点过的大幅加权）。
        offer(term, source, Math.log(1 + df) * (1 + profileCount), base)
      }
    }
  }
  // 2) 共现续写：已完成词元的最强共现词（中文无前缀场景的主通道）。
  if (candidates.size < limit && completed.length > 0) {
    const seed = completed[completed.length - 1]
    for (const [term, score] of cooccurrenceScores(seed, corpus)) {
      if (candidates.size >= limit) break
      offer(term, 'cooccurrence', score, base)
    }
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * 提取输入尾部的进行中 Latin 前缀（字母/数字/`_`/`.`/`-` 连续序列）。
 * 「部署 doc」→「doc」；「部署。」→''（无尾部 Latin 序列）。
 */
function pendingPrefixOf(input: string): string {
  const matched = /[a-z0-9_.-]+$/.exec(input.toLowerCase())
  if (matched === null) return ''
  // 首尾的 `.`/`-` 修剪（与 tokenize 的 Latin 词修剪规则一致）。
  let start = 0
  let end = matched[0].length
  while (start < end && (matched[0][start] === '.' || matched[0][start] === '-')) start += 1
  while (end > start && (matched[0][end - 1] === '.' || matched[0][end - 1] === '-')) end -= 1
  return matched[0].slice(start, end)
}

/**
 * 词元化输入但剥离进行中前缀对应的尾部原文（避免半截词污染已完成词元）。
 */
function tokenizeWithoutTail(input: string, pending: string): string[] {
  if (pending.length === 0) return [...new Set(tokenize(input))]
  const index = input.toLowerCase().lastIndexOf(pending)
  if (index < 0) return [...new Set(tokenize(input))]
  const head = input.slice(0, index)
  return [...new Set(tokenize(head))]
}

/**
 * 种子词的共现词打分（共现文档数 × IDF，与轴线 8 的 salience 同构）。
 */
function cooccurrenceScores(
  seed: string,
  corpus: SuggestCorpusView,
): Array<[string, number]> {
  const df = corpus.termDf.get(seed) ?? 0
  if (df < COOCCURRENCE_MIN_DOCS) return []
  const coCounts = new Map<string, number>()
  let scanned = 0
  for (const doc of corpus.docsWithTerm(seed)) {
    if (scanned >= COOCCURRENCE_SCAN_CAP) break
    scanned += 1
    for (const other of Object.keys(doc.termFreqs)) {
      if (other === seed) continue
      coCounts.set(other, (coCounts.get(other) ?? 0) + 1)
    }
  }
  const scores: Array<[string, number]> = []
  for (const [other, coDocs] of coCounts) {
    if (coDocs < COOCCURRENCE_MIN_DOCS) continue
    const otherDf = corpus.termDf.get(other) ?? 1
    const idf = Math.log(1 + corpus.docCount / otherDf)
    scores.push([other, coDocs * idf])
  }
  scores.sort((a, b) => b[1] - a[1])
  return scores
}
