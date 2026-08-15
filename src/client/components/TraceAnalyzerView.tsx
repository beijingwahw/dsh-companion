/**
 * 执行轨迹分析器视图页（模块 E 客户端 UI，挂载于 conversation.view）：
 * - E1 时间轴：选择会话派生轨迹，横向条形时间轴展示每个节点
 *   （步骤名/耗时/Token 拆分/模型/缓存命中），支持按耗时或 Token 排序定位瓶颈；
 * - E2 异常标注：异常节点红色高亮，hover（title）显示原因与建议；
 * - E3 轨迹对比：选择两个会话对比差异，可导出 HTML 对比报告；
 * - E4 统计面板：汇总指标 + 近 14 天趋势（纯 div 条形图）+ 基准线对比。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Select, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deriveTrace,
  diffTraces,
  downloadBlob,
  fetchTraceSessions,
  fetchTraceStats,
} from '../api.js'
import type {
  SessionRecord,
  TraceAnalysisResponse,
  TraceDiffEntry,
  TraceNode,
  TraceStatsResponse,
} from '../api.js'
import styles from './TraceAnalyzerView.module.css'

/** 组件 props：sessionId 由 slot 注入（缺省时不预选会话）。 */
export interface TraceAnalyzerViewProps {
  readonly sessionId?: string
}

/** 时间轴排序方式。 */
type SortMode = 'time' | 'duration' | 'tokens'

/** 毫秒 → 可读时长。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 节点类别中文标签。 */
function kindLabel(kind: TraceNode['kind']): string {
  switch (kind) {
    case 'tool':
      return '工具'
    case 'agent':
      return '子Agent'
    case 'model':
      return '模型'
    default:
      return '步骤'
  }
}

