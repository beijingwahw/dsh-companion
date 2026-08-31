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
/** 单个片段的复习调度状态（存储形状；key = episodeId）。 */
export interface ReviewState {
    /** 片段 id（sessionId:hash）。 */
    readonly episodeId: string;
    /** 最近一次复习时间（null = 从未复习）。 */
    readonly lastReviewedAt: number | null;
    /** 间隔档位索引（0..INTERVALS_DAYS-1；越大间隔越长）。 */
    readonly stage: number;
    /** 排程时采用的节律系数（轴线 24；缺省 1 = 标准阶梯）。 */
    readonly ease?: number;
}
/** 间隔阶梯（天）：SM2 精简版。 */
export declare const INTERVALS_DAYS: readonly number[];
/** 到期复习视图。 */
export interface DueReview {
    /** 片段 id。 */
    readonly episodeId: string;
    /** 来源会话 id。 */
    readonly sessionId: string;
    /** 问题面（卡片正面：先回忆这个）。 */
    readonly problem: string;
    /** 解法面（卡片背面：核对用）。 */
    readonly solution: string;
    /** 应复习时间（毫秒时间戳）。 */
    readonly dueAt: number;
    /** 逾期天数（0 = 刚好到期）。 */
    readonly overdueDays: number;
    /** 首次复习（true）或已复习过（false）。 */
    readonly fresh: boolean;
    /** 记忆巩固度（0..1：当前档位 / 最高档位）。 */
    readonly strength: number;
    /** 来源会话创建时间。 */
    readonly createdAt: number;
}
/** 评分结果（gradeReview 的返回视图）。 */
export interface GradeResult {
    /** 评分后的新状态。 */
    readonly state: ReviewState;
    /** 下次应复习时间（毫秒时间戳）。 */
    readonly nextDueAt: number;
    /** 下次间隔天数。 */
    readonly nextIntervalDays: number;
}
/**
 * 新片段的首次到期时间：创建 1 天后——让知识先「沉一晚」，
 * 对齐间隔重复实践中「新卡片次日首复习」的经典安排。
 */
export declare function initialDueAt(episodeCreatedAt: number): number;
/** 已复习片段的下一次到期时间：最近复习时间 + 档位间隔 × 排程节律。 */
export declare function nextDueAt(state: ReviewState): number;
/**
 * 复习评分：remembered = true 升一档（封顶最高档），false 归零重学。
 * SM2 的极简形态 + 个体节律乘子（轴线 24）：ease 缩放档位间隔，
 * 缺省 1 时退化为确定性阶梯（纯函数向后兼容）。
 */
export declare function gradeReview(state: ReviewState, remembered: boolean, now: number, ease?: number): GradeResult;
/** 记忆巩固度（0..1）：档位进度——展示「这条知识你还记得多牢」。 */
export declare function reviewStrength(state: ReviewState | undefined): number;
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
export declare function dueReviews(episodes: ReadonlyMap<string, import('./episodes.js').EpisodeRecord>, states: ReadonlyMap<string, ReviewState>, now: number, maxReturned?: number): readonly DueReview[];
/** 存储读出的复习状态净化：非法记录静默丢弃。 */
export declare function sanitizeReviewState(raw: unknown): ReviewState | undefined;
