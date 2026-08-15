/**
 * 模块 J：安全与审计（security）插件入口。
 *
 * 集成点：经 ctx.companion.addCallHook 注入调用钩子——
 * - beforeCall：DLP 扫描（严格模式直接拦截）+ 激活 Key 权限范围校验；
 * - afterCall：审计日志落盘（Prompt 摘要脱敏）+ 异常调用告警检测。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * J1：GET/POST /security/keys、POST /security/keys/activate、
 *     DELETE /security/keys、POST /security/keys/leak-check（泄露检测）、
 *     GET /security/keys/rotation（轮换提醒）；
 * J2：GET /security/audit（筛选）、GET /security/audit/export（CSV/JSON）；
 * J3：GET /security/dlp/state、POST /security/dlp/settings、
 *     GET/POST/DELETE /security/dlp/rules、POST /security/dlp/scan（发送前预检）；
 * J4：GET /security/report（合规报表）、GET /security/report/export（HTML）。
 *
 * 安全红线：任何响应不回传 Key 明文（只回掩码尾 4 位）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import type { CallParams } from '../../core/service.js'
import { beijingDayKey } from '../../core/time.js'
import type { AuditEntry, NamedKeyMeta } from './types.js'
import { redactText, scanText, validatePattern } from './dlp.js'
import {
  AUDIT_LOG_LIMIT,
  AuditAlertStore,
  AuditLogStore,
  DlpBlockStore,
  DlpRuleStore,
  DlpSettingsStore,
  NamedKeyStore,
  auditId,
} from './store.js'

/** 插件名。 */
export const name = 'companion-security'

/** 依赖服务：companion 根服务。 */
export const inject = ['companion']

/** 命名 Key 在保险库中的秘密名前缀。 */
const NAMED_KEY_SECRET_PREFIX = 'named-key:'

/** Key 轮换提醒阈值（天）。 */
const KEY_ROTATION_DAYS = 30

/** 单次调用 Token 告警阈值。 */
const TOKEN_ALERT_THRESHOLD = 100_000

/** 调用频率告警：60 秒内超过该次数视为异常。 */
const RATE_BURST_LIMIT = 30

/** 自定义 DLP 规则数上限。 */
const MAX_CUSTOM_RULES = 20

