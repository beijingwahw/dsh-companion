/**
 * 预算闸门：按北京时间日/月双档预算拦截非必要调用
 * （日预算吸收自 dsh-usage-ledger 的 dailyBudget 控制）。
 *
 * - 用量达 80%：告警一次（warning）；
 * - 用量达 100%：告警一次（error）并暂停非必要调用
 *   （抛 DeepSeekApiError 'INSUFFICIENT_BALANCE'；essential 调用仍放行）。
 * 任一档（日或月）用尽即暂停。告警去重经 Domain 表 `budget-state`
 * （键=北京日/月周期键）持久化，每周期每级只告警一次；
 * 进程内另以 Set 防并发重复。
 *
 * 已知局限（TOCTOU）：check() 是“读时放行”的闸门，而调用费用在调用完成
 * 之后才记账落盘；并发场景下多个调用可能在任一记账落地前集体通过检查，
 * 超支量级 ≈ 并发调用数 × 单次调用费用。暂不引入锁/额度预占等复杂方案。
 * 另：用量读取带短 TTL 内存缓存（见 SPENT_CACHE_TTL_MS），缓存窗口内
 * 的新增花费对闸门不可见，属同一量级的已知近似。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage'
import { DeepSeekApiError } from '../../core/deepseek.js'
import { round4 } from '../../core/pricing.js'
import { beijingDayKey, beijingMonthKey } from '../../core/time.js'
import type { UsageStore } from '../../core/usage.js'
import type { CostSettings } from './settings.js'

/** 预算告警状态记录：某周期（日/月）各级告警是否已发出。 */
export interface BudgetStateRecord {
  alerted80: boolean
  alerted100: boolean
}

/** 预算状态快照（供 /cost/state 等展示）。 */
export interface BudgetSnapshot {
  /** 日预算（元）；0 表示不限。 */
  dailyCny: number
  /** 今日已花费（元，北京时间日）。 */
  dailySpentCny: number
  /** 日用量/日预算比值（日预算为 0 时取 0）。 */
  dailyRatio: number
  /** 月度预算（元）；0 表示不限。 */
  monthlyCny: number
  /** 本月已花费（元）。 */
  spentCny: number
  /** 用量/预算比值（预算为 0 时取 0）。 */
  ratio: number
  /** 是否已暂停非必要调用（任一档用尽）。 */
  paused: boolean
}

/** 用量缓存 TTL（毫秒）：热路径免全表扫描的短窗口近似。 */
const SPENT_CACHE_TTL_MS = 15_000

/** 用量缓存条目：周期键 + 花费合计 + 计算时刻。 */
interface SpentCacheEntry {
  periodKey: string
  spentCny: number
  atMs: number
}

/** 预算档位：日或月。 */
type BudgetTier = 'daily' | 'monthly'

/** 预算闸门（日/月双档）。 */
export class BudgetGuard {
  private readonly table: KvTable<BudgetStateRecord>
  /** 进程内去重：避免并发调用在写链落盘前重复告警。 */
  private readonly alerted = new Set<string>()
  /** 日用量短 TTL 缓存：跨日或过期失效。 */
  private dailyCache: SpentCacheEntry | undefined
  /** 月用量短 TTL 缓存：跨月或过期失效。 */
  private monthlyCache: SpentCacheEntry | undefined

  /**
   * @param ctx 插件上下文（发事件与通知）。
   * @param domain companion 存储域（budget-state 表）。
   * @param usage 用量账本。
   * @param getSettings 实时读取成本设置。
   */
  constructor(
    private readonly ctx: Context,
    domain: Domain,
    private readonly usage: UsageStore,
    private readonly getSettings: () => CostSettings,
  ) {
    this.table = domain.table<BudgetStateRecord>('budget-state')
  }

  /**
   * 调用前预算检查：先日后月，任一档用尽即拦截非必要调用。
   * @param essential 必要调用：预算用尽时仍放行（只告警不拦截）。
   * @throws DeepSeekApiError 预算用尽且非必要调用。
   */
  async check(essential: boolean): Promise<void> {
    const settings = this.getSettings()
    const now = Date.now()
    // 日预算档：用尽即拦截（80% 告警不拦截）。
    if (settings.dailyBudgetCny > 0) {
      const spentCny = this.spentToday(now)
      if (spentCny >= settings.dailyBudgetCny) {
        await this.alertOnce('daily', beijingDayKey(now), 100, spentCny, settings.dailyBudgetCny)
        if (!essential) {
          throw new DeepSeekApiError('今日预算已用尽，非必要调用已暂停', 'INSUFFICIENT_BALANCE')
        }
        return
      }
      if (spentCny >= settings.dailyBudgetCny * 0.8) {
        await this.alertOnce('daily', beijingDayKey(now), 80, spentCny, settings.dailyBudgetCny)
      }
    }
    // 月预算档。
    if (settings.monthlyBudgetCny <= 0) return // 0 = 不限
    const spentCny = this.spentThisMonth(now)
    if (spentCny >= settings.monthlyBudgetCny) {
      await this.alertOnce('monthly', beijingMonthKey(now), 100, spentCny, settings.monthlyBudgetCny)
      if (!essential) {
        throw new DeepSeekApiError('月度预算已用尽，非必要调用已暂停', 'INSUFFICIENT_BALANCE')
      }
      return
    }
    if (spentCny >= settings.monthlyBudgetCny * 0.8) {
      await this.alertOnce('monthly', beijingMonthKey(now), 80, spentCny, settings.monthlyBudgetCny)
    }
  }

