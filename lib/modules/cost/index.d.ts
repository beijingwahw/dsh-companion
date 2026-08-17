/**
 * 模块 C：API 成本优化（cost）插件入口（开发者模式）。
 *
 * 职责：
 * - 注册 companion.cost 设置（schemastery，applies: 'live'）；
 * - 挂载 CostGatewayService 策略层服务（ctx.companionCost）；
 * - HTTP 端点：state / api-key / settings / report / test-call /
 *   pricing / pricing/refresh（经 ctx.companion.http 挂载）；
 * - 命令 `usage`：本月用量文本报告；
 * - 动态计价引擎接线（吸收自 dsh-usage-ledger）：
 *   启动时恢复持久化价格快照与用户覆盖 → 立即刷新官方定价页 →
 *   按 config.pricingRefreshIntervalMin 周期刷新（DeepSeek + 全部国产厂商）→
 *   官方价格变化时持久化新快照。
 *
 * 安全红线：API Key 只经 ctx.companion.setApiKey 写入（加密落盘）；
 * 任何响应不含 Key 明文（/cost/state 只回 apiKeyConfigured 布尔）。
 * 所有注册均为 effect，随 Cordis fiber 生命周期自动回卷。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名（Cordis fiber 诊断名）。 */
export declare const name = "companion-cost";
/** 依赖声明：核心服务 + 设置 + 命令面板。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
