/**
 * 成本网关服务（服务名 `companionCost`）：包装核心调用的策略层。
 *
 * 开发者模式开启时依次执行：
 * 预算闸门（budget.check）→ 模型路由（modelRouting）→ 峰谷调度
 * （peakScheduling 且 priority='normal' → scheduler.enqueue；
 * 是否真实延迟以调度器返回值为准，网关不自行预判峰谷）
 * → invoke：调用期权协议（estimator 估算 → budget.reserve 预授权 →
 *   ctx.companion.callDeepSeek → settle 结算 / 失败 release 释放）
 * → 节省额结算：仅当优化真实发生时计入 savedCny——
 *   modelRouting 开启且实际模型确比 complexModel 便宜时基线才取 complexModel，
 *   否则基线=实际模型（节省为 0）；deferredCalls 以调度器真实延迟为准。
 *   结算失败不反转已成功的调用结果：内部捕获并降级为 warning 通知。
 * 预授权在任务真正执行（invoke）时锁定：排队任务在 drain 前仍由网关注入的
 * 预算复检回调复查闸门，暂停期间排队任务以预算不足错误被 reject，
 * 队列不构成闸门旁路；在途并发的额度竞争由预留协议收敛。
 * 开发者模式关闭时直通核心服务。
 *
 * 跨模块协作（如 handoff 生成摘要）经 ctx.get('companionCost') 使用本服务，
 * 不直接 import 本文件（DESIGN.md 第 1 节）。
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChatMessage, ChatResult } from '../../core/deepseek.js'
import { round4, tokenUsageToUsageLike } from '../../core/pricing.js'
import type { CallParams } from '../../core/service.js'
import { beijingDayKey } from '../../core/time.js'
import type { DailyUsage } from '../../core/usage.js'
import { BudgetGuard, type BudgetSnapshot } from './budget.js'
import { CostEstimator } from './estimator.js'
import { ModelRouter } from './router.js'
import { PeakScheduler, type QueuedTaskInfo } from './scheduler.js'
import type { CostSettings } from './settings.js'

/** 经成本网关发起的一次调用参数。 */
export interface CostCallParams {
  /** 模型可见消息。 */
  messages: readonly ChatMessage[]
  /** 任务提示词（供模型路由判断难易）。 */
  taskHint?: string
  /** 优先级；'high' 不参与峰谷延迟。缺省 'normal'。 */
  priority?: 'normal' | 'high'
  /** 必要调用：预算用尽时仍放行。缺省 false。 */
  essential?: boolean
  /** 调用方标识（记账聚合）。 */
  source: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 预留 TTL 相对 API 超时的缓冲（毫秒）：覆盖结算链路的尾部延迟。 */
const RESERVATION_TTL_BUFFER_MS = 30_000

/** ctx.companionCost 服务契约。 */
export interface CostGateway {
  /** 经策略层发起一次 DeepSeek 调用。 */
  call(params: CostCallParams): Promise<ChatResult>
  /** 当前预算状态快照。 */
  budgetState(): Promise<BudgetSnapshot>
  /** 峰谷调度等待队列快照。 */
  queueSnapshot(): readonly QueuedTaskInfo[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionCost: CostGateway
  }
}

/** 成本网关服务实现（经 ctx.plugin 挂载；服务名 companionCost）。 */
export class CostGatewayService extends Service implements CostGateway {
  private readonly router = new ModelRouter()
  private readonly scheduler: PeakScheduler
  private readonly estimator = new CostEstimator()
  private readonly getSettings: () => CostSettings
  /** 预算守卫：存储域就绪后懒性创建；创建失败后重置，下次访问重试。 */
  private budgetGuardInstance: BudgetGuard | undefined
  private budgetGuardPromise: Promise<BudgetGuard> | undefined

  /**
   * @param ctx 插件上下文。
   * @param getSettings 实时读取成本设置（settings scope 的 getter 闭包）。
   */
  constructor(
    readonly ctx: Context,
    getSettings: () => CostSettings,
  ) {
    super(ctx, 'companionCost')
    this.getSettings = getSettings
    // 接线预算复检回调：drain 执行每个延迟任务前复查预算闸门，
    // 抛错（如预算暂停）即以预算不足错误拒绝执行该任务，队列不构成旁路。
    // 高峰窗口取自计价引擎（官方定价页实时解析），官方调整时段后自动跟随。
    this.scheduler = new PeakScheduler(
      ctx,
      async () => {
        const guard = await this.budgetReady()
        // 延迟任务均为 normal 优先级：按非必要复检；暂停期间排队任务被 reject。
        await guard.check(false)
      },
      () => this.ctx.companion.prices.activePeakWindows(),
    )
  }

