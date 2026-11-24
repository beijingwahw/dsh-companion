/**
 * 主动智能中心 v2：从「Provider 聚合器」到「洞察操作系统」。
 *
 * v1 的 Center 是三件事的组合：Provider 注册表 + 20 秒缓存 + 串行化
 * 写队列。它解决了「多源不互相拖垮」，但没有回答主动智能的四个
 * 更深问题：
 *
 * 1. **信号何时值得打断？** v1 只在 feed() 被调用时被动合成——用户
 *    不打开面板，洞察永远不出现。真正的主动智能需要一个**节律器**
 *    （cadence）：按数据变更事件驱动合成，在「值得打断」时才发通知，
 *    而不是每次刷新都把前 3 条当通知。本层引入 `companion/insights`
 *    事件的**节律门**：距上次通知不足 quietMs 时不推，严重度升级可突破。
 *
 * 2. **打断成本是否可学？** v1 的反馈只影响单卡排序。本层把
 *    helpful/unhelpful/dismiss 聚合到 **source 维度**（Wilson 下界），
 *    让「总被忽略的信号源」自动降权——用户不必逐条关掉同一类噪音。
 *
 * 3. **洞察能否自我解释？** v1 的卡片只有 text + action。本层为每张卡
 *    附 `provenance`（信号来源 + 数据新鲜度 + 合并关系），让「为什么
 *    现在给我看这个」可追溯——主动智能的可信度来自可解释，不来自神秘。
 *
 * 4. **系统是否知道自己在退化？** 本层暴露 `health()`：Provider 成功率、
 *    平均延迟、缓存命中、通知抑制率。主动智能的可观测性不是锦上添花
 *    ——一个静默失败的信号源比没有信号源更危险。
 *
 * 设计纪律（与 v1 一致）：
 * - 状态只存 64 位指纹 + 时间 + 反馈 + 结果，**永不存卡片正文**；
 * - 所有 Provider 本地执行；单源失败只计入降级数，不影响其余；
 * - 动作只走白名单；`action` 文案永不作为命令执行；
 * - 纯本地、零网络、零 LLM。
 */
