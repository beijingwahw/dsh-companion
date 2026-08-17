import type { ClientContext } from '@deepseek-ai/dsh-client-runtime';
/** 客户端插件名。 */
export declare const name = "deepseek-companion-client";
/** 客户端 Cordis 上下文仅依赖 slots 服务。 */
export declare const inject: string[];
/**
 * 客户端插件 apply：按 slots 纪律注册全部 UI 贡献。
 * 组件经 `inject: (sessionId) => ({ sessionId })` 注入当前会话 id；
 * 每个组件统一经 withErrorBoundary 包裹，单个组件渲染错误只降级自身，不波及宿主。
 */
export declare function apply(ctx: ClientContext): void;
