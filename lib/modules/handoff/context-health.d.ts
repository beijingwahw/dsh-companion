/**
 * 上下文压力监测算法（轴线 6，纯函数，无状态，可单测）。
 *
 * 把"上下文窗口什么时候耗尽"从被动体验（截断/报错）变成可观测、
 * 可预测、可行动的信号：
 * - **token 估算**：CJK ≈ 0.6 token/字、Latin ≈ 1 token/4 字符的
 *   启发式（DeepSeek 分词的经验区间中值，误差约 ±20%，对"何时该
 *   交接"的分级判断足够灵敏）；
 * - **耗尽预测**：近 N 回合的平均 token 增速外推剩余回合数
 *   （线性外推，窗口越大置信越高，不足 2 回合时不预测）；
 * - **建议分级**：healthy（<50%）/ watch（≥50%）/ advice（≥75%）/
 *   critical（≥90%），等级即行动建议——什么时候该生成交接摘要。
 */
import type { TranscriptTurn } from '../../core/transcript.js';
/** DeepSeek V3 官方上下文窗口（token）。保守可调小以提前预警。 */
export declare const CONTEXT_WINDOW_TOKENS = 65536;
/** 为模型输出预留的 token（预测"还能聊几轮"时扣除）。 */
export declare const RESERVED_OUTPUT_TOKENS = 4096;
/**
 * 启发式 token 估算：CJK/全角字符 × 0.6 + 其余字符 ÷ 4。
 * @param text 原始文本。
 */
export declare function estimateTokens(text: string): number;
/** 上下文健康等级。 */
export type ContextHealthLevel = 'healthy' | 'watch' | 'advice' | 'critical';
/** 上下文压力评估结果。 */
export interface ContextHealth {
    /** 会话历史估算 token（含每回合开销）。 */
    readonly estimatedTokens: number;
    /** 上下文窗口（token）。 */
    readonly windowTokens: number;
    /** 已用比例（0-1）。 */
    readonly ratio: number;
    /** 近端回合平均 token（增速）。 */
    readonly avgTurnTokens: number;
    /** 预计还可进行的回合数（不足 2 回合时不预测，为 null）。 */
    readonly remainingTurns: number | null;
    /** 健康等级。 */
    readonly level: ContextHealthLevel;
    /** 行动建议文案。 */
    readonly suggestion: string;
}
/**
 * 计算上下文压力评估。
 * @param turns 会话转录（时间序）。
 * @param options 可覆盖窗口与输出预留（测试/调参用）。
 */
export declare function computeContextHealth(turns: readonly TranscriptTurn[], options?: {
    windowTokens?: number;
    reservedOutputTokens?: number;
}): ContextHealth;
