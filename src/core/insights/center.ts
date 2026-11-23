/**
 * 主动智能中心：统一注册异步信号源，并提供缓存、单航班、状态持久化与反馈闭环。
 *
 * 这里只保存 policy.ts 的指纹状态，不保存卡片正文。所有 Provider 都在本地执行；
 * 任一 Provider 失败或超时只计入降级数量，不影响其他信号源。
 */
import type { KvTable } from '../storage-adapter.js'
import type { InsightCard, InsightSeverity } from './pulse.js'
import {
  applyInsightPolicy,
  pruneInsightStates,
  reduceInsightFeedback,
  sanitizeInsightState,
  type InsightFeedbackAction,
  type InsightPolicyOptions,
  type InsightState,
  type ManagedInsightCard,
} from './policy.js'

/** 异步洞察信号源；注册和注销均由宿主模块的 effect 管理。 */
export type AsyncInsightProvider = () => readonly InsightCard[] | Promise<readonly InsightCard[]>

/** 统一主动智能 feed。 */
export interface InsightFeed {
  readonly cards: readonly ManagedInsightCard[]
  readonly summary: string
  readonly generatedAt: number
  readonly unreadCount: number
  readonly snoozedCount: number
  readonly dismissedCount: number
  readonly providerFailures: number
}

/** Center 反馈动作；restore-all 只恢复状态，不保存或重建任何正文。 */
export type InsightCenterFeedbackAction = InsightFeedbackAction | 'restore-all'

/** Center 可调参数；生产默认值保持低频与克制。 */
export interface InsightCenterOptions extends InsightPolicyOptions {
  readonly cacheMs?: number
  readonly providerTimeoutMs?: number
  readonly now?: () => number
  readonly onNotifications?: (cards: readonly ManagedInsightCard[], feed: InsightFeed) => void
}

