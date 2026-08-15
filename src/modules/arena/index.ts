/**
 * 模块 G：多模型竞技场（arena）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * - GET  /arena/models       模型目录（含外部厂商 Key 配置状态）；
 * - POST /arena/keys         保存外部厂商 API Key（AES-256-GCM 加密落盘）；
 * - DELETE /arena/keys       删除外部厂商 API Key；
 * - POST /arena/compare      G1 同 Prompt 多模型并行对比（最多 5 个模型）；
 * - POST /arena/leaderboard  G2 批量评测排行榜（JSON/JSONL 测试集，
 *                            准确率/延迟分位/Token/成本/合规率，报告 MD/HTML）；
 * - GET  /arena/recommend    G3 模型推荐引擎（任务类型+预算+延迟+峰谷感知）。
 *
 * 外部厂商调用走 OpenAI 兼容 chat/completions 协议；baseUrl 可随 Key 一并
 * 配置（指向任意兼容网关）。安全红线：任何响应不回传 Key 明文。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { round4, tokenUsageToUsageLike } from '../../core/pricing.js'
import {
  ARENA_MODEL_CATALOG,
  recommendModels,
  taskTypeLabel,
  type ArenaModelInfo,
  type TaskType,
} from './catalog.js'

/** 插件名。 */
export const name = 'companion-arena'

/** 依赖服务：companion 根服务。 */
export const inject = ['companion']

/** G1 并行对比的模型数上限。 */
const MAX_COMPARE_MODELS = 5

/** G2 批量评测的用例数上限。 */
const MAX_LEADERBOARD_CASES = 30

/** 推荐引擎估算单次成本用的典型用量（计价引擎 UsageLike 形状）。 */
const TYPICAL_USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 }

/** 外部厂商 Key 在保险库中的秘密名前缀。 */
const ARENA_KEY_SECRET_PREFIX = 'arena-key:'

/** 单模型运行结果。 */
interface ArenaRunResult {
  readonly model: string
  readonly ok: boolean
  readonly output: string
  readonly latencyMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costCny: number
  readonly error?: string
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  /** 最近一次评测结果缓存（供导出复用，避免重跑评测）。 */
  let lastLeaderboard: { rows: LeaderboardRow[]; caseCount: number } | undefined

  // ------------------------------------------------------------------
  // GET /arena/models：模型目录 + Key 配置状态
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/arena/models', async (_req, res) => {
        const { vault } = await ctx.companion.ready
        sendJson(res, 200, {
          models: ARENA_MODEL_CATALOG.map((model) => ({
            id: model.id,
            label: model.label,
            provider: model.provider,
            latencyTier: model.latencyTier,
            accuracyPrior: model.accuracyPrior,
            keyConfigured:
              model.provider === 'deepseek'
                ? undefined
                : vault.hasSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}`),
          })),
        })
      }),
    'companion.arena-http-models',
  )

  // ------------------------------------------------------------------
  // POST /arena/keys：保存外部厂商 Key（加密落盘）
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/arena/keys', async (_req, res, { body }) => {
        const record = readObject(body)
        const modelId = requireString(record.modelId, 'modelId')
        const apiKey = requireString(record.apiKey, 'apiKey')
        const model = ARENA_MODEL_CATALOG.find((m) => m.id === modelId)
        if (!model || model.provider !== 'external') {
          throw new HttpError(`模型 ${modelId} 不是外部厂商模型`, 400)
        }
        const { vault } = await ctx.companion.ready
        await vault.setSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}`, apiKey)
        if (typeof record.baseUrl === 'string' && record.baseUrl.trim()) {
          await vault.setSecret(
            `${ARENA_KEY_SECRET_PREFIX}${modelId}:base-url`,
            record.baseUrl.trim(),
          )
        }
        sendJson(res, 200, { ok: true })
      }),
    'companion.arena-http-set-keys',
  )