  async call(params: CostCallParams): Promise<ChatResult> {
    const settings = this.getSettings()
    const base: CallParams = {
      messages: params.messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
      source: params.source,
    }
    // 开发者模式关闭：直通核心服务（仍记账并发 companion/usage 事件）。
    if (!settings.devMode) {
      return this.ctx.companion.callDeepSeek(base)
    }

    // 预算闸门：80% 告警；100% 拦截非必要调用。
    const guard = await this.budgetReady()
    await guard.check(params.essential ?? false)

    // 模型路由：按任务难易选择模型（关闭时沿用核心服务缺省模型）。
    let model: string | undefined
    if (settings.modelRouting) {
      model = this.router.resolve(params.taskHint, settings).model
    }

    // 峰谷调度：仅 normal 优先级参与；是否真实延迟由调度器判定并返回
    // （空闲时段立即执行 deferred=false；高峰排队 deferred=true）。
    // invoke 内嵌调用期权协议：估算 → 预授权 → 调用 → 结算/释放。
    // 预授权在任务真正执行时锁定（排队期间由调度器复检闸门把关），
    // 在途并发的额度竞争由预留协议收敛（详见 budget.ts 头注释）。
    const priority = params.priority ?? 'normal'
    const requestedModel = model ?? 'deepseek-chat'
    const inputChars = countMessageChars(params.messages)
    const invoke = async (): Promise<ChatResult> => {
      const estimateCny = this.estimator.estimate(
        requestedModel,
        inputChars,
        params.maxTokens,
        this.ctx.companion.prices.resolve(requestedModel, Date.now()),
      )
      const reservation = guard.reserve(
        estimateCny,
        params.essential ?? false,
        this.ctx.companion.config.apiTimeoutMs + RESERVATION_TTL_BUFFER_MS,
      )
      try {
        const result = await this.ctx.companion.callDeepSeek({ ...base, model })
        const actualCny = this.actualCostOf(result, requestedModel)
        reservation.settle(actualCny)
        this.estimator.observe(requestedModel, inputChars, actualCny)
        return result
      } catch (error) {
        reservation.release()
        throw error
      }
    }
    let result: ChatResult
    let deferred = false
    if (settings.peakScheduling && priority === 'normal') {
      const scheduled = this.scheduler.enqueue(
        invoke,
        params.taskHint || params.source,
        params.signal,
      )
      deferred = scheduled.deferred
      result = await scheduled.result
    } else {
      result = await invoke()
    }

    // 节省额结算失败不得反转已成功的调用结果：降级为 warning 通知。
    try {
      await this.recordSavings(result, requestedModel, settings, deferred)
    } catch (error) {
      this.ctx.companion.notice(
        'warning',
        `节省额结算失败（本次调用结果不受影响）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return result
  }

  async budgetState(): Promise<BudgetSnapshot> {
    const guard = await this.budgetReady()
    return guard.state()
  }

  queueSnapshot(): readonly QueuedTaskInfo[] {
    return this.scheduler.queueSnapshot()
  }

  /**
   * 一次成功调用的实际费用（元）：经动态计价引擎按调用完成时刻解析
   * （峰谷分时感知），与核心服务记账、节省额结算同源同口径。
   */
  private actualCostOf(result: ChatResult, requestedModel: string): number {
    return this.ctx.companion.prices.costOfCall(
      result.model || requestedModel,
      tokenUsageToUsageLike(result.usage),
      Date.now(),
    )
  }

  /**
   * 预算守卫就绪 Promise（懒性）：存储域就绪后创建；
   * 创建失败时挂兜底 catch 避免未处理 rejection，并重置内部 promise，
   * 使存储域恢复后的下次访问得以重试（与核心服务 ensureReady 同构）。
   */
  private budgetReady(): Promise<BudgetGuard> {
    if (this.budgetGuardInstance) return Promise.resolve(this.budgetGuardInstance)
    if (!this.budgetGuardPromise) {
      const promise = this.ctx.companion.ready.then(({ domain, usage }) => {
        const guard = new BudgetGuard(this.ctx, domain, usage, this.getSettings)
        this.budgetGuardInstance = guard
        return guard
      })
      promise.catch(() => {
        if (this.budgetGuardPromise === promise) this.budgetGuardPromise = undefined
      })
      this.budgetGuardPromise = promise
    }
    return this.budgetGuardPromise
  }

  /**
   * 节省额结算：仅当优化真实发生时计入 savedCny——
   * modelRouting 开启且实际模型确比 complexModel 便宜时基线才取 complexModel，
   * 否则基线=实际模型（节省为 0）；
   * 节省>0 或真实发生延迟时，经存储域 usage-daily 表的原子 update
   * 并入当日 savedCny/deferredCalls 字段。
   * 单价经动态计价引擎按结算时刻解析（峰谷分时感知，与实际记账同源）。
   */
  private async recordSavings(
    result: ChatResult,
    requestedModel: string,
    settings: CostSettings,
    deferred: boolean,
  ): Promise<void> {
    const prices = this.ctx.companion.prices
    const ts = Date.now()
    const usageLike = tokenUsageToUsageLike(result.usage)
    const actualCny = this.actualCostOf(result, requestedModel)
    // 基线缺省为实际模型（节省为 0）；仅当模型路由开启、
    // 且实际路由到的模型确比 complexModel 便宜时，才以 complexModel 为基线。
    let baselineCny = actualCny
    if (settings.modelRouting) {
      const complexCny = prices.costOfCall(settings.complexModel, usageLike, ts)
      if (complexCny > actualCny) baselineCny = complexCny
    }
    const savedCny = round4(baselineCny - actualCny)
    if (savedCny <= 0 && !deferred) return
    const { domain } = await this.ctx.companion.ready
    const table = domain.table<DailyUsage>('usage-daily')
    const day = beijingDayKey(Date.now())
    await table.update(day, (prev) => {
      // 正常路径下核心服务已记账当日行；兜底构造空行保证字段完整。
      const baseRow: DailyUsage = prev ?? {
        day,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        costCny: 0,
        savedCny: 0,
        deferredCalls: 0,
        byModel: {},
      }
      return {
        ...baseRow,
        savedCny: round4(baseRow.savedCny + Math.max(savedCny, 0)),
        deferredCalls: baseRow.deferredCalls + (deferred ? 1 : 0),
      }
    })
  }
}

/** 统计消息总字符数（估值器的输入长度口径）。 */
function countMessageChars(messages: readonly ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += typeof message.content === 'string' ? message.content.length : 0
  }
  return total
}
