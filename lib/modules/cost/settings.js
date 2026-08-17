import Schema from '@deepseek-ai/schemastery';
/** 成本模块设置的 schemastery schema（默认值见需求契约）。 */
export const CostSettings = Schema.object({
    devMode: Schema.boolean().default(false).description('开发者模式总开关'),
    peakScheduling: Schema.boolean().default(false).description('峰谷调度'),
    modelRouting: Schema.boolean().default(false).description('模型路由'),
    dailyBudgetCny: Schema.number().min(0).default(0).description('日预算（元，0=不限）'),
    monthlyBudgetCny: Schema.number().min(0).default(0).description('月度预算（元，0=不限）'),
    simpleModel: Schema.string().default('deepseek-chat').description('简单任务模型'),
    complexModel: Schema.string().default('deepseek-coder').description('复杂任务模型'),
    customRules: Schema.array(Schema.object({
        pattern: Schema.string(),
        model: Schema.string(),
    }))
        .default([])
        .description('自定义路由规则'),
});
/** 设置命名空间。 */
export const COST_SETTINGS_NS = 'companion.cost';
/**
 * 注册成本模块设置并返回命名空间作用域。
 *
 * 契约层（SettingsProvider）以 SchemaLike 解耦 schemastery 的具体类型形状，
 * 边界处做一次恒等类型适配（运行时值原样传递 schemastery schema）。
 */
export function registerCostSettings(ctx) {
    return ctx.settings.register(COST_SETTINGS_NS, asSchemaLike(CostSettings), {
        applies: 'live',
    });
}
/** 将 schemastery schema 恒等适配为契约层 SchemaLike（仅类型层面）。 */
function asSchemaLike(schema) {
    return schema;
}
