/**
 * PDF 导出：
 * - 内容可被 Latin-1 编码时，直接生成结构化 PDF（内置 Helvetica，无外部依赖）；
 * - 含 CJK 等宽字符时，内置字体无法嵌入，退回“打印友好 HTML”路径，
 *   由浏览器打印管线另存为 PDF（见 README「已知限制」）。
 */
/**
 * 文本是否全部可由 Latin-1 编码（决定走 PDF 还是打印路径）。
 * 0x80–0x9F 区间视为不安全：内置字体使用 WinAnsiEncoding，
 * 该区间对应 C1 控制字符（存在未映射空洞），直接输出会产生乱码。
 */
export declare function isLatin1Safe(text: string): boolean;
/**
 * 生成简单文本 PDF（A4，Helvetica）。
 * @param title 文档标题（渲染于首页顶部）。
 * @param lines 正文行（调用方无需预分页）。
 * @returns PDF 字节流。
 */
export declare function buildSimplePdf(title: string, lines: readonly string[]): Uint8Array;
/**
 * 生成打印友好的 HTML（CJK 导出走浏览器打印 → 另存为 PDF）。
 * @param title 文档标题。
 * @param bodyHtml 已转义的正文 HTML。
 * @returns 完整 HTML 文档字符串。
 */
export declare function buildPrintHtml(title: string, bodyHtml: string): string;
/** 最小 HTML 转义。 */
export declare function escapeHtml(text: string): string;
