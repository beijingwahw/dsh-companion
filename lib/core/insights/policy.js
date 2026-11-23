/** 一日毫秒数。 */
export const INSIGHT_DAY_MS = 86_400_000;
/** 默认 feed 上限。 */
const DEFAULT_MAX_CARDS = 8;
/** 每轮新增未读提醒上限，避免信号洪峰。 */
const DEFAULT_MAX_NOTIFICATIONS = 3;
/** 严重度权重；数值越大越需要用户注意。 */
const SEVERITY_WEIGHT = {
    critical: 1_000,
    watch: 500,
    info: 100,
};
/** 通知冷却：严重度升级不受低严重度冷却限制。 */
function cooldownFor(severity, options) {
    if (severity === 'critical')
        return options.criticalCooldownMs ?? 15 * 60_000;
    if (severity === 'watch')
        return options.watchCooldownMs ?? 6 * 3_600_000;
    return options.infoCooldownMs ?? INSIGHT_DAY_MS;
}
/** FNV-1a 64 位指纹：稳定、短且无需把正文写入存储键。 */
export function insightId(card) {
    // 正文和动作文案可能包含计数并随刷新变化；同源单卡默认以 source 保持
    // 身份稳定。同源多卡（如索引空/覆盖/过期）必须提供显式 key。
    const identity = card.key ?? card.actionId ?? card.source;
    const input = `${card.category}\n${card.source}\n${identity}`;
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `ins_${hash.toString(16).padStart(16, '0')}`;
}
/** 严重度是否升级（info→watch/critical、watch→critical）。 */
function severityEscalated(current, previous) {
    if (previous === undefined)
        return false;
    return SEVERITY_WEIGHT[current] > SEVERITY_WEIGHT[previous];
}
/** 同一信号是否到了可再次提醒的时刻。 */
function shouldNotify(card, state, now, options) {
    if (state?.lastNotifiedAt === undefined)
        return true;
    if (severityEscalated(card.severity, state.lastNotifiedSeverity))
        return true;
    return now - state.lastNotifiedAt >= cooldownFor(card.severity, options);
}
/** 创建空状态；用于用户直接操作一张尚未进入 feed 的卡。 */
export function emptyInsightState(now) {
    return {
        firstSeenAt: now,
        lastSeenAt: now,
        dismissed: false,
        notificationCount: 0,
        updatedAt: now,
    };
}
/**
 * 对卡片做去重、抑制、反馈加权、排序和通知配额计算。
 * 同一 id 的多源重复卡只保留严重度更高者；通知最多三条，但 feed 仍保留
 * 其他高优先级卡片，避免“冷却”被误实现成“藏起问题”。
 */
