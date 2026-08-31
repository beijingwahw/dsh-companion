/**
 * 检索盲区分析（轴线 19）：知道自己不知道什么。
 *
 * 设计动机：检索系统的失败有两种——「搜到了但不好」（轴线 10 诊断、
 * 轴线 16 救援已覆盖）和「根本搜不到」反复发生却无人察觉。后者是
 * 知识资产的盲区：你反复想找某类对话，但历史里压根没有——
 * 这是「该补什么知识」的最真实信号。
 *
 * 本模块在零命中查询日志（`retrieval-misses` 表，轴线 19 新增）之上
 * 做纯本地聚合：
 *
 * - **词元级聚合**：同主题的多次失败搜索合并计数（「rust 错误处理」
 *   和「rust 错误」共享词元 rust/错误 → 同一盲区的两次敲击）；
 * - **盲区评分**：`搜索次数 × log(1 + 停留天数)` × 新近度——反复搜、
 *   最近还在搜的主题得分最高；
 * - **可行动建议**：每个盲区生成一句话建议（「这个主题在你的历史
 *   对话中不存在——是有价值的新话题，还是用词与历史习惯不一致？」）。
 *
 * 苏格拉底式的知识管理：检索系统不只想「帮你找到已知的」，
 * 还想「让你看见未知的」。
 */
/** 盲区锚词的最低字符长度（过短的词元不构成主题）。 */
const ANCHOR_MIN_LENGTH = 2;
/** 单个盲区展示的相关查询上限。 */
const QUERIES_PER_BLINDSPOT = 3;
/** 盲区列表上限（展示关注面）。 */
const MAX_BLIND_SPOTS = 8;
/** 进入盲区列表的最低搜索次数（孤例失败不值得推送）。 */
const MIN_SEARCHES = 2;
/** 停留天数计入评分的封顶（超过一年的盲区不再加权——兴趣已冷）。 */
const MAX_DWELL_DAYS = 365;
/**
 * 聚合零命中日志为盲区报告。
 *
 * 聚合策略：每条零命中查询拆词元；每个词元独立累计（次数继承自查询
 * 计数），词元即盲区锚——多主题长查询（「rust 错误处理 vs go」）会
 * 同时给 rust 和 go 两个锚记一次敲击，这正是期望的语义。
 *
 * @param records 零命中查询记录（任意顺序）。
 * @param options 时间基准。
 */
export function analyzeBlindSpots(records, options) {
    const totalMisses = records.reduce((sum, record) => sum + record.count, 0);
    if (records.length === 0) {
        return {
            totalMisses: 0,
            blindSpots: [],
            summary: '没有零命中记录：你的查询习惯与知识资产覆盖面吻合得很好',
        };
    }
    const anchors = new Map();
    for (const record of records) {
        for (const term of tokenizeTerms(record.query)) {
            if (term.length < ANCHOR_MIN_LENGTH)
                continue;
            let agg = anchors.get(term);
            if (agg === undefined) {
                agg = { searches: 0, firstAt: record.firstAt ?? record.lastAt, lastAt: 0, queries: new Map() };
                anchors.set(term, agg);
            }
            agg.searches += record.count;
            agg.firstAt = Math.min(agg.firstAt, record.firstAt ?? record.lastAt);
            agg.lastAt = Math.max(agg.lastAt, record.lastAt);
            agg.queries.set(record.query, (agg.queries.get(record.query) ?? 0) + record.count);
        }
    }
    // 评分与成型：次数 × 停留天数对数 × 新近度（90 天半衰，与轴线 11 同构）。
    // 停留时长 = lastAt - firstAt（首末跨度）：久未再搜的旧主题不会因
    // 「沉默时间长」而虚高得分——新近度因子已单独表达「最近还在搜」。
    const DAY_MS = 24 * 3600_000;
    const blindSpots = [];
    for (const [anchor, agg] of anchors) {
        if (agg.searches < MIN_SEARCHES)
            continue;
        const ageDays = Math.max(0, (options.now - agg.lastAt) / DAY_MS);
        const recency = Math.pow(2, -ageDays / 90);
        const dwellDays = Math.min(MAX_DWELL_DAYS, (agg.lastAt - agg.firstAt) / DAY_MS + 1);
        const score = agg.searches * Math.log(1 + dwellDays) * (0.25 + 0.75 * recency);
        blindSpots.push({
            anchor,
            searches: agg.searches,
            queries: [...agg.queries.keys()].slice(0, QUERIES_PER_BLINDSPOT),
            lastAt: agg.lastAt,
            score: Number(score.toFixed(3)),
            advice: adviceFor(anchor, agg.searches, ageDays),
        });
    }
    blindSpots.sort((a, b) => b.score - a.score);
    const top = blindSpots.slice(0, MAX_BLIND_SPOTS);
    return {
        totalMisses,
        blindSpots: top,
        summary: summarize(top, totalMisses),
    };
}
/** 单条零命中记录的规范化净化（存储读出后的防御性处理）。 */
export function sanitizeMissRecord(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const query = typeof record.query === 'string' ? record.query.trim() : '';
    const count = typeof record.count === 'number' ? Math.floor(record.count) : 0;
    const lastAt = typeof record.lastAt === 'number' ? record.lastAt : 0;
    if (query.length === 0 || count < 1 || lastAt <= 0)
        return undefined;
    // firstAt 可缺省（旧版记录）：仅在合法时透传，缺省交给聚合层回退 lastAt。
    const firstAt = typeof record.firstAt === 'number' ? record.firstAt : undefined;
    if (firstAt !== undefined && (firstAt <= 0 || firstAt > lastAt))
        return undefined;
    return firstAt === undefined ? { query, count, lastAt } : { query, count, firstAt, lastAt };
}
/** 查询文本词元化（小写；与检索引擎同构的拆词）。 */
function tokenizeTerms(query) {
    // 与 core/retrieval/tokenize 的 tokenize 同规则；就地轻量实现避免
    // 引入合成/检索模块的传递依赖（本文件已位于 retrieval 域内，
    // 直接复用 tokenize 亦安全——此处保留独立实现以使本模块可被
    // 任何宿主侧调度器单独引用）。
    const normalized = query.toLowerCase();
    const cjk = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
    const latin = normalized.match(/[a-z0-9][a-z0-9_.-]*/g) ?? [];
    return [...cjk, ...latin.map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))];
}
/** 盲区建议：按搜索次数与最近性给出差异化措辞。 */
function adviceFor(anchor, searches, ageDays) {
    if (searches >= 5 && ageDays <= 14) {
        return `近期反复搜索「${anchor}」均无结果——这是你当前的真实需求缺口，值得专门开一场对话补齐`;
    }
    if (searches >= 5) {
        return `历史上多次搜索「${anchor}」未果——若仍需要，考虑补齐该主题；若已不需要，说明兴趣已转移`;
    }
    return `「${anchor}」在你的历史对话中不存在——是新话题，还是用词与历史习惯不一致？`;
}
/** 人话摘要。 */
function summarize(blindSpots, totalMisses) {
    if (blindSpots.length === 0) {
        return `累计 ${totalMisses} 次零命中均为孤例——没有形成可识别的知识盲区`;
    }
    const heads = blindSpots
        .slice(0, 3)
        .map((spot) => `「${spot.anchor}」×${spot.searches}`)
        .join('、');
    return `识别出 ${blindSpots.length} 个知识盲区（搜索但无覆盖）：${heads}${blindSpots.length > 3 ? '…' : ''}——盲区即需求缺口，也是知识资产的下一次增长点`;
}