/** 执行轨迹分析器视图页。 */
export function TraceAnalyzerView(props: TraceAnalyzerViewProps): ReactElement {
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [selectedSession, setSelectedSession] = useState(props.sessionId ?? '')
  const [analysis, setAnalysis] = useState<TraceAnalysisResponse | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('time')

  // 对比（E3）
  const [compareSession, setCompareSession] = useState('')
  const [diffEntries, setDiffEntries] = useState<readonly TraceDiffEntry[] | undefined>()
  const [diffLoading, setDiffLoading] = useState(false)

  // 统计面板（E4）
  const [stats, setStats] = useState<TraceStatsResponse | undefined>()

  // 卸载守卫 + 请求序号：防止过期响应覆盖新结果、卸载后 setState。
  const mountedRef = useRef(true)
  const analyzeSeq = useRef(0)
  const diffSeq = useRef(0)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 加载可分析会话列表
  useEffect(() => {
    let cancelled = false
    fetchTraceSessions()
      .then((response) => {
        if (!cancelled) setSessions(response.sessions)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '会话列表加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 加载近 14 天统计趋势
  useEffect(() => {
    let cancelled = false
    const to = new Date()
    const from = new Date(to.getTime() - 13 * 86_400_000)
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    fetchTraceStats({ from: fmt(from), to: fmt(to) })
      .then((response) => {
        if (!cancelled) setStats(response)
      })
      .catch(() => {
        // 趋势加载失败不阻塞主功能。
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 分析选中会话（E1/E2）。请求序号守卫：过期响应直接丢弃。 */
  const analyze = useCallback(() => {
    if (!selectedSession) return
    const seq = ++analyzeSeq.current
    setLoading(true)
    setError('')
    setAnalysis(undefined)
    setDiffEntries(undefined)
    deriveTrace(selectedSession)
      .then((response) => {
        if (!mountedRef.current || seq !== analyzeSeq.current) return
        setAnalysis(response)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== analyzeSeq.current) return
        setError(err instanceof Error ? err.message : '轨迹分析失败')
      })
      .finally(() => {
        if (mountedRef.current && seq === analyzeSeq.current) setLoading(false)
      })
  }, [selectedSession])

  /** 与对比会话做差异分析（E3）。请求序号守卫：过期响应直接丢弃。 */
  const runDiff = useCallback(async () => {
    if (!selectedSession || !compareSession) return
    const seq = ++diffSeq.current
    setDiffLoading(true)
    setError('')
    try {
      const response = await diffTraces({
        old: { sessionId: selectedSession },
        new: { sessionId: compareSession },
      })
      if (mountedRef.current && seq === diffSeq.current && response.format === 'json') {
        setDiffEntries(response.entries)
      }
    } catch (err) {
      if (mountedRef.current && seq === diffSeq.current) {
        setError(err instanceof Error ? err.message : '轨迹对比失败')
      }
    } finally {
      if (mountedRef.current && seq === diffSeq.current) setDiffLoading(false)
    }
  }, [selectedSession, compareSession])

  /** 导出 HTML 对比报告。 */
  const exportDiffHtml = useCallback(async () => {
    if (!selectedSession || !compareSession) return
    setDiffLoading(true)
    try {
      const response = await diffTraces({
        old: { sessionId: selectedSession },
        new: { sessionId: compareSession },
        format: 'html',
      })
      if (response.format === 'html') {
        downloadBlob(new Blob([response.html], { type: 'text/html' }), response.fileName)
        Toast.push('对比报告已导出', 'success')
      }
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '导出对比报告失败', 'error')
    } finally {
      setDiffLoading(false)
    }
  }, [selectedSession, compareSession])

  // 时间轴节点排序：time=按开始时间，duration=按耗时降序，tokens=按 Token 降序
  const timelineNodes: readonly TraceNode[] = (() => {
    if (!analysis) return []
    const nodes = [...analysis.trace.nodes]
    if (sortMode === 'duration') nodes.sort((a, b) => b.durationMs - a.durationMs)
    else if (sortMode === 'tokens') {
      nodes.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    }
    return nodes
  })()

  const traceSpan = analysis ? Math.max(1, analysis.trace.endedAt - analysis.trace.startedAt) : 1
  const anomalyNodeIds = new Set(analysis?.anomalies.flatMap((anomaly) => anomaly.nodeIds) ?? [])
  const anomalyByNode = new Map<string, string>()
  for (const anomaly of analysis?.anomalies ?? []) {
    for (const nodeId of anomaly.nodeIds) {
      anomalyByNode.set(nodeId, `[${anomaly.kind}] ${anomaly.reason}\n建议：${anomaly.suggestion}`)
    }
  }

  const maxDayDuration = Math.max(1, ...(stats?.days.map((day) => day.totalDurationMs) ?? [1]))

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>执行轨迹分析器</h2>

      <div className={styles.toolbar}>
        <Select value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)}>
          <option value="">选择要分析的会话…</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title || '未命名对话'}
            </option>
          ))}
        </Select>
        <Button variant="primary" size="sm" disabled={!selectedSession || loading} onClick={analyze}>
          {loading ? '分析中…' : '分析轨迹'}
        </Button>
      </div>

      {error.length > 0 && <div className={styles.error}>{error}</div>}
      {loading && <Spinner label="正在派生并分析执行轨迹…" />}

      {analysis && (
        <>
          {/* E4 汇总指标 */}
          <section className={styles.section}>
            <h3>汇总指标</h3>
            <div className={styles.statGrid}>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{formatDuration(analysis.stats.totalDurationMs)}</span>
                <span className={styles.statLabel}>总耗时</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {analysis.stats.totalInputTokens} / {analysis.stats.totalOutputTokens}
                </span>
                <span className={styles.statLabel}>输入 / 输出 Token</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{(analysis.stats.cacheHitRate * 100).toFixed(0)}%</span>
                <span className={styles.statLabel}>缓存命中率</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{(analysis.stats.toolSuccessRate * 100).toFixed(0)}%</span>
                <span className={styles.statLabel}>工具成功率</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{analysis.stats.agentDispatches}</span>
                <span className={styles.statLabel}>子 Agent 派发</span>
              </div>
            </div>
          </section>

          {/* E2 异常标注列表 */}
          {analysis.anomalies.length > 0 && (
            <section className={styles.section}>
              <h3>异常标注（{analysis.anomalies.length}）</h3>
              <ul className={styles.anomalyList}>
                {analysis.anomalies.map((anomaly, index) => (
                  <li key={index} className={styles.anomalyItem} title={anomaly.suggestion}>
                    <strong>{anomaly.kind}</strong>：{anomaly.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* E1 时间轴 */}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>时间轴（{timelineNodes.length} 个节点）</h3>
              <div className={styles.sortBar}>
                <Button size="sm" variant={sortMode === 'time' ? 'primary' : 'secondary'} onClick={() => setSortMode('time')}>
                  按时间
                </Button>
                <Button size="sm" variant={sortMode === 'duration' ? 'primary' : 'secondary'} onClick={() => setSortMode('duration')}>
                  最慢优先
                </Button>
                <Button size="sm" variant={sortMode === 'tokens' ? 'primary' : 'secondary'} onClick={() => setSortMode('tokens')}>
                  最贵优先
                </Button>
              </div>
            </div>
            {timelineNodes.length === 0 ? (
              <p className={styles.empty}>该会话没有可解析的执行步骤（仅普通对话消息）。</p>
            ) : (
              <div className={styles.timeline}>
                {timelineNodes.map((node) => {
                  const left = sortMode === 'time' ? ((node.startMs - analysis.trace.startedAt) / traceSpan) * 100 : 0
                  const width = Math.max(1, (node.durationMs / traceSpan) * 100)
                  const anomalyTip = anomalyByNode.get(node.id)
                  const classNames = [
                    styles.timelineBar,
                    styles[`kind_${node.kind}`],
                    anomalyNodeIds.has(node.id) ? styles.anomaly : '',
                    node.status === 'error' ? styles.statusError : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div key={node.id} className={styles.timelineRow}>
                      <span className={styles.timelineName} title={node.name}>
                        {node.name}
                      </span>
                      <div className={styles.timelineTrack}>
                        <div
                          className={classNames}
                          style={
                            sortMode === 'time'
                              ? { left: `${left}%`, width: `${width}%` }
                              : { left: '0%', width: `${width}%` }
                          }
                          title={`${kindLabel(node.kind)} · ${formatDuration(node.durationMs)} · 输入 ${node.inputTokens} / 输出 ${node.outputTokens} tokens${node.model ? ` · ${node.model}` : ''}${node.cacheHit ? ' · 缓存命中' : ''}${anomalyTip ? `\n⚠ ${anomalyTip}` : ''}`}
                        />
                      </div>
                      <span className={styles.timelineMeta}>
                        {formatDuration(node.durationMs)} · {node.inputTokens}+{node.outputTokens}t
                        {node.cacheHit ? ' · 缓存' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* E3 轨迹对比 */}
          <section className={styles.section}>
            <h3>轨迹对比</h3>
            <div className={styles.toolbar}>
              <Select value={compareSession} onChange={(event) => setCompareSession(event.target.value)}>
                <option value="">选择要对比的会话（新）…</option>
                {sessions
                  .filter((session) => session.id !== selectedSession)
                  .map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title || '未命名对话'}
                    </option>
                  ))}
              </Select>
              <Button size="sm" variant="secondary" disabled={!compareSession || diffLoading} onClick={runDiff}>
                对比
              </Button>
              <Button size="sm" variant="secondary" disabled={!compareSession || diffLoading} onClick={exportDiffHtml}>
                导出 HTML 报告
              </Button>
            </div>
            {diffEntries && (
              <table className={styles.diffTable}>
                <thead>
                  <tr>
                    <th>步骤</th>
                    <th>变化</th>
                    <th>耗时</th>
                    <th>Token</th>
                  </tr>
                </thead>
                <tbody>
                  {diffEntries.map((entry, index) => (
                    <tr key={index}>
                      <td>{entry.name}</td>
                      <td className={styles[`diff_${entry.change}`]}>
                        {entry.change === 'added' ? '新增' : entry.change === 'removed' ? '移除' : entry.change === 'changed' ? '变化' : '不变'}
                      </td>
                      <td>
                        {entry.oldDurationMs !== undefined && entry.newDurationMs !== undefined
                          ? `${formatDuration(entry.oldDurationMs)} → ${formatDuration(entry.newDurationMs)}（${(entry.durationDeltaMs ?? 0) >= 0 ? '+' : ''}${entry.durationDeltaMs ?? 0}ms）`
                          : entry.oldDurationMs !== undefined
                            ? formatDuration(entry.oldDurationMs)
                            : entry.newDurationMs !== undefined
                              ? formatDuration(entry.newDurationMs)
                              : '-'}
                      </td>
                      <td>
                        {entry.tokenDelta !== undefined
                          ? `${entry.oldTokens ?? '-'} → ${entry.newTokens ?? '-'}（${entry.tokenDelta >= 0 ? '+' : ''}${entry.tokenDelta}）`
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* E4 趋势图 */}
      {stats && stats.days.length > 0 && (
        <section className={styles.section}>
          <h3>近 14 天趋势</h3>
          <div className={styles.trend}>
            {stats.days.map((day) => (
              <div key={day.day} className={styles.trendCol} title={`${day.day}：${day.traceCount} 条轨迹，总耗时 ${formatDuration(day.totalDurationMs)}，异常 ${day.anomalyCount} 项`}>
                <div
                  className={styles.trendBar}
                  style={{ height: `${Math.max(4, (day.totalDurationMs / maxDayDuration) * 100)}%` }}
                />
                <span className={styles.trendLabel}>{day.day.slice(5)}</span>
              </div>
            ))}
          </div>
          {stats.baseline && (
            <p className={styles.baseline}>
              历史基准：平均耗时 {formatDuration(stats.baseline.avgDurationMs)} · 平均 Token{' '}
              {Math.round(stats.baseline.avgTokens)} · 平均异常 {stats.baseline.avgAnomalies} 项/轨迹
            </p>
          )}
        </section>
      )}
    </div>
  )
}
