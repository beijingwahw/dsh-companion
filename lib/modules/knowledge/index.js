import { HttpError, sendJson } from '../../core/http.js';
import { SessionId } from '../../core/ids.js';
import { formatBeijingTime } from '../../core/time.js';
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js';
import { dueIntentions, extractIntentions, sanitizeIntentionRecord, upcomingIntentions, } from '../../core/cognition/prospective.js';
import { extractEpisodes, sanitizeEpisodeRecord, } from '../../core/cognition/episodes.js';
import { dueReviews, gradeReview, INTERVALS_DAYS, sanitizeReviewState, } from '../../core/cognition/spaced.js';
import { forecastForgetting, retentionIndex, } from '../../core/cognition/forecast.js';
import { emptyRhythm, projectedLadder, rhythmHitRate, rhythmSummary, sanitizeRhythmProfile, TARGET_HIT_RATE, updateRhythm, } from '../../core/cognition/rhythm.js';
import { planReviewLoad, } from '../../core/cognition/load.js';
import { findAnalogies } from '../../core/cognition/analogy.js';
import { composePulse, consolidationInsights, dueIntentionInsights, dueReviewInsights, driftInsights, echoRadarInsights, episodeInsights, forgettingForecastInsights, loadInsights, rhythmInsights, } from '../../core/insights/pulse.js';
import { buildEntityGraph } from '../../core/graph/graph.js';
import { detectCommunities } from '../../core/graph/louvain.js';
import { personalizedPageRank, seedFromQuery, } from '../../core/graph/ppr.js';
import { detectTopicDrift } from '../../core/cognition/drift.js';
import { consolidateMemories, } from '../../core/cognition/consolidation.js';
import { excavateKnowledge, } from '../../core/cognition/archaeology.js';
import { scanSessionEchoes, } from '../../core/cognition/radar.js';
import { detectDarkMatter } from '../../core/cognition/darkmatter.js';
import { ENTITY_TYPES, entityTypeWeight, extractEntities, } from './entities.js';
import { computeEntityTrends } from './trends.js';
/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-knowledge';
/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands'];
/** 分析转录字符预算：超长会话保首尾截中段（对齐模块 B/E 的截断策略）。 */
const ANALYSIS_TRANSCRIPT_BUDGET = 80_000;
/** 截断时插入的中段提示行。 */
const ANALYSIS_TRUNCATION_NOTICE = '\n\n【内容过长，实体抽取仅覆盖首尾】\n\n';
/** 索引对账节流窗口（毫秒）。 */
const SYNC_THROTTLE_MS = 5_000;
/** 实体图谱缺省返回条数。 */
const DEFAULT_ENTITIES_LIMIT = 50;
/** 实体图谱最大返回条数。 */
const MAX_ENTITIES_LIMIT = 200;
/** 关联会话缺省返回条数。 */
const DEFAULT_RELATED_LIMIT = 5;
/** 关联会话最大返回条数。 */
const MAX_RELATED_LIMIT = 20;
/** 建议标签条数。 */
const SUGGESTED_TAGS_COUNT = 5;
/** 趋势对比窗口缺省长度（天）。 */
const DEFAULT_TREND_DAYS = 14;
/** 趋势对比窗口最大长度（天）。 */
const MAX_TREND_DAYS = 90;
/** 趋势返回条数缺省值。 */
const DEFAULT_TRENDS_LIMIT = 12;
/** 趋势返回条数上限。 */
const MAX_TRENDS_LIMIT = 50;
/** 单条标签最大长度（对齐 TagStore 的 MAX_TAG_LENGTH）。 */
const MAX_TAG_LENGTH = 32;
/** 节律档案在 knowledge-rhythm 表中的固定键。 */
const RHYTHM_PROFILE_KEY = 'profile';
/** 每日复习容量缺省值（轴线 25 认知负荷调度）。 */
const DAILY_REVIEW_CAP = 8;
/** 负荷容量参数上限（防御性：单日练习量不宜无界）。 */
const MAX_DAILY_REVIEW_CAP = 30;
/** 知识大陆缺省返回块数（轴线 26）。 */
const DEFAULT_CONTINENTS_LIMIT = 8;
/** 知识大陆最大返回块数。 */
const MAX_CONTINENTS_LIMIT = 20;
/** 每块大陆展示的成员实体数上限。 */
const CONTINENT_ENTITY_CAP = 12;
/** 星图导航缺省返回实体数（轴线 27）。 */
const DEFAULT_STARMAP_LIMIT = 15;
/** 星图导航最大返回实体数。 */
const MAX_STARMAP_LIMIT = 50;
/** 星图查询最大长度。 */
const STARMAP_QUERY_MAX_CHARS = 200;
/** 主题漂移期望段长缺省值（单元 = 会话；轴线 30）。 */
const DEFAULT_DRIFT_LAMBDA = 16;
/** 主题漂移期望段长参数范围。 */
const MIN_DRIFT_LAMBDA = 6;
const MAX_DRIFT_LAMBDA = 96;
/** 记忆固化返回簇数上限（轴线 31）。 */
const CONSOLIDATION_CLUSTER_CAP = 20;
/** 知识考古缺省纪元数（轴线 32）。 */
const DEFAULT_ARCHAEOLOGY_WINDOWS = 4;
/** 知识考古纪元数范围。 */
const MIN_ARCHAEOLOGY_WINDOWS = 2;
const MAX_ARCHAEOLOGY_WINDOWS = 12;
/** 回声雷达回声率观察窗缺省天数（轴线 33）。 */
const DEFAULT_RADAR_DAYS = 30;
/** 回声雷达观察窗范围（天）。 */
const MIN_RADAR_DAYS = 1;
const MAX_RADAR_DAYS = 365;
/** 回声雷达返回簇数上限。 */
const RADAR_CLUSTER_CAP = 20;
/** 知识暗物质缺省返回条数（轴线 34）。 */
const DEFAULT_DARKMATTER_LIMIT = 20;
/** 知识暗物质最大返回条数。 */
const MAX_DARKMATTER_LIMIT = 50;
/** 插件入口。 */
export function apply(ctx) {
    /** 倒排表（就绪后赋值；全部端点先 await 就绪再触碰）。 */
    let table;
    /** 意图表（轴线 20；键 = sessionId）。 */
    let intentionTable;
    /** 片段表（轴线 21/22；键 = sessionId）。 */
    let episodeTable;
    /** 复习调度表（轴线 21；键 = `sessionId:hash`）。 */
    let reviewTable;
    /** 记忆节律档案（轴线 24；单记录，键 = 'profile'）。 */
    let rhythmTable;
    /** 最近一次对账完成时间（节流基准）。 */
    let lastSyncAt = 0;
    /** 在途对账 promise（并发查询去重）。 */
    let syncInFlight;
    void ctx.companion.ready
        .then(({ domain }) => {
        table = domain.table('knowledge-entities');
        intentionTable = domain.table('knowledge-intentions');
        episodeTable = domain.table('knowledge-episodes');
        reviewTable = domain.table('knowledge-review');
        rhythmTable = domain.table('knowledge-rhythm');
    })
        .catch(() => {
        // 存储域失败：核心服务已发 notice，这里仅避免未处理 rejection。
    });
    /** 按预算截断转录（保首尾 + 中段提示行）。 */
    function budgetTranscript(text) {
        if (text.length <= ANALYSIS_TRANSCRIPT_BUDGET)
            return text;
        const keepTotal = ANALYSIS_TRANSCRIPT_BUDGET - ANALYSIS_TRUNCATION_NOTICE.length;
        const headLength = Math.ceil(keepTotal / 2);
        const tailLength = keepTotal - headLength;
        return (text.slice(0, headLength) + ANALYSIS_TRUNCATION_NOTICE + text.slice(text.length - tailLength));
    }
    /** 表键前缀：会话分析版本记录。 */
    const versionKey = (sessionId) => `v/${sessionId}`;
    /** 表键前缀：实体倒排记录。 */
    const entityTableKey = (entityKeyString) => `e/${entityKeyString}`;
    /** 从损坏/旧格式记录恢复实体记录的收窄：非法记录静默丢弃。 */
    function sanitizeEntityRecord(raw) {
        if (typeof raw !== 'object' || raw === null)
            return undefined;
        const record = raw;
        if (typeof record.name !== 'string' || record.name.length === 0)
            return undefined;
        const type = record.type;
        if (typeof type !== 'string' || !ENTITY_TYPES.includes(type)) {
            return undefined;
        }
        const sessions = {};
        if (typeof record.sessions === 'object' && record.sessions !== null) {
            for (const [sid, freq] of Object.entries(record.sessions)) {
                if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0)
                    sessions[sid] = freq;
            }
        }
        return { name: record.name, type: type, sessions };
    }
    /**
     * 全表扫描装载：内存视图（实体倒排 + 会话分析版本）。
     * 表是内存权威读的 KvTable，entries() 同步返回全量键值。
     */
    function loadSnapshot() {
        const entities = new Map();
        const versions = new Map();
        if (table === undefined)
            return { entities, versions };
        for (const [key, value] of table.entries()) {
            if (key.startsWith('v/')) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    versions.set(key.slice(2), value);
                }
            }
            else if (key.startsWith('e/')) {
                const record = sanitizeEntityRecord(value);
                if (record)
                    entities.set(key.slice(2), record);
            }
        }
        return { entities, versions };
    }
    /**
     * 分析单个会话并增量更新倒排索引：
     * 旧频次（该会话在各实体记录中的 sessions[sid]）与新抽取结果做 diff，
     * 只写发生变化的实体记录——未受影响的记录零 IO。
     * 同一次转录读取同时喂三路提取（轴线 20 意图 + 轴线 21/22 片段），
     * 零额外 IO。
     */
    async function analyzeSession(sessionId, session, entities) {
        const version = session.updatedAt ?? session.createdAt;
        // 1) 收集该会话的旧频次。
        const oldFreqs = new Map();
        for (const [ekey, record] of entities) {
            const freq = record.sessions[sessionId];
            if (freq !== undefined)
                oldFreqs.set(ekey, freq);
        }
        // 2) 读取转录并抽取实体 + 意图 + 片段。
        let text;
        try {
            const snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId));
            text = budgetTranscript(formatTranscript(transcriptFromLog(snapshot), { timestamps: false }));
        }
        catch {
            // 单会话读取失败：跳过（保留旧索引），不影响其余会话。
            return false;
        }
        const extracted = extractEntities(text);
        const nextFreqs = new Map();
        for (const entity of extracted)
            nextFreqs.set(entity.key, entity);
        // 2a) 前瞻记忆（轴线 20）：意图提取（无意图 → 清掉旧记录）。
        const intentions = extractIntentions(text);
        if (intentions.length > 0) {
            await intentionTable?.put(sessionId, { createdAt: session.createdAt, intentions });
        }
        else {
            await intentionTable?.delete(sessionId);
        }
        // 2b) 认知片段（轴线 21/22）：问题→解决提取（无片段 → 清掉旧记录）。
        const episodes = extractEpisodes(text);
        if (episodes.length > 0) {
            await episodeTable?.put(sessionId, { createdAt: session.createdAt, episodes });
        }
        else {
            await episodeTable?.delete(sessionId);
        }
        // 3) Diff 更新：频次不变的记录不触碰。
        const allKeys = new Set([...oldFreqs.keys(), ...nextFreqs.keys()]);
        for (const ekey of allKeys) {
            const entity = nextFreqs.get(ekey);
            const newFreq = entity?.freq ?? 0;
            const oldFreq = oldFreqs.get(ekey) ?? 0;
            if (newFreq === oldFreq)
                continue;
            let record = entities.get(ekey);
            if (record === undefined) {
                if (entity === undefined)
                    continue;
                record = { name: entity.name, type: entity.type, sessions: {} };
                entities.set(ekey, record);
            }
            // display 名随最近一次分析刷新（众数原形可能变化）。
            if (entity !== undefined)
                record.name = entity.name;
            if (newFreq > 0)
                record.sessions[sessionId] = newFreq;
            else
                delete record.sessions[sessionId];
            const tableKey = entityTableKey(ekey);
            if (Object.keys(record.sessions).length === 0) {
                entities.delete(ekey);
                await table?.delete(tableKey);
            }
            else {
                await table?.put(tableKey, record);
            }
        }
        await table?.put(versionKey(sessionId), version);
        return true;
    }
    /**
     * 索引对账（增量同步，对齐模块 E 的节流与在途去重策略）：
     * - 已消失会话 → 删除版本记录并从全部实体记录移除其频次；
     * - 新会话或版本漂移 → 重读转录重分析（增量 diff 落盘）；
     * - force=true 时清空全部状态后全量重建（reanalyze 入口）。
     */
    async function syncKnowledge(force) {
        if (table === undefined)
            throw new HttpError('知识索引尚未就绪', 503);
        if (!force &&
            syncInFlight === undefined &&
            Date.now() - lastSyncAt < SYNC_THROTTLE_MS) {
            const snapshot = loadSnapshot();
            return {
                sessions: snapshot.versions.size,
                entities: snapshot.entities.size,
                updated: 0,
                removed: 0,
            };
        }
        if (syncInFlight !== undefined)
            return syncInFlight;
        syncInFlight = (async () => {
            const sessions = await ctx.sessionQuery.listSessions();
            const live = new Map();
            for (const session of sessions)
                live.set(String(session.id), session);
            if (force) {
                // 全量重建：清空版本与实体记录后重新分析全部会话。
                for (const key of table.keys())
                    await table.delete(key);
            }
            const { entities, versions } = loadSnapshot();
            // 1) 死会话清理（实体 + 意图 + 片段 + 复习状态一并清）。
            let removed = 0;
            for (const sessionId of [...versions.keys()]) {
                if (live.has(sessionId))
                    continue;
                await table.delete(versionKey(sessionId));
                versions.delete(sessionId);
                for (const [ekey, record] of [...entities.entries()]) {
                    if (record.sessions[sessionId] === undefined)
                        continue;
                    delete record.sessions[sessionId];
                    const tableKey = entityTableKey(ekey);
                    if (Object.keys(record.sessions).length === 0) {
                        entities.delete(ekey);
                        await table.delete(tableKey);
                    }
                    else {
                        await table.put(tableKey, record);
                    }
                }
                await intentionTable?.delete(sessionId);
                await episodeTable?.delete(sessionId);
                // 复习状态键为 `sessionId:hash`：前缀匹配清理。
                if (reviewTable !== undefined) {
                    const prefix = `${sessionId}:`;
                    for (const key of reviewTable.keys()) {
                        if (key.startsWith(prefix))
                            await reviewTable.delete(key);
                    }
                }
                removed += 1;
            }
            // 2) 新会话 / 版本漂移会话重分析。
            let updated = 0;
            for (const [sessionId, session] of live) {
                const version = session.updatedAt ?? session.createdAt;
                if (!force && versions.get(sessionId) === version)
                    continue;
                if (await analyzeSession(sessionId, session, entities)) {
                    versions.set(sessionId, version);
                    updated += 1;
                }
            }
            lastSyncAt = Date.now();
            return {
                sessions: versions.size,
                entities: entities.size,
                updated,
                removed,
            };
        })();
        try {
            return await syncInFlight;
        }
        finally {
            syncInFlight = undefined;
        }
    }
    /** 读取某会话的实体视图（含全局统计）；须在 syncKnowledge 之后调用。 */
    function sessionEntitiesOf(sessionId, analyzedSessions) {
        const { entities } = loadSnapshot();
        const views = [];
        for (const record of entities.values()) {
            const freq = record.sessions[sessionId];
            if (freq === undefined || freq <= 0)
                continue;
            const df = Object.keys(record.sessions).length;
            // IDF：稀有实体（覆盖会话少）在全局图谱中更显著。
            const idf = Math.log(1 + analyzedSessions / (1 + df));
            views.push({
                name: record.name,
                type: record.type,
                freq,
                score: Number((freq * entityTypeWeight(record.type) * (1 + idf)).toFixed(4)),
                globalSessionCount: df,
            });
        }
        views.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        return views;
    }
    /** 计算与目标会话最相关的其他会话（实体重叠 + IDF 加权 + 余弦式归一）。 */
    async function relatedSessionsOf(sessionId, limit) {
        const { entities } = loadSnapshot();
        // 目标实体键集与各会话的实体键集（一次遍历构建）。
        const targetKeys = new Set();
        const sessionKeyCount = new Map();
        /** ekey → 覆盖会话集合（df 缓存）。 */
        const entityDf = new Map();
        for (const [ekey, record] of entities) {
            const sids = Object.keys(record.sessions);
            entityDf.set(ekey, sids.length);
            if (record.sessions[sessionId] !== undefined)
                targetKeys.add(ekey);
            for (const sid of sids) {
                sessionKeyCount.set(sid, (sessionKeyCount.get(sid) ?? 0) + 1);
            }
        }
        if (targetKeys.size === 0)
            return [];
        // 候选会话 → 共享实体及贡献分。
        const candidates = new Map();
        for (const [ekey, record] of entities) {
            if (!targetKeys.has(ekey))
                continue;
            const df = entityDf.get(ekey) ?? 1;
            // IDF 权重：稀有实体的重叠更说明"在谈同一件事"。
            const weight = 1 + 1 / Math.max(1, df);
            for (const sid of Object.keys(record.sessions)) {
                if (sid === sessionId)
                    continue;
                const entry = candidates.get(sid) ?? { score: 0, shared: [] };
                entry.score += weight;
                entry.shared.push({ name: record.name, type: record.type, weight });
                candidates.set(sid, entry);
            }
        }
        const targetSize = targetKeys.size;
        const related = [];
        for (const [sid, entry] of candidates) {
            const otherSize = sessionKeyCount.get(sid) ?? 1;
            // 余弦式归一：除以两实体集规模的几何平均，避免实体多的会话占尽便宜。
            const normalized = entry.score / Math.sqrt(targetSize * Math.max(1, otherSize));
            entry.shared.sort((a, b) => b.weight - a.weight);
            related.push({
                sessionId: sid,
                createdAt: 0,
                score: Number(normalized.toFixed(4)),
                sharedEntities: entry.shared.slice(0, 5).map(({ name, type }) => ({ name, type })),
            });
        }
        related.sort((a, b) => b.score - a.score);
        // 会话头信息（title/createdAt）从 listSessions 补齐。
        try {
            const sessions = await ctx.sessionQuery.listSessions();
            const headers = new Map();
            for (const session of sessions)
                headers.set(String(session.id), session);
            for (const hit of related) {
                const header = headers.get(hit.sessionId);
                if (header) {
                    hit.title = header.title;
                    hit.createdAt = header.createdAt;
                }
            }
        }
        catch {
            // 头信息补齐失败：保留零值 createdAt，不阻塞相似度结果。
        }
        return related.slice(0, limit);
    }
    /**
     * 主题趋势（轴线 7）：近 N 天 vs 上一等长窗口的实体动量与方向，
     * 附最近 8 周逐周覆盖会话数。时间基准取会话 createdAt。
     */
    async function entityTrendsOf(days, limit) {
        const { entities } = loadSnapshot();
        const records = [...entities.values()].map((record) => ({
            name: record.name,
            type: record.type,
            sessions: record.sessions,
        }));
        const sessionTimes = new Map();
        try {
            const sessions = await ctx.sessionQuery.listSessions();
            for (const session of sessions) {
                sessionTimes.set(String(session.id), session.createdAt);
            }
        }
        catch {
            // 头信息失败：无时间信号的实体自动剔除，不阻塞其余结果。
        }
        return computeEntityTrends({ records, sessionTimes, now: Date.now(), days }).slice(0, limit);
    }
    // ------------------------------------------------------------------
    // 认知三轴（轴线 20/21/22）：意图 / 复习 / 类比的服务函数
    // ------------------------------------------------------------------
    /** 装载意图快照（表 → 内存 Map；净化非法记录）。 */
    function loadIntentions() {
        const intentions = new Map();
        if (intentionTable === undefined)
            return intentions;
        for (const [sessionId, raw] of intentionTable.entries()) {
            const record = sanitizeIntentionRecord(raw);
            if (record && record.intentions.length > 0)
                intentions.set(sessionId, record);
        }
        return intentions;
    }
    /** 装载片段快照（表 → 内存 Map；净化非法记录）。 */
    function loadEpisodes() {
        const episodes = new Map();
        if (episodeTable === undefined)
            return episodes;
        for (const [sessionId, raw] of episodeTable.entries()) {
            const record = sanitizeEpisodeRecord(raw);
            if (record && record.episodes.length > 0)
                episodes.set(sessionId, record);
        }
        return episodes;
    }
    /** 装载复习状态快照（表 → 内存 Map；净化非法记录）。 */
    function loadReviews() {
        const states = new Map();
        if (reviewTable === undefined)
            return states;
        for (const [episodeId, raw] of reviewTable.entries()) {
            const state = sanitizeReviewState(raw);
            if (state)
                states.set(episodeId, state);
        }
        return states;
    }
    /** 装载记忆节律档案（单记录；非法/缺失返回空档案冷启动）。 */
    function loadRhythm() {
        if (rhythmTable === undefined)
            return emptyRhythm();
        const profile = sanitizeRhythmProfile(rhythmTable.get(RHYTHM_PROFILE_KEY));
        return profile ?? emptyRhythm();
    }
    /** 会话头信息（title 补齐用；失败返回空映射不阻塞）。 */
    async function sessionHeaders() {
        const headers = new Map();
        try {
            const sessions = await ctx.sessionQuery.listSessions();
            for (const session of sessions)
                headers.set(String(session.id), session);
        }
        catch {
            // 头信息补齐失败：命中保留 sessionId，不阻塞认知结果。
        }
        return headers;
    }
    /** 到期意图视图（带会话标题补齐）。 */
    async function dueIntentionViews(maxDue = 20, maxUpcoming = 10) {
        const records = loadIntentions();
        const now = Date.now();
        const due = [...dueIntentions(records, now, maxDue)];
        const upcoming = [...upcomingIntentions(records, now, maxUpcoming)];
        return { due, upcoming };
    }
    /** 到期复习视图。 */
    function dueReviewViews(maxReturned = 15) {
        return [...dueReviews(loadEpisodes(), loadReviews(), Date.now(), maxReturned)];
    }
    /** 认知总览（客户端认知面板的单次拉取：意图 + 复习 + 元认知三轴）。 */
    async function cognitionOverview() {
        const [intentions, episodes, reviews] = [loadIntentions(), loadEpisodes(), loadReviews()];
        const rhythm = loadRhythm();
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
        };
    }
    /**
     * 复习评分（轴线 21 + 24 闭环）：episodeId 必须存在于片段索引。
     * 评分同时更新记忆节律（命中率 → ease），下次间隔按新节律排定。
     */
    async function gradeEpisode(episodeId, remembered) {
        if (reviewTable === undefined)
            throw new HttpError('复习调度表尚未就绪', 503);
        const separator = episodeId.indexOf(':');
        if (separator <= 0 || separator >= episodeId.length - 1) {
            throw new HttpError('episodeId 格式非法（应为 会话ID:片段哈希）', 400);
        }
        const sessionId = episodeId.slice(0, separator);
        const record = loadEpisodes().get(sessionId);
        const exists = record !== undefined && record.episodes.some((episode) => `${sessionId}:${episode.id}` === episodeId);
        if (!exists) {
            throw new HttpError('episodeId 不在片段索引中（可能已被重新分析），请刷新复习清单', 404);
        }
        const states = loadReviews();
        const previous = states.get(episodeId) ?? {
            episodeId,
            lastReviewedAt: null,
            stage: 0,
        };
        const now = Date.now();
        const rhythm = loadRhythm();
        const result = gradeReview(previous, remembered, now, rhythm.ease);
        await reviewTable.put(episodeId, result.state);
        // 节律闭环（轴线 24）：本次评分计入命中率，系数按偏差调整。
        const nextRhythm = updateRhythm(rhythm, remembered, now);
        await rhythmTable?.put(RHYTHM_PROFILE_KEY, nextRhythm);
        return {
            stage: result.state.stage,
            nextDueAt: result.nextDueAt,
            nextIntervalDays: result.nextIntervalDays,
            ease: nextRhythm.ease,
        };
    }
    /** 遗忘预测视图（轴线 23）：用当前节律系数重算全库保持率。 */
    function forecastView() {
        return forecastForgetting(loadEpisodes(), loadReviews(), Date.now(), loadRhythm().ease);
    }
    /** 记忆节律视图（轴线 24）：档案 + 摘要 + 投影间隔阶梯。 */
    function rhythmView() {
        const profile = loadRhythm();
        return {
            profile,
            summary: rhythmSummary(profile),
            hitRate: rhythmHitRate(profile),
            targetHitRate: TARGET_HIT_RATE,
            ladder: projectedLadder(profile.ease),
        };
    }
    /**
     * 今日负荷计划（轴线 25）：到期复习 × 遗忘预测 → 可救性分诊
     * → 每日封顶。到期清单放宽到 200 条（洪峰也要有全局视野才能分诊）。
     */
    function todayLoad(cap = DAILY_REVIEW_CAP) {
        const episodes = loadEpisodes();
        const states = loadReviews();
        const now = Date.now();
        const ease = loadRhythm().ease;
        const retentions = retentionIndex(episodes, states, now, ease);
        const due = [...dueReviews(episodes, states, now, 200)];
        return planReviewLoad(due, (episodeId) => retentions.get(episodeId), cap);
    }
    /** 类比检索视图（轴线 22）：带会话标题补齐。 */
    async function analogySearch(queryText) {
        const headers = await sessionHeaders();
        const titles = new Map();
        for (const [sessionId, session] of headers)
            titles.set(sessionId, session.title);
        return findAnalogies(queryText, loadEpisodes(), titles);
    }
    // ------------------------------------------------------------------
    // 认知架构 3.0 四轴（轴线 26/27/30/31）的服务函数
    // ------------------------------------------------------------------
    /** 实体共现图（轴线 26/27 共享底座）：倒排快照 → 无向带权图。 */
    function entityGraphOf() {
        const { entities } = loadSnapshot();
        const records = [...entities.entries()].map(([key, record]) => ({
            key,
            name: record.name,
            type: record.type,
            sessions: record.sessions,
        }));
        return buildEntityGraph(records);
    }
    /** 知识大陆视图（轴线 26）：Louvain 社区发现（成员实体封顶展示）。 */
    function continentsView(limit) {
        const report = detectCommunities(entityGraphOf());
        return {
            ...report,
            communities: report.communities.slice(0, limit).map((community) => ({
                id: community.id,
                size: community.size,
                sessionCount: community.sessionCount,
                internalWeight: community.internalWeight,
                topEntities: community.topEntities,
                entities: community.entities.slice(0, CONTINENT_ENTITY_CAP),
            })),
        };
    }
    /** 星图导航视图（轴线 27）：查询 → 种子实体 → PPR 多跳关联。 */
    function starMapView(queryText, limit) {
        const graph = entityGraphOf();
        const seeds = seedFromQuery(graph, queryText);
        if (seeds.size === 0) {
            return {
                query: queryText,
                seeds: [],
                nodes: [],
                summary: '查询未命中任何实体——换用实体专名（如 docker、react、useEffect）或先积累更多对话',
            };
        }
        const ranked = personalizedPageRank(graph, seeds);
        const nodes = ranked.slice(0, limit);
        const multiHop = nodes.filter((node) => !node.seed && node.hopDistance !== null && node.hopDistance > 0);
        return {
            query: queryText,
            seeds: [...seeds.keys()],
            nodes,
            summary: multiHop.length > 0
                ? `从 ${seeds.size} 个种子实体出发，引力前 ${nodes.length} 的关联中 ${multiHop.length} 个需要多跳抵达——这些是你没想到的隐性关联`
                : `从 ${seeds.size} 个种子实体出发的 ${nodes.length} 个近邻关联`,
        };
    }
    /** 主题漂移视图（轴线 30）：会话流（标题 + 实体名）上的 BOCPD 分段。 */
    async function driftView(lambda) {
        const { entities } = loadSnapshot();
        // 会话 → 实体名列表（倒排投影：零转录重读，纯内存）。
        const sessionEntityNames = new Map();
        for (const record of entities.values()) {
            for (const sessionId of Object.keys(record.sessions)) {
                const list = sessionEntityNames.get(sessionId) ?? [];
                if (list.length === 0)
                    sessionEntityNames.set(sessionId, list);
                list.push(record.name);
            }
        }
        const sessions = await ctx.sessionQuery.listSessions();
        const units = sessions.map((session) => {
            const sessionId = String(session.id);
            const entityText = (sessionEntityNames.get(sessionId) ?? []).join(' ');
            const title = session.title ?? '';
            return {
                id: sessionId,
                at: session.createdAt,
                text: `${title} ${entityText}`.trim(),
            };
        });
        return detectTopicDrift(units, { hazardLambda: lambda });
    }
    /** 记忆固化视图（轴线 31）：片段问题面 + 代表问题文本的固化计划。 */
    function consolidationView() {
        const episodes = loadEpisodes();
        const items = [];
        const problems = new Map();
        for (const [sessionId, record] of episodes) {
            for (const episode of record.episodes) {
                const id = `${sessionId}:${episode.id}`;
                problems.set(id, episode.problem);
                items.push({ id, text: episode.problem, at: record.createdAt });
            }
        }
        const plan = consolidateMemories(items);
        return {
            ...plan,
            clusters: plan.clusters.slice(0, CONSOLIDATION_CLUSTER_CAP).map((cluster) => ({
                ...cluster,
                representativeProblem: problems.get(cluster.representativeId) ?? '',
            })),
        };
    }
    /** 知识考古视图（轴线 32）：会话流时间切片 + 板块事件挖掘。 */
    async function archaeologyView(windows) {
        const { entities } = loadSnapshot();
        // 会话 → 实体键列表（倒排投影：零转录重读，纯内存）。
        const sessionEntityKeys = new Map();
        for (const [key, record] of entities) {
            for (const sessionId of Object.keys(record.sessions)) {
                const list = sessionEntityKeys.get(sessionId) ?? [];
                if (list.length === 0)
                    sessionEntityKeys.set(sessionId, list);
                list.push(key);
            }
        }
        const sessions = await ctx.sessionQuery.listSessions();
        const units = sessions.map((session) => {
            const sessionId = String(session.id);
            return {
                id: sessionId,
                at: session.createdAt,
                entityKeys: sessionEntityKeys.get(sessionId) ?? [],
            };
        });
        return excavateKnowledge(units, { windows });
    }
    /** 回声雷达视图（轴线 33）：会话级近重复聚类 + 复发周期 + 回声率。 */
    async function radarView(days) {
        const { entities } = loadSnapshot();
        // 会话 → 实体名列表（会话级文本投影：标题 + 实体名，零转录重读）。
        const sessionEntityNames = new Map();
        for (const record of entities.values()) {
            for (const sessionId of Object.keys(record.sessions)) {
                const list = sessionEntityNames.get(sessionId) ?? [];
                if (list.length === 0)
                    sessionEntityNames.set(sessionId, list);
                list.push(record.name);
            }
        }
        const sessions = await ctx.sessionQuery.listSessions();
        const titles = new Map();
        const units = sessions.map((session) => {
            const sessionId = String(session.id);
            titles.set(sessionId, session.title ?? '');
            const entityText = (sessionEntityNames.get(sessionId) ?? []).join(' ');
            return {
                id: sessionId,
                at: session.createdAt,
                text: `${session.title ?? ''} ${entityText}`.trim(),
            };
        });
        const report = scanSessionEchoes(units, { days });
        return {
            ...report,
            clusters: report.clusters.slice(0, RADAR_CLUSTER_CAP).map((cluster) => ({
                ...cluster,
                representativeTitle: titles.get(cluster.representativeId) ?? '',
            })),
        };
    }
    /** 知识暗物质视图（轴线 34）：未连接实体对的链路预测（复用大陆同源图）。 */
    function darkMatterView(limit) {
        return detectDarkMatter(entityGraphOf(), { topK: limit });
    }
    /**
     * 模块 F 主动脉搏（轴线 18 的信号源扩展：
     * 意图 + 复习 + 片段 + 元认知三轴[遗忘预测/节律/负荷]）。
     */
    async function knowledgePulse() {
        const episodes = loadEpisodes();
        const states = loadReviews();
        const now = Date.now();
        const rhythm = loadRhythm();
        const forecast = forecastForgetting(episodes, states, now, rhythm.ease);
        const retentions = retentionIndex(episodes, states, now, rhythm.ease);
        const due = [...dueReviews(episodes, states, now, 30)];
        const plan = planReviewLoad(due, (episodeId) => retentions.get(episodeId));
        const dueIntentionList = await dueIntentionViews(30, 0);
        const totalEpisodes = [...episodes.values()].reduce((sum, record) => sum + record.episodes.length, 0);
        // 跨域就绪判定：片段量足够（≥5）且约束类别多样性足够（≥3 类）。
        const constraintKinds = new Set();
        for (const record of episodes.values()) {
            for (const episode of record.episodes) {
                for (const kind of episode.shape.constraints)
                    constraintKinds.add(kind);
            }
        }
        const driftReport = await driftView(DEFAULT_DRIFT_LAMBDA);
        const consolidationReport = consolidationView();
        const radarReport = await radarView(DEFAULT_RADAR_DAYS);
        return composePulse([
            () => dueIntentionInsights(dueIntentionList.due),
            () => dueReviewInsights(due),
            () => episodeInsights({
                episodes: totalEpisodes,
                sessionsWithEpisodes: episodes.size,
                crossDomainReady: totalEpisodes >= 5 && constraintKinds.size >= 3,
            }),
            () => forgettingForecastInsights({
                criticalCount: forecast.criticalCount,
                warningCount: forecast.warningCount,
                stableCount: forecast.stableCount,
            }),
            () => rhythmInsights(rhythm),
            () => loadInsights({
                totalDue: plan.totalDue,
                todayCount: plan.today.length,
                deferredCount: plan.deferredCount,
            }),
            () => driftInsights({
                unitCount: driftReport.unitCount,
                changepoints: driftReport.changepoints.length,
                currentRunLength: driftReport.currentRunLength,
                lastUnitSurprise: driftReport.lastUnitSurprise,
                currentRunTopTerms: driftReport.currentRunTopTerms,
            }),
            () => consolidationInsights({
                items: consolidationReport.items,
                clusters: consolidationReport.clusters.length,
                duplicates: consolidationReport.duplicates,
                topReinforcement: consolidationReport.clusters[0]?.reinforcement ?? 0,
            }),
            () => echoRadarInsights({
                sessions: radarReport.sessions,
                clusters: radarReport.clusters.length,
                duplicates: radarReport.duplicates,
                templateWorthy: radarReport.clusters.filter((c) => c.action === 'template').length,
                recentEchoes: radarReport.recentEchoes,
                recentTotal: radarReport.recentTotal,
                medianRecurrenceDays: radarReport.medianRecurrenceDays,
            }),
        ], Date.now());
    }
    // ------------------------------------------------------------------
    // HTTP 端点（注册即 effect）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/status', async (_req, res) => {
        await ctx.companion.ready;
        const sync = await syncKnowledge(false);
        sendJson(res, 200, {
            sessions: sync.sessions,
            entities: sync.entities,
            updated: sync.updated,
            removed: sync.removed,
            lastSyncAt: lastSyncAt > 0 ? lastSyncAt : null,
        });
    }), 'companion.knowledge-http-status');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/entities', async (_req, res, { query }) => {
        await ctx.companion.ready;
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_ENTITIES_LIMIT, MAX_ENTITIES_LIMIT);
        const typeFilter = query.get('type');
        if (typeFilter !== null &&
            typeFilter.length > 0 &&
            !ENTITY_TYPES.includes(typeFilter)) {
            throw new HttpError(`type 必须是以下之一：${ENTITY_TYPES.join(' / ')}`, 400);
        }
        await syncKnowledge(false);
        const { entities } = loadSnapshot();
        const views = [];
        for (const record of entities.values()) {
            if (typeFilter !== null && typeFilter.length > 0 && record.type !== typeFilter)
                continue;
            const sids = Object.keys(record.sessions);
            let totalFreq = 0;
            for (const freq of Object.values(record.sessions))
                totalFreq += freq;
            views.push({
                name: record.name,
                type: record.type,
                sessionCount: sids.length,
                totalFreq,
                sampleSessions: sids.slice(0, 3),
            });
        }
        views.sort((a, b) => b.sessionCount - a.sessionCount || b.totalFreq - a.totalFreq);
        sendJson(res, 200, { entities: views.slice(0, limit) });
    }), 'companion.knowledge-http-entities');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/analyze', async (_req, res, { query }) => {
        const sessionId = (query.get('sessionId') ?? '').trim();
        if (sessionId.length === 0)
            throw new HttpError('sessionId 必填', 400);
        await ctx.companion.ready;
        const sync = await syncKnowledge(false);
        const views = sessionEntitiesOf(sessionId, Math.max(1, sync.sessions));
        // 建议标签：头部实体名（长度 ≤ 32，对齐 TagStore 规范）。
        const suggestedTags = [];
        for (const view of views) {
            if (suggestedTags.length >= SUGGESTED_TAGS_COUNT)
                break;
            const tag = view.name.trim().slice(0, MAX_TAG_LENGTH);
            if (tag.length >= 2 && !suggestedTags.includes(tag))
                suggestedTags.push(tag);
        }
        sendJson(res, 200, {
            sessionId,
            analyzed: views.length > 0,
            entities: views,
            suggestedTags,
        });
    }), 'companion.knowledge-http-analyze');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/related', async (_req, res, { query }) => {
        const sessionId = (query.get('sessionId') ?? '').trim();
        if (sessionId.length === 0)
            throw new HttpError('sessionId 必填', 400);
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_RELATED_LIMIT, MAX_RELATED_LIMIT);
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, {
            sessionId,
            related: await relatedSessionsOf(sessionId, limit),
        });
    }), 'companion.knowledge-http-related');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/trends', async (_req, res, { query }) => {
        const days = parseDaysParam(query.get('days') ?? undefined);
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_TRENDS_LIMIT, MAX_TRENDS_LIMIT);
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, {
            days,
            generatedAt: Date.now(),
            trends: await entityTrendsOf(days, limit),
        });
    }), 'companion.knowledge-http-trends');
    ctx.effect(() => ctx.companion.http.add('POST', '/knowledge/reanalyze', async (_req, res) => {
        await ctx.companion.ready;
        sendJson(res, 200, { ok: true, ...(await syncKnowledge(true)) });
    }), 'companion.knowledge-http-reanalyze');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/cognition', async (_req, res) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, await cognitionOverview());
    }), 'companion.knowledge-http-cognition');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/intentions', async (_req, res) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, await dueIntentionViews(30, 15));
    }), 'companion.knowledge-http-intentions');
    ctx.effect(() => ctx.companion.http.add('POST', '/knowledge/review/grade', async (_req, res, { body }) => {
        await ctx.companion.ready;
        const record = readBodyObject(body);
        const episodeId = requireBodyString(record.episodeId, 'episodeId');
        if (typeof record.remembered !== 'boolean') {
            throw new HttpError('remembered 必须是布尔值', 400);
        }
        sendJson(res, 200, {
            ok: true,
            ...(await gradeEpisode(episodeId, record.remembered)),
        });
    }), 'companion.knowledge-http-review-grade');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/analogy', async (_req, res, { query }) => {
        const q = (query.get('q') ?? '').trim();
        if (q.length === 0)
            throw new HttpError('q 必填（当前问题的自然语言描述）', 400);
        if (q.length > 500)
            throw new HttpError('q 不能超过 500 字符', 400);
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, await analogySearch(q));
    }), 'companion.knowledge-http-analogy');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/pulse', async (_req, res) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, await knowledgePulse());
    }), 'companion.knowledge-http-pulse');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/forecast', async (_req, res) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, forecastView());
    }), 'companion.knowledge-http-forecast');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/rhythm', async (_req, res) => {
        await ctx.companion.ready;
        sendJson(res, 200, rhythmView());
    }), 'companion.knowledge-http-rhythm');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/load', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const cap = parseLimitParam(query.get('cap') ?? undefined, DAILY_REVIEW_CAP, MAX_DAILY_REVIEW_CAP);
        sendJson(res, 200, todayLoad(cap));
    }), 'companion.knowledge-http-load');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/continents', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_CONTINENTS_LIMIT, MAX_CONTINENTS_LIMIT);
        sendJson(res, 200, continentsView(limit));
    }), 'companion.knowledge-http-continents');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/starmap', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const queryText = (query.get('q') ?? '').trim().slice(0, STARMAP_QUERY_MAX_CHARS);
        if (queryText.length === 0) {
            throw new HttpError('q 必须是非空查询串', 400);
        }
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_STARMAP_LIMIT, MAX_STARMAP_LIMIT);
        sendJson(res, 200, starMapView(queryText, limit));
    }), 'companion.knowledge-http-starmap');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/drift', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const lambda = parseLambdaParam(query.get('lambda') ?? undefined);
        sendJson(res, 200, await driftView(lambda));
    }), 'companion.knowledge-http-drift');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/consolidation', async (_req, res) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        sendJson(res, 200, consolidationView());
    }), 'companion.knowledge-http-consolidation');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/archaeology', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const windows = parseWindowsParam(query.get('windows') ?? undefined);
        sendJson(res, 200, await archaeologyView(windows));
    }), 'companion.knowledge-http-archaeology');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/radar', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const days = parseRadarDaysParam(query.get('days') ?? undefined);
        sendJson(res, 200, await radarView(days));
    }), 'companion.knowledge-http-radar');
    ctx.effect(() => ctx.companion.http.add('GET', '/knowledge/darkmatter', async (_req, res, { query }) => {
        await ctx.companion.ready;
        await syncKnowledge(false);
        const limit = parseLimitParam(query.get('limit') ?? undefined, DEFAULT_DARKMATTER_LIMIT, MAX_DARKMATTER_LIMIT);
        sendJson(res, 200, darkMatterView(limit));
    }), 'companion.knowledge-http-darkmatter');
    // ------------------------------------------------------------------
    // 命令面板（与 HTTP 端点复用同一索引）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.commands.register({
        name: 'insight',
        description: '知识资产报告：全局实体图谱或单会话实体/建议标签/关联会话',
        input: { hint: '[会话ID]（缺省输出全局图谱）' },
        handler: async (invocation) => {
            const arg = (invocation.rawInput ?? '').trim();
            try {
                await ctx.companion.ready;
                if (arg.length === 0) {
                    // 全局图谱：覆盖会话数最多的头部实体。
                    const sync = await syncKnowledge(false);
                    const { entities } = loadSnapshot();
                    const views = [];
                    for (const record of entities.values()) {
                        const sids = Object.keys(record.sessions);
                        let totalFreq = 0;
                        for (const freq of Object.values(record.sessions))
                            totalFreq += freq;
                        views.push({
                            name: record.name,
                            type: record.type,
                            sessionCount: sids.length,
                            totalFreq,
                        });
                    }
                    views.sort((a, b) => b.sessionCount - a.sessionCount || b.totalFreq - a.totalFreq);
                    const lines = ['对话知识资产图谱：', ''];
                    lines.push(`已索引会话：${sync.sessions} 个，实体：${sync.entities} 个`);
                    if (views.length > 0) {
                        lines.push('');
                        lines.push('高频实体（按覆盖会话数）：');
                        for (const view of views.slice(0, 15)) {
                            lines.push(`  - [${view.type}] ${view.name}（${view.sessionCount} 个会话，累计 ${view.totalFreq} 次）`);
                        }
                    }
                    // 主题趋势（轴线 7）：近 14 天 vs 上一 14 天的注意力流向。
                    const trends = await entityTrendsOf(DEFAULT_TREND_DAYS, 10);
                    const rising = trends.filter((trend) => trend.direction === 'rising').slice(0, 5);
                    const falling = trends.filter((trend) => trend.direction === 'falling').slice(0, 3);
                    if (rising.length > 0 || falling.length > 0) {
                        lines.push('');
                        lines.push(`主题趋势（近 ${DEFAULT_TREND_DAYS} 天 vs 上一 ${DEFAULT_TREND_DAYS} 天）：`);
                        for (const trend of rising) {
                            lines.push(`  ↗ [${trend.type}] ${trend.name}（${trend.previousSessions} → ${trend.recentSessions} 个会话）`);
                        }
                        for (const trend of falling) {
                            lines.push(`  ↘ [${trend.type}] ${trend.name}（${trend.previousSessions} → ${trend.recentSessions} 个会话）`);
                        }
                    }
                    lines.push('');
                    lines.push('提示：运行 insight <会话ID> 查看单会话实体、建议标签与关联会话');
                    return { kind: 'success', text: lines.join('\n') };
                }
                const sync = await syncKnowledge(false);
                const views = sessionEntitiesOf(arg, Math.max(1, sync.sessions));
                if (views.length === 0) {
                    return { kind: 'success', text: `会话 ${arg} 暂未抽取到任何实体` };
                }
                const related = await relatedSessionsOf(arg, DEFAULT_RELATED_LIMIT);
                const lines = [`会话 ${arg} 的知识资产：`];
                lines.push('');
                lines.push('实体（按显著性）：');
                for (const view of views.slice(0, 10)) {
                    lines.push(`  - [${view.type}] ${view.name}（频次 ${view.freq}，覆盖 ${view.globalSessionCount} 个会话）`);
                }
                const tags = views
                    .map((view) => view.name.trim().slice(0, MAX_TAG_LENGTH))
                    .filter((tag) => tag.length >= 2)
                    .slice(0, SUGGESTED_TAGS_COUNT);
                if (tags.length > 0) {
                    lines.push('');
                    lines.push(`建议标签：${tags.join('、')}（可用 tag 命令应用）`);
                }
                if (related.length > 0) {
                    lines.push('');
                    lines.push('关联会话（实体重叠）：');
                    for (const hit of related) {
                        const shared = hit.sharedEntities.map((entity) => entity.name).join('、');
                        lines.push(`  - ${hit.title ?? '未命名对话'}（ID: ${hit.sessionId}，相似度 ${hit.score.toFixed(3)}）`);
                        if (shared.length > 0)
                            lines.push(`    共享实体：${shared}`);
                    }
                }
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                ctx.companion.notice('warning', `知识资产分析失败（原因：${error instanceof Error ? error.message : String(error)}）`);
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '知识资产分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-insight');
    ctx.effect(() => ctx.commands.register({
        name: 'todo',
        description: '前瞻记忆：已到期与即将到期的对话意图（说过要做什么，浮现提醒）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const { due, upcoming } = await dueIntentionViews(15, 8);
                if (due.length === 0 && upcoming.length === 0) {
                    return {
                        kind: 'success',
                        text: '没有待兑现的对话意图——你的历史对话里没有「明天再做」式的承诺',
                    };
                }
                const lines = [];
                if (due.length > 0) {
                    lines.push(`已到期意图（${due.length} 条）：`);
                    for (const item of due) {
                        lines.push(`  ‼ [超期 ${item.overdueDays} 天] ${item.text}（来自 ${formatBeijingTime(item.createdAt)} 的对话）`);
                    }
                }
                if (upcoming.length > 0) {
                    lines.push('');
                    lines.push(`即将到期（${upcoming.length} 条）：`);
                    for (const item of upcoming) {
                        lines.push(`  · ${item.text}（${formatBeijingTime(item.dueAt)} 到期）`);
                    }
                }
                lines.push('');
                lines.push('提示：兑现或放下都好——说过就忘才是最大的浪费');
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '意图提取失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-todo');
    ctx.effect(() => ctx.commands.register({
        name: 'review',
        description: '间隔重复：到期的「问题→解法」复习（review <片段ID> ok|no 评分）',
        input: { hint: '[片段ID ok|no]（缺省列出到期复习清单）' },
        handler: async (invocation) => {
            const arg = (invocation.rawInput ?? '').trim();
            try {
                await ctx.companion.ready;
                // 评分模式：review <episodeId> ok|no。
                if (arg.length > 0) {
                    const match = arg.match(/^(\S+)\s+(ok|no|记得|忘了)$/);
                    if (match === null) {
                        return {
                            kind: 'error',
                            text: '用法：review（列出复习清单）或 review <片段ID> ok|no（评分）',
                        };
                    }
                    const remembered = match[2] === 'ok' || match[2] === '记得';
                    const result = await gradeEpisode(match[1], remembered);
                    const verdict = remembered ? '记得' : '忘了';
                    const easePart = Math.abs(result.ease - 1) >= 0.05 ? `，节律 ×${result.ease.toFixed(2)}` : '';
                    return {
                        kind: 'success',
                        text: `已记录「${verdict}」——下次复习在 ${result.nextIntervalDays} 天后（档位 ${result.stage}/${INTERVALS_DAYS.length - 1}${easePart}）`,
                    };
                }
                // 清单模式：今日负荷计划（轴线 25 分诊后的到期复习）。
                await syncKnowledge(false);
                const plan = todayLoad();
                if (plan.today.length === 0) {
                    return { kind: 'success', text: '没有到期的复习——你的「问题→解法」记忆都在保鲜期内' };
                }
                const lines = [
                    `今日复习安排（${plan.totalDue} 条到期，精选 ${plan.today.length} 条${plan.deferredCount > 0 ? `，顺延 ${plan.deferredCount} 条` : ''}）——先回忆解法再看答案：`,
                ];
                for (const item of plan.today) {
                    lines.push('');
                    lines.push(`  [${item.reason}] ${item.review.problem}`);
                    lines.push(`  解法：${item.review.solution}`);
                    lines.push(`  ID: ${item.review.episodeId}（review <ID> ok|no 评分）`);
                }
                if (plan.deferredCount > 0) {
                    lines.push('');
                    lines.push(`（${plan.deferredCount} 条已顺延到明日计划——注意力留给救得回来的知识）`);
                }
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '复习调度失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-review');
    ctx.effect(() => ctx.commands.register({
        name: 'analogy',
        description: '类比检索：按问题结构形状找同构历史经验（跨域迁移）',
        input: { hint: '<当前问题的描述>' },
        handler: async (invocation) => {
            const queryText = (invocation.rawInput ?? '').trim();
            if (queryText.length === 0) {
                return {
                    kind: 'error',
                    text: '用法：analogy <问题描述>（如 analogy 容器间服务互相访问超时）',
                };
            }
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = await analogySearch(queryText);
                const lines = [`类比检索：${report.summary}`];
                if (report.queryShape.constraints.length > 0) {
                    lines.push(`问题结构：[${report.queryShape.constraints.join('/')}]`);
                }
                for (const hit of report.analogies) {
                    lines.push('');
                    lines.push(`  ${hit.crossDomain ? '★ 跨域类比' : '· 同域先例'}（相似度 ${hit.score.toFixed(2)}，共享约束 ${hit.sharedConstraints.join('/') || '无'}）`);
                    lines.push(`  问题：${hit.problem}`);
                    lines.push(`  解法：${hit.solution}`);
                    lines.push(`  来源：${hit.title ?? hit.sessionId}（${formatBeijingTime(hit.createdAt)}）`);
                }
                if (report.analogies.length === 0) {
                    lines.push('提示：描述里带上问题类型关键词（报错/超时/依赖/版本/内存）类比会更准');
                }
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '类比检索失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-analogy');
    ctx.effect(() => ctx.commands.register({
        name: 'forecast',
        description: '遗忘预测：全库记忆保持率体检（深度遗忘区/滑落区/健康区分桶）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = forecastView();
                const lines = [`遗忘预测：${report.summary}`];
                if (report.critical.length > 0) {
                    lines.push('');
                    lines.push(`⚠ 深度遗忘区（保持率 <30%，共 ${report.criticalCount} 条）：`);
                    for (const item of report.critical) {
                        lines.push(`  [保持率 ${Math.round(item.retention * 100)}%] ${item.problem}（${formatBeijingTime(item.createdAt)}）`);
                    }
                }
                if (report.warning.length > 0) {
                    lines.push('');
                    lines.push(`↘ 滑落区（30–70%，正值最佳巩固窗口，共 ${report.warningCount} 条）：`);
                    for (const item of report.warning) {
                        const eta = item.daysToThreshold > 0
                            ? `约 ${Math.ceil(item.daysToThreshold)} 天后跌入深度遗忘`
                            : '即将跌入深度遗忘';
                        lines.push(`  [保持率 ${Math.round(item.retention * 100)}%，${eta}] ${item.problem}`);
                    }
                }
                if (report.critical.length === 0 && report.warning.length === 0) {
                    lines.push('');
                    lines.push(`✓ ${report.stableCount} 条知识保持健康（≥70%）——记忆状态良好`);
                }
                else {
                    lines.push('');
                    lines.push(`✓ 另有 ${report.stableCount} 条保持健康（≥70%）`);
                    lines.push('提示：滑落区的知识抢救成本最低——运行 review 开始今日巩固');
                }
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '遗忘预测失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-forecast');
    ctx.effect(() => ctx.commands.register({
        name: 'rhythm',
        description: '记忆节律：个体遗忘速度画像（间隔如何随你的表现自适应）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                const view = rhythmView();
                const total = view.profile.remembered + view.profile.forgotten;
                const lines = ['记忆节律报告（个体自适应）：', ''];
                lines.push(`  ${view.summary}`);
                if (total > 0) {
                    lines.push(`  复习样本 ${total} 次（记得 ${view.profile.remembered} / 忘了 ${view.profile.forgotten}，命中率 ${Math.round(view.hitRate * 100)}%）`);
                    lines.push(`  目标命中率 ${Math.round(view.targetHitRate * 100)}%（合意困难工作点：难到刚好，不忘光也不无聊）`);
                }
                lines.push('');
                lines.push('  间隔阶梯（标准 → 你的）：');
                lines.push(`  ${view.ladder
                    .map((step) => `${step.baseDays} → ${step.adaptedDays} 天`)
                    .join(' | ')}`);
                if (total < 3) {
                    lines.push('');
                    lines.push(`提示：再评 ${3 - total} 次复习后，节律系数开始随你的表现自适应`);
                }
                else {
                    lines.push('');
                    lines.push('提示：系数每次评分后微调——间隔自动收敛到你的遗忘曲线上');
                }
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '节律报告失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-rhythm');
    ctx.effect(() => ctx.commands.register({
        name: 'continents',
        description: '知识大陆：实体共现图上的 Louvain 社区发现（知识自然聚成哪几块大陆）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = continentsView(DEFAULT_CONTINENTS_LIMIT);
                if (report.graph.nodes === 0) {
                    return {
                        kind: 'success',
                        text: '实体图还没有节点——先积累更多对话，让实体之间产生共现关系',
                    };
                }
                const lines = ['知识大陆（Louvain 社区发现）：', ''];
                lines.push(`  图规模：${report.graph.nodes} 个实体、${report.graph.edges} 条共现边，模块度 Q = ${report.modularity.toFixed(4)}（${report.levels} 轮聚合）`);
                if (report.communities.length === 0) {
                    lines.push('');
                    lines.push('  实体尚未形成显著的社区结构——实体间共现还太稀疏');
                    return { kind: 'success', text: lines.join('\n') };
                }
                lines.push('');
                lines.push(`大陆列表（${report.communities.length} 块，按成员数降序）：`);
                for (const community of report.communities) {
                    const tops = community.topEntities.map((entity) => entity.name).join('、');
                    lines.push(`  ◆ 大陆 ${community.id + 1}：${community.size} 个实体，覆盖 ${community.sessionCount} 个会话`);
                    if (tops.length > 0)
                        lines.push(`    核心实体：${tops}`);
                }
                lines.push('');
                lines.push('提示：运行 starmap <查询> 查看某块大陆内部的实体引力关系');
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '知识大陆发现失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-continents');
    ctx.effect(() => ctx.commands.register({
        name: 'starmap',
        description: '星图导航：从查询命中的实体出发，个性化 PageRank 浮现多跳隐性关联',
        input: { hint: '<查询词>（如：docker、react hooks、数据库连接池）' },
        handler: async (invocation) => {
            const arg = (invocation.rawInput ?? '').trim();
            if (arg.length === 0) {
                return {
                    kind: 'error',
                    text: '用法：starmap <查询词>（如 starmap docker）',
                };
            }
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const view = starMapView(arg, DEFAULT_STARMAP_LIMIT);
                const lines = [`星图导航（查询：${view.query}）：`, ''];
                if (view.seeds.length === 0) {
                    lines.push(view.summary);
                    return { kind: 'success', text: lines.join('\n') };
                }
                lines.push(`  种子实体：${view.seeds.join('、')}`);
                lines.push('');
                lines.push('引力排名（PPR 稳态分数，多跳项标 *）：');
                for (const node of view.nodes) {
                    const hop = node.seed || node.hopDistance === null
                        ? ''
                        : node.hopDistance > 1
                            ? ` [${node.hopDistance} 跳]`
                            : ' *';
                    lines.push(`  ${node.score >= view.nodes[0].score * 0.999 ? '★' : '·'} [${node.type}] ${node.name}${hop}（引力 ${(node.score * 100).toFixed(2)}%）`);
                }
                lines.push('');
                lines.push(`  ${view.summary}`);
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '星图导航失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-starmap');
    ctx.effect(() => ctx.commands.register({
        name: 'drift',
        description: '主题漂移：会话流上的 BOCPD 变点检测（注意力何时从 A 切到 B）',
        input: { hint: '[lambda]（危险率窗口，缺省 16；小 = 对切换更敏感）' },
        handler: async (invocation) => {
            const arg = (invocation.rawInput ?? '').trim();
            let lambda = DEFAULT_DRIFT_LAMBDA;
            if (arg.length > 0) {
                const parsed = Number(arg);
                if (!Number.isInteger(parsed) || parsed < MIN_DRIFT_LAMBDA || parsed > MAX_DRIFT_LAMBDA) {
                    return {
                        kind: 'error',
                        text: `lambda 必须是 [${MIN_DRIFT_LAMBDA}, ${MAX_DRIFT_LAMBDA}] 内的整数`,
                    };
                }
                lambda = parsed;
            }
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = await driftView(lambda);
                if (report.unitCount === 0) {
                    return { kind: 'success', text: '还没有可分析的会话——先积累一些对话' };
                }
                const lines = ['主题漂移报告（BOCPD 变点检测）：', ''];
                lines.push(`  样本：${report.unitCount} 个会话（词表 ${report.vocabSize} 项，λ = ${lambda}，期望运行长度 ${report.meanRunLength.toFixed(1)} 个会话）`);
                if (report.changepoints.length === 0) {
                    lines.push('');
                    lines.push('  未检测到显著主题切换——注意力保持在同一主题带内');
                }
                else {
                    lines.push('');
                    lines.push(`主题切换点（${report.changepoints.length} 处，按时间序）：`);
                    for (const cp of report.changepoints) {
                        lines.push(`  ⇄ ${formatBeijingTime(cp.at)}（置信度 ${(cp.probability * 100).toFixed(0)}%，切换强度 ${cp.jump.toFixed(2)} bit）`);
                        if (cp.beforeTerms.length > 0 || cp.afterTerms.length > 0) {
                            lines.push(`    ${cp.beforeTerms.slice(0, 5).join('、') || '（无）'} → ${cp.afterTerms.slice(0, 5).join('、') || '（无）'}`);
                        }
                    }
                }
                lines.push('');
                lines.push(`当前主题段：已持续 ${report.currentRunLength} 个会话，特征词 ${report.currentRunTopTerms.slice(0, 6).join('、') || '（无）'}`);
                lines.push(`  ${report.summary}`);
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '主题漂移分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-drift');
    ctx.effect(() => ctx.commands.register({
        name: 'consolidate',
        description: '记忆固化：MinHash-LSH 近重复检测（同一问题的多次出现聚簇强化）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const plan = consolidationView();
                if (plan.items === 0) {
                    return { kind: 'success', text: '还没有可固化的记忆片段——先积累一些「问题→解法」对话' };
                }
                const lines = ['记忆固化报告（MinHash-LSH 近重复聚类）：', ''];
                lines.push(`  片段库：${plan.items} 条，近重复簇 ${plan.clusters.length} 组，折叠冗余 ${plan.duplicates} 条（压缩率 ${(plan.compression * 100).toFixed(0)}%），唯一 ${plan.unique} 条`);
                if (plan.clusters.length > 0) {
                    lines.push('');
                    lines.push('重复簇（按强化度降序——反复出现的问题最值得先固化）：');
                    for (const cluster of plan.clusters) {
                        const problem = cluster.representativeProblem.length > 60
                            ? `${cluster.representativeProblem.slice(0, 60)}…`
                            : cluster.representativeProblem;
                        lines.push(`  ◆ [×${cluster.reinforcement}] ${problem}（紧致度 ${(cluster.cohesion * 100).toFixed(0)}%，${formatBeijingTime(cluster.firstSeenAt)} 首现）`);
                    }
                }
                lines.push('');
                lines.push(`  ${plan.summary}`);
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '记忆固化分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-consolidate');
    ctx.effect(() => ctx.commands.register({
        name: 'archaeology',
        description: '知识考古：时间切片回放知识大陆的形成史（新生/延续/分裂/合并/消亡）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = await archaeologyView(DEFAULT_ARCHAEOLOGY_WINDOWS);
                if (report.windows.length === 0) {
                    return { kind: 'success', text: report.summary };
                }
                const lines = ['知识考古报告（板块构造学）：', ''];
                for (const w of report.windows) {
                    const continents = w.continents
                        .slice(0, 3)
                        .map((c) => c.topEntities.slice(0, 3).join('/') || `${c.size} 实体`)
                        .join('、');
                    lines.push(`  纪元 ${w.index + 1}（${formatBeijingTime(w.fromAt)} 起，${w.sessions} 会话）：` +
                        `${w.continents.length} 块大陆（Q=${w.modularity.toFixed(3)}）${continents ? '：' + continents : ''}`);
                }
                if (report.events.length > 0) {
                    lines.push('');
                    lines.push('板块事件（时间序）：');
                    for (const event of report.events) {
                        lines.push(`  ◆ ${event.description}`);
                    }
                }
                lines.push('');
                lines.push(`  ${report.summary}`);
                lines.push('');
                lines.push('提示：continents 查看当前版图，drift 查看会话流级注意力切换');
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '知识考古分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-archaeology');
    ctx.effect(() => ctx.commands.register({
        name: 'radar',
        description: '回声雷达：会话级复发检测（同主题反复开会话 → 复发周期 + 固化建议）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = await radarView(DEFAULT_RADAR_DAYS);
                if (report.clusters.length === 0) {
                    return { kind: 'success', text: report.summary };
                }
                const lines = ['回声雷达报告（会话级复发检测）：', ''];
                lines.push(`  会话库：${report.sessions} 场，回声簇 ${report.clusters.length} 组，冗余 ${report.duplicates} 场` +
                    `；近 ${report.echoRateWindowDays} 天新会话回声率 ${(report.echoRate * 100).toFixed(0)}%` +
                    `（${report.recentEchoes}/${report.recentTotal}）`);
                if (report.medianRecurrenceDays !== null) {
                    lines.push(`  平均复发周期中位数：${report.medianRecurrenceDays} 天`);
                }
                lines.push('');
                lines.push('回声簇（按复发次数降序）：');
                for (const cluster of report.clusters) {
                    const title = cluster.representativeTitle || cluster.representativeId;
                    const period = cluster.recurrenceDays !== null ? `，复发周期约 ${cluster.recurrenceDays} 天` : '';
                    const action = cluster.action === 'template' ? ' → 建议固化为交接模板' : ' → 保持关注';
                    lines.push(`  ◆ [×${cluster.occurrences}] ${title}（紧致度 ${(cluster.cohesion * 100).toFixed(0)}%${period}）${action}`);
                }
                lines.push('');
                lines.push(`  ${report.summary}`);
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '回声雷达分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-radar');
    ctx.effect(() => ctx.commands.register({
        name: 'darkmatter',
        description: '知识暗物质：链路预测发现未共现但结构强关联的实体对（下一场对话该连接谁）',
        handler: async () => {
            try {
                await ctx.companion.ready;
                await syncKnowledge(false);
                const report = darkMatterView(DEFAULT_DARKMATTER_LIMIT);
                if (report.links.length === 0) {
                    return { kind: 'success', text: report.summary };
                }
                const lines = ['知识暗物质报告（缺失连接预测）：', ''];
                lines.push(`  图规模：${report.graph.nodes} 实体、${report.graph.edges} 条共现边；` +
                    `${report.candidates} 个共享邻居的未连接对` +
                    (report.budgetExhausted ? '（已达扫描预算，结果为下界）' : ''));
                lines.push('');
                lines.push('暗连接（按证据强度降序——CN/AA/RA 三指数）：');
                for (const link of report.links) {
                    lines.push(`  ◆ ${link.u} ↔ ${link.v}（共同邻居 ${link.commonNeighbors}，` +
                        `AA ${link.adamicAdar.toFixed(2)} / RA ${link.resourceAllocation.toFixed(2)}，` +
                        `融合 ${(link.score * 100).toFixed(0)}%）`);
                    if (link.evidence.length > 0) {
                        lines.push(`    证据链：${link.evidence.join('、')}`);
                    }
                }
                lines.push('');
                lines.push(`  ${report.summary}`);
                lines.push('');
                lines.push('提示：暗连接是研究建议而非事实——下一场对话值得把它们放到一起验证');
                return { kind: 'success', text: lines.join('\n') };
            }
            catch (error) {
                return {
                    kind: 'error',
                    text: error instanceof HttpError ? error.message : '知识暗物质分析失败，请稍后重试',
                };
            }
        },
    }), 'companion.knowledge-command-darkmatter');
}
/** 解析正整数 limit 参数（缺省回退默认值；非法 400）。 */
function parseLimitParam(value, fallback, max) {
    if (value === undefined || value === '')
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
        throw new HttpError(`limit 必须是 [1, ${max}] 内的整数`, 400);
    }
    return parsed;
}
/** 读取 JSON 对象请求体（非对象 → 400）。 */
function readBodyObject(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象', 400);
    }
    return body;
}
/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireBodyString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(`${field} 必须是非空字符串`, 400);
    }
    return value.trim();
}
/** 解析趋势窗口天数参数（缺省回退默认值；非法 400）。 */
function parseDaysParam(value) {
    if (value === undefined || value === '')
        return DEFAULT_TREND_DAYS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TREND_DAYS) {
        throw new HttpError(`days 必须是 [1, ${MAX_TREND_DAYS}] 内的整数`, 400);
    }
    return parsed;
}
/** 解析 BOCPD 危险率窗口参数 λ（缺省回退默认值；非法 400）。 */
function parseLambdaParam(value) {
    if (value === undefined || value === '')
        return DEFAULT_DRIFT_LAMBDA;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_DRIFT_LAMBDA || parsed > MAX_DRIFT_LAMBDA) {
        throw new HttpError(`lambda 必须是 [${MIN_DRIFT_LAMBDA}, ${MAX_DRIFT_LAMBDA}] 内的整数`, 400);
    }
    return parsed;
}
/** 解析考古纪元数参数（缺省回退默认值；非法 400；轴线 32）。 */
function parseWindowsParam(value) {
    if (value === undefined || value === '')
        return DEFAULT_ARCHAEOLOGY_WINDOWS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) ||
        parsed < MIN_ARCHAEOLOGY_WINDOWS ||
        parsed > MAX_ARCHAEOLOGY_WINDOWS) {
        throw new HttpError(`windows 必须是 [${MIN_ARCHAEOLOGY_WINDOWS}, ${MAX_ARCHAEOLOGY_WINDOWS}] 内的整数`, 400);
    }
    return parsed;
}
/** 解析回声雷达观察窗参数（缺省回退默认值；非法 400；轴线 33）。 */
function parseRadarDaysParam(value) {
    if (value === undefined || value === '')
        return DEFAULT_RADAR_DAYS;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_RADAR_DAYS || parsed > MAX_RADAR_DAYS) {
        throw new HttpError(`days 必须是 [${MIN_RADAR_DAYS}, ${MAX_RADAR_DAYS}] 内的整数`, 400);
    }
    return parsed;
}
