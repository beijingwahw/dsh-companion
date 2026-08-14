/**
 * 用量记账：按北京时间日粒度聚合，支撑成本报表（每日/每周）。
 * 记录保存在存储域 usage-daily 表，原子 update 避免并发写丢失。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'
import { round4 } from './pricing.js'
import { beijingDayKey, beijingMonthKey } from './time.js'

export interface ModelUsageSlice {
  calls: number
  promptTokens: number
  completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省，读取侧按 0 处理）。 */
  cacheHitTokens?: number
  costCny: number
}

export interface DailyUsage {
  /** 北京时间日期键 YYYY-MM-DD。 */
  day: string
  calls: number
  promptTokens: number
  completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省，读取侧按 0 处理）。 */
  cacheHitTokens?: number
  costCny: number
  /** 通过模型路由/峰谷调度节省的估算金额。 */
  savedCny: number
  /** 被峰谷调度延迟执行的调用数。 */
  deferredCalls: number
  byModel: Record<string, ModelUsageSlice>
}

export interface UsageDelta {
  ts: number
  model: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  costCny: number
  savedCny?: number
  deferred?: boolean
}

export interface UsageTotal {
  calls: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  costCny: number
  savedCny: number
  deferredCalls: number
}

export class UsageStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<DailyUsage>('usage-daily')
  }

  /** 记录一次调用（原子并入当日聚合）。 */
  async record(delta: UsageDelta): Promise<void> {
    // 入口校验时间戳：非法值（NaN/Infinity 等）会派生出 "NaN-NaN-NaN" 日键并污染落盘数据。
    if (!Number.isFinite(delta.ts)) {
      throw new TypeError(`usage.record: delta.ts 必须是有限数字，实际为 ${String(delta.ts)}`)
    }
    const day = beijingDayKey(delta.ts)
    const cacheHitTokens = delta.cacheHitTokens ?? 0
    await this.table.update(day, (prev) => {
      const base: DailyUsage = prev ?? {
        day,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        costCny: 0,
        savedCny: 0,
        deferredCalls: 0,
        byModel: {},
      }
      const slice: ModelUsageSlice = base.byModel[delta.model] ?? {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        costCny: 0,
      }
      return {
        ...base,
        calls: base.calls + 1,
        promptTokens: base.promptTokens + delta.promptTokens,
        completionTokens: base.completionTokens + delta.completionTokens,
        cacheHitTokens: (base.cacheHitTokens ?? 0) + cacheHitTokens,
        costCny: round4(base.costCny + delta.costCny),
        savedCny: round4(base.savedCny + (delta.savedCny ?? 0)),
        deferredCalls: base.deferredCalls + (delta.deferred ? 1 : 0),
        byModel: {
          ...base.byModel,
          [delta.model]: {
            calls: slice.calls + 1,
            promptTokens: slice.promptTokens + delta.promptTokens,
            completionTokens: slice.completionTokens + delta.completionTokens,
            cacheHitTokens: (slice.cacheHitTokens ?? 0) + cacheHitTokens,
            costCny: round4(slice.costCny + delta.costCny),
          },
        },
      }
    })
  }

  /** 读取 [fromDay, toDay] 闭区间内的日聚合，按日期升序。 */
  range(fromDay: string, toDay: string): DailyUsage[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((u) => u.day >= fromDay && u.day <= toDay)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }

  /** 读取某时间戳所在北京时间月的全部日聚合。 */
  month(ts: number): DailyUsage[] {
    const prefix = beijingMonthKey(ts)
    return this.range(`${prefix}-01`, `${prefix}-31`)
  }

  /** 汇总若干日聚合。 */
  total(rows: readonly DailyUsage[]): UsageTotal {
    const total: UsageTotal = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      costCny: 0,
      savedCny: 0,
      deferredCalls: 0,
    }
    for (const row of rows) {
      total.calls += row.calls
      total.promptTokens += row.promptTokens
      total.completionTokens += row.completionTokens
      total.cacheHitTokens += row.cacheHitTokens ?? 0
      total.costCny = round4(total.costCny + row.costCny)
      total.savedCny = round4(total.savedCny + row.savedCny)
      total.deferredCalls += row.deferredCalls
    }
    return total
  }
}