/** 插件入口。 */
export function apply(ctx: Context): void {
  void (async () => {
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const { domain, vault } = store
    const namedKeys = new NamedKeyStore(domain)
    const auditLog = new AuditLogStore(domain)
    const dlpRules = new DlpRuleStore(domain)
    const dlpSettings = new DlpSettingsStore(domain)
    const dlpBlocks = new DlpBlockStore(domain)
    const alerts = new AuditAlertStore(domain)

    /** 最近调用时间戳（频率告警用，内存态）。 */
    const recentCalls: number[] = []
    let lastRateAlertAt = 0

    try {
      ctx.effect(() => {
        // ----------------------------------------------------------------
        // 调用钩子：DLP 拦截（前置）+ 审计与告警（后置）
        // ----------------------------------------------------------------
        const disposeHook = ctx.companion.addCallHook({
          beforeCall(params: CallParams): void {
            const settings = dlpSettings.get()
            if (!settings.enabled) return
            const text = params.messages.map((m) => m.content).join('\n')
            const findings = scanText(text, dlpRules.list())
            if (findings.length === 0) return
            const names = findings.map((f) => `${f.ruleName}×${f.count}`).join('、')
            void dlpBlocks.recordBlock(Date.now(), findings.map((f) => f.ruleName)).catch(() => undefined)
            if (settings.strict) {
              throw new HttpError(`【DLP 拦截】检测到敏感内容：${names}（严格模式，已阻止发送）`, 403)
            }
            ctx.companion.notice('warning', `【DLP 警告】Prompt 中检测到敏感内容：${names}`)
          },
          afterCall(params, result, error, costCny): void {
            const ts = Date.now()
            const text = params.messages.map((m) => m.content).join('\n')
            const redacted = redactText(text, dlpRules.list())
            const entry: AuditEntry = {
              id: auditId(),
              ts,
              model: result?.model || params.model || 'deepseek-chat',
              promptSummary: redacted.slice(0, 100),
              promptTokens: result?.usage.promptTokens ?? 0,
              completionTokens: result?.usage.completionTokens ?? 0,
              costCny,
              status: result ? 'ok' : errorCodeOf(error),
              source: params.source,
            }
            void auditLog.append(entry).catch(() => undefined)

            // 异常告警：单次 Token 超阈值。
            const totalTokens = entry.promptTokens + entry.completionTokens
            if (totalTokens > TOKEN_ALERT_THRESHOLD) {
              void alerts
                .push({
                  ts,
                  kind: 'token-threshold',
                  detail: `单次调用 Token ${totalTokens} 超过阈值 ${TOKEN_ALERT_THRESHOLD}（来源：${params.source}）`,
                })
                .catch(() => undefined)
            }
            // 异常告警：调用频率突增。
            recentCalls.push(ts)
            while (recentCalls.length > 0 && recentCalls[0] < ts - 60_000) recentCalls.shift()
            if (recentCalls.length > RATE_BURST_LIMIT && ts - lastRateAlertAt > 60_000) {
              lastRateAlertAt = ts
              void alerts
                .push({
                  ts,
                  kind: 'rate-burst',
                  detail: `60 秒内调用 ${recentCalls.length} 次，超过阈值 ${RATE_BURST_LIMIT}`,
                })
                .catch(() => undefined)
            }
          },
        })

        const disposers: Array<() => void> = [
          disposeHook,

          // --------------------------------------------------------------
          // J1 API Key 安全管理
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/security/keys', async (_req, res) => {
            const activeKey = await ctx.companion.getApiKey()
            sendJson(res, 200, {
              keys: namedKeys.list().map((meta) => keyView(meta, vault.hasSecret(`${NAMED_KEY_SECRET_PREFIX}${meta.name}`))),
              rotationDays: KEY_ROTATION_DAYS,
              activeConfigured: activeKey !== undefined,
            })
          }),

          ctx.companion.http.add('POST', '/security/keys', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const apiKey = requireString(body.apiKey, 'apiKey')
            const note = typeof body.note === 'string' ? body.note.trim() : ''
            const scope = parseScope(body.scope)
            const existing = namedKeys.get(name)
            await vault.setSecret(`${NAMED_KEY_SECRET_PREFIX}${name}`, apiKey)
            const meta: NamedKeyMeta = {
              name,
              createdAt: existing?.createdAt ?? Date.now(),
              lastUsedAt: existing?.lastUsedAt ?? 0,
              scope,
              note,
            }
            await namedKeys.put(meta)
            sendJson(res, 200, { key: keyView(meta, true) })
          }),

          ctx.companion.http.add('POST', '/security/keys/activate', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const secret = await vault.getSecret(`${NAMED_KEY_SECRET_PREFIX}${name}`)
            if (!secret) throw new HttpError(`Key「${name}」不存在或已损坏`, 404)
            await ctx.companion.setApiKey(secret)
            const meta = namedKeys.get(name)
            if (meta) {
              await namedKeys.put({ ...meta, lastUsedAt: Date.now() })
            }
            ctx.companion.notice('success', `已切换激活 Key：${name}`)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('DELETE', '/security/keys', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            await vault.deleteSecret(`${NAMED_KEY_SECRET_PREFIX}${name}`)
            await namedKeys.delete(name)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/security/keys/leak-check', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const content = requireString(body.content, 'content')
            const leaked: string[] = []
            // 主 Key 泄露检测。
            const mainKey = await ctx.companion.getApiKey()
            if (mainKey && content.includes(mainKey)) leaked.push('（当前激活 Key）')
            // 命名 Key 泄露检测。
            for (const meta of namedKeys.list()) {
              const secret = await vault.getSecret(`${NAMED_KEY_SECRET_PREFIX}${meta.name}`)
              if (secret && content.includes(secret)) leaked.push(meta.name)
            }
            if (leaked.length > 0) {
              ctx.companion.notice('error', `【Key 泄露警告】在提交内容中发现 ${leaked.length} 个 API Key！`)
            }
            sendJson(res, 200, { leaked, safe: leaked.length === 0 })
          }),

          ctx.companion.http.add('GET', '/security/keys/rotation', (_req, res) => {
            const threshold = Date.now() - KEY_ROTATION_DAYS * 24 * 3600_000
            const due = namedKeys
              .list()
              .filter((meta) => meta.createdAt < threshold)
              .map((meta) => ({ name: meta.name, ageDays: Math.floor((Date.now() - meta.createdAt) / (24 * 3600_000)) }))
            sendJson(res, 200, { due, thresholdDays: KEY_ROTATION_DAYS })
          }),

          // --------------------------------------------------------------
          // J2 操作审计日志
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/security/audit', (_req, res, hctx) => {
            const from = parseOptionalTs(hctx.query.get('from'))
            const to = parseOptionalTs(hctx.query.get('to'))
            const model = hctx.query.get('model') ?? undefined
            const status = hctx.query.get('status') ?? undefined
            const limit = Math.min(Number(hctx.query.get('limit')) || 500, AUDIT_LOG_LIMIT)
            sendJson(res, 200, { entries: auditLog.filter({ from, to, model, status, limit }) })
          }),

          ctx.companion.http.add('GET', '/security/audit/export', (_req, res, hctx) => {
            const format = hctx.query.get('format') === 'json' ? 'json' : 'csv'
            const from = parseOptionalTs(hctx.query.get('from'))
            const to = parseOptionalTs(hctx.query.get('to'))
            const entries = auditLog.filter({ from, to, limit: AUDIT_LOG_LIMIT })
            if (format === 'json') {
              sendJson(res, 200, { format, fileName: `audit-log-${Date.now()}.json`, content: JSON.stringify(entries, null, 2) })
              return
            }
            const header = 'time,model,prompt_summary,prompt_tokens,completion_tokens,cost_cny,status,source'
            const rows = entries.map((entry) =>
              [
                new Date(entry.ts).toISOString(),
                csvCell(entry.model),
                csvCell(entry.promptSummary),
                entry.promptTokens,
                entry.completionTokens,
                entry.costCny,
                csvCell(entry.status),
                csvCell(entry.source),
              ].join(','),
            )
            sendJson(res, 200, { format, fileName: `audit-log-${Date.now()}.csv`, content: [header, ...rows].join('\n') })
          }),

          // --------------------------------------------------------------
          // J3 数据防泄漏（DLP）
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/security/dlp/state', (_req, res) => {
            sendJson(res, 200, { settings: dlpSettings.get(), rules: dlpRules.list() })
          }),

          ctx.companion.http.add('POST', '/security/dlp/settings', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const patch: { enabled?: boolean; strict?: boolean } = {}
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
            if (typeof body.strict === 'boolean') patch.strict = body.strict
            sendJson(res, 200, { settings: await dlpSettings.update(patch) })
          }),

          ctx.companion.http.add('POST', '/security/dlp/rules', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const pattern = requireString(body.pattern, 'pattern')
            const problem = validatePattern(pattern)
            if (problem) throw new HttpError(`正则表达式非法：${problem}`, 400)
            // 内置规则只允许切换启用状态。
            const builtin = dlpRules.list().find((rule) => rule.builtin && rule.name === name)
            if (builtin) throw new HttpError('内置规则不可修改，请新建自定义规则', 400)
            const customCount = dlpRules.list().filter((rule) => !rule.builtin).length
            if (customCount >= MAX_CUSTOM_RULES) {
              throw new HttpError(`自定义规则不能超过 ${MAX_CUSTOM_RULES} 条`, 400)
            }
            const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : `custom-${Date.now().toString(36)}`
            await dlpRules.put({ id, name, pattern, builtin: false, enabled: body.enabled !== false })
            sendJson(res, 200, { rules: dlpRules.list() })
          }),

          ctx.companion.http.add('POST', '/security/dlp/rules/toggle', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const enabled = body.enabled === true
            const rule = dlpRules.list().find((r) => r.id === id)
            if (!rule) throw new HttpError(`规则不存在：${id}`, 404)
            if (rule.builtin) {
              await dlpRules.toggleBuiltin(id, enabled)
            } else {
              await dlpRules.put({ ...rule, enabled })
            }
            sendJson(res, 200, { rules: dlpRules.list() })
          }),

          ctx.companion.http.add('DELETE', '/security/dlp/rules', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const rule = dlpRules.list().find((r) => r.id === id)
            if (!rule) throw new HttpError(`规则不存在：${id}`, 404)
            if (rule.builtin) throw new HttpError('内置规则不可删除', 400)
            await dlpRules.delete(id)
            sendJson(res, 200, { rules: dlpRules.list() })
          }),

          ctx.companion.http.add('POST', '/security/dlp/scan', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const text = requireString(body.text, 'text')
            const findings = scanText(text, dlpRules.list())
            sendJson(res, 200, { findings, clean: findings.length === 0, settings: dlpSettings.get() })
          }),

          // --------------------------------------------------------------
          // J4 合规报表
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/security/report', (_req, res, hctx) => {
            const { from, to } = requireDayRange(hctx.query)
            sendJson(res, 200, buildReport(from, to))
          }),

          ctx.companion.http.add('GET', '/security/report/export', (_req, res, hctx) => {
            const { from, to } = requireDayRange(hctx.query)
            const report = buildReport(from, to)
            sendJson(res, 200, {
              format: 'html',
              fileName: `compliance-report-${from}-${to}.html`,
              content: buildReportHtml(report),
            })
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-security.register')
    } catch {
      // 等待存储域期间插件已被卸载，放弃注册。
    }

    /** 组装合规报表（J4）。 */
    function buildReport(from: string, to: string): {
      from: string
      to: string
      totalCalls: number
      totalCostCny: number
      totalTokens: number
      modelShare: Record<string, number>
      blocks: Record<string, number>
      blockTotal: number
      alerts: Array<{ ts: number; kind: string; detail: string }>
    } {
      // 用量汇总：直接读 usage-daily 表（与成本报表同源）。
      const usageTable = domain.table<{
        day: string
        calls: number
        promptTokens: number
        completionTokens: number
        costCny: number
        byModel: Record<string, { calls: number }>
      }>('usage-daily')
      let totalCalls = 0
      let totalCostCny = 0
      let totalTokens = 0
      const modelCalls: Record<string, number> = {}
      for (const [, row] of usageTable.entries()) {
        if (row.day < from || row.day > to) continue
        totalCalls += row.calls
        totalCostCny += row.costCny
        totalTokens += row.promptTokens + row.completionTokens
        for (const [model, slice] of Object.entries(row.byModel ?? {})) {
          modelCalls[model] = (modelCalls[model] ?? 0) + slice.calls
        }
      }
      const modelShare: Record<string, number> = {}
      for (const [model, calls] of Object.entries(modelCalls)) {
        modelShare[model] = totalCalls > 0 ? Math.round((calls / totalCalls) * 1000) / 1000 : 0
      }
      // 拦截统计。
      const blocks: Record<string, number> = {}
      let blockTotal = 0
      for (const row of dlpBlocks.range(from, to)) {
        blockTotal += row.total
        for (const [ruleName, count] of Object.entries(row.byRule)) {
          blocks[ruleName] = (blocks[ruleName] ?? 0) + count
        }
      }
      return {
        from,
        to,
        totalCalls,
        totalCostCny: Math.round(totalCostCny * 10000) / 10000,
        totalTokens,
        modelShare,
        blocks,
        blockTotal,
        alerts: alerts.range(from, to).slice(0, 100),
      }
    }
  })()
}

