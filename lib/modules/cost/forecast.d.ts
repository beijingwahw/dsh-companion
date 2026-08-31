/**
 * 预测性成本智能（轴线 3）：支出预测 + 异常检测 + what-if 模拟 + 变化归因。
 *
 * 纯函数分析库：输入日用量序列（UsageStore.range 的输出）与模型价格
 * 解析器，输出预测 / 异常 / 模拟 / 归因结果；不做任何 IO。
 *
 * 四个能力与算法依据：
 * - **支出预测**：OLS 线性回归拟合「日费用 ~ 时间」趋势，外推未来
 *   horizon 天；R² 作为拟合质量指示；缺日按 0 补齐（不花钱的一天
 *   也是真实观测）；
 * - **异常检测**：中位数 + MAD（绝对中位差）鲁棒 z 分数——对离群值
 *   天然免疫（均值/标准差会被异常值本身污染，中位数不会）；
 * - **what-if 模拟**：在观测日均值基线上叠加三种场景算子——调用量
 *   倍数（线性缩放）、缓存命中率（按现价表分解输入成本重算）、
 *   模型迁移（按观测到的每调用均价估算目标模型成本）；
 * - **变化归因**：对比两个等长窗口，按模型分解费用变化的贡献份额，
 *   定位「这个月多花的钱去哪了」。
 */
import type { DailyUsage } from '../../core/usage.js';
import type { ModelPrice } from '../../core/price/types.js';
/** 模型价格解析器（price 引擎的 resolve 签名；无价格返回 undefined）。 */
export type PriceResolver = (model: string, atMs: number) => ModelPrice | undefined;
/** 预测点：未来某天的费用预测值。 */
export interface ForecastPoint {
    day: string;
    predictedCny: number;
}
/** 支出预测结果。 */
export interface ForecastResult {
    /** 参与拟合的历史天数（含补零天）。 */
    historyDays: number;
    /** 数据是否足以预测（历史 ≥ MIN_HISTORY_DAYS 且有非零观测）。 */
    sufficient: boolean;
    /** 线性趋势（元/天；正 = 上升趋势）。 */
    slopeCnyPerDay: number;
    /** 拟合优度 R²（0~1；方差为 0 的平坦序列记 1）。 */
    r2: number;
    /** 历史窗口日均费用（元）。 */
    meanDailyCny: number;
    /** 未来 horizon 天的逐日预测。 */
    points: ForecastPoint[];
    /** 本月末费用投影（已花费 + 未来预测到月底）。 */
    monthEndProjectedCny: number;
}
/** 单条异常记录。 */
export interface AnomalyPoint {
    day: string;
    costCny: number;
    /** 期望值（鲁棒基线 = 中位数）。 */
    expectedCny: number;
    /** 实际 / 期望 比值。 */
    deviationRatio: number;
    /** 鲁棒 z 分数（0.6745 × 离差 / MAD）。 */
    robustZ: number;
    severity: 'mild' | 'high' | 'critical';
}
/** 异常检测结果。 */
export interface AnomalyResult {
    anomalies: AnomalyPoint[];
    /** 鲁棒基线（中位数，元）。 */
    medianCny: number;
    /** 绝对中位差（元）。 */
    madCny: number;
    /** 参与统计的活跃天数。 */
    activeDays: number;
}
/** what-if 场景参数。 */
export interface WhatIfScenario {
    /** 调用量倍数（1.5 = 增 50%）；缺省 1。 */
    callVolumeFactor?: number;
    /** 目标缓存命中率（0~1）；缺省不调整。 */
    cacheHitRatio?: number;
    /** 模型迁移：把 from 模型 ratio 比例的调用迁到 to 模型。 */
    modelShift?: ReadonlyArray<{
        from: string;
        to: string;
        ratio: number;
    }>;
}
/** what-if 模拟结果。 */
export interface WhatIfResult {
    /** 历史窗口的日历跨度（天）。 */
    windowDays: number;
    baselineDailyCny: number;
    projectedDailyCny: number;
    deltaDailyCny: number;
    /** 30 天投影费用（元）。 */
    monthlyCny: number;
    /** 按模型分解的基线 vs 投影日费用。 */
    breakdown: ReadonlyArray<{
        model: string;
        baselineDailyCny: number;
        projectedDailyCny: number;
        deltaDailyCny: number;
    }>;
}
/** 归因条目（单模型的窗口间变化）。 */
export interface AttributionEntry {
    model: string;
    currentCny: number;
    previousCny: number;
    deltaCny: number;
    /** 占总变化的份额（总变化为 0 时全部为 0）。 */
    shareRatio: number;
    currentCalls: number;
    previousCalls: number;
}
/** 变化归因结果。 */
export interface AttributionResult {
    total: {
        currentCny: number;
        previousCny: number;
        deltaCny: number;
        currentCalls: number;
        previousCalls: number;
    };
    /** 按 |deltaCny| 降序。 */
    entries: ReadonlyArray<AttributionEntry>;
}
/**
 * 支出预测：OLS 线性回归 + 外推。
 * @param rows 历史日用量（时间升序或乱序均可，内部按 day 排序）。
 * @param horizonDays 外推天数。
 * @param anchorDay 锚定日（预测从锚定日的次日开始；缺省取序列末日）。
 */
export declare function forecastSpend(rows: readonly DailyUsage[], horizonDays: number, anchorDay?: string): ForecastResult;
/**
 * 异常检测：中位数 + MAD 鲁棒 z 分数。
 * 只统计有记录的活跃天（缺日是间隔不是异常）；费用显著高于基线
 * （z > 3.5）才标记，低花费/零花费不标记（省钱不是异常）。
 */
export declare function detectAnomalies(rows: readonly DailyUsage[]): AnomalyResult;
/**
 * what-if 模拟：观测日均值基线 + 场景算子。
 * 算子组合顺序：调用量倍数 → 缓存命中率 → 模型迁移（顺序应用，
 * 各自的增量按「当前状态」计算后在基线上叠加）。
 * @param rows 历史日用量窗口。
 * @param scenario 场景参数。
 * @param priceResolver 模型价格解析器（缓存命中率算子需要现价分解输入成本）。
 * @param windowDays 日历跨度（日均值分母；缺省按观测天数）。
 */
export declare function whatIfSimulate(rows: readonly DailyUsage[], scenario: WhatIfScenario, priceResolver: PriceResolver, windowDays?: number): WhatIfResult;
/**
 * 变化归因：对比两个等长窗口，按模型分解费用变化。
 * 正 delta = 该模型花的更多；shareRatio = 该模型变化占总变化的份额。
 */
export declare function attributeChange(currentRows: readonly DailyUsage[], previousRows: readonly DailyUsage[]): AttributionResult;
