/**
 * 临界预警引擎（轴线 35）：复杂系统临界转换的先行信号检测
 * （Early-Warning Signals，Scheffer et al. 2009, Nature）。
 *
 * 设计动机：轴线 30（BOCPD）在切换**发生后**定位变点——那是考古；
 * 没有任何组件回答「注意力是否**正在逼近**一次主题相变」。复杂系统
 * 在逼近分岔点时普遍出现**临界慢化**（critical slowing down）：主导
 * 特征值趋零 → 系统从扰动中回弹变慢 → 在观测序列上表现为两条统计
 * 律——滞后 1 自相关（AR(1)）系统性上升、方差系统性放大。
 *
 * 本引擎把会话流的新奇度（每场对话与其前 W 场基线的一元分布
 * JS 散度）作为指示序列，在其上检验三证据：
 *
 * - **持续性**（AR(1) 上升）：新奇度涨了之后**停留**得更久——
 *   系统对扰动的恢复力在减弱（AR(1) 是主导特征值的矩估计）；
 * - **发散性**（方差上升）：新奇度波动的振幅在放大——系统在
 *   相变边缘「晃得更远」；
 * - **漂移性**（近期斜率上升）：新奇度水平本身在爬升——注意力
 *   正在离开当前主题的吸引盆。
 *
 * 三证据加权融合为 [0,1] 预警分：持续 45% + 发散 30% + 漂移 25%。
 * warning 级额外要求**至少两类证据在场**（证据值 > 0.1 计数）——这是
 * Scheffer 2009 的多指标纪律：任何单一先行指标都可能误报，共现才是
 * 相变的指纹。一次性跳变后回落会被漂移方向与方差对比否决——那是
 * 轴线 30 的变点，不是临界慢化。
 *
 * 与相邻轴线的分工：轴线 30 看浪（变点定位，后视），本轴看洋流的
 * 拐点（相变逼近，前瞻）；轴线 23 的遗忘预测作用于记忆侧，本轴
 * 作用于注意力侧。行动出口：warning 级建议立即为当前主题生成交接
 * 摘要（模块 B）——趁注意力盆地切换前把上下文存档。
 *
 * 全部计算纯本地、确定性、零 LLM、零网络。
 */
/** 临界预警的观测单元（与主题漂移同构：会话标题 + 实体名投影）。 */
export interface EarlyWarningUnit {
    /** 单元 id（会话 id 或任意稳定标识）。 */
    readonly id: string;
    /** 时间戳（毫秒）。 */
    readonly at: number;
    /** 文本（调用方决定粒度；与 drift 单元同源）。 */
    readonly text: string;
}
/** 临界预警配置。 */
export interface EarlyWarningOptions {
    /** 期望段内回看基线窗口（单元数）——新奇度参照系；缺省 16。 */
    readonly baselineUnits?: number;
    /** 进入分析的最小序列长度（不足 → insufficient）；缺省 40。 */
    readonly minUnits?: number;
    /** 滑窗单元上限（时间近端优先）；缺省 240。 */
    readonly maxUnits?: number;
    /** 基线成立所需的最少前置单元；缺省 6。 */
    readonly minBaselineUnits?: number;
}
/** 一段（基线半 / 近期半）的指示序列统计。 */
export interface EarlyWarningHalfStats {
    /** 半窗样本数。 */
    readonly units: number;
    /** 滞后 1 自相关（AR(1)；零方差记 0）。 */
    readonly ar1: number;
    /** 方差（总体口径）。 */
    readonly variance: number;
}
/** 临界预警报告。 */
export interface EarlyWarningReport {
    /** 报告基准时间（最后单元时间戳）。 */
    readonly now: number;
    /** 窗口内单元数。 */
    readonly unitCount: number;
    /** 进入统计的新奇度序列长度。 */
    readonly seriesLength: number;
    /** 基线半统计（序列前半）。 */
    readonly baseline: EarlyWarningHalfStats;
    /** 近期半统计（序列后半）。 */
    readonly recent: EarlyWarningHalfStats;
    /** AR(1) 变化量（近期 − 基线）。 */
    readonly ar1Delta: number;
    /** 方差比（近期 / 基线；基线零方差时按 ε 稳压）。 */
    readonly varianceRatio: number;
    /** 近期半 OLS 斜率（单位：新奇度/单元，标准化见 summary）。 */
    readonly slope: number;
    /** 回弹率 = 1 − 近期 AR(1)（主导特征值到临界点的距离，[0,2]；小 = 逼近）。 */
    readonly returnRate: number;
    /** 三证据融合预警分 [0,1]。 */
    readonly score: number;
    /** 预警分级。 */
    readonly level: 'insufficient' | 'calm' | 'watch' | 'warning';
    /** 近端新奇度序列（供客户端迷你图；封顶 64 点）。 */
    readonly novelty: readonly number[];
    /** 人话摘要。 */
    readonly summary: string;
    /** 行动建议（watch/warning 级附；其余为 undefined）。 */
    readonly advice?: string;
}
/**
 * 临界预警主入口。
 *
 * @param units 观测单元（任意顺序；内部按时间稳定排序后取近端滑窗）。
 * @param options 配置（见 EarlyWarningOptions）。
 */
export declare function detectEarlyWarning(units: readonly EarlyWarningUnit[], options?: EarlyWarningOptions): EarlyWarningReport;
