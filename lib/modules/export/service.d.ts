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
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装，避免泄漏内部细节。
 */
export declare function toSafeHttpError(error: unknown, fallbackMessage: string): HttpError;
/** 提取命令面板可用的用户可读错误文本（不泄漏内部细节）。 */
export declare function userFacingMessage(error: unknown, fallbackMessage: string): string;
