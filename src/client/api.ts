/**
 * 浏览器端 API 层：DESIGN.md 第 4 节私有 HTTP API 的类型化 fetch 封装。
 *
 * 契约要点：
 * - 全部端点为同源 `/companion` 前缀下的 JSON 接口；
 * - 非 2xx 响应统一携带 `{ "error": string }`，在此统一解析为 CompanionApiError；
 * - 字节内容以 base64 传输，客户端解码为 Blob 后触发下载；
 * - 不导入 node:* 或宿主代码，本模块仅依赖浏览器内置能力。
 */

// ---------------------------------------------------------------------------
// 通用：错误、基础类型与 fetch 封装
// ---------------------------------------------------------------------------

/** 私有 API 统一前缀（同源请求，见 DESIGN.md 第 4 节）。 */
const API_PREFIX = '/companion'

/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export class CompanionApiError extends Error {
  /** HTTP 状态码。 */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CompanionApiError'
    this.status = status
  }
}

/** 通用成功响应（服务端契约 `{ ok: true }`）。 */
export interface OkResponse {
  readonly ok: true
}

/** 会话头信息（客户端视角；跨 JSON 边界，id 为普通字符串）。 */
export interface SessionRecord {
  readonly id: string
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt?: number
}

/** 查询参数表：值为 undefined 或空串的条目不会发出。 */
export type QueryParams = Readonly<Record<string, string | number | undefined>>

/** 可选的请求控制参数：外部取消信号 + 超时时长。 */
export interface RequestOptions {
  /** 外部取消信号；与内部超时共用同一个 AbortController 联动。 */
  readonly signal?: AbortSignal
  /** 超时时长（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
}

/** 缺省请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** fetch 网络层不可达时的统一错误文案。 */
const NETWORK_UNREACHABLE_MESSAGE = '无法连接 Companion 服务，请确认 Harness 已启动且插件已加载'

/**
 * 带超时与外部取消联动的 fetch 封装：
 * - 内部持有 AbortController，超时（setTimeout）与外部 signal 都中止同一控制器；
 * - 外部 signal 先中止时透传其中止原因；请求结束后清理定时器与事件监听；
 * - fetch 网络层失败（TypeError）统一包装为 CompanionApiError(0, …)，
 *   中止（AbortError 等）与其他错误原样抛出。
 */
async function fetchWithGuard(url: string, init: RequestInit, options?: RequestOptions): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = window.setTimeout(
    () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
    timeoutMs,
  )
  const externalSignal = options?.signal
  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason)
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CompanionApiError(0, NETWORK_UNREACHABLE_MESSAGE)
    }
    throw error
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 收窄服务端错误体：契约规定非 2xx 一律携带 `{ error: string }`。 */
function extractErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as Record<string, unknown>).error
    if (typeof error === 'string' && error.length > 0) return error
  }
  return `请求失败（HTTP ${status}）`
}

/** 统一响应解析：非 2xx 读取 `{ error }` 并抛错；成功则解析 JSON。 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let payload: unknown
  try {
    payload = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new CompanionApiError(response.status, `服务端响应不是合法 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    throw new CompanionApiError(response.status, extractErrorMessage(payload, response.status))
  }
  return payload as T
}

function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length > 0 ? `?${text}` : ''
}

/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionGet<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T> {
  const response = await fetchWithGuard(`${API_PREFIX}${path}${buildQuery(params)}`, {}, options)
  return parseResponse<T>(response)
}

/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await fetchWithGuard(
    `${API_PREFIX}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  return parseResponse<T>(response)
}

/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionDelete<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const hasBody = body !== undefined
  const response = await fetchWithGuard(
    `${API_PREFIX}${path}`,
    {
      method: 'DELETE',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    },
    options,
  )
  return parseResponse<T>(response)
}

// ---------------------------------------------------------------------------
// 模块 A：对话智能导出（/export/*）
// ---------------------------------------------------------------------------

/** 导出格式（与服务端契约一致的字符串联合；png=长图，客户端光栅化）。 */
export type ExportFormat = 'markdown' | 'pdf' | 'json' | 'png'

/** `GET /export/sessions` 响应。 */
export interface ExportSessionsResponse {
  readonly sessions: readonly SessionRecord[]
}

/** `POST /export/run` 请求体。 */
export interface ExportRunRequest {
  readonly sessionId: string
  readonly format: ExportFormat
  /** 缺省为 true。 */
  readonly timestamps?: boolean
  /** 缺省为 false。 */
  readonly redact?: boolean
}

/** 导出结果为文件：base64 内容 + 文件名 + MIME。 */
export interface ExportFileResult {
  readonly kind: 'file'
  readonly fileName: string
  readonly mimeType: string
  readonly contentBase64: string
}

