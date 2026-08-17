/**
 * 模块 A：对话智能导出插件。
 *
 * 经 ctx.companion.http 注册三个私有端点（GET /export/sessions、
 * POST /export/run、POST /export/batch），经 ctx.commands 注册
 * `export` 与 `export-batch` 两个命令。HTTP 与命令复用 ./service.js
 * 的同一套服务函数，不重复实现逻辑（DESIGN.md 第 5 节）。
 * 全部注册经 ctx.effect，随插件卸载自动回卷；错误一律收敛为
 * HttpError / 用户可读文本，不泄漏内部细节。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件名。 */
export declare const name = "companion-export";
/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export declare const inject: string[];
/** 插件入口：所有注册经 ctx.effect，卸载时统一回卷。 */
export declare function apply(ctx: Context): void;
