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
const SEVERITY_ORDER = {
    critical: 0,
    recommended: 1,
    info: 2,
};
/**
 * 节能顾问主入口：快照 → 建议卡。
 * @param snapshot 成本快照（见 CostAdviceSnapshot）。
 */
export function composeCostAdvice(snapshot) {
    const cards = [];
    // ---- 预算刹车：投影口径的超支预警 + 摊平日预算 ----
    if (snapshot.monthlyBudget > 0 && snapshot.monthProjection !== undefined) {
        const projection = snapshot.monthProjection;
        if (projection > snapshot.monthlyBudget) {
            const overspend = projection - snapshot.monthlyBudget;
            // 剩余期摊平：总预算 − 已花费，均摊到剩余天数（下限 0）。
            const dailyCap = snapshot.remainingDays > 0
                ? Math.max(0, snapshot.monthlyBudget - snapshot.monthSpend) / snapshot.remainingDays
                : 0;
            cards.push({
                kind: 'budget-pacing',
                severity: projection > snapshot.monthlyBudget * 1.2 ? 'critical' : 'recommended',
                estimatedSavingCny: Number(overspend.toFixed(2)),
                action: `月末投影 ${projection.toFixed(2)} 元将超出月预算 ${snapshot.monthlyBudget} 元` +
                    `（超 ${overspend.toFixed(2)} 元）；剩余 ${snapshot.remainingDays} 天按 ` +
                    `≤ ${dailyCap.toFixed(2)} 元/天 摊平可拉回预算线`,
            });
        }
    }
    // ---- 峰谷迁移：可延迟量 × 价差 ----
    // 高峰开销 ≈ 月花费 × 可延迟占比（近似：可延迟调用均匀分布）；
    // 迁移到空闲价可省其中的溢价比例。
    if (snapshot.peakNow && snapshot.deferrableRatio > 0.05 && snapshot.peakPremium > 0) {
        const shiftable = snapshot.monthSpend * snapshot.deferrableRatio;
        const saving = shiftable * (snapshot.peakPremium / (1 + snapshot.peakPremium));
        if (saving >= 0.5) {
            cards.push({
                kind: 'off-peak-shift',
                severity: saving > snapshot.monthSpend * 0.1 ? 'recommended' : 'info',
                estimatedSavingCny: Number(saving.toFixed(2)),
                action: `当前处于高峰时段，近 30 天 ${Math.round(snapshot.deferrableRatio * 100)}% 调用可延迟；` +
                    `开启峰谷自动调度把这些调用挪到空闲价，月度约省 ${saving.toFixed(2)} 元`,
            });
        }
    }
    // ---- 缓存提升：命中率每 +10 点的节省潜力 ----
    if (snapshot.cacheHitRate < 0.9 && snapshot.cacheMissTokens > 0 && snapshot.cacheDiscount > 0) {
        // 提升 10 个点命中率 = 未命中量的 10% 转为折扣价输入；
        // 节省 = 转移量 × 全价 × 折扣率（折扣率即省下的比例）。
        const shiftedTokens = snapshot.cacheMissTokens * 0.1;
        const saving = (shiftedTokens / 1_000_000) * snapshot.inputPricePerMillion * snapshot.cacheDiscount;
        if (saving >= 0.5) {
            cards.push({
                kind: 'cache-uplift',
                severity: 'info',
                estimatedSavingCny: Number(saving.toFixed(2)),
                action: `当前缓存命中率 ${Math.round(snapshot.cacheHitRate * 100)}%；命中率的提升路径是` +
                    `稳定 system 前缀与复用长上下文（命中部分按 ${Math.round((1 - snapshot.cacheDiscount) * 100)}% 折扣计费），` +
                    `命中率 +10 点月度约省 ${saving.toFixed(2)} 元`,
            });
        }
    }
    // ---- 模型迁移：同厂商低价候选（保守提示，不自动切换） ----
    if (snapshot.cheaperModel !== undefined && snapshot.cheaperModel.priceRatio < 1) {
        const saving = snapshot.monthSpend * (1 - snapshot.cheaperModel.priceRatio);
        if (saving >= 1) {
            cards.push({
                kind: 'model-shift',
                severity: 'info',
                estimatedSavingCny: Number(saving.toFixed(2)),
                action: `主力模型 ${snapshot.primaryModel} 的同厂商候选 ${snapshot.cheaperModel.model} ` +
                    `单价约为其 ${Math.round(snapshot.cheaperModel.priceRatio * 100)}%；简单任务（翻译/摘要）` +
                    `经模型路由走低价候选，月度约省 ${saving.toFixed(2)} 元（复杂任务保持主力）`,
            });
        }
    }
    return finish(cards);
}
function finish(cards) {
    const sorted = [...cards].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.estimatedSavingCny - a.estimatedSavingCny);
    const potential = sorted.reduce((max, card) => Math.max(max, card.estimatedSavingCny), 0);
    return {
        cards: sorted,
        potentialSavingCny: Number(potential.toFixed(2)),
        summary: sorted.length === 0
            ? '当前成本结构健康——预算在轨、无显著可优化项'
            : `${sorted.length} 条建议，最大单项月度节省潜力约 ${potential.toFixed(2)} 元`,
    };
}
