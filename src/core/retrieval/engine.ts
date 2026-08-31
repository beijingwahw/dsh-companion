/**
 * 本地混合检索引擎（轴线 1 核心 + 轴线 9 时序感知 + 性能优化）：
 * BM25 词法检索 + 字符 trigram 哈希向量语义近似 + RRF 倒数排名融合，
 * 可选新近度乘性加成。零外部依赖、零网络请求、纯本地计算，
 * 全部数据留在 companion 存储域（隐私红线：不上传任何第三方）。
 *
 * 三层结构与设计依据：
 * - **BM25 层**：精确词法匹配（tokenize 的词元命中），饱和词频 + 文档长度
 *   归一，是关键词检索的工业标准基线；
 * - **向量层**：字符 trigram 哈希到固定维度（signed hashing 缓解碰撞偏置），
 *   TF-IDF 加权后 L2 归一化做余弦相似度——捕捉"字符组成相似但用词不同"
 *   的近义表达（如中英混排、拼写变体），是无嵌入模型约束下的语义近似；
 * - **RRF 融合**：两路排名各取 top-K 后按 `Σ 1/(k + rank)` 合并——
 *   不依赖两路分数的可比性（BM25 分数无界、余弦有界），对单路失效鲁棒；
 * - **时序加成（轴线 9）**：融合后乘性新近度加成 `1 + boost × 2^(-年龄/半衰期)`，
 *   排名语义不变，仅在分数层面把同等相关性向近期轻推（缺省 +25% 封顶）。
 *
 * 索引为"文档统计"形态（词频 + trigram 频次 + 长度）；语料级统计
 * （termDf / gramDf / 总长度）与词元倒排表随 put/delete/load 增量维护——
 * 无过滤查询直读缓存（免全语料扫描），带过滤时按视图即时计算（IDF 与
 * 视图一致的精确语义），两条路径数值等价。索引落盘数据与维度/权重
 * 参数解耦，调参无需重建索引。
 */
import { charTrigrams, fnv1a32, tokenize } from './tokenize.js'

/** 哈希向量维度（2 的幂，位运算取模）。 */
const VECTOR_DIM = 512

/** BM25 参数：词频饱和度。 */
const BM25_K1 = 1.2

/** BM25 参数：文档长度归一强度。 */
const BM25_B = 0.75

/** RRF 融合常数（业界惯用 60：排名越靠前边际收益衰减越快）。 */
export const RRF_K = 60

/** 时序感知缺省半衰期（天）：30 天前的文档加成衰减一半。 */
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30

/** 时序感知缺省强度（0 = 关闭；0.25 = 最新文档最多加成 25%）。 */
const DEFAULT_RECENCY_BOOST = 0.25

/** 天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 单路排名进入融合的候选池规模（取 max(limit, 该值)）。 */
const CANDIDATE_POOL = 64

/** 索引文档的持久化形状（JSON 友好；存 companion 域 retrieval-index 表）。 */
export interface IndexedDoc {
  /** 会话 id（存储键）。 */
  sessionId: string
  /** 会话标题（索引时刻快照，用于展示）。 */
  title: string
  /** 会话创建/更新时间（索引时刻快照，用于时间过滤与展示）。 */
  createdAt: number
  updatedAt: number
  /** 词元 → 频次（tokenize 输出的稀疏统计）。 */
  termFreqs: Record<string, number>
  /** 词元总数（termFreqs 值之和，BM25 文档长度）。 */
  length: number
  /** 字符 trigram → 频次（哈希向量的原始稀疏输入）。 */
  grams: Record<string, number>
}

/** 混合检索单条命中。 */
export interface HybridHit {
  sessionId: string
  /** 时序加权后的融合分（两路排名倒数和 × 新近度加成；越大越相关）。 */
  score: number
  /** BM25 词法排名（1 起；未进词法候选池为 undefined）。 */
  lexicalRank?: number
  /** 向量语义排名（1 起；未进语义候选池为 undefined）。 */
  semanticRank?: number
}

/** 时序感知选项（轴线 9）：对融合分做新近度乘性加成。 */
export interface RecencyOptions {
  /** 当前时间基准（毫秒时间戳）。 */
  readonly now: number
  /** 半衰期（天）；缺省 30。 */
  readonly halfLifeDays?: number
  /** 加成强度（0 = 关闭）；缺省 0.25。 */
  readonly boost?: number
}

/**
 * 计算文档的时序加成（乘性增量，与 search 内部同式同参）：
 * 导出供命中解释器（轴线 15）做加成分解，避免常量两处维护。
 */
