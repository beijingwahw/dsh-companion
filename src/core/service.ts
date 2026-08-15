/**
 * CompanionCore：插件根服务（服务名 `companion`）。
 *
 * 职责：
 * - 打开 companion 存储域（所有用户数据的唯一落盘位置，Harness 沙箱内）；
 * - 持有加密保险库（API Key）、用量账本、动态计价引擎、私有 HTTP 路由器；
 * - 提供直连 DeepSeek API 的基础调用（含记账与 companion/usage 事件）；
 *   策略层（路由/调度/预算）由成本模块的 companionCost 服务包装。
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage'
import type { Config } from '../config.js'
import {
  chatCompletion,
  DeepSeekApiError,
  type ChatMessage,
  type ChatResult,
} from './deepseek.js'
import { createRouter, type CompanionRouter } from './http.js'
import { CredentialRef } from './ids.js'
import { round4, tokenUsageToUsageLike } from './pricing.js'
import { OFFICIAL_PRICING_URL, PriceService, type MinimalLogger } from './price/service.js'
import type { PriceTable } from './price/types.js'
import { UsageStore } from './usage.js'
import { SecretVault } from './vault.js'

/** 存储域：所有表（vault/usage-daily/templates/tags）都在此域内。 */
export const COMPANION_DOMAIN = defineDomain({
  name: 'companion',
  version: 1,
  description: 'DeepSeek Companion 插件本地数据（设置以外的用户数据）',
})

/** 保险库中 API Key 的秘密名。 */
export const API_KEY_SECRET = 'deepseek-api-key'

/** credentials seam 中的 API Key 引用（环境变量名约定）。 */
export const API_KEY_CREDENTIAL_REF = CredentialRef('DEEPSEEK_API_KEY')

/** 存储域初始化结果。 */
export interface CompanionStore {
  domain: Domain
  vault: SecretVault
  usage: UsageStore
}

export interface CallParams {
  messages: readonly ChatMessage[]
  /** 缺省 deepseek-chat。 */
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 调用方标识（如 handoff / cost-report），用于记账聚合。 */
  source: string
}

/** ctx.companion 服务契约。 */
export interface CompanionCore {
  readonly config: Config
  readonly http: CompanionRouter
  /** 存储域就绪 Promise（open 是异步的）。 */
  readonly ready: Promise<CompanionStore>
  /** 解析 API Key：保险库优先，其次 credentials seam。 */
  getApiKey(): Promise<string | undefined>
  /** 加密保存 API Key。 */
  setApiKey(value: string): Promise<void>
  /** 删除已保存的 API Key。 */
  clearApiKey(): Promise<void>
  /** 直连 DeepSeek API（含记账）。 */
  callDeepSeek(params: CallParams): Promise<ChatResult>
  /**
   * 动态计价引擎（移植自 dsh-usage-ledger）：官方定价页实时抓取 +
   * 峰谷分时 + 多厂商目录。费用估算一律经此解析单价。
   */
  readonly prices: PriceService
  /** 覆盖用户自定义单价（模型 id → 单价，最长前缀匹配）。 */
  setPricingOverrides(table: PriceTable): void
  /** 发出 companion/notice（UI 层呈现为 Toast）。 */
  notice(kind: 'info' | 'success' | 'warning' | 'error', message: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    companion: CompanionCore
  }
}

export class CompanionCoreService extends Service implements CompanionCore {
  readonly http: CompanionRouter = createRouter('/companion')
  readonly prices: PriceService
  /** 内部存储域初始化 promise；失败后被重置，下次访问 ready 时重试 open。 */
  private readyPromise?: Promise<CompanionStore>

  constructor(
    readonly ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'companion')

    // 动态计价引擎：官方定价页抓取失败静降级（保留上一份有效表），
    // 仅官方价格真实变更时经 info → notice 提示用户；warn 不打扰 UI。
    const log: MinimalLogger = {
      info: (...args: unknown[]) => this.notice('info', args.map(String).join(' ')),
      warn: () => undefined,
      error: (...args: unknown[]) => this.notice('warning', args.map(String).join(' ')),
    }
    this.prices = new PriceService(OFFICIAL_PRICING_URL, config.pricingTimeoutMs, log)

