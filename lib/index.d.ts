/**
 * DeepSeek Companion — DeepSeek Harness 官方伴侣插件（宿主入口）。
 *
 * 一切皆插件：本入口只做两件事——
 * 1. 挂载 CompanionCore 根服务（存储域 / 保险库 / 记账 / HTTP 路由）；
 * 2. 按配置分别挂载四个功能模块（A 导出 / B 交接摘要 / C 成本优化 / D 检索），
 *    每个模块是独立子插件，可单独启停、互不影响。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { Config as ConfigShape } from './config.js';
export declare const name = "deepseek-companion";
export { Config };
export type { ConfigShape };
export declare function apply(ctx: Context, config: ConfigShape): void;
