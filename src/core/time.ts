/**
 * 北京时间（UTC+8，无夏令时）工具：峰谷判定、日/月键、格式化。
 * 成本模块的峰谷调度与预算按月统计都以北京时间为准。
 */

/** 高峰时段窗口（北京时间，左闭右开）。 */
export interface PeakWindow {
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
}

/** 需求规定的高峰时段：9:00-12:00 与 14:00-18:00。 */
export const DEFAULT_PEAK_WINDOWS: readonly PeakWindow[] = [
  { startHour: 9, startMinute: 0, endHour: 12, endMinute: 0 },
  { startHour: 14, startMinute: 0, endHour: 18, endMinute: 0 },
]

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export interface BeijingParts {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  hour: number
  minute: number
  /** 0-59 */
  second: number
  /** 0=周日 */
  weekday: number
}

/** 取某时间戳的北京时间各分量。 */
export function beijingParts(ts: number): BeijingParts {
  const d = new Date(ts + BEIJING_OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  }
}

/** 北京时间日期键 YYYY-MM-DD。 */
export function beijingDayKey(ts: number): string {
  const p = beijingParts(ts)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** 北京时间月份键 YYYY-MM。 */
export function beijingMonthKey(ts: number): string {
  const p = beijingParts(ts)
  return `${p.year}-${pad2(p.month)}`
}

/** 北京时间格式化 YYYY-MM-DD HH:mm:ss。 */
export function formatBeijingTime(ts: number): string {
  const p = beijingParts(ts)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`
}

/** 判断某时刻是否处于高峰时段（支持跨午夜窗口：start > end 时视为环绕）。 */
export function isPeakTime(
  ts: number,
  windows: readonly PeakWindow[] = DEFAULT_PEAK_WINDOWS,
): boolean {
  const { hour, minute } = beijingParts(ts)
  const nowMinutes = hour * 60 + minute
  return windows.some((w) => {
    const start = w.startHour * 60 + w.startMinute
    const end = w.endHour * 60 + w.endMinute
    if (start > end) {
      // 跨午夜窗口（如 22:00-06:00）：now >= start 或 now < end 均算高峰。
      return nowMinutes >= start || nowMinutes < end
    }
    return nowMinutes >= start && nowMinutes < end
  })
}

/**
 * 从某时刻起，下一个处于空闲（非高峰）时段的分钟边界。
 * 仅在调用方已确认 isPeakTime(ts) 为真时使用。
 *
 * 直接计算包含当前时刻的各高峰窗口的结束时刻并取最大值（O(窗口数)），
 * 不再逐分钟扫描；无窗口包含时兜底返回下一分钟。
 */
export function nextOffPeakStart(
  ts: number,
  windows: readonly PeakWindow[] = DEFAULT_PEAK_WINDOWS,
): number {
  const minuteFloor = Math.floor(ts / 60_000) * 60_000
  const parts = beijingParts(minuteFloor)
  const nowMinutes = parts.hour * 60 + parts.minute
  // 当日 00:00 的北京时间时间戳（Date.UTC 自动归一化）。
  const dayStartUtc = Date.UTC(parts.year, parts.month - 1, parts.day)
  const dayStartTs = dayStartUtc - BEIJING_OFFSET_MS

  let best = 0
  for (const w of windows) {
    const start = w.startHour * 60 + w.startMinute
    const end = w.endHour * 60 + w.endMinute
    const inWindow =
      start > end ? nowMinutes >= start || nowMinutes < end : nowMinutes >= start && nowMinutes < end
    if (!inWindow) continue
    // 结束时刻：跨午夜窗口且当前处于午夜后段时，结束在今日；否则可能需顺延到明日。
    const endTsToday = dayStartTs + end * 60_000
    const endTs = endTsToday > minuteFloor ? endTsToday : endTsToday + 24 * 60 * 60_000
    if (endTs > best) best = endTs
  }
  return best > 0 ? best : minuteFloor + 60_000
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