export function applyInsightPolicy(input, previous, now, options = {}) {
    const deduplicated = new Map();
    for (const card of input) {
        const id = insightId(card);
        const incumbent = deduplicated.get(id);
        if (incumbent === undefined ||
            SEVERITY_WEIGHT[card.severity] > SEVERITY_WEIGHT[incumbent.severity]) {
            deduplicated.set(id, card);
        }
    }
    const candidates = [];
    let snoozedCount = 0;
    let dismissedCount = 0;
    for (const [id, card] of deduplicated) {
        const state = previous.get(id);
        if (state?.dismissed) {
            dismissedCount += 1;
            continue;
        }
        if ((state?.snoozeUntil ?? 0) > now) {
            snoozedCount += 1;
            continue;
        }
        const feedbackDelta = state?.feedback === 'helpful' ? 60 : state?.feedback === 'unhelpful' ? -80 : 0;
        const outcomeDelta = state?.outcome === 'acted' ? 30 : 0;
        candidates.push({
            card,
            id,
            state,
            priority: SEVERITY_WEIGHT[card.severity] + feedbackDelta + outcomeDelta,
        });
    }
    candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const nextStates = new Map(previous);
    const cards = [];
    const notifications = [];
    const maxCards = Math.max(1, Math.min(50, Math.floor(options.maxCards ?? DEFAULT_MAX_CARDS)));
    const maxNotifications = Math.max(0, Math.min(10, Math.floor(options.maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS)));
    for (const candidate of candidates) {
        const { card, id, state } = candidate;
        const base = state ?? emptyInsightState(now);
        let next = { ...base, lastSeenAt: now, updatedAt: now };
        const notify = cards.length < maxCards && notifications.length < maxNotifications &&
            shouldNotify(card, state, now, options);
        if (notify) {
            notifications.push(id);
            next = {
                ...next,
                lastNotifiedAt: now,
                lastNotifiedSeverity: card.severity,
                notificationCount: Math.min(1_000_000, base.notificationCount + 1),
            };
        }
        nextStates.set(id, next);
        if (cards.length >= maxCards)
            continue;
        const unread = (next.lastNotifiedAt ?? 0) > (next.acknowledgedAt ?? 0);
        cards.push({
            ...card,
            id,
            priority: candidate.priority,
            unread,
            firstSeenAt: next.firstSeenAt,
            lastNotifiedAt: next.lastNotifiedAt,
            notificationCount: next.notificationCount,
            feedback: next.feedback,
            outcome: next.outcome,
        });
    }
    // 对已被本次刷新压出 feed 的活动卡仍记录 lastSeenAt；suppressed 卡的状态
    // 原样保留，确保稍后/忽略不会因内容刷新被悄悄解除。
    return {
        cards,
        notifications,
        nextStates,
        activeIds: new Set(deduplicated.keys()),
        snoozedCount,
        dismissedCount,
    };
}
/** 应用单条用户反馈；所有时间字段单调且动作可逆（dismiss→restore）。 */
export function reduceInsightFeedback(previous, action, now) {
    const base = previous ?? emptyInsightState(now);
    const common = { ...base, lastSeenAt: now, updatedAt: now };
    switch (action) {
        case 'acknowledge':
            return { ...common, acknowledgedAt: now };
        case 'snooze':
            return { ...common, acknowledgedAt: now, snoozeUntil: now + INSIGHT_DAY_MS };
        case 'dismiss':
            return { ...common, acknowledgedAt: now, dismissed: true, outcome: 'dismissed' };
        case 'restore':
            return { ...common, dismissed: false, snoozeUntil: undefined, outcome: undefined };
        case 'helpful':
            return { ...common, feedback: 'helpful' };
        case 'unhelpful':
            return { ...common, feedback: 'unhelpful' };
        case 'acted':
            return { ...common, acknowledgedAt: now, outcome: 'acted' };
        case 'resolved':
            return { ...common, acknowledgedAt: now, dismissed: true, outcome: 'resolved' };
    }
}
/** 历史状态净化：90 天未再出现的普通状态可回收，用户忽略决定永久保留。 */
export function pruneInsightStates(states, activeIds, now) {
    const next = new Map();
    for (const [id, state] of states) {
        const stale = now - state.lastSeenAt > 90 * INSIGHT_DAY_MS;
        if (!activeIds.has(id) && stale && !state.dismissed)
            continue;
        next.set(id, state);
    }
    return next;
}
/** 将不可信持久化记录收窄为合法状态；损坏记录返回 undefined。 */
export function sanitizeInsightState(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const value = raw;
    const finiteTimes = ['firstSeenAt', 'lastSeenAt', 'updatedAt'];
    for (const key of finiteTimes) {
        if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
            return undefined;
        }
    }
    const optionalTimes = ['lastNotifiedAt', 'acknowledgedAt', 'snoozeUntil'];
    for (const key of optionalTimes) {
        const item = value[key];
        if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
            return undefined;
        }
    }
    if (typeof value.dismissed !== 'boolean')
        return undefined;
    if (typeof value.notificationCount !== 'number' ||
        !Number.isInteger(value.notificationCount) ||
        value.notificationCount < 0)
        return undefined;
    const severity = value.lastNotifiedSeverity;
    if (severity !== undefined && severity !== 'critical' && severity !== 'watch' && severity !== 'info') {
        return undefined;
    }
    const feedback = value.feedback;
    if (feedback !== undefined && feedback !== 'helpful' && feedback !== 'unhelpful')
        return undefined;
    const outcome = value.outcome;
    if (outcome !== undefined && outcome !== 'acted' && outcome !== 'resolved' && outcome !== 'dismissed') {
        return undefined;
    }
    return {
        firstSeenAt: value.firstSeenAt,
        lastSeenAt: value.lastSeenAt,
        lastNotifiedAt: value.lastNotifiedAt,
        lastNotifiedSeverity: severity,
        acknowledgedAt: value.acknowledgedAt,
        snoozeUntil: value.snoozeUntil,
        dismissed: value.dismissed,
        notificationCount: Math.min(1_000_000, value.notificationCount),
        feedback,
        outcome,
        updatedAt: value.updatedAt,
    };
}
