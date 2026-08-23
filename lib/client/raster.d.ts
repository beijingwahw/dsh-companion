/**
 * 客户端光栅导出引擎（能力吸收自 dsh-conv-export，流式重构）：
 * - 分片光栅（tiled rasterization）：整篇对话按片高（A4 页高整数倍）逐片
 *   光栅化，片内经 SVG foreignObject 窗口（translateY 位移）渲染到独立
 *   2x canvas——单 canvas 高度不再是上限，PDF 页数无上限、页界与片界
 *   对齐（页永不跨片），峰值内存恒为「单片」量级；
 * - PNG 长图：流式 PNG 编码器（StreamingPngEncoder）逐片取像素 → 逐行
 *   PNG 过滤（自适应选片级过滤器，跨片行连续性经原始行携带）→
 *   CompressionStream('deflate')（恰为 PNG 规范要求的 zlib 流）增量压缩
 *   → Blob 直下。PNG 规范本身无高度上限，突破旧 16000px 截断；
 * - 免打印 PDF：分片光栅 → 按页切片 → JPEG → 组装最小多页 PDF 下载。
 *
 * 取代旧的 window.print() 回退路径：打印对话框在部分平台（尤其 Windows Chrome）
 * 是窗口模态对话框，会冻结整个浏览器（包括应用标签页）直至关闭；
 * 光栅路径零对话框、零冻结，成品像普通文件一样直接下载。
 *
 * 仅依赖浏览器内置能力（DOM/canvas/CompressionStream），不依赖 cordis 与
 * React，可单测。无 CompressionStream 的环境退回旧的单 canvas 截断路径。
 */
/** 单页 PDF 的图像载荷。 */
interface PdfPage {
    /** JPEG 字节（DCTDecode）。 */
    readonly jpeg: Uint8Array;
    /** 逻辑宽度（CSS px）。 */
    readonly widthPx: number;
    /** 逻辑高度（CSS px）。 */
    readonly heightPx: number;
}
/** 导出进度回调：done 已完成片/页数，total 总数。 */
export type RasterProgress = (done: number, total: number) => void;
/** 导出选项：进度回调与取消信号。 */
export interface RasterExportOptions {
    onProgress?: RasterProgress;
    signal?: AbortSignal;
}
/**
 * 组装最小多页 PDF：每页一张 JPEG（能力吸收自 dsh-conv-export 的 buildPdf）。
 * @param pages 按顺序的页面载荷。
 * @returns PDF 文件字节。
 */
export declare function buildRasterPdf(pages: readonly PdfPage[]): Uint8Array<ArrayBuffer>;
/**
 * 导出为 PNG 长图：分片光栅 + 流式 PNG 编码 → 单张纵向长图下载。
 * PNG 规范无高度上限，超长对话不再被截断（产品上限见 MAX_TOTAL_CSS_HEIGHT）。
 * 无 CompressionStream 的环境退回旧的单 canvas 截断路径。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化/编码时抛出；取消信号触发 AbortError。
 */
export declare function exportLongPng(html: string, fileName: string, options?: RasterExportOptions): Promise<void>;
/**
 * 导出为免打印多页 PDF：分片光栅 → 按页切片 → JPEG → 自包含 PDF 下载。
 * 片高为页高整数倍，页界与片界对齐（页永不跨片）；页数无上限。
 * 全程无打印对话框，应用标签页永不冻结。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出；取消信号触发 AbortError。
 */
export declare function exportRasterPdf(html: string, fileName: string, options?: RasterExportOptions): Promise<void>;
export {};
