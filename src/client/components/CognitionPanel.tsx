/**
 * 认知面板（轴线 20–25 客户端 UI）：对话历史从被动资产变成主动认知伙伴。
 * - **前瞻记忆**（轴线 20）：对话里说过要做的事，到期主动浮现——
 *   「5 天前你说要试试 X，做了吗？」；即将到来的意图提前预告；
 * - **间隔重复**（轴线 21）：历史「问题→解法」片段的检索式练习——
 *   先看问题回忆解法（回忆比重看记得牢），再自评「记得/忘了」，
 *   SM2-lite 阶梯调度（1/3/7/14/30/60 天）；
 * - **类比检索**（轴线 22）：以当前问题描述找**结构同构**的历史经验——
 *   主题不同而约束结构相同（如 docker 网络隔离 ↔ k8s service 互通），
 *   跨域命中单独标注——这是主题检索永远找不到的先例；
 * - **遗忘预测**（轴线 23）：每条知识的连续保持率画像——
 *   ≥70% 健康 / 30–70% 滑落区（最佳巩固窗口）/ <30% 深度遗忘，
 *   在你遗忘之前看见它正在滑落；
 * - **个体节律**（轴线 24）：间隔随你的真实记忆表现伸缩
 *   （目标 85% 命中率 = 合意困难），你不是「平均人类」；
 * - **负荷调度**（轴线 25）：到期复习按可救性分诊、每日封顶、
 *   洪峰顺延——复习是一份每日计划，不是一场倾倒。
 *
 * 数据全部来自本地 /knowledge/* 认知端点（提取与调度在宿主侧本地
 * 完成，零 LLM、零网络外发）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchKnowledgeCognition,
  gradeKnowledgeReview,
  searchKnowledgeAnalogy,
} from '../api.js'
import type {
  KnowledgeAnalogyResponse,
  KnowledgeCognitionResponse,
  KnowledgeForecastResponse,
} from '../api.js'
import styles from './CognitionPanel.module.css'

/** 到期复习区默认展示的卡片数（检索式练习一次不宜贪多）。 */
const REVIEW_LIMIT = 5

/** 到期意图区默认展示条数。 */
const DUE_LIMIT = 8

/** 遗忘预测区展示的最危险条目数。 */
const FORECAST_LIMIT = 3

/** 类比查询输入的最大长度（与服务端校验一致）。 */
const ANALOGY_MAX_LENGTH = 500

/** 毫秒时间戳 → 日期（YYYY-MM-DD）。 */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 预测条目的滑落速度注记：N 天后跌入深度遗忘 / 已跌破。 */
function forecastEta(item: KnowledgeForecastResponse['warning'][number]): string {
  if (item.daysToThreshold <= 0) return '已跌破阈值'
  return `${Math.ceil(item.daysToThreshold)} 天后跌入深度遗忘`
}

/** 保持率 → 进度条填充色类名（分区语义色）。 */
function retentionBarClass(zone: 'stable' | 'warning' | 'critical'): string {
  if (zone === 'critical') return styles.barCritical
  if (zone === 'warning') return styles.barWarning
  return styles.barStable
}

/** 类比命中的跨域/同域徽章文案。 */
function analogyBadge(hit: KnowledgeAnalogyResponse['analogies'][number]): string {
  return hit.crossDomain ? '跨域类比' : '同域先例'
}

/** 组件 props。 */
export interface CognitionPanelProps {
  /** 点击来源会话（意图/类比命中）：请求主平台跳转。 */
  readonly onOpenSession: (sessionId: string) => void
  /** 收起认知面板。 */
  readonly onClose: () => void
}

