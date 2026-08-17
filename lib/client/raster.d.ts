/**
 * 客户端光栅导出引擎（能力吸收自 dsh-conv-export）：
 * - PNG 长图：将服务端打印 HTML 离屏渲染 → SVG foreignObject 光栅化 → 2x canvas → PNG 下载；
 * - 免打印 PDF：一次光栅化 → 按 A4 页高切片 → JPEG 编码 → 组装最小多页 PDF 下载。
 *
 * 取代旧的 window.print() 回退路径：打印对话框在部分平台（尤其 Windows Chrome）
 * 是窗口模态对话框，会冻结整个浏览器（包括应用标签页）直至关闭；
 * 光栅路径零对话框、零冻结，成品像普通文件一样直接下载。
 *
 * 仅依赖浏览器内置能力（DOM/canvas），不依赖 cordis 与 React，可单测。
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
/**
 * 组装最小多页 PDF：每页一张 JPEG（能力吸收自 dsh-conv-export 的 buildPdf）。
 * @param pages 按顺序的页面载荷。
 * @returns PDF 文件字节。
 */
export declare function buildRasterPdf(pages: readonly PdfPage[]): Uint8Array<ArrayBuffer>;
/**
 * 导出为 PNG 长图：光栅化整篇对话并下载一张纵向长图。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出（无 canvas / SVG 解析失败）。
 */
export declare function exportLongPng(html: string, fileName: string): Promise<void>;
/**
 * 导出为免打印多页 PDF：光栅化对话 → 按页高切片 → JPEG → 自包含 PDF 下载。
 * 全程无打印对话框，应用标签页永不冻结。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出。
 */
export declare function exportRasterPdf(html: string, fileName: string): Promise<void>;
export {};
