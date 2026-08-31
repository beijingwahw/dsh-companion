/**
 * 知识演化追踪（轴线 17）：跨时间的信念版本化——「你的知识过期了吗」。
 *
 * 设计动机：历史对话是会累积过期的知识资产。同一个技术问题在三月和
 * 八月得到的答案可能完全不同（版本迁移、价格调整、API 变更），而
 * 现有检索只按相关度返回「某一个」答案——用户无从知道「这个答案
 * 后来被推翻过」。
 *
 * 本模块在合成模块（G）的块级证据之上做纯本地冲突检测：
 *
 * - **声明提取**：从每个证据块提取轻量声明——主题锚（技术专名，
 *   复用实体形状启发）+ 版本号 + 关键数值（无需 LLM）；
 * - **演化事件**：两个证据块共享主题锚、但版本号或数值不同 →
 *   一次「信念变化」事件（旧值 → 新值，含双方时间戳与来源会话）；
 * - **版本语义排序**：v2.10 > v2.9（语义化版本比较，非字典序），
 *   据此判定方向（升级/回退/变化）；
 * - **时间线**：按时间升序的事件序列，最新信念排在最后——
 *   「你现在应该相信什么」一目了然。
 *
 * 与轴 15（解释单条命中）不同，本模块回答的是跨会话知识资产的
 * **时效性**问题：答案不是错的，只是旧了。
 */
import { tokenize } from '../retrieval/tokenize.js';
/**
 * 版本号提取（两类形态，双 pattern）：
 * - v 前缀任意段数：v2、v1.2、v1.2.3（v20 是版本，20 不是）；
 * - 无 v 前缀必须多段：2.0、18.04（单段纯数字归数值声明，如「30 秒」）。
 */
const VERSION_PATTERNS = [
    /(?:^|[^\w.])(v\d+(?:\.\d+){0,3})(?=$|[^\w.])/gi,
    /(?:^|[^\w.])(\d+(?:\.\d+){1,3})(?=$|[^\w.])/g,
];
/** 数值提取：独立数值（含小数；排除版本号已消费的片段）。 */
const NUMBER_PATTERN = /(?:^|[^\w.])(\d+(?:\.\d+)?)(?=$|[^\w.])/g;
/** 主题锚候选的最低词频（单现词不足以构成主题）。 */
const ANCHOR_MIN_TOKEN_LENGTH = 2;
/** 单块提取的声明上限（长块的尾部噪声截断）。 */
const MAX_CLAIMS_PER_CHUNK = 8;
/** 共享主题锚判定的最低字符长度（过滤过短的公共词）。 */
const ANCHOR_MIN_SHARED_LENGTH = 2;
/**
 * 分析证据块的信念演化：提取声明 → 锚定比较 → 生成事件时间线。
 * 纯函数；输入通常来自合成模块的块级检索（同主题的跨会话证据）。
 *
 * @param inputs 同主题的证据块（任意顺序；内部按时间排序）。
 * @returns 演化报告（事件按时间升序）。
 */
export function analyzeEvolution(inputs) {
    if (inputs.length < 2) {
        return { events: [], summary: '证据不足：跨会话演化分析需要至少两个时间点的证据' };
    }
    const ordered = [...inputs].sort((a, b) => a.createdAt - b.createdAt);
    // 逐块提取声明（含来源回指）。
    const claims = ordered.flatMap((input) => extractClaims(input.text).map((claim) => ({ claim, source: input })));
    if (claims.length === 0) {
        return { events: [], summary: '未在证据中检测到可比较的版本号或数值声明' };
    }
    // 按主题锚分组；组内两两比较生成演化事件（时间早者为旧信念）。
    const byAnchor = new Map();
    for (const entry of claims) {
        const group = byAnchor.get(entry.claim.anchor);
        if (group === undefined)
            byAnchor.set(entry.claim.anchor, [entry]);
        else
            group.push(entry);
    }
    const events = [];
    const seen = new Set();
    for (const [anchor, group] of byAnchor) {
        if (group.length < 2)
            continue;
        for (let i = 0; i < group.length; i += 1) {
            for (let j = i + 1; j < group.length; j += 1) {
                const event = compareClaims(anchor, group[i], group[j]);
                if (event === undefined)
                    continue;
                // 去重：同锚同值对只保留首次（时间最早的一对即最显著演化）。
                const dedupe = `${event.anchor}:${event.from}>${event.to}`;
                if (seen.has(dedupe))
                    continue;
                seen.add(dedupe);
                events.push(event);
            }
        }
    }
    events.sort((a, b) => a.toAt - b.toAt || a.fromAt - b.fromAt);
    return { events, summary: summarize(events) };
}
/**
 * 从证据块文本提取声明：主题锚 + 版本号 + 数值。
 * 主题锚取块内与版本/数值邻近的显著词元（技术专名启发：含字母且非停用）。
 */