/** 导出结果为打印页（无光栅能力时的降级路径）：新窗口写入 html 并触发打印。 */
export interface ExportPrintResult {
  readonly kind: 'print'
  readonly fileName: string
  readonly html: string
}

/**
 * 导出结果为光栅载荷：客户端以 canvas 将 html 光栅化为成品
 * （PNG 长图或免打印多页 PDF），全程无 window.print() 对话框。
 */
export interface ExportRasterResult {
  readonly kind: 'raster'
  /** 目标成品：png=长图，pdf=免打印多页 PDF。 */
  readonly target: 'png' | 'pdf'
  readonly fileName: string
  readonly html: string
}

/** `POST /export/run` 响应。 */
export type ExportRunResponse = ExportFileResult | ExportPrintResult | ExportRasterResult

/** `POST /export/batch` 请求体。 */
export interface ExportBatchRequest {
  readonly sessionIds: readonly string[]
  readonly format: ExportFormat
  readonly timestamps?: boolean
  readonly redact?: boolean
}

/** `POST /export/batch` 响应（ZIP 压缩包）。 */
export interface ExportBatchResponse {
  readonly kind: 'file'
  readonly fileName: string
  readonly mimeType: 'application/zip'
  readonly contentBase64: string
}

/** 列出可导出的会话。 */
export function fetchExportSessions(options?: RequestOptions): Promise<ExportSessionsResponse> {
  return companionGet<ExportSessionsResponse>('/export/sessions', undefined, options)
}

/** 导出单个会话。 */
export function runExport(request: ExportRunRequest, options?: RequestOptions): Promise<ExportRunResponse> {
  return companionPost<ExportRunResponse>('/export/run', request, options)
}

/** 批量导出多个会话为 ZIP。 */
export function runExportBatch(request: ExportBatchRequest, options?: RequestOptions): Promise<ExportBatchResponse> {
  return companionPost<ExportBatchResponse>('/export/batch', request, options)
}

// ---------------------------------------------------------------------------
// 模块 B：上下文交接摘要（/handoff/*）
// ---------------------------------------------------------------------------

/** `POST /handoff/generate` 响应。 */
export interface HandoffGenerateResponse {
  readonly summary: string
  readonly model: string
}

/** 交接摘要模板条目。 */
export interface HandoffTemplate {
  readonly name: string
  readonly content: string
  readonly updatedAt: number
}

/** `GET /handoff/templates` 响应。 */
export interface HandoffTemplatesResponse {
  readonly templates: readonly HandoffTemplate[]
}

/** `POST /handoff/import` 请求体；省略 sessionId = 武装给“下一个新对话”。 */
export interface HandoffImportRequest {
  readonly summary: string
  readonly sessionId?: string
}

/** `POST /handoff/import` 响应；sessionId 为 null 表示武装给了下一个新对话。 */
export interface HandoffImportResponse {
  readonly ok: true
  readonly sessionId: string | null
}

/** 已武装的交接摘要条目。 */
export interface ArmedHandoff {
  /** null = 武装给下一个新对话。 */
  readonly sessionId: string | null
  readonly summary: string
  readonly armedAt: number
}

/** `GET /handoff/armed` 响应。 */
export interface ArmedHandoffsResponse {
  readonly armed: readonly ArmedHandoff[]
}

/** `DELETE /handoff/armed` 请求体（缺省 sessionId 时移除全局武装）。 */
export interface DismissArmedRequest {
  readonly sessionId?: string
}

/** 为指定会话生成交接摘要。 */
export function generateHandoff(
  request: { sessionId: string },
  options?: RequestOptions,
): Promise<HandoffGenerateResponse> {
  return companionPost<HandoffGenerateResponse>('/handoff/generate', request, options)
}

/** 列出全部交接摘要模板。 */
export function fetchHandoffTemplates(options?: RequestOptions): Promise<HandoffTemplatesResponse> {
  return companionGet<HandoffTemplatesResponse>('/handoff/templates', undefined, options)
}

/** 保存（覆盖）一个模板。 */
export function saveHandoffTemplate(request: { name: string; content: string }): Promise<OkResponse> {
  return companionPost<OkResponse>('/handoff/templates', request)
}

/** 删除一个模板。 */
export function deleteHandoffTemplate(name: string): Promise<OkResponse> {
  return companionDelete<OkResponse>('/handoff/templates', { name })
}

/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export function importHandoff(request: HandoffImportRequest): Promise<HandoffImportResponse> {
  return companionPost<HandoffImportResponse>('/handoff/import', request)
}

