/**
 * 零依赖 ZIP 打包器（STORE 方式，不压缩）。
 * 用于模块 A 的批量导出：多个对话文件打包为 .zip 由浏览器下载。
 * 文件名以 UTF-8 编码（general purpose bit 11）。
 */
export interface ZipEntry {
    name: string;
    data: Uint8Array;
}
/** 清理文件名中的非法字符，防止 ZIP 目录穿越。 */
export declare function sanitizeFileName(name: string): string;
/**
 * 构建 ZIP 文件字节流。
 * @param entries 条目列表（名称在内部统一经 sanitizeFileName 强制清理）。
 * @returns 完整的 .zip 字节。
 * @throws 条目数超过 65535，或单条目超过 4GB（不支持 ZIP64）。
 */
export declare function buildZip(entries: readonly ZipEntry[]): Uint8Array;
