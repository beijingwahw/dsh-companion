/**
 * 全局对话检索视图页（模块 D + E + G 客户端 UI，挂载于 conversation.view）：
 * - 检索模式开关：语义检索（模块 E，混合排序）/ 关键词检索（模块 D，FTS）；
 * - 顶部全局搜索框（防抖 300ms）+ 日期范围（两个 type=date 输入）+ 标签筛选（GET /tags 全量标签，Pill 可点击）；
 * - 语义模式不支持服务端标签过滤：基于全量标签映射在客户端反查过滤（会话 → 标签）；
 * - **检索智能提示栏**（轴线 8/10）：展示查询扩展溯源（拼写纠错/共现扩展）
 *   与质量判定（相关度强度 + 通道覆盖 + 首条可执行建议），把黑盒分数
 *   翻译成人话；
 * - 结果列表展示标题、时间、摘要片段、标签与语义排名徽章（词法/语义名次）；
 * - **深度研究**（模块 G，轴线 5）：以当前查询词为研究问题，跨全部历史
 *   对话检索证据并合成带 [编号] 引用的回答，来源可点击直达原会话；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  askSynthesis,
  fetchAllTags,
  fetchKnowledgePulse,
  fetchRetrievalClusters,
  fetchRetrievalInsights,
  fetchRetrievalSuggestions,
  recordRetrievalFeedback,
  searchRetrieval,
  searchSessions,
} from '../api.js'
import type {
  InsightCard,
  RetrievalCluster,
  RetrievalDiagnostics,
  RetrievalDiversity,
  RetrievalExpansion,
  RetrievalFeedback,
  RetrievalHit,
  RetrievalRescue,
  RetrievalSuggestion,
  SearchHit,
  SessionRecord,
  SynthesisAnswerResponse,
} from '../api.js'
import { KnowledgePanel, type KnowledgeTarget } from './KnowledgePanel.js'
import { CognitionPanel } from './CognitionPanel.js'
import styles from './SearchView.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface SearchViewProps {
  readonly sessionId?: string
}

/** 两种检索模式统一后的展示命中形状。 */
interface DisplayHit {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly tags: readonly string[]
  /** BM25 词法排名（仅语义模式）。 */
  readonly lexicalRank?: number
  /** 向量语义排名（仅语义模式）。 */
  readonly semanticRank?: number
  /** 命中解释摘要（轴线 15；仅语义模式）。 */
  readonly explanationSummary?: string
}

/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50

/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300

/** 深度研究请求超时（毫秒）：含多会话读取 + LLM 合成，放宽于常规请求。 */
const RESEARCH_TIMEOUT_MS = 180_000

/** 质量判定人话标签（轴线 10，与服务端 VERDICT_LABELS 对应）。 */
const VERDICT_LABELS: Readonly<Record<string, string>> = {
  strong: '强',
  fair: '中',
  weak: '弱',
  empty: '空',
}

