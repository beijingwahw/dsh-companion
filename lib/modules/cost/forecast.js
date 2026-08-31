/** 预测所需最少历史天数。 */
const MIN_HISTORY_DAYS = 5;
/** 鲁棒 z 分数异常阈值（业界惯用 3.5）。 */
const ANOMALY_Z_THRESHOLD = 3.5;
/** 日期键（YYYY-MM-DD）→ Date（UTC 零点，便于日期加减）。 */
function dayToUtc(day) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date));
}
/** UTC 日期 → 日期键。 */
function utcToDay(date) {
    return date.toISOString().slice(0, 10);
}
/** 求中位数（空数组返回 0）。 */
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
/**
 * 稀疏日序列 → 稠密日序列：[from, to] 闭区间内缺日补 0
 * （返回 [day, cost] 序列，日期升序）。
 */
function denseSeries(rows, from, to) {
    const byDay = new Map();
    for (const row of rows)
        byDay.set(row.day, row.costCny);
    const series = [];
    const start = dayToUtc(from);
    const end = dayToUtc(to);
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
        const day = utcToDay(cursor);
        series.push([day, byDay.get(day) ?? 0]);
    }
    return series;
}
/**
 * 支出预测：OLS 线性回归 + 外推。
 * @param rows 历史日用量（时间升序或乱序均可，内部按 day 排序）。
 * @param horizonDays 外推天数。
 * @param anchorDay 锚定日（预测从锚定日的次日开始；缺省取序列末日）。
 */
export function forecastSpend(rows, horizonDays, anchorDay) {
    const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const lastDay = anchorDay ?? sorted[sorted.length - 1]?.day;
    const firstDay = sorted[0]?.day ?? lastDay;
    if (lastDay === undefined || firstDay === undefined) {
        return {
            historyDays: 0,
            sufficient: false,
            slopeCnyPerDay: 0,
            r2: 0,
            meanDailyCny: 0,
            points: [],
            monthEndProjectedCny: 0,
        };
    }
    const series = denseSeries(sorted, firstDay, lastDay);
    const n = series.length;
    const costs = series.map(([, cost]) => cost);
    const mean = costs.reduce((sum, value) => sum + value, 0) / (n > 0 ? n : 1);
    const sufficient = n >= MIN_HISTORY_DAYS && costs.some((value) => value > 0);
    // OLS：t = 0..n-1（天序），c_t 为费用。
    let sumT = 0;
    let sumC = 0;
    let sumTT = 0;
    let sumTC = 0;
    series.forEach(([, cost], t) => {
        sumT += t;
        sumC += cost;
        sumTT += t * t;
        sumTC += t * cost;
    });
    const denominator = n * sumTT - sumT * sumT;
    const slope = denominator === 0 ? 0 : (n * sumTC - sumT * sumC) / denominator;
    const intercept = (sumC - slope * sumT) / (n > 0 ? n : 1);
    // R²：SST 为 0（平坦序列）时均值即完美拟合，记 1。
    let sse = 0;
    let sst = 0;
    series.forEach(([, cost], t) => {
        const fitted = intercept + slope * t;
        sse += (cost - fitted) ** 2;
        sst += (cost - mean) ** 2;
    });
    const r2 = sst === 0 ? 1 : Math.max(0, 1 - sse / sst);
    // 外推：未来 horizon 天（锚定日次日起），负预测截断为 0。
    const points = [];
    const anchor = dayToUtc(lastDay);
    for (let offset = 1; offset <= horizonDays; offset += 1) {
        const day = utcToDay(new Date(anchor.getTime() + offset * 86_400_000));
        const predicted = Math.max(0, intercept + slope * (n - 1 + offset));
        points.push({ day, predictedCny: round4(predicted) });
    }
    // 月末投影：本月已花费 + 预测到月底的费用（从锚定日次日起算到当月最后一天）。
    const [year, month] = lastDay.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const daysRemaining = monthEnd - Number(lastDay.slice(8, 10));
    const spentThisMonth = sorted
        .filter((row) => row.day.slice(0, 7) === lastDay.slice(0, 7))
        .reduce((sum, row) => sum + row.costCny, 0);
    let projectedRest = 0;
    for (let offset = 1; offset <= Math.max(0, daysRemaining); offset += 1) {
        projectedRest += Math.max(0, intercept + slope * (n - 1 + offset));
    }
    return {
        historyDays: n,
        sufficient,
        slopeCnyPerDay: round4(slope),
        r2: round4(r2),
        meanDailyCny: round4(mean),
        points,
        monthEndProjectedCny: round4(spentThisMonth + projectedRest),
    };
}
/**
 * 异常检测：中位数 + MAD 鲁棒 z 分数。
 * 只统计有记录的活跃天（缺日是间隔不是异常）；费用显著高于基线
 * （z > 3.5）才标记，低花费/零花费不标记（省钱不是异常）。
 */
