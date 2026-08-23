/**
 * 导出对话框（模块 A 客户端 UI）：
 * - 单会话导出（当前 sessionId）或勾选“批量导出”后会话列表多选、打包为 ZIP；
 * - 批量选择可视化界面（对齐回合选择面板）：全选/全不选工具栏 + 已选计数 +
 *   标题/ID 实时筛选（全选作用于当前筛选结果并与已有选择取并集）+ 勾选行
 *   高亮/未勾选行淡化；
 * - 回合级选择导出（能力吸收自 dsh-conv-export）：单会话模式下逐回合勾选
 *   （角色徽章 + 两行截断预览 + 时间），全选/全不选与已选计数实时更新，
 *   仅导出选中回合（如剔除失败的尝试或跑题的段落）；全选时不携带 turns 字段；
 * - 可选格式 Markdown/PDF/JSON/PNG 长图、保留时间戳（默认开）、隐私脱敏；
 * - 导出按钮带加载态与分片进度（done/total）；导出进行中「取消」按钮变为
 *   「中止导出」（AbortSignal 贯穿 API 请求与客户端光栅化），Esc 不再关闭
 *   对话框（对齐 dsh-conv-export 的面板纪律：进行中以取消按钮为唯一出口）；
 * - 成功按 kind 分流：file → 直接下载；raster → 客户端 canvas 光栅化为
 *   PNG 长图或免打印多页 PDF（全程无 window.print() 对话框）；
 *   print → 打开打印窗口（仅旧契约降级路径）；失败 Toast 提示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Spinner,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  base64ToBlob,
  downloadBlob,
  fetchExportSessions,
  fetchExportTurns,
  openPrintHtml,
  runExport,
  runExportBatch,
} from '../api.js'
import type { ExportFormat, ExportTurnSummary, SessionRecord } from '../api.js'
import { exportLongPng, exportRasterPdf } from '../raster.js'
import styles from './ExportDialog.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface ExportDialogProps {
  /** 当前会话 id；未勾选批量导出时导出该会话。 */
  readonly sessionId?: string
  readonly open: boolean
  readonly onClose: () => void
}

