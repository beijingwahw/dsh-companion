/**
 * 模块 C：API 成本优化（cost）插件入口（开发者模式）。
 *
 * 职责：
 * - 注册 companion.cost 设置（schemastery，applies: 'live'）；
 * - 挂载 CostGatewayService 策略层服务（ctx.companionCost）；
 * - HTTP 端点：state / api-key / settings / report / test-call /
 *   pricing / pricing/refresh（经 ctx.companion.http 挂载）；
 * - 命令 `usage`：本月用量文本报告；
 * - 动态计价引擎接线（吸收自 dsh-usage-ledger）：
 *   启动时恢复持久化价格快照与用户覆盖 → 立即刷新官方定价页 →
 *   按 config.pricingRefreshIntervalMin 周期刷新（DeepSeek + 全部国产厂商）→
 *   官方价格变化时持久化新快照。
 *
 * 安全红线：API Key 只经 ctx.companion.setApiKey 写入（加密落盘）；
 * 任何响应不含 Key 明文（/cost/state 只回 apiKeyConfigured 布尔）。
 * 所有注册均为 effect，随 Cordis fiber 生命周期自动回卷。
 */
import type { Context } from '@deepseek-ai/cordis'
import { DeepSeekApiError, type ChatMessage } from '../../core/deepseek.js'
import { HttpError, sendJson } from '../../core/http.js'
import type { ModelPrice, PriceTable } from '../../core/price/types.js'
import { beijingDayKey, beijingMonthKey } from '../../core/time.js'
import { CostGatewayService } from './gateway.js'
import { compileCustomRules, MAX_CUSTOM_RULES, MAX_RULE_PATTERN_LENGTH } from './router.js'
import { registerCostSettings, type CostCustomRule, type CostSettings } from './settings.js'

/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-cost'

/** 依赖声明：核心服务 + 设置 + 命令面板。 */
export const inject = ['companion', 'settings', 'commands']

/** cost-extra 表中 pricing 覆盖的键。 */
const COST_EXTRA_PRICING_KEY = 'pricing'

/** cost-extra 表中官方价格快照的键。 */
const COST_EXTRA_SHEET_KEY = 'price-sheet'

/** 报表缺省天数（含今天）。 */
const REPORT_DEFAULT_DAYS = 7