  // ------------------------------------------------------------------
  // DELETE /arena/keys：删除外部厂商 Key
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('DELETE', '/arena/keys', async (_req, res, { body }) => {
        const record = readObject(body)
        const modelId = requireString(record.modelId, 'modelId')
        const { vault } = await ctx.companion.ready
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}`)
        await vault.deleteSecret(`${ARENA_KEY_SECRET_PREFIX}${modelId}:base-url`)
        sendJson(res, 200, { ok: true })
      }),
    'companion.arena-http-clear-keys',
  )

  // ------------------------------------------------------------------
  // POST /arena/compare：G1 同 Prompt 多模型并行对比
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/arena/compare', async (_req, res, { body }) => {
        const record = readObject(body)
        const prompt = requireString(record.prompt, 'prompt')
        const modelIds = parseStringArray(record.models, 'models')
        if (modelIds.length === 0) throw new HttpError('models 不能为空', 400)
        if (modelIds.length > MAX_COMPARE_MODELS) {
          throw new HttpError(`最多同时对比 ${MAX_COMPARE_MODELS} 个模型`, 400)
        }
        const results = await Promise.all(
          modelIds.map((modelId) => runOneModel(ctx, modelId, prompt)),
        )
        sendJson(res, 200, { prompt, results })
      }),
    'companion.arena-http-compare',
  )

  // ------------------------------------------------------------------
  // POST /arena/leaderboard：G2 批量评测排行榜
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/arena/leaderboard', async (_req, res, { body }) => {
        const record = readObject(body)

        // 导出走缓存（useCache）：直接基于最近一次评测结果生成报告，不重跑评测。
        // 该分支无需 models/cases，必须先于其校验执行。
        if (record.useCache === true && (record.format === 'markdown' || record.format === 'html')) {
          if (!lastLeaderboard) throw new HttpError('暂无评测结果可导出，请先运行评测', 400)
          sendJson(res, 200, {
            format: record.format,
            fileName: `arena-leaderboard-${Date.now()}.${record.format === 'html' ? 'html' : 'md'}`,
            content:
              record.format === 'html'
                ? buildLeaderboardHtml(lastLeaderboard.rows, lastLeaderboard.caseCount)
                : buildLeaderboardMarkdown(lastLeaderboard.rows, lastLeaderboard.caseCount),
          })
          return
        }

        const modelIds = parseStringArray(record.models, 'models')
        if (modelIds.length === 0) throw new HttpError('models 不能为空', 400)
        if (modelIds.length > MAX_COMPARE_MODELS) {
          throw new HttpError(`最多同时评测 ${MAX_COMPARE_MODELS} 个模型`, 400)
        }
        const cases = parseTestCases(record.cases)
        if (cases.length === 0) throw new HttpError('cases 不能为空', 400)
        if (cases.length > MAX_LEADERBOARD_CASES) {
          throw new HttpError(`测试用例不能超过 ${MAX_LEADERBOARD_CASES} 条`, 400)
        }

        const rows = []
        for (const modelId of modelIds) {
          const runs: ArenaRunResult[] = []
          for (const testCase of cases) {
            runs.push(await runOneModel(ctx, modelId, testCase.input))
          }
          rows.push(buildLeaderboardRow(modelId, cases, runs))
        }
        rows.sort((a, b) => b.compositeScore - a.compositeScore)
        // 缓存最近一次评测结果，供导出复用。
        lastLeaderboard = { rows, caseCount: cases.length }

        if (record.format === 'markdown' || record.format === 'html') {
          sendJson(res, 200, {
            format: record.format,
            fileName: `arena-leaderboard-${Date.now()}.${record.format === 'html' ? 'html' : 'md'}`,
            content:
              record.format === 'html'
                ? buildLeaderboardHtml(rows, cases.length)
                : buildLeaderboardMarkdown(rows, cases.length),
          })
          return
        }
        sendJson(res, 200, { format: 'json', rows })
      }),
    'companion.arena-http-leaderboard',
  )

  // ------------------------------------------------------------------
  // GET /arena/recommend：G3 模型推荐引擎
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/arena/recommend', (_req, res, { query }) => {
        const taskType = parseTaskType(query.get('taskType'))
        const budgetRaw = query.get('budgetPerCallCny')
        const budgetPerCallCny = budgetRaw === null ? 0 : Number(budgetRaw)
        if (!Number.isFinite(budgetPerCallCny) || budgetPerCallCny < 0) {
          throw new HttpError('budgetPerCallCny 必须是非负数字', 400)
        }
        const latency = query.get('latency')
        const latencyRequirement =
          latency === 'fast' || latency === 'balanced' ? latency : 'any'

        // 以典型用量估算各模型单次成本（动态计价引擎，峰谷感知）。
        const now = Date.now()
        const costPerCall: Record<string, number> = {}
        for (const model of ARENA_MODEL_CATALOG) {
          const cost = ctx.companion.prices.costOfCall(model.id, TYPICAL_USAGE, now)
          costPerCall[model.id] = round4(cost)
        }
        const recommendations = recommendModels(
          { taskType, budgetPerCallCny, latencyRequirement },
          costPerCall,
          now,
        )
        sendJson(res, 200, {
          taskType,
          taskTypeLabel: taskTypeLabel(taskType),
          recommendations: recommendations.map((rec) => ({
            model: rec.model.id,
            label: rec.model.label,
            score: round4(rec.score),
            reason: rec.reason,
            estimatedCostCny: costPerCall[rec.model.id] ?? 0,
          })),
        })
      }),
    'companion.arena-http-recommend',
  )
}

/** 运行单个模型（DeepSeek 走核心服务记账，外部厂商走兼容协议直连）。 */
async function runOneModel(ctx: Context, modelId: string, prompt: string): Promise<ArenaRunResult> {
  const model = ARENA_MODEL_CATALOG.find((m) => m.id === modelId)
  const startedAt = Date.now()
  if (!model) {
    return failureResult(modelId, startedAt, `未知模型：${modelId}`)
  }
  try {
    if (model.provider === 'deepseek') {
      const result = await ctx.companion.callDeepSeek({
        messages: [{ role: 'user', content: prompt }],
        model: model.id,
        source: 'arena',
      })
      const costCny = round4(
        ctx.companion.prices.costOfCall(
          result.model || model.id,
          tokenUsageToUsageLike(result.usage),
          Date.now(),
        ),
      )
      return {
        model: model.id,
        ok: true,
        output: result.content,
        latencyMs: result.latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costCny,
      }
    }
    return await runExternalModel(ctx, model, prompt, startedAt)
  } catch (error) {
    return failureResult(modelId, startedAt, error instanceof Error ? error.message : String(error))
  }
}

/** 外部厂商：OpenAI 兼容 chat/completions 直连（Key 从保险库解析）。 */
async function runExternalModel(
  ctx: Context,
  model: ArenaModelInfo,
  prompt: string,
  startedAt: number,
): Promise<ArenaRunResult> {
  const { vault } = await ctx.companion.ready
  const apiKey = await vault.getSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}`)
  if (!apiKey) {
    return failureResult(model.id, startedAt, `尚未配置 ${model.label} 的 API Key`)
  }
  const baseUrl =
    (await vault.getSecret(`${ARENA_KEY_SECRET_PREFIX}${model.id}:base-url`)) ??
    model.baseUrl ??
    ''
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(ctx.companion.config.apiTimeoutMs),
  })
  if (!response.ok) {
    return failureResult(model.id, startedAt, `HTTP ${response.status}`)
  }
  const json = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[]
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    return failureResult(model.id, startedAt, '响应缺少 choices[0].message.content')
  }
  const promptTokens = toNonNegative(json.usage?.prompt_tokens)
  const completionTokens = toNonNegative(json.usage?.completion_tokens)
  // 外部厂商费用经动态计价引擎估算（目录未收录时成本为 0）。
  const costCny = round4(
    ctx.companion.prices.costOfCall(
      model.id,
      { inputTokens: promptTokens, outputTokens: completionTokens },
      Date.now(),
    ),
  )
  return {
    model: model.id,
    ok: true,
    output: content,
    latencyMs: Date.now() - startedAt,
    promptTokens,
    completionTokens,
    costCny,
  }
}

