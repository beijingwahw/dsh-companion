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
  acknowledgeInsights,
  askSynthesis,
  fetchAllTags,
  fetchInsights,
  fetchRetrievalClusters,
  fetchRetrievalSuggestions,
  recordRetrievalFeedback,
  reindexRetrieval,
  searchRetrieval,
  searchSessions,
  sendInsightFeedback,
} from '../api.js'
import type {
  InsightsResponse,
  ManagedInsightCard,
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

/** 主动智能 feed 低频刷新间隔（毫秒）：页面可见时每 5 分钟拉取一次。 */
const FEED_REFRESH_MS = 300_000

/** 质量判定人话标签（轴线 10，与服务端 VERDICT_LABELS 对应）。 */
const VERDICT_LABELS: Readonly<Record<string, string>> = {
  strong: '强',
  fair: '中',
  weak: '弱',
  empty: '空',
}

/** 洞察严重度人话徽章（critical > watch > info）。 */
const SEVERITY_LABELS: Readonly<Record<ManagedInsightCard['severity'], string>> = {
  critical: '严重',
  watch: '关注',
  info: '提示',
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
  /** 主动智能 feed（轴线 18 升级）：面板开合与统一托管洞察响应。 */
  const [feedOpen, setFeedOpen] = useState(false)
  const [feed, setFeed] = useState<InsightsResponse | null>(null)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState('')
  /** 卡片反馈/内置动作的失败提示（与拉取错误分行展示）。 */
  const [feedActionError, setFeedActionError] = useState('')
  /** 进行中的卡片反馈/动作（按卡片 id 防重复提交）。 */
  const [feedPending, setFeedPending] = useState<ReadonlySet<string>>(new Set())
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

  /** feed 请求中止控制器：新请求/卸载时中止旧请求。 */
  const feedAbortRef = useRef<AbortController | null>(null)
  /** feed 请求代次：并发刷新时只有最新一代允许写状态（防陈旧覆盖）。 */
  const feedGenRef = useRef(0)
  /** 本挂载周期是否已因 critical/watch 新未读自动展开过一次（info 不自动打扰）。 */
  const feedAutoExpandedRef = useRef(false)
  /** feed 开关按钮：收起面板后焦点还回。 */
  const feedToggleRef = useRef<HTMLButtonElement | null>(null)
  /** 深度研究请求中止控制器与代次（重入中止旧请求、卸载丢弃回调）。 */
  const researchAbortRef = useRef<AbortController | null>(null)
  const researchGenRef = useRef(0)

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
   * 知识地图（轴线 13）：开合面板；聚类拉取移到下述 effect
   * （副作用不放在 setState updater 内，避免 StrictMode 双调用重复请求）。
   */
  const toggleMap = useCallback((): void => {
    setMapOpen((prev) => !prev)
    // 重新打开时清空旧错误，允许失败后重试。
    setMapError('')
  }, [])

  // 知识地图数据加载：面板打开且尚无数据且无错误时按需拉取
  // （minSize=2 只看重复主题簇——「我重复解决过哪些问题」）；
  // cancelled 标志保证卸载/快速切换时不写入失效状态。
  useEffect(() => {
    if (!mapOpen || mapClusters !== null || mapError.length > 0) return
    let cancelled = false
    setMapLoading(true)
    fetchRetrievalClusters({ minSize: 2 })
      .then((response) => {
        if (cancelled) return
        setMapClusters(response.clusters)
        setMapSessions(response.sessions)
      })
      .catch((err: unknown) => {
        if (!cancelled) setMapError(err instanceof Error ? err.message : '知识地图加载失败')
      })
      .finally(() => {
        if (!cancelled) setMapLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mapOpen, mapClusters, mapError])

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
   * 主动智能 feed（轴线 18 升级）：统一洞察拉取。
   * - AbortController + 请求代次：新请求中止旧请求，只有最新一代允许写状态；
   * - force=true 让服务端重新合成（内置动作成功后使用）；
   * - 仅 critical/watch 的新未读在本挂载周期自动展开面板一次，info 不自动打扰。
   */
  const loadFeed = useCallback((force = false): void => {
    feedAbortRef.current?.abort()
    const controller = new AbortController()
    feedAbortRef.current = controller
    const gen = ++feedGenRef.current
    setFeedLoading(true)
    setFeedError('')
    fetchInsights(force ? { force: true } : undefined, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || gen !== feedGenRef.current) return
        setFeed(response)
        if (
          !feedAutoExpandedRef.current &&
          response.cards.some((card) => card.unread && card.severity !== 'info')
        ) {
          feedAutoExpandedRef.current = true
          setFeedOpen(true)
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || gen !== feedGenRef.current) return
        setFeedError(err instanceof Error ? err.message : '主动洞察加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted && gen === feedGenRef.current) setFeedLoading(false)
      })
  }, [])

  // 挂载即拉取 feed；页面可见时每 5 分钟低频刷新，切回可见时立即刷新；
  // 卸载时中止在途请求并作废代次。
  useEffect(() => {
    loadFeed()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadFeed()
    }, FEED_REFRESH_MS)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') loadFeed()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      feedAbortRef.current?.abort()
      feedGenRef.current += 1
    }
  }, [loadFeed])

  // 打开面板后 acknowledge 全部可见未读（上报失败静默：不阻塞浏览，
  // 下次刷新会再次尝试）；成功后本地同步未读标记与计数。
  useEffect(() => {
    if (!feedOpen || feed === null) return
    const unreadIds = feed.cards.filter((card) => card.unread).map((card) => card.id)
    if (unreadIds.length === 0) return
    let cancelled = false
    acknowledgeInsights({ ids: unreadIds })
      .then(() => {
        if (cancelled) return
        const acked = new Set(unreadIds)
        setFeed((prev) => {
          if (prev === null) return prev
          const cards = prev.cards.map((card) => (acked.has(card.id) ? { ...card, unread: false } : card))
          return { ...prev, cards, unreadCount: cards.filter((card) => card.unread).length }
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [feedOpen, feed])

  /** 开合主动智能 feed 面板。 */
  const toggleFeed = useCallback((): void => {
    setFeedOpen((prev) => !prev)
  }, [])

  /** 收起面板并把焦点还回开关按钮（键盘/读屏用户不丢上下文）。 */
  const closeFeed = useCallback((): void => {
    setFeedOpen(false)
    feedToggleRef.current?.focus()
  }, [])

  /** 标记一个卡片 id 进入/离开进行中状态（防重复提交）。 */
  const markFeedPending = useCallback((id: string, pending: boolean): void => {
    setFeedPending((prev) => {
      const next = new Set(prev)
      if (pending) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  /**
   * 卡片反馈：有用/无用在本地即时反映；稍后/忽略改变列表成员，
   * 成功后重新拉取 feed（不 force，走服务端缓存）。
   */
  const runCardFeedback = useCallback(
    (card: ManagedInsightCard, action: 'helpful' | 'unhelpful' | 'snooze' | 'dismiss'): void => {
      if (feedPending.has(card.id)) return
      markFeedPending(card.id, true)
      setFeedActionError('')
      sendInsightFeedback({ id: card.id, action })
        .then(() => {
          if (action === 'helpful' || action === 'unhelpful') {
            setFeed((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    cards: prev.cards.map((item) => (item.id === card.id ? { ...item, feedback: action } : item)),
                  },
            )
          } else {
            loadFeed()
          }
        })
        .catch((err: unknown) => {
          setFeedActionError(err instanceof Error ? err.message : '洞察反馈失败')
        })
        .finally(() => {
          markFeedPending(card.id, false)
        })
    },
    [feedPending, loadFeed, markFeedPending],
  )

  /** 恢复全部已忽略的洞察，成功后刷新 feed。 */
  const restoreDismissed = useCallback((): void => {
    setFeedActionError('')
    sendInsightFeedback({ action: 'restore-all' })
      .then(() => loadFeed())
      .catch((err: unknown) => {
        setFeedActionError(err instanceof Error ? err.message : '恢复忽略失败')
      })
  }, [loadFeed])

  /**
   * 卡片内置动作（白名单，绝不执行 card.action 文本或任意命令）：
   * - open-cognition：打开认知面板；
   * - reindex-retrieval：调用现有重建语义索引 API。
   * 成功后上报 acted 并强制刷新 feed；失败在面板内显示错误。
   */
  const runCardAction = useCallback(
    (card: ManagedInsightCard): void => {
      if (card.actionId === 'open-cognition') {
        setCognitionOpen(true)
        setFeedActionError('')
        sendInsightFeedback({ id: card.id, action: 'acted' })
          .then(() => loadFeed(true))
          .catch((err: unknown) => {
            setFeedActionError(err instanceof Error ? err.message : '洞察动作上报失败')
          })
        return
      }
      if (card.actionId === 'reindex-retrieval') {
        if (feedPending.has(card.id)) return
        markFeedPending(card.id, true)
        setFeedActionError('')
        reindexRetrieval()
          .then(() => sendInsightFeedback({ id: card.id, action: 'acted' }))
          .then(() => {
            Toast.push('语义索引已重建', 'success')
            loadFeed(true)
          })
          .catch((err: unknown) => {
            setFeedActionError(err instanceof Error ? err.message : '重建语义索引失败')
          })
          .finally(() => {
            markFeedPending(card.id, false)
          })
      }
    },
    [feedPending, loadFeed, markFeedPending],
  )

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
    // 重入中止上一次研究；代次 + abort 双重保证只有最新请求写状态。
    researchAbortRef.current?.abort()
    const controller = new AbortController()
    researchAbortRef.current = controller
    const gen = ++researchGenRef.current
    setResearchLoading(true)
    setResearchError('')
    setResearch(null)
    setResearchQuestion(question)
    askSynthesis(question, { timeoutMs: RESEARCH_TIMEOUT_MS, signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted && gen === researchGenRef.current) setResearch(response)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted && gen === researchGenRef.current) {
          setResearchError(err instanceof Error ? err.message : '深度研究失败')
        }
      })
      .finally(() => {
        if (gen === researchGenRef.current) setResearchLoading(false)
      })
  }, [query])

  // 卸载时中止在途深度研究请求并作废代次（回调不再写状态）。
  useEffect(() => {
    return () => {
      researchAbortRef.current?.abort()
      researchGenRef.current += 1
    }
  }, [])

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
                  // onMouseDown 仅 preventDefault（阻止输入框丢焦点导致下拉提前收起）；
                  // 实际应用走可靠 onClick，键盘/触摸/鼠标路径一致生效。
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySuggestion(suggestion)}
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
          className={styles.tagButton}
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
        {/* 主动智能 feed 开关：原生 button 以承载 aria-expanded/aria-controls
            与焦点还回（Button 原语未开放这些属性）；未读数徽章内联。 */}
        <button
          ref={feedToggleRef}
          type="button"
          className={styles.feedToggle}
          aria-expanded={feedOpen}
          aria-controls="companion-insights-feed"
          title="主动洞察：统一聚合检索/认知/成本等全部信号源的智能 feed，挂载后自动刷新"
          onClick={toggleFeed}
        >
          主动洞察
          {feed !== null && feed.unreadCount > 0 ? (
            <span className={styles.feedBadge} aria-label={`${feed.unreadCount} 条未读洞察`}>
              {feed.unreadCount > 99 ? '99+' : feed.unreadCount}
            </span>
          ) : null}
        </button>
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
              {`相关度 ${Math.round((diagnostics.topScore / diagnostics.maxScore) * 100)}%（${VERDICT_LABELS[diagnostics.verdict] ?? diagnostics.verdict}）· 词法覆盖 ${Math.round(diagnostics.lexicalCoverage * 100)}% · 语义覆盖 ${Math.round(diagnostics.semanticCoverage * 100)}%`}
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

      {feedOpen ? (
        <div
          className={styles.pulsePanel}
          id="companion-insights-feed"
          role="region"
          aria-label="主动洞察"
          aria-live="polite"
        >
          <div className={styles.mapHead}>
            <span className={styles.mapTitle}>
              主动洞察{feed !== null && feed.summary.length > 0 ? `：${feed.summary}` : ''}
            </span>
            <span className={styles.feedHeadActions}>
              {feed !== null && feed.dismissedCount > 0 ? (
                <Button variant="secondary" title="恢复全部已忽略的洞察卡片" onClick={restoreDismissed}>
                  恢复忽略（{feed.dismissedCount}）
                </Button>
              ) : null}
              <Button variant="secondary" onClick={closeFeed}>
                收起
              </Button>
            </span>
          </div>
          {feedLoading && feed === null ? <Spinner label="聚合信号源并合成洞察…" /> : null}
          {feedError ? <span className={styles.error}>{feedError}</span> : null}
          {feedActionError ? <span className={styles.error}>{feedActionError}</span> : null}
          {feed !== null && feed.providerFailures > 0 ? (
            <span className={styles.muted}>{feed.providerFailures} 个信号源暂时不可用，已展示其余可用信号</span>
          ) : null}
          {!feedLoading && !feedError && feed !== null && feed.cards.length === 0 ? (
            <span className={styles.muted}>没有值得主动告知的信号——洞察随使用积累而生长</span>
          ) : null}
          {feed !== null && feed.cards.length > 0 ? (
            <div className={styles.pulseCards} role="list" aria-label="洞察卡片列表">
              {feed.cards.map((card) => (
                <div
                  key={card.id}
                  role="listitem"
                  className={
                    card.severity === 'critical'
                      ? styles.pulseCardCritical
                      : card.severity === 'watch'
                        ? styles.pulseCardWatch
                        : styles.pulseCardInfo
                  }
                >
                  <span className={styles.feedCardHead}>
                    <Pill
                      className={
                        card.severity === 'critical'
                          ? styles.feedSevCritical
                          : card.severity === 'watch'
                            ? styles.feedSevWatch
                            : styles.feedSevInfo
                      }
                    >
                      {SEVERITY_LABELS[card.severity]}
                    </Pill>
                    {card.unread ? <Pill className={styles.feedUnread}>未读</Pill> : null}
                    <span className={styles.pulseCardSource}>{card.source}</span>
                  </span>
                  <span className={styles.pulseCardText}>{card.text}</span>
                  {/* action 仅为建议文本展示；客户端绝不把它作为命令执行。 */}
                  {card.action ? <span className={styles.pulseCardAction}>→ {card.action}</span> : null}
                  <span className={styles.feedCardActions}>
                    {card.actionId === 'open-cognition' || card.actionId === 'reindex-retrieval' ? (
                      <button
                        type="button"
                        className={styles.feedActionPrimary}
                        disabled={feedPending.has(card.id)}
                        onClick={() => runCardAction(card)}
                      >
                        {card.actionId === 'open-cognition' ? '打开认知面板' : '重建语义索引'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.feedAction}
                      aria-pressed={card.feedback === 'helpful'}
                      disabled={feedPending.has(card.id)}
                      title="这条洞察对我有用"
                      onClick={() => runCardFeedback(card, 'helpful')}
                    >
                      {card.feedback === 'helpful' ? '已标记有用' : '有用'}
                    </button>
                    <button
                      type="button"
                      className={styles.feedAction}
                      aria-pressed={card.feedback === 'unhelpful'}
                      disabled={feedPending.has(card.id)}
                      title="这条洞察对我没用"
                      onClick={() => runCardFeedback(card, 'unhelpful')}
                    >
                      {card.feedback === 'unhelpful' ? '已标记无用' : '无用'}
                    </button>
                    <button
                      type="button"
                      className={styles.feedAction}
                      disabled={feedPending.has(card.id)}
                      title="稍后提醒我"
                      onClick={() => runCardFeedback(card, 'snooze')}
                    >
                      稍后
                    </button>
                    <button
                      type="button"
                      className={styles.feedAction}
                      disabled={feedPending.has(card.id)}
                      title="忽略这条洞察（可在面板顶部恢复）"
                      onClick={() => runCardFeedback(card, 'dismiss')}
                    >
                      忽略
                    </button>
                  </span>
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
            className={styles.tagButton}
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
