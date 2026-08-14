/**
 * 官方动态计价引擎（移植自 dsh-usage-ledger/src/pricing.ts 并适配本插件）。
 *
 * DeepSeek：抓取解析官方公开定价页，内置兜底快照；理解分时（峰谷）
 * 定价计划——按调用时刻的北京时间解析适用单价。
 *
 * 其他厂商（智谱/Kimi/通义/豆包/MiniMax/文心）：同一刷新循环抓取各自
 * 官方定价页；新公布的模型自动导入，厂商上新模型无需改代码。
 *
 * 解析优先级：用户覆盖 > DeepSeek 实时表 > 厂商实时表 > 内置目录精确 >
 * 最长前缀匹配。
 */
import { CATALOG_TABLE, VENDORS, vendorOf } from './catalog.js'
import {
  BROWSER_UA,
  parseDoubaoSheet,
  parseErnieSheet,
  parseKimiSheet,
  parsePriceCell,
  parseRawTables,
  parseVendorSheet,
  parseZhipuBundleSheet,
  parseZhipuLegacySheet,
  toGrid,
} from './scrapers.js'
import { beijingDayKey } from '../time.js'
import type { ModelPrice, PriceSheet, PriceTable, ScheduledPricing, UsageLike, VendorPricing } from './types.js'

/** DeepSeek 官方 API 定价页（zh-CN）。 */
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** 最小日志形状（结构兼容 cordis logger）。 */
export interface MinimalLogger {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * 内置兜底价格表（元/百万 tokens）：
 * - deepseek-chat / deepseek-coder 为本插件实际调用的官方模型名，
 *   取自插件原静态计费表（官方调价时由实时抓取自动覆盖）；
 * - deepseek-v4-* 镜像官方定价页 2026-08-14 快照：现平价，
 *   2026-08-17 起启用峰谷分时。
 */
export const BUILTIN_SHEET: PriceSheet = {
  source: 'builtin',
  current: {
    'deepseek-chat': { inputCacheHit: 0.5, inputMiss: 2, output: 8 },
    // 官方未公布 coder 缓存价：按普通输入价计价（与插件原行为一致）。
    'deepseek-coder': { inputCacheHit: 4, inputMiss: 4, output: 12 },
    'deepseek-v4-flash': { inputCacheHit: 0.02, inputMiss: 1, output: 2 },
    'deepseek-v4-pro': { inputCacheHit: 0.025, inputMiss: 3, output: 6 },
  },
  scheduled: {
    effective: '2026-08-17',
    peakWindows: [
      [9, 12],
      [14, 18],
    ],
    offPeak: {
      'deepseek-v4-flash': { inputCacheHit: 0.05, inputMiss: 1.5, output: 4.5 },
      'deepseek-v4-pro': { inputCacheHit: 0.15, inputMiss: 4.5, output: 13.5 },
    },
    peak: {
      'deepseek-v4-flash': { inputCacheHit: 0.1, inputMiss: 3, output: 9 },
      'deepseek-v4-pro': { inputCacheHit: 0.3, inputMiss: 9, output: 27 },
    },
  },
}

/** 缺省北京时间高峰窗口 [起始小时, 结束小时)（DeepSeek 官方约定）。 */
export const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

/**
 * 一次调用的费用（元）。缓存读按缓存命中价计；缓存写按未命中输入价计
 * （DeepSeek 将其并入普通输入）；未知价格计 0（tokens 仍被统计）。
 */
export function costOf(price: ModelPrice | undefined, usage: UsageLike): number {
  if (price === undefined) return 0
  return (
    usage.inputTokens * price.inputMiss +
    (usage.cacheReadTokens ?? 0) * price.inputCacheHit +
    (usage.cacheWriteTokens ?? 0) * price.inputMiss +
    usage.outputTokens * price.output
  ) / 1_000_000
}

/** 某北京时间时刻是否处于任一高峰窗口。 */
export function isPeakTimeAt(
  atMs: number,
  windows: ReadonlyArray<readonly [number, number]> = DEFAULT_PEAK_WINDOWS,
): boolean {
  const shifted = new Date(atMs + 8 * 3600_000)
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 在某价格表与时刻下解析模型单价（分时计划感知）。 */
export function resolvePrice(sheet: PriceSheet, model: string, atMs: number): ModelPrice | undefined {
  let table: PriceTable = sheet.current
  if (sheet.scheduled !== undefined && beijingDayKey(atMs) >= sheet.scheduled.effective) {
    table = isPeakTimeAt(atMs, sheet.scheduled.peakWindows ?? DEFAULT_PEAK_WINDOWS)
      ? sheet.scheduled.peak
      : sheet.scheduled.offPeak
  }
  return table[model]
}

/** 带超时抓取 URL 文本。 */
export async function fetchText(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'deepseek-companion/0.2 (pricing fetch)', ...headers },
  })
  if (!response.ok) throw new Error(`pricing fetch failed: HTTP ${response.status}`)
  return response.text()
}