/** 失败结果构造。 */
function failureResult(model: string, startedAt: number, error: string): ArenaRunResult {
  return {
    model,
    ok: false,
    output: '',
    latencyMs: Date.now() - startedAt,
    promptTokens: 0,
    completionTokens: 0,
    costCny: 0,
    error,
  }
}

/** 测试用例（G2）。 */
interface TestCase {
  readonly input: string
  /** 期望输出（提供后按 judge 规则自动评分）。 */
  readonly expected?: string
  /** exact=完全一致；contains=包含子串；缺省 contains。 */
  readonly judge?: 'exact' | 'contains'
}

/** 解析测试集：JSON 数组或 JSONL 字符串。 */
function parseTestCases(raw: unknown): TestCase[] {
  let items: unknown[]
  if (typeof raw === 'string') {
    // JSONL：每行一个 JSON 对象。
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    items = []
    for (const line of lines) {
      try {
        items.push(JSON.parse(line))
      } catch {
        throw new HttpError(`JSONL 解析失败：${line.slice(0, 60)}…`, 400)
      }
    }
  } else if (Array.isArray(raw)) {
    items = raw
  } else {
    throw new HttpError('cases 必须是 JSON 数组或 JSONL 字符串', 400)
  }
  return items.map((item, index) => {
    if (typeof item === 'string') return { input: item }
    if (typeof item !== 'object' || item === null) {
      throw new HttpError(`cases[${index}] 必须是字符串或对象`, 400)
    }
    const record = item as Record<string, unknown>
    if (typeof record.input !== 'string' || !record.input.trim()) {
      throw new HttpError(`cases[${index}].input 必须是非空字符串`, 400)
    }
    const testCase: TestCase = { input: record.input }
    if (typeof record.expected === 'string') {
      return {
        ...testCase,
        expected: record.expected,
        judge: record.judge === 'exact' ? 'exact' : 'contains',
      }
    }
    return testCase
  })
}