/** 插件入口。 */
export function apply(ctx: Context): void {
  // 1. 注册设置，取得命名空间作用域。
  const scope = registerCostSettings(ctx)

  // 2. 启动时恢复动态计价引擎状态（cost-extra 表）：
  //    a. 上次持久化的官方价格快照（重启后首次抓取成功前沿用官方价）；
  //    b. 用户自定义单价覆盖（→ ctx.companion.setPricingOverrides）。
  //    随后立即刷新一次官方定价页（DeepSeek + 全部国产厂商）。
  ctx.effect(() => {
    let active = true
    void ctx.companion.ready
      .then(({ domain }) => {
        if (!active) return
        const extra = domain.table<unknown>('cost-extra')
        ctx.companion.prices.loadPersistedSheet(extra.get(COST_EXTRA_SHEET_KEY))
        const overrides = sanitizeOverrides(extra.get(COST_EXTRA_PRICING_KEY))
        if (Object.keys(overrides).length > 0) {
          ctx.companion.setPricingOverrides(overrides)
        }
        // 官方价格内容变化时持久化新快照（静默降级：失败仅丢失下次
        // 重启后的“沿用上次官方价”能力，不影响实时计价）。
        ctx.companion.prices.onChanged = (sheet) => {
          void ctx.companion.ready
            .then(({ domain: d }) => d.table<unknown>('cost-extra').put(COST_EXTRA_SHEET_KEY, sheet))
            .catch(() => undefined)
        }
        void ctx.companion.prices.refreshAll()
      })
      .catch(() => {
        // 存储域初始化失败：计价恢复静默降级（核心服务已发 notice），
        // 避免悬挂 Promise 产生未处理 rejection（对齐 search 模块写法）。
      })
    return () => {
      active = false
      ctx.companion.prices.onChanged = undefined
    }
  }, 'companion.cost-pricing-restore')

  // 3. 官方定价页周期刷新：DeepSeek 官方页 + 全部国产厂商定价页，
  //    新模型与调价自动导入；定时器随 fiber 卸载清理。
  ctx.effect(() => {
    const intervalMs = Math.max(5, ctx.companion.config.pricingRefreshIntervalMin) * 60_000
    const timer = setInterval(() => {
      void ctx.companion.prices.refreshAll()
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'companion.cost-pricing-refresh')

  // 4. 挂载成本网关服务（提供 ctx.companionCost）。
  ctx.plugin(CostGatewayService, () => scope.get())

  // ------------------------------------------------------------------
  // HTTP 端点（注册即 effect）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/cost/state', async (_req, res) => {
        const settings = scope.get()
        const gateway = ctx.get('companionCost')
        if (!gateway) throw new HttpError('成本网关尚未就绪', 503)
        const budget = await gateway.budgetState()
        const apiKey = await ctx.companion.getApiKey()
        sendJson(res, 200, {
          devMode: settings.devMode,
          // 安全红线：只回布尔，不回 Key 明文。
          apiKeyConfigured: apiKey !== undefined,
          peakScheduling: settings.peakScheduling,
          modelRouting: settings.modelRouting,
          budget,
          rules: settings.customRules,
          pricing: pricingView(),
        })
      }),
    'companion.cost-http-state',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/cost/api-key', async (_req, res, { body }) => {
        const record = readObject(body)
        const apiKey = requireString(record.apiKey, 'apiKey')
        await ctx.companion.setApiKey(apiKey)
        sendJson(res, 200, { ok: true })
      }),
    'companion.cost-http-set-api-key',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('DELETE', '/cost/api-key', async (_req, res) => {
        await ctx.companion.clearApiKey()
        sendJson(res, 200, { ok: true })
      }),
    'companion.cost-http-clear-api-key',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/cost/settings', async (_req, res, { body }) => {
        const record = readObject(body)
        // 稀疏补丁：只更新出现的字段。
        const patch: Partial<CostSettings> = {}
        if (record.devMode !== undefined) patch.devMode = requireBoolean(record.devMode, 'devMode')
        if (record.peakScheduling !== undefined) {
          patch.peakScheduling = requireBoolean(record.peakScheduling, 'peakScheduling')
        }
        if (record.modelRouting !== undefined) {
          patch.modelRouting = requireBoolean(record.modelRouting, 'modelRouting')
        }
        if (record.dailyBudgetCny !== undefined) {
          patch.dailyBudgetCny = requireBudgetCny(record.dailyBudgetCny, 'dailyBudgetCny')
        }
        if (record.monthlyBudgetCny !== undefined) {
          patch.monthlyBudgetCny = requireBudgetCny(record.monthlyBudgetCny, 'monthlyBudgetCny')
        }
        if (record.rules !== undefined) patch.customRules = parseRules(record.rules)
        await scope.update(patch)
        // pricing 覆盖不属于设置 schema：持久化到 cost-extra 并应用到动态计价引擎。
        if (record.pricing !== undefined) {
          const overrides = parsePricing(record.pricing)
          const { domain } = await ctx.companion.ready
          await domain
            .table<Record<string, ModelPrice>>('cost-extra')
            .put(COST_EXTRA_PRICING_KEY, overrides)
          ctx.companion.setPricingOverrides(overrides)
        }
        sendJson(res, 200, { ok: true })
      }),
    'companion.cost-http-settings',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/cost/report', async (_req, res, { query }) => {
        const { usage } = await ctx.companion.ready
        const today = beijingDayKey(Date.now())
        const to = parseDayParam(query.get('to') ?? undefined, today, 'to')
        const from = parseDayParam(
          query.get('from') ?? undefined,
          beijingDayKey(Date.now() - (REPORT_DEFAULT_DAYS - 1) * 86_400_000),
          'from',
        )
        if (from > to) throw new HttpError('from 不能晚于 to', 400)
        const days = usage.range(from, to)
        sendJson(res, 200, { days, total: usage.total(days) })
      }),
    'companion.cost-http-report',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/cost/test-call', async (_req, res) => {
        const messages: readonly ChatMessage[] = [{ role: 'user', content: '你好' }]
        try {
          // 最小调用验证 Key 有效性（限制补全长度以控制验证成本）。
          const result = await ctx.companion.callDeepSeek({
            messages,
            model: 'deepseek-chat',
            maxTokens: 16,
            source: 'cost-test',
          })
          sendJson(res, 200, {
            ok: true,
            model: result.model || 'deepseek-chat',
            latencyMs: result.latencyMs,
          })
        } catch (error) {
          if (error instanceof DeepSeekApiError) {
            throw new HttpError(error.message, error.status ?? 400)
          }
          throw error
        }
      }),
    'companion.cost-http-test-call',
  )

  // 动态计价引擎面板数据：全部厂商定价（官方实时/内置快照/自定义）+
  // 峰谷分时计划 + 用户覆盖。
  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/cost/pricing', async (_req, res) => {
        sendJson(res, 200, pricingView())
      }),
    'companion.cost-http-pricing',
  )

  // 手动触发官方定价页刷新（DeepSeek + 全部国产厂商），返回刷新后的面板数据。
  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/cost/pricing/refresh', async (_req, res) => {
        await ctx.companion.prices.refreshAll()
        sendJson(res, 200, pricingView())
      }),
    'companion.cost-http-pricing-refresh',
  )

  // ------------------------------------------------------------------
  // 命令面板
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'usage',
        description: '输出本月 API 用量文本报告',
        handler: async () => {
          const { usage } = await ctx.companion.ready
          const now = Date.now()
          const total = usage.total(usage.month(now))
          const lines: string[] = [
            `本月用量（${beijingMonthKey(now)}，北京时间）：`,
            `- 调用次数：${total.calls}`,
            `- 输入 tokens：${total.promptTokens}（其中缓存命中 ${total.cacheHitTokens}）`,
            `- 输出 tokens：${total.completionTokens}`,
            `- 费用合计：¥${total.costCny.toFixed(4)}`,
            `- 估算节省：¥${total.savedCny.toFixed(4)}（峰谷延迟 ${total.deferredCalls} 次）`,
          ]
          const settings = scope.get()
          if (settings.dailyBudgetCny > 0) {
            const today = usage.total(usage.range(beijingDayKey(now), beijingDayKey(now)))
            const percent = Math.round((today.costCny / settings.dailyBudgetCny) * 100)
            lines.push(`- 今日预算：¥${settings.dailyBudgetCny.toFixed(2)}（已用 ${percent}%）`)
          }
          if (settings.monthlyBudgetCny > 0) {
            const percent = Math.round((total.costCny / settings.monthlyBudgetCny) * 100)
            lines.push(`- 月度预算：¥${settings.monthlyBudgetCny.toFixed(2)}（已用 ${percent}%）`)
          }
          const sheet = ctx.companion.prices.currentSheet
          lines.push(
            `- 计价来源：${sheet.source === 'live' ? '官方定价页实时抓取' : '内置快照'}${
              sheet.fetchedAt !== undefined ? `（${new Date(sheet.fetchedAt).toLocaleString('zh-CN')}）` : ''
            }`,
          )
          return { kind: 'success', text: lines.join('\n') }
        },
      }),
    'companion.cost-usage-command',
  )

  /** 动态计价引擎面板数据（/cost/state 与 /cost/pricing 共用）。 */
  function pricingView(): Record<string, unknown> {
    const prices = ctx.companion.prices
    const sheet = prices.currentSheet
    return {
      source: sheet.source,
      sourceUrl: sheet.sourceUrl,
      fetchedAt: sheet.fetchedAt,
      lastChangedAt: prices.lastChangedAt,
      scheduled: sheet.scheduled ?? null,
      overrides: prices.getOverrides(),
      vendors: prices.vendorPricing(Date.now()),
    }
  }
}

