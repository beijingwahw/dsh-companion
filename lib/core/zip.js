/**
 * 零依赖 ZIP 打包器（STORE 方式，不压缩）。
 * 用于模块 A 的批量导出：多个对话文件打包为 .zip 由浏览器下载。
 * 文件名以 UTF-8 编码（general purpose bit 11）。
 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.byteLength; i += 1) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/** 清理文件名中的非法字符，防止 ZIP 目录穿越。 */
export function sanitizeFileName(name) {
    const cleaned = name
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, 120);
    return cleaned || 'untitled';
}
/** ZIP（非 ZIP64）条目数上限：EOCD 计数字段为 16 位。 */
const MAX_ENTRIES = 0xffff;
/** ZIP（非 ZIP64）单条目字节上限：局部头/中心目录的长度字段为 32 位。 */
const MAX_ENTRY_BYTES = 0xffffffff;
/**
 * 构建 ZIP 文件字节流。
 * @param entries 条目列表（名称在内部统一经 sanitizeFileName 强制清理）。
 * @returns 完整的 .zip 字节。
 * @throws 条目数超过 65535，或单条目超过 4GB（不支持 ZIP64）。
 */
export function buildZip(entries) {
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`zip: too many entries (${entries.length} > ${MAX_ENTRIES}); ZIP64 is not supported`);
    }
    const encoder = new TextEncoder();
    const chunks = [];
    const centralChunks = [];
    let offset = 0;
    let centralSize = 0;
    for (const entry of entries) {
        if (entry.data.byteLength > MAX_ENTRY_BYTES) {
            throw new Error(`zip: entry "${entry.name}" exceeds the 4GB size limit; ZIP64 is not supported`);
        }
        // 无论调用方是否预处理过，条目名一律再强制清理一次，防止目录穿越。
        const nameBytes = encoder.encode(sanitizeFileName(entry.name));
        const crc = crc32(entry.data);
        const size = entry.data.byteLength;
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true); // version needed
        local.setUint16(6, 0x0800, true); // UTF-8 文件名
        local.setUint16(8, 0, true); // method: store
        local.setUint16(10, 0, true); // mod time
        local.setUint16(12, 0x0021, true); // mod date: 1980-01-01
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true);
        local.setUint32(22, size, true);
        local.setUint16(26, nameBytes.byteLength, true);
        local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), nameBytes, entry.data);
        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true); // version made by
        central.setUint16(6, 20, true); // version needed
        central.setUint16(8, 0x0800, true);
        central.setUint16(10, 0, true); // method
        central.setUint16(12, 0, true);
        central.setUint16(14, 0x0021, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, size, true);
        central.setUint32(24, size, true);
        central.setUint16(28, nameBytes.byteLength, true);
        central.setUint32(42, offset, true);
        centralChunks.push(new Uint8Array(central.buffer), nameBytes);
        offset += 30 + nameBytes.byteLength + size;
        centralSize += 46 + nameBytes.byteLength;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    return concatBytes([...chunks, ...centralChunks, new Uint8Array(eocd.buffer)]);
}
function concatBytes(parts) {
    const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.byteLength;
    }
    return out;
}
