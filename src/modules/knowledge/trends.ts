/**
 * 主题趋势演化算法（轴线 7，纯函数，无状态，可单测）。
 *
 * 回答"我的注意力正在流向哪里"：
 * - **动量**：实体在近窗口 vs 上一等长窗口的频次变化率
 *   （(recent - previous) / (previous + 1)，分母 +1 平滑冷启动）；
 * - **方向判定**：rising（动量高且近窗口有覆盖）/ falling（上窗口
 *   有覆盖而近窗口消失或骤降）/ stable（其余）；
 * - **周级时间线**：最近 8 周逐周的覆盖会话数（客户端渲染迷你
 *   柱状图，注意力漂移一眼可见）。
 *
 * 时间基准取会话 createdAt（对话发生时刻），与索引的频次信号
 * 解耦：趋势看"多少对话在谈它"，不看"谈了多少次"（单会话内
 * 重复刷屏不构成趋势）。
 */
import type { EntityType } from './entities.js'

/** 一周的毫秒数。 */
const WEEK_MS = 7 * 24 * 3600_000

/** 周级时间线的桶数（最近 8 周）。 */
export const TREND_WEEKS = 8

/** 实体记录输入形状（与 knowledge 模块的 EntityRecord 对齐）。 */
export interface TrendEntityRecord {
  readonly name: string
  readonly type: EntityType
  /** 会话 id → 该会话内频次。 */
  readonly sessions: Readonly<Record<string, number>>
}

/** 趋势输入。 */
export interface TrendInput {
  readonly records: readonly TrendEntityRecord[]
  /** 会话 id → createdAt（毫秒）。 */
  readonly sessionTimes: ReadonlyMap<string, number>
  /** 评估基准时刻（毫秒；测试可注入）。 */
  readonly now: number
  /** 对比窗口长度（天）。 */
  readonly days: number
}

/** 趋势方向。 */
export type TrendDirection = 'rising' | 'falling' | 'stable'

/** 单实体趋势视图。 */
export interface EntityTrend {
  readonly name: string
  readonly type: EntityType
  readonly direction: TrendDirection
  /** 动量：频次变化率（(recent - previous) / (previous + 1)）。 */
  readonly momentum: number
  /** 近窗口覆盖会话数。 */
  readonly recentSessions: number
  /** 上一窗口覆盖会话数。 */
  readonly previousSessions: number
  /** 近窗口累计频次。 */
  readonly recentFreq: number
  /** 上一窗口累计频次。 */
  readonly previousFreq: number
  /** 最近 8 周逐周覆盖会话数（旧 → 新）。 */
  readonly series: readonly number[]
}

/** 上升方向的判定阈值（动量超过且近窗口覆盖 ≥2 个会话）。 */
const RISING_MOMENTUM = 0.5

/** 下降方向的判定阈值（动量低于 -0.6 视为骤降）。 */
const FALLING_MOMENTUM = -0.6

/**
 * 计算实体趋势：近 `days` 天 vs 上一等长窗口的动量与方向，
 * 附最近 8 周逐周覆盖会话数。
 *
 * 排序按"信息量"：|动量| × log(1 + 两窗口频次和)——既显著又有
 * 量的变化排在前；两窗口均无信号的实体直接剔除。
 */
export function computeEntityTrends(input: TrendInput): readonly EntityTrend[] {
  const windowMs = input.days * 24 * 3600_000
  const recentCutoff = input.now - windowMs
  const previousCutoff = input.now - 2 * windowMs
  const trends: EntityTrend[] = []
  for (const record of input.records) {
    let recentSessions = 0
    let previousSessions = 0
    let recentFreq = 0
    let previousFreq = 0
    const series = new Array<number>(TREND_WEEKS).fill(0)
    let signal = false
    for (const [sessionId, freq] of Object.entries(record.sessions)) {
      if (!(freq > 0)) continue
      const time = input.sessionTimes.get(sessionId)
      if (time === undefined) continue
      signal = true
      if (time > recentCutoff) {
        recentSessions += 1
        recentFreq += freq
      } else if (time > previousCutoff) {
        previousSessions += 1
        previousFreq += freq
      }
      // 周级时间线：周桶 0（最近一周）… 7（8 周前）。
      const weeksAgo = Math.floor((input.now - time) / WEEK_MS)
      if (weeksAgo >= 0 && weeksAgo < TREND_WEEKS) {
        series[TREND_WEEKS - 1 - weeksAgo] += 1
      }
    }
    if (!signal) continue
    const momentum = (recentFreq - previousFreq) / (previousFreq + 1)
    let direction: TrendDirection = 'stable'
    if (momentum > RISING_MOMENTUM && recentSessions >= 2) {
      direction = 'rising'
    } else if (previousSessions >= 2 && (recentSessions === 0 || momentum < FALLING_MOMENTUM)) {
      direction = 'falling'
    }
    trends.push({
      name: record.name,
      type: record.type,
      direction,
      momentum: Number(momentum.toFixed(4)),
      recentSessions,
      previousSessions,
      recentFreq,
      previousFreq,
      series,
    })
  }
  // 信息量排序：显著且量大的变化在前；平局按近期覆盖数、名称稳定序。
  trends.sort(
    (a, b) =>
      Math.abs(b.momentum) * Math.log(1 + b.recentFreq + b.previousFreq) -
        Math.abs(a.momentum) * Math.log(1 + a.recentFreq + a.previousFreq) ||
      b.recentSessions - a.recentSessions ||
      a.name.localeCompare(b.name),
  )
  return trends
}
