/**
 * 间隔重复巩固（轴线 21）：艾宾浩斯遗忘曲线作用于对话知识资产。
 *
 * 设计动机：对话里找到的每个解法都是一次学习事件，而学习科学
 * 的基本事实是——不复习就遗忘（20 分钟后忘 40%，一周后忘 75%）。
 * 全部既有轴线都在帮你「找到」知识，没有任何一条帮你「保住」
 * 知识。Anki 用卡片做到了这一点；本模块用对话历史做同样的事：
 *
 * - **复习卡片**：问题→解决片段（episodes.ts 的产物）即天然卡片——
 *   正面是问题，背面是解法；
 * - **间隔调度**：SM2 精简版——1/3/7/14/30/60 天阶梯间隔，
 *   「记得」升档、「忘了」归零；
 * - **检索式练习**：复习不是重读而是回想——先看问题回忆解法，
 *   再展开核对。认知科学证明这是长期记忆最强的巩固手段。
 *
 * 与轴线 18 的关系：到期复习是主动洞察的天然信号源（复习压力
 * → 脉搏卡片），「该复习了」由系统说而不是你记得说。
 */
/** 间隔阶梯（天）：SM2 精简版。 */
export const INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];
/** 毫秒/天换算。 */
const DAY_MS = 24 * 3600_000;
/**
 * 新片段的首次到期时间：创建 1 天后——让知识先「沉一晚」，
 * 对齐间隔重复实践中「新卡片次日首复习」的经典安排。
 */
export function initialDueAt(episodeCreatedAt) {
    return episodeCreatedAt + INTERVALS_DAYS[0] * DAY_MS;
}
/** 已复习片段的下一次到期时间：最近复习时间 + 档位间隔 × 排程节律。 */
export function nextDueAt(state) {
    const base = state.lastReviewedAt ?? 0;
    const stage = Math.min(state.stage, INTERVALS_DAYS.length - 1);
    const interval = Math.max(1, Math.round(INTERVALS_DAYS[stage] * (state.ease ?? 1)));
    return base + interval * DAY_MS;
}
/**
 * 复习评分：remembered = true 升一档（封顶最高档），false 归零重学。
 * SM2 的极简形态 + 个体节律乘子（轴线 24）：ease 缩放档位间隔，
 * 缺省 1 时退化为确定性阶梯（纯函数向后兼容）。
 */
export function gradeReview(state, remembered, now, ease = 1) {
    const stage = remembered
        ? Math.min(state.stage + 1, INTERVALS_DAYS.length - 1)
        : 0;
    const next = {
        episodeId: state.episodeId,
        lastReviewedAt: now,
        stage,
        ease,
    };
    const interval = Math.max(1, Math.round(INTERVALS_DAYS[stage] * ease));
    return {
        state: next,
        nextDueAt: now + interval * DAY_MS,
        nextIntervalDays: interval,
    };
}
/** 记忆巩固度（0..1）：档位进度——展示「这条知识你还记得多牢」。 */
export function reviewStrength(state) {
    if (state === undefined)
        return 0;
    return state.stage / (INTERVALS_DAYS.length - 1);
}
/**
 * 计算到期复习：遍历全部片段（含所属会话创建时间），对照复习状态。
 *
 * 到期判定：
 * - 无状态（从未复习）且 now ≥ 创建 + 1 天 → 到期（fresh）；
 * - 有状态且 now ≥ 最近复习 + 档位间隔 → 到期（lapsed）。
 *
 * @param episodes sessionId → 片段记录（episodes.ts 产物）。
 * @param states episodeId → 复习状态。
 * @param now 当前时间。
 * @param maxReturned 返回条数上限（缺省 15）。
 */
export function dueReviews(episodes, states, now, maxReturned = 15) {
    const due = [];
    for (const [sessionId, record] of episodes) {
        for (const episode of record.episodes) {
            const state = states.get(`${sessionId}:${episode.id}`);
            if (state === undefined) {
                const dueAt = initialDueAt(record.createdAt);
                if (now < dueAt)
                    continue;
                due.push({
                    episodeId: `${sessionId}:${episode.id}`,
                    sessionId,
                    problem: episode.problem,
                    solution: episode.solution,
                    dueAt,
                    overdueDays: Math.floor((now - dueAt) / DAY_MS),
                    fresh: true,
                    strength: 0,
                    createdAt: record.createdAt,
                });
            }
            else {
                const dueAt = nextDueAt(state);
                if (now < dueAt)
                    continue;
                due.push({
                    episodeId: `${sessionId}:${episode.id}`,
                    sessionId,
                    problem: episode.problem,
                    solution: episode.solution,
                    dueAt,
                    overdueDays: Math.floor((now - dueAt) / DAY_MS),
                    fresh: false,
                    strength: reviewStrength(state),
                    createdAt: record.createdAt,
                });
            }
        }
    }
    // 逾期越久越靠前；同逾期按会话时间新→旧（近期知识优先巩固）。
    due.sort((a, b) => a.overdueDays - b.overdueDays || b.createdAt - a.createdAt);
    return due.slice(0, maxReturned);
}
/** 存储读出的复习状态净化：非法记录静默丢弃。 */
export function sanitizeReviewState(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const state = raw;
    if (typeof state.episodeId !== 'string' || state.episodeId.length === 0)
        return undefined;
    if (typeof state.stage !== 'number' || !Number.isInteger(state.stage) || state.stage < 0) {
        return undefined;
    }
    if (state.stage >= INTERVALS_DAYS.length)
        return undefined;
    const last = state.lastReviewedAt;
    if (last !== null && typeof last !== 'number')
        return undefined;
    if (typeof last === 'number' && (!Number.isFinite(last) || last <= 0))
        return undefined;
    // 节律系数（可选字段）：有限正数才透传，否则按标准阶梯处理。
    const ease = state.ease;
    if (ease !== undefined && (typeof ease !== 'number' || !Number.isFinite(ease) || ease <= 0)) {
        return undefined;
    }
    return {
        episodeId: state.episodeId,
        lastReviewedAt: typeof last === 'number' ? last : null,
        stage: state.stage,
        // 无 ease 字段的旧记录保持原形状（深度比较不引入 undefined 键）。
        ...(typeof ease === 'number' ? { ease } : {}),
    };
}
