/**
 * 模块 E：执行轨迹分析器（trace）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * - GET    /trace/sessions        可分析的会话列表；
 * - GET    /trace/derive          从会话日志派生轨迹（含异常标注与汇总指标）；
 * - POST   /trace/ingest          摄入 Harness 原生轨迹 JSON 并持久化；
 * - GET    /trace/list            已保存轨迹列表；
 * - GET    /trace/get             读取单条轨迹（含异常与指标）；
 * - DELETE /trace                 删除已保存轨迹；
 * - POST   /trace/diff            两条轨迹对比（E3），可返回 HTML 对比报告；
 * - GET    /trace/stats           日聚合趋势 + 历史基准线（E4）。
 *
 * 命令 `trace`：分析指定会话（或最近会话）并输出文本报告。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import {
  computeStats,
  costliestNodes,
  DEFAULT_ANOMALY_THRESHOLDS,
  deriveTraceFromLog,
  detectAnomalies,
  diffTraces,
  ingestRawTrace,
  slowestNodes,
} from './analyzer.js'
import { TraceStatsStore, TraceStore } from './store.js'
import type { Trace } from './types.js'

/** 插件名。 */
export const name = 'companion-trace'

/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 基准线告警：当前指标偏离历史平均超过该比例时提示。 */
const BASELINE_DEVIATION_WARN = 0.5

