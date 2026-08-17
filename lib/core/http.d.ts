/**
 * 插件私有 HTTP API 路由器。
 *
 * 根插件在 ctx.webServer 上注册唯一的前缀路由 `/companion`
 * （docs/subsystems/web-server.md），各功能模块通过
 * `ctx.companion.http.add(method, path, handler)` 挂载自己的端点；
 * 浏览器侧客户端（src/client）通过同源 fetch 调用这些端点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface HttpRequestContext {
    query: URLSearchParams;
    /** POST/DELETE 请求的 JSON 正文（GET 为 undefined）。 */
    body: unknown;
}
export type HttpHandler = (req: IncomingMessage, res: ServerResponse, ctx: HttpRequestContext) => void | Promise<void>;
/** 带状态码的业务错误。 */
export declare class HttpError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export interface CompanionRouter {
    /** 挂载端点；返回注销 disposer。重复 (method, path) 抛错。 */
    add(method: 'GET' | 'POST' | 'DELETE', path: string, handler: HttpHandler): () => void;
    /** 由 webServer 前缀路由委派的统一入口。 */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
/**
 * 创建路由器。
 * @param basePath 前缀路径（默认 /companion）。
 */
export declare function createRouter(basePath?: string): CompanionRouter;
/** 发送 JSON 响应。 */
export declare function sendJson(res: ServerResponse, status: number, payload: unknown): void;
/**
 * 读取并解析 JSON 请求体（大小上限默认 8 MB；空正文返回 {}）。
 * @param req 请求对象。
 * @param limitBytes 大小上限（字节）。
 * @param timeoutMs 读取超时（默认 30 秒）：慢速/停滞的 body 不会无限挂起，超时抛 408。
 */
export declare function readJsonBody(req: IncomingMessage, limitBytes?: number, timeoutMs?: number): Promise<unknown>;