/** 洞察卡片严重度排序权重（critical > watch > info；合并多脉搏源后重排用）。 */
const SEVERITY_RANK: Readonly<Record<InsightCard['severity'], number>> = {
  critical: 0,
  watch: 1,
  info: 2,
}

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 全局对话检索视图页。 */
export function SearchView(_props: SearchViewProps): ReactElement {
  /** 检索模式：true = 语义检索（模块 E 混合排序）；false = 关键词检索（模块 D）。 */
  const [semantic, setSemantic] = useState(true)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [allTags, setAllTags] = useState<readonly string[]>([])
  const [tagsError, setTagsError] = useState('')
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set())
  const [hits, setHits] = useState<readonly DisplayHit[]>([])
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 知识面板的洞察目标会话（点击结果行“知识”按钮设置）。 */
  const [insight, setInsight] = useState<KnowledgeTarget | null>(null)
  /** 检索智能（轴线 8）：本次语义检索的查询扩展溯源（无扩展为 null）。 */
  const [expansion, setExpansion] = useState<RetrievalExpansion | null>(null)
  /** 检索智能（轴线 10）：本次语义检索的质量诊断。 */
  const [diagnostics, setDiagnostics] = useState<RetrievalDiagnostics | null>(null)
  /** 反馈学习（轴线 11）：本次检索因历史点击获得加成的会话（无加成为 null）。 */
  const [feedback, setFeedback] = useState<RetrievalFeedback | null>(null)
  /** 多样性重排（轴线 12）：本次检索的 MMR 元信息。 */
  const [diversity, setDiversity] = useState<RetrievalDiversity | null>(null)
  /** 零命中救援（轴线 16）：本次检索的查询放宽溯源（未触发为 null）。 */
  const [rescue, setRescue] = useState<RetrievalRescue | null>(null)
  /** 查询建议（轴线 14）：输入框自动补全候选（空为无建议）。 */
  const [suggestions, setSuggestions] = useState<readonly RetrievalSuggestion[]>([])
  /** 建议下拉开合（聚焦/有候选时展开；选中或失焦收起）。 */
  const [suggestOpen, setSuggestOpen] = useState(false)
  /** 知识地图（轴线 13）：面板开合与聚类结果。 */
  const [mapOpen, setMapOpen] = useState(false)
  const [mapClusters, setMapClusters] = useState<readonly RetrievalCluster[] | null>(null)
  const [mapSessions, setMapSessions] = useState(0)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState('')
  /** 主动脉搏（轴线 18）：面板开合与洞察卡片。 */
  const [pulseOpen, setPulseOpen] = useState(false)
  const [pulseCards, setPulseCards] = useState<readonly InsightCard[] | null>(null)
  const [pulseSummary, setPulseSummary] = useState('')
  const [pulseLoading, setPulseLoading] = useState(false)
  const [pulseError, setPulseError] = useState('')
  /** 认知面板（轴线 20/21/22）：前瞻记忆 + 间隔重复 + 类比检索。 */
  const [cognitionOpen, setCognitionOpen] = useState(false)
  /** 深度研究（模块 G）：合成结果与状态。 */
  const [research, setResearch] = useState<SynthesisAnswerResponse | null>(null)
  const [researchQuestion, setResearchQuestion] = useState('')
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchError, setResearchError] = useState('')

  /**
   * 会话 → 标签 反查表（由全量标签映射 `标签 → 会话列表` 反转而来）：
   * 语义端点不支持服务端标签过滤，语义模式下用它做客户端过滤。
   */
  const sessionTagsRef = useRef<ReadonlyMap<string, ReadonlySet<string>>>(new Map())

  /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
  const rangeInvalid = from.length > 0 && to.length > 0 && from > to

  /** 语义模式下标签筛选是否生效（选中了任意标签即生效）。 */
  const tagFilterActive = selectedTags.size > 0

  // 搜索框防抖：停止输入 300ms 后才触发检索
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // 查询建议（轴线 14）：语义模式下随输入防抖拉取自动补全候选。
  // 建议请求独立于检索请求（输入中即出建议，不等检索完成）；失败静默
  // （建议是增强体验，不打扰主流程）。
  useEffect(() => {
    const input = query.trim()
    if (!semantic || input.length === 0) {
      setSuggestions([])
      setSuggestOpen(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      fetchRetrievalSuggestions({ q: query })
        .then((response) => {
          if (cancelled) return
          setSuggestions(response.suggestions)
        })
        .catch(() => {
          if (!cancelled) setSuggestions([])
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, semantic])

  // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射），
  // 同时反转出 会话 → 标签 表供语义模式的客户端标签过滤。
  useEffect(() => {
    let cancelled = false
    fetchAllTags()
      .then((response) => {
        if (cancelled) return
        setAllTags(Object.keys(response.tags))
        const inverted = new Map<string, Set<string>>()
        for (const [tag, sessionIds] of Object.entries(response.tags)) {
          for (const sessionId of sessionIds) {
            let bucket = inverted.get(sessionId)
            if (bucket === undefined) {
              bucket = new Set()
              inverted.set(sessionId, bucket)
            }
            bucket.add(tag)
          }
        }
        sessionTagsRef.current = inverted
      })
      .catch((err: unknown) => {
        if (!cancelled) setTagsError(err instanceof Error ? err.message : '标签加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 语义模式下的客户端标签过滤：命中会话需带全部选中标签。 */
  const passTagFilter = useCallback((sessionId: string): boolean => {
    if (selectedTags.size === 0) return true
    const tags = sessionTagsRef.current.get(sessionId)
    if (tags === undefined) return false
    for (const tag of selectedTags) {
      if (!tags.has(tag)) return false
    }
    return true
  }, [selectedTags])

  // 检索条件、模式或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
  useEffect(() => {
    // from 晚于 to：仅本地提示，不发起请求
    if (rangeInvalid) {
      setHits([])
      setError('起始日期不能晚于结束日期，请调整日期区间')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    /** 语义模式：混合排序端点（标签在客户端过滤）；关键词模式：FTS 端点。 */
    const request = semantic
      ? searchRetrieval(
          {
            query: debouncedQuery.trim(),
            from: from || undefined,
            to: to || undefined,
            limit: tagFilterActive ? limit * 4 : limit,
          },
        ).then((response): readonly DisplayHit[] => {
          // 轴线 8/10/11/12/16：捕获扩展溯源、质量诊断、反馈学习、
          // 多样性元信息与零命中救援溯源。
          if (!cancelled) {
            setExpansion(response.expansion ?? null)
            setDiagnostics(response.diagnostics ?? null)
            setFeedback(response.feedback ?? null)
            setDiversity(response.diversity ?? null)
            setRescue(response.rescue ?? null)
          }
          return response.hits
            .filter((hit) => passTagFilter(hit.session.id))
            .map((hit: RetrievalHit) => ({
              session: hit.session,
              snippet: hit.snippet,
              tags: [...(sessionTagsRef.current.get(hit.session.id) ?? [])],
              lexicalRank: hit.lexicalRank,
              semanticRank: hit.semanticRank,
              explanationSummary: hit.explanation?.summary,
            }))
        })
      : searchSessions({
          query: debouncedQuery.trim() || undefined,
          from: from || undefined,
          to: to || undefined,
          tags: [...selectedTags],
          limit,
        }).then((response): readonly DisplayHit[] => {
          // 关键词模式不带智能诊断：清空提示栏状态。
          if (!cancelled) {
            setExpansion(null)
            setDiagnostics(null)
            setFeedback(null)
            setDiversity(null)
            setRescue(null)
          }
          return response.hits.map((hit: SearchHit) => ({
            session: hit.session,
            snippet: hit.snippet,
            tags: hit.tags,
          }))
        })
    request
      .then((mapped) => {
        if (!cancelled) setHits(mapped)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '检索失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [semantic, debouncedQuery, from, to, selectedTags, limit, rangeInvalid, tagFilterActive, passTagFilter])

  /** 点击结果项：请求主平台跳转到该会话。
   *
   * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
   * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
   *
   * 轴线 11（反馈学习）：语义模式下点击即反馈——当前查询词并入该会话的
   * 点击画像，后续相似检索会温和上浮该会话。异步发射、失败静默（反馈
   * 是增强信号，不阻塞跳转，也不打扰用户）。
   */
  const openSession = useCallback(
    (sessionId: string): void => {
      window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }))
      Toast.push('已发送跳转请求', 'info')
      const queryText = debouncedQuery.trim()
      if (semantic && queryText.length > 0) {
        recordRetrievalFeedback({ query: queryText, sessionId }).catch(() => undefined)
      }
    },
    [semantic, debouncedQuery],
  )

  /**
   * 知识地图（轴线 13）：打开面板并按需拉取主题聚类（minSize=2 只看
   * 重复主题簇——「我重复解决过哪些问题」）；再次点击收起。
   */
  const toggleMap = useCallback((): void => {
    setMapOpen((prev) => {
      const next = !prev
      if (next && mapClusters === null && !mapLoading) {
        setMapLoading(true)
        setMapError('')
        fetchRetrievalClusters({ minSize: 2 })
          .then((response) => {
            setMapClusters(response.clusters)
            setMapSessions(response.sessions)
          })
          .catch((err: unknown) => {
            setMapError(err instanceof Error ? err.message : '知识地图加载失败')
          })
          .finally(() => {
            setMapLoading(false)
          })
      }
      return next
    })
  }, [mapClusters, mapLoading])

  /** 点击主题簇：以簇标签为检索词发起语义检索（知识地图 → 深入某主题）。 */
  const searchCluster = useCallback(
    (cluster: RetrievalCluster): void => {
      if (cluster.label.length === 0) return
      setQuery(cluster.label)
      setLimit(PAGE_SIZE)
    },
    [],
  )

  /**
   * 主动脉搏（轴线 18 + 认知三轴扩展）：打开面板并并行拉取两个脉搏源——
   * 检索侧（盲区/学习/索引）与认知侧（到期意图/复习/片段资产），卡片
   * 按严重度重排合并；认知源失败静默降级（认知是增强信号，不阻塞检索侧）。
   * 每次打开都重新拉取（洞察随状态变化）。
   */
  const togglePulse = useCallback((): void => {
    setPulseOpen((prev) => {
      const next = !prev
      if (next) {
        // 主动洞察的价值在于「此刻」：每次打开重新合成。
        setPulseLoading(true)
        setPulseError('')
        Promise.all([
          fetchRetrievalInsights(),
          fetchKnowledgePulse().catch(() => null),
        ])
          .then(([retrieval, cognition]) => {
            const cards = [...retrieval.cards, ...(cognition?.cards ?? [])].sort(
              (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
            )
            setPulseCards(cards)
            const summaries = [retrieval.summary, cognition?.summary].filter(
              (text): text is string => typeof text === 'string' && text.length > 0,
            )
            setPulseSummary(summaries.join('；'))
          })
          .catch((err: unknown) => {
            setPulseError(err instanceof Error ? err.message : '主动脉搏加载失败')
          })
          .finally(() => {
            setPulseLoading(false)
          })
      }
      return next
    })
  }, [])

  /** 切换检索模式（语义 ↔ 关键词）并重置分页。 */
  const toggleMode = useCallback((): void => {
    setSemantic((prev) => !prev)
    setLimit(PAGE_SIZE)
  }, [])

  /** 切换标签筛选（点击 Pill）。 */
  const toggleTag = useCallback((tag: string): void => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新查询词并重置分页。 */
  const handleQueryChange = useCallback((value: string): void => {
    setQuery(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新起始日期并重置分页。 */
  const handleFromChange = useCallback((value: string): void => {
    setFrom(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 更新结束日期并重置分页。 */
  const handleToChange = useCallback((value: string): void => {
    setTo(value)
    setLimit(PAGE_SIZE)
  }, [])

  /** 语义模式说明文案（标签过滤在客户端完成）。 */
  const modeHint = useMemo(
    () =>
      semantic
        ? tagFilterActive
          ? '语义检索 · 标签为本地过滤'
          : '语义检索 · 混合排序（BM25 + 向量）'
        : '关键词检索',
    [semantic, tagFilterActive],
  )

  /**
   * 深度研究（模块 G，轴线 5）：以当前查询词为研究问题，跨全部历史
   * 对话检索证据并合成带引用的回答。请求含多会话读取与 LLM 合成，
   * 超时放宽至 180 秒；发起时即时收起旧结果。
   */
  const runResearch = useCallback((): void => {
    const question = query.trim()
    if (!question) {
      Toast.push('请先输入研究问题，再点击深度研究', 'warning')
      return
    }
    setResearchLoading(true)
    setResearchError('')
    setResearch(null)
    setResearchQuestion(question)
    askSynthesis(question, { timeoutMs: RESEARCH_TIMEOUT_MS })
      .then((response) => {
        setResearch(response)
      })
      .catch((err: unknown) => {
        setResearchError(err instanceof Error ? err.message : '深度研究失败')
      })
      .finally(() => {
        setResearchLoading(false)
      })
  }, [query])

  /** 应用一条查询建议（轴线 14）：整体替换查询词并收起下拉。 */
  const applySuggestion = useCallback((suggestion: RetrievalSuggestion): void => {
    setQuery(suggestion.text)
    setLimit(PAGE_SIZE)
    setSuggestOpen(false)
  }, [])

  return (
    <div className={styles.view}>
      <header className={styles.toolbar}>
        <div
          className={styles.searchWrap}
          // Input 原语未开放 onFocus/onBlur，改挂包裹层（React 焦点事件冒泡到父级）。
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => {
            // 延迟收起：给点击建议项留出事件派发窗口。
            window.setTimeout(() => setSuggestOpen(false), 150)
          }}
        >
          <Input
            className={styles.searchInput}
            type="search"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder={semantic ? '语义检索历史对话…' : '关键词检索历史对话…'}
          />
          {semantic && suggestOpen && suggestions.length > 0 ? (
            <div className={styles.suggestList} role="listbox" aria-label="查询建议">
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.source}:${suggestion.term}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className={styles.suggestItem}
                  // onMouseDown 先于输入框 onBlur 触发，点击建议不会先丢焦点。
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applySuggestion(suggestion)
                  }}
                  title={`来自你的语料（${
                    suggestion.source === 'profile'
                      ? '你点过'
                      : suggestion.source === 'prefix'
                        ? '前缀补全'
                        : '共现续写'
                  }）`}
                >
                  <span className={styles.suggestText}>{suggestion.text}</span>
                  <span className={styles.suggestSource}>
                    {suggestion.source === 'profile'
                      ? '点过'
                      : suggestion.source === 'prefix'
                        ? '前缀'
                        : '共现'}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span
          role="button"
          tabIndex={0}
          aria-pressed={semantic}
          title="切换检索模式：语义（混合排序）↔ 关键词"
          onClick={toggleMode}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleMode()
            }
          }}
        >
          <Pill className={semantic ? styles.tagActive : styles.tag}>{modeHint}</Pill>
        </span>
        <label className={styles.dateField}>
          <span>从</span>
          <Input type="date" value={from} onChange={(event) => handleFromChange(event.target.value)} />
        </label>
        <label className={styles.dateField}>
          <span>至</span>
          <Input type="date" value={to} onChange={(event) => handleToChange(event.target.value)} />
        </label>
        {rangeInvalid ? <span className={styles.error}>起始日期不能晚于结束日期</span> : null}
        <Button
          variant="secondary"
          title="全部会话自动聚类为主题簇：发现重复解决的问题，点击簇深入检索"
          onClick={toggleMap}
        >
          {mapLoading ? '聚类中…' : '知识地图'}
        </Button>
        <Button
          variant="secondary"
          title="认知面板：到期的前瞻意图（说过要做的事）、间隔重复复习（问题→解法）、跨域类比检索"
          onClick={() => setCognitionOpen((prev) => !prev)}
        >
          认知面板
        </Button>
        <Button
          variant="secondary"
          disabled={pulseLoading}
          title="主动洞察：检索盲区 + 反馈学习 + 索引健康 + 认知信号（到期意图/复习/片段）的即时聚合"
          onClick={togglePulse}
        >
          {pulseLoading ? '合成中…' : '主动脉搏'}
        </Button>
        <Button
          variant="secondary"
          disabled={researchLoading}
          title="跨全部历史对话检索证据并合成带引用来源的回答"
          onClick={runResearch}
        >
          {researchLoading ? '研究中…' : '深度研究'}
        </Button>
      </header>

      {semantic && !loading && (expansion !== null || diagnostics !== null || rescue !== null) ? (
        <div className={styles.intelBar} aria-live="polite">
          {rescue !== null ? (
            <span className={styles.intelSegment}>
              {`零命中救援：原查询无结果，已自动放宽为「${rescue.queryText}」（${rescue.actions
                .map((action) =>
                  action.kind === 'correction'
                    ? `${action.from}→${action.to}`
                    : `剔除“${action.from}”`,
                )
                .join('、')}）`}
            </span>
          ) : null}
          {expansion !== null ? (
            <span className={styles.intelSegment}>
              已扩展：
              {expansion.notes.map((note) => (
                <Pill key={`${note.kind}:${note.from}:${note.to}`} className={styles.tag}>
                  {note.to}←{note.from}（{note.kind === 'correction' ? '纠错' : '共现'}）
                </Pill>
              ))}
            </span>
          ) : null}
          {feedback !== null && feedback.boosted.length > 0 ? (
            <span className={styles.intelSegment}>
              {`反馈学习：${feedback.boosted.length} 个会话因历史点击上浮（最高 +${Math.round(
                Math.max(...feedback.boosted.map((entry) => entry.boost)) * 100,
              )}%）`}
            </span>
          ) : null}
          {diversity !== null && diversity.applied ? (
            <span className={styles.intelSegment}>{`多样性重排已启用（λ=${diversity.lambda}，候选 ${diversity.pool}）`}</span>
          ) : null}
          {diagnostics !== null && diagnostics.verdict !== 'empty' ? (
            <span className={styles.intelSegment}>
              {`相关度 ${Math.round((diagnostics.topScore / diagnostics.maxScore) * 100)}%（${VERDICT_LABELS[diagnostics.verdict]}）· 词法覆盖 ${Math.round(diagnostics.lexicalCoverage * 100)}% · 语义覆盖 ${Math.round(diagnostics.semanticCoverage * 100)}%`}
            </span>
          ) : null}
          {diagnostics !== null && diagnostics.suggestions.length > 0 ? (
            <span className={styles.intelSegment}>{diagnostics.suggestions[0]}</span>
          ) : null}
        </div>
      ) : null}

      {(researchLoading || research !== null || researchError.length > 0) && (
        <div className={styles.researchPanel}>
          <div className={styles.researchHead}>
            <span className={styles.researchTitle}>
              深度研究{researchQuestion ? `：${researchQuestion}` : ''}
            </span>
            {!researchLoading ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setResearch(null)
                  setResearchError('')
                  setResearchQuestion('')
                }}
              >
                收起
              </Button>
            ) : null}
          </div>
          {researchLoading ? <Spinner label="检索历史对话并合成证据…" /> : null}
          {researchError ? <span className={styles.error}>{researchError}</span> : null}
          {research !== null ? (
            <>
              <div className={styles.researchAnswer}>{research.answer}</div>
              {research.evolution !== undefined && research.evolution.events.length > 0 ? (
                <div className={styles.evolutionPanel}>
                  <span className={styles.evolutionTitle}>知识演化（答案随时间变化的痕迹）</span>
                  {research.evolution.events.slice(0, 4).map((event) => (
                    <span key={`${event.anchor}:${event.from}:${event.to}`} className={styles.evolutionRow}>
                      {`${event.anchor}: ${event.from} → ${event.to}（${
                        event.kind === 'upgrade' ? '升级' : event.kind === 'downgrade' ? '回退' : '变化'
                      }，${formatTime(event.toAt)}）`}
                    </span>
                  ))}
                  <span className={styles.evolutionHint}>{research.evolution.summary}</span>
                </div>
              ) : null}
              {research.sources.length > 0 ? (
                <div className={styles.researchSources}>
                  <span className={styles.researchSourcesTitle}>证据来源（点击直达原会话）</span>
                  {research.sources.map((source, index) => (
                    <div
                      key={source.sessionId}
                      role="button"
                      tabIndex={0}
                      className={styles.researchSource}
                      title="点击跳转到该会话"
                      onClick={() => openSession(source.sessionId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openSession(source.sessionId)
                        }
                      }}
                    >
                      <span className={styles.researchSourceHead}>
                        <span className={styles.researchSourceIndex}>[{index + 1}]</span>
                        <span className={styles.researchSourceTitle}>
                          {source.title ?? `会话 ${source.sessionId}`}
                        </span>
                        <span className={styles.researchSourceTime}>
                          {formatTime(source.createdAt)}
                        </span>
                      </span>
                      {source.snippet.length > 0 ? (
                        <span className={styles.researchSourceSnippet}>{source.snippet}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <span className={styles.researchStats}>
                检索 {research.stats.candidates} 个会话 · 命中 {research.stats.chunks} 个片段 ·
                采用 {research.stats.evidenceChunks} 条证据 · {research.model}
              </span>
            </>
          ) : null}
        </div>
      )}

      {mapOpen ? (
        <div className={styles.mapPanel}>
          <div className={styles.mapHead}>
            <span className={styles.mapTitle}>
              知识地图{mapSessions > 0 ? `：${mapSessions} 个会话的主题分布` : ''}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                setMapOpen(false)
              }}
            >
              收起
            </Button>
          </div>
          {mapLoading ? <Spinner label="对历史会话做主题聚类…" /> : null}
          {mapError ? <span className={styles.error}>{mapError}</span> : null}
          {!mapLoading && !mapError && mapClusters !== null && mapClusters.length === 0 ? (
            <span className={styles.muted}>没有重复解决的主题簇（相似会话都只出现过一次）</span>
          ) : null}
          {!mapLoading && !mapError && mapClusters !== null && mapClusters.length > 0 ? (
            <div className={styles.mapClusters}>
              {mapClusters.map((cluster) => (
                <div
                  key={cluster.id}
                  role="button"
                  tabIndex={0}
                  className={styles.mapCluster}
                  title="点击以该主题发起语义检索"
                  onClick={() => searchCluster(cluster)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      searchCluster(cluster)
                    }
                  }}
                >
                  <span className={styles.mapClusterLabel}>{cluster.label}</span>
                  <span className={styles.mapClusterMeta}>
                    <Pill className={styles.rankBadge}>{cluster.size} 个会话</Pill>
                    <span className={styles.mapClusterTime}>
                      {formatTime(cluster.from)} ~ {formatTime(cluster.to)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {pulseOpen ? (
        <div className={styles.pulsePanel}>
          <div className={styles.mapHead}>
            <span className={styles.mapTitle}>
              主动脉搏{pulseSummary.length > 0 ? `：${pulseSummary}` : ''}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                setPulseOpen(false)
              }}
            >
              收起
            </Button>
          </div>
          {pulseLoading ? <Spinner label="聚合信号源并合成洞察…" /> : null}
          {pulseError ? <span className={styles.error}>{pulseError}</span> : null}
          {!pulseLoading && !pulseError && pulseCards !== null && pulseCards.length === 0 ? (
            <span className={styles.muted}>没有值得主动告知的信号——洞察随使用积累而生长</span>
          ) : null}
          {!pulseLoading && !pulseError && pulseCards !== null && pulseCards.length > 0 ? (
            <div className={styles.pulseCards}>
              {pulseCards.map((card, index) => (
                <div
                  key={`${card.category}:${index}`}
                  className={
                    card.severity === 'critical'
                      ? styles.pulseCardCritical
                      : card.severity === 'watch'
                        ? styles.pulseCardWatch
                        : styles.pulseCardInfo
                  }
                >
                  <span className={styles.pulseCardText}>{card.text}</span>
                  {card.action ? <span className={styles.pulseCardAction}>→ {card.action}</span> : null}
                  <span className={styles.pulseCardSource}>{card.source}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {cognitionOpen ? (
        <CognitionPanel onOpenSession={openSession} onClose={() => setCognitionOpen(false)} />
      ) : null}

      <div className={styles.tagRow}>
        {tagsError ? <span className={styles.error}>{tagsError}</span> : null}
        {!tagsError && allTags.length === 0 ? <span className={styles.muted}>暂无标签</span> : null}
        {allTags.map((tag) => (
          // Pill 原语不支持键盘交互属性（PillProps 未开放 role/tabIndex/onKeyDown），
          // 故以外层 span 补齐 role="button"、tabIndex 与 Enter/Space 键激活。
          <span
            key={tag}
            role="button"
            tabIndex={0}
            aria-pressed={selectedTags.has(tag)}
            onClick={() => toggleTag(tag)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleTag(tag)
              }
            }}
          >
            <Pill className={selectedTags.has(tag) ? styles.tagActive : styles.tag}>{tag}</Pill>
          </span>
        ))}
      </div>

      <div className={styles.results}>
        {loading && hits.length === 0 ? <Spinner label="检索中…" /> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!loading && !error && hits.length === 0 ? (
          <div className={styles.empty}>
            {semantic ? '没有语义相关的对话，试试换个说法或切换为关键词检索' : '没有匹配的对话，试试调整关键词、日期或标签'}
          </div>
        ) : null}

        {hits.map((hit) => (
          <div
            key={hit.session.id}
            role="button"
            tabIndex={0}
            className={styles.resultItem}
            title="点击跳转到该会话"
            onClick={() => openSession(hit.session.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openSession(hit.session.id)
              }
            }}
          >
            <span className={styles.resultHead}>
              <span className={styles.resultTitle}>{hit.session.title ?? `会话 ${hit.session.id}`}</span>
              <span className={styles.resultActions}>
                <span className={styles.resultTime}>
                  {formatTime(hit.session.updatedAt ?? hit.session.createdAt)}
                </span>
                {/* 包裹 span 拦截点击/键盘事件冒泡：Button 原语的 onClick 不
                    携带事件对象，改在父级阻止冒泡，避免触发整行跳转。 */}
                <span
                  className={styles.insightWrap}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Button
                    variant="secondary"
                    className={styles.insightButton}
                    title="查看该会话的知识资产：实体、建议标签、关联会话"
                    onClick={() => {
                      setInsight(
                        insight !== null && insight.id === hit.session.id
                          ? null
                          : { id: hit.session.id, title: hit.session.title },
                      )
                    }}
                  >
                    知识
                  </Button>
                </span>
              </span>
            </span>
            {hit.snippet ? <span className={styles.resultSnippet}>{hit.snippet}</span> : null}
            {hit.tags.length > 0 ? (
              <span className={styles.resultTags}>
                {hit.tags.map((tag) => (
                  <Pill key={tag} className={styles.resultTag}>
                    {tag}
                  </Pill>
                ))}
              </span>
            ) : null}
            {semantic && (hit.lexicalRank !== undefined || hit.semanticRank !== undefined) ? (
              <span className={styles.rankRow}>
                <Pill className={styles.rankBadge}>词法 #{hit.lexicalRank ?? '-'}</Pill>
                <Pill className={styles.rankBadge}>语义 #{hit.semanticRank ?? '-'}</Pill>
              </span>
            ) : null}
            {/* 轴线 15：命中解释——「为什么是这个会话」的人话摘要。 */}
            {hit.explanationSummary ? (
              <span className={styles.explainRow} title={hit.explanationSummary}>
                {hit.explanationSummary}
              </span>
            ) : null}
          </div>
        ))}

        {loading && hits.length > 0 ? <Spinner label="加载更多…" /> : null}
        {!loading && !error && hits.length >= limit ? (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => setLimit((prev) => prev + PAGE_SIZE)}>
              加载更多
            </Button>
          </div>
        ) : null}
      </div>

      <KnowledgePanel
        target={insight}
        onSearchEntity={(name) => handleQueryChange(name)}
        onOpenSession={openSession}
        onCloseTarget={() => setInsight(null)}
      />
    </div>
  )
}
