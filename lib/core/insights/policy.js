/** 一日毫秒数。 */
export const INSIGHT_DAY_MS = 86_400_000;
/** 默认 feed 上限。 */
const DEFAULT_MAX_CARDS = 8;
/** 每轮新增未读提醒上限，避免信号洪峰。 */
const DEFAULT_MAX_NOTIFICATIONS = 3;
/**
 * 语义合并缺省阈值。
 *
 * 中文卡片的主题重合度天然偏低（bigram 切分 + 大量共用虚词），实测
 * 同主题不同表述的 Jaccard 多落在 0.25–0.45；0.5 会漏合并，0.2 以下
 * 会把不同主题误并。取 0.42 作为经验拐点（测试覆盖同主题合并与
 * 异主题不合并两侧）。
 */
const DEFAULT_SEMANTIC_MERGE_THRESHOLD = 0.42;
/** 语义合并参与比较的词元上限。 */
const DEFAULT_SEMANTIC_MERGE_MAX_TERMS = 24;
/** 可信度 Beta 先验（冷启动：1 成功 / 1 失败 → 下界约 0.2）。 */
const DEFAULT_TRUST_PRIOR = 1;
/** 可信度下限：即使全被忽略也保留 15% 的排序权重（不永久静音）。 */
const DEFAULT_TRUST_FLOOR = 0.15;
/** 严重度权重；数值越大越需要用户注意。 */
const SEVERITY_WEIGHT = {
    critical: 1_000,
    watch: 500,
    info: 100,
};
/** 严重度序（数值越小越紧急）。 */
const SEVERITY_RANK = {
    critical: 0,
    watch: 1,
    info: 2,
};
/** 可打扰等级：critical 永远可打扰，watch 需窗口开放，info 需高开放度。 */
function interruptRank(severity) {
    return SEVERITY_RANK[severity];
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
/** 通知冷却：严重度升级不受低严重度冷却限制。 */
function cooldownFor(severity, options) {
    if (severity === 'critical')
        return options.criticalCooldownMs ?? 15 * 60_000;
    if (severity === 'watch')
        return options.watchCooldownMs ?? 6 * 3_600_000;
    return options.infoCooldownMs ?? INSIGHT_DAY_MS;
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
// ---------------------------------------------------------------------------
// 语义抑制：跨源同主题近似重复检测
// ---------------------------------------------------------------------------
/** 卡片文本的轻量词元化（中文按双字滑窗，Latin 按词）。 */
function topicTokens(text, cap) {
    const tokens = new Set();
    const normalized = text.toLowerCase();
    let index = 0;
    while (index < normalized.length && tokens.size < cap) {
        const code = normalized.charCodeAt(index);
        const isCjk = code >= 0x3400 && code <= 0x9fff;
        if (isCjk) {
            const next = index + 1 < normalized.length ? normalized.charCodeAt(index + 1) : 0;
            if (next >= 0x3400 && next <= 0x9fff) {
                tokens.add(normalized.slice(index, index + 2));
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if (code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39) {
            let end = index;
            while (end < normalized.length) {
                const c = normalized.charCodeAt(end);
                if (c >= 0x61 && c <= 0x7a || c >= 0x30 && c <= 0x39 || c === 0x5f || c === 0x2d)
                    end += 1;
                else
                    break;
            }
            if (end - index >= 2)
                tokens.add(normalized.slice(index, end));
            index = end;
            continue;
        }
        index += 1;
    }
    return tokens;
}
/** 两个词元集合的 Jaccard 相似度（空集按不相似处理）。 */
function jaccardOf(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const token of a) {
        if (b.has(token))
            intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/**
 * 跨源同主题合并：把「讲同一件事」的多张卡片折叠成一张代表卡。
 *
 * 代表选择：严重度最高者（信息价值上限）；同严重度取正文更长者
 * （信息密度更高）；再同则取指纹字典序最小者（全序确定性）。
 * 被吸收的卡片计入 mergedCount，不进入 feed——用户看到的是一条
 * 合并后的洞察，而不是三条同一主题的刷屏。
 */
export function mergeSemanticDuplicates(cards, threshold = DEFAULT_SEMANTIC_MERGE_THRESHOLD, maxTerms = DEFAULT_SEMANTIC_MERGE_MAX_TERMS) {
    if (cards.length === 0)
        return [];
    const tokenized = cards.map((card) => topicTokens(card.text, maxTerms));
    // 并查集：同主题卡片传递归并。
    const parent = cards.map((_, index) => index);
    const find = (index) => {
        let current = index;
        while (parent[current] !== current)
            current = parent[current];
        return current;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb)
            return;
        parent[rb] = ra;
    };
    for (let i = 0; i < cards.length; i += 1) {
        for (let j = i + 1; j < cards.length; j += 1) {
            if (jaccardOf(tokenized[i], tokenized[j]) >= threshold)
                union(i, j);
        }
    }
    const buckets = new Map();
    for (let index = 0; index < cards.length; index += 1) {
        const root = find(index);
        const bucket = buckets.get(root);
        if (bucket === undefined)
            buckets.set(root, [cards[index]]);
        else
            bucket.push(cards[index]);
    }
    const groups = [];
    for (const bucket of buckets.values()) {
        const sorted = [...bucket].sort((a, b) => {
            const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
            if (severity !== 0)
                return severity;
            const length = b.text.length - a.text.length;
            if (length !== 0)
                return length;
            return insightId(a).localeCompare(insightId(b));
        });
        groups.push({ representative: sorted[0], absorbed: sorted.slice(1) });
    }
    return groups;
}
/**
 * 信号源可信度：Wilson 置信下界（z = 1.0，约 68% 置信水平）。
 *
 * 成功 = helpful 计数；失败 = unhelpful + dismissed 计数（忽略是比
 * 「无用」更强的负信号，但不额外加权——二者都是「这条不该出现」）。
 * 加 Beta 先验伪计数（缺省各 1）保证冷启动有定义且偏保守。
 * 返回 [trustFloor, 1]，trustFloor 缺省 0.15——即使一个源被持续忽略，
 * 也保留 15% 的排序权重：不永久静音，留出「新类型的信号突然变好」
 * 的自愈通道。
 */
export function sourceTrust(counts, options = {}) {
    const successPrior = options.trustPriorSuccess ?? DEFAULT_TRUST_PRIOR;
    const failurePrior = options.trustPriorFailure ?? DEFAULT_TRUST_PRIOR;
    const floor = options.trustFloor ?? DEFAULT_TRUST_FLOOR;
    const helpful = (counts?.helpful ?? 0) + successPrior;
    const failed = (counts?.unhelpful ?? 0) + (counts?.dismissed ?? 0) + failurePrior;
    const total = helpful + failed;
    if (total <= 0)
        return 1;
    const p = helpful / total;
    const z = 1;
    const z2 = z * z;
    // Wilson 下界：p̂ + z²/2n − z√(p̂(1−p̂)/n + z²/4n²)，除以 1 + z²/n
    const denominator = 1 + z2 / total;
    const centre = p + z2 / (2 * total);
    const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
    const lower = (centre - spread) / denominator;
    return Math.min(1, Math.max(floor, lower));
}
/**
 * 对卡片列表做去重、语义合并、抑制、反馈加权、效用加权、排序和通知配额计算。
 *
 * 与 v1 的差别：
 * - 语义合并把跨源同主题卡折叠为一张（mergedCount 可观测）；
 * - 排序权重乘以 sourceTrust（per-source Wilson 下界）；
 * - 通知资格额外受节律窗口调制（feed 不受影响）。
 */
export function applyInsightPolicy(input, previous, now, options = {}, sourceFeedback) {
    const deduplicated = new Map();
    for (const card of input) {
        const id = insightId(card);
        const incumbent = deduplicated.get(id);
        if (incumbent === undefined ||
            SEVERITY_WEIGHT[card.severity] > SEVERITY_WEIGHT[incumbent.severity]) {
            deduplicated.set(id, card);
        }
    }
    // 语义抑制：跨源同主题折叠（同指纹已去重，这里处理不同指纹的重复）。
    const groups = mergeSemanticDuplicates([...deduplicated.values()], options.semanticMergeThreshold, options.semanticMergeMaxTerms);
    const mergedIntoOf = new Map();
    let mergedCount = 0;
    for (const group of groups) {
        const representativeId = insightId(group.representative);
        for (const card of group.absorbed) {
            mergedIntoOf.set(insightId(card), representativeId);
            mergedCount += 1;
        }
    }
    const trustOf = new Map();
    const trustFor = (source) => {
        const cached = trustOf.get(source);
        if (cached !== undefined)
            return cached;
        const trust = sourceTrust(sourceFeedback?.get(source), options);
        trustOf.set(source, trust);
        return trust;
    };
    // 候选构建：只保留语义合并的代表卡。
    const candidates = [];
    let snoozedCount = 0;
    let dismissedCount = 0;
    const absorbedByRepresentative = new Map();
    for (const group of groups) {
        absorbedByRepresentative.set(insightId(group.representative), group.absorbed.length);
    }
    for (const group of groups) {
        const card = group.representative;
        const id = insightId(card);
        const state = previous.get(id);
        if (state?.dismissed) {
            dismissedCount += 1 + group.absorbed.length;
            continue;
        }
        if ((state?.snoozeUntil ?? 0) > now) {
            snoozedCount += 1;
            continue;
        }
        const feedbackDelta = state?.feedback === 'helpful' ? 60 : state?.feedback === 'unhelpful' ? -80 : 0;
        const outcomeDelta = state?.outcome === 'acted' ? 30 : 0;
        const trust = trustFor(card.source);
        // 严重度权重经可信度调制：被持续忽略的源整体下沉，但保留 floor 权重。
        const priority = SEVERITY_WEIGHT[card.severity] * trust + feedbackDelta + outcomeDelta;
        candidates.push({
            card,
            id,
            state,
            priority,
            merged: group.absorbed.length,
            trust,
        });
    }
    candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const nextStates = new Map(previous);
    const cards = [];
    const notifications = [];
    let rhythmSuppressedCount = 0;
    const maxCards = Math.max(1, Math.min(50, Math.floor(options.maxCards ?? DEFAULT_MAX_CARDS)));
    const maxNotifications = Math.max(0, Math.min(10, Math.floor(options.maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS)));
    const hourOfDay = new Date(now).getHours();
    const dayOfWeek = new Date(now).getDay();
    const window = options.attentionWindow !== undefined
        ? Math.max(0, Math.min(1, options.attentionWindow(hourOfDay, dayOfWeek)))
        : 1;
    const quietMax = options.quietMaxSeverity ?? 'watch';
    for (const candidate of candidates) {
        const { card, id, state } = candidate;
        const base = state ?? emptyInsightState(now);
        let next = { ...base, lastSeenAt: now, updatedAt: now };
        const cooldownPassed = shouldNotify(card, state, now, options);
        // 节律门：可打扰等级 ≤ 窗口允许的最高等级才推送。
        const quietAllowed = interruptRank(card.severity) <= SEVERITY_RANK[quietMax];
        const windowOpen = quietAllowed || window >= 1 - interruptRank(card.severity) * 0.25;
        const notify = cards.length < maxCards && notifications.length < maxNotifications &&
            cooldownPassed && windowOpen;
        let rhythmSuppressed = false;
        if (notify) {
            notifications.push(id);
            next = {
                ...next,
                lastNotifiedAt: now,
                lastNotifiedSeverity: card.severity,
                notificationCount: Math.min(1_000_000, base.notificationCount + 1),
            };
        }
        else if (cooldownPassed && cards.length < maxCards) {
            rhythmSuppressed = true;
            rhythmSuppressedCount += 1;
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
            mergedCount: candidate.merged > 0 ? candidate.merged : undefined,
            mergedInto: mergedIntoOf.get(id),
            sourceTrust: Number(candidate.trust.toFixed(4)),
            rhythmSuppressed: rhythmSuppressed || undefined,
        });
    }
    return {
        cards,
        notifications,
        nextStates,
        activeIds: new Set(deduplicated.keys()),
        snoozedCount,
        dismissedCount,
        mergedCount,
        rhythmSuppressedCount,
        sourceTrust: trustOf,
    };
}
/** 同一信号是否到了可再次提醒的时刻。 */
function shouldNotify(card, state, now, options) {
    if (state?.lastNotifiedAt === undefined)
        return true;
    if (severityEscalated(card.severity, state.lastNotifiedSeverity))
        return true;
    return now - state.lastNotifiedAt >= cooldownFor(card.severity, options);
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
/**
 * 从持久化状态派生 per-source 反馈计数（效用学习的输入）。
 *
 * 状态表以指纹为键、不保存 source；因此本函数要求调用方提供
 * 「指纹 → source」的映射（Center 在每次刷新时从当前卡片重建）。
 */
export function aggregateSourceFeedback(states, sourceOf) {
    const counts = new Map();
    for (const [id, state] of states) {
        const source = sourceOf.get(id);
        if (source === undefined)
            continue;
        const entry = counts.get(source) ?? { helpful: 0, unhelpful: 0, dismissed: 0 };
        if (state.feedback === 'helpful')
            entry.helpful += 1;
        else if (state.feedback === 'unhelpful')
            entry.unhelpful += 1;
        if (state.outcome === 'dismissed')
            entry.dismissed += 1;
        counts.set(source, entry);
    }
    return counts;
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
