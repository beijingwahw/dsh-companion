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

/** 光栅宽度（CSS px；2x 视网膜下实际像素翻倍）。 */
const IMAGE_WIDTH = 800
/** 光栅缩放系数（2x 视网膜）。 */
const IMAGE_SCALE = 2
/** 光栅高度上限（canvas 尺寸限制）。 */
const IMAGE_MAX_HEIGHT = 16000
/** PDF 单页高度（IMAGE_WIDTH 宽下的 CSS px，A4 纵横比）。 */
const PAGE_CSS_HEIGHT = Math.round((IMAGE_WIDTH * 297) / 210)

/** 单页 PDF 的图像载荷。 */
interface PdfPage {
  /** JPEG 字节（DCTDecode）。 */
  readonly jpeg: Uint8Array
  /** 逻辑宽度（CSS px）。 */
  readonly widthPx: number
  /** 逻辑高度（CSS px）。 */
  readonly heightPx: number
}

/**
 * 从服务端打印 HTML 文档中提取可渲染内容与样式。
 * 剥离全部 script：打印回退页携带自动打印脚本，光栅路径绝不允许其执行。
 * @param html 完整 HTML 文档字符串（服务端 buildPrintHtml 产物）。
 * @returns 样式文本与 body 内容。
 */
function toStageContent(html: string): { styles: string; bodyInner: string; bodyStyle: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(doc.querySelectorAll('script'))) el.remove()
  const styles = Array.from(doc.querySelectorAll('style'))
    .map((el) => el.textContent ?? '')
    .join('\n')
  // body 选择器在 foreignObject 内不生效：提取其声明，稍后直接落到光栅舞台根节点。
  const bodyStyle = styles.match(/(?:^|[}\s])body\s*\{([^}]*)\}/i)?.[1] ?? ''
  return { styles, bodyInner: doc.body.innerHTML, bodyStyle }
}

/**
 * 将容器内全部 <img> 内联为 data: URL，使 SVG foreignObject 光栅可嵌入图片
 * （SVG 图像内部禁止外部资源请求）。
 * @param root 就地内联图片的容器。
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (src === '' || src.startsWith('data:')) return
      try {
        const res = await fetch(src)
        if (!res.ok) return
        const blob = await res.blob()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        img.setAttribute('src', dataUrl)
      } catch {
        // 不可达的图片：直接移除，避免污染/拖垮光栅化。
        img.remove()
      }
    }),
  )
}

/**
 * 将打印文档离屏渲染并光栅化到 2x canvas。
 * @param html 服务端打印 HTML（完整文档）。
 * @returns 光栅化画布（宽 IMAGE_WIDTH * IMAGE_SCALE）。
 * @throws 运行环境无法光栅化时抛出（无 canvas / SVG 解析失败）。
 */
async function rasterize(html: string): Promise<HTMLCanvasElement> {
  const { styles, bodyInner, bodyStyle } = toStageContent(html)
  const stage = document.createElement('div')
  stage.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${IMAGE_WIDTH}px;pointer-events:none;z-index:-1;`
  const style = document.createElement('style')
  style.textContent = styles
  stage.appendChild(style)
  const content = document.createElement('div')
  content.innerHTML = bodyInner
  stage.appendChild(content)
  document.body.appendChild(stage)
  try {
    await inlineImages(stage)
    // 等待内联图片完成布局沉淀。
    await new Promise((resolve) => setTimeout(resolve, 60))
    const height = Math.min(Math.ceil(stage.scrollHeight), IMAGE_MAX_HEIGHT)

    // 序列化干净克隆：不带离屏偏移（否则内容会移出 SVG 视口），
    // 显式 XHTML 命名空间保证 foreignObject 载荷格式合法；
    // 原 body 样式声明直接落到克隆根节点（foreignObject 内无 body 元素）。
    const clone = stage.cloneNode(true) as HTMLElement
    clone.setAttribute(
      'style',
      `${bodyStyle};width:${IMAGE_WIDTH}px;background:#ffffff;`,
    )
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    const serialized = new XMLSerializer().serializeToString(clone)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}">` +
      `<foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`

    // 光栅化前先校验 XML 良构性。
    const probe = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (probe.querySelector('parsererror') !== null) throw new Error('svg serialize failed')

    const img = new Image()
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    await img.decode()

    const canvas = document.createElement('canvas')
    canvas.width = IMAGE_WIDTH * IMAGE_SCALE
    canvas.height = height * IMAGE_SCALE
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('no 2d context')
    ctx.scale(IMAGE_SCALE, IMAGE_SCALE)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, IMAGE_WIDTH, height)
    ctx.drawImage(img, 0, 0, IMAGE_WIDTH, height)
    return canvas
  } finally {
    stage.remove()
  }
}

