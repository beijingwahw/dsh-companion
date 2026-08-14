/**
 * 成本模块设置（开发者模式）：总开关、峰谷调度、模型路由、日/月度预算、
 * 简单/复杂模型与自定义路由规则。
 *
 * 经 ctx.settings 注册于命名空间 `companion.cost`（applies: 'live'）；
 * schema 由 schemastery 校验，scope.get() 始终返回带默认值的完整设置。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SchemaLike, SettingsScope } from '../../types/harness.js'

/** 自定义路由规则：taskHint 命中 pattern（子串或正则）时使用指定模型。 */
export interface CostCustomRule {
  pattern: string
  model: string
}

/** 成本模块设置形状。 */
export interface CostSettings {
  /** 开发者模式总开关；关闭时所有调用直通核心服务。 */
  devMode: boolean
  /** 峰谷调度开关：高峰时段延迟 normal 优先级调用至空闲时段。 */
  peakScheduling: boolean
  /** 模型路由开关：按任务难易选择简单/复杂模型。 */
  modelRouting: boolean
  /** 日预算（人民币元，北京时间日）；0 表示不限。 */
  dailyBudgetCny: number
  /** 月度预算（人民币元）；0 表示不限。 */
  monthlyBudgetCny: number
  /** 简单任务模型。 */
  simpleModel: string
  /** 复杂任务模型。 */
  complexModel: string
  /** 自定义路由规则（优先于关键词启发式）。 */
  customRules: CostCustomRule[]
}

/** 成本模块设置的 schemastery schema（默认值见需求契约）。 */
export const CostSettings: Schema<CostSettings> = Schema.object({
  devMode: Schema.boolean().default(false).description('开发者模式总开关'),
  peakScheduling: Schema.boolean().default(false).description('峰谷调度'),
  modelRouting: Schema.boolean().default(false).description('模型路由'),
  dailyBudgetCny: Schema.number().min(0).default(0).description('日预算（元，0=不限）'),
  monthlyBudgetCny: Schema.number().min(0).default(0).description('月度预算（元，0=不限）'),
  simpleModel: Schema.string().default('deepseek-chat').description('简单任务模型'),
  complexModel: Schema.string().default('deepseek-coder').description('复杂任务模型'),
  customRules: Schema.array(
    Schema.object({
      pattern: Schema.string(),
      model: Schema.string(),
    }),
  )
    .default([])
    .description('自定义路由规则'),
})

/** 设置命名空间。 */
export const COST_SETTINGS_NS = 'companion.cost'

/**
 * 注册成本模块设置并返回命名空间作用域。
 *
 * 契约层（SettingsProvider）以 SchemaLike 解耦 schemastery 的具体类型形状，
 * 边界处做一次恒等类型适配（运行时值原样传递 schemastery schema）。
 */
export function registerCostSettings(ctx: Context): SettingsScope<CostSettings> {
  return ctx.settings.register<CostSettings>(COST_SETTINGS_NS, asSchemaLike(CostSettings), {
    applies: 'live',
  })
}

/** 将 schemastery schema 恒等适配为契约层 SchemaLike（仅类型层面）。 */
function asSchemaLike<T>(schema: Schema<T>): SchemaLike<T> {
  return schema as unknown as SchemaLike<T>
}
