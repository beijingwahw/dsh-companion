/**
 * 遗忘预测引擎（轴线 23）：在知识滑入遗忘之前看见它正在滑落。
 *
 * 设计动机：轴线 21 的间隔调度回答「何时复习」，但它只对
 * **已登记状态**的片段负责——而真实语料里大量知识从未进入复习
 * 循环（旧会话的片段从未复习过），它们的衰减无人看管。本模块
 * 用艾宾浩斯指数衰减模型为**每一条**片段给出连续的记忆画像：
 *
 * - **保持率**（retention）：此刻还能想起来的概率估计
 *   `R(t) = exp(-t/S)`，t 为距上次巩固的天数，S 为记忆稳定性；
 * - **稳定性**（stability）：当前档位间隔 × 个体节律 × 标定因子——
 *   标定保证「到期时刻的预测保持率恰好等于阈值」（与轴线 21 的
 *   调度自洽：调度器瞄准的正是这条临界线）；
 * - **分区**：≥70% 稳定 / 30–70% 滑落区（最佳巩固窗口，
 *   救得回来）/ <30% 深度遗忘区（按重新学习处理）。
 *
 * 与轴线 24 的联动是本引擎的预测力来源：复习日程按**当时的**
 * 节律系数排定，而预测用**当前的**系数重算——节律变差时，
 * 还没到期的知识也会被提前预警（日程已过期，记忆还在 decay）。
 */
import { INTERVALS_DAYS, reviewStrength } from './spaced.js';
/** 毫秒/天换算。 */
const DAY_MS = 24 * 3600_000;
/** 保持率阈值：跌破即视为「正在遗忘」（也是复习调度瞄准的临界线）。 */
export const RETENTION_THRESHOLD = 0.7;
/** 深度遗忘线：低于此值记忆基本不可提取，巩固按重新学习处理。 */
export const CRITICAL_RETENTION = 0.3;
/**
 * 稳定性标定因子：S = 间隔 × ease × 因子。
 * 取 1 / -ln(阈值)，使「到期时刻的预测保持率 = 阈值」精确成立——
 * 预测模型与调度模型在数学上共享同一条临界线。
 */
const STABILITY_FACTOR = 1 / -Math.log(RETENTION_THRESHOLD);
/**
 * 记忆稳定性估计（天）：当前档位基准间隔 × 节律系数 × 标定因子。
 * 无复习状态按第 0 档（1 天）计——未经巩固的知识天然易逝。
 */
export function estimateStabilityDays(state, ease) {
    const stage = Math.min(state?.stage ?? 0, INTERVALS_DAYS.length - 1);
    return INTERVALS_DAYS[stage] * ease * STABILITY_FACTOR;
}
/**
 * 预测保持率：R(t) = exp(-经过天数 / 稳定性)。
 *
 * @param state 复习状态（undefined = 从未复习）。
 * @param anchorAt 复习锚点（最近复习时间；无状态时用会话创建时间）。
 * @param now 当前时间。
 * @param ease 个体节律系数。
 */
export function predictRetention(state, anchorAt, now, ease) {
    const stability = estimateStabilityDays(state, ease);
    const elapsedDays = Math.max(0, (now - anchorAt) / DAY_MS);
    return Math.exp(-elapsedDays / stability);
}
/**
 * 距跌破阈值的剩余天数：S·ln(R/T)。
 * 正值 = 还在阈值之上（N 天后跌破）；0 = 恰好在临界线上；负 = 已跌破。
 */
export function daysToThreshold(retention, stabilityDays) {
    return stabilityDays * Math.log(retention / RETENTION_THRESHOLD);
}
/** 保持率 → 记忆分区（三档判定）。 */
export function memoryZone(retention) {
    if (retention < CRITICAL_RETENTION)
        return 'critical';
    if (retention < RETENTION_THRESHOLD)
        return 'warning';
    return 'stable';
}
/**
 * 全量保持率索引（episodeId → retention）：认知负荷调度（轴线 25）
 * 的查表基座——一次计算，分诊复用。
 */
export function retentionIndex(episodes, states, now, ease) {
    const index = new Map();
    for (const [sessionId, record] of episodes) {
        for (const episode of record.episodes) {
            const state = states.get(`${sessionId}:${episode.id}`);
            const anchor = state?.lastReviewedAt ?? record.createdAt;
            index.set(`${sessionId}:${episode.id}`, predictRetention(state, anchor, now, ease));
        }
    }
    return index;
}
/**
 * 全库遗忘预测：遍历全部片段（含从未复习的），按保持率分桶。
 *
 * @param episodes sessionId → 片段记录。
 * @param states episodeId → 复习状态。
 * @param now 当前时间。
 * @param ease 个体节律系数（当前值——这是预警「日程过期」的关键）。
 * @param options.maxPerBucket 每桶返回条数上限（缺省 10）。
 */
export function forecastForgetting(episodes, states, now, ease, options) {
    const critical = [];
    const warning = [];
    let stableCount = 0;
    for (const [sessionId, record] of episodes) {
        for (const episode of record.episodes) {
            const episodeId = `${sessionId}:${episode.id}`;
            const state = states.get(episodeId);
            const anchor = state?.lastReviewedAt ?? record.createdAt;
            const stability = estimateStabilityDays(state, ease);
            const retention = predictRetention(state, anchor, now, ease);
            const zone = memoryZone(retention);
            const item = {
                episodeId,
                sessionId,
                problem: episode.problem,
                solution: episode.solution,
                retention: Number(retention.toFixed(4)),
                stabilityDays: Number(stability.toFixed(2)),
                daysToThreshold: Number(daysToThreshold(retention, stability).toFixed(2)),
                zone,
                strength: reviewStrength(state),
                fresh: state === undefined,
                createdAt: record.createdAt,
            };
            if (zone === 'critical')
                critical.push(item);
            else if (zone === 'warning')
                warning.push(item);
            else
                stableCount += 1;
        }
    }
    // 深度遗忘区：新→旧（最近丢失的与当前工作最相关，先展示）。
    critical.sort((a, b) => b.createdAt - a.createdAt);
    // 滑落区：保持率升序（最接近深度遗忘的最危险，先展示）。
    warning.sort((a, b) => a.retention - b.retention);
    const cap = options?.maxPerBucket ?? 10;
    return {
        now,
        ease,
        critical: critical.slice(0, cap),
        warning: warning.slice(0, cap),
        criticalCount: critical.length,
        warningCount: warning.length,
        stableCount,
        summary: summarizeForecast(critical.length, warning.length, stableCount),
    };
}
/** 预测报告人话摘要。 */
function summarizeForecast(criticalCount, warningCount, stableCount) {
    if (criticalCount === 0 && warningCount === 0 && stableCount === 0) {
        return '尚无可预测的知识——「问题→解法」片段积累后遗忘预测自动启动';
    }
    if (criticalCount > 0) {
        const warningPart = warningCount > 0 ? `，另有 ${warningCount} 条正在滑落` : '';
        return `${criticalCount} 条知识已滑入深度遗忘区（<30%）${warningPart}——趁还有印象，抢救成本最低`;
    }
    if (warningCount > 0) {
        return `${warningCount} 条知识保持率跌破 70%——正值最佳巩固窗口（救得回来的区间），${stableCount} 条保持健康`;
    }
    return `${stableCount} 条知识保持率全部 ≥70%——记忆健康`;
}
