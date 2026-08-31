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
import { CRITICAL_RETENTION, RETENTION_THRESHOLD } from './forecast.js';
/** 每日复习容量缺省值（检索式练习一次 8 条以内为宜）。 */
export const DEFAULT_DAILY_CAP = 8;
/**
 * 单条复习的分诊：可救性 × 巩固投资 → 优先级。
 *
 * 优先级 = 紧迫度（距阈值的下坠深度） × 救援权重（滑落区 1 /
 * 深度遗忘 0.25） × 投资系数（1 + 巩固度）。
 */
export function reviewPriority(review, retention) {
    const pct = Math.round(retention * 100);
    const urgency = Math.min(1, Math.max(0, (RETENTION_THRESHOLD - retention) / RETENTION_THRESHOLD));
    const rescuable = retention >= CRITICAL_RETENTION;
    const rescueWeight = rescuable ? 1 : 0.25;
    const investment = 1 + review.strength;
    const priority = Number((urgency * rescueWeight * investment).toFixed(4));
    let reason;
    if (retention >= RETENTION_THRESHOLD) {
        reason = `保持率 ${pct}%——刚到期，按计划巩固`;
    }
    else if (rescuable) {
        reason = `保持率 ${pct}%——最佳巩固窗口，救得回来`;
    }
    else {
        reason = `保持率 ${pct}%——深度遗忘区，按重新学习安排`;
    }
    return { priority, reason };
}
/**
 * 生成每日负荷计划：分诊打分 → 排序 → 封顶 → 顺延计数。
 *
 * @param due 到期复习清单（轴线 21 的 dueReviews 产物）。
 * @param retentionOf 保持率查表（轴线 23 的 retentionIndex 产物；
 *   查不到时按阈值处理——刚到期的中性紧急度）。
 * @param cap 每日容量（缺省 8）。
 */
export function planReviewLoad(due, retentionOf, cap = DEFAULT_DAILY_CAP) {
    const effectiveCap = Math.max(1, Math.floor(cap));
    const scored = due.map((review) => {
        const retention = retentionOf(review.episodeId) ?? RETENTION_THRESHOLD;
        const { priority, reason } = reviewPriority(review, retention);
        return { review, retention: Number(retention.toFixed(4)), priority, reason };
    });
    // 优先级降序 → 逾期久者优先 → 知识新者优先（同分诊级别的自然次序）。
    scored.sort((a, b) => b.priority - a.priority ||
        b.review.overdueDays - a.review.overdueDays ||
        b.review.createdAt - a.review.createdAt);
    const today = scored.slice(0, effectiveCap);
    const deferredCount = Math.max(0, scored.length - today.length);
    const health = scored.length === 0 ? 'clear' : deferredCount > 0 ? 'overload' : 'normal';
    return {
        cap: effectiveCap,
        totalDue: scored.length,
        today,
        deferredCount,
        health,
        summary: summarizeLoad(today.length, deferredCount, scored.length),
    };
}
/** 负荷计划人话摘要。 */
function summarizeLoad(todayCount, deferredCount, totalDue) {
    if (totalDue === 0)
        return '没有到期复习——认知负荷为零';
    if (deferredCount > 0) {
        return `复习洪峰：${totalDue} 条到期，今日精选 ${todayCount} 条（按可救性排序），${deferredCount} 条顺延——注意力留给救得回来的知识`;
    }
    return `今日 ${todayCount} 条到期复习（负荷健康，无需顺延）`;
}
