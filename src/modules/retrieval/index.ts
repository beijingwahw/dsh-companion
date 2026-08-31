/**
 * 模块 E：本地语义检索（retrieval）插件——轴线 1/8/9/10/11/12/13/14/15/16 的宿主侧接线。
 *
 * 能力：纯本地混合检索（BM25 词法 + trigram 哈希向量语义近似 + RRF 融合），
 * 检索质量显著超越纯 FTS 关键词匹配，且零外部依赖、零隐私外泄。
 *
 * 组成：
 * - 惰性增量索引：每次检索前对账 `sessionQuery.listSessions()` 与已索引
 *   快照（updatedAt 漂移检测），仅重读变更会话；5 秒节流避免高频全量对账；
 * - 查询智能（轴线 8）：检索前对查询做拼写纠错 + 语料共现扩展
 *   （倒排表直达，扩展词只追加不替换，响应携带溯源注记）；
 * - 时序感知（轴线 9）：融合分乘性新近度加成（半衰期 30 天、强度 25%）；
 * - 质量诊断（轴线 10）：每次检索返回四级判定 + 通道覆盖率 + 可执行建议；
 * - 反馈学习（轴线 11）：点击结果即反馈——查询词并入该会话的点击画像，
 *   后续检索对画像命中查询词的会话做乘性加成（封顶 35%、90 天半衰），
 *   检索器随使用越来越懂「你最终打开的是什么」；
 * - 多样性重排（轴线 12）：MMR 贪心选择（λ=0.7），头部结果从「最优的
 *   重复」变成「最优且互补的组合」；
 * - 知识地图（轴线 13）：全部会话质心贪心聚类为主题簇，回答「我重复
 *   解决过哪些问题 / 知识分布在哪些主题」；
 * - 查询建议（轴线 14）：输入框自动补全——前缀补全（语料词表 × df）+
 *   共现续写 + 点击画像加权，「你的语料告诉你该搜什么」；
 * - 命中解释（轴线 15）：每条命中携带透明账本（词法命中词 × tf、语义
 *   形状相似度、新近/反馈加成分解）+ 一句话人话摘要；
 * - 零命中救援（轴线 16）：检索失败时自动放宽查询（宽阈值纠错 0.35 +
 *   噪声词剔除）重试，救援结果明确标注、可回溯；
 * - HTTP 端点：`GET /retrieval/search`（混合检索 + 扩展 + 诊断 + 反馈 +
 *   多样性 + 解释 + 救援）、`GET /retrieval/suggest`（查询建议）、
 *   `GET /retrieval/status`（索引状态）、`POST /retrieval/reindex`
 *   （全量重建）、`POST /retrieval/feedback`（点击反馈）、
 *   `GET /retrieval/clusters`（主题簇知识地图）；
 * - 命令 `find`：语义检索历史对话（与 HTTP 复用同一服务函数，
 *   输出附扩展溯源、救援说明、命中解释与质量摘要）；命令 `map`：知识地图速览。
 *
 * 索引持久化：companion 域 `retrieval-index` 表（键 = 会话 id，
 * 值 = 文档统计形状，见 core/retrieval/engine.js）；启动时恢复内存索引。
 * 反馈持久化：companion 域 `retrieval-feedback` 表（键 = 会话 id，
 * 值 = 点击画像，见 core/retrieval/feedback.js）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '../../core/storage-adapter.js'
import {
  buildIndexedDoc,
  buildSnippet,
  docGramVector,
  HybridRetrievalIndex,
  recencyBoostFor,
  sanitizeIndexedDoc,
  sparseCosine,
  textGramVector,
  type IndexedDoc,
} from '../../core/retrieval/engine.js'
import { expandQuery, type QueryExpansionNote } from '../../core/retrieval/query.js'
import {
  diagnoseRetrieval,
  VERDICT_LABELS,
  type RetrievalDiagnostics,
} from '../../core/retrieval/quality.js'
import {
  feedbackBoost,
  recordClick,
  sanitizeFeedbackProfile,
  type FeedbackProfile,
} from '../../core/retrieval/feedback.js'
import {
  DEFAULT_MMR_LAMBDA,
  diversityPoolSize,
  mmrSelect,
  MMR_MIN_POOL,
  type DiversityInfo,
} from '../../core/retrieval/diversity.js'
import { clusterSessions, type SessionCluster } from '../../core/retrieval/clusters.js'
import { suggestQueries, type QuerySuggestion } from '../../core/retrieval/suggest.js'
import { explainHit, type HitExplanation } from '../../core/retrieval/explain.js'
import { relaxQuery, type RescueAction } from '../../core/retrieval/rescue.js'
import {
  analyzeBlindSpots,
  sanitizeMissRecord,
  type BlindSpotReport,
  type MissRecord,
} from '../../core/retrieval/blindspots.js'
import {
  blindSpotInsights,
  composePulse,
  indexInsights,
  learningInsights,
  type PulseReport,
} from '../../core/insights/pulse.js'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js'
import { formatBeijingTime } from '../../core/time.js'
import type { CommandInvocation, CommandResult, SessionRecord } from '../../types/harness.js'

/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-retrieval'

/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 索引转录字符预算：超长会话保首尾截中段（对齐模块 B 的截断策略）。 */
const INDEX_TRANSCRIPT_BUDGET = 80_000

