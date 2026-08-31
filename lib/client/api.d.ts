/**
 * 浏览器端 API 层：DESIGN.md 第 4 节私有 HTTP API 的类型化 fetch 封装。
 *
 * 契约要点：
 * - 全部端点为同源 `/companion` 前缀下的 JSON 接口；
 * - 非 2xx 响应统一携带 `{ "error": string }`，在此统一解析为 CompanionApiError；
 * - 字节内容以 base64 传输，客户端解码为 Blob 后触发下载；
 * - 不导入 node:* 或宿主代码，本模块仅依赖浏览器内置能力。
 */
/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export declare class CompanionApiError extends Error {
    /** HTTP 状态码。 */
    readonly status: number;
    constructor(status: number, message: string);
}
/** 通用成功响应（服务端契约 `{ ok: true }`）。 */
export interface OkResponse {
    readonly ok: true;
}
/** 会话头信息（客户端视角；跨 JSON 边界，id 为普通字符串）。 */
export interface SessionRecord {
    readonly id: string;
    readonly title?: string;
    readonly createdAt: number;
    readonly updatedAt?: number;
}
/** 查询参数表：值为 undefined 或空串的条目不会发出。 */
export type QueryParams = Readonly<Record<string, string | number | undefined>>;
/** 可选的请求控制参数：外部取消信号 + 超时时长。 */
export interface RequestOptions {
    /** 外部取消信号；与内部超时共用同一个 AbortController 联动。 */
    readonly signal?: AbortSignal;
    /** 超时时长（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS}。 */
    readonly timeoutMs?: number;
}
/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionGet<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<T>;
/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export declare function companionDelete<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
/** 导出格式（与服务端契约一致的字符串联合；png=长图，客户端光栅化）。 */
export type ExportFormat = 'markdown' | 'pdf' | 'json' | 'png';
/** `GET /export/sessions` 响应。 */
export interface ExportSessionsResponse {
    readonly sessions: readonly SessionRecord[];
}
/** 回合选择面板的单回合预览（`GET /export/turns` 响应项）。 */
export interface ExportTurnSummary {
    /** 回合在列表中的下标（0 起），导出请求的 turns 数组引用该值。 */
    readonly index: number;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    /** 回合事件时间（毫秒时间戳）。 */
    readonly time: number;
    /** 折叠空白后截断的纯文本预览。 */
    readonly preview: string;
}
/** `GET /export/turns` 响应（回合选择面板数据源）。 */
export interface ExportTurnsResponse {
    readonly turns: readonly ExportTurnSummary[];
}
/** `POST /export/run` 请求体。 */
export interface ExportRunRequest {
    readonly sessionId: string;
    readonly format: ExportFormat;
    /** 缺省为 true。 */
    readonly timestamps?: boolean;
    /** 缺省为 false。 */
    readonly redact?: boolean;
    /**
     * 仅导出选中的回合（回合在回合列表中的下标）；省略 = 导出全部回合。
     * 全选状态省略该字段，请求体最小。
     */
    readonly turns?: readonly number[];
}
/** 导出结果为文件：base64 内容 + 文件名 + MIME。 */
export interface ExportFileResult {
    readonly kind: 'file';
    readonly fileName: string;
    readonly mimeType: string;
    readonly contentBase64: string;
}
/** 导出结果为打印页（无光栅能力时的降级路径）：新窗口写入 html 并触发打印。 */
export interface ExportPrintResult {
    readonly kind: 'print';
    readonly fileName: string;
    readonly html: string;
}
/**
 * 导出结果为光栅载荷：客户端以 canvas 将 html 光栅化为成品
 * （PNG 长图或免打印多页 PDF），全程无 window.print() 对话框。
 */
