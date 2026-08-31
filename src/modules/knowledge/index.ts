/**
 * 模块 F：对话知识资产（knowledge）插件——轴线 4/7/20–25 的宿主侧接线。
 *
 * 把对话从"一次性的消息流"升级为"可积累的知识资产"：
 * - **实体抽取**（轴线 4）：纯本地规则从会话转录抽取六类实体
 *   （命令/路径/技术专名/代码标识符/中文术语/版本号），零 LLM 调用；
 * - **自动标签建议**：按 freq × 类型权重 × IDF 对会话实体打分，
 *   推荐头部实体为标签（只建议不写入——尊重现有标签系统与用户判断）；
 * - **关联会话**：基于实体倒排索引计算会话间的实体重叠相似度
 *   （IDF 加权 + 余弦式归一），回答"还有哪些对话在谈同一件事"；
 * - **前瞻记忆**（轴线 20）：从转录提取未兑现意图（「明天试试」「回头
 *   重构」），到期浮现——对话历史不再说过就忘；
 * - **间隔重复巩固**（轴线 21）：问题→解决片段即复习卡片，1/3/7/14/30/60
 *   天阶梯间隔调度，「记得」升档「忘了」归零——遗忘曲线对抗；
 * - **类比检索**（轴线 22）：按问题结构形状（约束类别 × 解法类别）跨域
 *   匹配历史经验——"你三个月前解决过同构问题，虽然在完全不同的领域"；
 * - **遗忘预测**（轴线 23）：艾宾浩斯衰减模型为每条片段给出连续的
 *   保持率画像（≥70% 健康 / 30–70% 滑落区 / <30% 深度遗忘区），
 *   用当前节律重算——日程过期（节律变差）的知识被提前预警；
 * - **个体节律自适应**（轴线 24）：命中率 → ease 闭环比例控制
 *   （目标 85% 合意困难），间隔按你的遗忘速度伸缩——你不再是
 *   "平均人类"；
 * - **认知负荷调度**（轴线 25）：到期复习按可救性 × 巩固投资分诊，
 *   每日封顶 + 洪峰顺延——复习是一份每日计划，不是一场倾倒。
 *
 * 组成：
 * - 惰性增量倒排索引：每次查询前对账 sessionQuery.listSessions() 与
 *   已分析版本（updatedAt 漂移检测），仅重读变更会话；5 秒节流
 *   （对齐模块 E 的同步策略）；同一次转录读取同时喂实体/意图/片段
 *   三路提取（零额外 IO）；
 * - HTTP 端点：`GET /knowledge/status`（索引状态）、`GET
 *   /knowledge/entities`（全局实体图谱）、`GET /knowledge/analyze`
 *   （单会话实体 + 标签建议）、`GET /knowledge/related`（关联会话）、
 *   `POST /knowledge/reanalyze`（全量重建）、`GET /knowledge/cognition`
 *   （认知总览：意图 + 复习 + 元认知三轴）、`GET /knowledge/intentions`
 *   （意图清单）、`POST /knowledge/review/grade`（复习评分 + 节律更新）、
 *   `GET /knowledge/analogy?q=`（类比检索）、`GET /knowledge/pulse`
 *   （模块 F 主动洞察：意图/复习/片段/预测/节律/负荷六类信号源）、
 *   `GET /knowledge/forecast`（遗忘预测报告）、`GET /knowledge/rhythm`
 *   （记忆节律画像）、`GET /knowledge/load?cap=`（今日负荷计划）；
 * - 命令 `insight`：知识资产文本报告；`todo`：到期意图；`review`：
 *   今日分诊后的复习安排（`review <片段ID> ok|no` 评分）；
 *   `analogy <问题描述>`：同构经验检索；`forecast`：遗忘预测体检；
 *   `rhythm`：记忆节律报告。
 *
 * 索引持久化：companion 域 `knowledge-entities` 表——
 * - 键 `v/<sessionId>` → 已分析版本（updatedAt 快照，漂移检测基准）；
 * - 键 `e/<type>:<小写名>` → 实体倒排记录 { name, type, sessions }。
 * 认知持久化：`knowledge-intentions` 表（键 = sessionId → 意图记录）、
 * `knowledge-episodes` 表（键 = sessionId → 片段记录）、
 * `knowledge-review` 表（键 = `sessionId:hash` → 复习调度状态）、
 * `knowledge-rhythm` 表（单记录 'profile' → 记忆节律档案）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import { formatBeijingTime } from '../../core/time.js'
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js'
import type { Domain, KvTable } from '../../core/storage-adapter.js'
import type { CommandInvocation, CommandResult, SessionRecord } from '../../types/harness.js'
import {
  dueIntentions,
  extractIntentions,
  sanitizeIntentionRecord,
  upcomingIntentions,
  type DueIntention,
  type IntentionRecord,
} from '../../core/cognition/prospective.js'
import {
  extractEpisodes,
  sanitizeEpisodeRecord,
  type EpisodeRecord,
} from '../../core/cognition/episodes.js'
import {
  dueReviews,
  gradeReview,
  INTERVALS_DAYS,
  sanitizeReviewState,
  type DueReview,
  type ReviewState,
} from '../../core/cognition/spaced.js'
import {
  forecastForgetting,
  retentionIndex,
  type ForecastReport,
} from '../../core/cognition/forecast.js'
import {
  emptyRhythm,
  projectedLadder,
  rhythmHitRate,
  rhythmSummary,
  sanitizeRhythmProfile,
  TARGET_HIT_RATE,
  updateRhythm,
  type RhythmProfile,
} from '../../core/cognition/rhythm.js'
import {
  planReviewLoad,
  type LoadPlan,
} from '../../core/cognition/load.js'
import { findAnalogies } from '../../core/cognition/analogy.js'
import {
  composePulse,
  dueIntentionInsights,
  dueReviewInsights,
  episodeInsights,
  forgettingForecastInsights,
  loadInsights,
  rhythmInsights,
  type PulseReport,
} from '../../core/insights/pulse.js'
import {
  ENTITY_TYPES,
  entityTypeWeight,
  extractEntities,
  parseEntityKey,
  type EntityType,
  type ExtractedEntity,
} from './entities.js'
import { computeEntityTrends, type TrendEntityRecord } from './trends.js'

/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-knowledge'

/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 分析转录字符预算：超长会话保首尾截中段（对齐模块 B/E 的截断策略）。 */
const ANALYSIS_TRANSCRIPT_BUDGET = 80_000

/** 截断时插入的中段提示行。 */
const ANALYSIS_TRUNCATION_NOTICE = '\n\n【内容过长，实体抽取仅覆盖首尾】\n\n'