/** 查询当前已武装的交接摘要。 */
export function fetchArmedHandoffs(options?: RequestOptions): Promise<ArmedHandoffsResponse> {
  return companionGet<ArmedHandoffsResponse>('/handoff/armed', undefined, options)
}

/** 移除已武装的交接摘要。 */
export function dismissArmedHandoff(request: DismissArmedRequest): Promise<OkResponse> {
  return companionDelete<OkResponse>('/handoff/armed', request)
}

// ---------------------------------------------------------------------------
// 模块 C：API 成本优化（/cost/*）
// ---------------------------------------------------------------------------

/**
 * 模型单价（元 / 百万 tokens）：动态计价引擎形状
 * （吸收自 dsh-usage-ledger），用户可按模型 id 覆盖（最长前缀匹配）。
 */
export interface ModelPrice {
  /** 命中前缀缓存的输入单价。 */
  readonly inputCacheHit: number
  /** 未命中缓存的输入单价。 */
  readonly inputMiss: number
  /** 输出单价。 */
  readonly output: number
}

/** 单厂商定价面板数据。 */
export interface VendorPricing {
  readonly id: string
  readonly label: string
  readonly pricingUrl: string
  /** 是否阶梯计价（展示的是最低档）。 */
  readonly tiered: boolean
  /** live=官方定价页实时抓取；builtin=内置快照；override=用户自定义。 */
  readonly source: 'live' | 'builtin' | 'override'
  readonly fetchedAt?: number
  readonly models: Readonly<Record<string, ModelPrice>>
}

/** 动态计价引擎面板数据（`GET /cost/pricing` 与 /cost/state.pricing）。 */
export interface CostPricingView {
  /** DeepSeek 价格表来源：live=官方页实时抓取；builtin=内置快照。 */
  readonly source: 'live' | 'builtin'
  readonly sourceUrl?: string
  readonly fetchedAt?: number
  /** 官方价格最近一次内容变更时间（undefined=从未）。 */
  readonly lastChangedAt?: number
  /** 峰谷分时计划（null=暂无）。 */
  readonly scheduled: Readonly<{
    readonly effective: string
    readonly peakWindows?: ReadonlyArray<readonly [number, number]>
    readonly offPeak: Readonly<Record<string, ModelPrice>>
    readonly peak: Readonly<Record<string, ModelPrice>>
  }> | null
  /** 用户自定义单价覆盖。 */
  readonly overrides: Readonly<Record<string, ModelPrice>>
  /** 按厂商分组的全部已知定价。 */
  readonly vendors: readonly VendorPricing[]
}

/** 模型路由规则（细节由服务端成本模块维护，客户端只读透传，不展开字段）。 */
export type CostRoutingRule = Readonly<Record<string, unknown>>

/** 日/月双档预算状态。 */
export interface CostBudgetState {
  /** 日预算（元）；0 表示不限。 */
  readonly dailyCny: number
  /** 今日已花费（元，北京时间日）。 */
  readonly dailySpentCny: number
  /** 日用量/日预算比值（日预算为 0 时取 0）。 */
  readonly dailyRatio: number
  readonly monthlyCny: number
  readonly spentCny: number
  /** 已用 / 预算（0~1，可能大于 1）。 */
  readonly ratio: number
  /** 任一档预算用尽后是否已暂停 API 调用。 */
  readonly paused: boolean
}

/** `GET /cost/state` 响应。 */
export interface CostState {
  readonly devMode: boolean
  readonly apiKeyConfigured: boolean
  readonly peakScheduling: boolean
  readonly modelRouting: boolean
  readonly budget: CostBudgetState
  readonly rules: readonly CostRoutingRule[]
  readonly pricing: CostPricingView
}

/** `POST /cost/settings` 稀疏补丁：只携带需要变更的字段。 */
export interface CostSettingsPatch {
  readonly devMode?: boolean
  readonly peakScheduling?: boolean
  readonly modelRouting?: boolean
  readonly dailyBudgetCny?: number
  readonly monthlyBudgetCny?: number
  readonly rules?: readonly CostRoutingRule[]
  readonly pricing?: Readonly<Record<string, ModelPrice>>
}

/** 按模型切片的当日用量。 */
export interface ModelUsageSlice {
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省）。 */
  readonly cacheHitTokens?: number
  readonly costCny: number
}

/** 北京时间日粒度用量聚合。 */
export interface DailyUsage {
  /** 日期键 YYYY-MM-DD。 */
  readonly day: string
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** 命中缓存的输入 tokens（旧行可能缺省）。 */
  readonly cacheHitTokens?: number
  readonly costCny: number
  /** 通过模型路由/峰谷调度节省的估算金额。 */
  readonly savedCny: number
  /** 被峰谷调度延迟执行的调用数。 */
  readonly deferredCalls: number
  readonly byModel: Readonly<Record<string, ModelUsageSlice>>
}