/** 排行榜行。 */
interface LeaderboardRow {
  readonly model: string
  readonly successRate: number
  readonly accuracy: number | null
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly avgTokens: number
  readonly costPerTaskCny: number
  readonly complianceRate: number | null
  readonly compositeScore: number
}

/** 汇总单模型的评测行。 */
function buildLeaderboardRow(
  modelId: string,
  cases: readonly TestCase[],
  runs: readonly ArenaRunResult[],
): LeaderboardRow {
  const okRuns = runs.filter((run) => run.ok)
  const latencies = okRuns.map((run) => run.latencyMs).sort((a, b) => a - b)

  // 准确率：仅统计提供了 expected 的用例。
  const judged = cases
    .map((testCase, index) => ({ testCase, run: runs[index] }))
    .filter(({ testCase, run }) => testCase.expected !== undefined && run.ok)
  const accuracy =
    judged.length > 0
      ? judged.filter(({ testCase, run }) => judgeOutput(run.output, testCase.expected ?? '', testCase.judge)).length /
        judged.length
      : null

  // 结构化合规率：输出为合法 JSON 的比例（仅当全部期望输出都是 JSON 时统计）。
  const expectsJson = judged.length > 0 && judged.every(({ testCase }) => looksLikeJson(testCase.expected ?? ''))
  const complianceRate = expectsJson && okRuns.length > 0
    ? okRuns.filter((run) => looksLikeJson(run.output)).length / okRuns.length
    : null

  const avgTokens =
    okRuns.length > 0
      ? Math.round(okRuns.reduce((sum, run) => sum + run.promptTokens + run.completionTokens, 0) / okRuns.length)
      : 0
  const totalCost = okRuns.reduce((sum, run) => sum + run.costCny, 0)

  // 综合得分：准确率 0.4 + 成功率 0.2 + 延迟 0.2 + 成本 0.2（各自归一）。
  const maxCost = Math.max(1e-9, ...runs.map((run) => run.costCny))
  const maxLatency = Math.max(1, ...latencies)
  const compositeScore = round4(
    (accuracy ?? 0.5) * 0.4 +
      (okRuns.length / Math.max(1, runs.length)) * 0.2 +
      (latencies.length > 0 ? 1 - percentile(latencies, 50) / maxLatency : 0.5) * 0.2 +
      (1 - totalCost / Math.max(1e-9, maxCost * runs.length)) * 0.2,
  )

  return {
    model: modelId,
    successRate: runs.length > 0 ? okRuns.length / runs.length : 0,
    accuracy,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    avgTokens,
    costPerTaskCny: round4(runs.length > 0 ? totalCost / runs.length : 0),
    complianceRate,
    compositeScore,
  }
}