/** 索引对账节流窗口（毫秒）。 */
const SYNC_THROTTLE_MS = 5_000

/** 实体图谱缺省返回条数。 */
const DEFAULT_ENTITIES_LIMIT = 50

/** 实体图谱最大返回条数。 */
const MAX_ENTITIES_LIMIT = 200

/** 关联会话缺省返回条数。 */
const DEFAULT_RELATED_LIMIT = 5

/** 关联会话最大返回条数。 */
const MAX_RELATED_LIMIT = 20

/** 建议标签条数。 */
const SUGGESTED_TAGS_COUNT = 5

/** 趋势对比窗口缺省长度（天）。 */
const DEFAULT_TREND_DAYS = 14

/** 趋势对比窗口最大长度（天）。 */
const MAX_TREND_DAYS = 90

/** 趋势返回条数缺省值。 */
const DEFAULT_TRENDS_LIMIT = 12

/** 趋势返回条数上限。 */
const MAX_TRENDS_LIMIT = 50

/** 单条标签最大长度（对齐 TagStore 的 MAX_TAG_LENGTH）。 */
const MAX_TAG_LENGTH = 32

/** 节律档案在 knowledge-rhythm 表中的固定键。 */
const RHYTHM_PROFILE_KEY = 'profile'

/** 每日复习容量缺省值（轴线 25 认知负荷调度）。 */
const DAILY_REVIEW_CAP = 8

/** 负荷容量参数上限（防御性：单日练习量不宜无界）。 */
const MAX_DAILY_REVIEW_CAP = 30

/** 实体倒排记录（knowledge-entities 表 `e/` 前缀键的值形状）。 */
interface EntityRecord {
  /** 展示名（众数原形；随最近一次分析刷新）。 */
  name: string
  type: EntityType
  /** 会话 id → 该会话内频次。 */
  sessions: Record<string, number>
}

/** 索引同步结果。 */
interface SyncResult {
  /** 已分析会话数。 */
  sessions: number
  /** 实体总数。 */
  entities: number
  /** 本次重分析的会话数。 */
  updated: number
  /** 本次清理的死会话数。 */
  removed: number
}

/** 单会话实体视图（analyze 端点响应项）。 */
interface SessionEntityView {
  name: string
  type: EntityType
  freq: number
  /** 全局显著性分：freq × 类型权重 × IDF。 */
  score: number
  /** 覆盖会话数（含本会话）。 */
  globalSessionCount: number
}

/** 关联会话命中（related 端点响应项）。 */
interface RelatedSessionHit {
  sessionId: string
  title?: string
  createdAt: number
  /** 实体重叠相似度（IDF 加权 + 余弦式归一；无界正数）。 */
  score: number
  /** 共享实体（按贡献降序，最多 5 个）。 */
  sharedEntities: ReadonlyArray<{ name: string; type: EntityType }>
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  /** 倒排表（就绪后赋值；全部端点先 await 就绪再触碰）。 */
  let table: KvTable<EntityRecord | number> | undefined
  /** 意图表（轴线 20；键 = sessionId）。 */
  let intentionTable: KvTable<IntentionRecord> | undefined
  /** 片段表（轴线 21/22；键 = sessionId）。 */
  let episodeTable: KvTable<EpisodeRecord> | undefined
  /** 复习调度表（轴线 21；键 = `sessionId:hash`）。 */
  let reviewTable: KvTable<ReviewState> | undefined
  /** 记忆节律档案（轴线 24；单记录，键 = 'profile'）。 */
  let rhythmTable: KvTable<RhythmProfile> | undefined
  /** 最近一次对账完成时间（节流基准）。 */
  let lastSyncAt = 0
  /** 在途对账 promise（并发查询去重）。 */
  let syncInFlight: Promise<SyncResult> | undefined

  void ctx.companion.ready
    .then(({ domain }: { domain: Domain }) => {
      table = domain.table<EntityRecord | number>('knowledge-entities')
      intentionTable = domain.table<IntentionRecord>('knowledge-intentions')
      episodeTable = domain.table<EpisodeRecord>('knowledge-episodes')
      reviewTable = domain.table<ReviewState>('knowledge-review')
      rhythmTable = domain.table<RhythmProfile>('knowledge-rhythm')
    })
    .catch(() => {
      // 存储域失败：核心服务已发 notice，这里仅避免未处理 rejection。
    })

  /** 按预算截断转录（保首尾 + 中段提示行）。 */
  function budgetTranscript(text: string): string {
    if (text.length <= ANALYSIS_TRANSCRIPT_BUDGET) return text
    const keepTotal = ANALYSIS_TRANSCRIPT_BUDGET - ANALYSIS_TRUNCATION_NOTICE.length
    const headLength = Math.ceil(keepTotal / 2)
    const tailLength = keepTotal - headLength
    return (
      text.slice(0, headLength) + ANALYSIS_TRUNCATION_NOTICE + text.slice(text.length - tailLength)
    )
  }

  /** 表键前缀：会话分析版本记录。 */
  const versionKey = (sessionId: string): string => `v/${sessionId}`

  /** 表键前缀：实体倒排记录。 */
  const entityTableKey = (entityKeyString: string): string => `e/${entityKeyString}`

