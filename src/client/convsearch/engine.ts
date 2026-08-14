/**
 * 对话内搜索引擎（能力吸收自 dsh-conv-search，基于 CSS Custom Highlight API）。
 *
 * 为什么用 Highlight API 而不是注入 <mark>：转录 DOM 归 React 所有，
 * 模型流式输出期间持续重渲染；用 <mark> 包裹命中会改动 React 管理的
 * 文本节点并与协调算法对抗。Custom Highlight API 以覆盖层绘制 range，
 * 不触碰 DOM 树，天然扛住一切重渲染，也无需清理 React 子节点。
 *
 * 作用域纪律：匹配只走对话滚动视口（[data-conversation-scroll]），
 * 跳过输入区 seat 与本插件自己的浮动搜索栏，避免命中 UI 外壳文字
 * 或用户自己的草稿产生幻影结果。
 *
 * 不依赖 cordis 与 React，纯 DOM 助手，可对着 jsdom 单测。
 */

/** 全部命中的高亮名。 */
export const HL_ALL = 'companion-conv-search'
/** 当前激活（聚焦）命中的高亮名。 */
export const HL_ACTIVE = 'companion-conv-search-active'
/** 对话滚动视口选择器（引擎的作用域）。 */
export const SCROLL_SELECTOR = '[data-conversation-scroll]'
/** 排除在匹配之外的输入区 seat 选择器。 */
export const COMPOSER_SELECTOR = '[data-composer-seat]'
/** 排除在匹配之外的本插件浮动搜索栏选择器。 */
export const BAR_SELECTOR = '[data-companion-search-bar]'

/** 定位到的单个命中：range 本身。 */
export interface MatchRange {
  /** 高亮文本范围（startContainer 为文本节点）。 */
  readonly range: Range
}

/** 匹配行为开关（对齐浏览器/IDE 查找栏）。 */
export interface MatchOptions {
  /** 区分大小写（关=不区分，缺省）。 */
  readonly caseSensitive: boolean
  /** 仅匹配两侧为非词字符界定的出现。 */
  readonly wholeWord: boolean
}

/** 缺省匹配行为：不区分大小写的子串匹配。 */
export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  caseSensitive: false,
  wholeWord: false,
}

/** 一次搜索遍历的结果。 */
export interface SearchResult {
  /** 按文档顺序排列的全部命中。 */
  readonly matches: readonly MatchRange[]
  /** 命中总数（matches.length）。 */
  readonly total: number
}

/** 特性检测 CSS Custom Highlight API 是否可用。 */
export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined'
}

/**
 * 从文档任意位置解析对话滚动视口。
 * @param from 任意元素或 document 本身。
 * @returns 滚动视口元素；当前没有对话渲染时为 null。
 */
export function resolveScope(from: ParentNode = document): HTMLElement | null {
  return from.querySelector<HTMLElement>(SCROLL_SELECTOR)
}

/**
 * 收集作用域内的候选文本节点：除输入区 seat、插件搜索栏与
 * 不渲染的 script/style 内容之外的全部文本。
 * @param scope 对话滚动视口。
 * @returns 按文档顺序排列的文本节点。
 */
function collectTextNodes(scope: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue ?? ''
      if (text.trim() === '') return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.closest(`${COMPOSER_SELECTOR}, ${BAR_SELECTOR}, script, style`) !== null) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let current = walker.nextNode()
  while (current !== null) {
    out.push(current as Text)
    current = walker.nextNode()
  }
  return out
}

/**
 * 全词匹配的“词字符”判定：任意文字（含 CJK）、数字与下划线。
 * @param ch 单个字符（文本边缘处为 ''）。
 */
function isWordChar(ch: string): boolean {
  if (ch === '') return false
  return /^[\p{L}\p{N}_]$/u.test(ch)
}

/**
 * 全词边界检查：查询串的词字符边缘外侧不得紧邻词字符；
 * 查询串边缘本身是非词字符时不施加边界约束。
 */
function wholeWordOk(text: string, idx: number, end: number, needle: string): boolean {
  const before = idx > 0 ? text.charAt(idx - 1) : ''
  const after = end < text.length ? text.charAt(end) : ''
  if (isWordChar(needle.charAt(0)) && isWordChar(before)) return false
  if (isWordChar(needle.charAt(needle.length - 1)) && isWordChar(after)) return false
  return true
}

/**
 * 在作用域全部文本节点中定位查询串的每个出现，按文档顺序返回 range。
 * @param scope 对话滚动视口。
 * @param query 原始查询（已 trim、非空）。
 * @param options 匹配行为（大小写、全词）。
 */
export function findMatches(
  scope: HTMLElement,
  query: string,
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): SearchResult {
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const matches: MatchRange[] = []
  if (needle === '') return { matches, total: 0 }

  for (const node of collectTextNodes(scope)) {
    const text = node.data
    const hay = options.caseSensitive ? text : text.toLowerCase()
    let idx = hay.indexOf(needle)
    while (idx !== -1) {
      const end = idx + needle.length
      if (!options.wholeWord || wholeWordOk(hay, idx, end, needle)) {
        const range = document.createRange()
        range.setStart(node, idx)
        range.setEnd(node, end)
        matches.push({ range })
      }
      idx = hay.indexOf(needle, end)
    }
  }
  return { matches, total: matches.length }
}

/** 取高亮注册表；不支持时返回 undefined。 */
function registry(): HighlightRegistry | undefined {
  if (!highlightsSupported()) return undefined
  return CSS.highlights
}

/**
 * 绘制命中：全部命中挂 {@link HL_ALL}，激活命中额外挂 {@link HL_ACTIVE}。
 * 每次调用替换上一次绘制。
 * @param result 待绘制的命中。
 * @param activeIndex 聚焦命中下标；-1 表示无。
 */
export function paint(result: SearchResult, activeIndex: number): void {
  const reg = registry()
  if (reg === undefined) return
  const all = new Highlight(...result.matches.map((m) => m.range))
  reg.set(HL_ALL, all)
  const activeRange = result.matches[activeIndex]?.range
  if (activeRange !== undefined) {
    reg.set(HL_ACTIVE, new Highlight(activeRange))
  } else {
    reg.delete(HL_ACTIVE)
  }
}

/** 清除本插件绘制的全部高亮（幂等）。 */
export function clearPaint(): void {
  const reg = registry()
  if (reg === undefined) return
  reg.delete(HL_ALL)
  reg.delete(HL_ACTIVE)
}

/**
 * 将激活命中滚动到视口中央。无 Range 几何的运行环境（部分测试环境）
 * 降级为无操作。
 * @param result 当前命中集。
 * @param index 聚焦命中下标。
 */
export function scrollToMatch(result: SearchResult, index: number): void {
  const target = result.matches[index]
  if (target === undefined) return
  if (typeof target.range.getBoundingClientRect !== 'function') return
  const rect = target.range.getBoundingClientRect()
  const scrollport = resolveScope()
  if (scrollport === null) return
  const portRect = scrollport.getBoundingClientRect()
  const delta = rect.top - portRect.top - scrollport.clientHeight / 2 + rect.height / 2
  scrollport.scrollBy({ top: delta, behavior: 'smooth' })
}