/** 截断时插入的中段提示行。 */
const INDEX_TRUNCATION_NOTICE = '\n\n【内容过长，索引仅覆盖首尾】\n\n'

/** 索引对账节流窗口（毫秒）：窗口内重复检索不重复全量 listSessions。 */
const SYNC_THROTTLE_MS = 5_000

/** 缺省最大返回条数。 */
const DEFAULT_LIMIT = 50

/** 最大返回条数上限。 */
const MAX_LIMIT = 200

/** 生成摘要片段的命中条数上限（超出部分不读会话原文，控制检索延迟）。 */
const SNIPPET_LIMIT = 12

/** 单条混合检索命中（HTTP 响应形状）。 */
interface RetrievalHit {
  session: SessionRecord
  /** 摘要片段（仅前 SNIPPET_LIMIT 条生成）。 */
  snippet?: string
  /** 时序加权后的融合分。 */
  score: number
  /** 词法排名（1 起；未入候选池为 undefined）。 */
  lexicalRank?: number
  /** 语义排名（1 起；未入候选池为 undefined）。 */
  semanticRank?: number
  /** 命中解释（轴线 15：透明账本 + 人话摘要）。 */
  explanation?: HitExplanation
}

/** 查询扩展信息（轴线 8 响应形状；无扩展时缺省）。 */
interface RetrievalExpansion {
  /** 追加进查询的扩展词。 */
  readonly terms: readonly string[]
  /** 溯源注记（哪个词经何种通道带入哪个扩展词）。 */
  readonly notes: readonly QueryExpansionNote[]
}

/** 零命中救援信息（轴线 16 响应形状；仅在触发救援时返回）。 */
interface RetrievalRescue {
  /** 救援后的实际查询文本。 */
  readonly queryText: string
  /** 救援动作溯源（纠错替换 / 噪声剔除）。 */
  readonly actions: readonly RescueAction[]
}

/** 反馈学习信息（轴线 11 响应形状；无任何加成时缺省）。 */
interface RetrievalFeedbackInfo {
  /** 获得加成的会话与加成幅度（乘性增量，如 0.12 = +12%）。 */
  readonly boosted: ReadonlyArray<{ readonly sessionId: string; readonly boost: number }>
}

/** 混合检索服务结果（HTTP 与命令共用）。 */
interface RetrievalSearchResult {
  hits: RetrievalHit[]
  /** 查询扩展（轴线 8；无扩展时缺省）。 */
  expansion?: RetrievalExpansion
  /** 质量诊断（轴线 10；始终返回）。 */
  diagnostics: RetrievalDiagnostics
  /** 反馈学习（轴线 11；无加成时缺省）。 */
  feedback?: RetrievalFeedbackInfo
  /** 多样性重排（轴线 12；始终返回 applied 标志）。 */
  diversity?: DiversityInfo
  /** 零命中救援（轴线 16；仅触发救援且有结果时缺省）。 */
  rescue?: RetrievalRescue
}

/** 索引对账结果。 */
interface SyncResult {
  indexed: number
  updated: number
  removed: number
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  const index = new HybridRetrievalIndex()
  /** 索引表（就绪后赋值；全部端点先 await 就绪再触碰）。 */
  let table: KvTable<IndexedDoc> | undefined
  /** 反馈画像表（轴线 11；就绪后赋值）。 */
  let feedbackTable: KvTable<FeedbackProfile> | undefined
  /** 会话 id → 点击画像（内存权威状态；写穿回 feedbackTable）。 */
  const profiles = new Map<string, FeedbackProfile>()
  /** 零命中查询表（轴线 19；就绪后赋值）。 */
  let missesTable: KvTable<MissRecord> | undefined
  /** 查询文本 → 零命中记录（内存权威状态；写穿回 missesTable）。 */
  const misses = new Map<string, MissRecord>()
  /** 最近一次对账完成时间（节流基准）。 */
  let lastSyncAt = 0
  /** 在途对账 promise（并发检索去重，只跑一次）。 */
  let syncInFlight: Promise<SyncResult> | undefined

