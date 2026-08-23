/**
 * 模块 A 导出服务函数：HTTP 端点与命令面板共用（DESIGN.md 第 5 节纪律）。
 *
 * 管线：sessionQuery.readSession → transcriptFromLog →（可选）按选中回合下标过滤 →
 * （可选）逐轮 redactText 脱敏 → 按格式渲染（markdown / json / pdf / png）。
 *
 * 回合级选择导出（能力吸收自 dsh-conv-export）：GET /export/turns 提供回合
 * 预览列表（角色 + 折叠截断纯文本），POST /export/run 携带 turns 下标数组
 * 仅导出选中回合（如剔除失败的尝试或跑题的段落）。
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
import { type TranscriptTurn } from '../../core/transcript.js';
import type { SessionQueryEngine, SessionId } from '../../types/harness.js';
/** 导出格式。 */
export type ExportFormat = 'markdown' | 'pdf' | 'json' | 'png';
/** 单次导出选项。 */
export interface ExportOptions {
    /** 目标格式。 */
    format: ExportFormat;
    /** 转录是否附带北京时间时间戳（缺省 true）。 */
    timestamps?: boolean;
    /** 导出前是否对每轮文本执行隐私脱敏（缺省 false）。 */
    redact?: boolean;
    /**
     * 调用方是否具备客户端光栅能力（浏览器 canvas，缺省 false）。
     * true：PNG 长图与含非 Latin-1 字符的 PDF 返回 kind:'raster' 载荷，
     * 由客户端光栅化，全程无打印对话框；
     * false（命令面板等无 canvas 环境）：PNG 不支持（HttpError 400），
     * 含非 Latin-1 字符的 PDF 退回 kind:'print' 打印页。
     */
    raster?: boolean;
    /**
     * 仅导出选中的回合（回合在 GET /export/turns 列表中的下标，0 起）。
     * 缺省/undefined = 导出全部回合；越界下标静默忽略
     * （append-only 日志下旧回合下标稳定，宽容处理列表与导出间的漂移）；
     * 过滤后无可导出回合时抛 400。
     */
    turns?: readonly number[];
}
/** 文件类导出载荷：字节内容一律 base64（DESIGN.md 第 4 节）。 */
export interface ExportFilePayload {
    kind: 'file';
    fileName: string;
    mimeType: string;
    contentBase64: string;
}
/** 打印类导出载荷：无光栅能力时 PDF 含非 Latin-1 字符的浏览器打印回退。 */
export interface ExportPrintPayload {
    kind: 'print';
    fileName: string;
    html: string;
}
/**
 * 光栅类导出载荷：客户端以 canvas 将打印 HTML 光栅化为成品
 * （PNG 长图或免打印多页 PDF），全程无 window.print() 对话框。
 */
export interface ExportRasterPayload {
    kind: 'raster';
    /** 目标成品：png=长图，pdf=免打印多页 PDF。 */
    target: 'png' | 'pdf';
    fileName: string;
    html: string;
}
/** 导出载荷联合（POST /export/run 的响应形状）。 */
export type ExportPayload = ExportFilePayload | ExportPrintPayload | ExportRasterPayload;
/** 批量导出会话数上限（去重后计数）。 */
export declare const MAX_BATCH_SESSIONS = 100;
/** 回合预览长度上限（折叠空白后的字符数；吸收自 dsh-conv-export 的面板预览）。 */
export declare const TURN_PREVIEW_CHARS = 160;
/** 回合选择面板的单回合预览（GET /export/turns 响应项）。 */
export interface ExportTurnSummary {
    /** 回合在列表中的下标（0 起），导出请求的 turns 数组引用该值。 */
    index: number;
    role: TranscriptTurn['role'];
    /** 回合事件时间（毫秒时间戳）。 */
    time: number;
    /** 折叠空白后截断的纯文本预览（仅面板展示用，不参与导出内容）。 */
    preview: string;
}
/** GET /export/turns 响应形状。 */
export interface ExportTurnsPayload {
    turns: readonly ExportTurnSummary[];
}
/**
 * 单会话读取失败（会话不存在等）：批量导出时可跳过，
 * 其余条目照常入包；HTTP 语义为 404。
 * 与之相对，非本类型的错误视为系统性错误（存储介质/渲染管线等），
 * 批量导出不再吞掉，直接上抛（HTTP 层收敛为 500）。
 */
export declare class SessionReadError extends HttpError {
    constructor(sessionId: string);
}
/**
 * 导出单个会话（供 HTTP 与命令复用）。
 * @param sessionQuery Harness 会话查询服务（对 ctx 的唯一依赖）。
 * @param sessionId 目标会话品牌 id。
 * @param options 格式与开关（timestamps 缺省 true，redact 缺省 false）。
 * @returns DESIGN.md 第 4 节规定的响应形状。
 */
export declare function buildSingleExport(sessionQuery: SessionQueryEngine, sessionId: SessionId, options: ExportOptions): Promise<ExportPayload>;
/**
 * 批量导出多个会话并打包为 ZIP（PDF 非 Latin-1 的条目以 .html 入包）。
 * @param sessionQuery Harness 会话查询服务。
 * @param sessionIds 会话 id 列表：先经 Set 去重，去重后数量不得超过
 * MAX_BATCH_SESSIONS；单个会话读取失败（SessionReadError）会被跳过，
 * 系统性错误（存储介质/渲染管线等）则上抛，不再无差别吞掉。
 * @param options 格式与开关（统一作用于全部会话）。
 * @returns ZIP 文件载荷，文件名含打包当日北京日期。
 */
export declare function buildBatchExport(sessionQuery: SessionQueryEngine, sessionIds: readonly SessionId[], options: ExportOptions): Promise<ExportFilePayload>;
/**
 * 列出会话的回合预览（回合选择面板数据源，吸收自 dsh-conv-export）。
 *
 * 下标语义：与 transcriptFromLog 的输出顺序一致（按 seq 稳定排序），
 * append-only 日志下旧回合下标不漂移；新回合只追加在列表末尾。
 */
export declare function listTurns(sessionQuery: SessionQueryEngine, sessionId: SessionId): Promise<ExportTurnsPayload>;
/**
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装，避免泄漏内部细节。
 */
export declare function toSafeHttpError(error: unknown, fallbackMessage: string): HttpError;
/** 提取命令面板可用的用户可读错误文本（不泄漏内部细节）。 */
export declare function userFacingMessage(error: unknown, fallbackMessage: string): string;
