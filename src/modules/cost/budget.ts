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
 * 调用期权协议（预授权-结算两阶段提交）：
 * check() 是“读时放行”，费用在调用完成后才记账——并发调用可能在任一
 * 记账落地前集体通过检查（TOCTOU）。为此在 invoke 时刻增加 reserve()：
 * 按估算金额锁定额度（预授权），调用完成后 settle(actual) 入账并释放
 * 差额，失败则 release() 全额释放。可用额度恒为
 *   available = budget − spent − Σ在途预留，
 * 不变式收紧为「最终支出 ≤ 预算 + Σ在途(实际−估算)⁺」——超支上界从
 * 「并发数 × 单次全额」降为「并发数 × 估算误差」。预留带 TTL 懒回收
 * （惰性清扫，无空闲定时器）：超时未结算的孤儿预留（调用崩溃路径）在
 * 下次访问时自动释放；TTL 取 apiTimeoutMs + 缓冲，覆盖在途调用窗口。
 * settle 同步推进 spent 缓存，使缓存窗口内的新增花费对闸门即时可见
 * （15s TTL 缓存由此退化为全量扫描的兜底优化，不再是精度近似）。
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
  /** 在途预留合计（元）：已预授权未结算的调用估算费用。 */
  reservedCny: number
}

/** 预授权句柄：settle/release 幂等，交给调用方在 invoke 前后配对使用。 */
export interface Reservation {
  /** 预授权金额（元）。 */
  readonly amountCny: number
  /** 结算：按实际费用入账并释放预留（差额自动回到可用额度）。 */
  settle(actualCny: number): void
  /** 全额释放预留（调用失败/中止路径）。 */
  release(): void
}

/** 内部预留记录。 */
interface ReservationRecord {
  amountCny: number
  expiresAt: number
  settled: boolean
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
  /** 在途预留（调用期权协议）：id → 记录。 */
  private readonly reservations = new Map<number, ReservationRecord>()
  /** 预留自增 id。 */
  private nextReservationId = 0

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

  /**
   * 预授权（调用期权协议）：按估算金额锁定额度，返回结算句柄。
   *
   * 投影口径：任一档（日/月）的 projected = spent + Σ在途预留 + 本次估算
   * 达到该档预算即拒绝非必要调用；essential 调用透支放行（告警）。
   * 告警按「档位 + 周期键」经既有 alertOnce 去重（fire-and-forget，
   * 写盘失败不阻塞调用）。预留带 TTL，由惰性清扫回收孤儿记录。
   * @param estimateCny 估算费用（元）。
   * @param essential 必要调用：预授权不足时仍放行（透支告警）。
   * @param ttlMs 预留有效期：应覆盖单次调用窗口（apiTimeoutMs + 缓冲）。
   * @throws DeepSeekApiError 投影超预算且非必要调用。
   */
  reserve(estimateCny: number, essential: boolean, ttlMs: number): Reservation {
    const now = Date.now()
    this.sweepExpired(now)
    const settings = this.getSettings()
    const reservedTotal = this.reservedTotalCny()
    // 日档：投影（含在途预留）达 100% 拒绝 / 80% 告警。
    if (settings.dailyBudgetCny > 0) {
      const projected = this.spentToday(now) + reservedTotal + estimateCny
      if (projected >= settings.dailyBudgetCny) {
        this.fireAlert('daily', beijingDayKey(now), 100, projected, settings.dailyBudgetCny)
        if (!essential) {
          throw new DeepSeekApiError(
            '今日预算预授权不足（含在途调用），非必要调用已拒绝',
            'INSUFFICIENT_BALANCE',
          )
        }
      } else if (projected >= settings.dailyBudgetCny * 0.8) {
        this.fireAlert('daily', beijingDayKey(now), 80, projected, settings.dailyBudgetCny)
      }
    }
    // 月档。
    if (settings.monthlyBudgetCny > 0) {
      const projected = this.spentThisMonth(now) + reservedTotal + estimateCny
      if (projected >= settings.monthlyBudgetCny) {
        this.fireAlert('monthly', beijingMonthKey(now), 100, projected, settings.monthlyBudgetCny)
        if (!essential) {
          throw new DeepSeekApiError(
            '月度预算预授权不足（含在途调用），非必要调用已拒绝',
            'INSUFFICIENT_BALANCE',
          )
        }
      } else if (projected >= settings.monthlyBudgetCny * 0.8) {
        this.fireAlert('monthly', beijingMonthKey(now), 80, projected, settings.monthlyBudgetCny)
      }
    }
    const id = (this.nextReservationId += 1)
    const record: ReservationRecord = {
      amountCny: estimateCny,
      expiresAt: now + ttlMs,
      settled: false,
    }
    this.reservations.set(id, record)
    return {
      amountCny: estimateCny,
      settle: (actualCny: number): void => {
        if (record.settled) return
        record.settled = true
        this.reservations.delete(id)
        this.applySettlement(actualCny)
      },
      release: (): void => {
        if (record.settled) return
        record.settled = true
        this.reservations.delete(id)
      },
    }
  }