export interface ExportRasterResult {
    readonly kind: 'raster';
    /** 目标成品：png=长图，pdf=免打印多页 PDF。 */
    readonly target: 'png' | 'pdf';
    readonly fileName: string;
    readonly html: string;
}
/** `POST /export/run` 响应。 */
export type ExportRunResponse = ExportFileResult | ExportPrintResult | ExportRasterResult;
/** `POST /export/batch` 请求体。 */
export interface ExportBatchRequest {
    readonly sessionIds: readonly string[];
    readonly format: ExportFormat;
    readonly timestamps?: boolean;
    readonly redact?: boolean;
}
/** `POST /export/batch` 响应（ZIP 压缩包）。 */
export interface ExportBatchResponse {
    readonly kind: 'file';
    readonly fileName: string;
    readonly mimeType: 'application/zip';
    readonly contentBase64: string;
}
/** 列出可导出的会话。 */
export declare function fetchExportSessions(options?: RequestOptions): Promise<ExportSessionsResponse>;
/** 列出会话的回合预览（回合选择面板数据源）。 */
export declare function fetchExportTurns(sessionId: string, options?: RequestOptions): Promise<ExportTurnsResponse>;
/** 导出单个会话。 */
export declare function runExport(request: ExportRunRequest, options?: RequestOptions): Promise<ExportRunResponse>;
/** 批量导出多个会话为 ZIP。 */
export declare function runExportBatch(request: ExportBatchRequest, options?: RequestOptions): Promise<ExportBatchResponse>;
/** 分层摘要统计（轴线 2：超长对话 map-reduce 路径的可观测性）。 */
export interface HandoffStats {
    /** 是否走了 map-reduce 路径（false = 单发路径）。 */
    readonly hierarchical: boolean;
    /** 片段总数（单发路径为 0）。 */
    readonly chunks: number;
    /** 命中缓存的片段数。 */
    readonly cachedChunks: number;
}
/** `POST /handoff/generate` 响应。 */
export interface HandoffGenerateResponse {
    readonly summary: string;
    readonly model: string;
    readonly stats?: HandoffStats;
}
/** 交接摘要模板条目。 */
export interface HandoffTemplate {
    readonly name: string;
    readonly content: string;
    readonly updatedAt: number;
}
/** `GET /handoff/templates` 响应。 */
export interface HandoffTemplatesResponse {
    readonly templates: readonly HandoffTemplate[];
}
/** `POST /handoff/import` 请求体；省略 sessionId = 武装给“下一个新对话”。 */
export interface HandoffImportRequest {
    readonly summary: string;
    readonly sessionId?: string;
    /** 摘要来源会话（轴线 2 继承图谱）：记录血缘边的 source。 */
    readonly sourceSessionId?: string;
}
/** `POST /handoff/import` 响应；sessionId 为 null 表示武装给了下一个新对话。 */
export interface HandoffImportResponse {
    readonly ok: true;
    readonly sessionId: string | null;
}
/** 已武装的交接摘要条目。 */
export interface ArmedHandoff {
    /** null = 武装给下一个新对话。 */
    readonly sessionId: string | null;
    readonly summary: string;
    readonly armedAt: number;
}
/** `GET /handoff/armed` 响应。 */
export interface ArmedHandoffsResponse {
    readonly armed: readonly ArmedHandoff[];
    /** pending 摘要的投递回执（世代门闩可观测性）。 */
    readonly receipts?: readonly HandoffReceipt[];
}
/** pending 摘要的投递回执。 */
export interface HandoffReceipt {
    readonly sessionId: string;
    readonly injectedAt: number;
}
/** `DELETE /handoff/armed` 请求体（缺省 sessionId 时移除全局武装）。 */
export interface DismissArmedRequest {
    readonly sessionId?: string;
}
/** 为指定会话生成交接摘要；focus 为可选查询聚焦主题（轴线 2）。 */
export declare function generateHandoff(request: {
    sessionId: string;
    focus?: string;
    template?: string;
}, options?: RequestOptions): Promise<HandoffGenerateResponse>;
/** 列出全部交接摘要模板。 */
export declare function fetchHandoffTemplates(options?: RequestOptions): Promise<HandoffTemplatesResponse>;
/** 保存（覆盖）一个模板。 */
export declare function saveHandoffTemplate(request: {
    name: string;
    content: string;
}): Promise<OkResponse>;
/** 删除一个模板。 */
export declare function deleteHandoffTemplate(name: string): Promise<OkResponse>;
/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export declare function importHandoff(request: HandoffImportRequest): Promise<HandoffImportResponse>;
/** 查询当前已武装的交接摘要。 */
export declare function fetchArmedHandoffs(options?: RequestOptions): Promise<ArmedHandoffsResponse>;
/** 移除已武装的交接摘要。 */
export declare function dismissArmedHandoff(request: DismissArmedRequest): Promise<OkResponse>;
/** 继承图谱节点（轴线 2：上下文血缘）。 */
export interface LineageNode {
    readonly sessionId: string;
    /** 距查询起点的跳数（1 = 直接相邻）。 */
    readonly depth: number;
    /** 传播所用摘要摘录。 */
    readonly excerpt: string;
    readonly linkedAt: number;
}
/** `GET /handoff/lineage?sessionId=` 响应。 */
export interface HandoffLineageResponse {
    readonly ancestors: readonly LineageNode[];
    readonly descendants: readonly LineageNode[];
}
/** 查询会话的上下文血缘（祖先 = 内容流入方，后代 = 内容流向方）。 */
export declare function fetchHandoffLineage(sessionId: string, options?: RequestOptions): Promise<HandoffLineageResponse>;
/**
 * 模型单价（元 / 百万 tokens）：动态计价引擎形状
 * （吸收自 dsh-usage-ledger），用户可按模型 id 覆盖（最长前缀匹配）。
 */
