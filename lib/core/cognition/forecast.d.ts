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
import { type ReviewState } from './spaced.js';
import type { EpisodeRecord } from './episodes.js';
/** 保持率阈值：跌破即视为「正在遗忘」（也是复习调度瞄准的临界线）。 */
export declare const RETENTION_THRESHOLD = 0.7;
/** 深度遗忘线：低于此值记忆基本不可提取，巩固按重新学习处理。 */
export declare const CRITICAL_RETENTION = 0.3;
/** 记忆分区（遗忘预测的三档判定）。 */
export type MemoryZone = 'stable' | 'warning' | 'critical';
/** 单条片段的遗忘预测视图。 */
export interface ForgettingForecast {
    /** 片段 id（sessionId:hash）。 */
    readonly episodeId: string;
    /** 来源会话 id。 */
    readonly sessionId: string;
    /** 问题面。 */
    readonly problem: string;
    /** 解法面。 */
    readonly solution: string;
    /** 当前预测保持率（0..1）。 */
    readonly retention: number;
    /** 记忆稳定性估计（天）。 */
    readonly stabilityDays: number;
    /** 距跌破阈值的剩余天数（负 = 已跌破；按当前衰减速度外推）。 */
    readonly daysToThreshold: number;
    /** 记忆分区。 */
    readonly zone: MemoryZone;
    /** 巩固度（0..1，档位进度）。 */
    readonly strength: number;
    /** 从未复习（true）或已进入复习循环（false）。 */
    readonly fresh: boolean;
    /** 来源会话创建时间。 */
    readonly createdAt: number;
}
/** 遗忘预测报告（分桶封顶 + 全量计数）。 */
export interface ForecastReport {
    /** 预测基准时间。 */
    readonly now: number;
    /** 预测采用的节律系数（当前值，非排程时的历史值）。 */
    readonly ease: number;
    /** 深度遗忘区样本（新→旧：最近丢失的最先展示）。 */
    readonly critical: readonly ForgettingForecast[];
    /** 滑落区样本（保持率升序：最危险的在前）。 */
    readonly warning: readonly ForgettingForecast[];
    /** 深度遗忘区总数（未截断）。 */
    readonly criticalCount: number;
    /** 滑落区总数（未截断）。 */
    readonly warningCount: number;
    /** 稳定区总数。 */
    readonly stableCount: number;
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 记忆稳定性估计（天）：当前档位基准间隔 × 节律系数 × 标定因子。
 * 无复习状态按第 0 档（1 天）计——未经巩固的知识天然易逝。
 */
export declare function estimateStabilityDays(state: ReviewState | undefined, ease: number): number;
/**
 * 预测保持率：R(t) = exp(-经过天数 / 稳定性)。
 *
 * @param state 复习状态（undefined = 从未复习）。
 * @param anchorAt 复习锚点（最近复习时间；无状态时用会话创建时间）。
 * @param now 当前时间。
 * @param ease 个体节律系数。
 */
export declare function predictRetention(state: ReviewState | undefined, anchorAt: number, now: number, ease: number): number;
/**
 * 距跌破阈值的剩余天数：S·ln(R/T)。
 * 正值 = 还在阈值之上（N 天后跌破）；0 = 恰好在临界线上；负 = 已跌破。
 */
export declare function daysToThreshold(retention: number, stabilityDays: number): number;
/** 保持率 → 记忆分区（三档判定）。 */
export declare function memoryZone(retention: number): MemoryZone;
/**
 * 全量保持率索引（episodeId → retention）：认知负荷调度（轴线 25）
 * 的查表基座——一次计算，分诊复用。
 */
export declare function retentionIndex(episodes: ReadonlyMap<string, EpisodeRecord>, states: ReadonlyMap<string, ReviewState>, now: number, ease: number): Map<string, number>;
/**
 * 全库遗忘预测：遍历全部片段（含从未复习的），按保持率分桶。
 *
 * @param episodes sessionId → 片段记录。
 * @param states episodeId → 复习状态。
 * @param now 当前时间。
 * @param ease 个体节律系数（当前值——这是预警「日程过期」的关键）。
 * @param options.maxPerBucket 每桶返回条数上限（缺省 10）。
 */
export declare function forecastForgetting(episodes: ReadonlyMap<string, EpisodeRecord>, states: ReadonlyMap<string, ReviewState>, now: number, ease: number, options?: {
    maxPerBucket?: number;
}): ForecastReport;