export function detectAnomalies(rows) {
    const active = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const costs = active.map((row) => row.costCny);
    const med = median(costs);
    const mad = median(costs.map((cost) => Math.abs(cost - med)));
    const anomalies = [];
    for (const row of active) {
        let robustZ;
        if (mad > 0) {
            robustZ = (0.6745 * (row.costCny - med)) / mad;
        }
        else {
            // MAD 为 0：多数天费用完全一致。退化规则 = 超过基线 4 倍即异常
            //（robustZ 以阈值等效值 3.5/0.6745 记账，保持字段语义）。
            robustZ = med > 0 && row.costCny > med * 4 ? 3.5 / 0.6745 : 0;
        }
        if (robustZ > ANOMALY_Z_THRESHOLD && row.costCny > 0) {
            const severity = robustZ > 10 ? 'critical' : robustZ > 5 ? 'high' : 'mild';
            anomalies.push({
                day: row.day,
                costCny: row.costCny,
                expectedCny: round4(med),
                deviationRatio: med > 0 ? round4(row.costCny / med) : 0,
                robustZ: round4(robustZ),
                severity,
            });
        }
    }
    return { anomalies, medianCny: round4(med), madCny: round4(mad), activeDays: active.length };
}
/** 按模型聚合窗口总量。 */
function aggregateByModel(rows) {
    const byModel = new Map();
    for (const row of rows) {
        for (const [model, slice] of Object.entries(row.byModel)) {
            const agg = byModel.get(model) ?? {
                calls: 0,
                promptTokens: 0,
                completionTokens: 0,
                cacheHitTokens: 0,
                costCny: 0,
            };
            agg.calls += slice.calls;
            agg.promptTokens += slice.promptTokens;
            agg.completionTokens += slice.completionTokens;
            agg.cacheHitTokens += slice.cacheHitTokens ?? 0;
            agg.costCny += slice.costCny;
            byModel.set(model, agg);
        }
    }
    return byModel;
}
/**
 * what-if 模拟：观测日均值基线 + 场景算子。
 * 算子组合顺序：调用量倍数 → 缓存命中率 → 模型迁移（顺序应用，
 * 各自的增量按「当前状态」计算后在基线上叠加）。
 * @param rows 历史日用量窗口。
 * @param scenario 场景参数。
 * @param priceResolver 模型价格解析器（缓存命中率算子需要现价分解输入成本）。
 * @param windowDays 日历跨度（日均值分母；缺省按观测天数）。
 */
