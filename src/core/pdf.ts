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
export function isLatin1Safe(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0xff) return false
    if (code >= 0x80 && code <= 0x9f) return false
  }
  return true
}

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 50
const FONT_SIZE = 10
const LEADING = 14
const MAX_LINE_CHARS = 96
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LEADING)

/**
 * 生成简单文本 PDF（A4，Helvetica）。
 * @param title 文档标题（渲染于首页顶部）。
 * @param lines 正文行（调用方无需预分页）。
 * @returns PDF 字节流。
 */
export function buildSimplePdf(title: string, lines: readonly string[]): Uint8Array {
  const wrapped: string[] = []
  for (const line of lines) {
    if (line.length === 0) {
      wrapped.push('')
      continue
    }
    for (let i = 0; i < line.length; i += MAX_LINE_CHARS) {
      wrapped.push(line.slice(i, i + MAX_LINE_CHARS))
    }
  }
  const allLines = [title, '', ...wrapped]

  const pages: string[][] = []
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE))
  }
  if (pages.length === 0) pages.push([''])

  // 对象布局：1 Catalog，2 Pages，3 Font，其后每页 = 页对象 + 内容流。
  const encoder = new TextEncoder()
  const objects: string[] = []
  const pageObjectIds: number[] = []
  let nextId = 4
  for (const pageLines of pages) {
    const pageId = nextId
    const contentId = nextId + 1
    pageObjectIds.push(pageId)
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    )
    const stream = buildContentStream(pageLines)
    // /Length 必须使用字节长度：Latin-1 扩展字符（0xA0-0xFF）在 UTF-8 下占 2 字节。
    objects.push(
      `${contentId} 0 obj\n<< /Length ${encoder.encode(stream).byteLength} >>\nstream\n${stream}\nendstream\nendobj\n`,
    )
    nextId += 2
  }

  const header = '%PDF-1.4\n'
  const catalog = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
  const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] /Count ${pageObjectIds.length} >>\nendobj\n`
  const font = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`

  // 对象体按 id 升序收集到数组、最后一次性 join；
  // xref offset 在拼接时按 UTF-8 字节长度累量记录（不用 indexOf 回查）。
  const parts: string[] = [header, catalog, pagesObj, font, ...objects]
  const offsets: number[] = [0] // offsets[id] = 对象 `id 0 obj` 的字节偏移（0 号位占位）
  let byteLength = encoder.encode(header).byteLength
  for (let i = 1; i < parts.length; i += 1) {
    offsets.push(byteLength)
    byteLength += encoder.encode(parts[i]).byteLength
  }

  const objectCount = parts.length - 1
  const xrefOffset = byteLength
  const xrefLines: string[] = [`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`]
  for (let id = 1; id <= objectCount; id += 1) {
    xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  }
  const trailer =
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return encoder.encode(parts.join('') + xrefLines.join('') + trailer)
}

function buildContentStream(lines: readonly string[]): string {
  const startY = PAGE_HEIGHT - MARGIN
  const parts: string[] = [`BT /F1 ${FONT_SIZE} Tf ${LEADING} TL ${MARGIN} ${startY} Td`]
  for (const line of lines) {
    parts.push(`(${escapePdfText(line)}) Tj T*`)
  }
  parts.push('ET')
  return parts.join('\n')
}

/** 转义 PDF 字面量字符串：括号/反斜杠，以及控制字符等不可打印字符（八进制转义）。 */
function escapePdfText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code > 0xff) {
      out += '?'
      continue
    }
    const ch = text[i]
    if (ch === '(' || ch === ')' || ch === '\\') {
      out += `\\${ch}`
      continue
    }
    // C0 控制字符（含 \r、\x00 等）、DEL 与 C1 区间（0x80–0x9F）均不可直接打印。
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\${code.toString(8).padStart(3, '0')}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * 生成打印友好的 HTML（CJK 导出走浏览器打印 → 另存为 PDF）。
 * @param title 文档标题。
 * @param bodyHtml 已转义的正文 HTML。
 * @returns 完整 HTML 文档字符串。
 */
export function buildPrintHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', system-ui, sans-serif;
         max-width: 46em; margin: 2em auto; padding: 0 1em; line-height: 1.7; color: #1a1a1a; }
  h1 { font-size: 1.4em; border-bottom: 1px solid #ddd; padding-bottom: .4em; }
  h3 { font-size: 1em; margin: 1.2em 0 .3em; color: #333; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0; }
  .meta { color: #666; font-size: .85em; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${bodyHtml}
<script>window.addEventListener('load', function () { setTimeout(function () { window.print() }, 200) })</script>
</body>
</html>`
}

/** 最小 HTML 转义。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
