/**
 * 对话知识资产面板（模块 F 客户端 UI，轴线 4 + 轴线 7）：
 * - **全局实体图谱**：覆盖会话数最多的头部实体（点击实体 → 以实体名
 *   作为检索词发起检索，把知识图谱变成检索入口）；
 * - **主题趋势**（轴线 7）：近 14 天 vs 上一 14 天的实体动量——上升 /
 *   衰退主题 + 最近 8 周逐周覆盖迷你柱状图（注意力流向可视化）；
 * - **单会话洞察**（由检索结果的“知识”按钮触发）：会话实体列表
 *   （类型徽章 + 频次 + 全局覆盖数）、建议标签（一键应用到该会话，
 *   复用模块 D 的标签系统，不自动写入）、关联会话（实体重叠推荐，
 *   点击请求主平台跳转）。
 *
 * 数据全部来自本地 /knowledge/* 端点（实体抽取与趋势计算在宿主侧
 * 本地完成，零 LLM、零网络外发）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  analyzeSessionKnowledge,
  fetchKnowledgeEntities,
  fetchKnowledgeTrends,
  fetchRelatedSessions,
  updateSessionTags,
} from '../api.js'
import type {
  KnowledgeAnalyzeResponse,
  KnowledgeEntitySummary,
  KnowledgeEntityType,
  KnowledgeRelatedHit,
  KnowledgeTrend,
} from '../api.js'
import styles from './KnowledgePanel.module.css'

/** 实体类型的中文徽章文案。 */
const TYPE_LABELS: Readonly<Record<KnowledgeEntityType, string>> = {
  command: '命令',
  path: '路径',
  tech: '技术',
  code: '代码',
  term: '术语',
  version: '版本',
}

/** 全局实体图谱的加载条数。 */
const GRAPH_LIMIT = 30

/** 主题趋势的加载条数。 */
const TRENDS_LIMIT = 10

/** 趋势方向的中文文案。 */
const DIRECTION_LABELS: Readonly<Record<KnowledgeTrend['direction'], string>> = {
  rising: '上升',
  falling: '衰退',
  stable: '平稳',
}

/** 洞察目标会话（由检索结果行传入）。 */
export interface KnowledgeTarget {
  readonly id: string
  readonly title?: string
}

/** 组件 props。 */
export interface KnowledgePanelProps {
  /** 当前洞察的会话；null 时仅展示全局实体图谱。 */
  readonly target: KnowledgeTarget | null
  /** 点击实体：以实体名发起检索。 */
  readonly onSearchEntity: (name: string) => void
  /** 点击关联会话：请求主平台跳转。 */
  readonly onOpenSession: (sessionId: string) => void
  /** 关闭单会话洞察。 */
  readonly onCloseTarget: () => void
}

