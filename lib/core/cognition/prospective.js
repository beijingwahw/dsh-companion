/**
 * 前瞻记忆引擎（轴线 20）： remembering to remember——对话里的未兑现意图。
 *
 * 设计动机：认知科学区分两种记忆——回溯记忆（记住过去的事）与前瞻记忆
 * （记住将来要做的事）。全部 19 条既有轴线都在做回溯记忆；但对话中
 * 每天都在产生前瞻陈述：「明天我试试这个」「下周再优化」「回头重构」。
 * 这些意图说完即沉底，没有任何产品把它们捞起来在正确的时刻浮现——
 * 于是对话历史成了一个「说过就忘」的黑洞。
 *
 * 本模块在会话转录之上做纯本地提取与到期计算：
 *
 * - **意图提取**：句子级扫描——时间标记（明天/下周/回头/TODO…）×
 *   意图信号（试试/修复/研究…）共现，问句排除（问「怎么修」不是
 *   承诺「会修」）；
 * - **到期视界**：显式时间标记映射为天数（明天=1、下周=7、下个月=30），
 *   模糊标记（回头/以后/有空）取 7 天缺省视界；
 * - **到期浮现**：`createdAt + horizonDays <= now` 即到期，超期越久
 *   严重度越高——「5 天前你说要试试 X，做了吗？」
 *
 * 红线与前 19 轴一致：零 LLM、零网络、纯函数、隐私不出域。
 */
/** 时间标记表：正则源 → 视界天数 + 显式性。 */
const TEMPORAL_MARKERS = [
    // 显式标记按粒度降序匹配（先试更长的模式避免「下周」吃掉「下个月」的歧义）。
    { source: /下个?月|next month/i, days: 30, explicit: true },
    { source: /下周|下礼拜|next week/i, days: 7, explicit: true },
    { source: /周末|weekend/i, days: 5, explicit: true },
    { source: /后天|day after tomorrow/i, days: 2, explicit: true },
    { source: /今[晚天]下午|tonight|this evening/i, days: 0, explicit: true },
    { source: /明天|tomorrow/i, days: 1, explicit: true },
    // 模糊标记：无具体日期，取一周缺省视界。
    { source: /回头|稍后|待会|之后|以后|有空|找时间|改天|later|someday/i, days: 7, explicit: false },
];
/** 意图信号动词（句子含时间标记时尚需一个意图动词才算承诺）。 */
const INTENT_VERBS = [
    /试试|试一下|试个/,
    /看看|看下|看一下/,
    /研究(?:一[下番]|研究)?/,
    /优化|修复|修一下|重构|重写/,
    /部署|上线|发布/,
    /验证|测(?:一?下|试)?|测试/,
    /写(?:个|一[个篇段]|点)/,
    /学(?:一?下|习)/,
    /搞定|处理|检查|整理/,
    /升级|更新|迁移/,
    /try|test|fix|refactor|deploy|optimize|investigate/i,
];
/** 独立 TODO 标记：单独出现即构成意图（无需动词共现）。 */
const TODO_MARKERS = [/待办/, /\bTODO\b/i, /别忘了|别忘|记得要/, /\bremind(?:er)?\b/i];
/** 单会话意图条数上限（防超长会话撑爆）。 */
const MAX_INTENTIONS_PER_SESSION = 12;
/** 意图句最大保留长度。 */
const MAX_TEXT_LENGTH = 160;
/**
 * 句子切分（中英标点 + 换行）。捕获组把终结符保留为独立元素，
 * 切分结果形如 [句, 符, 句, 符, …]——问句判定必须看终结符：
 * 普通切分会吃掉句尾「？」，让「明天怎么部署？」被误当陈述句。
 * 英文句点仅在后随空白/行尾时充当终结符（config.ts、v1.2.3、
 * 3.5 天里的点号不切分）。
 */
const SENTENCE_SPLIT = /([。！？；!?;\n]+|\.(?=\s|$))/;
/** 毫秒/天换算。 */
const DAY_MS = 24 * 3600_000;
/**
 * 从会话转录提取意图（句子级共现扫描）。
 *
 * 规则：句子含时间标记 + 意图动词（或独立 TODO 标记）→ 一条意图；
 * 问句排除（句尾 ？/?）；会话内按规范化文本去重。
 *
 * @param text 会话转录（formatTranscript 产物或原文）。
 */