const isModelId = (text: string): boolean => /^deepseek-[\w.-]+$/i.test(text.trim())

/** 解析 "0.05元" / "¥1.5" 风格单元格为数字（DeepSeek 页）。 */
function parseDeepSeekPrice(text: string): number | undefined {
  return parsePriceCell(text)
}

/**
 * 解析 DeepSeek 定价页 HTML 为价格表。无可识别价格表时抛错
 * （调用方保留上一份有效表）。
 */
export function parsePriceSheet(html: string, url: string): PriceSheet {
  const grids = parseRawTables(html).map(toGrid)

  // 平价 "current" 表：表头行以模型 id 为列；标签行携带三类价格。
  let current: PriceTable | undefined
  for (const grid of grids) {
    const header = grid[0]
    if (header === undefined) continue
    const modelCols: Array<[number, string]> = []
    header.forEach((text, col) => {
      if (isModelId(text)) modelCols.push([col, text.trim().toLowerCase()])
    })
    if (modelCols.length < 1) continue
    const table: PriceTable = {}
    for (const row of grid.slice(1)) {
      const label = row.join(' ')
      const pick = (col: number): number | undefined => parseDeepSeekPrice(row[col] ?? '')
      for (const [col, model] of modelCols) {
        const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 }
        if (label.includes('缓存未命中')) {
          const value = pick(col)
          if (value !== undefined) existing.inputMiss = value
        } else if (label.includes('缓存命中')) {
          const value = pick(col)
          if (value !== undefined) existing.inputCacheHit = value
        } else if (label.includes('输出')) {
          const value = pick(col)
          if (value !== undefined) existing.output = value
        }
        table[model] = existing
      }
    }
    const priced = Object.values(table).some((p) => p.inputMiss > 0 || p.output > 0)
    if (priced) {
      current = table
      break
    }
  }

  // 峰谷分时表：表头以三类价格为列；行为 [模型, 空闲/高峰时段, hit, miss, output]。
  let scheduled: ScheduledPricing | undefined
  for (const grid of grids) {
    const header = grid[0]
    if (header === undefined) continue
    if (!header.some((text) => text.includes('缓存命中')) || !header.some((text) => text.includes('输出'))) continue
    const offPeak: PriceTable = {}
    const peak: PriceTable = {}
    for (const row of grid.slice(1)) {
      const modelCell = row[0] ?? ''
      if (!isModelId(modelCell) || row.length < 5) continue
      const model = modelCell.trim().toLowerCase()
      const price: ModelPrice = {
        inputCacheHit: parseDeepSeekPrice(row[2] ?? '') ?? 0,
        inputMiss: parseDeepSeekPrice(row[3] ?? '') ?? 0,
        output: parseDeepSeekPrice(row[4] ?? '') ?? 0,
      }
      if ((row[1] ?? '').includes('高峰')) peak[model] = price
      else offPeak[model] = price
    }
    if (Object.keys(peak).length > 0 && Object.keys(offPeak).length > 0) {
      scheduled = { effective: '', peakWindows: DEFAULT_PEAK_WINDOWS.slice(), offPeak, peak }
      break
    }
  }

  if (current === undefined && scheduled === undefined) {
    throw new Error('pricing page: no recognizable price table')
  }
  // 分时计划取代表格后，生效前按保守（高峰）价计费而不是失败。
  if (current === undefined && scheduled !== undefined) current = scheduled.peak

  // 生效日期："…2026 年 8 月 17 日 00:00 开始生效"。
  if (scheduled !== undefined) {
    const effective = html.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^<。]{0,40}?开始生效/)
    if (effective !== null && effective[1] !== undefined && effective[2] !== undefined && effective[3] !== undefined) {
      scheduled.effective = `${effective[1]}-${effective[2].padStart(2, '0')}-${effective[3].padStart(2, '0')}`
    }
    // 高峰窗口："高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00"。
    const windows = html.match(
      /高峰时段为北京时间\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*[、,，]\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/,
    )
    if (windows !== null) {
      const nums = windows.slice(1, 9).map(Number) as [number, number, number, number, number, number, number, number]
      scheduled.peakWindows = [
        [nums[0] + nums[1] / 60, nums[2] + nums[3] / 60],
        [nums[4] + nums[5] / 60, nums[6] + nums[7] / 60],
      ]
    }
    // 未解析出生效日期的分时计划永不激活。
    if (scheduled.effective === '') scheduled = undefined
  }

  return {
    source: 'live',
    fetchedAt: Date.now(),
    sourceUrl: url,
    // current 必有：undefined 分支已回退 scheduled.peak。
    current: current as PriceTable,
    scheduled,
  }
}

