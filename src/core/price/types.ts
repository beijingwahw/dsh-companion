/**
 * 动态计价类型（移植自 dsh-usage-ledger/src/types.ts 并适配本插件）。
 *
 * 价格单位统一为 元/百万 tokens；价格表按模型 id 索引；
 * 价格页快照（PriceSheet）支持 DeepSeek 峰谷分时定价计划。
 */

/** 单模型每百万 tokens 单价（元）。 */
export interface ModelPrice {
  /** 命中前缀缓存的输入单价。 */
  inputCacheHit: number
  /** 未命中缓存的输入单价。 */
  inputMiss: number
  /** 输出单价。 */
  output: number
}

/** 模型 id → 单价 的价格表（如 `deepseek-chat`）。 */
export type PriceTable = Record<string, ModelPrice>

/** DeepSeek 峰谷分时定价计划。 */
export interface ScheduledPricing {
  /** 生效日期（北京时间 YYYY-MM-DD）。 */
  effective: string
  /** 高峰时段窗口 [起始小时, 结束小时)，按高峰价计费。 */
  peakWindows?: ReadonlyArray<readonly [number, number]>
  /** 空闲时段单价。 */
  offPeak: PriceTable
  /** 高峰时段单价。 */
  peak: PriceTable
}

/** 一份已解析的定价快照：实时抓取或内置兜底。 */
export interface PriceSheet {
  source: 'live' | 'builtin'
  /** 成功抓取的 Unix 毫秒时间戳；内置快照缺省。 */
  fetchedAt?: number
  /** 实时抓取时的来源 URL。 */
  sourceUrl?: string
  /** 任何分时计划生效前使用的平价表。 */
  current: PriceTable
  /** 可选的即将生效/已生效的峰谷分时计划。 */
  scheduled?: ScheduledPricing
}

/** 费用函数接受的 token 用量形状。 */
export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 单厂商的已解析定价块（供报表与面板展示）。 */
export interface VendorPricing {
  id: string
  label: string
  pricingUrl: string
  /** 目录价是否为阶梯计价的最低档快照。 */
  tiered: boolean
  /** 数字的来源。 */
  source: 'live' | 'builtin' | 'override'
  fetchedAt?: number
  models: PriceTable
}