  /** 当前是否已暂停非必要调用（任一档预算>0 且用量已达该档预算）。 */
  paused(): boolean {
    const settings = this.getSettings()
    const now = Date.now()
    if (settings.dailyBudgetCny > 0 && this.spentToday(now) >= settings.dailyBudgetCny) return true
    if (settings.monthlyBudgetCny > 0 && this.spentThisMonth(now) >= settings.monthlyBudgetCny) return true
    return false
  }

  /** 预算状态快照（日/月各读一次用量，TTL 缓存内复用）。 */
  state(): BudgetSnapshot {
    const settings = this.getSettings()
    const now = Date.now()
    const dailySpentCny = this.spentToday(now)
    const spentCny = this.spentThisMonth(now)
    const dailyPaused = settings.dailyBudgetCny > 0 && dailySpentCny >= settings.dailyBudgetCny
    const monthlyPaused = settings.monthlyBudgetCny > 0 && spentCny >= settings.monthlyBudgetCny
    return {
      dailyCny: settings.dailyBudgetCny,
      dailySpentCny,
      dailyRatio: settings.dailyBudgetCny > 0 ? round4(dailySpentCny / settings.dailyBudgetCny) : 0,
      monthlyCny: settings.monthlyBudgetCny,
      spentCny,
      ratio: settings.monthlyBudgetCny > 0 ? round4(spentCny / settings.monthlyBudgetCny) : 0,
      paused: dailyPaused || monthlyPaused,
    }
  }

  /**
   * 今日（北京时间）已花费合计。
   * 带短 TTL 内存缓存：跨日或过期失效，避免热路径反复全表扫描。
   */
  private spentToday(ts: number): number {
    const dayKey = beijingDayKey(ts)
    const cached = this.dailyCache
    if (cached && cached.periodKey === dayKey && ts - cached.atMs < SPENT_CACHE_TTL_MS) {
      return cached.spentCny
    }
    const spentCny = this.usage.total(this.usage.range(dayKey, dayKey)).costCny
    this.dailyCache = { periodKey: dayKey, spentCny, atMs: ts }
    return spentCny
  }

  /**
   * 本月（北京时间）已花费合计。
   * 带短 TTL 内存缓存：跨月或过期失效，避免热路径（每次调用检查、
   * state/paused 重复调用）反复全表扫描。
   */
  private spentThisMonth(ts: number): number {
    const monthKey = beijingMonthKey(ts)
    const cached = this.monthlyCache
    if (cached && cached.periodKey === monthKey && ts - cached.atMs < SPENT_CACHE_TTL_MS) {
      return cached.spentCny
    }
    const spentCny = this.usage.total(this.usage.month(ts)).costCny
    this.monthlyCache = { periodKey: monthKey, spentCny, atMs: ts }
    return spentCny
  }

  /**
   * 每周期（日/月）每级只告警一次：持久化状态 + 进程内去重，随后发事件与通知。
   * 先写盘、成功后才标记进程内去重：写盘失败不标记也不阻塞调用，
   * 告警照常发出（宁可后续重复告警，不可永久吞掉）。
   */
  private async alertOnce(
    tier: BudgetTier,
    period: string,
    level: 80 | 100,
    spentCny: number,
    budgetCny: number,
  ): Promise<void> {
    // 存储键带档位前缀：日键（YYYY-MM-DD）与月键（YYYY-MM）天然不冲突，
    // 前缀仅为可读性与防御。
    const storeKey = `${tier}:${period}`
    const dedupeKey = `${storeKey}:${level}`
    if (this.alerted.has(dedupeKey)) return
    const record = this.table.get(storeKey)
    if (record && (level === 80 ? record.alerted80 : record.alerted100)) {
      this.alerted.add(dedupeKey)
      return
    }
    try {
      await this.table.update(storeKey, (prev) => {
        const base: BudgetStateRecord = prev ?? { alerted80: false, alerted100: false }
        return level === 80 ? { ...base, alerted80: true } : { ...base, alerted100: true }
      })
      // 仅在写盘成功后标记去重：失败时保留重试与再次告警的机会。
      this.alerted.add(dedupeKey)
    } catch (error) {
      // 写盘失败降级为提示，但不阻塞当前调用，也不吞掉本次告警。
      this.ctx.companion.notice(
        'warning',
        `预算告警状态持久化失败（本次告警照常发出，去重可能失效）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const periodLabel = tier === 'daily' ? '今日' : '本月'
    this.ctx.emit('companion/budget-alert', {
      level,
      tier,
      period,
      spentCny,
      budgetCny,
      paused: level === 100,
    })
    this.ctx.companion.notice(
      level === 100 ? 'error' : 'warning',
      level === 100
        ? `${periodLabel} API 用量已达预算上限（¥${spentCny.toFixed(4)} / ¥${budgetCny.toFixed(2)}），非必要调用已暂停`
        : `${periodLabel} API 用量已达预算的 80%（¥${spentCny.toFixed(4)} / ¥${budgetCny.toFixed(2)}），请注意控制`,
    )
  }
}
