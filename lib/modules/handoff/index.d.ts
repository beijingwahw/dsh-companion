/**
 * 模块 B：上下文交接摘要（handoff）插件入口——轴线 2「上下文工程 2.0」。
 *
 * 职责：
 * - 为指定会话生成交接摘要（优先经 ctx.companionCost 策略层，缺省直连核心服务）；
 * - 超长对话走 map-reduce 分层摘要（hierarchical.ts）：分块抽取 → 内容哈希
 *   缓存 → 递归归并，突破单发 prompt 预算且不丢弃中段内容；
 * - 查询聚焦（focus）：可选主题词注入提示词，定向保留相关内容；
 * - 会话继承图谱（lineage.ts）：追踪摘要跨会话传播链路（血缘可视化）；
 * - 管理摘要模板（templates 表）与武装状态（handoff-armed 表）；
 * - 经 ctx.systemPrompt.context 注入已武装的摘要：
 *   特定会话武装按装配 scope 匹配注入；pending 武装只注入下一次装配。
 *
 * HTTP 端点经 ctx.companion.http 挂载在 /companion 前缀下（形状见 DESIGN.md 第 4 节）；
 * 命令 `handoff` / `handoff-import` 与端点复用同一套模块内服务函数。
 * 所有注册均为 effect，随 Cordis fiber 生命周期自动回卷。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名（Cordis fiber 诊断名）。 */
export declare const name = "companion-handoff";
/** 依赖声明：核心服务 + 会话查询 + 命令面板 + 系统提示词装配。 */
export declare const inject: string[];
/** 插件入口。 */
export declare function apply(ctx: Context): void;
