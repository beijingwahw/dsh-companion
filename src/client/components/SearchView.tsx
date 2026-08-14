/**
 * 全局对话检索视图页（模块 D 客户端 UI，挂载于 conversation.view）：
 * - 顶部全局搜索框（防抖 300ms）+ 日期范围（两个 type=date 输入）+ 标签筛选（GET /tags 全量标签，Pill 可点击）；
 * - 结果列表展示标题、时间、摘要片段与标签；
 * - 点击结果派发 `companion:open-session` 自定义事件请求主平台跳转（集成缝，见下注）；
 * - “加载更多”通过递增 limit 实现分页。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Pill, Spinner, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchAllTags, searchSessions } from '../api.js'
import type { SearchHit } from '../api.js'
import styles from './SearchView.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入（本视图不使用，仅为统一注入约定）。 */
export interface SearchViewProps {
  readonly sessionId?: string
}

/** 每次“加载更多”递增的条数。 */
const PAGE_SIZE = 50

/** 搜索输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 300

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 全局对话检索视图页。 */
export function SearchView(_props: SearchViewProps): ReactElement {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [allTags, setAllTags] = useState<readonly string[]>([])
  const [tagsError, setTagsError] = useState('')
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set())
  const [hits, setHits] = useState<readonly SearchHit[]>([])
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  /** 日期区间本地校验：YYYY-MM-DD 格式可直接按字典序比较，from 晚于 to 时不发请求。 */
  const rangeInvalid = from.length > 0 && to.length > 0 && from > to

  // 搜索框防抖：停止输入 300ms 后才触发检索
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // 挂载时拉取全量标签（GET /tags 缺省 sessionId 返回 标签 → 会话列表 映射）
  useEffect(() => {
    let cancelled = false
    fetchAllTags()
      .then((response) => {
        if (!cancelled) setAllTags(Object.keys(response.tags))
      })
      .catch((err: unknown) => {
        if (!cancelled) setTagsError(err instanceof Error ? err.message : '标签加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 检索条件或 limit 变化时重新请求（selectedTags 每次切换都是新 Set，引用变化即触发）
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
    searchSessions({
      query: debouncedQuery.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      tags: [...selectedTags],
      limit,
    })
      .then((response) => {
        if (!cancelled) setHits(response.hits)
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
  }, [debouncedQuery, from, to, selectedTags, limit, rangeInvalid])

  /** 点击结果项：请求主平台跳转到该会话。
   *
   * 集成缝说明：主平台客户端监听 `companion:open-session` 自定义事件完成会话切换；
   * 插件不直接依赖平台内部导航 API，事件即两者之间唯一的导航契约（见 DESIGN.md 第 6 节）。
   */
  const openSession = useCallback((sessionId: string): void => {
    window.dispatchEvent(new CustomEvent('companion:open-session', { detail: { sessionId } }))
    Toast.push('已发送跳转请求', 'info')
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

  return (
    <div className={styles.view}>
      <header className={styles.toolbar}>
        <Input
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          placeholder="全局检索历史对话…"
        />
        <label className={styles.dateField}>
          <span>从</span>
          <Input type="date" value={from} onChange={(event) => handleFromChange(event.target.value)} />
        </label>
        <label className={styles.dateField}>
          <span>至</span>
          <Input type="date" value={to} onChange={(event) => handleToChange(event.target.value)} />
        </label>
        {rangeInvalid ? <span className={styles.error}>起始日期不能晚于结束日期</span> : null}
      </header>

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
          <div className={styles.empty}>没有匹配的对话，试试调整关键词、日期或标签</div>
        ) : null}

        {hits.map((hit) => (
          <Button
            key={hit.session.id}
            variant="ghost"
            className={styles.resultItem}
            onClick={() => openSession(hit.session.id)}
          >
            <span className={styles.resultHead}>
              <span className={styles.resultTitle}>{hit.session.title ?? `会话 ${hit.session.id}`}</span>
              <span className={styles.resultTime}>
                {formatTime(hit.session.updatedAt ?? hit.session.createdAt)}
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
          </Button>
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
    </div>
  )
}