export function extractIntentions(text) {
    const intentions = [];
    const seen = new Set();
    // 偶数下标是句子，紧随的奇数下标是它的终结符。
    const chunks = text.split(SENTENCE_SPLIT);
    for (let index = 0; index < chunks.length; index += 2) {
        const sentence = chunks[index].trim();
        const terminator = chunks[index + 1] ?? '';
        if (sentence.length < 4 || sentence.length > 300)
            continue;
        // 问句是求助不是承诺（「怎么修复？」≠「我会修复」）。
        const isQuestion = /[？?]/.test(terminator);
        // 独立 TODO 标记：无需动词共现；缺时间标记时取 1 天视界（待办默认尽快）。
        const todoMarker = TODO_MARKERS.find((pattern) => pattern.test(sentence));
        const hasTodo = todoMarker !== undefined;
        if (isQuestion && !hasTodo)
            continue;
        const marker = TEMPORAL_MARKERS.find((entry) => entry.source.test(sentence));
        if (marker === undefined && !hasTodo)
            continue;
        if (!hasTodo && !INTENT_VERBS.some((pattern) => pattern.test(sentence)))
            continue;
        const normalized = sentence.replace(/\s+/g, '').toLowerCase();
        if (seen.has(normalized))
            continue;
        seen.add(normalized);
        intentions.push({
            text: sentence.slice(0, MAX_TEXT_LENGTH),
            marker: marker !== undefined
                ? (sentence.match(marker.source)?.[0] ?? '')
                : (sentence.match(todoMarker ?? /TODO/)?.[0] ?? 'TODO'),
            horizonDays: marker?.days ?? 1,
            explicit: marker?.explicit ?? true,
        });
        if (intentions.length >= MAX_INTENTIONS_PER_SESSION)
            break;
    }
    return intentions;
}
/**
 * 计算到期意图：遍历全部记录，`createdAt + horizonDays` 已过即到期。
 *
 * @param records sessionId → 意图记录。
 * @param now 当前时间。
 * @param maxReturned 返回条数上限（缺省 20）。
 */
export function dueIntentions(records, now, maxReturned = 20) {
    const due = [];
    for (const [sessionId, record] of records) {
        for (const intention of record.intentions) {
            const dueAt = record.createdAt + intention.horizonDays * DAY_MS;
            if (now < dueAt)
                continue;
            due.push({
                sessionId,
                text: intention.text,
                marker: intention.marker,
                dueAt,
                overdueDays: Math.floor((now - dueAt) / DAY_MS),
                createdAt: record.createdAt,
            });
        }
    }
    // 超期越久越靠前（最被辜负的承诺优先浮现）。
    due.sort((a, b) => a.overdueDays - b.overdueDays || b.dueAt - a.dueAt);
    return due.slice(0, maxReturned);
}
/**
 * 未到期意图（即将到来）：`createdAt + horizonDays` 在未来 7 天内。
 * 与 dueIntentions 互补，构成「即将到来 / 已到期」两栏视图。
 */
export function upcomingIntentions(records, now, maxReturned = 10) {
    const upcoming = [];
    for (const [sessionId, record] of records) {
        for (const intention of record.intentions) {
            const dueAt = record.createdAt + intention.horizonDays * DAY_MS;
            if (now >= dueAt || dueAt - now > 7 * DAY_MS)
                continue;
            upcoming.push({
                sessionId,
                text: intention.text,
                marker: intention.marker,
                dueAt,
                overdueDays: 0,
                createdAt: record.createdAt,
            });
        }
    }
    upcoming.sort((a, b) => a.dueAt - b.dueAt);
    return upcoming.slice(0, maxReturned);
}
/** 存储读出的意图记录净化：非法记录静默丢弃。 */
export function sanitizeIntentionRecord(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt <= 0) {
        return undefined;
    }
    if (!Array.isArray(record.intentions))
        return undefined;
    const intentions = [];
    for (const item of record.intentions) {
        if (typeof item !== 'object' || item === null)
            continue;
        const intention = item;
        if (typeof intention.text !== 'string' || intention.text.length === 0)
            continue;
        if (typeof intention.marker !== 'string')
            continue;
        if (typeof intention.horizonDays !== 'number' || !Number.isFinite(intention.horizonDays))
            continue;
        if (typeof intention.explicit !== 'boolean')
            continue;
        intentions.push({
            text: intention.text,
            marker: intention.marker,
            horizonDays: Math.max(0, Math.min(365, Math.floor(intention.horizonDays))),
            explicit: intention.explicit,
        });
    }
    return { createdAt: record.createdAt, intentions };
}