  /** 打开索引表并恢复内存索引（启动一次；失败发通知不阻塞端点注册）。 */
  function openTable(domain: Domain): KvTable<IndexedDoc> {
    return domain.table<IndexedDoc>('retrieval-index')
  }

  void ctx.companion.ready
    .then(({ domain }) => {
      const t = openTable(domain)
      table = t
      const docs: IndexedDoc[] = []
      for (const [, raw] of t.entries()) {
        const doc = sanitizeIndexedDoc(raw)
        if (doc) docs.push(doc)
      }
      index.load(docs)
      // 轴线 11：恢复点击画像（损坏记录静默丢弃，不阻塞启动）。
      feedbackTable = domain.table<FeedbackProfile>('retrieval-feedback')
      for (const [sessionId, raw] of feedbackTable.entries()) {
        const profile = sanitizeFeedbackProfile(raw)
        if (profile) profiles.set(sessionId, profile)
      }
      // 轴线 19：恢复零命中查询日志（盲区分析的原料）。
      missesTable = domain.table<MissRecord>('retrieval-misses')
      for (const [, raw] of missesTable.entries()) {
        const record = sanitizeMissRecord(raw)
        if (record) misses.set(record.query, record)
      }
    })
    .catch(() => {
      // 存储域失败：核心服务已发 notice，这里仅避免未处理 rejection。
    })

  /** 按预算截断转录（保首尾 + 中段提示行）。 */
  function budgetTranscript(text: string): string {
    if (text.length <= INDEX_TRANSCRIPT_BUDGET) return text
    const keepTotal = INDEX_TRANSCRIPT_BUDGET - INDEX_TRUNCATION_NOTICE.length
    const headLength = Math.ceil(keepTotal / 2)
    const tailLength = keepTotal - headLength
    return (
      text.slice(0, headLength) + INDEX_TRUNCATION_NOTICE + text.slice(text.length - tailLength)
    )
  }

  /**
   * 索引对账（增量同步）：
   * - 已索引但已不存在的会话 → 删除索引；
   * - 新会话或 updatedAt 漂移的会话 → 重读转录并重建统计；
   * - 其余保持不变（append-only 日志下旧文档统计天然稳定）。
   * 节流：距上次成功对账不足 SYNC_THROTTLE_MS 时直接返回缓存统计
   * （force=true 时强制对账，供手动重建入口）。
   */
  async function syncIndex(force: boolean): Promise<SyncResult> {
    if (!force && Date.now() - lastSyncAt < SYNC_THROTTLE_MS && syncInFlight === undefined) {
      return { indexed: index.size, updated: 0, removed: 0 }
    }
    if (syncInFlight !== undefined) return syncInFlight
    syncInFlight = (async (): Promise<SyncResult> => {
      const sessions = await ctx.sessionQuery.listSessions()
      const live = new Map<string, SessionRecord>()
      for (const session of sessions) live.set(String(session.id), session)
      let updated = 0
      let removed = 0
      // 1) 清理已消失会话的索引。
      for (const [sessionId, doc] of index.entries()) {
        if (live.has(sessionId)) continue
        index.delete(sessionId)
        await table?.delete(sessionId)
        removed += 1
      }
      // 2) 重建缺失/漂移会话的统计（updatedAt 缺省回退 createdAt）。
      for (const [sessionId, session] of live) {
        const doc = index.get(sessionId)
        const version = session.updatedAt ?? session.createdAt
        if (doc && doc.updatedAt === version) continue
        let snapshot
        try {
          snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
        } catch {
          // 单会话读取失败：跳过（保留旧统计），不影响其余会话索引。
          continue
        }
        const text = budgetTranscript(
          formatTranscript(transcriptFromLog(snapshot), { timestamps: false }),
        )
        const next = buildIndexedDoc(
          {
            sessionId,
            title: session.title ?? '',
            createdAt: session.createdAt,
            updatedAt: version,
          },
          text,
        )
        index.put(next)
        await table?.put(sessionId, next)
        updated += 1
      }
      lastSyncAt = Date.now()
      return { indexed: index.size, updated, removed }
    })()
    try {
      return await syncInFlight
    } finally {
      syncInFlight = undefined
    }
  }