function extractClaims(text) {
    const claims = [];
    const versionSpans = [];
    // 1) 版本号声明（双 pattern：v 前缀任意段 / 无前缀多段）：
    //    锚 = 版本号前方的最近词元。
    for (const pattern of VERSION_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const version = match[1];
            const start = match.index ?? 0;
            versionSpans.push([start, start + match[0].length]);
            const anchor = nearestAnchor(text, start);
            if (anchor !== undefined)
                claims.push({ anchor, version });
        }
    }
    // 2) 数值声明：锚 = 数值前方的最近词元（跳过已被版本号覆盖的片段）。
    for (const match of text.matchAll(NUMBER_PATTERN)) {
        const start = match.index ?? 0;
        const inVersion = versionSpans.some(([from, to]) => start >= from && start < to);
        if (inVersion)
            continue;
        const anchor = nearestAnchor(text, start);
        if (anchor !== undefined)
            claims.push({ anchor, value: match[1] });
    }
    return claims.slice(0, MAX_CLAIMS_PER_CHUNK);
}
/**
 * 版本号/数值前方的最近主题锚词：从位置向前扫，取第一个
 * 长度 ≥ 2 的字母词元（技术专名启发；中文按 tokenize 词元处理）。
 */
function nearestAnchor(text, position) {
    const prefix = text.slice(Math.max(0, position - 40), position);
    const tokens = tokenize(prefix);
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const token = tokens[i];
        if (token.length < ANCHOR_MIN_TOKEN_LENGTH)
            continue;
        return token.toLowerCase();
    }
    return undefined;
}
/**
 * 比较同锚的两条声明：值不同 → 演化事件；值相同或缺值 → 无事件。
 * 时间早者为旧信念（from），晚者为新信念（to）。
 */
function compareClaims(anchor, a, b) {
    if (anchor.length < ANCHOR_MIN_SHARED_LENGTH)
        return undefined;
    const valueA = a.claim.version ?? a.claim.value;
    const valueB = b.claim.version ?? b.claim.value;
    if (valueA === undefined || valueB === undefined)
        return undefined;
    if (valueA === valueB)
        return undefined;
    // 同一会话内的表述差异不算演化（跨会话才是知识资产的时间维度）。
    if (a.source.sessionId === b.source.sessionId)
        return undefined;
    const [older, newer] = a.source.createdAt <= b.source.createdAt
        ? [a, b]
        : [b, a];
    const kind = older.claim.version !== undefined && newer.claim.version !== undefined
        ? compareVersions(older.claim.version, newer.claim.version)
        : 'change';
    return {
        anchor,
        kind,
        from: older.claim.version ?? older.claim.value ?? '',
        to: newer.claim.version ?? newer.claim.value ?? '',
        fromAt: older.source.createdAt,
        toAt: newer.source.createdAt,
        fromSession: older.source.sessionId,
        toSession: newer.source.sessionId,
    };
}
/**
 * 语义化版本比较：v2.10 > v2.9（数字段逐段比，非字典序）。
 * 不可比（段数差异过大等）时返回 change。
 */
export function compareVersions(a, b) {
    const parse = (version) => version
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part));
    const sa = parse(a);
    const sb = parse(b);
    if (sa.length === 0 || sb.length === 0)
        return 'change';
    const length = Math.max(sa.length, sb.length);
    for (let i = 0; i < length; i += 1) {
        const da = sa[i] ?? 0;
        const db = sb[i] ?? 0;
        // a 为旧值、b 为新值：旧 < 新 → upgrade；旧 > 新 → downgrade。
        if (da < db)
            return 'upgrade';
        if (da > db)
            return 'downgrade';
    }
    return 'change';
}
/** 人话摘要：事件计数 + 最新一次演化的方向与值。 */
function summarize(events) {
    if (events.length === 0) {
        return '未检测到信念变化：各时间点的版本号与数值陈述一致';
    }
    const latest = events[events.length - 1];
    const direction = latest.kind === 'upgrade' ? '升级' : latest.kind === 'downgrade' ? '回退' : '变化';
    const heads = events
        .slice(0, 3)
        .map((event) => `${event.anchor}: ${event.from}→${event.to}`)
        .join('；');
    return `检测到 ${events.length} 次信念演化（${heads}${events.length > 3 ? '…' : ''}）；最新：${latest.anchor} ${direction}为 ${latest.to}——旧答案未必错误，但已有更新版本`;
}
