/**
 * 模块 H4：定时调度 —— 轻量 Cron 解析与自然语言转换。
 *
 * - 标准 5 字段 Cron（分 时 日 月 周），支持 *、逗号列表、a-b 范围、星号步长；
 * - 自然语言（中文）→ Cron：覆盖“每天凌晨 2 点”“每隔 30 分钟”等常见表达；
 * - 基于北京时间（UTC+8）计算下一次触发时刻。
 */
import { beijingParts, type BeijingParts } from '../../core/time.js'

/** 毫秒常量。 */
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60_000
/** 北京时间固定 UTC+8 偏移。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60_000

/** Cron 单字段解析结果：允许的值集合。 */
interface CronField {
  readonly values: ReadonlySet<number>
}

const FIELD_RANGES = [
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 6 }, // 周（0=周日）
] as const

/** 解析单个 Cron 字段；非法时抛错。 */
function parseField(text: string, range: { min: number; max: number }): CronField {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) throw new Error('Cron 字段不能为空')
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? Number(stepMatch[2]) : 1
    const base = stepMatch ? stepMatch[1] : trimmed
    if (step < 1) throw new Error('Cron 步长必须为正整数')
    let start: number
    let end: number
    if (base === '*') {
      start = range.min
      end = range.max
    } else {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        start = Number(rangeMatch[1])
        end = Number(rangeMatch[2])
      } else if (/^\d+$/.test(base)) {
        start = Number(base)
        end = step > 1 && !stepMatch ? start : Number(base)
        if (stepMatch) end = range.max
      } else {
        throw new Error(`无法解析 Cron 字段：${trimmed}`)
      }
    }
    if (start < range.min || end > range.max || start > end) {
      throw new Error(`Cron 字段超出范围 [${range.min}, ${range.max}]：${trimmed}`)
    }
    for (let v = start; v <= end; v += step) values.add(v)
  }
  return { values }
}

/** 解析后的 Cron 表达式。 */
export interface ParsedCron {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
  /** 日字段与周字段是否同时被显式指定（两者同时指定时按 OR 组合）。 */
  readonly dayOrWeek: boolean
}

/** 解析 5 字段 Cron 表达式；非法时抛错。 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Cron 表达式必须是 5 个字段（分 时 日 月 周）')
  const minute = parseField(fields[0], FIELD_RANGES[0])
  const hour = parseField(fields[1], FIELD_RANGES[1])
  const dayOfMonth = parseField(fields[2], FIELD_RANGES[2])
  const month = parseField(fields[3], FIELD_RANGES[3])
  const dayOfWeek = parseField(fields[4], FIELD_RANGES[4])
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOrWeek: fields[2] !== '*' && fields[4] !== '*',
  }
}

/** 由北京时间分量构造时间戳（UTC+8 固定偏移，Date.UTC 自动归一化溢出）。 */
function beijingToTs(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

/** 集合中 ≥ from 的最小值；无则 undefined。 */
function nextAtLeast(values: ReadonlySet<number>, from: number): number | undefined {
  let best: number | undefined
  for (const value of values) {
    if (value >= from && (best === undefined || value < best)) best = value
  }
  return best
}

/** 日匹配（日与周同时指定时按 OR，与标准 cron 一致）。 */
function dayMatches(cron: ParsedCron, parts: BeijingParts): boolean {
  const domMatch = cron.dayOfMonth.values.has(parts.day)
  const dowMatch = cron.dayOfWeek.values.has(parts.weekday)
  return cron.dayOrWeek ? domMatch || dowMatch : domMatch && dowMatch
}

/**
 * 计算下一次触发时刻（严格晚于 fromMs，分钟精度）。
 *
 * 字段跳跃算法：不逐分钟扫描，而是在月/日/时/分各层级直接跳到下一个候选
 * 时刻。迭代次数约为“天数 × 小常数”，对“每年仅触发一次”这类稀疏表达式
 * 也能在毫秒内给出结果（旧的逐分钟扫描最坏需迭代上百万次）。
 * 上限扫描 4 年；无解返回 undefined。
 */
export function nextCronFire(cron: ParsedCron, fromMs: number): number | undefined {
  let t = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = t + 4 * 366 * DAY_MS
  for (let guard = 0; guard < 5000 && t < limit; guard += 1) {
    const parts = beijingParts(t)

    if (!cron.month.values.has(parts.month)) {
      const nextMonth = nextAtLeast(cron.month.values, parts.month + 1)
      t =
        nextMonth !== undefined
          ? beijingToTs(parts.year, nextMonth, 1, 0, 0)
          : beijingToTs(parts.year + 1, nextAtLeast(cron.month.values, 1) ?? 1, 1, 0, 0)
      continue
    }

    if (!dayMatches(cron, parts)) {
      t = beijingToTs(parts.year, parts.month, parts.day + 1, 0, 0)
      continue
    }

    if (!cron.hour.values.has(parts.hour)) {
      const nextHour = nextAtLeast(cron.hour.values, parts.hour + 1)
      t =
        nextHour !== undefined
          ? beijingToTs(parts.year, parts.month, parts.day, nextHour, 0)
          : beijingToTs(parts.year, parts.month, parts.day + 1, 0, 0)
      continue
    }

    if (!cron.minute.values.has(parts.minute)) {
      const nextMinute = nextAtLeast(cron.minute.values, parts.minute + 1)
      t =
        nextMinute !== undefined
          ? beijingToTs(parts.year, parts.month, parts.day, parts.hour, nextMinute)
          : beijingToTs(parts.year, parts.month, parts.day, parts.hour + 1, 0)
      continue
    }

    return t
  }
  return undefined
}

/** 中文数字映射。 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  十: 10, 十一: 11, 十二: 12, 二十: 20, 三十: 30, 半: 30,
}

/** 解析中文数字（支持 0-59 的常见写法）。 */
function parseCnNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)
  if (CN_DIGITS[text] !== undefined) return CN_DIGITS[text]
  const tens = text.match(/^([一二三四五六]?)(十)([一二三四五六七八九]?)$/)
  if (tens) {
    const t = tens[1] ? CN_DIGITS[tens[1]] : 1
    const u = tens[3] ? CN_DIGITS[tens[3]] : 0
    return t * 10 + u
  }
  return undefined
}