export function recencyBoostFor(doc: IndexedDoc, recency: RecencyOptions): number {
  const halfLifeDays = recency.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS
  const boost = recency.boost ?? DEFAULT_RECENCY_BOOST
  if (boost <= 0 || halfLifeDays <= 0) return 0
  const ageDays = Math.max(0, (recency.now - doc.updatedAt) / DAY_MS)
  return boost * Math.pow(2, -ageDays / halfLifeDays)
}

/** 语料级统计：全量增量缓存（无过滤查询）或过滤视图的即时计算。 */
interface CorpusStats {
  readonly docCount: number
  readonly avgLength: number
  readonly termDf: ReadonlyMap<string, number>
  readonly gramDf: ReadonlyMap<string, number>
}

/** 从损坏/旧格式记录恢复时的收窄辅助：静默丢弃非法记录。 */
export function sanitizeIndexedDoc(raw: unknown): IndexedDoc | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return undefined
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined
  const termFreqs: Record<string, number> = {}
  if (typeof record.termFreqs === 'object' && record.termFreqs !== null) {
    for (const [term, freq] of Object.entries(record.termFreqs as Record<string, unknown>)) {
      if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0) termFreqs[term] = freq
    }
  }
  const grams: Record<string, number> = {}
  if (typeof record.grams === 'object' && record.grams !== null) {
    for (const [gram, freq] of Object.entries(record.grams as Record<string, unknown>)) {
      if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0) grams[gram] = freq
    }
  }
  return {
    sessionId: record.sessionId,
    title: typeof record.title === 'string' ? record.title : '',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: record.updatedAt,
    termFreqs,
    length: typeof record.length === 'number' ? record.length : 0,
    grams,
  }
}

/** 把一篇会话转录文本构建为索引文档（统计形态；IDF 留待查询时算）。 */
export function buildIndexedDoc(
  meta: { sessionId: string; title: string; createdAt: number; updatedAt: number },
  text: string,
): IndexedDoc {
  const tokens = tokenize(`${meta.title}\n${text}`)
  const termFreqs: Record<string, number> = {}
  for (const token of tokens) termFreqs[token] = (termFreqs[token] ?? 0) + 1
  const grams: Record<string, number> = {}
  for (const [gram, freq] of charTrigrams(text)) grams[gram] = freq
  return { ...meta, termFreqs, length: tokens.length, grams }
}

/**
 * 混合检索索引：内存持有全量文档统计，查询时对「过滤后的文档视图」
 * 计算 BM25 与余弦两路排名并 RRF 融合。不做任何 IO——持久化由调用方
 * （模块层）负责。
 */
export class HybridRetrievalIndex {
  private readonly docs = new Map<string, IndexedDoc>()
  /** 全量词元文档频率（增量维护；无过滤查询的 BM25 IDF 直读缓存）。 */
  private readonly termDf = new Map<string, number>()
  /** 全量 trigram 文档频率（增量维护；语义通道 IDF 直读缓存）。 */
  private readonly gramDf = new Map<string, number>()
  /** 词元 → 会话 id 倒排表（增量维护；查询扩展共现扫描直达，免全量遍历）。 */
  private readonly postings = new Map<string, Set<string>>()
  /** 全量文档词元总数（增量维护；BM25 平均长度基准）。 */
  private totalLength = 0

  /** 当前已索引文档数。 */
  get size(): number {
    return this.docs.size
  }

  /** 全部文档（键值对数组；供持久化与调试）。 */
  entries(): [string, IndexedDoc][] {
    return [...this.docs.entries()]
  }

  /** 读取单个文档统计（存在时）。 */
  get(sessionId: string): IndexedDoc | undefined {
    return this.docs.get(sessionId)
  }

  /** 全量词表（词元 → 文档频率）只读视图：查询智能（轴线 8）消费。 */
  termDfSnapshot(): ReadonlyMap<string, number> {
    return this.termDf
  }

  /** 包含指定词元的文档迭代器（倒排表直达）：共现扩展消费。 */
  *docsWithTerm(term: string): Generator<IndexedDoc, void, undefined> {
    const ids = this.postings.get(term)
    if (ids === undefined) return
    for (const sessionId of ids) {
      const doc = this.docs.get(sessionId)
      if (doc !== undefined) yield doc
    }
  }

  /** 写入/覆盖一篇文档（同一会话重索引即覆盖；统计与倒排同步增减）。 */
  put(doc: IndexedDoc): void {
    const prev = this.docs.get(doc.sessionId)
    if (prev !== undefined) this.removeStats(prev)
    this.docs.set(doc.sessionId, doc)
    this.addStats(doc)
  }