  /**
   * 混合检索服务函数（HTTP 与命令共用）：
   * 对账索引 → 查询智能扩展（轴线 8）→ 引擎混合排名 + 时序加成（轴线 9）
   * → 零命中救援（轴线 16：宽阈值纠错 + 噪声剔除后重试）→
   * 反馈学习加成（轴线 11）→ MMR 多样性重排（轴线 12）→
   * 质量诊断（轴线 10）→ 命中解释（轴线 15）→ 头部命中并行补摘要片段。
   *
   * 后处理顺序的设计依据：诊断只评引擎原始命中（反馈/多样性属后处理，
   * 不掺入质量指标）；反馈加成先于多样性（相关性基准含学习先验）；
   * MMR 最后执行（对最终呈现序负责）；解释基于原始查询词（透明性：
   * 用户看到的是「我搜的词如何命中」，不是引擎内部的扩展黑箱）。
   * @param params 查询词 + 可选时间范围与条数上限。
   */
  async function hybridSearch(params: {
    query: string
    from?: number
    to?: number
    limit?: number
  }): Promise<RetrievalSearchResult> {
    await ctx.companion.ready
    await syncIndex(false)
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const now = Date.now()
    const corpus = {
      docCount: index.size,
      termDf: index.termDfSnapshot(),
      docsWithTerm: (term: string) => index.docsWithTerm(term),
    }
    const dateFilter = (doc: IndexedDoc): boolean => {
      if (params.from !== undefined && doc.createdAt < params.from) return false
      if (params.to !== undefined && doc.createdAt > params.to) return false
      return true
    }
    /** 扩展 + 检索的单轮执行（首轮与救援轮共用）。 */
    const runSearch = (queryText: string) => {
      // 轴线 8：查询智能——拼写纠错 + 语料共现扩展（倒排表直达，纯本地）。
      const expanded = expandQuery(queryText, corpus)
      const hits = index.search(
        expanded.queryText,
        limit,
        dateFilter,
        // 轴线 9：时序感知（半衰期 30 天、强度 25% 用引擎缺省值）。
        { now },
      )
      return { expanded, hits }
    }
    let { expanded, hits } = runSearch(params.query)
    // 轴线 16：零命中救援——原查询失败后放宽重试（宽阈值纠错 + 噪声剔除）。
    let rescue: RetrievalRescue | undefined
    if (hits.length === 0 && index.size > 0) {
      const relaxed = relaxQuery(params.query, corpus.termDf)
      if (relaxed.applied) {
        const retry = runSearch(relaxed.queryText)
        if (retry.hits.length > 0) {
          expanded = retry.expanded
          hits = retry.hits
          rescue = { queryText: relaxed.queryText, actions: relaxed.actions }
        }
      }
    }
    // 轴线 19：零命中（含救援失败）→ 记入查询日志（盲区分析的原料）。
    // 救援成功的不算盲区——语料有覆盖，只是查询写法问题。
    if (hits.length === 0 && rescue === undefined && params.query.trim().length > 0) {
      recordMiss(params.query)
    }
    // 轴线 10：检索质量诊断（评引擎原始命中，先于后处理）。
    const diagnostics = diagnoseRetrieval(hits, index.size)
    // 轴线 11：反馈学习——画像命中查询词的会话获得乘性加成（封顶 35%）。
    // 同步记录每命中的加成分解（轴线 15 解释的原料：新近 + 反馈）。
    const boosted: Array<{ sessionId: string; boost: number }> = []
    const breakdowns = new Map<string, { recency: number; feedback: number }>()
    for (const hit of hits) {
      const doc = index.get(hit.sessionId)
      if (doc === undefined) continue
      const recency = recencyBoostFor(doc, { now })
      const feedback = feedbackBoost(profiles.get(hit.sessionId), params.query, now)
      breakdowns.set(hit.sessionId, { recency, feedback })
      if (feedback > 0.005) {
        hit.score *= 1 + feedback
        boosted.push({ sessionId: hit.sessionId, boost: Number(feedback.toFixed(4)) })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    // 轴线 12：MMR 多样性重排——头部从「最优的重复」变成「最优且互补」。
    const poolSize = diversityPoolSize(limit, hits.length)
    const pool = hits.slice(0, poolSize)
    let ordered = hits
    let diversity: DiversityInfo
    if (pool.length >= MMR_MIN_POOL) {
      const vectors = new Map<string, ReadonlyMap<number, number>>()
      for (const hit of pool) {
        const doc = index.get(hit.sessionId)
        if (doc !== undefined) vectors.set(hit.sessionId, docGramVector(doc))
      }
      ordered = mmrSelect(
        pool,
        (hit) => hit.score,
        (a, b) => {
          const va = vectors.get(a.sessionId)
          const vb = vectors.get(b.sessionId)
          if (va === undefined || vb === undefined) return 0
          return sparseCosine(va, vb)
        },
        limit,
      )
      diversity = { applied: true, pool: pool.length, lambda: DEFAULT_MMR_LAMBDA }
    } else {
      ordered = hits.slice(0, limit)
      diversity = { applied: false, pool: pool.length, lambda: DEFAULT_MMR_LAMBDA }
    }
    // 头部命中补摘要片段：并行读取原文定位最佳窗口（片段高亮仍按用户
    // 原始查询词，不掺扩展词）；失败静默降级为无片段。
    const detailed = ordered.slice(0, SNIPPET_LIMIT)
    const snippets = new Map<string, string>()
    await Promise.all(
      detailed.map(async (hit) => {
        try {
          const snapshot = await ctx.sessionQuery.readSession(SessionId(hit.sessionId))
          const text = formatTranscript(transcriptFromLog(snapshot), { timestamps: false })
          snippets.set(hit.sessionId, buildSnippet(text, params.query))
        } catch {
          // 读取失败：该条无片段，不阻塞整体结果。
        }
      }),
    )
    // 轴线 15：命中解释——每条命中拆解四成分（纯内存计算，无 I/O）。
    // 查询向量构建一次复用；解释基于用户原始查询词。
    const queryVector = textGramVector(params.query)
    // 会话头信息：优先引擎快照（title/createdAt/updatedAt）。
    const result: RetrievalHit[] = []
    for (const hit of ordered) {
      const doc = index.get(hit.sessionId)
      if (!doc) continue
      const breakdown = breakdowns.get(hit.sessionId)
      result.push({
        session: {
          id: SessionId(hit.sessionId),
          title: doc.title || undefined,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        },
        snippet: snippets.get(hit.sessionId),
        score: hit.score,
        lexicalRank: hit.lexicalRank,
        semanticRank: hit.semanticRank,
        explanation: explainHit(params.query, doc, breakdown ?? { recency: 0, feedback: 0 }, queryVector),
      })
    }
    return {
      hits: result,
      expansion:
        expanded.notes.length > 0
          ? { terms: [...expanded.extraTerms], notes: expanded.notes }
          : undefined,
      diagnostics,
      feedback: boosted.length > 0 ? { boosted } : undefined,
      diversity,
      rescue,
    }
  }

  /**
   * 查询建议服务函数（轴线 14）：输入框自动补全。
   * 候选来自语料词表（前缀补全）+ 共现学习（续写）+ 点击画像加权。
   */
  async function suggest(input: string): Promise<QuerySuggestion[]> {
    await ctx.companion.ready
    await syncIndex(false)
    // 点击画像聚合：词 → 全部会话的累计点击次数（高价值信号加权）。
    const profileTerms = new Map<string, number>()
    for (const profile of profiles.values()) {
      for (const [term, count] of Object.entries(profile.terms)) {
        profileTerms.set(term, (profileTerms.get(term) ?? 0) + count)
      }
    }
    return suggestQueries(
      input,
      {
        docCount: index.size,
        termDf: index.termDfSnapshot(),
        docsWithTerm: (term) => index.docsWithTerm(term),
      },
      { profileTerms },
    )
  }

  /**
   * 零命中记录（轴线 19）：查询文本 → 次数累计 + 首次/最近时间（写穿存储）。
   * 失败静默——日志缺失只影响盲区分析精度，不影响检索主流程。
   */
  function recordMiss(queryText: string): void {
    const query = queryText.trim().slice(0, 200)
    if (query.length === 0) return
    const now = Date.now()
    const prev = misses.get(query)
    const next: MissRecord = {
      query,
      count: (prev?.count ?? 0) + 1,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
    }
    misses.set(query, next)
    void missesTable?.put(query, next).catch(() => undefined)
  }

  /**
   * 盲区分析服务函数（轴线 19）：聚合零命中日志为知识盲区报告。
   */
  async function blindSpotAnalysis(): Promise<BlindSpotReport> {
    await ctx.companion.ready
    return analyzeBlindSpots([...misses.values()], { now: Date.now() })
  }

  /**
   * 主动脉搏服务函数（轴线 18）：聚合盲区/学习/索引三类信号为洞察卡片。
   * 信号提供者注入式架构——任何模块未来可注册自己的信号源。
   */
  async function pulse(): Promise<PulseReport> {
    await ctx.companion.ready
    await syncIndex(false)
    const blindSpotReport = await blindSpotAnalysis()
    let totalSessions = index.size
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      totalSessions = sessions.length
    } catch {
      // 列表失败：退化为索引自身计数。
    }
    let totalClicks = 0
    for (const profile of profiles.values()) totalClicks += profile.clicks
    return composePulse(
      [
        () => blindSpotInsights(blindSpotReport),
        () => learningInsights({ profiledSessions: profiles.size, totalClicks }),
        () =>
          indexInsights({
            indexedSessions: index.size,
            totalSessions,
            lastSyncAt: lastSyncAt > 0 ? lastSyncAt : null,
            now: Date.now(),
          }),
      ],
      Date.now(),
    )
  }

  /**
   * 记录点击反馈（轴线 11）：查询词并入该会话的点击画像（写穿持久化）。
   * @returns 更新后的累计点击次数。
   */
  async function recordFeedback(sessionId: string, queryText: string): Promise<number> {
    await ctx.companion.ready
    const next = recordClick(profiles.get(sessionId), queryText, Date.now())
    profiles.set(sessionId, next)
    // 写穿失败不回滚内存（下次点击会再写；画像可重建，非关键数据）。
    await feedbackTable?.put(sessionId, next).catch(() => undefined)
    return next.clicks
  }

  /**
   * 知识地图服务函数（轴线 13）：对全部已索引会话做主题聚类。
   * @param minSize 过滤簇的最小规模（1 = 全部簇；2 = 只看重复主题）。
   */
  async function knowledgeMap(minSize: number): Promise<{
    sessions: number
    clusters: SessionCluster[]
  }> {
    await ctx.companion.ready
    await syncIndex(false)
    const all = index.entries().map(([, doc]) => doc)
    const clusters = clusterSessions(all).filter((cluster) => cluster.size >= minSize)
    return { sessions: all.length, clusters }
  }

  // ------------------------------------------------------------------
  // HTTP 端点（注册即 effect）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/search', async (_req, res, { query }) => {
        const queryText = (query.get('query') ?? '').trim()
        if (queryText.length === 0) throw new HttpError('query 必填', 400)
        const from = parseTimeParam(query.get('from'), 'start')
        const to = parseTimeParam(query.get('to'), 'end')
        if (from !== undefined && to !== undefined && from > to) {
          throw new HttpError('from 不能晚于 to', 400)
        }
        const limitRaw = query.get('limit')
        let limit: number | undefined
        if (limitRaw !== null && limitRaw.length > 0) {
          const parsed = Number(limitRaw)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new HttpError('limit 必须是正整数', 400)
          }
          limit = parsed
        }
        sendJson(res, 200, await hybridSearch({ query: queryText, from, to, limit }))
      }),
    'companion.retrieval-http-search',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/suggest', async (_req, res, { query }) => {
        const input = (query.get('q') ?? '').trim()
        // 空输入也合法（返回空数组）；不做 400——输入框每键一请求。
        const suggestions = input.length === 0 ? [] : await suggest(input)
        sendJson(res, 200, { suggestions })
      }),
    'companion.retrieval-http-suggest',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/blindspots', async (_req, res) => {
        sendJson(res, 200, await blindSpotAnalysis())
      }),
    'companion.retrieval-http-blindspots',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/insights', async (_req, res) => {
        sendJson(res, 200, await pulse())
      }),
    'companion.retrieval-http-insights',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/status', async (_req, res) => {
        await ctx.companion.ready
        sendJson(res, 200, {
          indexed: index.size,
          lastSyncAt: lastSyncAt > 0 ? lastSyncAt : null,
        })
      }),
    'companion.retrieval-http-status',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/retrieval/reindex', async (_req, res) => {
        await ctx.companion.ready
        // 强制对账：清内存统计后全量重建（持久化表逐条覆盖）。
        const result = await syncIndex(true)
        sendJson(res, 200, { ok: true, ...result })
      }),
    'companion.retrieval-http-reindex',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/retrieval/feedback', async (_req, res, { body }) => {
        await ctx.companion.ready
        const record = readBodyObject(body)
        const queryText = requireBodyString(record.query, 'query')
        const sessionId = requireBodyString(record.sessionId, 'sessionId')
        // 会话必须在索引中（防脏数据写画像：索引对账已清理消失会话）。
        if (index.get(sessionId) === undefined) {
          throw new HttpError('sessionId 不在语义索引中（稍候对账或先执行检索）', 404)
        }
        const clicks = await recordFeedback(sessionId, queryText)
        sendJson(res, 200, { ok: true, clicks })
      }),
    'companion.retrieval-http-feedback',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/retrieval/clusters', async (_req, res, { query }) => {
        const minSizeRaw = query.get('minSize')
        let minSize = 1
        if (minSizeRaw !== null && minSizeRaw.length > 0) {
          const parsed = Number(minSizeRaw)
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new HttpError('minSize 必须是正整数', 400)
          }
          minSize = parsed
        }
        sendJson(res, 200, await knowledgeMap(minSize))
      }),
    'companion.retrieval-http-clusters',
  )

  // ------------------------------------------------------------------
  // 命令面板（与 HTTP 端点复用 hybridSearch 服务函数）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'find',
        description: '语义检索历史对话（混合排序 + 反馈学习，本地计算）',
        input: { hint: '<检索词>' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const queryText = (invocation.rawInput ?? '').trim()
          if (queryText.length === 0) return { kind: 'error', text: '请输入检索词' }
          try {
            const { hits, expansion, diagnostics, feedback, diversity, rescue } =
              await hybridSearch({ query: queryText })
            if (hits.length === 0) {
              const lines = [`未找到与“${queryText}”语义相关的对话`]
              for (const suggestion of diagnostics.suggestions) lines.push(`· ${suggestion}`)
              return { kind: 'success', text: lines.join('\n') }
            }
            const lines: string[] = [`语义检索到 ${hits.length} 个对话（混合排序）：`]
            if (rescue !== undefined) {
              const traced = rescue.actions
                .map((action) =>
                  action.kind === 'correction'
                    ? `${action.from}→${action.to}`
                    : `剔除“${action.from}”`,
                )
                .join('、')
              lines.push(`零命中救援: 已放宽为“${rescue.queryText}”（${traced}）`)
            }
            if (expansion !== undefined) {
              const traced = expansion.notes
                .map((note) => `${note.to}（${note.kind === 'correction' ? '纠错' : '共现'}）`)
                .join('、')
              lines.push(`查询扩展: ${traced}`)
            }
            if (feedback !== undefined) {
              const traced = feedback.boosted
                .map((entry) => `${entry.sessionId} +${Math.round(entry.boost * 100)}%`)
                .join('、')
              lines.push(`反馈学习: ${feedback.boosted.length} 个会话因历史点击获得加成（${traced}）`)
            }
            if (diversity !== undefined && diversity.applied) {
              lines.push(`多样性重排: 已启用（λ=${diversity.lambda}，候选池 ${diversity.pool}）`)
            }
            const strength = Math.round((diagnostics.topScore / diagnostics.maxScore) * 100)
            lines.push(
              `质量: 相关度 ${strength}%（${VERDICT_LABELS[diagnostics.verdict]}）· 词法覆盖 ${Math.round(diagnostics.lexicalCoverage * 100)}% · 语义覆盖 ${Math.round(diagnostics.semanticCoverage * 100)}%`,
            )
            let rank = 1
            for (const hit of hits) {
              lines.push(`${rank}. ${hit.session.title ?? '未命名对话'}`)
              lines.push(`   ID: ${hit.session.id}`)
              lines.push(`   时间: ${formatBeijingTime(hit.session.createdAt)}`)
              lines.push(
                `   排名: 词法 #${hit.lexicalRank ?? '-'} · 语义 #${hit.semanticRank ?? '-'} · 融合分 ${hit.score.toFixed(5)}`,
              )
              if (hit.explanation) lines.push(`   解释: ${hit.explanation.summary}`)
              if (hit.snippet) lines.push(`   片段: ${hit.snippet}`)
              rank += 1
            }
            for (const suggestion of diagnostics.suggestions) lines.push(`· ${suggestion}`)
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            ctx.companion.notice(
              'warning',
              `语义检索失败（原因：${error instanceof Error ? error.message : String(error)}）`,
            )
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '语义检索失败，请稍后重试',
            }
          }
        },
      }),
    'companion.retrieval-command-find',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'map',
        description: '知识地图：历史会话主题聚类，发现重复解决的问题',
        input: { hint: '[minSize]' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const raw = (invocation.rawInput ?? '').trim()
          let minSize = 2
          if (raw.length > 0) {
            const parsed = Number(raw)
            if (!Number.isInteger(parsed) || parsed < 1) {
              return { kind: 'error', text: 'minSize 必须是正整数（缺省 2：只看重复主题）' }
            }
            minSize = parsed
          }
          try {
            const { sessions, clusters } = await knowledgeMap(minSize)
            if (clusters.length === 0) {
              return {
                kind: 'success',
                text:
                  sessions === 0
                    ? '语义索引尚未建立：稍候片刻等待自动对账，或先执行一次检索'
                    : `没有规模 ≥ ${minSize} 的主题簇（共 ${sessions} 个会话，试降低 minSize）`,
              }
            }
            const repeated = clusters.filter((cluster) => cluster.size >= 2).length
            const lines = [
              `知识地图：${sessions} 个会话聚成 ${clusters.length} 个主题簇（其中 ${repeated} 个存在重复投入）`,
            ]
            for (const cluster of clusters.slice(0, 12)) {
              lines.push(
                `${cluster.id} ${cluster.label} · ${cluster.size} 个会话 · ${formatBeijingTime(cluster.from)} ~ ${formatBeijingTime(cluster.to)}`,
              )
              lines.push(`   会话: ${cluster.sessionIds.slice(0, 5).join('、')}${cluster.sessionIds.length > 5 ? ' …' : ''}`)
            }
            lines.push('提示：簇标签可直接作为 find 命令的检索词深入某主题')
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '知识地图生成失败，请稍后重试',
            }
          }
        },
      }),
    'companion.retrieval-command-map',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'pulse',
        description: '主动脉搏：主动洞察（检索盲区 + 反馈学习 + 索引健康，本地计算）',
        handler: async (): Promise<CommandResult> => {
          try {
            const report = await pulse()
            const lines = [`主动脉搏：${report.summary}`]
            for (const card of report.cards) {
              const flag =
                card.severity === 'critical' ? '‼' : card.severity === 'watch' ? '△' : '·'
              lines.push(`${flag} ${card.text}`)
              if (card.action) lines.push(`   → ${card.action}`)
            }
            if (report.cards.length === 0) {
              lines.push('提示：洞察随使用积累——点击检索结果、产生零命中都会成为信号源')
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '主动脉搏合成失败，请稍后重试',
            }
          }
        },
      }),
    'companion.retrieval-command-pulse',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'blindspots',
        description: '知识盲区：反复搜索但历史无覆盖的主题（需求缺口清单）',
        handler: async (): Promise<CommandResult> => {
          try {
            const report = await blindSpotAnalysis()
            if (report.blindSpots.length === 0) {
              return { kind: 'success', text: report.summary }
            }
            const lines = [`知识盲区：${report.summary}`]
            for (const spot of report.blindSpots) {
              lines.push(
                `· 「${spot.anchor}」×${spot.searches} 次（最近 ${formatBeijingTime(spot.lastAt)}）`,
              )
              lines.push(`   查询原形: ${spot.queries.join('、')}`)
              lines.push(`   → ${spot.advice}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '盲区分析失败，请稍后重试',
            }
          }
        },
      }),
    'companion.retrieval-command-blindspots',
  )
}

/**
 * 解析可选时间参数：毫秒时间戳或 YYYY-MM-DD（北京时间；from 取当日
 * 零点、to 取当日末尾）；空/缺省返回 undefined，非法格式 400。
 */
function parseTimeParam(value: string | null, edge: 'start' | 'end'): number | undefined {
  if (value === null || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
  const DAY_MS = 24 * 60 * 60 * 1000
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (matched) {
    const year = Number(matched[1])
    const month = Number(matched[2])
    const day = Number(matched[3])
    const probe = new Date(Date.UTC(year, month - 1, day))
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new HttpError(`时间参数不是合法日期：${value}`)
    }
    const dayStart = Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS
    return edge === 'start' ? dayStart : dayStart + DAY_MS - 1
  }
  throw new HttpError(`时间参数必须是毫秒时间戳或 YYYY-MM-DD：${value}`)
}

/** 校验请求体是 JSON 对象（POST /retrieval/feedback 用）。 */
function readBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireBodyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(`${field} 必须是非空字符串`, 400)
  }
  return value.trim()
}