/** 价格表内容（价格部分）的规范化（键排序）JSON。 */
function canonicalSheet(sheet: PriceSheet): string {
  const norm = (table: PriceTable): unknown =>
    Object.fromEntries(
      Object.entries(table)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, p]) => [model, [p.inputCacheHit, p.inputMiss, p.output]]),
    )
  return JSON.stringify({
    current: norm(sheet.current),
    scheduled:
      sheet.scheduled === undefined
        ? null
        : {
            effective: sheet.scheduled.effective,
            windows: sheet.scheduled.peakWindows,
            offPeak: norm(sheet.scheduled.offPeak),
            peak: norm(sheet.scheduled.peak),
          },
  })
}

/** 价格表的一行人类可读摘要（供变更日志）。 */
function summarizeSheet(sheet: PriceSheet): string {
  const parts = Object.entries(sheet.current).map(([model, p]) => `${model} ¥${p.inputMiss}/¥${p.output}`)
  if (sheet.scheduled !== undefined) parts.push(`峰谷自 ${sheet.scheduled.effective} 生效`)
  return parts.join(', ')
}

/** 对某表键做最长前缀匹配。 */
function matchByPrefix(table: PriceTable, model: string): ModelPrice | undefined {
  const id = model.trim().toLowerCase()
  let best: ModelPrice | undefined
  let bestLen = -1
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && key.length > bestLen) {
      best = table[key]
      bestLen = key.length
    }
  }
  return best
}

/** 两张表的人类可读差异：新增模型与调价。 */
function diffTable(prev: PriceTable, next: PriceTable): string[] {
  const notes: string[] = []
  for (const [model, price] of Object.entries(next)) {
    const old = prev[model]
    if (old === undefined) {
      notes.push(`新增模型 ${model}（¥${price.inputMiss}/¥${price.output}）`)
    } else if (old.inputMiss !== price.inputMiss || old.output !== price.output || old.inputCacheHit !== price.inputCacheHit) {
      notes.push(`${model} 调价 ¥${old.inputMiss}/¥${old.output} → ¥${price.inputMiss}/¥${price.output}`)
    }
  }
  for (const model of Object.keys(prev)) {
    if (next[model] === undefined) notes.push(`移除模型 ${model}`)
  }
  return notes
}

/** 校验反序列化的价格表条目；非法条目被丢弃。 */
function sanitizePriceTable(raw: unknown): PriceTable {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const table: PriceTable = {}
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const hit = Number(entry.inputCacheHit)
    const miss = Number(entry.inputMiss)
    const output = Number(entry.output)
    if (!Number.isFinite(hit) || !Number.isFinite(miss) || !Number.isFinite(output)) continue
    if (hit < 0 || miss < 0 || output < 0) continue
    table[model] = { inputCacheHit: hit, inputMiss: miss, output }
  }
  return table
}