    // 私有 HTTP 前缀路由：各模块经 ctx.companion.http 挂载端点。
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/companion',
          handler: (req, res) => this.http.handle(req, res),
        }),
      'companion.http-route',
    )

    // 构造时即启动初始化（ensureReady 内部已挂兜底 catch，无未处理 rejection）。
    void this.ensureReady()
  }

  /** 存储域就绪 Promise（open 失败后下次访问会重新 open）。 */
  get ready(): Promise<CompanionStore> {
    return this.ensureReady()
  }

  /** 懒性创建（或复用）存储域初始化 promise，并为其挂兜底 catch。 */
  private ensureReady(): Promise<CompanionStore> {
    if (!this.readyPromise) {
      const promise = this.ctx.storageDomain.open(COMPANION_DOMAIN).then((domain) => ({
        domain,
        vault: new SecretVault(domain),
        usage: new UsageStore(domain),
      }))
      // 兜底 catch：记录错误并重置内部 promise，使失败后可重新初始化。
      promise.catch((error: unknown) => {
        if (this.readyPromise === promise) this.readyPromise = undefined
        try {
          this.notice(
            'error',
            `companion 存储域初始化失败：${error instanceof Error ? error.message : String(error)}`,
          )
        } catch {
          // notice 自身失败时静默，避免产生新的未处理 rejection。
        }
      })
      this.readyPromise = promise
    }
    return this.readyPromise
  }

  async getApiKey(): Promise<string | undefined> {
    const { vault } = await this.ready
    const stored = await vault.getSecret(API_KEY_SECRET)
    if (stored) return stored
    try {
      const resolved = await this.ctx.credentials.resolve(API_KEY_CREDENTIAL_REF)
      return resolved?.value
    } catch {
      return undefined
    }
  }

  async setApiKey(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) throw new DeepSeekApiError('API Key 不能为空', 'NO_API_KEY')
    const { vault } = await this.ready
    await vault.setSecret(API_KEY_SECRET, trimmed)
  }

  async clearApiKey(): Promise<void> {
    const { vault } = await this.ready
    await vault.deleteSecret(API_KEY_SECRET)
  }

  async callDeepSeek(params: CallParams): Promise<ChatResult> {
    const apiKey = await this.getApiKey()
    if (!apiKey) {
      throw new DeepSeekApiError(
        '尚未配置 DeepSeek API Key：请在设置 → 开发者模式中填写，或配置凭据 DEEPSEEK_API_KEY',
        'NO_API_KEY',
      )
    }
    const requestedModel = params.model ?? 'deepseek-chat'
    const result = await chatCompletion({
      baseUrl: this.config.apiBaseUrl,
      apiKey,
      timeoutMs: this.config.apiTimeoutMs,
      model: requestedModel,
      messages: params.messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
    })
    const model = result.model || requestedModel
    // 记账与事件发射是 best-effort：失败降级为 warning 提示，不影响调用结果的返回。
    // usage.record 与事件复用同一个 ts，保证两侧时间一致；
    // 费用经动态计价引擎按调用时刻解析（峰谷分时感知）。
    const ts = Date.now()
    const costCny = round4(this.prices.costOfCall(model, tokenUsageToUsageLike(result.usage), ts))
    try {
      const { usage } = await this.ready
      await usage.record({
        ts,
        model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cacheHitTokens: Math.min(result.usage.promptCacheHitTokens, result.usage.promptTokens),
        costCny,
      })
      this.ctx.emit('companion/usage', {
        ts,
        model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costCny,
        source: params.source,
      })
    } catch (error) {
      this.notice(
        'warning',
        `用量记账失败（本次调用结果不受影响）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return result
  }

  setPricingOverrides(table: PriceTable): void {
    this.prices.setOverrides(table)
  }

  notice(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
    this.ctx.emit('companion/notice', { kind, message })
  }
}