export interface ModelPrice {
    /** 命中前缀缓存的输入单价。 */
    readonly inputCacheHit: number;
    /** 未命中缓存的输入单价。 */
    readonly inputMiss: number;
    /** 输出单价。 */
    readonly output: number;
}
/** 单厂商定价面板数据。 */
export interface VendorPricing {
    readonly id: string;
    readonly label: string;
    readonly pricingUrl: string;
    /** 是否阶梯计价（展示的是最低档）。 */
    readonly tiered: boolean;
    /** live=官方定价页实时抓取；builtin=内置快照；override=用户自定义。 */
    readonly source: 'live' | 'builtin' | 'override';
    readonly fetchedAt?: number;
    readonly models: Readonly<Record<string, ModelPrice>>;
}
/** 动态计价引擎面板数据（`GET /cost/pricing` 与 /cost/state.pricing）。 */
export interface CostPricingView {
    /** DeepSeek 价格表来源：live=官方页实时抓取；builtin=内置快照。 */
    readonly source: 'live' | 'builtin';
    readonly sourceUrl?: string;
    readonly fetchedAt?: number;
    /** 官方价格最近一次内容变更时间（undefined=从未）。 */
    readonly lastChangedAt?: number;
    /** 峰谷分时计划（null=暂无）。 */
    readonly scheduled: Readonly<{
        readonly effective: string;
        readonly peakWindows?: ReadonlyArray<readonly [number, number]>;
        readonly offPeak: Readonly<Record<string, ModelPrice>>;
        readonly peak: Readonly<Record<string, ModelPrice>>;
    }> | null;
    /** 用户自定义单价覆盖。 */
    readonly overrides: Readonly<Record<string, ModelPrice>>;
    /** 按厂商分组的全部已知定价。 */
    readonly vendors: readonly VendorPricing[];
}
/** 模型路由规则（细节由服务端成本模块维护，客户端只读透传，不展开字段）。 */
export type CostRoutingRule = Readonly<Record<string, unknown>>;
/** 日/月双档预算状态。 */
export interface CostBudgetState {
    /** 日预算（元）；0 表示不限。 */
    readonly dailyCny: number;
    /** 今日已花费（元，北京时间日）。 */
    readonly dailySpentCny: number;
    /** 日用量/日预算比值（日预算为 0 时取 0）。 */
    readonly dailyRatio: number;
    readonly monthlyCny: number;
    readonly spentCny: number;
    /** 已用 / 预算（0~1，可能大于 1）。 */
    readonly ratio: number;
    /** 任一档预算用尽后是否已暂停 API 调用。 */
    readonly paused: boolean;
    /** 在途预授权合计（元，调用期权协议的预留总额）。 */
    readonly reservedCny?: number;
}
/** `GET /cost/state` 响应。 */
export interface CostState {
    readonly devMode: boolean;
    readonly apiKeyConfigured: boolean;
    readonly peakScheduling: boolean;
    readonly modelRouting: boolean;
    readonly budget: CostBudgetState;
    readonly rules: readonly CostRoutingRule[];
    readonly pricing: CostPricingView;
}
/** `POST /cost/settings` 稀疏补丁：只携带需要变更的字段。 */
export interface CostSettingsPatch {
    readonly devMode?: boolean;
    readonly peakScheduling?: boolean;
    readonly modelRouting?: boolean;
    readonly dailyBudgetCny?: number;
    readonly monthlyBudgetCny?: number;
    readonly rules?: readonly CostRoutingRule[];
    readonly pricing?: Readonly<Record<string, ModelPrice>>;
}
/** 按模型切片的当日用量。 */
export interface ModelUsageSlice {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省）。 */
    readonly cacheHitTokens?: number;
    readonly costCny: number;
}
/** 北京时间日粒度用量聚合。 */
export interface DailyUsage {
    /** 日期键 YYYY-MM-DD。 */
    readonly day: string;
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省）。 */
    readonly cacheHitTokens?: number;
    readonly costCny: number;
    /** 通过模型路由/峰谷调度节省的估算金额。 */
    readonly savedCny: number;
    /** 被峰谷调度延迟执行的调用数。 */
    readonly deferredCalls: number;
    readonly byModel: Readonly<Record<string, ModelUsageSlice>>;
}
/** 区间用量汇总。 */
export interface UsageTotal {
    readonly calls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheHitTokens: number;
    readonly costCny: number;
    readonly savedCny: number;
    readonly deferredCalls: number;
}
/** `GET /cost/report` 响应。 */
export interface CostReportResponse {
    readonly days: readonly DailyUsage[];
    readonly total: UsageTotal;
}
/** `POST /cost/test-call` 响应。 */
export interface CostTestCallResponse {
    readonly ok: true;
    readonly model: string;
    readonly latencyMs: number;
}
/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export declare function fetchCostState(options?: RequestOptions): Promise<CostState>;
/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export declare function saveCostApiKey(apiKey: string): Promise<OkResponse>;
/** 删除已保存的 API Key。 */
export declare function removeCostApiKey(): Promise<OkResponse>;
/** 更新成本设置（稀疏补丁）。 */
export declare function updateCostSettings(patch: CostSettingsPatch): Promise<OkResponse>;
/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export declare function fetchCostReport(range: {
    from: string;
    to: string;
}, options?: RequestOptions): Promise<CostReportResponse>;
/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export declare function testCostCall(): Promise<CostTestCallResponse>;
/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export declare function fetchCostPricing(options?: RequestOptions): Promise<CostPricingView>;
/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export declare function refreshCostPricing(options?: RequestOptions): Promise<CostPricingView>;
/** `GET /search` 请求参数。 */
export interface SearchRequest {
    readonly query?: string;
    /** YYYY-MM-DD。 */
    readonly from?: string;
    /** YYYY-MM-DD。 */
    readonly to?: string;
    readonly tags?: readonly string[];
    readonly limit?: number;
}
/** 单条检索命中。 */
export interface SearchHit {
    readonly session: SessionRecord;
    readonly snippet?: string;
    readonly tags: readonly string[];
}
/** `GET /search` 响应。 */
export interface SearchResponse {
    readonly hits: readonly SearchHit[];
}
/** `GET /tags?sessionId=` 响应（单个会话的标签）。 */
export interface SessionTagsResponse {
    readonly tags: readonly string[];
}
/** `GET /tags`（缺省 sessionId）响应：标签 → 会话 id 列表的全量映射。 */
export interface AllTagsResponse {
    readonly tags: Readonly<Record<string, readonly string[]>>;
}
/** `POST /tags` 请求体。 */
export interface UpdateTagsRequest {
    readonly sessionId: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
}
/** 跨会话全文检索。 */
export declare function searchSessions(request: SearchRequest): Promise<SearchResponse>;
/** 读取单个会话的标签。 */
export declare function fetchSessionTags(sessionId: string): Promise<SessionTagsResponse>;
/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export declare function fetchAllTags(): Promise<AllTagsResponse>;
/** 为会话增删标签。 */
export declare function updateSessionTags(request: UpdateTagsRequest): Promise<SessionTagsResponse>;
/** 单条语义检索命中（混合排序：BM25 词法 + trigram 向量语义 + RRF 融合）。 */
export interface RetrievalHit {
    readonly session: SessionRecord;
    readonly snippet?: string;
    /** 时序加权后的融合分（两路排名倒数和 × 新近度加成）。 */
    readonly score: number;
    /** BM25 词法排名（1 起；未入候选池时缺省）。 */
    readonly lexicalRank?: number;
    /** 向量语义排名（1 起；未入候选池时缺省）。 */
    readonly semanticRank?: number;
    /** 命中解释（轴线 15：透明账本 + 人话摘要）。 */
    readonly explanation?: RetrievalHitExplanation;
}
/** 单个词法命中项（轴线 15）。 */
export interface RetrievalLexicalHitTerm {
    readonly term: string;
    readonly tf: number;
}
/** 命中解释账本（轴线 15：融合分的四成分分解）。 */
export interface RetrievalHitExplanation {
    readonly lexicalHits: readonly RetrievalLexicalHitTerm[];
    readonly semanticSimilarity: number;
    readonly recencyBoost: number;
    readonly feedbackBoost: number;
    readonly summary: string;
}
/** 查询扩展溯源（轴线 8：拼写纠错 / 语料共现扩展）。 */
export interface RetrievalExpansionNote {
    /** 扩展通道：correction（拼写纠错）或 cooccurrence（语料共现）。 */
    readonly kind: 'correction' | 'cooccurrence';
    /** 触发扩展的原查询词。 */
    readonly from: string;
    /** 被追加的扩展词。 */
    readonly to: string;
}
/** 查询扩展信息（轴线 8；无扩展时缺省）。 */
export interface RetrievalExpansion {
    readonly terms: readonly string[];
    readonly notes: readonly RetrievalExpansionNote[];
}
/** 检索质量四级判定（轴线 10）。 */
export type RetrievalVerdict = 'strong' | 'fair' | 'weak' | 'empty';
/** 检索质量诊断（轴线 10）。 */
export interface RetrievalDiagnostics {
    readonly verdict: RetrievalVerdict;
    readonly topScore: number;
    readonly maxScore: number;
    readonly scoreGap: number;
    readonly lexicalCoverage: number;
    readonly semanticCoverage: number;
    readonly suggestions: readonly string[];
}
/** 反馈学习信息（轴线 11：因历史点击获得加成的会话）。 */
export interface RetrievalFeedback {
    readonly boosted: ReadonlyArray<{
        readonly sessionId: string;
        readonly boost: number;
    }>;
}
/** 多样性重排信息（轴线 12：MMR）。 */
export interface RetrievalDiversity {
    /** 是否实际执行了重排（候选池不足时跳过）。 */
    readonly applied: boolean;
    /** 参与重排的候选池规模。 */
    readonly pool: number;
    /** 相关性/多样性权衡系数 λ。 */
    readonly lambda: number;
}
/** 会话主题簇（轴线 13：知识地图）。 */
export interface RetrievalCluster {
    readonly id: string;
    readonly label: string;
    readonly size: number;
    readonly sessionIds: readonly string[];
    readonly from: number;
    readonly to: number;
    readonly topTerms: readonly string[];
}
/** 零命中救援信息（轴线 16：查询放宽重试的溯源）。 */
export interface RetrievalRescue {
    /** 救援后的实际查询文本。 */
    readonly queryText: string;
    /** 救援动作（纠错替换 / 噪声剔除）。 */
    readonly actions: ReadonlyArray<{
        readonly kind: 'correction' | 'removal';
        readonly from: string;
        readonly to?: string;
    }>;
}
/** `GET /retrieval/search` 响应。 */
export interface RetrievalSearchResponse {
    readonly hits: readonly RetrievalHit[];
    /** 查询扩展溯源（轴线 8；无扩展时缺省）。 */
    readonly expansion?: RetrievalExpansion;
    /** 检索质量诊断（轴线 10；始终返回）。 */
    readonly diagnostics?: RetrievalDiagnostics;
    /** 反馈学习（轴线 11；无加成时缺省）。 */
    readonly feedback?: RetrievalFeedback;
    /** 多样性重排（轴线 12；始终返回）。 */
    readonly diversity?: RetrievalDiversity;
    /** 零命中救援（轴线 16；触发救援且有结果时返回）。 */
    readonly rescue?: RetrievalRescue;
}
/** `GET /retrieval/status` 响应。 */
export interface RetrievalStatusResponse {
    readonly indexed: number;
    readonly lastSyncAt: number | null;
}
/** `POST /retrieval/reindex` 响应。 */
export interface RetrievalReindexResponse {
    readonly ok: true;
    readonly indexed: number;
    readonly updated: number;
    readonly removed: number;
}
/** `POST /retrieval/feedback` 响应（轴线 11）。 */
export interface RetrievalFeedbackResponse {
    readonly ok: true;
    /** 该会话的累计点击次数。 */
    readonly clicks: number;
}
/** `GET /retrieval/clusters` 响应（轴线 13：知识地图）。 */
export interface RetrievalClustersResponse {
    /** 参与聚类的会话总数。 */
    readonly sessions: number;
    readonly clusters: readonly RetrievalCluster[];
}
/** 单条查询建议（轴线 14）。 */
export interface RetrievalSuggestion {
    /** 完整建议查询文本（可直接作为检索输入）。 */
    readonly text: string;
    /** 建议补入的核心词。 */
    readonly term: string;
    /** 建议来源：profile（你点过）/ prefix（语料前缀）/ cooccurrence（共现续写）。 */
    readonly source: 'profile' | 'prefix' | 'cooccurrence';
    /** 建议强度（降序展示）。 */
    readonly score: number;
}
/** `GET /retrieval/suggest` 响应（轴线 14：输入框自动补全）。 */
export interface RetrievalSuggestResponse {
    readonly suggestions: readonly RetrievalSuggestion[];
}
/** 语义检索历史对话（混合排序，本地计算）。from/to 可为毫秒时间戳或 YYYY-MM-DD。 */
export declare function searchRetrieval(request: {
    query: string;
    from?: string;
    to?: string;
    limit?: number;
}, options?: RequestOptions): Promise<RetrievalSearchResponse>;
/** 读取查询建议（轴线 14：语料前缀 + 共现续写 + 点击画像加权）。 */
export declare function fetchRetrievalSuggestions(request: {
    q: string;
}, options?: RequestOptions): Promise<RetrievalSuggestResponse>;
/** 读取语义索引状态（已索引会话数与最近对账时间）。 */
export declare function fetchRetrievalStatus(options?: RequestOptions): Promise<RetrievalStatusResponse>;
/** 记录点击反馈（轴线 11）：查询词并入该会话的点击画像，检索越用越准。 */
export declare function recordRetrievalFeedback(request: {
    query: string;
    sessionId: string;
}, options?: RequestOptions): Promise<RetrievalFeedbackResponse>;
/** 读取知识地图（轴线 13）：全部会话的主题聚类。minSize 过滤簇规模。 */
export declare function fetchRetrievalClusters(request?: {
    minSize?: number;
}, options?: RequestOptions): Promise<RetrievalClustersResponse>;
/** 单个知识盲区（轴线 19）。 */
export interface RetrievalBlindSpot {
    /** 盲区主题词。 */
    readonly anchor: string;
    /** 零命中搜索总次数。 */
    readonly searches: number;
    /** 相关查询原形（去重，最近优先）。 */
    readonly queries: readonly string[];
    /** 最近一次零命中时间。 */
    readonly lastAt: number;
    /** 盲区强度。 */
    readonly score: number;
    /** 一句话建议。 */
    readonly advice: string;
}
/** `GET /retrieval/blindspots` 响应（轴线 19）。 */
export interface RetrievalBlindSpotsResponse {
    /** 零命中日志的去重查询总数。 */
    readonly totalMisses: number;
    /** 按强度降序的盲区列表。 */
    readonly blindSpots: readonly RetrievalBlindSpot[];
    /** 人话摘要。 */
    readonly summary: string;
}
/** 读取知识盲区（轴线 19）：反复搜索但历史无覆盖的主题。 */
export declare function fetchRetrievalBlindSpots(options?: RequestOptions): Promise<RetrievalBlindSpotsResponse>;
/** 单条洞察卡片（轴线 18）。 */
export interface InsightCard {
    /** 洞察分类（intention/review 为认知三轴扩展）。 */
    readonly category: 'blindspot' | 'learning' | 'index' | 'cost' | 'context' | 'topic' | 'intention' | 'review';
    /** 严重度（critical > watch > info 排序）。 */
    readonly severity: 'critical' | 'watch' | 'info';
    /** 洞察正文。 */
    readonly text: string;
    /** 建议动作。 */
    readonly action?: string;
    /** 信号来源标识。 */
    readonly source: string;
}
/** `GET /retrieval/insights` 响应（轴线 18：主动脉搏）。 */
export interface RetrievalInsightsResponse {
    /** 按严重度降序的洞察卡片。 */
    readonly cards: readonly InsightCard[];
    /** 人话摘要。 */
    readonly summary: string;
    /** 合成时间戳。 */
    readonly generatedAt: number;
}
/** 读取主动脉搏（轴线 18）：主动聚合的洞察卡片。 */
export declare function fetchRetrievalInsights(options?: RequestOptions): Promise<RetrievalInsightsResponse>;
/** 实体类型（与服务端 EntityType 对应）。 */
export type KnowledgeEntityType = 'command' | 'path' | 'tech' | 'code' | 'term' | 'version';
/** `GET /knowledge/status` 响应。 */
export interface KnowledgeStatusResponse {
    /** 已分析会话数。 */
    readonly sessions: number;
    /** 实体总数。 */
    readonly entities: number;
    /** 本次对账重分析的会话数。 */
    readonly updated: number;
    /** 本次对账清理的死会话数。 */
    readonly removed: number;
    readonly lastSyncAt: number | null;
}
/** 实体图谱条目（`GET /knowledge/entities` 响应项）。 */
export interface KnowledgeEntitySummary {
    readonly name: string;
    readonly type: KnowledgeEntityType;
    /** 覆盖会话数。 */
    readonly sessionCount: number;
    /** 全部会话累计频次。 */
    readonly totalFreq: number;
    /** 覆盖会话 id 样例（最多 3 个）。 */
    readonly sampleSessions: readonly string[];
}
/** `GET /knowledge/entities` 响应。 */
export interface KnowledgeEntitiesResponse {
    readonly entities: readonly KnowledgeEntitySummary[];
}
/** 单会话实体视图（`GET /knowledge/analyze` 响应项）。 */
export interface KnowledgeSessionEntity {
    readonly name: string;
    readonly type: KnowledgeEntityType;
    /** 会话内频次。 */
    readonly freq: number;
    /** 全局显著性分：freq × 类型权重 × IDF。 */
    readonly score: number;
    /** 覆盖会话数（含本会话）。 */
    readonly globalSessionCount: number;
}
/** `GET /knowledge/analyze` 响应。 */
export interface KnowledgeAnalyzeResponse {
    readonly sessionId: string;
    /** 是否抽取到实体。 */
    readonly analyzed: boolean;
    readonly entities: readonly KnowledgeSessionEntity[];
    /** 建议标签（头部实体名；不自动写入，由用户确认后经 POST /tags 应用）。 */
    readonly suggestedTags: readonly string[];
}
/** 关联会话命中（`GET /knowledge/related` 响应项）。 */
export interface KnowledgeRelatedHit {
    readonly sessionId: string;
    readonly title?: string;
    readonly createdAt: number;
    /** 实体重叠相似度（IDF 加权 + 余弦式归一）。 */
    readonly score: number;
    /** 共享实体（按贡献降序，最多 5 个）。 */
    readonly sharedEntities: ReadonlyArray<{
        readonly name: string;
        readonly type: KnowledgeEntityType;
    }>;
}
/** `GET /knowledge/related` 响应。 */
export interface KnowledgeRelatedResponse {
    readonly sessionId: string;
    readonly related: readonly KnowledgeRelatedHit[];
}
/** `POST /knowledge/reanalyze` 响应。 */
export interface KnowledgeReanalyzeResponse {
    readonly ok: true;
    readonly sessions: number;
    readonly entities: number;
    readonly updated: number;
    readonly removed: number;
}
/** 读取知识索引状态（已分析会话数 / 实体数 / 最近对账时间）。 */
export declare function fetchKnowledgeStatus(options?: RequestOptions): Promise<KnowledgeStatusResponse>;
/** 读取全局实体图谱（按覆盖会话数降序）。 */
export declare function fetchKnowledgeEntities(request?: {
    type?: string;
    limit?: number;
}, options?: RequestOptions): Promise<KnowledgeEntitiesResponse>;
/** 分析单个会话：实体列表 + 建议标签。 */
export declare function analyzeSessionKnowledge(sessionId: string, options?: RequestOptions): Promise<KnowledgeAnalyzeResponse>;
/** 查询与目标会话实体重叠度最高的关联会话。 */
export declare function fetchRelatedSessions(sessionId: string, limit?: number, options?: RequestOptions): Promise<KnowledgeRelatedResponse>;
/** 全量重建知识索引（清空后重分析全部会话）。 */
export declare function reanalyzeKnowledge(options?: RequestOptions): Promise<KnowledgeReanalyzeResponse>;
/** 到期/即将到期的意图（轴线 20：前瞻记忆）。 */
export interface KnowledgeDueIntention {
    readonly sessionId: string;
    /** 意图句原文。 */
    readonly text: string;
    /** 命中的时间标记原形（明天/下周/TODO…）。 */
    readonly marker: string;
    /** 应到期时间（毫秒时间戳）。 */
    readonly dueAt: number;
    /** 超期天数（0 = 刚好到期）。 */
    readonly overdueDays: number;
    readonly createdAt: number;
}
/** 到期复习卡片（轴线 21：间隔重复）。 */
export interface KnowledgeDueReview {
    /** 片段 id（会话ID:片段哈希；评分请求引用该值）。 */
    readonly episodeId: string;
    readonly sessionId: string;
    /** 问题面（卡片正面：先回忆这个）。 */
    readonly problem: string;
    /** 解法面（卡片背面：核对用）。 */
    readonly solution: string;
    readonly dueAt: number;
    readonly overdueDays: number;
    /** 首次复习（true）或已复习过（false）。 */
    readonly fresh: boolean;
    /** 巩固度（0..1，档位进度）。 */
    readonly strength: number;
    readonly createdAt: number;
}
/** 认知统计。 */
export interface KnowledgeCognitionStats {
    /** 持有片段记录的会话数。 */
    readonly sessions: number;
    /** 意图总数。 */
    readonly intentions: number;
    /** 片段总数。 */
    readonly episodes: number;
    /** 已有复习状态的片段数。 */
    readonly reviewStates: number;
}
/** 单条遗忘预测（轴线 23：连续保持率画像）。 */
export interface KnowledgeForgettingForecast {
    readonly episodeId: string;
    readonly sessionId: string;
    /** 问题面。 */
    readonly problem: string;
    /** 解法面。 */
    readonly solution: string;
    /** 当前预测保持率（0..1）。 */
    readonly retention: number;
    /** 记忆稳定性估计（天）。 */
    readonly stabilityDays: number;
    /** 距跌破阈值的剩余天数（负 = 已跌破）。 */
    readonly daysToThreshold: number;
    /** 记忆分区：stable / warning / critical。 */
    readonly zone: 'stable' | 'warning' | 'critical';
    /** 巩固度（0..1）。 */
    readonly strength: number;
    /** 从未复习（true）或已进入复习循环（false）。 */
    readonly fresh: boolean;
    readonly createdAt: number;
}
/** `GET /knowledge/forecast` 响应（轴线 23：全库遗忘预测报告）。 */
export interface KnowledgeForecastResponse {
    readonly now: number;
    /** 预测采用的节律系数（当前值）。 */
    readonly ease: number;
    /** 深度遗忘区样本（新→旧）。 */
    readonly critical: readonly KnowledgeForgettingForecast[];
    /** 滑落区样本（保持率升序：最危险在前）。 */
    readonly warning: readonly KnowledgeForgettingForecast[];
    readonly criticalCount: number;
    readonly warningCount: number;
    readonly stableCount: number;
    readonly summary: string;
}
/** `GET /knowledge/rhythm` 响应（轴线 24：个体记忆节律画像）。 */
export interface KnowledgeRhythmResponse {
    readonly profile: {
        readonly remembered: number;
        readonly forgotten: number;
        /** 节律系数（间隔乘子；1 = 标准曲线）。 */
        readonly ease: number;
        readonly updatedAt: number | null;
    };
    readonly summary: string;
    /** 复习命中率（0..1；零样本为 0）。 */
    readonly hitRate: number;
    readonly targetHitRate: number;
    /** 投影间隔阶梯：标准档位 → 你的档位。 */
    readonly ladder: ReadonlyArray<{
        readonly stage: number;
        readonly baseDays: number;
        readonly adaptedDays: number;
    }>;
}
/** 单条已排程复习（轴线 25：带分诊结论）。 */
export interface KnowledgePlannedReview {
    readonly review: KnowledgeDueReview;
    /** 预测保持率（轴线 23）。 */
    readonly retention: number;
    /** 分诊优先级（越大越先安排）。 */
    readonly priority: number;
    /** 分诊理由（人话）。 */
    readonly reason: string;
}
/** `GET /knowledge/load` 响应（轴线 25：今日负荷计划）。 */
export interface KnowledgeLoadPlan {
    /** 每日容量。 */
    readonly cap: number;
    readonly totalDue: number;
    /** 今日实际安排（按优先级降序，封顶 cap 条）。 */
    readonly today: readonly KnowledgePlannedReview[];
    /** 顺延条数。 */
    readonly deferredCount: number;
    /** 负荷健康度：clear / normal / overload。 */
    readonly health: 'clear' | 'normal' | 'overload';
    readonly summary: string;
}
/** `GET /knowledge/cognition` 响应（认知面板单次拉取：认知三轴 + 元认知三轴）。 */
export interface KnowledgeCognitionResponse {
    readonly intentions: {
        readonly due: readonly KnowledgeDueIntention[];
        readonly upcoming: readonly KnowledgeDueIntention[];
    };
    readonly reviews: readonly KnowledgeDueReview[];
    /** 今日负荷计划（轴线 25；旧服务端可能缺省）。 */
    readonly plan?: KnowledgeLoadPlan;
    /** 遗忘预测报告（轴线 23；旧服务端可能缺省）。 */
    readonly forecast?: KnowledgeForecastResponse;
    /** 记忆节律摘要（轴线 24；旧服务端可能缺省）。 */
    readonly rhythm?: {
        readonly ease: number;
        readonly remembered: number;
        readonly forgotten: number;
        readonly summary: string;
    };
    readonly stats: KnowledgeCognitionStats;
}
/** `GET /knowledge/intentions` 响应（更长的意图清单）。 */
export interface KnowledgeIntentionsResponse {
    readonly due: readonly KnowledgeDueIntention[];
    readonly upcoming: readonly KnowledgeDueIntention[];
}
/** `POST /knowledge/review/grade` 响应。 */
export interface KnowledgeReviewGradeResponse {
    readonly ok: true;
    /** 评分后的间隔档位。 */
    readonly stage: number;
    readonly nextDueAt: number;
    /** 下次复习间隔（天，已含个体节律乘子）。 */
    readonly nextIntervalDays: number;
    /** 评分后更新的节律系数（轴线 24；旧服务端可能缺省）。 */
    readonly ease?: number;
}
/** 单条类比命中（轴线 22）。 */
export interface KnowledgeAnalogyHit {
    readonly episodeId: string;
    readonly sessionId: string;
    readonly title?: string;
    /** 历史问题面。 */
    readonly problem: string;
    /** 历史解法面。 */
    readonly solution: string;
    /** 形状相似度（0..1）。 */
    readonly score: number;
    /** 共享约束类别（同构证据）。 */
    readonly sharedConstraints: readonly string[];
    readonly sharedResolutions: readonly string[];
    /** 跨域类比（true = 主题不同而结构同构——最有价值的命中）。 */
    readonly crossDomain: boolean;
    readonly termOverlap: number;
    readonly createdAt: number;
}
/** `GET /knowledge/analogy?q=` 响应。 */
export interface KnowledgeAnalogyResponse {
    /** 从查询描述提取到的结构标签（溯源）。 */
    readonly queryShape: {
        readonly constraints: readonly string[];
        readonly resolutions: readonly string[];
    };
    readonly analogies: readonly KnowledgeAnalogyHit[];
    readonly summary: string;
}
/** `GET /knowledge/pulse` 响应（轴线 18 的认知信号源）。 */
export interface KnowledgePulseResponse {
    readonly cards: readonly InsightCard[];
    readonly summary: string;
    readonly generatedAt: number;
}
/** 拉取认知总览：到期意图 + 到期复习 + 统计（单次请求驱动整个认知面板）。 */
export declare function fetchKnowledgeCognition(options?: RequestOptions): Promise<KnowledgeCognitionResponse>;
/** 拉取完整意图清单（到期 30 条 + 即将到来 15 条）。 */
export declare function fetchKnowledgeIntentions(options?: RequestOptions): Promise<KnowledgeIntentionsResponse>;
/** 复习评分（轴线 21）：记得升档、忘了归零，返回下次复习间隔。 */
export declare function gradeKnowledgeReview(request: {
    episodeId: string;
    remembered: boolean;
}, options?: RequestOptions): Promise<KnowledgeReviewGradeResponse>;
/** 类比检索（轴线 22）：以当前问题描述找结构同构的历史经验。 */
export declare function searchKnowledgeAnalogy(q: string, options?: RequestOptions): Promise<KnowledgeAnalogyResponse>;
/** 拉取认知脉搏（轴线 18：意图 + 复习 + 片段 + 元认知三类信号）。 */
export declare function fetchKnowledgePulse(options?: RequestOptions): Promise<KnowledgePulseResponse>;
/** 拉取遗忘预测报告（轴线 23：全库记忆保持率体检）。 */
export declare function fetchKnowledgeForecast(options?: RequestOptions): Promise<KnowledgeForecastResponse>;
/** 拉取记忆节律画像（轴线 24：间隔如何随你的表现自适应）。 */
export declare function fetchKnowledgeRhythm(options?: RequestOptions): Promise<KnowledgeRhythmResponse>;
/** 手动触发全量重建语义索引。 */
export declare function reindexRetrieval(options?: RequestOptions): Promise<RetrievalReindexResponse>;
/** 上下文健康等级。 */
export type ContextHealthLevel = 'healthy' | 'watch' | 'advice' | 'critical';
/** `GET /handoff/context-health` 响应（轴线 6：token 估算 + 耗尽预测）。 */
export interface ContextHealthResponse {
    readonly sessionId: string;
    /** 会话事件数（粗略回合规模）。 */
    readonly turns: number;
    /** 会话历史估算 token（启发式：CJK×0.6 + 其余÷4）。 */
    readonly estimatedTokens: number;
    readonly windowTokens: number;
    /** 已用比例（0-1）。 */
    readonly ratio: number;
    /** 近端回合平均 token（增速）。 */
    readonly avgTurnTokens: number;
    /** 预计还可进行的回合数（不足 2 回合时不预测）。 */
    readonly remainingTurns: number | null;
    readonly level: ContextHealthLevel;
    readonly suggestion: string;
}
/** 读取会话的上下文压力评估（token 估算 / 耗尽预测 / 分级建议）。 */
export declare function fetchContextHealth(sessionId: string, options?: RequestOptions): Promise<ContextHealthResponse>;
/** 趋势方向。 */
export type KnowledgeTrendDirection = 'rising' | 'falling' | 'stable';
/** 单实体趋势视图（`GET /knowledge/trends` 响应项）。 */
export interface KnowledgeTrend {
    readonly name: string;
    readonly type: KnowledgeEntityType;
    readonly direction: KnowledgeTrendDirection;
    /** 动量：近窗口 vs 上一窗口的频次变化率。 */
    readonly momentum: number;
    readonly recentSessions: number;
    readonly previousSessions: number;
    readonly recentFreq: number;
    readonly previousFreq: number;
    /** 最近 8 周逐周覆盖会话数（旧 → 新）。 */
    readonly series: readonly number[];
}
/** `GET /knowledge/trends` 响应。 */
export interface KnowledgeTrendsResponse {
    readonly days: number;
    readonly generatedAt: number;
    readonly trends: readonly KnowledgeTrend[];
}
/** 读取主题趋势（近 N 天 vs 上一等长窗口的实体动量）。 */
export declare function fetchKnowledgeTrends(request?: {
    days?: number;
    limit?: number;
}, options?: RequestOptions): Promise<KnowledgeTrendsResponse>;
/** 合成来源（贡献证据的会话视图）。 */
export interface SynthesisSource {
    readonly sessionId: string;
    readonly title?: string;
    readonly createdAt: number;
    /** 证据片段摘录（≤160 字符）。 */
    readonly snippet: string;
}
/** `POST /synthesis/answer` 响应。 */
export interface SynthesisAnswerResponse {
    /** 合成回答（带 [编号] 引用标注）。 */
    readonly answer: string;
    readonly model: string;
    /** 证据来源（按证据分数降序，每会话一条）。 */
    readonly sources: readonly SynthesisSource[];
    /** 知识演化追踪（轴线 17：证据中的跨会话信念变化）。 */
    readonly evolution?: SynthesisEvolution;
    readonly stats: {
        readonly candidates: number;
        readonly chunks: number;
        readonly evidenceChunks: number;
        readonly evidenceChars: number;
    };
}
/** 单条信念演化事件（轴线 17）。 */
export interface SynthesisEvolutionEvent {
    /** 主题锚词。 */
    readonly anchor: string;
    /** upgrade（版本升）/ downgrade（版本降）/ change（数值或不可比变化）。 */
    readonly kind: 'upgrade' | 'downgrade' | 'change';
    readonly from: string;
    readonly to: string;
    readonly fromAt: number;
    readonly toAt: number;
    readonly fromSession: string;
    readonly toSession: string;
}
/** 知识演化报告（轴线 17）。 */
export interface SynthesisEvolution {
    /** 按时间升序的演化事件（最新信念在末尾）。 */
    readonly events: readonly SynthesisEvolutionEvent[];
    /** 人话摘要。 */
    readonly summary: string;
}
/** 深度研究：跨全部历史对话检索并合成带引用来源的回答。 */
export declare function askSynthesis(question: string, options?: RequestOptions): Promise<SynthesisAnswerResponse>;
/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export declare function base64ToBlob(b64: string, mime: string): Blob;
/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export declare function downloadBlob(blob: Blob, fileName: string): void;
/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export declare function openPrintHtml(html: string): void;