/** 校验反序列化的持久化价格表快照；结构非法返回 undefined。 */
export function sanitizePriceSheet(raw: unknown): PriceSheet | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const current = sanitizePriceTable(entry.current)
  if (Object.keys(current).length === 0) return undefined
  const sheet: PriceSheet = { source: 'live', current }
  if (typeof entry.fetchedAt === 'number' && Number.isFinite(entry.fetchedAt)) sheet.fetchedAt = entry.fetchedAt
  if (typeof entry.sourceUrl === 'string') sheet.sourceUrl = entry.sourceUrl
  if (typeof entry.scheduled === 'object' && entry.scheduled !== null && !Array.isArray(entry.scheduled)) {
    const sched = entry.scheduled as Record<string, unknown>
    const offPeak = sanitizePriceTable(sched.offPeak)
    const peak = sanitizePriceTable(sched.peak)
    if (typeof sched.effective === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.effective) && Object.keys(peak).length > 0) {
      const scheduled: ScheduledPricing = { effective: sched.effective, offPeak, peak }
      if (Array.isArray(sched.peakWindows)) {
        const windows: Array<readonly [number, number]> = []
        for (const w of sched.peakWindows) {
          if (Array.isArray(w) && w.length === 2 && Number.isFinite(Number(w[0])) && Number.isFinite(Number(w[1]))) {
            windows.push([Number(w[0]), Number(w[1])])
          }
        }
        if (windows.length > 0) scheduled.peakWindows = windows
      }
      sheet.scheduled = scheduled
    }
  }
  return sheet
}

/** 持有实时价格表并负责刷新与兜底的所有权服务。 */
export class PriceService {
  private sheet: PriceSheet = BUILTIN_SHEET
  private changedAt: number | undefined
  private overrides: PriceTable = {}
  /** 各厂商官方定价页实时抓取表（新模型落在这里）。 */
  private vendorLive = new Map<string, { table: PriceTable; fetchedAt: number }>()
  /** 官方价格内容变化回调（供持久化与提示）。 */
  onChanged?: (sheet: PriceSheet) => void

  constructor(
    private pricingUrl: string,
    private readonly timeoutMs: number,
    private readonly log: MinimalLogger,
  ) {}

  /** 指向另一份定价页（设置实时更新）。 */
  setUrl(url: string): void {
    this.pricingUrl = url
  }

  /** 当前定价页 URL。 */
  get url(): string {
    return this.pricingUrl
  }

  /** 替换用户价格覆盖（设置实时更新）。 */
  setOverrides(overrides: PriceTable): void {
    this.overrides = overrides
  }

  /** 当前用户价格覆盖（只读副本）。 */
  getOverrides(): Readonly<PriceTable> {
    return { ...this.overrides }
  }

  /** 当前生效的价格表快照。 */
  get currentSheet(): PriceSheet {
    return this.sheet
  }

  /** 官方页最近一次给出不同价格的时间（undefined = 从未）。 */
  get lastChangedAt(): number | undefined {
    return this.changedAt
  }

  /** 当前生效的高峰时段窗口（分时计划优先，缺省官方约定窗口）。 */
  activePeakWindows(): ReadonlyArray<readonly [number, number]> {
    const scheduled = this.sheet.scheduled
    if (scheduled !== undefined && scheduled.peakWindows !== undefined && scheduled.peakWindows.length > 0) {
      return scheduled.peakWindows
    }
    return DEFAULT_PEAK_WINDOWS
  }

  /**
   * 恢复持久化的价格表快照（重启后首次抓取成功前沿用上次官方价格）。
   * 仅接受结构合法的快照；内置快照不被空表覆盖。
   */
  loadPersistedSheet(raw: unknown): boolean {
    const sheet = sanitizePriceSheet(raw)
    if (sheet === undefined) return false
    this.sheet = sheet
    return true
  }

  /** 一次调用在某时刻的费用（元）：解析单价并经 costOf 计算。 */
  costOfCall(model: string, usage: UsageLike, atMs: number): number {
    return costOf(this.resolve(model, atMs), usage)
  }

  /**
   * 某模型在某时刻的单价。优先级：用户覆盖 > DeepSeek 实时/内置表 >
   * 厂商实时表（自动导入的新模型）> 内置目录精确 > 最长前缀匹配
   * （覆盖 `glm-4.6-250414` 这类带日期快照名）。undefined 表示无价可计。
   */
  resolve(model: string, atMs: number): ModelPrice | undefined {
    const id = model.trim().toLowerCase()
    const override = this.overrides[id] ?? matchByPrefix(this.overrides, id)
    if (override !== undefined) return override
    const deepseek = resolvePrice(this.sheet, id, atMs)
    if (deepseek !== undefined) return deepseek
    const vendor = vendorOf(id)
    if (vendor !== undefined) {
      const live = this.vendorLive.get(vendor)
      if (live !== undefined) {
        const hit = live.table[id] ?? matchByPrefix(live.table, id)
        if (hit !== undefined) return hit
      }
    }
    return CATALOG_TABLE[id] ?? matchByPrefix(CATALOG_TABLE, id)
  }

