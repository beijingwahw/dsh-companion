/**
 * 插件根配置：四个功能模块可独立启停，互不影响。
 * 配置经 schemastery 校验后传入 apply；cordis.patch.yml 可覆盖任一字段。
 */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** 模块 A：对话智能导出。 */
  enableExport: boolean
  /** 模块 B：上下文交接摘要。 */
  enableHandoff: boolean
  /** 模块 C：API 成本优化（开发者模式）。 */
  enableCost: boolean
  /** 模块 D：全局对话检索。 */
  enableSearch: boolean
  /** DeepSeek 官方 API 基址（manifest.json 已放行该域名）。 */
  apiBaseUrl: string
  /** 单次 API 调用超时（毫秒）。 */
  apiTimeoutMs: number
  /** 单次定价页抓取的墙上时钟预算（毫秒）；供动态计价引擎使用。 */
  pricingTimeoutMs: number
  /** 官方定价页刷新间隔（分钟）；下限 5 分钟，避免高频抓取官方页。 */
  pricingRefreshIntervalMin: number
}

export const Config: Schema<Config> = Schema.object({
  enableExport: Schema.boolean().default(true),
  enableHandoff: Schema.boolean().default(true),
  enableCost: Schema.boolean().default(true),
  enableSearch: Schema.boolean().default(true),
  // URL 格式校验：role('url') 提供表单渲染提示，pattern 强制 http(s):// 前缀
  // （schemastery 实际支持 role/pattern，见其类型声明）。
  apiBaseUrl: Schema.string()
    .role('url')
    .pattern(/^https?:\/\/.+/)
    .default('https://api.deepseek.com'),
  // 正数下限校验：毫秒超时必须为不小于 1 的正数（schemastery 实际支持 min）。
  apiTimeoutMs: Schema.number().min(1).default(60_000),
  pricingTimeoutMs: Schema.number().min(1).default(10_000),
  pricingRefreshIntervalMin: Schema.number().min(5).default(60),
})
