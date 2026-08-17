/**
 * 成本模块设置（开发者模式）：总开关、峰谷调度、模型路由、日/月度预算、
 * 简单/复杂模型与自定义路由规则。
 *
 * 经 ctx.settings 注册于命名空间 `companion.cost`（applies: 'live'）；
 * schema 由 schemastery 校验，scope.get() 始终返回带默认值的完整设置。
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { SettingsScope } from '../../types/harness.js';
/** 自定义路由规则：taskHint 命中 pattern（子串或正则）时使用指定模型。 */
export interface CostCustomRule {
    pattern: string;
    model: string;
}
/** 成本模块设置形状。 */
export interface CostSettings {
    /** 开发者模式总开关；关闭时所有调用直通核心服务。 */
    devMode: boolean;
    /** 峰谷调度开关：高峰时段延迟 normal 优先级调用至空闲时段。 */
    peakScheduling: boolean;
    /** 模型路由开关：按任务难易选择简单/复杂模型。 */
    modelRouting: boolean;
    /** 日预算（人民币元，北京时间日）；0 表示不限。 */
    dailyBudgetCny: number;
    /** 月度预算（人民币元）；0 表示不限。 */
    monthlyBudgetCny: number;
    /** 简单任务模型。 */
    simpleModel: string;
    /** 复杂任务模型。 */
    complexModel: string;
    /** 自定义路由规则（优先于关键词启发式）。 */
    customRules: CostCustomRule[];
}
/** 成本模块设置的 schemastery schema（默认值见需求契约）。 */
export declare const CostSettings: Schema<CostSettings>;
/** 设置命名空间。 */
export declare const COST_SETTINGS_NS = "companion.cost";
/**
 * 注册成本模块设置并返回命名空间作用域。
 *
 * 契约层（SettingsProvider）以 SchemaLike 解耦 schemastery 的具体类型形状，
 * 边界处做一次恒等类型适配（运行时值原样传递 schemastery schema）。
 */
export declare function registerCostSettings(ctx: Context): SettingsScope<CostSettings>;
