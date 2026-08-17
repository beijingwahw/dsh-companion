/**
 * 模块 A 导出服务函数：HTTP 端点与命令面板共用（DESIGN.md 第 5 节纪律）。
 *
 * 管线：sessionQuery.readSession → transcriptFromLog →（可选）逐轮 redactText 脱敏 →
 * 按格式渲染（markdown / json / pdf / png）。
 *
 * PDF/PNG 光栅路径（能力吸收自 dsh-conv-export）：
 * - PDF 全文 Latin-1 安全时直接生成结构化 PDF（kind:'file'）；
 * - 调用方具备客户端光栅能力（raster=true，浏览器 canvas）时：
 *   PNG 长图与含非 Latin-1 字符的 PDF 一律返回 kind:'raster' 载荷，
 *   由客户端光栅化为 PNG / 免打印多页 PDF，全程无 window.print() 对话框；
 * - 无光栅能力（命令面板）时：含非 Latin-1 字符的 PDF 退回打印友好 HTML
 *   路径（kind:'print'），PNG 不支持（HttpError 400）。
 * 响应形状严格对应 DESIGN.md 第 4 节：kind:'file'（base64）、kind:'print'（html）
 * 或 kind:'raster'（html + target）。
 */
import { HttpError } from '../../core/http.js';
import { buildPrintHtml, buildSimplePdf, escapeHtml, isLatin1Safe } from '../../core/pdf.js';
import { redactText } from '../../core/privacy.js';
import { beijingDayKey, formatBeijingTime } from '../../core/time.js';
import { transcriptFromLog, transcriptToJson, transcriptToMarkdown, } from '../../core/transcript.js';
import { buildZip, sanitizeFileName } from '../../core/zip.js';
/** 批量导出会话数上限（去重后计数）。 */
export const MAX_BATCH_SESSIONS = 100;
/**
 * 单会话读取失败（会话不存在等）：批量导出时可跳过，
 * 其余条目照常入包；HTTP 语义为 404。
 * 与之相对，非本类型的错误视为系统性错误（存储介质/渲染管线等），
 * 批量导出不再吞掉，直接上抛（HTTP 层收敛为 500）。
 */
export class SessionReadError extends HttpError {
    constructor(sessionId) {
        super(`会话不存在或读取失败：${sessionId}`, 404);
        this.name = 'SessionReadError';
    }
}
/** 文本编码器（导出字节统一 UTF-8）。 */
const encoder = new TextEncoder();
/**
 * 导出单个会话（供 HTTP 与命令复用）。
 * @param sessionQuery Harness 会话查询服务（对 ctx 的唯一依赖）。
 * @param sessionId 目标会话品牌 id。
 * @param options 格式与开关（timestamps 缺省 true，redact 缺省 false）。
 * @returns DESIGN.md 第 4 节规定的响应形状。
 */
export async function buildSingleExport(sessionQuery, sessionId, options) {
    const built = await buildExport(sessionQuery, sessionId, options);
    if (built.kind === 'print') {
        return { kind: 'print', fileName: built.fileName, html: built.html };
    }
    if (built.kind === 'raster') {
        return { kind: 'raster', target: built.target, fileName: built.fileName, html: built.html };
    }
    return {
        kind: 'file',
        fileName: built.fileName,
        mimeType: built.mimeType,
        contentBase64: toBase64(built.bytes),
    };
}
/**
 * 批量导出多个会话并打包为 ZIP（PDF 非 Latin-1 的条目以 .html 入包）。
 * @param sessionQuery Harness 会话查询服务。
 * @param sessionIds 会话 id 列表：先经 Set 去重，去重后数量不得超过
 * MAX_BATCH_SESSIONS；单个会话读取失败（SessionReadError）会被跳过，
 * 系统性错误（存储介质/渲染管线等）则上抛，不再无差别吞掉。
 * @param options 格式与开关（统一作用于全部会话）。
 * @returns ZIP 文件载荷，文件名含打包当日北京日期。
 */
export async function buildBatchExport(sessionQuery, sessionIds, options) {
    if (sessionIds.length === 0)
        throw new HttpError('sessionIds 不能为空', 400);
    if (options.format === 'png') {
        throw new HttpError('PNG 长图需客户端逐张光栅化，不支持批量 ZIP 导出', 400);
    }
    // 去重：避免同一会话被重复导出打包。
    const uniqueIds = [...new Set(sessionIds)];
    if (uniqueIds.length > MAX_BATCH_SESSIONS) {
        throw new HttpError(`批量导出一次最多支持 ${MAX_BATCH_SESSIONS} 个会话`, 400);
    }
    // 批量打包在服务端完成：强制关闭客户端光栅（非 Latin-1 PDF 以 .html 入包）。
    const batchOptions = { ...options, raster: false };
    const entries = [];
    const usedNames = new Set();
    for (const sessionId of uniqueIds) {
        let built;
        try {
            built = await buildExport(sessionQuery, sessionId, batchOptions);
        }
        catch (error) {
            // 单会话读取失败：跳过，其余照常入包；
            // 其余错误视为系统性错误，上抛由 HTTP 层收敛为 500。
            if (error instanceof SessionReadError)
                continue;
            throw error;
        }
        const name = uniqueEntryName(usedNames, built.fileName);
        // 批量打包强制 raster:false，产物只会是 file 或 print（print 以 .html 入包）。
        const data = built.kind === 'file' ? built.bytes : encoder.encode(built.html);
        entries.push({ name, data });
    }
    if (entries.length === 0)
        throw new HttpError('没有可导出的会话', 404);
    return {
        kind: 'file',
        fileName: `deepseek-conversations-${beijingDayKey(Date.now())}.zip`,
        mimeType: 'application/zip',
        contentBase64: toBase64(buildZip(entries)),
    };
}
/**
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装，避免泄漏内部细节。
 */
