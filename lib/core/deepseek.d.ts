/**
 * DeepSeek 官方 API 客户端（https://api.deepseek.com，OpenAI 兼容协议）。
 *
 * 只负责“一次受控的 chat/completions 调用”：鉴权、超时、错误分类、
 * usage 解析。策略层（模型路由 / 峰谷调度 / 预算闸门）由成本模块包装，
 * 记账与事件由 CompanionCore 完成。
 */
/** 发送给 DeepSeek API 的消息。 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
/** Token 用量（对齐官方 usage 字段）。 */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens: number;
}
export interface ChatCompletionParams {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    model: string;
    messages: readonly ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    /** 开启 JSON 输出模式（response_format: json_object）。 */
    jsonMode?: boolean;
    signal?: AbortSignal;
}
export interface ChatResult {
    id: string;
    model: string;
    content: string;
    usage: TokenUsage;
    latencyMs: number;
}
/** DeepSeek API 错误分类。 */
export type DeepSeekErrorCode = 'NO_API_KEY' | 'AUTH_FAILED' | 'INSUFFICIENT_BALANCE' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'BAD_RESPONSE';
export declare class DeepSeekApiError extends Error {
    readonly code: DeepSeekErrorCode;
    readonly status?: number | undefined;
    constructor(message: string, code: DeepSeekErrorCode, status?: number | undefined);
}
/**
 * 执行一次非流式 chat/completions 调用。
 * @param params 调用参数（含 baseUrl / apiKey / 超时）。
 * @returns 解析后的结果，含 usage 与耗时。
 * @throws DeepSeekApiError（携带错误分类，便于 UI 本地化提示）。
 */
export declare function chatCompletion(params: ChatCompletionParams): Promise<ChatResult>;