/** 对话知识资产面板。 */
export function KnowledgePanel({
  target,
  onSearchEntity,
  onOpenSession,
  onCloseTarget,
}: KnowledgePanelProps): ReactElement {
  const [graph, setGraph] = useState<readonly KnowledgeEntitySummary[]>([])
  const [graphError, setGraphError] = useState('')
  const [trends, setTrends] = useState<readonly KnowledgeTrend[]>([])
  const [trendsDays, setTrendsDays] = useState(0)
  const [analysis, setAnalysis] = useState<KnowledgeAnalyzeResponse | null>(null)
  const [related, setRelated] = useState<readonly KnowledgeRelatedHit[]>([])
  const [insightLoading, setInsightLoading] = useState(false)
  const [insightError, setInsightError] = useState('')
  const [applying, setApplying] = useState(false)

  // 挂载时拉取全局实体图谱（覆盖会话数降序）。
  useEffect(() => {
    let cancelled = false
    fetchKnowledgeEntities({ limit: GRAPH_LIMIT })
      .then((response) => {
        if (!cancelled) setGraph(response.entities)
      })
      .catch((err: unknown) => {
        if (!cancelled) setGraphError(err instanceof Error ? err.message : '实体图谱加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 挂载时拉取主题趋势（轴线 7：实体动量 + 8 周时间线；失败静默不阻塞图谱）。
  useEffect(() => {
    let cancelled = false
    fetchKnowledgeTrends({ limit: TRENDS_LIMIT })
      .then((response) => {
        if (!cancelled) {
          setTrends(response.trends)
          setTrendsDays(response.days)
        }
      })
      .catch(() => {
        // 趋势失败：不展示该区块，不影响实体图谱。
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 洞察目标变化：并行拉取单会话实体分析与关联会话。
  useEffect(() => {
    if (target === null) {
      setAnalysis(null)
      setRelated([])
      setInsightError('')
      return
    }
    let cancelled = false
    setInsightLoading(true)
    setInsightError('')
    Promise.all([analyzeSessionKnowledge(target.id), fetchRelatedSessions(target.id, 5)])
      .then(([analysisResponse, relatedResponse]) => {
        if (cancelled) return
        setAnalysis(analysisResponse)
        setRelated(relatedResponse.related)
      })
      .catch((err: unknown) => {
        if (!cancelled) setInsightError(err instanceof Error ? err.message : '会话知识分析失败')
      })
      .finally(() => {
        if (!cancelled) setInsightLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target])

  /** 一键应用建议标签（Set 语义自动去重，已存在的不重复添加）。 */
  const applySuggestedTags = useCallback((): void => {
    if (analysis === null || analysis.suggestedTags.length === 0) return
    setApplying(true)
    updateSessionTags({ sessionId: analysis.sessionId, add: [...analysis.suggestedTags] })
      .then(() => {
        Toast.push(`已为会话应用 ${analysis.suggestedTags.length} 个建议标签`, 'info')
      })
      .catch((err: unknown) => {
        Toast.push(err instanceof Error ? err.message : '应用建议标签失败', 'error')
      })
      .finally(() => {
        setApplying(false)
      })
  }, [analysis])

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>知识资产</span>

      {target !== null ? (
        <div className={styles.section}>
          <div className={styles.targetHead}>
            <span className={styles.targetTitle}>
              {target.title ?? `会话 ${target.id}`} 的洞察
            </span>
            <Button variant="secondary" onClick={onCloseTarget}>
              收起
            </Button>
          </div>
          {insightLoading ? <Spinner label="分析会话知识…" /> : null}
          {insightError ? <span className={styles.error}>{insightError}</span> : null}
          {!insightLoading && !insightError && analysis !== null ? (
            <>
              <span className={styles.sectionTitle}>实体（按显著性降序）</span>
              {analysis.entities.length === 0 ? (
                <span className={styles.muted}>该会话未抽取到实体</span>
              ) : (
                <div className={styles.entityCloud}>
                  {analysis.entities.slice(0, 12).map((entity) => (
                    <span
                      key={`${entity.type}:${entity.name}`}
                      role="button"
                      tabIndex={0}
                      title={`${TYPE_LABELS[entity.type]} · 频次 ${entity.freq} · 覆盖 ${entity.globalSessionCount} 个会话`}
                      onClick={() => onSearchEntity(entity.name)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSearchEntity(entity.name)
                        }
                      }}
                    >
                      <Pill className={styles.entityPill}>
                        <span className={styles.typeBadge}>{TYPE_LABELS[entity.type]}</span>
                        {entity.name}
                      </Pill>
                    </span>
                  ))}
                </div>
              )}
              {analysis.suggestedTags.length > 0 ? (
                <div className={styles.suggestionRow}>
                  <span className={styles.sectionTitle}>建议标签：</span>
                  {analysis.suggestedTags.map((tag) => (
                    <Pill key={tag} className={styles.sharedPill}>
                      {tag}
                    </Pill>
                  ))}
                  <Button
                    variant="secondary"
                    disabled={applying}
                    onClick={applySuggestedTags}
                  >
                    {applying ? '应用中…' : '一键应用'}
                  </Button>
                </div>
              ) : null}
              {related.length > 0 ? (
                <div className={styles.section}>
                  <span className={styles.sectionTitle}>关联会话（实体重叠）</span>
                  <div className={styles.relatedList}>
                    {related.map((hit) => (
                      <div
                        key={hit.sessionId}
                        role="button"
                        tabIndex={0}
                        className={styles.relatedItem}
                        title="点击跳转到该会话"
                        onClick={() => onOpenSession(hit.sessionId)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onOpenSession(hit.sessionId)
                          }
                        }}
                      >
                        <span className={styles.relatedHead}>
                          <span className={styles.relatedTitle}>
                            {hit.title ?? `会话 ${hit.sessionId}`}
                          </span>
                          <span className={styles.relatedScore}>
                            相似度 {hit.score.toFixed(3)}
                          </span>
                        </span>
                        {hit.sharedEntities.length > 0 ? (
                          <span className={styles.sharedRow}>
                            {hit.sharedEntities.map((entity) => (
                              <Pill key={`${entity.type}:${entity.name}`} className={styles.sharedPill}>
                                {entity.name}
                              </Pill>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          <div className={styles.divider} />
        </div>
      ) : null}

      {trends.length > 0 ? (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>
            主题趋势（近 {trendsDays} 天 vs 上一 {trendsDays} 天）
          </span>
          <div className={styles.trendList}>
            {trends.map((trend) => (
              <div
                key={`${trend.type}:${trend.name}`}
                className={styles.trendRow}
                role="button"
                tabIndex={0}
                title={`${DIRECTION_LABELS[trend.direction]} · ${trend.previousSessions} → ${trend.recentSessions} 个会话 · 动量 ${trend.momentum.toFixed(2)}`}
                onClick={() => onSearchEntity(trend.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSearchEntity(trend.name)
                  }
                }}
              >
                <span className={styles.trendName}>
                  <span className={styles.typeBadge}>{TYPE_LABELS[trend.type]}</span>
                  {trend.name}
                </span>
                <span
                  className={`${styles.trendDirection} ${
                    trend.direction === 'rising'
                      ? styles.trendRising
                      : trend.direction === 'falling'
                        ? styles.trendFalling
                        : ''
                  }`}
                >
                  {DIRECTION_LABELS[trend.direction]}
                  {trend.direction !== 'stable' ? ` ${Math.abs(Math.round(trend.momentum * 100))}%` : ''}
                </span>
                <span className={styles.trendBars} aria-hidden="true">
                  {trend.series.map((count, index) => (
                    <span
                      key={index}
                      className={`${styles.trendBar} ${count === 0 ? styles.trendBarEmpty : ''}`}
                      style={{ height: `${Math.max(3, Math.min(20, count * 5))}px` }}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <span className={styles.sectionTitle}>全局实体图谱（点击实体检索）</span>
        {graphError ? <span className={styles.error}>{graphError}</span> : null}
        {!graphError && graph.length === 0 ? (
          <span className={styles.muted}>暂无实体数据（对话积累后自动生成）</span>
        ) : null}
        <div className={styles.entityCloud}>
          {graph.map((entity) => (
            <span
              key={`${entity.type}:${entity.name}`}
              role="button"
              tabIndex={0}
              title={`${TYPE_LABELS[entity.type]} · ${entity.sessionCount} 个会话 · 累计 ${entity.totalFreq} 次`}
              onClick={() => onSearchEntity(entity.name)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSearchEntity(entity.name)
                }
              }}
            >
              <Pill className={styles.entityPill}>
                <span className={styles.typeBadge}>{TYPE_LABELS[entity.type]}</span>
                {entity.name}
              </Pill>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
