/**
 * 对话内搜索控制器（能力吸收自 dsh-conv-search）：持有浮动搜索栏
 * （纯 DOM 实现，不与宿主 React 版本耦合）、引擎遍历，以及转录变更
 * 监视——模型流式输出或加载更早消息时保持高亮诚实。
 *
 * 生命周期：cordis apply 时 install()（document 级按键捕获 + 搜索栏挂载），
 * 插件卸载时 uninstall()。其间一切由用户输入与 DOM 观察驱动。
 *
 * 快捷键（浏览器/IDE 查找栏惯例）：
 * - Ctrl/Cmd+F：打开（仅在对话已渲染时接管，否则保留浏览器原生查找）；
 * - Esc：关闭；
 * - Enter / Shift+Enter、F3 / Ctrl+G（+Shift 反向）：下一个 / 上一个命中；
 * - ArrowUp / ArrowDown：浏览查询历史。
 */
import {
  DEFAULT_MATCH_OPTIONS,
  clearPaint,
  findMatches,
  paint,
  resolveScope,
  scrollToMatch,
} from './engine.js'
import type { MatchOptions, SearchResult } from './engine.js'
import { adoptStyles } from './styles.js'

/** 输入触发重搜的防抖（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 120
/** 转录变更触发重搜的防抖（毫秒）。 */
const MUTATION_DEBOUNCE_MS = 160
/** 内存查询历史上限。 */
const HISTORY_LIMIT = 20

/** 控制器可变运行状态。 */
interface ControllerState {
  /** 搜索栏是否打开。 */
  open: boolean
  /** 当前查询（输入框实时值）。 */
  query: string
  /** 匹配行为开关（大小写/全词）。 */
  options: MatchOptions
  /** 最近一次搜索遍历结果。 */
  result: SearchResult
  /** 激活命中下标；-1=无。 */
  index: number
}

/** 激活命中的身份标识：用于在转录变更后重新定位。 */
interface MatchAnchor {
  /** 激活命中起始所在的文本节点。 */
  readonly container: Node
  /** 该节点内的起始偏移。 */
  readonly offset: number
}

/** 计数文案：`第 index 个，共 total 个`。 */
function countText(index: number, total: number): string {
  return `${index} / ${total}`
}

/**
 * 单例控制器。一个页面只承载一个对话面板，模块级实例即正确的所有权；
 * cordis 的 install/uninstall 括起其 DOM 效果。
 */
class SearchController {
  private state: ControllerState = {
    open: false,
    query: '',
    options: DEFAULT_MATCH_OPTIONS,
    result: { matches: [], total: 0 },
    index: -1,
  }

  private bar: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private countEl: HTMLElement | null = null
  private prevBtn: HTMLButtonElement | null = null
  private nextBtn: HTMLButtonElement | null = null
  private caseBtn: HTMLButtonElement | null = null
  private wordBtn: HTMLButtonElement | null = null

  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private mutationTimer: ReturnType<typeof setTimeout> | undefined
  private observer: MutationObserver | null = null
  private observedScope: HTMLElement | null = null
  private installed = false

  /** 内存查询历史（最新在前），上限 HISTORY_LIMIT。 */
  private history: string[] = []
  /** 历史浏览游标；-1=未在浏览。 */
  private historyCursor = -1
  /** 开始浏览历史前暂存的输入值。 */
  private historyDraft = ''
  /** 上次变更重同步前激活命中的身份。 */
  private anchor: MatchAnchor | null = null

  /** 搜索栏当前是否打开（供头部按钮读取）。 */
  get isOpen(): boolean {
    return this.state.open
  }

  /** 安装 document 级效果：样式表、搜索栏 DOM、Ctrl+F/Esc 按键捕获（幂等）。 */
  install(): void {
    if (this.installed) return
    this.installed = true
    adoptStyles()
    this.mountBar()
    window.addEventListener('keydown', this.onKeyDown, true)
  }

