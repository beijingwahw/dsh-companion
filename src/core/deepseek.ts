/**
 * DeepSeek 官方 API 客户端（https://api.deepseek.com，OpenAI 兼容协议）。
 *
 * 只负责“一次受控的 chat/completions 调用”：鉴权、超时、错误分类、
 * usage 解析。策略层（模型路由 / 峰谷调度 / 预算闸门）由成本模块包装，
 * 记账与事件由 CompanionCore 完成。
 */

/** 发送给 DeepSeek API 的消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Token 用量（对齐官方 usage 字段）。 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  promptCacheHitTokens: number
}

export interface ChatCompletionParams {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  model: string
  messages: readonly ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatResult {
  id: string
  model: string
  content: string
  usage: TokenUsage
  latencyMs: number
}

/** DeepSeek API 错误分类。 */
export type DeepSeekErrorCode =
  | 'NO_API_KEY'
  | 'AUTH_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'BAD_RESPONSE'

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    readonly code: DeepSeekErrorCode,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DeepSeekApiError'
  }
}

/** 超时缺省值（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 校验超时配置：非有限数或 <=0 时回退默认值，
 * 避免 AbortSignal.timeout 因非法参数抛 RangeError。
 */
function sanitizeTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.floor(value)
}

/**
 * 将响应 usage 字段强制转换为非负有限数字（Number + Number.isFinite）。
 * 上游返回 null/字符串/NaN/负数等非法值时一律取 0，防止 NaN 污染费用统计。
 */
function toNonNegativeNumber(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

/**
 * 执行一次非流式 chat/completions 调用。
 * @param params 调用参数（含 baseUrl / apiKey / 超时）。
 * @returns 解析后的结果，含 usage 与耗时。
 * @throws DeepSeekApiError（携带错误分类，便于 UI 本地化提示）。
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<ChatResult> {
  const startedAt = Date.now()
  const timeoutMs = sanitizeTimeoutMs(params.timeoutMs)
  const url = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: false,
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens

  let response: Response
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
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new DeepSeekApiError(`请求超时（${timeoutMs}ms）`, 'TIMEOUT')
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DeepSeekApiError('请求已被取消', 'ABORTED')
    }
    throw new DeepSeekApiError(
      `网络错误：${error instanceof Error ? error.message : String(error)}`,
      'NETWORK_ERROR',
    )
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw classifyHttpError(response.status, detail)
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new DeepSeekApiError('响应不是合法 JSON', 'BAD_RESPONSE', response.status)
  }

  const parsed = parseChatResponse(json)
  return { ...parsed, latencyMs: Date.now() - startedAt }
}

function parseChatResponse(json: unknown): Omit<ChatResult, 'latencyMs'> {
  const root = json as {
    id?: string
    model?: string
    choices?: { message?: { content?: unknown } }[]
    // 上游字段类型不可信：按 unknown 接收，统一经 toNonNegativeNumber 强制转换。
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      total_tokens?: unknown
      prompt_cache_hit_tokens?: unknown
    }
  }
  const content = root.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new DeepSeekApiError('响应缺少 choices[0].message.content', 'BAD_RESPONSE')
  }
  const usage = root.usage ?? {}
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
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string; code?: string } }
    return json.error?.message ?? ''
  } catch {
    return ''
  }
}

function classifyHttpError(status: number, detail: string): DeepSeekApiError {
  switch (status) {
    case 401:
      return new DeepSeekApiError(detail || 'API Key 无效或已过期', 'AUTH_FAILED', status)
    case 402:
      return new DeepSeekApiError(detail || '账户余额不足', 'INSUFFICIENT_BALANCE', status)
    case 429:
      return new DeepSeekApiError(detail || '触发速率限制', 'RATE_LIMITED', status)
    default:
      if (status >= 500) {
        return new DeepSeekApiError(detail || `服务端错误（HTTP ${status}）`, 'SERVER_ERROR', status)
      }
      return new DeepSeekApiError(detail || `请求失败（HTTP ${status}）`, 'BAD_RESPONSE', status)
  }
}