  /** 在途预留合计（元）。 */
  reservedTotalCny(): number {
    this.sweepExpired(Date.now())
    let total = 0
    for (const record of this.reservations.values()) total += record.amountCny
    return round4(total)
  }

  /**
   * 结算推进 spent 缓存：结算的实际费用已由核心服务记账落盘（usage.record），
   * 此处同步累加缓存值使闸门即时可见。并发下若他方恰好全量刷新了缓存，
   * 存在短暂保守方向的重复计入（自愈于缓存 TTL 内，闸门偏严不偏松）。
   */
  private applySettlement(actualCny: number): void {
    if (!Number.isFinite(actualCny) || actualCny <= 0) return
    const now = Date.now()
    const dayKey = beijingDayKey(now)
    const monthKey = beijingMonthKey(now)
    if (this.dailyCache && this.dailyCache.periodKey === dayKey) {
      this.dailyCache = {
        ...this.dailyCache,
        spentCny: round4(this.dailyCache.spentCny + actualCny),
        atMs: now,
      }
    }
    if (this.monthlyCache && this.monthlyCache.periodKey === monthKey) {
      this.monthlyCache = {
        ...this.monthlyCache,
        spentCny: round4(this.monthlyCache.spentCny + actualCny),
        atMs: now,
      }
    }
  }

  /** 惰性清扫：释放超时未结算的孤儿预留（调用崩溃路径），无空闲定时器。 */
  private sweepExpired(now: number): void {
    if (this.reservations.size === 0) return
    for (const [id, record] of this.reservations) {
      if (record.expiresAt <= now) this.reservations.delete(id)
    }
  }

  /** fire-and-forget 告警：写盘与通知失败均不阻塞预授权路径。 */
  private fireAlert(
    tier: BudgetTier,
    period: string,
    level: 80 | 100,
    projectedCny: number,
    budgetCny: number,
  ): void {
    void this.alertOnce(tier, period, level, projectedCny, budgetCny, true).catch(() => undefined)
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
      reservedCny: this.reservedTotalCny(),
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
   * @param includesReserved 金额口径是否含在途预授权（预授权路径的投影口径）。
   */
  private async alertOnce(
    tier: BudgetTier,
    period: string,
    level: 80 | 100,
    spentCny: number,
    budgetCny: number,
    includesReserved = false,
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
    const reservedNote = includesReserved ? '（含在途调用预授权）' : ''
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
        ? `${periodLabel} API 用量已达预算上限${reservedNote}（¥${spentCny.toFixed(4)} / ¥${budgetCny.toFixed(2)}），非必要调用已暂停`
        : `${periodLabel} API 用量已达预算的 80%${reservedNote}（¥${spentCny.toFixed(4)} / ¥${budgetCny.toFixed(2)}），请注意控制`,
    )
  }
}
