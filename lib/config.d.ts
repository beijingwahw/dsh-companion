/**
 * 插件根配置：四个功能模块可独立启停，互不影响。
 * 配置经 schemastery 校验后传入 apply；cordis.patch.yml 可覆盖任一字段。
 */
import Schema from '@deepseek-ai/schemastery';
export interface Config {
    /** 模块 A：对话智能导出。 */
    enableExport: boolean;
    /** 模块 B：上下文交接摘要。 */
    enableHandoff: boolean;
    /** 模块 C：API 成本优化（开发者模式）。 */
    enableCost: boolean;
    /** 模块 D：全局对话检索。 */
    enableSearch: boolean;
    /** DeepSeek 官方 API 基址（manifest.json 已放行该域名）。 */
    apiBaseUrl: string;
    /** 单次 API 调用超时（毫秒）。 */
    apiTimeoutMs: number;
    /** 单次定价页抓取的墙上时钟预算（毫秒）；供动态计价引擎使用。 */
    pricingTimeoutMs: number;
    /** 官方定价页刷新间隔（分钟）；下限 5 分钟，避免高频抓取官方页。 */
    pricingRefreshIntervalMin: number;
}
export declare const Config: Schema<Config>;
