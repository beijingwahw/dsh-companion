/**
 * 成本报表视图页（模块 C 客户端 UI，挂载于 conversation.view）——详尽可视化面板：
 * - GET /cost/state 与 GET /cost/report?from&to（默认近 7 天，可切换 7/28 天）；
 * - 汇总卡片：调用数、Token 总量、费用、节省金额、延迟执行数、缓存命中率、
 *   日均费用、峰值日（后四项从报表数据派生）；
 * - 预算控制：日/月双档进度条（80% 黄、100% 红）+ 在途预授权合计展示；
 * - 每日 Token/费用条形图：Token 柱拆分为输入（实心）/输出（半透明）堆叠；
 * - 每日费用与节省对比图：费用柱（品牌色）与节省柱（绿色）并排；
 * - 模型费用排行：byModel 聚合的水平占比条（Top 7 + 其他合计）；
 * - 缓存命中结构：命中（绿）/未命中（品牌色）水平堆叠条 + 命中率；
 * - 动态计价信息区：定价来源、抓取时间、峰谷 24 小时时间轴（高峰段高亮）、
 *   多厂商定价概览（厂商 + 模型数 + live/builtin/override 来源徽章），
 *   支持手动触发官方定价页刷新；
 * - 开发者模式总开关与 API Key 管理；峰谷调度、模型路由开关；
 * - 每 60s 轮询 /cost/state，paused 变化时 Toast 预警。
 * 全部图表为纯 CSS（div 宽高比例），不依赖任何图表库。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Pill,
  Spinner,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchCostReport,
  fetchCostState,
  refreshCostPricing,
  removeCostApiKey,
  saveCostApiKey,
  testCostCall,
  updateCostSettings,
} from '../api.js'
import type { CostReportResponse, CostSettingsPatch, CostState } from '../api.js'
import styles from './CostReportView.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface CostReportViewProps {
  readonly sessionId?: string
}

/** 报表区间档位（天）。 */
type RangeDays = 7 | 28

/** /cost/state 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 60_000

/** 本地日期 → YYYY-MM-DD（服务端按北京时间聚合，客户端以本地日期近似）。 */
function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 计算近 N 天的 [from, to] 区间。 */
function rangeFor(days: RangeDays): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - (days - 1) * 86_400_000)
  return { from: dayKey(from), to: dayKey(to) }
}

/** 金额格式化（元，保留 4 位小数）。 */
function formatCny(value: number): string {
  return `¥${value.toFixed(4)}`
}

/**
 * 浅比较 CostState 的关键字段（视图实际渲染的字段）：
 * 轮询返回的数据若无变化则跳过 setState，避免无谓的重渲染。
 * rules/pricing 本视图不渲染，不参与比较。
 */
function isCostStateEqual(prev: CostState, next: CostState): boolean {
  return (
    prev.devMode === next.devMode &&
    prev.apiKeyConfigured === next.apiKeyConfigured &&
    prev.peakScheduling === next.peakScheduling &&
    prev.modelRouting === next.modelRouting &&
    prev.budget.dailyCny === next.budget.dailyCny &&
    prev.budget.dailySpentCny === next.budget.dailySpentCny &&
    prev.budget.dailyRatio === next.budget.dailyRatio &&
    prev.budget.monthlyCny === next.budget.monthlyCny &&
    prev.budget.spentCny === next.budget.spentCny &&
    prev.budget.ratio === next.budget.ratio &&
    prev.budget.paused === next.budget.paused &&
    prev.pricing.source === next.pricing.source &&
    prev.pricing.fetchedAt === next.pricing.fetchedAt &&
    prev.pricing.lastChangedAt === next.pricing.lastChangedAt
  )
}