/** 统一主动智能中心。 */
export class InsightCenter {
  private readonly providers = new Set<AsyncInsightProvider>()
  private readonly cacheMs: number
  private readonly providerTimeoutMs: number
  private readonly now: () => number
  private cached?: { readonly expiresAt: number; readonly feed: InsightFeed }
  private inFlight?: Promise<InsightFeed>
  private states?: Map<string, InsightState>
  private stateTable?: KvTable<InsightState>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly resolveStateTable: () => Promise<KvTable<InsightState>>,
    private readonly options: InsightCenterOptions = {},
  ) {
    this.cacheMs = Math.max(0, options.cacheMs ?? 20_000)
    this.providerTimeoutMs = Math.max(100, options.providerTimeoutMs ?? 10_000)
    this.now = options.now ?? Date.now
  }

  /** 注册信号源并使旧缓存失效；返回幂等注销函数。 */
  register(provider: AsyncInsightProvider): () => void {
    this.providers.add(provider)
    this.invalidate()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.providers.delete(provider)
      this.invalidate()
    }
  }

  /** 数据变更后由模块调用；下一次读取会重新合成，不在写路径同步重算。 */
  invalidate(): void {
    this.cached = undefined
  }

  /** 读取统一 feed；短时间重复读取共享缓存，并发强制刷新共享同一 Promise。 */
  async feed(force = false): Promise<InsightFeed> {
    const now = this.now()
    if (!force && this.cached !== undefined && this.cached.expiresAt > now) return this.cached.feed
    if (this.inFlight !== undefined) return this.inFlight
    const promise = this.enqueue(() => this.refresh())
    this.inFlight = promise
    try {
      return await promise
    } finally {
      if (this.inFlight === promise) this.inFlight = undefined
    }
  }

  /** 确认未读；all 只修改已持久化的指纹状态，不接触卡片正文。 */
  acknowledge(request: { readonly ids?: readonly string[]; readonly all?: boolean }): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureStates()
      const states = this.states as Map<string, InsightState>
      const table = this.stateTable as KvTable<InsightState>
      const ids = request.all === true
        ? [...states.keys()]
        : [...new Set(request.ids ?? [])].slice(0, 50)
      const now = this.now()
      let changed = 0
      for (const id of ids) {
        const previous = states.get(id)
        if (previous === undefined) continue
        const next = reduceInsightFeedback(previous, 'acknowledge', now)
        if (next.acknowledgedAt === previous.acknowledgedAt && previous.acknowledgedAt !== undefined) continue
        await table.put(id, next)
        states.set(id, next)
        changed += 1
      }
      if (changed > 0) this.invalidate()
      return changed
    })
  }

  /** 应用单条反馈或恢复全部忽略；未知单条指纹返回 false，防止伪造垃圾状态。 */
  feedback(id: string | undefined, action: InsightCenterFeedbackAction): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureStates()
      const states = this.states as Map<string, InsightState>
      const table = this.stateTable as KvTable<InsightState>
      const now = this.now()
      if (action === 'restore-all') {
        let changed = false
        for (const [key, previous] of states) {
          if (!previous.dismissed && (previous.snoozeUntil ?? 0) <= now) continue
          const next = reduceInsightFeedback(previous, 'restore', now)
          await table.put(key, next)
          states.set(key, next)
          changed = true
        }
        if (changed) this.invalidate()
        return changed
      }
      if (id === undefined) return false
      const previous = states.get(id)
      if (previous === undefined) return false
      const next = reduceInsightFeedback(previous, action, now)
      await table.put(id, next)
      states.set(id, next)
      this.invalidate()
      return true
    })
  }

  /** 串行化刷新和反馈，避免慢 Provider 与快速按钮操作互相覆盖。 */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 首次访问时恢复并净化持久化状态；损坏记录不会进入内存。 */
  private async ensureStates(): Promise<void> {
    if (this.states !== undefined) return
    const table = await this.resolveStateTable()
    const restored = new Map<string, InsightState>()
    for (const [id, raw] of table.entries()) {
      if (!/^ins_[0-9a-f]{16}$/.test(id)) continue
      const state = sanitizeInsightState(raw)
      if (state !== undefined) restored.set(id, state)
    }
    this.stateTable = table
    this.states = restored
  }

  /** 单航班实际刷新；仅在 enqueue 内调用。 */
  private async refresh(): Promise<InsightFeed> {
    await this.ensureStates()
    const previous = this.states as Map<string, InsightState>
    const table = this.stateTable as KvTable<InsightState>
    const providers = [...this.providers]
    const settled = await Promise.all(providers.map((provider) => this.collect(provider)))
    const input: InsightCard[] = []
    let providerFailures = 0
    for (const cards of settled) {
      if (cards === undefined) providerFailures += 1
      else input.push(...cards)
    }
    const now = this.now()
    const result = applyInsightPolicy(input, previous, now, this.options)
    const nextStates = pruneInsightStates(result.nextStates, result.activeIds, now)

    for (const [id] of previous) {
      if (!nextStates.has(id)) await table.delete(id)
    }
    for (const [id, state] of nextStates) {
      if (previous.get(id) !== state) await table.put(id, state)
    }
    this.states = new Map(nextStates)

    const feed: InsightFeed = {
      cards: result.cards,
      summary: summarizeFeed(result.cards, providerFailures),
      generatedAt: now,
      unreadCount: result.cards.filter((card) => card.unread).length,
      snoozedCount: result.snoozedCount,
      dismissedCount: result.dismissedCount,
      providerFailures,
    }
    this.cached = { feed, expiresAt: now + this.cacheMs }
    if (result.notifications.length > 0 && this.options.onNotifications !== undefined) {
      const notified = new Set(result.notifications)
      const cards = result.cards.filter((card) => notified.has(card.id))
      try {
        this.options.onNotifications(cards, feed)
      } catch {
        // 通知订阅者属于增强体验，失败不影响 feed 和状态落盘。
      }
    }
    return feed
  }

  /** 隔离单个 Provider 的同步异常、异步拒绝与超时。 */
  private async collect(provider: AsyncInsightProvider): Promise<readonly InsightCard[] | undefined> {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('insight provider timeout')), this.providerTimeoutMs)
        timer.unref()
      })
      return await Promise.race([Promise.resolve().then(provider), timeout])
    } catch {
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** 面向用户的摘要只陈述当前可见信号与降级事实。 */
function summarizeFeed(cards: readonly ManagedInsightCard[], providerFailures: number): string {
  const counts: Record<InsightSeverity, number> = { critical: 0, watch: 0, info: 0 }
  for (const card of cards) counts[card.severity] += 1
  const parts: string[] = []
  if (cards.length === 0) parts.push('当前没有需要主动展示的信号')
  else {
    parts.push(`${cards.length} 条主动洞察`)
    if (counts.critical > 0) parts.push(`${counts.critical} 条需立即关注`)
    if (counts.watch > 0) parts.push(`${counts.watch} 条建议留意`)
  }
  if (providerFailures > 0) parts.push(`${providerFailures} 个信号源暂时不可用`)
  return parts.join('，')
}