/**
 * 组装最小多页 PDF：每页一张 JPEG（能力吸收自 dsh-conv-export 的 buildPdf）。
 * @param pages 按顺序的页面载荷。
 * @returns PDF 文件字节。
 */
export function buildRasterPdf(pages: readonly PdfPage[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  let offset = 0
  const offsets: number[] = []
  const push = (data: string | Uint8Array): void => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data
    chunks.push(bytes)
    offset += bytes.length
  }
  const beginObj = (num: number): void => {
    offsets[num] = offset
    push(`${num} 0 obj\n`)
  }
  const endObj = (): void => push('endobj\n')

  const count = pages.length
  push('%PDF-1.4\n')
  beginObj(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\n')
  endObj()
  beginObj(2)
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  push(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>\n`)
  endObj()
  pages.forEach((page, i) => {
    const pageNum = 3 + i * 3
    const imgNum = pageNum + 1
    const contentNum = pageNum + 2
    const wPt = (page.widthPx * 0.75).toFixed(2)
    const hPt = (page.heightPx * 0.75).toFixed(2)
    beginObj(pageNum)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
        `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\n`,
    )
    endObj()
    beginObj(imgNum)
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx * IMAGE_SCALE} ` +
        `/Height ${page.heightPx * IMAGE_SCALE} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    )
    push(page.jpeg)
    push('\nendstream\n')
    endObj()
    const stream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`
    beginObj(contentNum)
    push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream\n`)
    endObj()
  })

  const total = 2 + count * 3
  const xrefAt = offset
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`)
  for (let n = 1; n <= total; n += 1) {
    push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)

  const out = new Uint8Array(offset)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** 触发客户端文件下载。 */
function download(filename: string, mime: string, data: BlobPart): void {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * 导出为 PNG 长图：光栅化整篇对话并下载一张纵向长图。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出（无 canvas / SVG 解析失败）。
 */
export async function exportLongPng(html: string, fileName: string): Promise<void> {
  const canvas = await rasterize(html)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('toBlob failed')
  download(fileName, 'image/png', blob)
}

/**
 * 导出为免打印多页 PDF：光栅化对话 → 按页高切片 → JPEG → 自包含 PDF 下载。
 * 全程无打印对话框，应用标签页永不冻结。
 * @param html 服务端打印 HTML（完整文档）。
 * @param fileName 下载文件名（含扩展名）。
 * @throws 运行环境无法光栅化时抛出。
 */
export async function exportRasterPdf(html: string, fileName: string): Promise<void> {
  const canvas = await rasterize(html)
  const slicePx = PAGE_CSS_HEIGHT * IMAGE_SCALE
  const pages: PdfPage[] = []
  for (let y = 0; y < canvas.height; y += slicePx) {
    const h = Math.min(slicePx, canvas.height - y)
    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = h
    const ctx = slice.getContext('2d')
    if (ctx === null) throw new Error('no 2d context')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, slice.width, h)
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h)
    const jpeg = await new Promise<Blob | null>((resolve) => slice.toBlob(resolve, 'image/jpeg', 0.92))
    if (jpeg === null) throw new Error('toBlob failed')
    pages.push({
      jpeg: new Uint8Array(await jpeg.arrayBuffer()),
      widthPx: IMAGE_WIDTH,
      heightPx: Math.ceil(h / IMAGE_SCALE),
    })
  }
  download(fileName, 'application/pdf', buildRasterPdf(pages))
}