/** 认知面板。 */
export function CognitionPanel({ onOpenSession, onClose }: CognitionPanelProps): ReactElement {
  const [overview, setOverview] = useState<KnowledgeCognitionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 已翻开解法面的复习卡片（检索式练习：先回忆再核对）。 */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  /** 评分中的卡片（防重复提交）。 */
  const [grading, setGrading] = useState('')
  /** 类比检索：查询词与结果。 */
  const [analogyQuery, setAnalogyQuery] = useState('')
  const [analogy, setAnalogy] = useState<KnowledgeAnalogyResponse | null>(null)
  const [analogyLoading, setAnalogyLoading] = useState(false)
  const [analogyError, setAnalogyError] = useState('')

  // 挂载时拉取认知总览（到期意图 + 到期复习 + 统计，单次请求）。
  useEffect(() => {
    let cancelled = false
    fetchKnowledgeCognition()
      .then((response) => {
        if (!cancelled) setOverview(response)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '认知总览加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 翻开一张复习卡片的解法面。 */
  const reveal = useCallback((episodeId: string): void => {
    setRevealed((prev) => new Set([...prev, episodeId]))
  }, [])

  /**
   * 复习评分（轴线 21）：记得 → 升档（间隔拉长）；忘了 → 归零（明天重来）。
   * 评分成功后卡片离开本期队列，Toast 告知下次复习时间。
   */
  const grade = useCallback((episodeId: string, remembered: boolean): void => {
    setGrading(episodeId)
    gradeKnowledgeReview({ episodeId, remembered })
      .then((response) => {
        const rhythmNote =
          response.ease !== undefined ? `（节律 ×${response.ease.toFixed(2)}）` : ''
        Toast.push(
          remembered
            ? `记得！已升档，下次复习：${response.nextIntervalDays} 天后${rhythmNote}`
            : `已归零重来，明天再复习一次${rhythmNote}`,
          'info',
        )
        setOverview((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                reviews: prev.reviews.filter((item) => item.episodeId !== episodeId),
                plan:
                  prev.plan === undefined
                    ? undefined
                    : {
                        ...prev.plan,
                        today: prev.plan.today.filter(
                          (item) => item.review.episodeId !== episodeId,
                        ),
                      },
                rhythm:
                  prev.rhythm === undefined || response.ease === undefined
                    ? prev.rhythm
                    : { ...prev.rhythm, ease: response.ease },
              },
        )
        setRevealed((prev) => {
          const next = new Set(prev)
          next.delete(episodeId)
          return next
        })
      })
      .catch((err: unknown) => {
        Toast.push(err instanceof Error ? err.message : '复习评分失败', 'error')
      })
      .finally(() => {
        setGrading('')
      })
  }, [])

  /** 发起类比检索（轴线 22：以结构形状找同构先例）。 */
  const runAnalogy = useCallback((): void => {
    const q = analogyQuery.trim()
    if (q.length === 0) {
      Toast.push('请先描述当前遇到的问题', 'warning')
      return
    }
    setAnalogyLoading(true)
    setAnalogyError('')
    searchKnowledgeAnalogy(q)
      .then((response) => {
        setAnalogy(response)
      })
      .catch((err: unknown) => {
        setAnalogyError(err instanceof Error ? err.message : '类比检索失败')
      })
      .finally(() => {
        setAnalogyLoading(false)
      })
  }, [analogyQuery])

  const dueIntentions = overview?.intentions.due.slice(0, DUE_LIMIT) ?? []
  const upcoming = overview?.intentions.upcoming ?? []
  const stats = overview?.stats
  const forecast = overview?.forecast
  const plan = overview?.plan
  const rhythm = overview?.rhythm

  /**
   * 复习卡片源（轴线 25 感知）：负荷计划的今日精选带分诊结论
   * （保持率 + 理由）；旧服务端无 plan 时回退到期清单。
   */
  const reviewCards: ReadonlyArray<{
    episodeId: string
    problem: string
    solution: string
    overdueDays: number
    fresh: boolean
    strength: number
    retention?: number
    reason?: string
  }> =
    plan !== undefined && plan.today.length > 0
      ? plan.today.slice(0, REVIEW_LIMIT).map((item) => ({
          ...item.review,
          retention: item.retention,
          reason: item.reason,
        }))
      : (overview?.reviews.slice(0, REVIEW_LIMIT) ?? [])

  /** 预测区展示条目：滑落区优先（最佳巩固窗口），无滑落时展示深度遗忘。 */
  const forecastItems =
    forecast === undefined
      ? []
      : forecast.warning.length > 0
        ? forecast.warning.slice(0, FORECAST_LIMIT)
        : forecast.critical.slice(0, FORECAST_LIMIT)

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>认知面板</span>
        {stats ? (
          <span className={styles.stats}>
            {`${stats.sessions} 个会话 · ${stats.intentions} 条意图 · ${stats.episodes} 条经验 · ${stats.reviewStates} 条在巩固`}
          </span>
        ) : null}
        <Button variant="secondary" onClick={onClose}>
          收起
        </Button>
      </div>

      {loading ? <Spinner label="汇总认知信号…" /> : null}
      {error ? <span className={styles.error}>{error}</span> : null}

      {!loading && !error ? (
        <>
          <div className={styles.section}>
            <span className={styles.sectionTitle}>说过要做的事（前瞻记忆）</span>
            {dueIntentions.length === 0 ? (
              <span className={styles.muted}>没有到期的意图——说过要做的事会在到期时在这里浮现</span>
            ) : (
              <div className={styles.intentionList}>
                {dueIntentions.map((item) => (
                  <div
                    key={`${item.sessionId}:${item.dueAt}:${item.text}`}
                    className={styles.intentionItem}
                    role="button"
                    tabIndex={0}
                    title="点击跳转到意图来源会话"
                    onClick={() => onOpenSession(item.sessionId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenSession(item.sessionId)
                      }
                    }}
                  >
                    <span className={styles.intentionText}>{item.text}</span>
                    <span
                      className={`${styles.overdueBadge} ${
                        item.overdueDays >= 14 ? styles.overdueCritical : ''
                      }`}
                    >
                      {item.overdueDays === 0 ? '今天到期' : `超期 ${item.overdueDays} 天`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {upcoming.length > 0 ? (
              <span className={styles.upcoming}>
                {`即将到来：${upcoming
                  .slice(0, 3)
                  .map((item) => `${formatDate(item.dueAt)}「${item.text.slice(0, 24)}」`)
                  .join('、')}`}
              </span>
            ) : null}
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <span className={styles.sectionTitleRow}>
              <span className={styles.sectionTitle}>遗忘预测（保持率实时画像）</span>
              {forecast !== undefined ? (
                <span className={styles.rhythmMark} title={forecast.summary}>
                  {`稳定 ${forecast.stableCount} · 滑落 ${forecast.warningCount} · 深忘 ${forecast.criticalCount}`}
                </span>
              ) : null}
            </span>
            {forecast === undefined ? (
              <span className={styles.muted}>遗忘预测不可用</span>
            ) : forecastItems.length === 0 ? (
              <span className={styles.muted}>所有知识保持率 ≥70%——记忆状态健康</span>
            ) : (
              <div className={styles.forecastList}>
                {forecastItems.map((item) => (
                  <div
                    key={item.episodeId}
                    className={styles.forecastItem}
                    role="button"
                    tabIndex={0}
                    title="点击跳转到该知识来源会话"
                    onClick={() => onOpenSession(item.sessionId)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenSession(item.sessionId)
                      }
                    }}
                  >
                    <span className={styles.forecastProblem}>{item.problem}</span>
                    <span className={styles.retentionBar}>
                      <span className={styles.retentionTrack}>
                        <span
                          className={`${styles.bar} ${retentionBarClass(item.zone)}`}
                          style={{ width: `${Math.max(2, Math.round(item.retention * 100))}%` }}
                        />
                      </span>
                      <span className={styles.retentionText}>
                        {`${Math.round(item.retention * 100)}% · ${
                          item.zone === 'warning' ? '滑落区' : '深度遗忘'
                        }`}
                      </span>
                    </span>
                    <span className={styles.forecastEta}>{forecastEta(item)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <span className={styles.sectionTitleRow}>
              <span className={styles.sectionTitle}>到期复习（先回忆，再看解法）</span>
              {plan !== undefined && plan.health === 'overload' ? (
                <Pill className={styles.overloadPill}>{`复习洪峰：${plan.deferredCount} 条顺延`}</Pill>
              ) : null}
              {rhythm !== undefined ? (
                <span
                  className={styles.rhythmMark}
                  title={`个体节律（轴线 24）：间隔乘子 ${rhythm.ease.toFixed(2)}，目标 85% 命中率`}
                >
                  {`节律 ×${rhythm.ease.toFixed(2)}`}
                </span>
              ) : null}
            </span>
            {plan !== undefined && plan.totalDue > plan.today.length ? (
              <span className={styles.planSummary}>{plan.summary}</span>
            ) : null}
            {reviewCards.length === 0 ? (
              <span className={styles.muted}>
                没有到期的复习卡片——解决过问题的对话会自动积累成卡片，次日首复习
              </span>
            ) : (
              <div className={styles.reviewList}>
                {reviewCards.map((item) => (
                  <div key={item.episodeId} className={styles.reviewCard}>
                    <span className={styles.reviewProblem}>{item.problem}</span>
                    {item.reason ? (
                      <span className={styles.triageRow}>
                        <span className={styles.retentionMini}>{`保持率 ${Math.round((item.retention ?? 0) * 100)}%`}</span>
                        <span className={styles.triageReason}>{item.reason}</span>
                      </span>
                    ) : null}
                    {revealed.has(item.episodeId) ? (
                      <span className={styles.reviewSolution}>{item.solution}</span>
                    ) : (
                      <Button variant="secondary" onClick={() => reveal(item.episodeId)}>
                        回想后看解法
                      </Button>
                    )}
                    {revealed.has(item.episodeId) ? (
                      <span className={styles.gradeRow}>
                        <Button
                          variant="secondary"
                          disabled={grading === item.episodeId}
                          title="记得：间隔升档（1→3→7→14→30→60 天）"
                          onClick={() => grade(item.episodeId, true)}
                        >
                          记得
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={grading === item.episodeId}
                          title="忘了：归零重来，明天再复习"
                          onClick={() => grade(item.episodeId, false)}
                        >
                          忘了
                        </Button>
                        <span className={styles.reviewMeta}>
                          {item.fresh ? '首次复习' : `巩固度 ${Math.round(item.strength * 100)}%`}
                          {item.overdueDays > 0 ? ` · 逾期 ${item.overdueDays} 天` : ''}
                        </span>
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.divider} />

          <div className={styles.section}>
            <span className={styles.sectionTitle}>类比检索（找结构同构的先例）</span>
            <div className={styles.analogyRow}>
              <Input
                className={styles.analogyInput}
                type="search"
                value={analogyQuery}
                placeholder="描述当前的问题（如：两个服务互相调用一直超时）…"
                onChange={(event) => setAnalogyQuery(event.target.value.slice(0, ANALOGY_MAX_LENGTH))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runAnalogy()
                }}
              />
              <Button variant="secondary" disabled={analogyLoading} onClick={runAnalogy}>
                {analogyLoading ? '检索中…' : '找类比'}
              </Button>
            </div>
            {analogyError ? <span className={styles.error}>{analogyError}</span> : null}
            {analogy ? (
              <>
                <span className={styles.analogySummary}>{analogy.summary}</span>
                {analogy.analogies.length > 0 ? (
                  <div className={styles.analogyList}>
                    {analogy.analogies.map((hit) => (
                      <div
                        key={hit.episodeId}
                        className={styles.analogyCard}
                        role="button"
                        tabIndex={0}
                        title="点击跳转到该会话"
                        onClick={() => onOpenSession(hit.sessionId)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onOpenSession(hit.sessionId)
                          }
                        }}
                      >
                        <span className={styles.analogyHead}>
                          <span className={styles.analogyBadgeRow}>
                            <Pill
                              className={hit.crossDomain ? styles.crossDomainPill : styles.sameDomainPill}
                            >
                              {analogyBadge(hit)}
                            </Pill>
                            <span className={styles.analogyScore}>
                              {`结构相似度 ${Math.round(hit.score * 100)}%`}
                            </span>
                          </span>
                          <span className={styles.analogyTitle}>
                            {hit.title ?? `会话 ${hit.sessionId}`}
                          </span>
                        </span>
                        {hit.sharedConstraints.length > 0 ? (
                          <span className={styles.sharedRow}>
                            {hit.sharedConstraints.map((kind) => (
                              <Pill key={kind} className={styles.sharedPill}>
                                {kind}
                              </Pill>
                            ))}
                          </span>
                        ) : null}
                        <span className={styles.analogyProblem}>{hit.problem}</span>
                        <span className={styles.analogySolution}>{hit.solution}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