  /** 按厂商分组的全部已知定价（供面板与报表）。 */
  vendorPricing(atMs: number): VendorPricing[] {
    const result: VendorPricing[] = []
    const seen = new Set<string>()
    // DeepSeek 优先：其数字来自官方页实时抓取。
    const deepseekModels: PriceTable = { ...resolveTable(this.sheet, atMs) }
    for (const key of Object.keys(this.overrides)) {
      if (vendorOf(key) === 'deepseek') deepseekModels[key] = this.overrides[key]!
    }
    result.push({
      id: 'deepseek',
      label: VENDORS.deepseek!.label,
      pricingUrl: this.sheet.sourceUrl ?? VENDORS.deepseek!.pricingUrl,
      tiered: false,
      source: this.sheet.source === 'live' ? 'live' : 'builtin',
      fetchedAt: this.sheet.fetchedAt,
      models: deepseekModels,
    })
    seen.add('deepseek')
    // 其余国产厂商：实时抓取表优先，目录兜底。
    for (const [vendorId, info] of Object.entries(VENDORS)) {
      if (seen.has(vendorId)) continue
      seen.add(vendorId)
      const live = this.vendorLive.get(vendorId)
      const models: PriceTable = {}
      const base = live !== undefined ? live.table : CATALOG_TABLE
      for (const [key, price] of Object.entries(base)) {
        if (vendorOf(key) === vendorId) models[key] = price
      }
      let source: VendorPricing['source'] = live !== undefined ? 'live' : 'builtin'
      for (const [key, price] of Object.entries(this.overrides)) {
        if (vendorOf(key) === vendorId) {
          models[key] = price
          source = 'override'
        }
      }
      if (Object.keys(models).length > 0) {
        result.push({
          id: vendorId,
          label: info.label,
          pricingUrl: info.pricingUrl,
          tiered: info.tiered ?? false,
          source,
          fetchedAt: live?.fetchedAt,
          models,
        })
      }
    }
    // 不属于任何已知厂商的覆盖（自定义模型）。
    const rest: PriceTable = {}
    for (const [key, price] of Object.entries(this.overrides)) {
      if (vendorOf(key) === undefined) rest[key] = price
    }
    if (Object.keys(rest).length > 0) {
      result.push({ id: 'custom', label: '自定义模型', pricingUrl: '', tiered: false, source: 'override', models: rest })
    }
    return result
  }

  /**
   * 抓取解析官方页；失败时保留上一份有效表。
   * 检测官方价格变更并显式记录，使公布的调价在下一次轮询即被自动采纳。
   */
  async refresh(): Promise<void> {
    try {
      const html = await fetchText(this.pricingUrl, this.timeoutMs)
      const next = parsePriceSheet(html, this.pricingUrl)
      if (canonicalSheet(next) !== canonicalSheet(this.sheet)) {
        this.sheet = next
        this.changedAt = next.fetchedAt ?? Date.now()
        this.log.info(`companion-pricing: 官方定价已更新，新价格生效: ${summarizeSheet(next)}`)
        this.onChanged?.(this.sheet)
      } else {
        // 元数据（fetchedAt/source）在页面未变时仍前进。
        this.sheet = next
      }
    } catch (error) {
      this.log.warn(`companion-pricing: pricing refresh failed, keeping ${this.sheet.source} sheet: ${String(error)}`)
    }
  }

  /**
   * 抓取某厂商的官方定价数据并自动导入其列出的全部带价模型。
   * 新模型与调价被显式记录；失败（网络、纯 JS 页）保留上一份表不变。
   *
   * 按 fetchKind 分派：
   *  - kimi-rsc: Kimi 客户端渲染文档；价格在 /pricing/chat* 子页的 RSC payload；
   *  - ernie-cdn: 百度 CDN page-data JSON（cloud.baidu.com 重置 TLS）；
   *  - zhipu-bundle: 智谱 SPA 壳；旗舰价内嵌 app.*.js，旧模型走公开运营位接口；
   *  - doubao-md: 火山文档中心接口返回服务端 Markdown；
   *  - html（缺省）: 定价页 HTML 的通用表格解析。
   */
  async refreshVendor(vendorId: string): Promise<void> {
    const info = VENDORS[vendorId]
    if (info === undefined) return
    try {
      const table = await this.fetchVendorTable(vendorId)
      if (Object.keys(table).length === 0) {
        this.log.warn(`companion-pricing: ${info.label} 定价页未解析出价格表（可能是动态渲染页面），沿用现有价格`)
        return
      }
      const prev = this.vendorLive.get(vendorId)?.table ?? {}
      const notes = diffTable(prev, table)
      this.vendorLive.set(vendorId, { table, fetchedAt: Date.now() })
      if (notes.length > 0) {
        this.changedAt = Date.now()
        this.log.info(`companion-pricing: ${info.label} 官方定价已更新: ${notes.join('；')}`)
      }
    } catch (error) {
      this.log.warn(`companion-pricing: ${info.label} 定价抓取失败，沿用现有价格: ${String(error)}`)
    }
  }