/** 格式选项（value 为 API 契约的 'markdown' | 'pdf' | 'json' | 'png'）。 */
const FORMAT_OPTIONS: ReadonlyArray<{ readonly value: ExportFormat; readonly label: string }> = [
  { value: 'markdown', label: 'Markdown（.md）' },
  { value: 'pdf', label: 'PDF（.pdf）' },
  { value: 'json', label: 'JSON（.json）' },
  { value: 'png', label: 'PNG 长图（.png）' },
]

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 回合角色 → 徽章展示名。 */
function roleLabel(role: ExportTurnSummary['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  return role
}

/** 回合角色 → 徽章配色类（用户蓝 / 助手绿 / 其余中性）。 */
function roleBadgeClass(role: ExportTurnSummary['role']): string {
  if (role === 'user') return styles.turnBadgeUser
  if (role === 'assistant') return styles.turnBadgeAssistant
  return styles.turnBadgeOther
}

/** 中止类错误判定（fetch 中止与光栅取消统一为 DOMException AbortError）。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** 导出对话框：格式/选项 + 回合级选择 + 批量会话多选 + 加载态与 Toast 反馈。 */
export function ExportDialog(props: ExportDialogProps): ReactElement {
  /** 局部常量：便于在回调中保持类型收窄，并作为 useCallback 的具体依赖。 */
  const sessionId = props.sessionId
  const onClose = props.onClose
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [timestamps, setTimestamps] = useState(true)
  const [redact, setRedact] = useState(false)
  const [batch, setBatch] = useState(false)
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState('')
  /** 批量选择的标题/ID 筛选词（客户端实时过滤，不分发服务端）。 */
  const [sessionFilter, setSessionFilter] = useState('')
  /** 回合预览列表（单会话模式的回合选择面板数据源）。 */
  const [turns, setTurns] = useState<readonly ExportTurnSummary[]>([])
  const [checkedTurns, setCheckedTurns] = useState<ReadonlySet<number>>(new Set())
  const [turnsLoading, setTurnsLoading] = useState(false)
  const [turnsError, setTurnsError] = useState('')
  const [exporting, setExporting] = useState(false)
  /** 光栅化进度文案（分片/页计数），空串表示无进度信息。 */
  const [progressLabel, setProgressLabel] = useState('')

  /** 挂载标记：异步回调在 setState 前检查，防止卸载后更新状态。 */
  const mountedRef = useRef(true)
  /** 进行中导出的中止控制器（API 请求与光栅化共用同一信号）。 */
  const abortRef = useRef<AbortController | null>(null)

  // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 打开对话框（单会话模式）时拉取回合预览列表；sessionId 变化时重拉，
  // 前一轮流询请求随 effect 清理中止；关闭时重置选择状态。
  // 批量模式下回合选择无意义（多会话无统一回合列表），不拉取。
  useEffect(() => {
    if (!props.open || batch || !sessionId) return
    const controller = new AbortController()
    setTurnsLoading(true)
    setTurnsError('')
    setTurns([])
    setCheckedTurns(new Set())
    fetchExportTurns(sessionId, { signal: controller.signal })
      .then((response) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setTurns(response.turns)
        // 默认全选：与“导出全部回合”等价（此时不携带 turns 字段）。
        setCheckedTurns(new Set(response.turns.map((turn) => turn.index)))
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return
        setTurnsError(error instanceof Error ? error.message : '回合列表加载失败')
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted) setTurnsLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [props.open, batch, sessionId])

  /** 拉取可导出的会话列表（进入批量模式时调用；mounted 守卫）。 */
  const loadSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true)
    setSessionsError('')
    try {
      const response = await fetchExportSessions()
      if (!mountedRef.current) return
      setSessions(response.sessions)
    } catch (error) {
      if (!mountedRef.current) return
      setSessionsError(error instanceof Error ? error.message : '会话列表加载失败')
    } finally {
      if (mountedRef.current) setSessionsLoading(false)
    }
  }, [])

  /** “批量导出”开关：首次打开时拉取会话列表。 */
  const handleBatchToggle = useCallback(
    (next: boolean): void => {
      setBatch(next)
      if (next && sessions.length === 0 && !sessionsLoading) {
        void loadSessions()
      }
    },
    [sessions.length, sessionsLoading, loadSessions],
  )

  /** 勾选/取消勾选某个会话。 */
  const toggleSelected = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 批量筛选结果：按标题或会话 ID 子串匹配（大小写不敏感）。 */
  const filteredSessions = useMemo(() => {
    const keyword = sessionFilter.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(
      (session) =>
        (session.title ?? '').toLowerCase().includes(keyword) ||
        session.id.toLowerCase().includes(keyword),
    )
  }, [sessions, sessionFilter])

  /**
   * 全选：作用于当前筛选结果并与已有选择取并集（筛选态下即「选中全部匹配项」，
   * 未筛选时即全量）；不匹配的已选会话保持选中不被清除。
   */
  const selectAllSessions = useCallback((): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const session of filteredSessions) next.add(session.id)
      return next
    })
  }, [filteredSessions])

  /** 全不选：清空全部已选会话（含被筛选隐藏的）。 */
  const selectNoSessions = useCallback((): void => {
    setSelectedIds(new Set())
  }, [])

  /** 勾选/取消勾选某个回合。 */
  const toggleTurn = useCallback((index: number): void => {
    setCheckedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  /** 全选/全不选回合。 */
  const selectAllTurns = useCallback((): void => {
    setCheckedTurns(new Set(turns.map((turn) => turn.index)))
  }, [turns])
  const selectNoTurns = useCallback((): void => {
    setCheckedTurns(new Set())
  }, [])

  /** 重拉回合列表（错误态重试入口）。 */
  const reloadTurns = useCallback((): void => {
    // 复用同一 effect 的拉取语义：临时切换 open 触发重跑成本高，
    // 这里直接内联拉取（与 effect 相同的守卫纪律）。
    if (!sessionId) return
    const controller = new AbortController()
    setTurnsLoading(true)
    setTurnsError('')
    fetchExportTurns(sessionId, { signal: controller.signal })
      .then((response) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setTurns(response.turns)
        setCheckedTurns(new Set(response.turns.map((turn) => turn.index)))
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return
        setTurnsError(error instanceof Error ? error.message : '回合列表加载失败')
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted) setTurnsLoading(false)
      })
  }, [sessionId])

  /** 中止进行中的导出（取消按钮在导出中的唯一职责）。 */
  const abortExport = useCallback((): void => {
    abortRef.current?.abort()
  }, [])

  /**
   * 对话框关闭请求：导出进行中忽略（Esc/点击遮罩不关闭面板，
   * 对齐 dsh-conv-export 的纪律——进行中以「中止导出」按钮为唯一出口）。
   */
  const requestClose = useCallback((): void => {
    if (exporting) return
    onClose()
  }, [exporting, onClose])

  /** 执行导出：区分单会话与批量，按响应 kind 触发下载或打印（mounted 守卫）。 */
  const handleExport = useCallback(async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    setProgressLabel('')
    const controller = new AbortController()
    abortRef.current = controller
    const onProgress = (done: number, total: number): void => {
      if (mountedRef.current) setProgressLabel(`正在导出… ${done}/${total}`)
    }
    try {
      if (batch) {
        if (format === 'png') {
          Toast.push('PNG 长图需逐张光栅化，不支持批量导出，请改用 Markdown/PDF/JSON', 'warning')
          return
        }
        const sessionIds = [...selectedIds]
        if (sessionIds.length === 0) {
          Toast.push('请至少勾选一个会话', 'warning')
          return
        }
        const result = await runExportBatch(
          { sessionIds, format, timestamps, redact },
          { signal: controller.signal },
        )
        if (!mountedRef.current) return
        downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName)
        Toast.push(`已导出 ${sessionIds.length} 个会话（ZIP 压缩包）`, 'success')
      } else {
        if (!sessionId) {
          Toast.push('当前没有可导出的会话，可勾选“批量导出”选择会话', 'warning')
          return
        }
        // 回合级选择：全选时不携带 turns（导出全部）；部分选择传选中下标。
        if (turns.length > 0 && checkedTurns.size === 0) {
          Toast.push('请至少勾选一个回合', 'warning')
          return
        }
        const turnIndices =
          turns.length > 0 && checkedTurns.size < turns.length
            ? [...checkedTurns].sort((a, b) => a - b)
            : undefined
        const result = await runExport(
          { sessionId, format, timestamps, redact, turns: turnIndices },
          { signal: controller.signal },
        )
        if (!mountedRef.current) return
        if (result.kind === 'file') {
          downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName)
        } else if (result.kind === 'raster') {
          // 客户端光栅化：PNG 长图或免打印多页 PDF（无 window.print() 对话框）；
          // 分片进度经 onProgress 更新按钮文案，取消信号贯穿逐片光栅（mounted 守卫）。
          if (result.target === 'png') {
            await exportLongPng(result.html, result.fileName, { onProgress, signal: controller.signal })
          } else {
            await exportRasterPdf(result.html, result.fileName, { onProgress, signal: controller.signal })
          }
        } else {
          // 旧契约降级路径：服务端返回可打印 HTML，新窗口写入并触发浏览器打印
          openPrintHtml(result.html)
        }
        Toast.push('导出成功', 'success')
      }
      onClose()
    } catch (error) {
      if (!mountedRef.current) return
      if (isAbortError(error)) {
        Toast.push('已中止导出', 'info')
      } else {
        Toast.push(error instanceof Error ? error.message : '导出失败，请稍后重试', 'error')
      }
    } finally {
      abortRef.current = null
      if (mountedRef.current) {
        setExporting(false)
        setProgressLabel('')
      }
    }
  }, [exporting, batch, selectedIds, format, timestamps, redact, sessionId, turns, checkedTurns, onClose])

  /** 导出按钮文案：批量 = 所选会话数；单会话部分选择 = 已选/总回合数。 */
  const exportButtonLabel = batch
    ? `导出所选（${selectedIds.size}）`
    : turns.length > 0 && checkedTurns.size < turns.length
      ? `导出所选回合（${checkedTurns.size}/${turns.length}）`
      : '导出'

  /** 回合选择区块可见性：单会话模式且有当前会话（批量模式隐藏）。 */
  const showTurns = !batch && Boolean(sessionId)

  return (
    <Modal
      open={props.open}
      title="导出对话"
      onClose={requestClose}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={exporting ? abortExport : requestClose}>
            {exporting ? '中止导出' : '取消'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleExport()}
            disabled={exporting || (showTurns && !turnsLoading && !turnsError && turns.length === 0)}
          >
            {exporting ? <Spinner label={progressLabel || '正在导出…'} /> : exportButtonLabel}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>导出格式</span>
          <Select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
            {FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>

        <div className={styles.options}>
          <Checkbox checked={timestamps} onChange={setTimestamps} label="保留时间戳" />
          <Checkbox checked={redact} onChange={setRedact} label="隐私脱敏（移除手机号 / 邮箱 / API Key 等敏感信息）" />
          <Checkbox checked={batch} onChange={handleBatchToggle} label="批量导出（多选会话，打包为 ZIP）" />
        </div>

        {showTurns ? (
          <div className={styles.turnSection}>
            <div className={styles.turnToolbar}>
              <span className={styles.turnSectionLabel}>导出回合</span>
              <div className={styles.turnToolbarButtons}>
                <Button variant="ghost" size="sm" onClick={selectAllTurns} disabled={turns.length === 0}>
                  全选
                </Button>
                <Button variant="ghost" size="sm" onClick={selectNoTurns} disabled={turns.length === 0}>
                  全不选
                </Button>
              </div>
              <span className={styles.turnCount}>
                已选 {checkedTurns.size}/{turns.length}
              </span>
            </div>
            <div className={styles.turnList}>
              {turnsLoading ? <Spinner label="加载回合列表…" /> : null}
              {!turnsLoading && turnsError ? (
                <div className={styles.error}>
                  <span>{turnsError}</span>
                  <Button variant="ghost" size="sm" onClick={reloadTurns}>
                    重试
                  </Button>
                </div>
              ) : null}
              {!turnsLoading && !turnsError && turns.length === 0 ? (
                <div className={styles.empty}>该会话暂无可导出的回合</div>
              ) : null}
              {!turnsLoading && !turnsError
                ? turns.map((turn) => {
                    const checked = checkedTurns.has(turn.index)
                    return (
                      <div
                        key={turn.index}
                        className={checked ? styles.turnItemChecked : styles.turnItem}
                        data-role={turn.role}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={() => toggleTurn(turn.index)}
                          label={
                            <span className={styles.turnMeta}>
                              <span className={roleBadgeClass(turn.role)}>{roleLabel(turn.role)}</span>
                              <span className={styles.turnPreview} title={turn.preview}>
                                {turn.preview}
                              </span>
                              <span className={styles.turnTime}>{formatTime(turn.time)}</span>
                            </span>
                          }
                        />
                      </div>
                    )
                  })
                : null}
            </div>
          </div>
        ) : null}

        {batch ? (
          <div className={styles.sessionSection}>
            <div className={styles.sessionToolbar}>
              <span className={styles.sessionSectionLabel}>选择会话</span>
              <div className={styles.sessionToolbarButtons}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectAllSessions}
                  disabled={sessions.length === 0}
                  title="选中当前列表中的全部会话（筛选时仅选中匹配项，已选会话不会被清除）"
                >
                  全选
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectNoSessions}
                  disabled={sessions.length === 0}
                >
                  全不选
                </Button>
              </div>
              <span className={styles.sessionCount}>
                已选 {selectedIds.size}/{sessions.length}
              </span>
            </div>
            <Input
              type="search"
              value={sessionFilter}
              onChange={(event) => setSessionFilter(event.target.value)}
              placeholder="按标题或会话 ID 筛选…"
            />
            <div className={styles.sessionList}>
              {sessionsLoading ? <Spinner label="加载会话列表…" /> : null}
              {!sessionsLoading && sessionsError ? (
                <div className={styles.error}>
                  <span>{sessionsError}</span>
                  <Button variant="ghost" size="sm" onClick={() => void loadSessions()}>
                    重试
                  </Button>
                </div>
              ) : null}
              {!sessionsLoading && !sessionsError && sessions.length === 0 ? (
                <div className={styles.empty}>暂无可导出的会话</div>
              ) : null}
              {!sessionsLoading && !sessionsError &&
              sessions.length > 0 &&
              filteredSessions.length === 0 ? (
                <div className={styles.empty}>没有匹配「{sessionFilter.trim()}」的会话</div>
              ) : null}
              {!sessionsLoading && !sessionsError
                ? filteredSessions.map((session) => {
                    const checked = selectedIds.has(session.id)
                    return (
                      <div
                        key={session.id}
                        className={checked ? styles.sessionItemChecked : styles.sessionItem}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={() => toggleSelected(session.id)}
                          label={
                            <span className={styles.sessionMeta}>
                              <span className={styles.sessionTitle}>
                                {session.title ?? `会话 ${session.id}`}
                              </span>
                              <span className={styles.sessionTime}>{formatTime(session.createdAt)}</span>
                            </span>
                          }
                        />
                      </div>
                    )
                  })
                : null}
            </div>
          </div>
        ) : null}

        {!batch && !props.sessionId ? (
          <div className={styles.hint}>未检测到当前会话，可勾选“批量导出”从列表中选择会话。</div>
        ) : null}
      </div>
    </Modal>
  )
}
