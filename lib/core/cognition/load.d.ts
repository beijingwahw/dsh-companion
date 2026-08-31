/**
 * 认知负荷调度（轴线 25）：注意力是稀缺资源，复习洪峰需要分诊。
 *
 * 设计动机：间隔重复系统最常见的弃用原因是**洪峰**——攒了
 * 三周没复习，一打开 40 条到期卡片，直接关闭再也没回来。
 * 把全部到期项倒给用户不是调度，是倾倒。本模块把到期复习
 * 变成一份**每日计划**：
 *
 * - **可救性分诊**：滑落区（30–70% 保持率）的知识正处在
 *   「最佳巩固窗口」——还有印象、即将丢失、巩固收益最大，
 *   优先安排；深度遗忘区（<30%）的降权处理（按重新学习的
 *   节奏来，不挤占救得回来的名额）；
 * - **巩固投资保护**：档位越高的知识乘以越高的权重——
 *   60 天档位滑落比 1 天档位滑落损失更大；
 * - **每日封顶 + 顺延**：超出容量的条目明确顺延（不是丢弃），
 *   负荷状态透明可见（clear / normal / overload）。
 *
 * 与轴线 23 的关系：分诊的输入正是遗忘预测的保持率——
 * 预测（23）→ 分诊（25）→ 评分 → 节律（24）→ 更准的预测，
 * 元认知三轴构成一个完整闭环。
 */
import type { DueReview } from './spaced.js';
/** 每日复习容量缺省值（检索式练习一次 8 条以内为宜）。 */
export declare const DEFAULT_DAILY_CAP = 8;
/** 负荷健康度：无到期 / 容量内 / 超容量（发生顺延）。 */
export type LoadHealth = 'clear' | 'normal' | 'overload';
/** 单条已排程复习（带分诊结论）。 */
export interface PlannedReview {
    /** 到期复习视图（轴线 21 的产物）。 */
    readonly review: DueReview;
    /** 预测保持率（轴线 23 的输入）。 */
    readonly retention: number;
    /** 分诊优先级（越大越先安排）。 */
    readonly priority: number;
    /** 分诊理由（人话，展示用）。 */
    readonly reason: string;
}
/** 每日负荷计划。 */
export interface LoadPlan {
    /** 每日容量。 */
    readonly cap: number;
    /** 到期总数。 */
    readonly totalDue: number;
    /** 今日实际安排（按优先级降序，封顶 cap 条）。 */
    readonly today: readonly PlannedReview[];
    /** 顺延条数（到期但未进今日计划）。 */
    readonly deferredCount: number;
    /** 负荷健康度。 */
    readonly health: LoadHealth;
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 单条复习的分诊：可救性 × 巩固投资 → 优先级。
 *
 * 优先级 = 紧迫度（距阈值的下坠深度） × 救援权重（滑落区 1 /
 * 深度遗忘 0.25） × 投资系数（1 + 巩固度）。
 */
export declare function reviewPriority(review: DueReview, retention: number): {
    priority: number;
    reason: string;
};
/**
 * 生成每日负荷计划：分诊打分 → 排序 → 封顶 → 顺延计数。
 *
 * @param due 到期复习清单（轴线 21 的 dueReviews 产物）。
 * @param retentionOf 保持率查表（轴线 23 的 retentionIndex 产物；
 *   查不到时按阈值处理——刚到期的中性紧急度）。
 * @param cap 每日容量（缺省 8）。
 */
export declare function planReviewLoad(due: readonly DueReview[], retentionOf: (episodeId: string) => number | undefined, cap?: number): LoadPlan;