/** 插件入口。 */
export function apply(ctx: Context): void {
  void (async () => {
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const traceStore = new TraceStore(store.domain)
    const statsStore = new TraceStatsStore(store.domain)

    try {
      ctx.effect(() => {
        const disposers: Array<() => void> = [
          ctx.companion.http.add('GET', '/trace/sessions', async (_req, res) => {
            const sessions = await ctx.sessionQuery.listSessions()
            sendJson(
              res,
              200,
              {
                sessions: [...sessions]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .slice(0, 100)
                  .map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
              },
            )
          }),

          ctx.companion.http.add('GET', '/trace/derive', async (_req, res, hctx) => {
            const sessionId = requireQuery(hctx.query, 'sessionId')
            const snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
            const trace = deriveTraceFromLog(snapshot)
            const anomalies = detectAnomalies(trace, DEFAULT_ANOMALY_THRESHOLDS)
            const stats = computeStats(trace)
            // 同一会话当日重复查看不重复计入趋势（dedupeKey 去重）。
            void statsStore.record(Date.now(), stats, anomalies.length, `derive:${sessionId}`).catch(() => undefined)
            maybeWarnBaseline(ctx, statsStore, stats)
            sendJson(res, 200, {
              trace,
              anomalies,
              stats,
              slowest: slowestNodes(trace),
              costliest: costliestNodes(trace),
            })
          }),

          ctx.companion.http.add('POST', '/trace/ingest', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const raw = body.trace
            if (raw === undefined) throw new HttpError('trace 字段必填', 400)
            const id =
              typeof body.id === 'string' && body.id.trim()
                ? body.id.trim()
                : `ingest-${Date.now()}`
            const trace = ingestRawTrace(raw, id)
            if (trace.nodes.length === 0) throw new HttpError('轨迹中没有可解析的步骤', 400)
            await traceStore.put(trace)
            const anomalies = detectAnomalies(trace, DEFAULT_ANOMALY_THRESHOLDS)
            const stats = computeStats(trace)
            // 同一轨迹当日重复摄入不重复计入趋势（dedupeKey 去重）。
            void statsStore.record(Date.now(), stats, anomalies.length, `ingest:${trace.id}`).catch(() => undefined)
            sendJson(res, 200, { trace, anomalies, stats })
          }),

          ctx.companion.http.add('GET', '/trace/list', (_req, res) => {
            sendJson(
              res,
              200,
              {
                traces: traceStore.list().map((trace) => ({
                  id: trace.id,
                  sessionId: trace.sessionId,
                  startedAt: trace.startedAt,
                  endedAt: trace.endedAt,
                  nodeCount: trace.nodes.length,
                })),
              },
            )
          }),

          ctx.companion.http.add('GET', '/trace/get', (_req, res, hctx) => {
            const id = requireQuery(hctx.query, 'id')
            const trace = traceStore.get(id)
            if (!trace) throw new HttpError(`轨迹不存在：${id}`, 404)
            sendJson(res, 200, {
              trace,
              anomalies: detectAnomalies(trace, DEFAULT_ANOMALY_THRESHOLDS),
              stats: computeStats(trace),
            })
          }),

          ctx.companion.http.add('DELETE', '/trace', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) throw new HttpError('id 必填', 400)
            await traceStore.delete(id)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/trace/diff', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const oldTrace = await resolveTrace(ctx, traceStore, body.old, 'old')
            const newTrace = await resolveTrace(ctx, traceStore, body.new, 'new')
            const entries = diffTraces(oldTrace, newTrace)
            if (body.format === 'html') {
              sendJson(res, 200, {
                format: 'html',
                fileName: `trace-diff-${Date.now()}.html`,
                html: buildDiffHtml(oldTrace, newTrace, entries),
              })
              return
            }
            sendJson(res, 200, { format: 'json', entries })
          }),

          ctx.companion.http.add('GET', '/trace/stats', (_req, res, hctx) => {
            const from = hctx.query.get('from') ?? ''
            const to = hctx.query.get('to') ?? ''
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
              throw new HttpError('from/to 必须是 YYYY-MM-DD', 400)
            }
            if (from > to) throw new HttpError('from 不能晚于 to', 400)
            sendJson(res, 200, { days: statsStore.range(from, to), baseline: statsStore.baseline() })
          }),

          ctx.commands.register({
            name: 'trace',
            description: '分析会话执行轨迹（耗时/Token/异常）',
            input: '[会话ID]',
            handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
              const input = (invocation.input ?? '').trim()
              let sessionId = input.length > 0 ? input : undefined
              if (!sessionId) {
                const sessions = await ctx.sessionQuery.listSessions()
                const latest = [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0]
                if (!latest) return { text: '暂无可分析的会话' }
                sessionId = latest.id
              }
              try {
                const snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
                const trace = deriveTraceFromLog(snapshot)
                const stats = computeStats(trace)
                const anomalies = detectAnomalies(trace, DEFAULT_ANOMALY_THRESHOLDS)
                const lines: string[] = [
                  `轨迹分析（会话 ${sessionId}）：`,
                  `- 节点数：${stats.nodeCount}，总耗时 ${(stats.totalDurationMs / 1000).toFixed(1)}s`,
                  `- Token：输入 ${stats.totalInputTokens} / 输出 ${stats.totalOutputTokens}`,
                  `- 缓存命中率：${(stats.cacheHitRate * 100).toFixed(0)}%，工具成功率：${(stats.toolSuccessRate * 100).toFixed(0)}%`,
                  `- 子 Agent 派发：${stats.agentDispatches} 次`,
                ]
                const slowest = slowestNodes(trace)
                if (slowest.length > 0 && slowest[0].durationMs > 0) {
                  lines.push(
                    `- 最慢步骤：${slowest.map((node) => `${node.name}（${node.durationMs}ms）`).join('、')}`,
                  )
                }
                if (anomalies.length > 0) {
                  lines.push(`- 异常 ${anomalies.length} 项：`)
                  for (const anomaly of anomalies) {
                    lines.push(`  · [${anomaly.kind}] ${anomaly.reason}`)
                  }
                } else {
                  lines.push('- 未检测到异常模式')
                }
                return { text: lines.join('\n'), data: { stats, anomalies } }
              } catch {
                return { text: '轨迹分析失败，请稍后重试' }
              }
            },
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-trace.register')
    } catch {
      // 等待存储域期间插件已被卸载，放弃注册。
    }
  })()
}