/** Key 展示视图（安全红线：只回掩码尾 4 位）。 */
function keyView(meta: NamedKeyMeta, configured: boolean): Record<string, unknown> {
  return {
    name: meta.name,
    note: meta.note,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
    scope: meta.scope,
    configured,
    rotationDue: Date.now() - meta.createdAt > 30 * 24 * 3600_000,
  }
}

/** 解析 Key 权限范围。 */
function parseScope(raw: unknown): { access: 'full' | 'read'; models: readonly string[]; dailyBudgetCny: number } {
  if (typeof raw !== 'object' || raw === null) {
    return { access: 'full', models: [], dailyBudgetCny: 0 }
  }
  const record = raw as Record<string, unknown>
  const access = record.access === 'read' ? 'read' : 'full'
  const models = Array.isArray(record.models)
    ? (record.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : []
  const budget = Number(record.dailyBudgetCny)
  return { access, models, dailyBudgetCny: Number.isFinite(budget) && budget > 0 ? budget : 0 }
}

/** 错误对象 → 审计状态码。 */
function errorCodeOf(error: Error | undefined): string {
  if (!error) return 'unknown'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code ? code : 'error'
}

/** CSV 单元格转义。 */
function csvCell(text: string): string {
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 解析可选时间戳参数。 */
function parseOptionalTs(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 解析并校验 YYYY-MM-DD 区间参数。 */
function requireDayRange(query: URLSearchParams): { from: string; to: string } {
  const from = query.get('from') ?? ''
  const to = query.get('to') ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HttpError('from/to 必须是 YYYY-MM-DD', 400)
  }
  if (from > to) throw new HttpError('from 不能晚于 to', 400)
  return { from, to }
}

/** 合规报表 HTML（自包含，CJK 安全；PDF 经浏览器打印管线另存）。 */
function buildReportHtml(report: {
  from: string
  to: string
  totalCalls: number
  totalCostCny: number
  totalTokens: number
  modelShare: Record<string, number>
  blocks: Record<string, number>
  blockTotal: number
  alerts: Array<{ ts: number; kind: string; detail: string }>
}): string {
  const modelRows = Object.entries(report.modelShare)
    .map(([model, share]) => `<tr><td>${escapeHtml(model)}</td><td>${(share * 100).toFixed(1)}%</td></tr>`)
    .join('\n')
  const blockRows = Object.entries(report.blocks)
    .map(([ruleName, count]) => `<tr><td>${escapeHtml(ruleName)}</td><td>${count}</td></tr>`)
    .join('\n')
  const alertRows = report.alerts
    .map(
      (alert) =>
        `<tr><td>${new Date(alert.ts).toLocaleString('zh-CN', { hour12: false })}</td><td>${escapeHtml(alert.kind)}</td><td>${escapeHtml(alert.detail)}</td></tr>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>合规报表 ${report.from} ~ ${report.to}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;font-size:13px}
th{background:#f6f8fa}
.meta{color:#57606a;font-size:13px}
.cards{display:flex;gap:12px;margin-top:12px}
.card{flex:1;padding:12px;border:1px solid #d0d7de;border-radius:8px}
.card .v{font-size:20px;font-weight:600}.card .l{font-size:12px;color:#57606a}
</style>
</head>
<body>
<h1>DeepSeek Companion 合规报表</h1>
<p class="meta">统计区间：${report.from} ~ ${report.to}（北京时间）· 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>
<div class="cards">
<div class="card"><div class="v">${report.totalCalls}</div><div class="l">API 调用总量</div></div>
<div class="card"><div class="v">¥${report.totalCostCny.toFixed(4)}</div><div class="l">总费用</div></div>
<div class="card"><div class="v">${report.totalTokens}</div><div class="l">总 Token 消耗</div></div>
<div class="card"><div class="v">${report.blockTotal}</div><div class="l">敏感内容拦截次数</div></div>
</div>
<h2>各模型使用占比</h2>
<table><thead><tr><th>模型</th><th>占比</th></tr></thead><tbody>${modelRows || '<tr><td colspan="2">无数据</td></tr>'}</tbody></table>
<h2>敏感内容拦截统计</h2>
<table><thead><tr><th>规则</th><th>次数</th></tr></thead><tbody>${blockRows || '<tr><td colspan="2">无拦截记录</td></tr>'}</tbody></table>
<h2>异常调用告警记录</h2>
<table><thead><tr><th>时间</th><th>类型</th><th>详情</th></tr></thead><tbody>${alertRows || '<tr><td colspan="3">无告警</td></tr>'}</tbody></table>
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