  /** 从损坏/旧格式记录恢复实体记录的收窄：非法记录静默丢弃。 */
  function sanitizeEntityRecord(raw: unknown): EntityRecord | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0) return undefined
    const type = record.type
    if (typeof type !== 'string' || !(ENTITY_TYPES as readonly string[]).includes(type)) {
      return undefined
    }
    const sessions: Record<string, number> = {}
    if (typeof record.sessions === 'object' && record.sessions !== null) {
      for (const [sid, freq] of Object.entries(record.sessions as Record<string, unknown>)) {
        if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0) sessions[sid] = freq
      }
    }
    return { name: record.name, type: type as EntityType, sessions }
  }

  /**
   * 全表扫描装载：内存视图（实体倒排 + 会话分析版本）。
   * 表是内存权威读的 KvTable，entries() 同步返回全量键值。
   */
  function loadSnapshot(): {
    entities: Map<string, EntityRecord>
    versions: Map<string, number>
  } {
    const entities = new Map<string, EntityRecord>()
    const versions = new Map<string, number>()
    if (table === undefined) return { entities, versions }
    for (const [key, value] of table.entries()) {
      if (key.startsWith('v/')) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          versions.set(key.slice(2), value)
        }
      } else if (key.startsWith('e/')) {
        const record = sanitizeEntityRecord(value)
        if (record) entities.set(key.slice(2), record)
      }
    }
    return { entities, versions }
  }

  /**
   * 分析单个会话并增量更新倒排索引：
   * 旧频次（该会话在各实体记录中的 sessions[sid]）与新抽取结果做 diff，
   * 只写发生变化的实体记录——未受影响的记录零 IO。
   * 同一次转录读取同时喂三路提取（轴线 20 意图 + 轴线 21/22 片段），
   * 零额外 IO。
   */
  async function analyzeSession(
    sessionId: string,
    session: SessionRecord,
    entities: Map<string, EntityRecord>,
  ): Promise<boolean> {
    const version = session.updatedAt ?? session.createdAt
    // 1) 收集该会话的旧频次。
    const oldFreqs = new Map<string, number>()
    for (const [ekey, record] of entities) {
      const freq = record.sessions[sessionId]
      if (freq !== undefined) oldFreqs.set(ekey, freq)
    }
    // 2) 读取转录并抽取实体 + 意图 + 片段。
    let text: string
    try {
      const snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
      text = budgetTranscript(formatTranscript(transcriptFromLog(snapshot), { timestamps: false }))
    } catch {
      // 单会话读取失败：跳过（保留旧索引），不影响其余会话。
      return false
    }
    const extracted = extractEntities(text)
    const nextFreqs = new Map<string, ExtractedEntity>()
    for (const entity of extracted) nextFreqs.set(entity.key, entity)
    // 2a) 前瞻记忆（轴线 20）：意图提取（无意图 → 清掉旧记录）。
    const intentions = extractIntentions(text)
    if (intentions.length > 0) {
      await intentionTable?.put(sessionId, { createdAt: session.createdAt, intentions })
    } else {
      await intentionTable?.delete(sessionId)
    }
    // 2b) 认知片段（轴线 21/22）：问题→解决提取（无片段 → 清掉旧记录）。
    const episodes = extractEpisodes(text)
    if (episodes.length > 0) {
      await episodeTable?.put(sessionId, { createdAt: session.createdAt, episodes })
    } else {
      await episodeTable?.delete(sessionId)
    }
    // 3) Diff 更新：频次不变的记录不触碰。
    const allKeys = new Set<string>([...oldFreqs.keys(), ...nextFreqs.keys()])
    for (const ekey of allKeys) {
      const entity = nextFreqs.get(ekey)
      const newFreq = entity?.freq ?? 0
      const oldFreq = oldFreqs.get(ekey) ?? 0
      if (newFreq === oldFreq) continue
      let record = entities.get(ekey)
      if (record === undefined) {
        if (entity === undefined) continue
        record = { name: entity.name, type: entity.type, sessions: {} }
        entities.set(ekey, record)
      }
      // display 名随最近一次分析刷新（众数原形可能变化）。
      if (entity !== undefined) record.name = entity.name
      if (newFreq > 0) record.sessions[sessionId] = newFreq
      else delete record.sessions[sessionId]
      const tableKey = entityTableKey(ekey)
      if (Object.keys(record.sessions).length === 0) {
        entities.delete(ekey)
        await table?.delete(tableKey)
      } else {
        await table?.put(tableKey, record)
      }
    }
    await table?.put(versionKey(sessionId), version)
    return true
  }

  /**
   * 索引对账（增量同步，对齐模块 E 的节流与在途去重策略）：
   * - 已消失会话 → 删除版本记录并从全部实体记录移除其频次；
   * - 新会话或版本漂移 → 重读转录重分析（增量 diff 落盘）；
   * - force=true 时清空全部状态后全量重建（reanalyze 入口）。
   */
  async function syncKnowledge(force: boolean): Promise<SyncResult> {
    if (table === undefined) throw new HttpError('知识索引尚未就绪', 503)
    if (
      !force &&
      syncInFlight === undefined &&
      Date.now() - lastSyncAt < SYNC_THROTTLE_MS
    ) {
      const snapshot = loadSnapshot()
      return {
        sessions: snapshot.versions.size,
        entities: snapshot.entities.size,
        updated: 0,
        removed: 0,
      }
    }
    if (syncInFlight !== undefined) return syncInFlight
    syncInFlight = (async (): Promise<SyncResult> => {
      const sessions = await ctx.sessionQuery.listSessions()
      const live = new Map<string, SessionRecord>()
      for (const session of sessions) live.set(String(session.id), session)

      if (force) {
        // 全量重建：清空版本与实体记录后重新分析全部会话。
        for (const key of table.keys()) await table.delete(key)
      }
      const { entities, versions } = loadSnapshot()

      // 1) 死会话清理（实体 + 意图 + 片段 + 复习状态一并清）。
      let removed = 0
      for (const sessionId of [...versions.keys()]) {
        if (live.has(sessionId)) continue
        await table.delete(versionKey(sessionId))
        versions.delete(sessionId)
        for (const [ekey, record] of [...entities.entries()]) {
          if (record.sessions[sessionId] === undefined) continue
          delete record.sessions[sessionId]
          const tableKey = entityTableKey(ekey)
          if (Object.keys(record.sessions).length === 0) {
            entities.delete(ekey)
            await table.delete(tableKey)
          } else {
            await table.put(tableKey, record)
          }
        }
        await intentionTable?.delete(sessionId)
        await episodeTable?.delete(sessionId)
        // 复习状态键为 `sessionId:hash`：前缀匹配清理。
        if (reviewTable !== undefined) {
          const prefix = `${sessionId}:`
          for (const key of reviewTable.keys()) {
            if (key.startsWith(prefix)) await reviewTable.delete(key)
          }
        }
        removed += 1
      }

      // 2) 新会话 / 版本漂移会话重分析。
      let updated = 0
      for (const [sessionId, session] of live) {
        const version = session.updatedAt ?? session.createdAt
        if (!force && versions.get(sessionId) === version) continue
        if (await analyzeSession(sessionId, session, entities)) {
          versions.set(sessionId, version)
          updated += 1
        }
      }
      lastSyncAt = Date.now()
      return {
        sessions: versions.size,
        entities: entities.size,
        updated,
        removed,
      }
    })()
    try {
      return await syncInFlight
    } finally {
      syncInFlight = undefined
    }
  }

  /** 读取某会话的实体视图（含全局统计）；须在 syncKnowledge 之后调用。 */
  function sessionEntitiesOf(
    sessionId: string,
    analyzedSessions: number,
  ): SessionEntityView[] {
    const { entities } = loadSnapshot()
    const views: SessionEntityView[] = []
    for (const record of entities.values()) {
      const freq = record.sessions[sessionId]
      if (freq === undefined || freq <= 0) continue
      const df = Object.keys(record.sessions).length
      // IDF：稀有实体（覆盖会话少）在全局图谱中更显著。
      const idf = Math.log(1 + analyzedSessions / (1 + df))
      views.push({
        name: record.name,
        type: record.type,
        freq,
        score: Number((freq * entityTypeWeight(record.type) * (1 + idf)).toFixed(4)),
        globalSessionCount: df,
      })
    }
    views.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return views
  }

  /** 计算与目标会话最相关的其他会话（实体重叠 + IDF 加权 + 余弦式归一）。 */
  async function relatedSessionsOf(
    sessionId: string,
    limit: number,
  ): Promise<RelatedSessionHit[]> {
    const { entities } = loadSnapshot()
    // 目标实体键集与各会话的实体键集（一次遍历构建）。
    const targetKeys = new Set<string>()
    const sessionKeyCount = new Map<string, number>()
    /** ekey → 覆盖会话集合（df 缓存）。 */
    const entityDf = new Map<string, number>()
    for (const [ekey, record] of entities) {
      const sids = Object.keys(record.sessions)
      entityDf.set(ekey, sids.length)
      if (record.sessions[sessionId] !== undefined) targetKeys.add(ekey)
      for (const sid of sids) {
        sessionKeyCount.set(sid, (sessionKeyCount.get(sid) ?? 0) + 1)
      }
    }
    if (targetKeys.size === 0) return []
    // 候选会话 → 共享实体及贡献分。
    const candidates = new Map<string, { score: number; shared: Array<{ name: string; type: EntityType; weight: number }> }>()
    for (const [ekey, record] of entities) {
      if (!targetKeys.has(ekey)) continue
      const df = entityDf.get(ekey) ?? 1
      // IDF 权重：稀有实体的重叠更说明"在谈同一件事"。
      const weight = 1 + 1 / Math.max(1, df)
      for (const sid of Object.keys(record.sessions)) {
        if (sid === sessionId) continue
        const entry = candidates.get(sid) ?? { score: 0, shared: [] }
        entry.score += weight
        entry.shared.push({ name: record.name, type: record.type, weight })
        candidates.set(sid, entry)
      }
    }
    const targetSize = targetKeys.size
    const related: RelatedSessionHit[] = []
    for (const [sid, entry] of candidates) {
      const otherSize = sessionKeyCount.get(sid) ?? 1
      // 余弦式归一：除以两实体集规模的几何平均，避免实体多的会话占尽便宜。
      const normalized = entry.score / Math.sqrt(targetSize * Math.max(1, otherSize))
      entry.shared.sort((a, b) => b.weight - a.weight)
      related.push({
        sessionId: sid,
        createdAt: 0,
        score: Number(normalized.toFixed(4)),
        sharedEntities: entry.shared.slice(0, 5).map(({ name, type }) => ({ name, type })),
      })
    }
    related.sort((a, b) => b.score - a.score)
    // 会话头信息（title/createdAt）从 listSessions 补齐。
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      const headers = new Map<string, SessionRecord>()
      for (const session of sessions) headers.set(String(session.id), session)
      for (const hit of related) {
        const header = headers.get(hit.sessionId)
        if (header) {
          hit.title = header.title
          hit.createdAt = header.createdAt
        }
      }
    } catch {
      // 头信息补齐失败：保留零值 createdAt，不阻塞相似度结果。
    }
    return related.slice(0, limit)
  }

  /**
   * 主题趋势（轴线 7）：近 N 天 vs 上一等长窗口的实体动量与方向，
   * 附最近 8 周逐周覆盖会话数。时间基准取会话 createdAt。
   */
  async function entityTrendsOf(days: number, limit: number) {
    const { entities } = loadSnapshot()
    const records: TrendEntityRecord[] = [...entities.values()].map((record) => ({
      name: record.name,
      type: record.type,
      sessions: record.sessions,
    }))
    const sessionTimes = new Map<string, number>()
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      for (const session of sessions) {
        sessionTimes.set(String(session.id), session.createdAt)
      }
    } catch {
      // 头信息失败：无时间信号的实体自动剔除，不阻塞其余结果。
    }
    return computeEntityTrends({ records, sessionTimes, now: Date.now(), days }).slice(0, limit)
  }

  // ------------------------------------------------------------------
  // 认知三轴（轴线 20/21/22）：意图 / 复习 / 类比的服务函数
  // ------------------------------------------------------------------

  /** 装载意图快照（表 → 内存 Map；净化非法记录）。 */
  function loadIntentions(): Map<string, IntentionRecord> {
    const intentions = new Map<string, IntentionRecord>()
    if (intentionTable === undefined) return intentions
    for (const [sessionId, raw] of intentionTable.entries()) {
      const record = sanitizeIntentionRecord(raw)
      if (record && record.intentions.length > 0) intentions.set(sessionId, record)
    }
    return intentions
  }

  /** 装载片段快照（表 → 内存 Map；净化非法记录）。 */
  function loadEpisodes(): Map<string, EpisodeRecord> {
    const episodes = new Map<string, EpisodeRecord>()
    if (episodeTable === undefined) return episodes
    for (const [sessionId, raw] of episodeTable.entries()) {
      const record = sanitizeEpisodeRecord(raw)
      if (record && record.episodes.length > 0) episodes.set(sessionId, record)
    }
    return episodes
  }

  /** 装载复习状态快照（表 → 内存 Map；净化非法记录）。 */
  function loadReviews(): Map<string, ReviewState> {
    const states = new Map<string, ReviewState>()
    if (reviewTable === undefined) return states
    for (const [episodeId, raw] of reviewTable.entries()) {
      const state = sanitizeReviewState(raw)
      if (state) states.set(episodeId, state)
    }
    return states
  }

  /** 装载记忆节律档案（单记录；非法/缺失返回空档案冷启动）。 */
  function loadRhythm(): RhythmProfile {
    if (rhythmTable === undefined) return emptyRhythm()
    const profile = sanitizeRhythmProfile(rhythmTable.get(RHYTHM_PROFILE_KEY))
    return profile ?? emptyRhythm()
  }

  /** 会话头信息（title 补齐用；失败返回空映射不阻塞）。 */
  async function sessionHeaders(): Promise<Map<string, SessionRecord>> {
    const headers = new Map<string, SessionRecord>()
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      for (const session of sessions) headers.set(String(session.id), session)
    } catch {
      // 头信息补齐失败：命中保留 sessionId，不阻塞认知结果。
    }
    return headers
  }

  /** 到期意图视图（带会话标题补齐）。 */
  async function dueIntentionViews(
    maxDue = 20,
    maxUpcoming = 10,
  ): Promise<{ due: DueIntention[]; upcoming: DueIntention[] }> {
    const records = loadIntentions()
    const now = Date.now()
    const due = [...dueIntentions(records, now, maxDue)]
    const upcoming = [...upcomingIntentions(records, now, maxUpcoming)]
    return { due, upcoming }
  }

  /** 到期复习视图。 */
  function dueReviewViews(maxReturned = 15): DueReview[] {
    return [...dueReviews(loadEpisodes(), loadReviews(), Date.now(), maxReturned)]
  }

  /** 认知总览（客户端认知面板的单次拉取：意图 + 复习 + 元认知三轴）。 */
  async function cognitionOverview(): Promise<{
    intentions: { due: DueIntention[]; upcoming: DueIntention[] }
    reviews: DueReview[]
    plan: LoadPlan
    forecast: ForecastReport
    rhythm: { ease: number; remembered: number; forgotten: number; summary: string }
    stats: { sessions: number; intentions: number; episodes: number; reviewStates: number }
  }> {
    const [intentions, episodes, reviews] = [loadIntentions(), loadEpisodes(), loadReviews()]
    const rhythm = loadRhythm()
    return {
      intentions: await dueIntentionViews(),
      reviews: dueReviewViews(),
      plan: todayLoad(),
      forecast: forecastView(),
      rhythm: {
        ease: rhythm.ease,
        remembered: rhythm.remembered,
        forgotten: rhythm.forgotten,
        summary: rhythmSummary(rhythm),
      },
      stats: {
        sessions: episodes.size,
        intentions: [...intentions.values()].reduce((sum, record) => sum + record.intentions.length, 0),
        episodes: [...episodes.values()].reduce((sum, record) => sum + record.episodes.length, 0),
        reviewStates: reviews.size,
      },
    }
  }

  /**
   * 复习评分（轴线 21 + 24 闭环）：episodeId 必须存在于片段索引。
   * 评分同时更新记忆节律（命中率 → ease），下次间隔按新节律排定。
   */
  async function gradeEpisode(episodeId: string, remembered: boolean): Promise<{
    stage: number
    nextDueAt: number
    nextIntervalDays: number
    ease: number
  }> {
    if (reviewTable === undefined) throw new HttpError('复习调度表尚未就绪', 503)
    const separator = episodeId.indexOf(':')
    if (separator <= 0 || separator >= episodeId.length - 1) {
      throw new HttpError('episodeId 格式非法（应为 会话ID:片段哈希）', 400)
    }
    const sessionId = episodeId.slice(0, separator)
    const record = loadEpisodes().get(sessionId)
    const exists =
      record !== undefined && record.episodes.some((episode) => `${sessionId}:${episode.id}` === episodeId)
    if (!exists) {
      throw new HttpError('episodeId 不在片段索引中（可能已被重新分析），请刷新复习清单', 404)
    }
    const states = loadReviews()
    const previous: ReviewState = states.get(episodeId) ?? {
      episodeId,
      lastReviewedAt: null,
      stage: 0,
    }
    const now = Date.now()
    const rhythm = loadRhythm()
    const result = gradeReview(previous, remembered, now, rhythm.ease)
    await reviewTable.put(episodeId, result.state)
    // 节律闭环（轴线 24）：本次评分计入命中率，系数按偏差调整。
    const nextRhythm = updateRhythm(rhythm, remembered, now)
    await rhythmTable?.put(RHYTHM_PROFILE_KEY, nextRhythm)
    return {
      stage: result.state.stage,
      nextDueAt: result.nextDueAt,
      nextIntervalDays: result.nextIntervalDays,
      ease: nextRhythm.ease,
    }
  }

  /** 遗忘预测视图（轴线 23）：用当前节律系数重算全库保持率。 */
  function forecastView(): ForecastReport {
    return forecastForgetting(loadEpisodes(), loadReviews(), Date.now(), loadRhythm().ease)
  }

  /** 记忆节律视图（轴线 24）：档案 + 摘要 + 投影间隔阶梯。 */
  function rhythmView(): {
    profile: RhythmProfile
    summary: string
    hitRate: number
    targetHitRate: number
    ladder: ReadonlyArray<{ stage: number; baseDays: number; adaptedDays: number }>
  } {
    const profile = loadRhythm()
    return {
      profile,
      summary: rhythmSummary(profile),
      hitRate: rhythmHitRate(profile),
      targetHitRate: TARGET_HIT_RATE,
      ladder: projectedLadder(profile.ease),
    }
  }

  /**
   * 今日负荷计划（轴线 25）：到期复习 × 遗忘预测 → 可救性分诊
   * → 每日封顶。到期清单放宽到 200 条（洪峰也要有全局视野才能分诊）。
   */
  function todayLoad(cap = DAILY_REVIEW_CAP): LoadPlan {
    const episodes = loadEpisodes()
    const states = loadReviews()
    const now = Date.now()
    const ease = loadRhythm().ease
    const retentions = retentionIndex(episodes, states, now, ease)
    const due = [...dueReviews(episodes, states, now, 200)]
    return planReviewLoad(due, (episodeId) => retentions.get(episodeId), cap)
  }

  /** 类比检索视图（轴线 22）：带会话标题补齐。 */
  async function analogySearch(queryText: string) {
    const headers = await sessionHeaders()
    const titles = new Map<string, string | undefined>()
    for (const [sessionId, session] of headers) titles.set(sessionId, session.title)
    return findAnalogies(queryText, loadEpisodes(), titles)
  }

  /**
   * 模块 F 主动脉搏（轴线 18 的信号源扩展：
   * 意图 + 复习 + 片段 + 元认知三轴[遗忘预测/节律/负荷]）。
   */
  async function knowledgePulse(): Promise<PulseReport> {
    const episodes = loadEpisodes()
    const states = loadReviews()
    const now = Date.now()
    const rhythm = loadRhythm()
    const forecast = forecastForgetting(episodes, states, now, rhythm.ease)
    const retentions = retentionIndex(episodes, states, now, rhythm.ease)
    const due = [...dueReviews(episodes, states, now, 30)]
    const plan = planReviewLoad(due, (episodeId) => retentions.get(episodeId))
    const dueIntentionList = await dueIntentionViews(30, 0)
    const totalEpisodes = [...episodes.values()].reduce((sum, record) => sum + record.episodes.length, 0)
    // 跨域就绪判定：片段量足够（≥5）且约束类别多样性足够（≥3 类）。
    const constraintKinds = new Set<string>()
    for (const record of episodes.values()) {
      for (const episode of record.episodes) {
        for (const kind of episode.shape.constraints) constraintKinds.add(kind)
      }
    }
    return composePulse(
      [
        () => dueIntentionInsights(dueIntentionList.due),
        () => dueReviewInsights(due),
        () =>
          episodeInsights({
            episodes: totalEpisodes,
            sessionsWithEpisodes: episodes.size,
            crossDomainReady: totalEpisodes >= 5 && constraintKinds.size >= 3,
          }),
        () =>
          forgettingForecastInsights({
            criticalCount: forecast.criticalCount,
            warningCount: forecast.warningCount,
            stableCount: forecast.stableCount,
          }),
        () => rhythmInsights(rhythm),
        () =>
          loadInsights({
            totalDue: plan.totalDue,
            todayCount: plan.today.length,
            deferredCount: plan.deferredCount,
          }),
      ],
      Date.now(),
    )
  }


  // ------------------------------------------------------------------
  // HTTP 端点（注册即 effect）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/status', async (_req, res) => {
        await ctx.companion.ready
        const sync = await syncKnowledge(false)
        sendJson(res, 200, {
          sessions: sync.sessions,
          entities: sync.entities,
          updated: sync.updated,
          removed: sync.removed,
          lastSyncAt: lastSyncAt > 0 ? lastSyncAt : null,
        })
      }),
    'companion.knowledge-http-status',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/entities', async (_req, res, { query }) => {
        await ctx.companion.ready
        const limit = parseLimitParam(
          query.get('limit') ?? undefined,
          DEFAULT_ENTITIES_LIMIT,
          MAX_ENTITIES_LIMIT,
        )
        const typeFilter = query.get('type')
        if (
          typeFilter !== null &&
          typeFilter.length > 0 &&
          !(ENTITY_TYPES as readonly string[]).includes(typeFilter)
        ) {
          throw new HttpError(
            `type 必须是以下之一：${ENTITY_TYPES.join(' / ')}`,
            400,
          )
        }
        await syncKnowledge(false)
        const { entities } = loadSnapshot()
        const views = []
        for (const record of entities.values()) {
          if (typeFilter !== null && typeFilter.length > 0 && record.type !== typeFilter) continue
          const sids = Object.keys(record.sessions)
          let totalFreq = 0
          for (const freq of Object.values(record.sessions)) totalFreq += freq
          views.push({
            name: record.name,
            type: record.type,
            sessionCount: sids.length,
            totalFreq,
            sampleSessions: sids.slice(0, 3),
          })
        }
        views.sort(
          (a, b) => b.sessionCount - a.sessionCount || b.totalFreq - a.totalFreq,
        )
        sendJson(res, 200, { entities: views.slice(0, limit) })
      }),
    'companion.knowledge-http-entities',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/analyze', async (_req, res, { query }) => {
        const sessionId = (query.get('sessionId') ?? '').trim()
        if (sessionId.length === 0) throw new HttpError('sessionId 必填', 400)
        await ctx.companion.ready
        const sync = await syncKnowledge(false)
        const views = sessionEntitiesOf(sessionId, Math.max(1, sync.sessions))
        // 建议标签：头部实体名（长度 ≤ 32，对齐 TagStore 规范）。
        const suggestedTags: string[] = []
        for (const view of views) {
          if (suggestedTags.length >= SUGGESTED_TAGS_COUNT) break
          const tag = view.name.trim().slice(0, MAX_TAG_LENGTH)
          if (tag.length >= 2 && !suggestedTags.includes(tag)) suggestedTags.push(tag)
        }
        sendJson(res, 200, {
          sessionId,
          analyzed: views.length > 0,
          entities: views,
          suggestedTags,
        })
      }),
    'companion.knowledge-http-analyze',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/related', async (_req, res, { query }) => {
        const sessionId = (query.get('sessionId') ?? '').trim()
        if (sessionId.length === 0) throw new HttpError('sessionId 必填', 400)
        const limit = parseLimitParam(
          query.get('limit') ?? undefined,
          DEFAULT_RELATED_LIMIT,
          MAX_RELATED_LIMIT,
        )
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, {
          sessionId,
          related: await relatedSessionsOf(sessionId, limit),
        })
      }),
    'companion.knowledge-http-related',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/trends', async (_req, res, { query }) => {
        const days = parseDaysParam(query.get('days') ?? undefined)
        const limit = parseLimitParam(
          query.get('limit') ?? undefined,
          DEFAULT_TRENDS_LIMIT,
          MAX_TRENDS_LIMIT,
        )
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, {
          days,
          generatedAt: Date.now(),
          trends: await entityTrendsOf(days, limit),
        })
      }),
    'companion.knowledge-http-trends',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/knowledge/reanalyze', async (_req, res) => {
        await ctx.companion.ready
        sendJson(res, 200, { ok: true, ...(await syncKnowledge(true)) })
      }),
    'companion.knowledge-http-reanalyze',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/cognition', async (_req, res) => {
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, await cognitionOverview())
      }),
    'companion.knowledge-http-cognition',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/intentions', async (_req, res) => {
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, await dueIntentionViews(30, 15))
      }),
    'companion.knowledge-http-intentions',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/knowledge/review/grade', async (_req, res, { body }) => {
        await ctx.companion.ready
        const record = readBodyObject(body)
        const episodeId = requireBodyString(record.episodeId, 'episodeId')
        if (typeof record.remembered !== 'boolean') {
          throw new HttpError('remembered 必须是布尔值', 400)
        }
        sendJson(res, 200, {
          ok: true,
          ...(await gradeEpisode(episodeId, record.remembered)),
        })
      }),
    'companion.knowledge-http-review-grade',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/analogy', async (_req, res, { query }) => {
        const q = (query.get('q') ?? '').trim()
        if (q.length === 0) throw new HttpError('q 必填（当前问题的自然语言描述）', 400)
        if (q.length > 500) throw new HttpError('q 不能超过 500 字符', 400)
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, await analogySearch(q))
      }),
    'companion.knowledge-http-analogy',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/pulse', async (_req, res) => {
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, await knowledgePulse())
      }),
    'companion.knowledge-http-pulse',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/forecast', async (_req, res) => {
        await ctx.companion.ready
        await syncKnowledge(false)
        sendJson(res, 200, forecastView())
      }),
    'companion.knowledge-http-forecast',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/rhythm', async (_req, res) => {
        await ctx.companion.ready
        sendJson(res, 200, rhythmView())
      }),
    'companion.knowledge-http-rhythm',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/knowledge/load', async (_req, res, { query }) => {
        await ctx.companion.ready
        await syncKnowledge(false)
        const cap = parseLimitParam(query.get('cap') ?? undefined, DAILY_REVIEW_CAP, MAX_DAILY_REVIEW_CAP)
        sendJson(res, 200, todayLoad(cap))
      }),
    'companion.knowledge-http-load',
  )

  // ------------------------------------------------------------------
  // 命令面板（与 HTTP 端点复用同一索引）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'insight',
        description: '知识资产报告：全局实体图谱或单会话实体/建议标签/关联会话',
        input: { hint: '[会话ID]（缺省输出全局图谱）' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const arg = (invocation.rawInput ?? '').trim()
          try {
            await ctx.companion.ready
            if (arg.length === 0) {
              // 全局图谱：覆盖会话数最多的头部实体。
              const sync = await syncKnowledge(false)
              const { entities } = loadSnapshot()
              const views: Array<{
                name: string
                type: EntityType
                sessionCount: number
                totalFreq: number
              }> = []
              for (const record of entities.values()) {
                const sids = Object.keys(record.sessions)
                let totalFreq = 0
                for (const freq of Object.values(record.sessions)) totalFreq += freq
                views.push({
                  name: record.name,
                  type: record.type,
                  sessionCount: sids.length,
                  totalFreq,
                })
              }
              views.sort((a, b) => b.sessionCount - a.sessionCount || b.totalFreq - a.totalFreq)
              const lines: string[] = ['对话知识资产图谱：', '']
              lines.push(`已索引会话：${sync.sessions} 个，实体：${sync.entities} 个`)
              if (views.length > 0) {
                lines.push('')
                lines.push('高频实体（按覆盖会话数）：')
                for (const view of views.slice(0, 15)) {
                  lines.push(
                    `  - [${view.type}] ${view.name}（${view.sessionCount} 个会话，累计 ${view.totalFreq} 次）`,
                  )
                }
              }
              // 主题趋势（轴线 7）：近 14 天 vs 上一 14 天的注意力流向。
              const trends = await entityTrendsOf(DEFAULT_TREND_DAYS, 10)
              const rising = trends.filter((trend) => trend.direction === 'rising').slice(0, 5)
              const falling = trends.filter((trend) => trend.direction === 'falling').slice(0, 3)
              if (rising.length > 0 || falling.length > 0) {
                lines.push('')
                lines.push(`主题趋势（近 ${DEFAULT_TREND_DAYS} 天 vs 上一 ${DEFAULT_TREND_DAYS} 天）：`)
                for (const trend of rising) {
                  lines.push(
                    `  ↗ [${trend.type}] ${trend.name}（${trend.previousSessions} → ${trend.recentSessions} 个会话）`,
                  )
                }
                for (const trend of falling) {
                  lines.push(
                    `  ↘ [${trend.type}] ${trend.name}（${trend.previousSessions} → ${trend.recentSessions} 个会话）`,
                  )
                }
              }
              lines.push('')
              lines.push('提示：运行 insight <会话ID> 查看单会话实体、建议标签与关联会话')
              return { kind: 'success', text: lines.join('\n') }
            }
            const sync = await syncKnowledge(false)
            const views = sessionEntitiesOf(arg, Math.max(1, sync.sessions))
            if (views.length === 0) {
              return { kind: 'success', text: `会话 ${arg} 暂未抽取到任何实体` }
            }
            const related = await relatedSessionsOf(arg, DEFAULT_RELATED_LIMIT)
            const lines: string[] = [`会话 ${arg} 的知识资产：`]
            lines.push('')
            lines.push('实体（按显著性）：')
            for (const view of views.slice(0, 10)) {
              lines.push(
                `  - [${view.type}] ${view.name}（频次 ${view.freq}，覆盖 ${view.globalSessionCount} 个会话）`,
              )
            }
            const tags = views
              .map((view) => view.name.trim().slice(0, MAX_TAG_LENGTH))
              .filter((tag) => tag.length >= 2)
              .slice(0, SUGGESTED_TAGS_COUNT)
            if (tags.length > 0) {
              lines.push('')
              lines.push(`建议标签：${tags.join('、')}（可用 tag 命令应用）`)
            }
            if (related.length > 0) {
              lines.push('')
              lines.push('关联会话（实体重叠）：')
              for (const hit of related) {
                const shared = hit.sharedEntities.map((entity) => entity.name).join('、')
                lines.push(
                  `  - ${hit.title ?? '未命名对话'}（ID: ${hit.sessionId}，相似度 ${hit.score.toFixed(3)}）`,
                )
                if (shared.length > 0) lines.push(`    共享实体：${shared}`)
              }
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            ctx.companion.notice(
              'warning',
              `知识资产分析失败（原因：${error instanceof Error ? error.message : String(error)}）`,
            )
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '知识资产分析失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-insight',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'todo',
        description: '前瞻记忆：已到期与即将到期的对话意图（说过要做什么，浮现提醒）',
        handler: async (): Promise<CommandResult> => {
          try {
            await ctx.companion.ready
            await syncKnowledge(false)
            const { due, upcoming } = await dueIntentionViews(15, 8)
            if (due.length === 0 && upcoming.length === 0) {
              return {
                kind: 'success',
                text: '没有待兑现的对话意图——你的历史对话里没有「明天再做」式的承诺',
              }
            }
            const lines: string[] = []
            if (due.length > 0) {
              lines.push(`已到期意图（${due.length} 条）：`)
              for (const item of due) {
                lines.push(
                  `  ‼ [超期 ${item.overdueDays} 天] ${item.text}（来自 ${formatBeijingTime(item.createdAt)} 的对话）`,
                )
              }
            }
            if (upcoming.length > 0) {
              lines.push('')
              lines.push(`即将到期（${upcoming.length} 条）：`)
              for (const item of upcoming) {
                lines.push(
                  `  · ${item.text}（${formatBeijingTime(item.dueAt)} 到期）`,
                )
              }
            }
            lines.push('')
            lines.push('提示：兑现或放下都好——说过就忘才是最大的浪费')
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '意图提取失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-todo',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'review',
        description: '间隔重复：到期的「问题→解法」复习（review <片段ID> ok|no 评分）',
        input: { hint: '[片段ID ok|no]（缺省列出到期复习清单）' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const arg = (invocation.rawInput ?? '').trim()
          try {
            await ctx.companion.ready
            // 评分模式：review <episodeId> ok|no。
            if (arg.length > 0) {
              const match = arg.match(/^(\S+)\s+(ok|no|记得|忘了)$/)
              if (match === null) {
                return {
                  kind: 'error',
                  text: '用法：review（列出复习清单）或 review <片段ID> ok|no（评分）',
                }
              }
              const remembered = match[2] === 'ok' || match[2] === '记得'
              const result = await gradeEpisode(match[1], remembered)
              const verdict = remembered ? '记得' : '忘了'
              const easePart =
                Math.abs(result.ease - 1) >= 0.05 ? `，节律 ×${result.ease.toFixed(2)}` : ''
              return {
                kind: 'success',
                text: `已记录「${verdict}」——下次复习在 ${result.nextIntervalDays} 天后（档位 ${result.stage}/${INTERVALS_DAYS.length - 1}${easePart}）`,
              }
            }
            // 清单模式：今日负荷计划（轴线 25 分诊后的到期复习）。
            await syncKnowledge(false)
            const plan = todayLoad()
            if (plan.today.length === 0) {
              return { kind: 'success', text: '没有到期的复习——你的「问题→解法」记忆都在保鲜期内' }
            }
            const lines: string[] = [
              `今日复习安排（${plan.totalDue} 条到期，精选 ${plan.today.length} 条${plan.deferredCount > 0 ? `，顺延 ${plan.deferredCount} 条` : ''}）——先回忆解法再看答案：`,
            ]
            for (const item of plan.today) {
              lines.push('')
              lines.push(`  [${item.reason}] ${item.review.problem}`)
              lines.push(`  解法：${item.review.solution}`)
              lines.push(`  ID: ${item.review.episodeId}（review <ID> ok|no 评分）`)
            }
            if (plan.deferredCount > 0) {
              lines.push('')
              lines.push(`（${plan.deferredCount} 条已顺延到明日计划——注意力留给救得回来的知识）`)
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '复习调度失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-review',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'analogy',
        description: '类比检索：按问题结构形状找同构历史经验（跨域迁移）',
        input: { hint: '<当前问题的描述>' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const queryText = (invocation.rawInput ?? '').trim()
          if (queryText.length === 0) {
            return {
              kind: 'error',
              text: '用法：analogy <问题描述>（如 analogy 容器间服务互相访问超时）',
            }
          }
          try {
            await ctx.companion.ready
            await syncKnowledge(false)
            const report = await analogySearch(queryText)
            const lines: string[] = [`类比检索：${report.summary}`]
            if (report.queryShape.constraints.length > 0) {
              lines.push(`问题结构：[${report.queryShape.constraints.join('/')}]`)
            }
            for (const hit of report.analogies) {
              lines.push('')
              lines.push(
                `  ${hit.crossDomain ? '★ 跨域类比' : '· 同域先例'}（相似度 ${hit.score.toFixed(2)}，共享约束 ${hit.sharedConstraints.join('/') || '无'}）`,
              )
              lines.push(`  问题：${hit.problem}`)
              lines.push(`  解法：${hit.solution}`)
              lines.push(`  来源：${hit.title ?? hit.sessionId}（${formatBeijingTime(hit.createdAt)}）`)
            }
            if (report.analogies.length === 0) {
              lines.push('提示：描述里带上问题类型关键词（报错/超时/依赖/版本/内存）类比会更准')
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '类比检索失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-analogy',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'forecast',
        description: '遗忘预测：全库记忆保持率体检（深度遗忘区/滑落区/健康区分桶）',
        handler: async (): Promise<CommandResult> => {
          try {
            await ctx.companion.ready
            await syncKnowledge(false)
            const report = forecastView()
            const lines: string[] = [`遗忘预测：${report.summary}`]
            if (report.critical.length > 0) {
              lines.push('')
              lines.push(`⚠ 深度遗忘区（保持率 <30%，共 ${report.criticalCount} 条）：`)
              for (const item of report.critical) {
                lines.push(
                  `  [保持率 ${Math.round(item.retention * 100)}%] ${item.problem}（${formatBeijingTime(item.createdAt)}）`,
                )
              }
            }
            if (report.warning.length > 0) {
              lines.push('')
              lines.push(`↘ 滑落区（30–70%，正值最佳巩固窗口，共 ${report.warningCount} 条）：`)
              for (const item of report.warning) {
                const eta =
                  item.daysToThreshold > 0
                    ? `约 ${Math.ceil(item.daysToThreshold)} 天后跌入深度遗忘`
                    : '即将跌入深度遗忘'
                lines.push(
                  `  [保持率 ${Math.round(item.retention * 100)}%，${eta}] ${item.problem}`,
                )
              }
            }
            if (report.critical.length === 0 && report.warning.length === 0) {
              lines.push('')
              lines.push(`✓ ${report.stableCount} 条知识保持健康（≥70%）——记忆状态良好`)
            } else {
              lines.push('')
              lines.push(`✓ 另有 ${report.stableCount} 条保持健康（≥70%）`)
              lines.push('提示：滑落区的知识抢救成本最低——运行 review 开始今日巩固')
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '遗忘预测失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-forecast',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'rhythm',
        description: '记忆节律：个体遗忘速度画像（间隔如何随你的表现自适应）',
        handler: async (): Promise<CommandResult> => {
          try {
            await ctx.companion.ready
            const view = rhythmView()
            const total = view.profile.remembered + view.profile.forgotten
            const lines: string[] = ['记忆节律报告（个体自适应）：', '']
            lines.push(`  ${view.summary}`)
            if (total > 0) {
              lines.push(
                `  复习样本 ${total} 次（记得 ${view.profile.remembered} / 忘了 ${view.profile.forgotten}，命中率 ${Math.round(view.hitRate * 100)}%）`,
              )
              lines.push(
                `  目标命中率 ${Math.round(view.targetHitRate * 100)}%（合意困难工作点：难到刚好，不忘光也不无聊）`,
              )
            }
            lines.push('')
            lines.push('  间隔阶梯（标准 → 你的）：')
            lines.push(
              `  ${view.ladder
                .map((step) => `${step.baseDays} → ${step.adaptedDays} 天`)
                .join(' | ')}`,
            )
            if (total < 3) {
              lines.push('')
              lines.push(`提示：再评 ${3 - total} 次复习后，节律系数开始随你的表现自适应`)
            } else {
              lines.push('')
              lines.push('提示：系数每次评分后微调——间隔自动收敛到你的遗忘曲线上')
            }
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof HttpError ? error.message : '节律报告失败，请稍后重试',
            }
          }
        },
      }),
    'companion.knowledge-command-rhythm',
  )
}

/** 解析正整数 limit 参数（缺省回退默认值；非法 400）。 */
function parseLimitParam(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new HttpError(`limit 必须是 [1, ${max}] 内的整数`, 400)
  }
  return parsed
}

/** 读取 JSON 对象请求体（非对象 → 400）。 */
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

/** 解析趋势窗口天数参数（缺省回退默认值；非法 400）。 */
function parseDaysParam(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_TREND_DAYS
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TREND_DAYS) {
    throw new HttpError(`days 必须是 [1, ${MAX_TREND_DAYS}] 内的整数`, 400)
  }
  return parsed
}