/** 从 { id } 或 { sessionId } 解析出轨迹（保存轨迹优先，否则从会话派生）。 */
async function resolveTrace(
  ctx: Context,
  traceStore: TraceStore,
  spec: unknown,
  field: string,
): Promise<Trace> {
  if (typeof spec !== 'object' || spec === null) {
    throw new HttpError(`${field} 必须是 { id } 或 { sessionId } 对象`, 400)
  }
  const record = spec as Record<string, unknown>
  if (typeof record.id === 'string' && record.id.trim()) {
    const trace = traceStore.get(record.id.trim())
    if (!trace) throw new HttpError(`${field} 轨迹不存在：${record.id}`, 404)
    return trace
  }
  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    const snapshot = await ctx.sessionQuery.readSession(SessionId(record.sessionId.trim()))
    return deriveTraceFromLog(snapshot)
  }
  throw new HttpError(`${field} 必须提供 id 或 sessionId`, 400)
}

/** 基准线偏离告警（best-effort：仅 notice，不打断响应）。 */
function maybeWarnBaseline(ctx: Context, statsStore: TraceStatsStore, stats: { totalDurationMs: number }): void {
  try {
    const baseline = statsStore.baseline()
    if (!baseline || baseline.avgDurationMs <= 0) return
    const deviation = (stats.totalDurationMs - baseline.avgDurationMs) / baseline.avgDurationMs
    if (deviation > BASELINE_DEVIATION_WARN) {
      ctx.companion.notice(
        'warning',
        `本次轨迹耗时偏离历史平均 ${(deviation * 100).toFixed(0)}%，建议查看轨迹分析定位瓶颈`,
      )
    }
  } catch {
    // 基准线告警失败静默。
  }
}

/** 生成 E3 对比报告 HTML（自包含，无外部依赖）。 */
function buildDiffHtml(
  oldTrace: Trace,
  newTrace: Trace,
  entries: ReturnType<typeof diffTraces>,
): string {
  const rows = entries
    .map((entry) => {
      const badge =
        entry.change === 'added'
          ? '<span class="added">新增</span>'
          : entry.change === 'removed'
            ? '<span class="removed">移除</span>'
            : entry.change === 'changed'
              ? '<span class="changed">变化</span>'
              : '<span class="same">不变</span>'
      const duration =
        entry.durationDeltaMs !== undefined
          ? `${entry.oldDurationMs ?? '-'}ms → ${entry.newDurationMs ?? '-'}ms（${entry.durationDeltaMs >= 0 ? '+' : ''}${entry.durationDeltaMs}ms）`
          : entry.oldDurationMs !== undefined
            ? `${entry.oldDurationMs}ms`
            : entry.newDurationMs !== undefined
              ? `${entry.newDurationMs}ms`
              : '-'
      const tokens =
        entry.tokenDelta !== undefined
          ? `${entry.oldTokens ?? '-'} → ${entry.newTokens ?? '-'}（${entry.tokenDelta >= 0 ? '+' : ''}${entry.tokenDelta}）`
          : '-'
      return `<tr><td>${escapeHtml(entry.name)}</td><td>${badge}</td><td>${duration}</td><td>${tokens}</td></tr>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>轨迹对比报告</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px}
table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;font-size:13px}
th{background:#f6f8fa}
.added{color:#1a7f37;font-weight:600}
.removed{color:#cf222e;font-weight:600}
.changed{color:#9a6700;font-weight:600}
.same{color:#57606a}
.meta{color:#57606a;font-size:13px}
</style>
</head>
<body>
<h1>轨迹对比报告</h1>
<p class="meta">旧轨迹：${escapeHtml(oldTrace.id)}（${oldTrace.nodes.length} 个节点）<br>
新轨迹：${escapeHtml(newTrace.id)}（${newTrace.nodes.length} 个节点）<br>
生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>
<table>
<thead><tr><th>步骤</th><th>变化</th><th>耗时</th><th>Token</th></tr></thead>
<tbody>
${rows}
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

/** 读取必填查询参数。 */
function requireQuery(query: URLSearchParams, key: string): string {
  const value = query.get(key)
  if (!value || !value.trim()) throw new HttpError(`${key} 必填`, 400)
  return value.trim()
}

/** 将请求体收窄为 JSON 对象。 */
function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}