  /** 移除全部安装效果并清除绘制（幂等）。 */
  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    window.removeEventListener('keydown', this.onKeyDown, true)
    this.close()
    this.bar?.remove()
    this.bar = null
    this.input = null
    this.countEl = null
    this.prevBtn = null
    this.nextBtn = null
    this.caseBtn = null
    this.wordBtn = null
  }

  /** 打开搜索栏（无对话渲染时无操作）。 */
  open(): void {
    if (this.bar === null || this.input === null) return
    if (resolveScope() === null) return
    this.state.open = true
    this.bar.hidden = false
    this.input.focus()
    this.input.select()
    this.syncActionButton()
    this.watchScope()
    // 用既有查询对可能已变化的转录重跑一遍。
    if (this.state.query.trim() !== '') this.runSearch(false)
    else this.renderCount()
  }

  /** 关闭搜索栏、丢弃游标并清除全部高亮。 */
  close(): void {
    this.state.open = false
    if (this.bar !== null) this.bar.hidden = true
    this.state.index = -1
    clearPaint()
    this.syncActionButton()
    this.unwatchScope()
    clearTimeout(this.searchTimer)
    clearTimeout(this.mutationTimer)
  }

  /** 开关切换（头部按钮手势）。 */
  toggle(): void {
    if (this.state.open) this.close()
    else this.open()
  }

  /**
   * 将打开状态镜像到头部按钮（纯 DOM 旁路——React 按钮只渲染一次，
   * 不应为此重渲染）。
   */
  private syncActionButton(): void {
    const btn = document.querySelector('[data-companion-search-action]')
    if (btn === null) return
    btn.setAttribute('aria-pressed', String(this.state.open))
  }

  /** 前进到下一个命中（环绕）。 */
  next(): void {
    this.step(1)
  }

  /** 回退到上一个命中（环绕）。 */
  prev(): void {
    this.step(-1)
  }

  // ------------------------------------------------------------------ 搜索栏

  /** 构建一次浮动搜索栏并隐藏，直到打开。 */
  private mountBar(): void {
    const bar = document.createElement('div')
    bar.setAttribute('data-companion-search-bar', '')
    bar.hidden = true
    bar.setAttribute('role', 'search')

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '在对话中查找…'
    input.setAttribute('aria-label', '在对话中查找')
    input.spellcheck = false
    input.addEventListener('input', () => {
      this.state.query = input.value
      this.historyCursor = -1
      this.setNoResult(false)
      clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => {
        this.runSearch(true)
      }, SEARCH_DEBOUNCE_MS)
    })
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) this.prev()
        else this.next()
        this.commitHistory()
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 浏览历史查询（浏览器/IDE 查找栏惯例）。
        e.preventDefault()
        this.browseHistory(e.key === 'ArrowUp' ? 1 : -1)
      }
      // Esc 与 F3/Ctrl+G 归 window 捕获处理器所有，
      // 无论焦点在哪个元素上行为一致。
      e.stopPropagation()
    })

    const count = document.createElement('span')
    count.setAttribute('data-companion-search-count', '')
    count.setAttribute('aria-live', 'polite')

    const caseBtn = this.toggleButton('区分大小写', 'Aa', this.state.options.caseSensitive)
    const wordBtn = this.toggleButton('全词匹配', 'ab', this.state.options.wholeWord)
    caseBtn.addEventListener('click', () => {
      this.toggleOption('caseSensitive')
    })
    wordBtn.addEventListener('click', () => {
      this.toggleOption('wholeWord')
    })

    const prevBtn = this.iconButton('上一个（Shift+Enter）', 'M9.5 12 15 6.5 13.9 5.4 7.3 12l6.6 6.6L15 17.5z')
    const nextBtn = this.iconButton('下一个（Enter）', 'M14.5 12 9 17.5l1.1 1.1 6.6-6.6-6.6-6.6L9 6.5z')
    const closeBtn = this.iconButton('关闭（Esc）', 'M6.4 5.3 12 10.9l5.6-5.6 1.1 1.1L13.1 12l5.6 5.6-1.1 1.1L12 13.1l-5.6 5.6-1.1-1.1L10.9 12 5.3 6.4z')
    prevBtn.addEventListener('click', () => {
      this.prev()
      this.input?.focus()
    })
    nextBtn.addEventListener('click', () => {
      this.next()
      this.input?.focus()
    })
    closeBtn.addEventListener('click', () => {
      this.close()
    })

    bar.append(input, count, caseBtn, wordBtn, prevBtn, nextBtn, closeBtn)
    document.body.appendChild(bar)
    this.bar = bar
    this.input = input
    this.countEl = count
    this.prevBtn = prevBtn
    this.nextBtn = nextBtn
    this.caseBtn = caseBtn
    this.wordBtn = wordBtn
  }

  /**
   * 构建一个紧凑文本开关（Aa=区分大小写，ab=全词匹配）。
   * 纯文本字形保持搜索栏零依赖且 16px 下清晰可辨。
   */
  private toggleButton(label: string, glyph: string, pressed: boolean): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.setAttribute('aria-pressed', String(pressed))
    btn.setAttribute('data-companion-search-toggle', '')
    btn.textContent = glyph
    return btn
  }

  /** 翻转一个匹配选项、同步开关按钮并立即重跑当前查询（显式手势不防抖）。 */
  private toggleOption(key: keyof MatchOptions): void {
    this.state.options = { ...this.state.options, [key]: !this.state.options[key] }
    const btn = key === 'caseSensitive' ? this.caseBtn : this.wordBtn
    if (btn !== null) btn.setAttribute('aria-pressed', String(this.state.options[key]))
    clearTimeout(this.searchTimer)
    this.runSearch(true)
    this.input?.focus()
  }

  /**
   * 构建一个 16px 图标按钮（内联 SVG path，零图标依赖——
   * 搜索栏是纯 DOM，不得引入 React 图标组件）。
   */
  private iconButton(label: string, d: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.title = label
    btn.setAttribute('aria-label', label)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('fill', 'currentColor')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
    btn.appendChild(svg)
    return btn
  }

  // ------------------------------------------------------------- 查询历史

  /** 记录当前非空查询进历史（最新在前、去重、限长）；Enter 提交时调用。 */
  private commitHistory(): void {
    const query = this.state.query.trim()
    if (query === '') return
    this.history = [query, ...this.history.filter((h) => h !== query)].slice(0, HISTORY_LIMIT)
    this.historyCursor = -1
  }

  /**
   * 步进浏览查询历史：ArrowUp 向更旧，ArrowDown 回到暂存草稿；
   * 每步重跑搜索。
   * @param delta +1=更旧，-1=更新。
   */
  private browseHistory(delta: number): void {
    if (this.input === null || this.history.length === 0) return
    if (this.historyCursor === -1) {
      if (delta < 0) return
      this.historyDraft = this.input.value
      this.historyCursor = 0
    } else {
      const next = this.historyCursor + delta
      if (next < 0) {
        // 越过最新条目：恢复暂存草稿。
        this.historyCursor = -1
        this.input.value = this.historyDraft
        this.state.query = this.historyDraft
        clearTimeout(this.searchTimer)
        this.searchTimer = setTimeout(() => {
          this.runSearch(true)
        }, SEARCH_DEBOUNCE_MS)
        return
      }
      if (next >= this.history.length) return
      this.historyCursor = next
    }
    const entry = this.history[this.historyCursor]
    if (entry === undefined) return
    this.input.value = entry
    this.state.query = entry
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.runSearch(true)
    }, SEARCH_DEBOUNCE_MS)
  }

  // ------------------------------------------------------------- 搜索遍历

  /**
   * 对渲染中的转录执行一次搜索遍历并重绘。
   * @param jumpToFirst 是否同时把游标移到最佳初始命中（当前阅读位置
   * 之下最近的第一个命中，没有则回绕到最前）。变更重同步传 false——
   * 绝不能抢走读者的滚动位置。
   */
  private runSearch(jumpToFirst: boolean): void {
    const scope = resolveScope()
    const query = this.state.query.trim()
    if (scope === null || query === '') {
      this.state.result = { matches: [], total: 0 }
      this.state.index = -1
      this.anchor = null
      clearPaint()
      this.renderCount()
      return
    }
    this.watchScope()
    const result = findMatches(scope, query, this.state.options)
    this.state.result = result
    if (result.total === 0) {
      this.state.index = -1
      this.anchor = null
    } else if (jumpToFirst) {
      this.state.index = this.initialIndex(scope, result)
      this.anchor = this.anchorOf(result, this.state.index)
      scrollToMatch(result, this.state.index)
    } else {
      // 变更重同步：游标停留在同一个命中（按身份），
      // 绝不把读者跳到另一个出现处。
      this.state.index = this.relocateIndex(result)
      this.anchor = this.anchorOf(result, this.state.index)
    }
    paint(result, this.state.index)
    this.renderCount()
  }

  /** 快照激活命中的身份（文本节点 + 起始偏移），供后续变更重同步重新定位。 */
  private anchorOf(result: SearchResult, index: number): MatchAnchor | null {
    const match = result.matches[index]
    if (match === undefined) return null
    return { container: match.range.startContainer, offset: match.range.startOffset }
  }

  /**
   * 在全新结果集中定位先前激活的命中：优先完全相同的文本节点 + 偏移
   * （命中原样存活）；退而求同一文本节点（命中在节点内移动，如流式追加）；
   * 都找不到则钳制下标，让读者留在原地而不是跳走。
   */
  private relocateIndex(result: SearchResult): number {
    const anchor = this.anchor
    if (anchor !== null) {
      // 完全同一身份：同节点、同起始偏移。
      for (let i = 0; i < result.total; i += 1) {
        const range = result.matches[i]?.range
        if (
          range !== undefined &&
          range.startContainer === anchor.container &&
          range.startOffset === anchor.offset
        ) {
          return i
        }
      }
      // 同节点、偏移移动（周围文本增删）。
      for (let i = 0; i < result.total; i += 1) {
        if (result.matches[i]?.range.startContainer === anchor.container) return i
      }
    }
    // 无锚点或锚点消失：原地钳制。
    return Math.min(Math.max(this.state.index, 0), result.total - 1)
  }

  /**
   * 选取初始激活命中：滚动视口顶边（读者当前位置）之下最近的第一个，
   * 没有则回绕到整体第一个。无 Range 几何的运行环境退回第一个命中。
   */
  private initialIndex(scope: HTMLElement, result: SearchResult): number {
    const portTop = scope.getBoundingClientRect().top
    for (let i = 0; i < result.total; i += 1) {
      const match = result.matches[i]
      if (match === undefined) continue
      const rect =
        typeof match.range.getBoundingClientRect === 'function'
          ? match.range.getBoundingClientRect()
          : null
      if (rect === null) return i
      if (rect.top >= portTop - 8) return i
    }
    return 0
  }

  /** 游标步进一格（环绕）、重绘并滚动。零结果时搜索栏重新抖动作答。 */
  private step(delta: number): void {
    const { result } = this.state
    if (result.total === 0) {
      if (this.state.open && this.state.query.trim() !== '') this.setNoResult(true)
      return
    }
    const nextIndex = (((this.state.index + delta) % result.total) + result.total) % result.total
    this.state.index = nextIndex
    this.anchor = this.anchorOf(result, nextIndex)
    paint(result, nextIndex)
    scrollToMatch(result, nextIndex)
    this.renderCount()
  }

  /** 更新 “n / total” 计数、导航按钮可用态与无结果视觉状态。 */
  private renderCount(): void {
    if (this.countEl === null) return
    const { total } = this.state.result
    const { index } = this.state
    const empty = this.state.query.trim() === ''
    this.countEl.textContent = total === 0 ? (empty ? '' : '无结果') : countText(index + 1, total)
    this.setNoResult(!empty && total === 0)
    const disabled = total === 0
    if (this.prevBtn !== null) this.prevBtn.disabled = disabled
    if (this.nextBtn !== null) this.nextBtn.disabled = disabled
  }

  /**
   * 切换无结果提示：状态属性由样式表渲染为红色计数与一次性搜索栏抖动。
   * 已置位时再次置位会重新触发抖动——这正是对零结果查询反复按 Enter
   * 应当给出的回应。
   */
  private setNoResult(on: boolean): void {
    if (this.bar === null) return
    if (!on) {
      this.bar.removeAttribute('data-no-result')
      return
    }
    this.bar.setAttribute('data-no-result', '')
    this.bar.classList.remove('companion-search-shake')
    // 强制回流，让重新添加类名能重启动画。
    void this.bar.offsetWidth
    this.bar.classList.add('companion-search-shake')
  }

  // ---------------------------------------------------------- 转录监视

  /**
   * 在当前滚动视口上挂 MutationObserver：流式输出、工具卡片与加载更早
   * 消息都会触发高亮重同步。作用域元素变化（切换会话）时重新附着。
   */
  private watchScope(): void {
    const scope = resolveScope()
    if (scope === null || scope === this.observedScope) return
    this.unwatchScope()
    this.observedScope = scope
    this.observer = new MutationObserver(() => {
      if (!this.state.open || this.state.query.trim() === '') return
      clearTimeout(this.mutationTimer)
      this.mutationTimer = setTimeout(() => {
        this.runSearch(false)
      }, MUTATION_DEBOUNCE_MS)
    })
    this.observer.observe(scope, { subtree: true, childList: true, characterData: true })
  }

  /** 断开变更监视。 */
  private unwatchScope(): void {
    this.observer?.disconnect()
    this.observer = null
    this.observedScope = null
  }

  // ------------------------------------------------------------- 按键

  /**
   * document 级捕获阶段按键处理器。捕获顺序至关重要：先于任何目标监听器
   * 运行，因此即使输入框持有焦点，Esc 也能关闭搜索栏（输入框自己的
   * 处理器只负责 Enter）。
   *
   * - Ctrl/Cmd+F：打开（仅在对话已渲染时；否则保留浏览器原生查找）；
   * - Esc：打开状态下始终关闭；
   * - F3 / Ctrl/Cmd+G（+Shift 反向）：打开状态下导航命中。
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const isFind =
      (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')
    if (isFind) {
      // 仅在确有对话渲染时接管，否则浏览器原生查找保持可用。
      if (resolveScope() === null) return
      e.preventDefault()
      e.stopPropagation()
      this.open()
      return
    }
    if (!this.state.open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.close()
      return
    }
    const isNav =
      e.key === 'F3' || ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'g' || e.key === 'G'))
    if (isNav) {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) this.prev()
      else this.next()
    }
  }
}

/** 页面级控制器单例。 */
export const convSearchController = new SearchController()