// --------------------------------------------------------------------
// 请求体收窄辅助（unknown → 具体形状；strict 下不用 any）
// --------------------------------------------------------------------

/** 将请求体收窄为 JSON 对象，否则 400。 */
function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(`${field} 必须是非空字符串`, 400)
  }
  return value.trim()
}

/** 读取必填布尔字段。 */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(`${field} 必须是布尔值`, 400)
  }
  return value
}

/** 读取预算金额：有限非负数字（0=不限）。 */
function requireBudgetCny(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HttpError(`${field} 必须是非负数字（0=不限）`, 400)
  }
  return value
}

/**
 * 解析自定义路由规则数组：
 * 规则数 ≤ MAX_CUSTOM_RULES、pattern 长度 ≤ MAX_RULE_PATTERN_LENGTH，
 * 并预编译全部正则做合法性校验——编译失败即拒绝保存（400），
 * 从入口遏制用户自定义正则的 ReDoS 风险。
 */
function parseRules(value: unknown): CostCustomRule[] {
  if (!Array.isArray(value)) {
    throw new HttpError('rules 必须是数组', 400)
  }
  const list = value as unknown[]
  if (list.length > MAX_CUSTOM_RULES) {
    throw new HttpError(`rules 数量不能超过 ${MAX_CUSTOM_RULES} 条`, 400)
  }
  const rules: CostCustomRule[] = []
  for (let index = 0; index < list.length; index += 1) {
    const raw: unknown = list[index]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new HttpError(`rules[${index}] 必须是对象`, 400)
    }
    const entry = raw as Record<string, unknown>
    const pattern = entry.pattern
    const model = entry.model
    if (typeof pattern !== 'string' || !pattern.trim() || typeof model !== 'string' || !model.trim()) {
      throw new HttpError(`rules[${index}] 必须包含非空的 pattern 与 model`, 400)
    }
    const trimmedPattern = pattern.trim()
    if (trimmedPattern.length > MAX_RULE_PATTERN_LENGTH) {
      throw new HttpError(
        `rules[${index}].pattern 长度不能超过 ${MAX_RULE_PATTERN_LENGTH} 字符`,
        400,
      )
    }
    rules.push({ pattern: trimmedPattern, model: model.trim() })
  }
  // 预编译校验：任一 pattern 不是合法正则即拒绝保存。
  try {
    compileCustomRules(rules)
  } catch (error) {
    throw new HttpError(
      `rules 包含非法正则 pattern：${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  return rules
}

/**
 * 解析 pricing 覆盖表（模型名 → 单价）。
 * 新形状：{ inputCacheHit, inputMiss, output }（元/百万 tokens）；
 * 兼容旧形状：{ inputPerMillionCny, outputPerMillionCny,
 * cacheHitInputPerMillionCny }（历史持久化数据与旧客户端）。
 */
function parsePricing(value: unknown): PriceTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError('pricing 必须是“模型名 → 计费信息”的对象', 400)
  }
  const record = value as Record<string, unknown>
  const result: PriceTable = {}
  for (const [model, raw] of Object.entries(record)) {
    result[model] = parseModelPrice(raw, model)
  }
  return result
}

/** 解析单个模型的单价条目（新形状优先，旧形状兜底转换）。 */
function parseModelPrice(raw: unknown, model: string): ModelPrice {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(`pricing[${model}] 必须是对象`, 400)
  }
  const entry = raw as Record<string, unknown>
  // 新形状：inputMiss/output 必填，inputCacheHit 缺省 0。
  if (entry.inputMiss !== undefined || entry.output !== undefined) {
    const inputMiss = entry.inputMiss
    const output = entry.output
    if (typeof inputMiss !== 'number' || typeof output !== 'number' || inputMiss < 0 || output < 0) {
      throw new HttpError(`pricing[${model}] 缺少合法的 inputMiss/output`, 400)
    }
    const cacheHit = entry.inputCacheHit
    if (cacheHit !== undefined && (typeof cacheHit !== 'number' || cacheHit < 0)) {
      throw new HttpError(`pricing[${model}].inputCacheHit 必须是非负数字`, 400)
    }
    return { inputCacheHit: cacheHit ?? 0, inputMiss, output }
  }
  // 旧形状（兼容历史数据）：inputPerMillionCny/outputPerMillionCny。
  const input = entry.inputPerMillionCny
  const output = entry.outputPerMillionCny
  if (typeof input !== 'number' || typeof output !== 'number' || input < 0 || output < 0) {
    throw new HttpError(`pricing[${model}] 缺少合法的 inputMiss/output（或旧字段 inputPerMillionCny/outputPerMillionCny）`, 400)
  }
  const cacheHit = entry.cacheHitInputPerMillionCny
  if (cacheHit !== undefined && (typeof cacheHit !== 'number' || cacheHit < 0)) {
    throw new HttpError(`pricing[${model}].cacheHitInputPerMillionCny 必须是非负数字`, 400)
  }
  return { inputCacheHit: cacheHit ?? input, inputMiss: input, output }
}

/** 启动恢复路径的覆盖表收窄：静默丢弃非法条目（区别于保存入口的 400）。 */
function sanitizeOverrides(raw: unknown): PriceTable {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const table: PriceTable = {}
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    try {
      table[model] = parseModelPrice(value, model)
    } catch {
      // 非法条目静默丢弃：启动恢复不因历史脏数据失败。
    }
  }
  return table
}

/**
 * 解析报表日期参数（YYYY-MM-DD）；缺省回退默认值。
 * 解析后回验历法合法性（getUTCMonth/getUTCDate 与输入一致），
 * 拒绝 2024-13-40 这类会被 Date 静默规范化的非法日期。
 */
function parseDayParam(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined || value === '') return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(`${field} 必须是 YYYY-MM-DD 格式`, 400)
  }
  const [year, month, day] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new HttpError(`${field} 不是合法日期：${value}`, 400)
  }
  return value
}