/** 区间用量汇总。 */
export interface UsageTotal {
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheHitTokens: number
  readonly costCny: number
  readonly savedCny: number
  readonly deferredCalls: number
}

/** `GET /cost/report` 响应。 */
export interface CostReportResponse {
  readonly days: readonly DailyUsage[]
  readonly total: UsageTotal
}

/** `POST /cost/test-call` 响应。 */
export interface CostTestCallResponse {
  readonly ok: true
  readonly model: string
  readonly latencyMs: number
}

/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export function fetchCostState(options?: RequestOptions): Promise<CostState> {
  return companionGet<CostState>('/cost/state', undefined, options)
}

/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export function saveCostApiKey(apiKey: string): Promise<OkResponse> {
  return companionPost<OkResponse>('/cost/api-key', { apiKey })
}

/** 删除已保存的 API Key。 */
export function removeCostApiKey(): Promise<OkResponse> {
  return companionDelete<OkResponse>('/cost/api-key')
}

/** 更新成本设置（稀疏补丁）。 */
export function updateCostSettings(patch: CostSettingsPatch): Promise<OkResponse> {
  return companionPost<OkResponse>('/cost/settings', patch)
}

/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export function fetchCostReport(
  range: { from: string; to: string },
  options?: RequestOptions,
): Promise<CostReportResponse> {
  return companionGet<CostReportResponse>('/cost/report', { from: range.from, to: range.to }, options)
}

/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export function testCostCall(): Promise<CostTestCallResponse> {
  return companionPost<CostTestCallResponse>('/cost/test-call')
}

/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export function fetchCostPricing(options?: RequestOptions): Promise<CostPricingView> {
  return companionGet<CostPricingView>('/cost/pricing', undefined, options)
}

/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export function refreshCostPricing(options?: RequestOptions): Promise<CostPricingView> {
  return companionPost<CostPricingView>('/cost/pricing/refresh', undefined, options)
}

// ---------------------------------------------------------------------------
// 模块 D：全局对话检索（/search、/tags）
// ---------------------------------------------------------------------------

/** `GET /search` 请求参数。 */
export interface SearchRequest {
  readonly query?: string
  /** YYYY-MM-DD。 */
  readonly from?: string
  /** YYYY-MM-DD。 */
  readonly to?: string
  readonly tags?: readonly string[]
  readonly limit?: number
}

/** 单条检索命中。 */
export interface SearchHit {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
}

/** `GET /search` 响应。 */
export interface SearchResponse {
  readonly hits: readonly SearchHit[]
}

/** `GET /tags?sessionId=` 响应（单个会话的标签）。 */
export interface SessionTagsResponse {
  readonly tags: readonly string[]
}

/** `GET /tags`（缺省 sessionId）响应：标签 → 会话 id 列表的全量映射。 */
export interface AllTagsResponse {
  readonly tags: Readonly<Record<string, readonly string[]>>
}

/** `POST /tags` 请求体。 */
export interface UpdateTagsRequest {
  readonly sessionId: string
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}

/** 跨会话全文检索。 */
export function searchSessions(request: SearchRequest): Promise<SearchResponse> {
  return companionGet<SearchResponse>('/search', {
    query: request.query,
    from: request.from,
    to: request.to,
    tags: request.tags && request.tags.length > 0 ? request.tags.join(',') : undefined,
    limit: request.limit,
  })
}

/** 读取单个会话的标签。 */
export function fetchSessionTags(sessionId: string): Promise<SessionTagsResponse> {
  return companionGet<SessionTagsResponse>('/tags', { sessionId })
}

/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export function fetchAllTags(): Promise<AllTagsResponse> {
  return companionGet<AllTagsResponse>('/tags')
}

/** 为会话增删标签。 */
export function updateSessionTags(request: UpdateTagsRequest): Promise<SessionTagsResponse> {
  return companionPost<SessionTagsResponse>('/tags', request)
}

// ---------------------------------------------------------------------------
// 浏览器工具：base64 解码、下载、打印
// ---------------------------------------------------------------------------

/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 延迟释放，确保下载已启动
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export function openPrintHtml(html: string): void {
  const win = window.open('', '_blank')
  if (!win) {
    throw new CompanionApiError(0, '浏览器拦截了弹出窗口，请允许弹窗后重试打印导出')
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.focus()
  // 留出少量渲染时间再唤起打印对话框；若窗口在此期间被关闭则跳过打印
  window.setTimeout(() => {
    if (!win.closed) win.print()
  }, 250)
}