  /** 删除一篇文档；不存在时静默（统计与倒排同步回滚）。 */
  delete(sessionId: string): void {
    const prev = this.docs.get(sessionId)
    if (prev === undefined) return
    this.removeStats(prev)
    this.docs.delete(sessionId)
  }

  /** 批量替换内存文档集（持久化恢复路径；统计与倒排全量重建）。 */
  load(docs: readonly IndexedDoc[]): void {
    this.docs.clear()
    this.termDf.clear()
    this.gramDf.clear()
    this.postings.clear()
    this.totalLength = 0
    for (const doc of docs) {
      this.docs.set(doc.sessionId, doc)
      this.addStats(doc)
    }
  }

  /** 累加一篇文档的全量统计与倒排项。 */
  private addStats(doc: IndexedDoc): void {
    this.totalLength += doc.length
    for (const term of Object.keys(doc.termFreqs)) {
      this.termDf.set(term, (this.termDf.get(term) ?? 0) + 1)
      let ids = this.postings.get(term)
      if (ids === undefined) {
        ids = new Set<string>()
        this.postings.set(term, ids)
      }
      ids.add(doc.sessionId)
    }
    for (const gram of Object.keys(doc.grams)) {
      this.gramDf.set(gram, (this.gramDf.get(gram) ?? 0) + 1)
    }
  }

  /** 回滚一篇文档的全量统计与倒排项（覆盖/删除前调用）。 */
  private removeStats(doc: IndexedDoc): void {
    this.totalLength -= doc.length
    for (const term of Object.keys(doc.termFreqs)) {
      const df = this.termDf.get(term) ?? 0
      if (df <= 1) this.termDf.delete(term)
      else this.termDf.set(term, df - 1)
      const ids = this.postings.get(term)
      if (ids !== undefined) {
        ids.delete(doc.sessionId)
        if (ids.size === 0) this.postings.delete(term)
      }
    }
    for (const gram of Object.keys(doc.grams)) {
      const df = this.gramDf.get(gram) ?? 0
      if (df <= 1) this.gramDf.delete(gram)
      else this.gramDf.set(gram, df - 1)
    }
  }

  /** 无过滤查询的全量统计（增量维护，查询时零扫描）。 */
  private globalStats(): CorpusStats {
    return {
      docCount: this.docs.size,
      avgLength: this.docs.size > 0 ? this.totalLength / this.docs.size : 0,
      termDf: this.termDf,
      gramDf: this.gramDf,
    }
  }

  /** 过滤视图的即时统计（时间过滤路径少见，保持精确语义）。 */
  private viewStatsOf(visible: Map<string, IndexedDoc>): CorpusStats {
    let totalLength = 0
    const termDf = new Map<string, number>()
    const gramDf = new Map<string, number>()
    for (const doc of visible.values()) {
      totalLength += doc.length
      for (const term of Object.keys(doc.termFreqs)) {
        termDf.set(term, (termDf.get(term) ?? 0) + 1)
      }
      for (const gram of Object.keys(doc.grams)) {
        gramDf.set(gram, (gramDf.get(gram) ?? 0) + 1)
      }
    }
    return {
      docCount: visible.size,
      avgLength: visible.size > 0 ? totalLength / visible.size : 0,
      termDf,
      gramDf,
    }
  }

