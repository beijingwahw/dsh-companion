/**
 * DeepSeek 官方 API 客户端（https://api.deepseek.com，OpenAI 兼容协议）。
 *
 * 只负责“一次受控的 chat/completions 调用”：鉴权、超时、错误分类、
 * usage 解析。策略层（模型路由 / 峰谷调度 / 预算闸门）由成本模块包装，
 * 记账与事件由 CompanionCore 完成。
 */
export class DeepSeekApiError extends Error {
    code;
    status;
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'DeepSeekApiError';
    }
}
/** 超时缺省值（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * 校验超时配置：非有限数或 <=0 时回退默认值，
 * 避免 AbortSignal.timeout 因非法参数抛 RangeError。
 */
function sanitizeTimeoutMs(value) {
    if (!Number.isFinite(value) || value <= 0)
        return DEFAULT_TIMEOUT_MS;
    return Math.floor(value);
}
/**
 * 将响应 usage 字段强制转换为非负有限数字（Number + Number.isFinite）。
 * 上游返回 null/字符串/NaN/负数等非法值时一律取 0，防止 NaN 污染费用统计。
 */
function toNonNegativeNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0)
        return 0;
    return n;
}
/**
 * 执行一次非流式 chat/completions 调用。
 * @param params 调用参数（含 baseUrl / apiKey / 超时）。
 * @returns 解析后的结果，含 usage 与耗时。
 * @throws DeepSeekApiError（携带错误分类，便于 UI 本地化提示）。
 */
export async function chatCompletion(params) {
    const startedAt = Date.now();
    const timeoutMs = sanitizeTimeoutMs(params.timeoutMs);
    const url = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
        model: params.model,
        messages: params.messages,
        stream: false,
    };
    if (params.temperature !== undefined)
        body.temperature = params.temperature;
    if (params.maxTokens !== undefined)
        body.max_tokens = params.maxTokens;
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${params.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([
                AbortSignal.timeout(timeoutMs),
                ...(params.signal ? [params.signal] : []),
            ]),
        });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
            throw new DeepSeekApiError(`请求超时（${timeoutMs}ms）`, 'TIMEOUT');
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new DeepSeekApiError('请求已被取消', 'ABORTED');
        }
        throw new DeepSeekApiError(`网络错误：${error instanceof Error ? error.message : String(error)}`, 'NETWORK_ERROR');
    }
    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw classifyHttpError(response.status, detail);
    }
    let json;
    try {
        json = await response.json();
    }
    catch {
        throw new DeepSeekApiError('响应不是合法 JSON', 'BAD_RESPONSE', response.status);
    }
    const parsed = parseChatResponse(json);
    return { ...parsed, latencyMs: Date.now() - startedAt };
}
function parseChatResponse(json) {
    const root = json;
    const content = root.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new DeepSeekApiError('响应缺少 choices[0].message.content', 'BAD_RESPONSE');
    }
    const usage = root.usage ?? {};
    return {
        id: root.id ?? '',
        model: root.model ?? '',
        content,
        usage: {
            promptTokens: toNonNegativeNumber(usage.prompt_tokens),
            completionTokens: toNonNegativeNumber(usage.completion_tokens),
            totalTokens: toNonNegativeNumber(usage.total_tokens),
            promptCacheHitTokens: toNonNegativeNumber(usage.prompt_cache_hit_tokens),
        },
    };
}
async function readErrorDetail(response) {
    try {
        const json = (await response.json());
        return json.error?.message ?? '';
    }
    catch {
        return '';
    }
}
function classifyHttpError(status, detail) {
    switch (status) {
        case 401:
            return new DeepSeekApiError(detail || 'API Key 无效或已过期', 'AUTH_FAILED', status);
        case 402:
            return new DeepSeekApiError(detail || '账户余额不足', 'INSUFFICIENT_BALANCE', status);
        case 429:
            return new DeepSeekApiError(detail || '触发速率限制', 'RATE_LIMITED', status);
        default:
            if (status >= 500) {
                return new DeepSeekApiError(detail || `服务端错误（HTTP ${status}）`, 'SERVER_ERROR', status);
            }
            return new DeepSeekApiError(detail || `请求失败（HTTP ${status}）`, 'BAD_RESPONSE', status);
    }
}
