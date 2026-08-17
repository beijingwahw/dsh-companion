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
/** 导出单个会话。 */
export function runExport(request, options) {
    return companionPost('/export/run', request, options);
}
/** 批量导出多个会话为 ZIP。 */
export function runExportBatch(request, options) {
    return companionPost('/export/batch', request, options);
}
/** 为指定会话生成交接摘要。 */
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