  /**
   * 混合检索：两路排名各取 top-K（候选池）→ RRF 融合 → 可选时序加成 →
   * 按最终分降序。
   *
   * 性能设计：无过滤查询直读增量维护的全量统计（termDf/gramDf/平均长度），
   * 免去每次查询的全语料扫描；带过滤时对视图即时计算（保持 IDF 与视图
   * 一致的精确语义）。两条路径数值完全等价。
   *
   * @param queryText 查询文本（任意中英混合，可含扩展词）。
   * @param limit 返回条数上限。
   * @param filter 可选的文档预过滤（时间范围等，模块层语义）。
   * @param recency 可选的时序感知选项（轴线 9）：融合分乘性新近度加成。
   */
  search(
    queryText: string,
    limit: number,
    filter?: (doc: IndexedDoc) => boolean,
    recency?: RecencyOptions,
  ): HybridHit[] {
    const trimmed = queryText.trim()
    if (trimmed.length === 0 || this.docs.size === 0) return []
    // 过滤视图：两路排名只对通过预过滤的文档计分，IDF 也只统计视图内
    // 文档（否则被过滤文档会污染词元稀有度与长度基准，排名失真）。
    let visible: Map<string, IndexedDoc> | undefined
    if (filter !== undefined) {
      visible = new Map<string, IndexedDoc>()
      for (const doc of this.docs.values()) {
        if (filter(doc)) visible.set(doc.sessionId, doc)
      }
      if (visible.size === 0) return []
    }
    const stats = visible !== undefined ? this.viewStatsOf(visible) : this.globalStats()
    const corpus: Iterable<IndexedDoc> = visible !== undefined ? visible.values() : this.docs.values()
    const pool = Math.max(limit, CANDIDATE_POOL)
    const lexical = this.lexicalRankingOf(trimmed, corpus, stats)
    const semantic = this.semanticRankingOf(trimmed, corpus, stats)
    // RRF 融合：rank 从 1 起；单路未入池的文档只累计另一路贡献。
    interface FusedEntry {
      score: number
      lexicalRank?: number
      semanticRank?: number
    }
    const fused = new Map<string, FusedEntry>()
    const addRanking = (
      ranking: Map<string, number>,
      key: 'lexicalRank' | 'semanticRank',
    ): void => {
      const ordered = [...ranking.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, pool)
      ordered.forEach(([sessionId], index) => {
        const rank = index + 1
        const entry = fused.get(sessionId) ?? { score: 0 }
        entry.score += 1 / (RRF_K + rank)
        entry[key] = rank
        fused.set(sessionId, entry)
      })
    }
    addRanking(lexical, 'lexicalRank')
    addRanking(semantic, 'semanticRank')
    const hits = [...fused.entries()].map(([sessionId, entry]) => ({
      sessionId,
      score: entry.score,
      lexicalRank: entry.lexicalRank,
      semanticRank: entry.semanticRank,
    }))
    // 时序感知（轴线 9）：乘性新近度加成 `1 + boost × 2^(-年龄/半衰期)`。
    // 融合排名不变（RRF 语义保持），仅在分数层面把同等相关性向近期轻推；
    // 缺省 boost 0.25——最新文档最多 +25%，相关性仍占主导。
    if (recency !== undefined) {
      const halfLifeDays = recency.halfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS
      const boost = recency.boost ?? DEFAULT_RECENCY_BOOST
      if (boost > 0 && halfLifeDays > 0) {
        for (const hit of hits) {
          const doc = this.docs.get(hit.sessionId)
          if (doc === undefined) continue
          hit.score *= 1 + recencyBoostFor(doc, recency)
        }
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * BM25 词法排名（语料统计由调用方注入：全量缓存或过滤视图）：
   * IDF 采用标准式 `ln(1 + (N - df + 0.5) / (df + 0.5))`；查询词不在
   * 语料中（df=0）时该词在任何文档 tf=0，实际不产生得分（无需特判）。
   */
  private lexicalRankingOf(
    queryText: string,
    corpus: Iterable<IndexedDoc>,
    stats: CorpusStats,
  ): Map<string, number> {
    const docCount = stats.docCount
    const scores = new Map<string, number>()
    const terms = [...new Set(tokenize(queryText))]
    if (terms.length === 0) return scores
    for (const doc of corpus) {
      let score = 0
      for (const term of terms) {
        const tf = doc.termFreqs[term]
        if (tf === undefined || tf <= 0) continue
        const df = stats.termDf.get(term) ?? 0
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
        const lengthNorm = stats.avgLength > 0 ? doc.length / stats.avgLength : 1
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * lengthNorm)))
      }
      if (score > 0) scores.set(doc.sessionId, score)
    }
    return scores
  }