import type { KvTable } from '../storage-adapter.js'
import type { InsightCard, InsightSeverity } from './pulse.js'
import {
  aggregateSourceFeedback,
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

/** 单张卡片的溯源元数据（可解释性）。 */
export interface InsightProvenance {
  /** 信号来源标识。 */
  readonly source: string
  /** 该源此刻的反馈可信度（Wilson 下界，[0,1]）。 */
  readonly trust: number
  /** 本卡吸收的同主题卡数（0 = 未合并）。 */
  readonly merged: number
  /** 是否因节律窗口关闭而未推送（仍在 feed 可见）。 */
  readonly rhythmSuppressed: boolean
  /** 数据新鲜度：Provider 本次成功返回的耗时（毫秒；失败为 undefined）。 */
  readonly latencyMs?: number
}

/** 统一主动智能 feed。 */
export interface InsightFeed {
  readonly cards: readonly ManagedInsightCard[]
  readonly summary: string
  readonly generatedAt: number
  readonly unreadCount: number
  readonly snoozedCount: number
  readonly dismissedCount: number
  readonly providerFailures: number
  /** 被语义抑制合并的卡片数（跨源同主题冗余）。 */
  readonly mergedCount: number
  /** 因节律窗口关闭而未推送的卡片数。 */
  readonly rhythmSuppressedCount: number
  /** 各信号源可信度快照。 */
  readonly sourceTrust: Readonly<Record<string, number>>
  /** 各卡片溯源（键 = 卡片指纹）。 */
  readonly provenance: Readonly<Record<string, InsightProvenance>>
}

/** 主动智能子系统健康报告（可观测性）。 */
export interface InsightHealth {
  /** 已注册 Provider 数。 */
  readonly providers: number
  /** 最近一轮成功的 Provider 数。 */
  readonly healthyProviders: number
  /** 最近一轮失败的 Provider 数。 */
  readonly failedProviders: number
  /** 累计刷新轮次。 */
  readonly refreshes: number
  /** 累计 Provider 失败次数。 */
  readonly providerFailures: number
  /** Provider 成功率（[0,1]；无样本为 1）。 */
  readonly providerSuccessRate: number
  /** 最近一轮耗时（毫秒）。 */
  readonly lastRefreshMs: number
  /** 指数平滑平均耗时（毫秒）。 */
  readonly avgRefreshMs: number
  /** 累计通知数。 */
  readonly notifications: number
  /** 累计节律抑制数。 */
  readonly rhythmSuppressed: number
  /** 累计语义合并数。 */
  readonly merged: number
  /** 最近一次成功刷新的时间戳（无则 null）。 */
  readonly lastRefreshAt: number | null
}

/** Center 反馈动作；restore-all 只恢复状态，不保存或重建任何正文。 */
export type InsightCenterFeedbackAction = InsightFeedbackAction | 'restore-all'

/** Center 可调参数；生产默认值保持低频与克制。 */
export interface InsightCenterOptions extends InsightPolicyOptions {
  readonly cacheMs?: number
  readonly providerTimeoutMs?: number
  readonly now?: () => number
  readonly onNotifications?: (cards: readonly ManagedInsightCard[], feed: InsightFeed) => void
  /** 节律门：两次通知之间的最小间隔（毫秒）；缺省 5 分钟。 */
  readonly quietMs?: number
  /** 健康统计的指数平滑系数（0..1；越大越看重近期）。 */
  readonly healthSmoothing?: number
}

/** 默认通知最小间隔（毫秒）：主动智能的「别烦我」下限。 */
const DEFAULT_QUIET_MS = 5 * 60_000

/** 默认健康统计平滑系数。 */
const DEFAULT_HEALTH_SMOOTHING = 0.3

/** 统一主动智能中心。 */
export class InsightCenter {
  private readonly providers = new Set<AsyncInsightProvider>()
  private readonly cacheMs: number
  private readonly providerTimeoutMs: number
  private readonly quietMs: number
  private readonly smoothing: number
  private readonly now: () => number
  private cached?: { readonly expiresAt: number; readonly feed: InsightFeed }
  private inFlight?: Promise<InsightFeed>
  private states?: Map<string, InsightState>
  private stateTable?: KvTable<InsightState>
  private queue: Promise<unknown> = Promise.resolve()
  /** 最近一次通知时间戳（节律门基准）。 */
  private lastNotifiedAt?: number
  /** 累计健康统计。 */
  private healthStats = {
    refreshes: 0,
    providerFailures: 0,
    providerSamples: 0,
    notifications: 0,
    rhythmSuppressed: 0,
    merged: 0,
    lastRefreshMs: 0,
    avgRefreshMs: 0,
    lastRefreshAt: null as number | null,
    failedProvidersNow: 0,
  }

  constructor(
    private readonly resolveStateTable: () => Promise<KvTable<InsightState>>,
    private readonly options: InsightCenterOptions = {},
  ) {
    this.cacheMs = Math.max(0, options.cacheMs ?? 20_000)
    this.providerTimeoutMs = Math.max(100, options.providerTimeoutMs ?? 10_000)
    this.quietMs = Math.max(0, options.quietMs ?? DEFAULT_QUIET_MS)
    this.smoothing = Math.min(1, Math.max(0, options.healthSmoothing ?? DEFAULT_HEALTH_SMOOTHING))
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

  /** 主动智能子系统健康报告（可观测性：静默失败比没有信号更危险）。 */
  health(): InsightHealth {
    const providers = this.providers.size
    const successRate =
      this.healthStats.providerSamples === 0
        ? 1
        : (this.healthStats.providerSamples - this.healthStats.providerFailures) /
          this.healthStats.providerSamples
    return {
      providers,
      healthyProviders: Math.max(0, providers - this.healthStats.failedProvidersNow),
      failedProviders: this.healthStats.failedProvidersNow,
      refreshes: this.healthStats.refreshes,
      providerFailures: this.healthStats.providerFailures,
      providerSuccessRate: Number(successRate.toFixed(4)),
      lastRefreshMs: this.healthStats.lastRefreshMs,
      avgRefreshMs: Number(this.healthStats.avgRefreshMs.toFixed(1)),
      notifications: this.healthStats.notifications,
      rhythmSuppressed: this.healthStats.rhythmSuppressed,
      merged: this.healthStats.merged,
      lastRefreshAt: this.healthStats.lastRefreshAt,
    }
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
    const startedAt = this.now()

    // 并行采集 + 单源超时/异常隔离；记录每个源的耗时供溯源。
    const collected = await Promise.all(providers.map((provider) => this.collect(provider)))
    const input: InsightCard[] = []
    let providerFailures = 0
    const latencyBySource = new Map<string, number>()
    for (const item of collected) {
      if (item === undefined) {
        providerFailures += 1
        continue
      }
      input.push(...item.cards)
      if (item.latencyMs !== undefined) {
        for (const card of item.cards) latencyBySource.set(card.source, item.latencyMs)
      }
    }

    // 指纹 → source 映射：效用学习需要按源聚合反馈，而状态表只存指纹。
    const sourceOf = new Map<string, string>()
    for (const card of input) sourceOf.set(insightIdOf(card), card.source)
    const sourceFeedback = aggregateSourceFeedback(previous, sourceOf)

    const now = this.now()
    const result = applyInsightPolicy(input, previous, now, this.options, sourceFeedback)
    const nextStates = pruneInsightStates(result.nextStates, result.activeIds, now)

    for (const [id] of previous) {
      if (!nextStates.has(id)) await table.delete(id)
    }
    for (const [id, state] of nextStates) {
      if (previous.get(id) !== state) await table.put(id, state)
    }
    this.states = new Map(nextStates)

    // 溯源：把 sourceTrust / 合并关系 / 节律抑制 / 采集延迟附到每张卡。
    const provenance: Record<string, InsightProvenance> = {}
    for (const card of result.cards) {
      provenance[card.id] = {
        source: card.source,
        trust: card.sourceTrust ?? 1,
        merged: card.mergedCount ?? 0,
        rhythmSuppressed: card.rhythmSuppressed === true,
        latencyMs: latencyBySource.get(card.source),
      }
    }
    const sourceTrust: Record<string, number> = {}
    for (const [source, trust] of result.sourceTrust) sourceTrust[source] = trust

    const feed: InsightFeed = {
      cards: result.cards,
      summary: summarizeFeed(result.cards, providerFailures, result.mergedCount),
      generatedAt: now,
      unreadCount: result.cards.filter((card) => card.unread).length,
      snoozedCount: result.snoozedCount,
      dismissedCount: result.dismissedCount,
      providerFailures,
      mergedCount: result.mergedCount,
      rhythmSuppressedCount: result.rhythmSuppressedCount,
      sourceTrust,
      provenance,
    }

    // 健康统计（指数平滑耗时；累计计数）。
    this.healthStats.refreshes += 1
    this.healthStats.providerSamples += providers.length
    this.healthStats.providerFailures += providerFailures
    this.healthStats.failedProvidersNow = providerFailures
    this.healthStats.merged += result.mergedCount
    this.healthStats.rhythmSuppressed += result.rhythmSuppressedCount
    this.healthStats.lastRefreshAt = now
    const elapsed = Math.max(0, this.now() - startedAt)
    this.healthStats.lastRefreshMs = elapsed
    this.healthStats.avgRefreshMs =
      this.healthStats.avgRefreshMs === 0
        ? elapsed
        : this.healthStats.avgRefreshMs * (1 - this.smoothing) + elapsed * this.smoothing

    this.cached = { feed, expiresAt: now + this.cacheMs }

    // 节律门：通知是打断，不是刷新的副产品。距上次通知不足 quietMs 时
    // 不推新通知（卡片仍在 feed 中可见，未读态照常累积）。
    const notifyEligible = result.notifications.filter((id) => {
      if (this.lastNotifiedAt === undefined) return true
      if (now - this.lastNotifiedAt < this.quietMs) {
        // 严重度升级可突破节律门（critical 永不因节律被吞）。
        const card = feed.cards.find((item) => item.id === id)
        return card?.severity === 'critical'
      }
      return true
    })
    if (notifyEligible.length > 0) {
      this.lastNotifiedAt = now
      this.healthStats.notifications += notifyEligible.length
    }
    if (notifyEligible.length > 0 && this.options.onNotifications !== undefined) {
      const notified = new Set(notifyEligible)
      const cards = result.cards.filter((card) => notified.has(card.id))
      try {
        this.options.onNotifications(cards, feed)
      } catch {
        // 通知订阅者属于增强体验，失败不影响 feed 和状态落盘。
      }
    }
    return feed
  }

  /** 隔离单个 Provider 的同步异常、异步拒绝与超时；返回耗时。 */
  private async collect(
    provider: AsyncInsightProvider,
  ): Promise<{ cards: readonly InsightCard[]; latencyMs?: number } | undefined> {
    let timer: NodeJS.Timeout | undefined
    const startedAt = this.now()
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('insight provider timeout')), this.providerTimeoutMs)
        timer.unref()
      })
      const cards = await Promise.race([Promise.resolve().then(provider), timeout])
      return { cards, latencyMs: Math.max(0, this.now() - startedAt) }
    } catch {
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** 指纹计算（与 policy 同源；Center 内部避免重复 import 循环）。 */
function insightIdOf(card: InsightCard): string {
  const identity = card.key ?? card.actionId ?? card.source
  const input = `${card.category}\n${card.source}\n${identity}`
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `ins_${hash.toString(16).padStart(16, '0')}`
}

/** 面向用户的摘要只陈述当前可见信号与降级事实。 */
function summarizeFeed(
  cards: readonly ManagedInsightCard[],
  providerFailures: number,
  mergedCount: number,
): string {
  const counts: Record<InsightSeverity, number> = { critical: 0, watch: 0, info: 0 }
  for (const card of cards) counts[card.severity] += 1
  const parts: string[] = []
  if (cards.length === 0) parts.push('当前没有需要主动展示的信号')
  else {
    parts.push(`${cards.length} 条主动洞察`)
    if (counts.critical > 0) parts.push(`${counts.critical} 条需立即关注`)
    if (counts.watch > 0) parts.push(`${counts.watch} 条建议留意`)
  }
  if (mergedCount > 0) parts.push(`${mergedCount} 条同主题信号已合并`)
  if (providerFailures > 0) parts.push(`${providerFailures} 个信号源暂时不可用`)
  return parts.join('，')
}
