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
import type { TranscriptTurn } from '../../core/transcript.js'

/** DeepSeek V3 官方上下文窗口（token）。保守可调小以提前预警。 */
export const CONTEXT_WINDOW_TOKENS = 65_536

/** 为模型输出预留的 token（预测"还能聊几轮"时扣除）。 */
export const RESERVED_OUTPUT_TOKENS = 4_096

/** 耗尽预测的近端回合窗口（线性外推的采样窗口）。 */
const RECENT_TURN_WINDOW = 10

/** 每回合的角色/定界开销（token）。 */
const PER_TURN_OVERHEAD_TOKENS = 6

/** 判定 CJK 表意文字（含兼容表意区）。 */
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/** 判定全角标点/全角形式区（近似按 CJK 计价）。 */
function isFullwidthCode(code: number): boolean {
  return (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)
}

/**
 * 启发式 token 估算：CJK/全角字符 × 0.6 + 其余字符 ÷ 4。
 * @param text 原始文本。
 */
export function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (isCjkCode(code) || isFullwidthCode(code)) wide += 1
    else narrow += 1
  }
  return Math.ceil(wide * 0.6 + narrow / 4)
}

/** 上下文健康等级。 */
export type ContextHealthLevel = 'healthy' | 'watch' | 'advice' | 'critical'

/** 上下文压力评估结果。 */
export interface ContextHealth {
  /** 会话历史估算 token（含每回合开销）。 */
  readonly estimatedTokens: number
  /** 上下文窗口（token）。 */
  readonly windowTokens: number
  /** 已用比例（0-1）。 */
  readonly ratio: number
  /** 近端回合平均 token（增速）。 */
  readonly avgTurnTokens: number
  /** 预计还可进行的回合数（不足 2 回合时不预测，为 null）。 */
  readonly remainingTurns: number | null
  /** 健康等级。 */
  readonly level: ContextHealthLevel
  /** 行动建议文案。 */
  readonly suggestion: string
}

/** 按比例分级并给出行动建议。 */
function classify(ratio: number): { level: ContextHealthLevel; suggestion: string } {
  if (ratio >= 0.9) {
    return {
      level: 'critical',
      suggestion: '上下文即将耗尽：请立即生成交接摘要并开启新会话，避免历史被截断丢失',
    }
  }
  if (ratio >= 0.75) {
    return {
      level: 'advice',
      suggestion: '上下文压力偏高：建议现在生成交接摘要，为剩余讨论预留空间',
    }
  }
  if (ratio >= 0.5) {
    return {
      level: 'watch',
      suggestion: '上下文已过半：可关注压力变化，超过 75% 时再交接',
    }
  }
  return { level: 'healthy', suggestion: '上下文充裕，无需交接' }
}

/**
 * 计算上下文压力评估。
 * @param turns 会话转录（时间序）。
 * @param options 可覆盖窗口与输出预留（测试/调参用）。
 */
export function computeContextHealth(
  turns: readonly TranscriptTurn[],
  options: { windowTokens?: number; reservedOutputTokens?: number } = {},
): ContextHealth {
  const windowTokens = options.windowTokens ?? CONTEXT_WINDOW_TOKENS
  const reservedOutputTokens = options.reservedOutputTokens ?? RESERVED_OUTPUT_TOKENS
  let estimatedTokens = 0
  for (const turn of turns) {
    estimatedTokens += estimateTokens(turn.text) + PER_TURN_OVERHEAD_TOKENS
  }
  const ratio = windowTokens > 0 ? Math.min(1, estimatedTokens / windowTokens) : 1
  // 近端增速：最后 N 个非空回合的平均 token。
  const recent = turns.filter((turn) => turn.text.trim().length > 0).slice(-RECENT_TURN_WINDOW)
  const avgTurnTokens =
    recent.length > 0
      ? recent.reduce((sum, turn) => sum + estimateTokens(turn.text) + PER_TURN_OVERHEAD_TOKENS, 0) /
        recent.length
      : 0
  // 耗尽预测：线性外推（窗口 - 已用 - 输出预留）/ 平均增速。
  let remainingTurns: number | null = null
  if (turns.length >= 2 && avgTurnTokens > 0) {
    remainingTurns = Math.max(
      0,
      Math.floor((windowTokens - estimatedTokens - reservedOutputTokens) / avgTurnTokens),
    )
  }
  const { level, suggestion } = classify(ratio)
  return {
    estimatedTokens,
    windowTokens,
    ratio: Number(ratio.toFixed(4)),
    avgTurnTokens: Math.ceil(avgTurnTokens),
    remainingTurns,
    level,
    suggestion,
  }
}