export function toSafeHttpError(error, fallbackMessage) {
    if (error instanceof HttpError)
        return error;
    return new HttpError(fallbackMessage, 500);
}
/** 提取命令面板可用的用户可读错误文本（不泄漏内部细节）。 */
export function userFacingMessage(error, fallbackMessage) {
    if (error instanceof HttpError)
        return error.message;
    return fallbackMessage;
}
/** 读取会话并渲染为导出中间产物。 */
async function buildExport(sessionQuery, sessionId, options) {
    let snapshot;
    try {
        snapshot = await sessionQuery.readSession(sessionId);
    }
    catch {
        // 归类为单会话读取失败（批量导出可跳过）；
        // 渲染/打包阶段的错误不经此包装，将以系统性错误上抛。
        throw new SessionReadError(sessionId);
    }
    const timestamps = options.timestamps ?? true;
    const session = snapshot.session;
    const title = session.title || session.id;
    let turns = transcriptFromLog(snapshot);
    if (options.redact ?? false) {
        turns = turns.map((turn) => ({ ...turn, text: redactText(turn.text).text }));
    }
    const baseName = sanitizeFileName(title);
    if (options.format === 'markdown') {
        return {
            kind: 'file',
            fileName: `${baseName}.md`,
            mimeType: 'text/markdown; charset=utf-8',
            bytes: encoder.encode(transcriptToMarkdown(session, turns, { timestamps })),
        };
    }
    if (options.format === 'json') {
        return {
            kind: 'file',
            fileName: `${baseName}.json`,
            mimeType: 'application/json; charset=utf-8',
            bytes: encoder.encode(transcriptToJson(session, turns, { timestamps })),
        };
    }
    // PNG 长图：服务端无 canvas，必须由客户端光栅化（raster=true）。
    if (options.format === 'png') {
        if (!(options.raster ?? false)) {
            throw new HttpError('PNG 长图导出需要客户端界面（浏览器 canvas），命令面板暂不支持', 400);
        }
        return {
            kind: 'raster',
            target: 'png',
            fileName: `${baseName}.png`,
            html: buildPrintHtml(title, buildPrintBody(session, turns, timestamps)),
        };
    }
    // PDF：全文（标题 + 正文行）可 Latin-1 编码时直接生成 PDF，否则走光栅/打印 HTML。
    const lines = buildPdfLines(turns, timestamps);
    if (isLatin1Safe([title, ...lines].join('\n'))) {
        return {
            kind: 'file',
            fileName: `${baseName}.pdf`,
            mimeType: 'application/pdf',
            bytes: buildSimplePdf(title, lines),
        };
    }
    const html = buildPrintHtml(title, buildPrintBody(session, turns, timestamps));
    // 有客户端光栅能力：返回 raster 载荷，客户端生成免打印多页 PDF（无 window.print() 冻结）。
    if (options.raster ?? false) {
        return { kind: 'raster', target: 'pdf', fileName: `${baseName}.pdf`, html };
    }
    return { kind: 'print', fileName: `${baseName}.html`, html };
}
/** 说话人展示名。 */
function speakerLabel(role) {
    if (role === 'user')
        return '用户';
    if (role === 'assistant')
        return '助手';
    return role;
}
/**
 * PDF 正文行的说话人标签（ASCII）。
 * buildSimplePdf 只能编码 Latin-1，该快路径仅在全文 Latin-1 安全时启用，
 * 用 ASCII 标签保证纯英文对话能真正走直出 PDF，而不是被中文标签误判
 * 为不可编码、永远退回打印/光栅路径。
 */
function pdfSpeakerLabel(role) {
    if (role === 'user')
        return 'User';
    if (role === 'assistant')
        return 'Assistant';
    return role;
}
/**
 * PDF 正文行（标题由 buildSimplePdf 单独渲染，不含在内）。
 * 时间戳使用 ASCII 括号，避免 Latin-1 安全的全角字符把纯英文对话误判为不可编码。
 */
function buildPdfLines(turns, timestamps) {
    const lines = [];
    for (const turn of turns) {
        const stamp = timestamps ? ` (${formatBeijingTime(turn.time)})` : '';
        lines.push(`${pdfSpeakerLabel(turn.role)}${stamp}`, '');
        lines.push(...turn.text.split('\n'));
        lines.push('');
    }
    return lines;
}
/** 打印友好页的正文 HTML（全部经转义，元信息头与 Markdown 导出对齐）。 */
function buildPrintBody(session, turns, timestamps) {
    const meta = [
        `会话 ID：${session.id}`,
        `创建时间：${formatBeijingTime(session.createdAt)}`,
        `导出时间：${formatBeijingTime(Date.now())}`,
        `消息轮次：${turns.length}`,
    ]
        .map((item) => escapeHtml(item))
        .join(' · ');
    const parts = [
        `<h1>${escapeHtml(session.title || '未命名对话')}</h1>`,
        `<p class="meta">${meta}</p>`,
    ];
    for (const turn of turns) {
        const stamp = timestamps ? `（${formatBeijingTime(turn.time)}）` : '';
        parts.push(`<h3>${escapeHtml(`${speakerLabel(turn.role)}${stamp}`)}</h3>`);
        parts.push(`<pre>${escapeHtml(turn.text)}</pre>`);
    }
    return parts.join('\n');
}
/** 字节内容 base64 编码（HTTP 响应中字节一律 base64）。 */
function toBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}
/** ZIP 条目名去重：重名时在扩展名前插入 -2/-3… 序号，防止覆盖。 */
function uniqueEntryName(used, name) {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let suffix = 2;; suffix += 1) {
        const candidate = `${stem}-${suffix}${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}