/** 自动评分：exact=完全一致（去首尾空白），contains=包含子串。 */
function judgeOutput(output: string, expected: string, judge?: 'exact' | 'contains'): boolean {
  if (judge === 'exact') return output.trim() === expected.trim()
  return output.includes(expected)
}

/** 文本是否形似 JSON（对象或数组）。 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/** 百分位数（输入需已升序排序）。 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

/** 排行榜 Markdown 报告。 */
function buildLeaderboardMarkdown(rows: readonly LeaderboardRow[], caseCount: number): string {
  const lines: string[] = [
    '# 多模型评测排行榜',
    '',
    `- 测试用例数：${caseCount}`,
    `- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 排名 | 模型 | 综合得分 | 成功率 | 准确率 | P50/P95/P99 | 平均Token | 单任务成本 | 合规率 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.model} | ${row.compositeScore.toFixed(3)} | ${(row.successRate * 100).toFixed(0)}% | ${row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`} | ${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms | ${row.avgTokens} | ¥${row.costPerTaskCny.toFixed(4)} | ${row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`} |`,
    )
  })
  return lines.join('\n')
}

/** 排行榜 HTML 报告（自包含）。 */
function buildLeaderboardHtml(rows: readonly LeaderboardRow[], caseCount: number): string {
  const bodyRows = rows
    .map(
      (row, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(row.model)}</td><td>${row.compositeScore.toFixed(3)}</td><td>${(row.successRate * 100).toFixed(0)}%</td><td>${row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`}</td><td>${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms</td><td>${row.avgTokens}</td><td>¥${row.costPerTaskCny.toFixed(4)}</td><td>${row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`}</td></tr>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>多模型评测排行榜</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px}
table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;font-size:13px}
th{background:#f6f8fa}
.meta{color:#57606a;font-size:13px}
</style>
</head>
<body>
<h1>多模型评测排行榜</h1>
<p class="meta">测试用例数：${caseCount} · 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>
<table>
<thead><tr><th>排名</th><th>模型</th><th>综合得分</th><th>成功率</th><th>准确率</th><th>P50/P95/P99</th><th>平均Token</th><th>单任务成本</th><th>合规率</th></tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</body>
</html>`
}

/** HTML 转义。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 解析任务类型参数。 */
function parseTaskType(value: string | null): TaskType {
  if (value === 'code' || value === 'translation' || value === 'summarization' || value === 'reasoning' || value === 'general') {
    return value
  }
  return 'general'
}

/** 非负数字收窄。 */
function toNonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 将请求体收窄为 JSON 对象。 */
function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 读取必填非空字符串字段。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(`${field} 必须是非空字符串`, 400)
  }
  return value.trim()
}

/** 解析字符串数组。 */
function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(`${field} 必须是字符串数组`, 400)
  const result: string[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new HttpError(`${field} 必须全部为非空字符串`, 400)
    }
    result.push(item.trim())
  }
  return result
}