  /** 按 fetchKind 抓取解析某厂商的定价数据。 */
  private async fetchVendorTable(vendorId: string): Promise<PriceTable> {
    const info = VENDORS[vendorId]!
    const kind = info.fetchKind ?? 'html'
    if (kind === 'ernie-cdn') {
      const json = JSON.parse(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })) as {
        result?: { data?: { markdownRemark?: { html?: string } } }
      }
      return parseErnieSheet(json.result?.data?.markdownRemark?.html ?? '')
    }
    if (kind === 'kimi-rsc') {
      const base = info.dataSource ?? info.pricingUrl
      const rscHeaders = { 'user-agent': BROWSER_UA, RSC: '1' }
      // 子页在索引页以 href:`/pricing/xxx` 列出。
      const index = await fetchText(base + 'chat', this.timeoutMs, rscHeaders)
      const pages = [...new Set([...index.matchAll(/href:`(\/pricing\/[\w-]+)`/g)].map((m) => m[1] ?? ''))].filter(
        (p) => p !== '/pricing/chat',
      )
      const table: PriceTable = {}
      for (const page of pages) {
        const payload = await fetchText('https://platform.kimi.com/docs' + page, this.timeoutMs, rscHeaders)
        Object.assign(table, parseKimiSheet(payload))
      }
      // 索引页自身也可能携带表格。
      Object.assign(table, parseKimiSheet(index))
      return table
    }
    if (kind === 'zhipu-bundle') {
      const table: PriceTable = {}
      // 现役旗舰模型位于 SPA 的 app.*.js 包内；包名携带部署哈希，从壳页发现。
      try {
        const shell = await fetchText(info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })
        const bundleUrl = shell.match(/src="(https:\/\/static\.bigmodel\.cn\/wd-paas-front\/js\/app\.[\w.]+\.js)"/)?.[1]
        if (bundleUrl !== undefined) {
          Object.assign(table, parseZhipuBundleSheet(await fetchText(bundleUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })))
        }
      } catch (error) {
        this.log.warn(`companion-pricing: 智谱 JS 包价格解析失败，仅用运营位接口: ${String(error)}`)
      }
      // 旧模型（GLM-4 代及更早）来自公开运营位接口（dataSource）；旧模型不覆盖包内价。
      const legacy = parseZhipuLegacySheet(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA }))
      for (const [model, price] of Object.entries(legacy)) {
        if (table[model] === undefined) table[model] = price
      }
      return table
    }
    if (kind === 'doubao-md') {
      const json = JSON.parse(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })) as {
        Result?: { MDContent?: string }
      }
      return parseDoubaoSheet(json.Result?.MDContent ?? '')
    }
    const html = await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })
    return parseVendorSheet(html, vendorId)
  }

  /** 刷新 DeepSeek 与全部其他厂商的官方定价页。 */
  async refreshAll(): Promise<void> {
    await this.refresh()
    for (const vendorId of Object.keys(VENDORS)) {
      if (vendorId === 'deepseek') continue
      await this.refreshVendor(vendorId)
    }
  }
}

/** 某时刻下生效的平价表（分时计划感知）。 */
function resolveTable(sheet: PriceSheet, atMs: number): PriceTable {
  if (sheet.scheduled !== undefined && beijingDayKey(atMs) >= sheet.scheduled.effective) {
    return isPeakTimeAt(atMs, sheet.scheduled.peakWindows ?? DEFAULT_PEAK_WINDOWS)
      ? sheet.scheduled.peak
      : sheet.scheduled.offPeak
  }
  return sheet.current
}
