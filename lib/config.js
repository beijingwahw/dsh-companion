/**
 * 插件根配置：四个功能模块可独立启停，互不影响。
 * 配置经 schemastery 校验后传入 apply；cordis.patch.yml 可覆盖任一字段。
 */
import Schema from '@deepseek-ai/schemastery';
export const Config = Schema.object({
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
});