export function whatIfSimulate(rows, scenario, priceResolver, windowDays) {
    const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const span = windowDays !== undefined && windowDays > 0
        ? windowDays
        : Math.max(1, sorted.length);
    const byModel = aggregateByModel(sorted);
    const factor = scenario.callVolumeFactor !== undefined && scenario.callVolumeFactor > 0
        ? scenario.callVolumeFactor
        : 1;
    const atMs = Date.now();
    /** 基线与投影的日费用（按模型）。 */
    const breakdown = [];
    // 迁移增量先在「调用均价」层面计算（元/天，已含 factor 缩放）。
    const shiftDelta = new Map();
    if (scenario.modelShift !== undefined) {
        for (const shift of scenario.modelShift) {
            if (!(shift.ratio > 0 && shift.ratio <= 1))
                continue;
            const from = byModel.get(shift.from);
            if (from === undefined || from.calls === 0)
                continue;
            const fromPerCall = from.costCny / from.calls;
            const to = byModel.get(shift.to);
            let toPerCall;
            if (to !== undefined && to.calls > 0) {
                toPerCall = to.costCny / to.calls;
            }
            else {
                // 目标模型无历史：按现价表估算每调用成本（输入/输出 token 用量
                // 沿用来源模型均值）；无价格时退化为来源模型均价（保守估计）。
                const price = priceResolver(shift.to, atMs);
                if (price !== undefined) {
                    const promptPerCall = from.promptTokens / from.calls;
                    const completionPerCall = from.completionTokens / from.calls;
                    toPerCall =
                        (promptPerCall * price.inputMiss + completionPerCall * price.output) / 1_000_000;
                }
                else {
                    toPerCall = fromPerCall;
                }
            }
            // 迁移量 = 来源模型日均调用 × ratio × 调用量倍数。
            const movedDailyCalls = (from.calls / span) * shift.ratio * factor;
            shiftDelta.set(shift.from, (shiftDelta.get(shift.from) ?? 0) - movedDailyCalls * fromPerCall);
            shiftDelta.set(shift.to, (shiftDelta.get(shift.to) ?? 0) + movedDailyCalls * toPerCall);
        }
    }
    for (const [model, agg] of byModel) {
        const baselineDaily = agg.costCny / span;
        let projectedDaily = baselineDaily * factor;
        projectedDaily += shiftDelta.get(model) ?? 0;
        // 缓存命中率算子：按现价分解输入成本重算（只对有价格的模型生效）。
        if (scenario.cacheHitRatio !== undefined) {
            const ratio = Math.min(1, Math.max(0, scenario.cacheHitRatio));
            const price = priceResolver(model, atMs);
            if (price !== undefined && agg.promptTokens > 0) {
                const observedRatio = agg.cacheHitTokens / agg.promptTokens;
                const dailyPrompt = (agg.promptTokens / span) * factor;
                const oldInput = dailyPrompt * (observedRatio * price.inputCacheHit + (1 - observedRatio) * price.inputMiss);
                const newInput = dailyPrompt * (ratio * price.inputCacheHit + (1 - ratio) * price.inputMiss);
                projectedDaily += (newInput - oldInput) / 1_000_000;
            }
        }
        breakdown.push({
            model,
            baselineDailyCny: round4(baselineDaily),
            projectedDailyCny: round4(Math.max(0, projectedDaily)),
            deltaDailyCny: round4(projectedDaily - baselineDaily),
        });
    }
    breakdown.sort((a, b) => b.baselineDailyCny - a.baselineDailyCny);
    const baselineTotal = breakdown.reduce((sum, item) => sum + item.baselineDailyCny, 0);
    const projectedTotal = breakdown.reduce((sum, item) => sum + item.projectedDailyCny, 0);
    return {
        windowDays: span,
        baselineDailyCny: round4(baselineTotal),
        projectedDailyCny: round4(projectedTotal),
        deltaDailyCny: round4(projectedTotal - baselineTotal),
        monthlyCny: round4(projectedTotal * 30),
        breakdown,
    };
}
/**
 * 变化归因：对比两个等长窗口，按模型分解费用变化。
 * 正 delta = 该模型花的更多；shareRatio = 该模型变化占总变化的份额。
 */
export function attributeChange(currentRows, previousRows) {
    const current = aggregateByModel(currentRows);
    const previous = aggregateByModel(previousRows);
    const models = new Set([...current.keys(), ...previous.keys()]);
    let currentTotalCny = 0;
    let previousTotalCny = 0;
    let currentTotalCalls = 0;
    let previousTotalCalls = 0;
    const raw = [];
    for (const model of models) {
        const c = current.get(model);
        const p = previous.get(model);
        const currentCny = c?.costCny ?? 0;
        const previousCny = p?.costCny ?? 0;
        const currentCalls = c?.calls ?? 0;
        const previousCalls = p?.calls ?? 0;
        currentTotalCny += currentCny;
        previousTotalCny += previousCny;
        currentTotalCalls += currentCalls;
        previousTotalCalls += previousCalls;
        raw.push({
            model,
            currentCny: round4(currentCny),
            previousCny: round4(previousCny),
            deltaCny: round4(currentCny - previousCny),
            shareRatio: 0,
            currentCalls,
            previousCalls,
        });
    }
    const totalDelta = currentTotalCny - previousTotalCny;
    for (const entry of raw) {
        entry.shareRatio = totalDelta === 0 ? 0 : round4(entry.deltaCny / totalDelta);
    }
    raw.sort((a, b) => Math.abs(b.deltaCny) - Math.abs(a.deltaCny));
    return {
        total: {
            currentCny: round4(currentTotalCny),
            previousCny: round4(previousTotalCny),
            deltaCny: round4(totalDelta),
            currentCalls: currentTotalCalls,
            previousCalls: previousTotalCalls,
        },
        entries: raw,
    };
}
/** 四舍五入到 4 位小数（与 usage 记账精度一致）。 */
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
