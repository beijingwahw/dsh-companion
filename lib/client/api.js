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
const API_PREFIX = '/companion';
/** API 层统一抛出的错误：携带 HTTP 状态码与服务端错误文案。 */
export class CompanionApiError extends Error {
    /** HTTP 状态码。 */
    status;
    constructor(status, message) {
        super(message);
        this.name = 'CompanionApiError';
        this.status = status;
    }
}
/** 缺省请求超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** fetch 网络层不可达时的统一错误文案。 */
const NETWORK_UNREACHABLE_MESSAGE = '无法连接 Companion 服务，请确认 Harness 已启动且插件已加载';
/**
 * 带超时与外部取消联动的 fetch 封装：
 * - 内部持有 AbortController，超时（setTimeout）与外部 signal 都中止同一控制器；
 * - 外部 signal 先中止时透传其中止原因；请求结束后清理定时器与事件监听；
 * - fetch 网络层失败（TypeError）统一包装为 CompanionApiError(0, …)，
 *   中止（AbortError 等）与其他错误原样抛出。
 */
async function fetchWithGuard(url, init, options) {
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    const externalSignal = options?.signal;
    const onExternalAbort = () => {
        controller.abort(externalSignal?.reason);
    };
    if (externalSignal) {
        if (externalSignal.aborted) {
            onExternalAbort();
        }
        else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    catch (error) {
        if (error instanceof TypeError) {
            throw new CompanionApiError(0, NETWORK_UNREACHABLE_MESSAGE);
        }
        throw error;
    }
    finally {
        window.clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}
/** 收窄服务端错误体：契约规定非 2xx 一律携带 `{ error: string }`。 */
function extractErrorMessage(payload, status) {
    if (typeof payload === 'object' && payload !== null) {
        const error = payload.error;
        if (typeof error === 'string' && error.length > 0)
            return error;
    }
    return `请求失败（HTTP ${status}）`;
}
/** 统一响应解析：非 2xx 读取 `{ error }` 并抛错；成功则解析 JSON。 */
async function parseResponse(response) {
    const text = await response.text();
    let payload;
    try {
        payload = text.length > 0 ? JSON.parse(text) : {};
    }
    catch {
        throw new CompanionApiError(response.status, `服务端响应不是合法 JSON（HTTP ${response.status}）`);
    }
    if (!response.ok) {
        throw new CompanionApiError(response.status, extractErrorMessage(payload, response.status));
    }
    return payload;
}
function buildQuery(params) {
    if (!params)
        return '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '')
            continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text.length > 0 ? `?${text}` : '';
}
/** 类型化 GET 封装。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionGet(path, params, options) {
    const response = await fetchWithGuard(`${API_PREFIX}${path}${buildQuery(params)}`, {}, options);
    return parseResponse(response);
}
/** 类型化 POST 封装（JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionPost(path, body, options) {
    const response = await fetchWithGuard(`${API_PREFIX}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }, options);
    return parseResponse(response);
}
/** 类型化 DELETE 封装（契约允许 DELETE 携带 JSON 请求体）。options 可选：外部取消信号与超时（缺省 30s）。 */
export async function companionDelete(path, body, options) {
    const hasBody = body !== undefined;
    const response = await fetchWithGuard(`${API_PREFIX}${path}`, {
        method: 'DELETE',
        headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
    }, options);
    return parseResponse(response);
}
/** 列出可导出的会话。 */
export function fetchExportSessions(options) {
    return companionGet('/export/sessions', undefined, options);
}
/** 列出会话的回合预览（回合选择面板数据源）。 */
export function fetchExportTurns(sessionId, options) {
    return companionGet('/export/turns', { sessionId }, options);
}
/** 导出单个会话。 */
export function runExport(request, options) {
    return companionPost('/export/run', request, options);
}
/** 批量导出多个会话为 ZIP。 */
export function runExportBatch(request, options) {
    return companionPost('/export/batch', request, options);
}
/** 为指定会话生成交接摘要；focus 为可选查询聚焦主题（轴线 2）。 */
export function generateHandoff(request, options) {
    return companionPost('/handoff/generate', request, options);
}
/** 列出全部交接摘要模板。 */
export function fetchHandoffTemplates(options) {
    return companionGet('/handoff/templates', undefined, options);
}
/** 保存（覆盖）一个模板。 */
export function saveHandoffTemplate(request) {
    return companionPost('/handoff/templates', request);
}
/** 删除一个模板。 */
export function deleteHandoffTemplate(name) {
    return companionDelete('/handoff/templates', { name });
}
/** 导入摘要：带 sessionId 注入指定会话，不带则武装给下一个新对话。 */
export function importHandoff(request) {
    return companionPost('/handoff/import', request);
}
/** 查询当前已武装的交接摘要。 */
export function fetchArmedHandoffs(options) {
    return companionGet('/handoff/armed', undefined, options);
}
/** 移除已武装的交接摘要。 */
export function dismissArmedHandoff(request) {
    return companionDelete('/handoff/armed', request);
}
/** 查询会话的上下文血缘（祖先 = 内容流入方，后代 = 内容流向方）。 */
export function fetchHandoffLineage(sessionId, options) {
    return companionGet('/handoff/lineage', { sessionId }, options);
}
/** 读取成本状态（保险库不回传 Key 明文，只有 apiKeyConfigured 布尔）。 */
export function fetchCostState(options) {
    return companionGet('/cost/state', undefined, options);
}
/** 保存 API Key（服务端 AES-256-GCM 加密落盘）。 */
export function saveCostApiKey(apiKey) {
    return companionPost('/cost/api-key', { apiKey });
}
/** 删除已保存的 API Key。 */
export function removeCostApiKey() {
    return companionDelete('/cost/api-key');
}
/** 更新成本设置（稀疏补丁）。 */
export function updateCostSettings(patch) {
    return companionPost('/cost/settings', patch);
}
/** 读取 [from, to]（YYYY-MM-DD，北京时间）区间的成本报表。 */
export function fetchCostReport(range, options) {
    return companionGet('/cost/report', { from: range.from, to: range.to }, options);
}
/** 用当前 Key 发起一次最小测试调用，验证连通性。 */
export function testCostCall() {
    return companionPost('/cost/test-call');
}
/** 读取动态计价引擎面板数据（各厂商官方定价、峰谷计划、用户覆盖）。 */
export function fetchCostPricing(options) {
    return companionGet('/cost/pricing', undefined, options);
}
/** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。 */
export function refreshCostPricing(options) {
    return companionPost('/cost/pricing/refresh', undefined, options);
}
/** 跨会话全文检索。 */
export function searchSessions(request) {
    return companionGet('/search', {
        query: request.query,
        from: request.from,
        to: request.to,
        tags: request.tags && request.tags.length > 0 ? request.tags.join(',') : undefined,
        limit: request.limit,
    });
}
/** 读取单个会话的标签。 */
export function fetchSessionTags(sessionId) {
    return companionGet('/tags', { sessionId });
}
/** 读取全量标签映射（标签 → 会话 id 列表）。 */
export function fetchAllTags() {
    return companionGet('/tags');
}
/** 为会话增删标签。 */
export function updateSessionTags(request) {
    return companionPost('/tags', request);
}
/** 语义检索历史对话（混合排序，本地计算）。from/to 可为毫秒时间戳或 YYYY-MM-DD。 */
export function searchRetrieval(request, options) {
    return companionGet('/retrieval/search', {
        query: request.query,
        from: request.from,
        to: request.to,
        limit: request.limit,
    }, options);
}
/** 读取查询建议（轴线 14：语料前缀 + 共现续写 + 点击画像加权）。 */
export function fetchRetrievalSuggestions(request, options) {
    return companionGet('/retrieval/suggest', { q: request.q }, options);
}
/** 读取语义索引状态（已索引会话数与最近对账时间）。 */
export function fetchRetrievalStatus(options) {
    return companionGet('/retrieval/status', undefined, options);
}
/** 记录点击反馈（轴线 11）：查询词并入该会话的点击画像，检索越用越准。 */
export function recordRetrievalFeedback(request, options) {
    return companionPost('/retrieval/feedback', request, options);
}
/** 读取知识地图（轴线 13）：全部会话的主题聚类。minSize 过滤簇规模。 */
export function fetchRetrievalClusters(request, options) {
    return companionGet('/retrieval/clusters', { minSize: request?.minSize }, options);
}
/** 读取知识盲区（轴线 19）：反复搜索但历史无覆盖的主题。 */
export function fetchRetrievalBlindSpots(options) {
    return companionGet('/retrieval/blindspots', undefined, options);
}
/** 读取主动脉搏（轴线 18）：主动聚合的洞察卡片。 */
export function fetchRetrievalInsights(options) {
    return companionGet('/retrieval/insights', undefined, options);
}
/** 读取知识索引状态（已分析会话数 / 实体数 / 最近对账时间）。 */
export function fetchKnowledgeStatus(options) {
    return companionGet('/knowledge/status', undefined, options);
}
/** 读取全局实体图谱（按覆盖会话数降序）。 */
export function fetchKnowledgeEntities(request = {}, options) {
    return companionGet('/knowledge/entities', {
        type: request.type,
        limit: request.limit,
    }, options);
}
/** 分析单个会话：实体列表 + 建议标签。 */
export function analyzeSessionKnowledge(sessionId, options) {
    return companionGet('/knowledge/analyze', { sessionId }, options);
}
/** 查询与目标会话实体重叠度最高的关联会话。 */
export function fetchRelatedSessions(sessionId, limit, options) {
    return companionGet('/knowledge/related', {
        sessionId,
        limit,
    }, options);
}
/** 全量重建知识索引（清空后重分析全部会话）。 */
export function reanalyzeKnowledge(options) {
    return companionPost('/knowledge/reanalyze', undefined, options);
}
/** 拉取认知总览：到期意图 + 到期复习 + 统计（单次请求驱动整个认知面板）。 */
export function fetchKnowledgeCognition(options) {
    return companionGet('/knowledge/cognition', undefined, options);
}
/** 拉取完整意图清单（到期 30 条 + 即将到来 15 条）。 */
export function fetchKnowledgeIntentions(options) {
    return companionGet('/knowledge/intentions', undefined, options);
}
/** 复习评分（轴线 21）：记得升档、忘了归零，返回下次复习间隔。 */
export function gradeKnowledgeReview(request, options) {
    return companionPost('/knowledge/review/grade', request, options);
}
/** 类比检索（轴线 22）：以当前问题描述找结构同构的历史经验。 */
export function searchKnowledgeAnalogy(q, options) {
    return companionGet('/knowledge/analogy', { q }, options);
}
/** 拉取认知脉搏（轴线 18：意图 + 复习 + 片段 + 元认知三类信号）。 */
export function fetchKnowledgePulse(options) {
    return companionGet('/knowledge/pulse', undefined, options);
}
/** 拉取遗忘预测报告（轴线 23：全库记忆保持率体检）。 */
export function fetchKnowledgeForecast(options) {
    return companionGet('/knowledge/forecast', undefined, options);
}
/** 拉取记忆节律画像（轴线 24：间隔如何随你的表现自适应）。 */
export function fetchKnowledgeRhythm(options) {
    return companionGet('/knowledge/rhythm', undefined, options);
}
/** 手动触发全量重建语义索引。 */
export function reindexRetrieval(options) {
    return companionPost('/retrieval/reindex', undefined, options);
}
/** 读取会话的上下文压力评估（token 估算 / 耗尽预测 / 分级建议）。 */
export function fetchContextHealth(sessionId, options) {
    return companionGet('/handoff/context-health', { sessionId }, options);
}
/** 读取主题趋势（近 N 天 vs 上一等长窗口的实体动量）。 */
export function fetchKnowledgeTrends(request = {}, options) {
    return companionGet('/knowledge/trends', {
        days: request.days,
        limit: request.limit,
    }, options);
}
/** 深度研究：跨全部历史对话检索并合成带引用来源的回答。 */
export function askSynthesis(question, options) {
    return companionPost('/synthesis/answer', { question }, options);
}
// ---------------------------------------------------------------------------
// 浏览器工具：base64 解码、下载、打印
// ---------------------------------------------------------------------------
/** 将 base64 字符串解码为 Blob（二进制安全，不经 atob→字符串 的 Latin-1 陷阱）。 */
export function base64ToBlob(b64, mime) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}
/** 通过 objectURL + `<a download>` 触发浏览器下载。 */
export function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 延迟释放，确保下载已启动
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
/** 在新窗口写入完整 HTML 并触发浏览器打印（用于 PDF 含非 Latin-1 内容的降级路径）。 */
export function openPrintHtml(html) {
    const win = window.open('', '_blank');
    if (!win) {
        throw new CompanionApiError(0, '浏览器拦截了弹出窗口，请允许弹窗后重试打印导出');
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    // 留出少量渲染时间再唤起打印对话框；若窗口在此期间被关闭则跳过打印
    window.setTimeout(() => {
        if (!win.closed)
            win.print();
    }, 250);
}
