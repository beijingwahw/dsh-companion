/**
 * 节能顾问（成本优化决策层）：把用量数据翻译成按优先级排序的行动建议。
 *
 * 设计动机：模块 C 已有预测（OLS 外推）、异常（MAD）、what-if 沙盘、
 * 变化归因四个**分析**引擎，但它们回答"发生了什么/会怎样"；用户真正
 * 需要的是"**现在该做什么**"。节能顾问是纯函数决策层——输入一张
 * 成本快照（由现有引擎组装），输出按预期节省金额降序的建议卡：
 *
 * - `budget-pacing` 预算刹车：月末投影 vs 月预算，投影超支时给出
 *   按剩余天数摊平的日预算上限（投影口径与轴线 forecast 一致）；
 * - `off-peak-shift` 峰谷迁移：高峰时段可延迟调用量 × 高峰/空闲价差
 *   估算月度节省（与峰谷调度器同一经济口径）；
 * - `cache-uplift` 缓存提升：命中率每提升 10 个点的节省潜力
 *   （按缓存折扣价与当前命中结构估算）；
 * - `model-shift` 模型迁移：同厂商低价模型可得时的迁移候选
 *   （保守提示，不做自动切换）。
 *
 * 每张建议卡带 `estimatedSavingCny`（月度估算，可能为 0——信息型建议
 * 不假装省钱）与一句话行动。纯函数、无状态、确定性；不产生任何
 * 副作用——采纳与否永远由用户决定（预算/调度开关仍走原路径）。
 */
/** 成本快照：由用量表 + 现有预测引擎组装的输入形状。 */
export interface CostAdviceSnapshot {
    /** 当月已花费（CNY）。 */
    readonly monthSpend: number;
    /** 月预算（CNY；0 = 不限）。 */
    readonly monthlyBudget: number;
    /** 月末费用投影（CNY；无足够历史时缺省—— pacing 建议降级）。 */
    readonly monthProjection?: number;
    /** 本月剩余天数（含今天，≥ 1）。 */
    readonly remainingDays: number;
    /** 当前是否处于高峰时段（北京时间峰谷窗口）。 */
    readonly peakNow: boolean;
    /** 近 30 天可延迟（非紧急）调用量占比（0–1）。 */
    readonly deferrableRatio: number;
    /** 高峰价相对空闲价的溢价率（0–1；如 0.5 = 高峰贵 50%）。 */
    readonly peakPremium: number;
    /** 近 30 天缓存命中率（0–1）。 */
    readonly cacheHitRate: number;
    /** 缓存命中相对全价的折扣率（0–1；如 0.9 = 一折）。 */
    readonly cacheDiscount: number;
    /** 近 30 天未命中输入 tokens（缓存提升潜力的基数）。 */
    readonly cacheMissTokens: number;
    /** 每百万未命中输入 token 的全价（CNY）。 */
    readonly inputPricePerMillion: number;
    /** 当前主力模型名。 */
    readonly primaryModel: string;
    /** 同厂商更低价的候选模型（无则缺省）。 */
    readonly cheaperModel?: {
        readonly model: string;
        readonly priceRatio: number;
    };
}
/** 一张建议卡。 */
export interface CostAdviceCard {
    /** 建议类型。 */
    readonly kind: 'budget-pacing' | 'off-peak-shift' | 'cache-uplift' | 'model-shift';
    /** 优先级（critical / recommended / info）。 */
    readonly severity: 'critical' | 'recommended' | 'info';
    /** 月度节省估算（CNY；信息型建议为 0）。 */
    readonly estimatedSavingCny: number;
    /** 一句话行动。 */
    readonly action: string;
}
/** 顾问报告。 */
export interface CostAdviceReport {
    /** 建议卡（按 severity → 节省金额降序）。 */
    readonly cards: readonly CostAdviceCard[];
    /** 月度总节省潜力（各卡合计的上界；不可叠加时取最大）。 */
    readonly potentialSavingCny: number;
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 节能顾问主入口：快照 → 建议卡。
 * @param snapshot 成本快照（见 CostAdviceSnapshot）。
 */
export declare function composeCostAdvice(snapshot: CostAdviceSnapshot): CostAdviceReport;