/** 时段词 → 小时。 */
const PERIOD_HOURS: Array<{ pattern: RegExp; hour: number }> = [
  { pattern: /凌晨/, hour: 0 },
  { pattern: /清晨|早上|上午/, hour: 8 },
  { pattern: /中午/, hour: 12 },
  { pattern: /下午/, hour: 12 },
  { pattern: /傍晚/, hour: 18 },
  { pattern: /晚上|夜里|晚间/, hour: 20 },
]

/**
 * 自然语言 → Cron 表达式（中文常见表达）；无法识别时抛错。
 * 支持：每天/每周X/每月X号 + 时刻；每隔 N 分钟/小时。
 */
export function naturalLanguageToCron(text: string): string {
  const input = text.trim()
  if (!input) throw new Error('定时表达式不能为空')
  // 已是标准 Cron 直接返回。
  if (/^[\d*,/\- ]+$/.test(input) && input.trim().split(/\s+/).length === 5) {
    parseCron(input) // 校验合法性
    return input.trim()
  }

  // 每隔 N 分钟 / 每 N 分钟
  let match = input.match(/每(?:隔)?\s*(\d+|[一二三四五六七八九十]+)\s*分钟/)
  if (match) {
    const n = parseCnNumber(match[1])
    if (!n || n < 1 || n > 59) throw new Error('间隔分钟数必须在 1-59 之间')
    return `*/${n} * * * *`
  }
  // 每隔 N 小时 / 每 N 小时
  match = input.match(/每(?:隔)?\s*(\d+|[一二三四五六七八九十]+)\s*(?:个)?小时/)
  if (match) {
    const n = parseCnNumber(match[1])
    if (!n || n < 1 || n > 23) throw new Error('间隔小时数必须在 1-23 之间')
    return `0 */${n} * * *`
  }

  // 周期部分：每天 / 每周X / 每周一 / 每月X号
  let dom = '*'
  let dow = '*'
  if (/每天|每日/.test(input)) {
    // 缺省即每天
  } else if ((match = input.match(/每(?:周|星期|礼拜)([一二三四五六日天])/))) {
    const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
    dow = String(map[match[1]])
  } else if ((match = input.match(/每月\s*(\d+|[一二三四五六七八九十]+)\s*[号日]/))) {
    const day = parseCnNumber(match[1])
    if (!day || day < 1 || day > 31) throw new Error('日期必须在 1-31 之间')
    dom = String(day)
  } else if (!/每/.test(input)) {
    throw new Error('无法识别周期，请使用“每天/每周X/每月X号”或标准 Cron 表达式')
  }

  // 时刻部分：凌晨 2 点 / 下午 3 点半 / 14:30 / 8 点 30 分
  let hour: number | undefined
  let minute = 0
  let timeMatched = false

  const clock = input.match(/(\d{1,2})[:：](\d{1,2})/)
  if (clock) {
    hour = Number(clock[1])
    minute = Number(clock[2])
    timeMatched = true
  } else {
    const point = input.match(/(\d+|[一二三四五六七八九十]+)\s*[点时](?:\s*(半|\d+|[一二三四五六七八九十]+)\s*分?)?/)
    if (point) {
      hour = parseCnNumber(point[1])
      minute = point[2] ? parseCnNumber(point[2]) ?? 0 : 0
      timeMatched = true
    }
  }
  if (!timeMatched || hour === undefined) {
    throw new Error('无法识别时刻，请写明具体时间（如“凌晨 2 点”“14:30”）')
  }
  if (minute === undefined || Number.isNaN(minute)) minute = 0
  // 时段修正：下午/晚上/夜里 + 12 小时制。
  for (const { pattern, hour: base } of PERIOD_HOURS) {
    if (pattern.test(input)) {
      if (base === 12 && hour < 12) hour += 12
      else if (base === 0 && hour === 12) hour = 0
      else if (base === 20 && hour < 12) hour += 12
      break
    }
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('时刻超出范围')
  }
  return `${minute} ${hour} ${dom} * ${dow}`
}