/** 成本报表视图页。 */
export function CostReportView(_props: CostReportViewProps): ReactElement {
  const [costState, setCostState] = useState<CostState | null>(null)
  const [stateError, setStateError] = useState('')
  const [report, setReport] = useState<CostReportResponse | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')
  const [rangeDays, setRangeDays] = useState<RangeDays>(7)
  const [apiKey, setApiKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [deletingKey, setDeletingKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')
  const [dailyBudgetInput, setDailyBudgetInput] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [refreshingPricing, setRefreshingPricing] = useState(false)

  /** 上一次观察到的 paused 状态；null 表示尚未建立基线。 */
  const pausedRef = useRef<boolean | null>(null)

  /** 拉取成本状态；silent 用于轮询（失败不打扰用户）。检测 paused 变化并 Toast 预警。
   *
   * - signal 中止（卸载）后静默返回，不再更新状态；
   * - setState 前对关键字段浅比较，无变化不触发重渲染。
   */
  const loadState = useCallback(async (silent: boolean, signal?: AbortSignal): Promise<void> => {
    try {
      const next = await fetchCostState({ signal })
      if (signal?.aborted) return
      setCostState((prev) => (prev !== null && isCostStateEqual(prev, next) ? prev : next))
      setStateError('')
      const prev = pausedRef.current
      pausedRef.current = next.budget.paused
      if (prev !== null && prev !== next.budget.paused) {
        if (next.budget.paused) {
          Toast.push('预警：月度预算已用尽，Companion 已暂停 API 调用', 'error')
        } else {
          Toast.push('预算限制已解除，Companion 恢复 API 调用', 'success')
        }
      }
    } catch (error) {
      if (signal?.aborted) return
      if (!silent) setStateError(error instanceof Error ? error.message : '成本状态加载失败')
    }
  }, [])

  // 挂载：加载状态，并启动链式轮询——上一次请求完成后再 setTimeout 排下一次，
  // 避免 setInterval 在慢响应下堆积并发请求；卸载时 abort 在途请求并清理定时器。
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    let timer = 0
    const poll = async (silent: boolean): Promise<void> => {
      await loadState(silent, controller.signal)
      if (cancelled || controller.signal.aborted) return
      timer = window.setTimeout(() => void poll(true), POLL_INTERVAL_MS)
    }
    void poll(false)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadState])

  // 区间变化时重新加载报表：cancelled 守卫 + abort，快速切换 7/28 天时旧响应不会覆盖新结果。
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setReportLoading(true)
    setReportError('')
    fetchCostReport(rangeFor(rangeDays), { signal: controller.signal })
      .then((response) => {
        if (!cancelled) setReport(response)
      })
      .catch((error: unknown) => {
        if (!cancelled) setReportError(error instanceof Error ? error.message : '成本报表加载失败')
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [rangeDays])

  /** 提交设置补丁并刷新状态。 */
  const applySettings = useCallback(
    async (patch: CostSettingsPatch, successMessage: string): Promise<void> => {
      setSavingSettings(true)
      try {
        await updateCostSettings(patch)
        Toast.push(successMessage, 'success')
        await loadState(true)
      } catch (error) {
        Toast.push(error instanceof Error ? error.message : '设置保存失败', 'error')
      } finally {
        setSavingSettings(false)
      }
    },
    [loadState],
  )

  /** 切换布尔设置（开发者模式 / 峰谷调度 / 模型路由）。 */
  const handleToggle = useCallback(
    (key: 'devMode' | 'peakScheduling' | 'modelRouting', value: boolean): void => {
      const patch: CostSettingsPatch =
        key === 'devMode'
          ? { devMode: value }
          : key === 'peakScheduling'
            ? { peakScheduling: value }
            : { modelRouting: value }
      void applySettings(patch, '设置已更新')
    },
    [applySettings],
  )

  /** 保存月度预算。 */
  const handleSaveBudget = useCallback((): void => {
    const value = Number(budgetInput)
    if (!Number.isFinite(value) || value < 0) {
      Toast.push('请输入有效的月度预算金额（元，非负数）', 'warning')
      return
    }
    void applySettings({ monthlyBudgetCny: value }, '月度预算已更新')
  }, [budgetInput, applySettings])

  /** 保存日预算。 */
  const handleSaveDailyBudget = useCallback((): void => {
    const value = Number(dailyBudgetInput)
    if (!Number.isFinite(value) || value < 0) {
      Toast.push('请输入有效的日预算金额（元，非负数）', 'warning')
      return
    }
    void applySettings({ dailyBudgetCny: value }, '日预算已更新')
  }, [dailyBudgetInput, applySettings])

  /** 手动触发官方定价页刷新（DeepSeek + 全部国产厂商）。 */
  const handleRefreshPricing = useCallback(async (): Promise<void> => {
    setRefreshingPricing(true)
    try {
      const view = await refreshCostPricing()
      Toast.push(
        view.source === 'live'
          ? '官方定价页已刷新，价格为最新实时数据'
          : '官方定价页抓取失败，当前沿用内置/上次有效价格',
        view.source === 'live' ? 'success' : 'warning',
      )
      await loadState(true)
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '定价刷新失败', 'error')
    } finally {
      setRefreshingPricing(false)
    }
  }, [loadState])

  /** 保存 API Key（服务端加密落盘，响应不回传明文）。 */
  const handleSaveApiKey = useCallback(async (): Promise<void> => {
    const value = apiKey.trim()
    if (!value) {
      Toast.push('请输入 API Key', 'warning')
      return
    }
    setSavingKey(true)
    try {
      await saveCostApiKey(value)
      Toast.push('API Key 已加密保存', 'success')
      setApiKey('')
      await loadState(true)
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : 'API Key 保存失败', 'error')
    } finally {
      setSavingKey(false)
    }
  }, [apiKey, loadState])

  /** 删除已保存的 API Key。 */
  const handleDeleteApiKey = useCallback(async (): Promise<void> => {
    setDeletingKey(true)
    try {
      await removeCostApiKey()
      Toast.push('API Key 已删除', 'success')
      await loadState(true)
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : 'API Key 删除失败', 'error')
    } finally {
      setDeletingKey(false)
    }
  }, [loadState])

  /** 用当前 Key 发起最小测试调用。 */
  const handleTestCall = useCallback(async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await testCostCall()
      Toast.push(`连接成功：${result.model}（延迟 ${result.latencyMs}ms）`, 'success')
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '测试调用失败', 'error')
    } finally {
      setTesting(false)
    }
  }, [])

  // ---------------------------------------------------------------------
  // 派生展示数据
  // ---------------------------------------------------------------------

  const budget = costState?.budget
  const ratio = budget && budget.monthlyCny > 0 ? budget.spentCny / budget.monthlyCny : 0
  const dailyRatio = budget && budget.dailyCny > 0 ? budget.dailySpentCny / budget.dailyCny : 0
  /** 进度条样式档位：80% 黄、100% 红。 */
  const barClassOf = (r: number): string =>
    r >= 1 ? styles.progressDanger : r >= 0.8 ? styles.progressWarning : styles.progressNormal

  const pricing = costState?.pricing
  const pricingSourceText =
    pricing === undefined
      ? ''
      : pricing.source === 'live'
        ? '官方定价页实时抓取'
        : '内置快照'
  const pricingFetchedText =
    pricing?.fetchedAt !== undefined ? new Date(pricing.fetchedAt).toLocaleString('zh-CN') : ''
  const peakWindowsText =
    pricing?.scheduled !== undefined && pricing.scheduled !== null
      ? (pricing.scheduled.peakWindows ?? [[9, 12], [14, 18]])
          .map(([start, end]) => `${start}:00-${end}:00`)
          .join('、')
      : ''

  const days = report?.days ?? []
  const maxTokens = Math.max(1, ...days.map((d) => d.promptTokens + d.completionTokens))
  const maxCost = Math.max(0.0001, ...days.map((d) => d.costCny))
  const maxSaved = Math.max(0.0001, ...days.map((d) => d.savedCny))
  /** 有调用的天数（日均费用的分母，空天数不计）。 */
  const activeDayCount = days.filter((d) => d.calls > 0).length

  /** 汇总卡片：调用数 / Token / 费用 / 节省 / 延迟 + 派生指标（缓存命中率、日均费用、峰值日）。 */
  const summaryCards: ReadonlyArray<{ readonly label: string; readonly value: string }> = report
    ? [
        { label: '调用数', value: `${report.total.calls}` },
        {
          label: 'Token 总量',
          value: (report.total.promptTokens + report.total.completionTokens).toLocaleString('zh-CN'),
        },
        { label: '费用（元）', value: formatCny(report.total.costCny) },
        { label: '节省金额（元）', value: formatCny(report.total.savedCny) },
        { label: '延迟执行数', value: `${report.total.deferredCalls}` },
        {
          label: '缓存命中率',
          value:
            report.total.promptTokens > 0
              ? `${Math.round((report.total.cacheHitTokens / report.total.promptTokens) * 1000) / 10}%`
              : '—',
        },
        {
          label: '日均费用（元）',
          value: activeDayCount > 0 ? formatCny(report.total.costCny / activeDayCount) : '—',
        },
        {
          label: '峰值日',
          value:
            days.length > 0
              ? `${days.reduce((a, b) => (b.costCny > a.costCny ? b : a)).day.slice(5)}（${formatCny(
                  days.reduce((a, b) => (b.costCny > a.costCny ? b : a)).costCny,
                )}）`
              : '—',
        },
      ]
    : []

  /** 缓存命中结构（输入 Token 的命中/未命中占比）。 */
  const cacheHit =
    report && report.total.promptTokens > 0
      ? {
          hit: report.total.cacheHitTokens,
          miss: report.total.promptTokens - report.total.cacheHitTokens,
          rate: report.total.cacheHitTokens / report.total.promptTokens,
        }
      : null

  /** 模型费用聚合行（byModel 跨天累加，按费用降序）。 */
  interface ModelRow {
    readonly model: string
    readonly calls: number
    readonly tokens: number
    readonly costCny: number
  }
  const modelAgg = new Map<string, { calls: number; tokens: number; costCny: number }>()
  for (const day of days) {
    for (const [model, slice] of Object.entries(day.byModel)) {
      const entry = modelAgg.get(model) ?? { calls: 0, tokens: 0, costCny: 0 }
      entry.calls += slice.calls
      entry.tokens += slice.promptTokens + slice.completionTokens
      entry.costCny += slice.costCny
      modelAgg.set(model, entry)
    }
  }
  const modelList: readonly ModelRow[] = [...modelAgg.entries()]
    .map(([model, agg]) => ({ model, ...agg }))
    .sort((a, b) => b.costCny - a.costCny)
  /** 排行榜展示上限：Top 7 + 其余合并为「其他」。 */
  const MODEL_RANK_LIMIT = 7
  const modelTop = modelList.slice(0, MODEL_RANK_LIMIT)
  const modelRest = modelList.slice(MODEL_RANK_LIMIT)
  const modelRows: readonly ModelRow[] =
    modelRest.length > 0
      ? [
          ...modelTop,
          {
            model: `其他（${modelRest.length} 个模型）`,
            calls: modelRest.reduce((sum, row) => sum + row.calls, 0),
            tokens: modelRest.reduce((sum, row) => sum + row.tokens, 0),
            costCny: modelRest.reduce((sum, row) => sum + row.costCny, 0),
          },
        ]
      : modelTop
  const maxModelCost = Math.max(0.0001, ...modelRows.map((row) => row.costCny))
  const totalModelCost = Math.max(0.0001, modelList.reduce((sum, row) => sum + row.costCny, 0))

  /** 峰谷时间轴（24 格，每格 1 小时；窗口支持小数小时，按覆盖判定）。 */
  const peakWindows =
    pricing?.scheduled !== undefined && pricing.scheduled !== null
      ? (pricing.scheduled.peakWindows ?? [[9, 12], [14, 18]])
      : null
  const peakHours: readonly boolean[] =
    peakWindows !== null
      ? Array.from({ length: 24 }, (_, hour) =>
          peakWindows.some(([start, end]) => (start <= end ? hour >= start && hour < end : hour >= start || hour < end)),
        )
      : []

  /** 多厂商定价概览行（pricing.vendors 面板数据）。 */
  const vendorRows: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly count: number
    readonly source: 'live' | 'builtin' | 'override'
  }> =
    pricing?.vendors.map((vendor) => ({
      id: vendor.id,
      label: vendor.label,
      count: Object.keys(vendor.models).length,
      source: vendor.source,
    })) ?? []

  const devMode = costState?.devMode ?? false

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h2 className={styles.title}>API 成本报表</h2>
        <div className={styles.rangeToggle}>
          <Button
            size="sm"
            variant={rangeDays === 7 ? 'primary' : 'ghost'}
            onClick={() => setRangeDays(7)}
          >
            近 7 天
          </Button>
          <Button
            size="sm"
            variant={rangeDays === 28 ? 'primary' : 'ghost'}
            onClick={() => setRangeDays(28)}
          >
            近 28 天
          </Button>
        </div>
      </header>

      {/* 已有状态数据时才在顶部显示错误行；尚无数据时的错误在设置区展示（含重试按钮） */}
      {costState && stateError ? <div className={styles.error}>{stateError}</div> : null}

      {/* 汇总卡片 */}
      {reportLoading && !report ? <Spinner label="加载报表…" /> : null}
      {reportError ? <div className={styles.error}>{reportError}</div> : null}
      {report ? (
        <div className={styles.cards}>
          {summaryCards.map((card) => (
            <div key={card.label} className={styles.card}>
              <span className={styles.cardValue}>{card.value}</span>
              <span className={styles.cardLabel}>{card.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 预算进度（日/月双档） */}
      {budget ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            预算控制
            {budget.paused ? <Pill className={styles.pausedBadge}>已暂停调用</Pill> : null}
          </h3>

          {/* 在途预授权（调用期权协议的预留合计，从可用额度中锁定） */}
          {budget.reservedCny !== undefined && budget.reservedCny > 0 ? (
            <div className={styles.hint}>
              在途调用预授权：{formatCny(budget.reservedCny)}（该额度已被进行中的 API 调用预留锁定）
            </div>
          ) : null}

          {/* 日预算档 */}
          <div className={styles.budgetRow}>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${barClassOf(dailyRatio)}`}
                style={{ width: `${Math.min(100, Math.max(0, dailyRatio * 100))}%` }}
              />
            </div>
            <span className={styles.budgetText}>
              今日已用 {formatCny(budget.dailySpentCny)} / 日预算 {formatCny(budget.dailyCny)}
              {budget.dailyCny > 0 ? `（${Math.round(dailyRatio * 1000) / 10}%）` : '（未设置）'}
            </span>
          </div>
          <div className={styles.budgetEdit}>
            <Input
              className={styles.budgetInput}
              type="number"
              value={dailyBudgetInput}
              onChange={(event) => setDailyBudgetInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !savingSettings && dailyBudgetInput.length > 0) {
                  handleSaveDailyBudget()
                }
              }}
              placeholder={`当前日预算 ${budget.dailyCny} 元（0=不限），输入新日预算…`}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSaveDailyBudget}
              disabled={savingSettings || dailyBudgetInput.length === 0}
            >
              {savingSettings ? <Spinner label="保存中…" /> : '保存日预算'}
            </Button>
          </div>

          {/* 月预算档 */}
          <div className={styles.budgetRow}>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${barClassOf(ratio)}`}
                style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
              />
            </div>
            <span className={styles.budgetText}>
              本月已用 {formatCny(budget.spentCny)} / 月预算 {formatCny(budget.monthlyCny)}
              {budget.monthlyCny > 0 ? `（${Math.round(ratio * 1000) / 10}%）` : '（未设置）'}
            </span>
          </div>
          <div className={styles.budgetEdit}>
            <Input
              className={styles.budgetInput}
              type="number"
              value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter 快捷提交：与“保存预算”按钮等价
                if (event.key === 'Enter' && !savingSettings && budgetInput.length > 0) {
                  handleSaveBudget()
                }
              }}
              placeholder={`当前月预算 ${budget.monthlyCny} 元（0=不限），输入新月预算…`}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSaveBudget}
              disabled={savingSettings || budgetInput.length === 0}
            >
              {savingSettings ? <Spinner label="保存中…" /> : '保存月预算'}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 每日费用与节省对比（费用柱品牌色 + 节省柱绿色） */}
      {report ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>每日费用与节省</h3>
          <div className={styles.chartLegend}>
            <span>
              <i className={`${styles.legendDot} ${styles.legendTokens}`} />
              实际费用（元）
            </span>
            <span>
              <i className={`${styles.legendDot} ${styles.legendCost}`} />
              节省金额（元）
            </span>
          </div>
          {days.length === 0 ? (
            <div className={styles.empty}>该时间范围内暂无用量记录</div>
          ) : (
            <div className={styles.chart}>
              {days.map((day) => {
                const costPct = Math.round((day.costCny / maxCost) * 100)
                const savedPct = Math.round((day.savedCny / maxSaved) * 100)
                return (
                  <div
                    key={day.day}
                    className={styles.chartDay}
                    title={`${day.day}：费用 ${formatCny(day.costCny)} / 节省 ${formatCny(day.savedCny)} / 延迟执行 ${day.deferredCalls} 次`}
                  >
                    <div className={styles.chartBars}>
                      <div className={styles.barTokens} style={{ height: `${costPct}%` }} />
                      <div className={styles.barCost} style={{ height: `${savedPct}%` }} />
                    </div>
                    <span className={styles.chartLabel}>{day.day.slice(5)}</span>
                  </div>
                )
              })}
            </div>
          )}
          {report.total.savedCny > 0 ? (
            <div className={styles.hint}>
              区间累计节省 {formatCny(report.total.savedCny)}
              （模型路由改用更经济的模型 + 峰谷调度延迟至空闲时段）
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 模型费用排行（byModel 聚合的水平占比条） */}
      {report && modelRows.length > 0 ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>模型费用排行</h3>
          {modelRows.map((row) => {
            const widthPct = Math.max(2, Math.round((row.costCny / maxModelCost) * 100))
            const share = Math.round((row.costCny / totalModelCost) * 1000) / 10
            return (
              <div
                key={row.model}
                className={styles.modelRow}
                title={`${row.model}：费用 ${formatCny(row.costCny)} / 调用 ${row.calls} 次 / Token ${row.tokens.toLocaleString('zh-CN')}`}
              >
                <span className={styles.modelName}>{row.model}</span>
                <div className={styles.modelBarTrack}>
                  <div className={styles.modelBar} style={{ width: `${widthPct}%` }} />
                </div>
                <span className={styles.modelStats}>
                  {formatCny(row.costCny)} · {row.calls} 次 · {share}%
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      {/* 缓存命中结构（输入 Token 命中/未命中占比） */}
      {cacheHit ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            缓存命中
            <span className={styles.cacheRate}>{Math.round(cacheHit.rate * 1000) / 10}%</span>
          </h3>
          <div className={styles.cacheTrack}>
            <div className={styles.cacheHit} style={{ width: `${cacheHit.rate * 100}%` }} />
          </div>
          <div className={styles.cacheLegend}>
            <span>
              <i className={`${styles.legendDot} ${styles.legendCost}`} />
              命中 {cacheHit.hit.toLocaleString('zh-CN')} tokens（按折扣价计费）
            </span>
            <span>
              <i className={`${styles.legendDot} ${styles.legendTokens}`} />
              未命中 {cacheHit.miss.toLocaleString('zh-CN')} tokens（按全价计费）
            </span>
          </div>
        </div>
      ) : null}

      {/* 动态计价信息（官方定价页实时抓取 + 峰谷分时） */}
      {pricing ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>动态计价</h3>
          <div className={styles.statusRow}>
            定价来源：
            {pricing.source === 'live' ? (
              <Pill className={styles.okBadge}>官方实时</Pill>
            ) : (
              <Pill className={styles.warnBadge}>内置快照</Pill>
            )}
            {pricingFetchedText ? <span className={styles.hint}>抓取于 {pricingFetchedText}</span> : null}
          </div>
          {pricing.scheduled !== null ? (
            <>
              <div className={styles.hint}>
                峰谷分时定价自 {pricing.scheduled.effective} 生效
                {peakWindowsText ? `（北京时间高峰 ${peakWindowsText} 按高峰价计费）` : ''}
              </div>
              {/* 峰谷 24 小时时间轴：高峰格品牌色高亮，支持跨午夜窗口 */}
              <div className={styles.timeline}>
                <div className={styles.timelineTrack}>
                  {peakHours.map((isPeak, hour) => (
                    <div
                      key={hour}
                      className={isPeak ? styles.timelinePeak : styles.timelineOff}
                      title={`${hour}:00 - ${hour + 1}:00（北京时间）${isPeak ? ' · 高峰' : ' · 空闲'}`}
                    />
                  ))}
                </div>
                <div className={styles.timelineScale}>
                  <span>0 点</span>
                  <span>6 点</span>
                  <span>12 点</span>
                  <span>18 点</span>
                  <span>24 点</span>
                </div>
              </div>
            </>
          ) : null}
          <div className={styles.hint}>
            每小时自动抓取 DeepSeek 与国产厂商官方定价页，新模型与调价自动导入；缓存命中按折扣价计费。
          </div>
          {/* 多厂商定价概览：厂商 + 已收录模型数 + 来源徽章 */}
          {vendorRows.length > 0 ? (
            <div className={styles.vendorGrid}>
              {vendorRows.map((vendor) => (
                <div key={vendor.id} className={styles.vendorItem}>
                  <span className={styles.vendorName}>{vendor.label}</span>
                  <span className={styles.vendorCount}>{vendor.count} 个模型</span>
                  {vendor.source === 'live' ? (
                    <Pill className={styles.okBadge}>官方实时</Pill>
                  ) : vendor.source === 'override' ? (
                    <Pill className={styles.pausedBadge}>自定义</Pill>
                  ) : (
                    <Pill className={styles.warnBadge}>内置快照</Pill>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <div className={styles.budgetEdit}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleRefreshPricing()}
              disabled={refreshingPricing}
            >
              {refreshingPricing ? <Spinner label="刷新中…" /> : '立即刷新官方定价'}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 每日 Token / 费用条形图（Token 柱拆分输入/输出堆叠；纯 CSS，高度按比例） */}
      {report ? (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>每日 Token / 费用</h3>
          <div className={styles.chartLegend}>
            <span>
              <i className={`${styles.legendDot} ${styles.legendTokens}`} />
              输入 Token
            </span>
            <span>
              <i className={`${styles.legendDot} ${styles.legendTokensOut}`} />
              输出 Token
            </span>
            <span>
              <i className={`${styles.legendDot} ${styles.legendCost}`} />
              费用（元）
            </span>
          </div>
          {days.length === 0 ? (
            <div className={styles.empty}>该时间范围内暂无用量记录</div>
          ) : (
            <div className={styles.chart}>
              {days.map((day) => {
                const tokens = day.promptTokens + day.completionTokens
                const tokenPct = Math.round((tokens / maxTokens) * 100)
                const costPct = Math.round((day.costCny / maxCost) * 100)
                const inPct = tokens > 0 ? (day.promptTokens / tokens) * tokenPct : 0
                const outPct = tokens > 0 ? (day.completionTokens / tokens) * tokenPct : 0
                return (
                  <div
                    key={day.day}
                    className={styles.chartDay}
                    title={`${day.day}：输入 ${day.promptTokens.toLocaleString('zh-CN')} / 输出 ${day.completionTokens.toLocaleString('zh-CN')} tokens / 费用 ${formatCny(day.costCny)} / 调用 ${day.calls} 次`}
                  >
                    <div className={styles.chartBars}>
                      {/* 堆叠 Token 柱：输出段在上（半透明）、输入段在下（实心） */}
                      <div className={styles.barTokensStack}>
                        <div className={styles.barTokensOut} style={{ height: `${outPct}%` }} />
                        <div className={styles.barTokens} style={{ height: `${inPct}%` }} />
                      </div>
                      <div className={styles.barCost} style={{ height: `${costPct}%` }} />
                    </div>
                    <span className={styles.chartLabel}>{day.day.slice(5)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 设置区 */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>成本优化设置</h3>
        {costState ? (
          <div className={styles.settings}>
            <Checkbox
              checked={costState.devMode}
              disabled={savingSettings}
              onChange={(checked) => handleToggle('devMode', checked)}
              label="开发者模式（总开关：API Key 管理与调度设置）"
            />

            {!devMode ? (
              <div className={styles.hint}>开发者模式已关闭：API Key 管理与调度设置不可用。</div>
            ) : (
              <>
                <div className={styles.subSection}>
                  <div className={styles.subTitle}>API Key 管理</div>
                  <div className={styles.statusRow}>
                    状态：
                    {costState.apiKeyConfigured ? (
                      <Pill className={styles.okBadge}>已配置</Pill>
                    ) : (
                      <Pill className={styles.warnBadge}>未配置</Pill>
                    )}
                  </div>
                  <div className={styles.apiKeyRow}>
                    <Input
                      className={styles.apiKeyInput}
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={costState.apiKeyConfigured ? '输入新 Key 以覆盖…' : 'sk-…'}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSaveApiKey()}
                      disabled={savingKey || apiKey.length === 0}
                    >
                      {savingKey ? <Spinner label="保存中…" /> : '保存'}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void handleDeleteApiKey()}
                      disabled={deletingKey || !costState.apiKeyConfigured}
                    >
                      {deletingKey ? <Spinner label="删除中…" /> : '删除'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleTestCall()}
                      disabled={testing || !costState.apiKeyConfigured}
                    >
                      {testing ? <Spinner label="测试中…" /> : '测试连接'}
                    </Button>
                  </div>
                  <div className={styles.hint}>Key 仅以 AES-256-GCM 加密保存在本地，不会出现在任何响应与日志中。</div>
                </div>

                <div className={styles.subSection}>
                  <div className={styles.subTitle}>调度与路由</div>
                  <Checkbox
                    checked={costState.peakScheduling}
                    disabled={savingSettings}
                    onChange={(checked) => handleToggle('peakScheduling', checked)}
                    label="峰谷调度（高峰时段延迟非紧急调用至空闲时段）"
                  />
                  <Checkbox
                    checked={costState.modelRouting}
                    disabled={savingSettings}
                    onChange={(checked) => handleToggle('modelRouting', checked)}
                    label="模型路由（按任务复杂度选择更经济的模型）"
                  />
                </div>
              </>
            )}
          </div>
        ) : stateError ? (
          // 初次 /cost/state 失败：显示错误提示 + 重试按钮，而不是永久 Spinner
          <div className={styles.error}>
            <span>{stateError}</span>
            <Button variant="ghost" size="sm" onClick={() => void loadState(false)}>
              重试
            </Button>
          </div>
        ) : (
          <Spinner label="加载成本状态…" />
        )}
      </div>
    </div>
  )
}