  /**
   * 向量语义排名（语料统计由调用方注入）：查询与文档都做
   * 「trigram → 哈希桶 → TF-IDF → L2 归一」，余弦即归一化点积。
   * signed hashing（哈希值第 16 位取符号）让碰撞近似成对抵消，
   * 缓解固定维度下的偏置聚集。
   */
  private semanticRankingOf(
    queryText: string,
    corpus: Iterable<IndexedDoc>,
    stats: CorpusStats,
  ): Map<string, number> {
    const docCount = stats.docCount
    const gramIdf = (gram: string): number =>
      Math.log(1 + docCount / (1 + (stats.gramDf.get(gram) ?? 0)))
    const hashGram = (gram: string): { dim: number; sign: number } => {
      const hash = fnv1a32(gram)
      return { dim: hash & (VECTOR_DIM - 1), sign: (hash >>> 16) & 1 ? -1 : 1 }
    }
    const scores = new Map<string, number>()
    const queryVec = new Map<number, number>()
    for (const [gram, freq] of charTrigrams(queryText)) {
      const { dim, sign } = hashGram(gram)
      queryVec.set(dim, (queryVec.get(dim) ?? 0) + sign * freq * gramIdf(gram))
    }
    let queryNorm = 0
    for (const value of queryVec.values()) queryNorm += value * value
    queryNorm = Math.sqrt(queryNorm)
    if (queryNorm === 0) return scores
    for (const doc of corpus) {
      const docVec = new Map<number, number>()
      for (const [gram, freq] of Object.entries(doc.grams)) {
        const { dim, sign } = hashGram(gram)
        docVec.set(dim, (docVec.get(dim) ?? 0) + sign * freq * gramIdf(gram))
      }
      let docNorm = 0
      for (const value of docVec.values()) docNorm += value * value
      docNorm = Math.sqrt(docNorm)
      if (docNorm === 0) continue
      let dot = 0
      for (const [dim, value] of queryVec) {
        const other = docVec.get(dim)
        if (other !== undefined) dot += value * other
      }
      const cosine = dot / (queryNorm * docNorm)
      if (cosine > 0) scores.set(doc.sessionId, cosine)
    }
    return scores
  }
}

/**
 * 文档的哈希稀疏向量（signed hashing 到 512 维，TF 直读、不做 IDF 加权）：
 * 供文档间相似度计算（轴线 12 多样性重排、轴线 13 会话聚类）复用——
 * 与语义通道的查询-文档匹配不同，文档-文档的形状比较不需要查询侧
 * 稀有度加权，TF + L2 归一已是充分的形状签名。
 */
export function docGramVector(doc: IndexedDoc): Map<number, number> {
  const vector = new Map<number, number>()
  for (const [gram, freq] of Object.entries(doc.grams)) {
    const hash = fnv1a32(gram)
    const dim = hash & (VECTOR_DIM - 1)
    const sign = (hash >>> 16) & 1 ? -1 : 1
    vector.set(dim, (vector.get(dim) ?? 0) + sign * freq)
  }
  return vector
}

/**
 * 任意文本的哈希稀疏向量（与 docGramVector 同构：TF 直读 + signed hashing）：
 * 供命中解释器（轴线 15）计算查询与文档的形状相似度——同一构造保证
 * 余弦可比性。docGramVector(doc) ≡ textGramVector(建索引时的原文)。
 */
export function textGramVector(text: string): Map<number, number> {
  const vector = new Map<number, number>()
  for (const [gram, freq] of charTrigrams(text)) {
    const hash = fnv1a32(gram)
    const dim = hash & (VECTOR_DIM - 1)
    const sign = (hash >>> 16) & 1 ? -1 : 1
    vector.set(dim, (vector.get(dim) ?? 0) + sign * freq)
  }
  return vector
}

/** 两个稀疏向量的余弦相似度（[0, 1]；signed hashing 下可为负，钳到 0）。 */
export function sparseCosine(
  a: ReadonlyMap<number, number>,
  b: ReadonlyMap<number, number>,
): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const value of a.values()) normA += value * value
  for (const [dim, value] of b) {
    normB += value * value
    const other = a.get(dim)
    if (other !== undefined) dot += other * value
  }
  if (normA === 0 || normB === 0) return 0
  return Math.max(0, dot / Math.sqrt(normA * normB))
}

/**
 * 摘要片段生成：在原文中定位查询词元的最密集命中窗口。
 * 策略：滑窗（窗口宽 160 字符，步长 40）内统计查询词元命中数，
 * 取命中最多的窗口，前后以 `…` 标注截断；无命中回退原文头部。
 * @param text 会话转录原文。
 * @param queryText 查询文本。
 */
export function buildSnippet(text: string, queryText: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length === 0) return ''
  const terms = new Set(tokenize(queryText))
  if (terms.size === 0) return trimmed.slice(0, 160)
  const windowSize = 160
  const step = 40
  let bestStart = 0
  let bestHits = -1
  for (let start = 0; start < trimmed.length; start += step) {
    const window = trimmed.slice(start, start + windowSize)
    let hits = 0
    for (const term of terms) {
      if (window.includes(term)) hits += 1
    }
    if (hits > bestHits) {
      bestHits = hits
      bestStart = start
    }
    if (start + windowSize >= trimmed.length) break
  }
  const window = trimmed.slice(bestStart, bestStart + windowSize)
  const prefix = bestStart > 0 ? '…' : ''
  const suffix = bestStart + windowSize < trimmed.length ? '…' : ''
  return `${prefix}${window}${suffix}`
}
