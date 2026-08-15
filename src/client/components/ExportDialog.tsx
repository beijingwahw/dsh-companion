/**
 * 导出对话框（模块 A 客户端 UI）：
 * - 单会话导出（当前 sessionId）或勾选“批量导出”后会话列表多选、打包为 ZIP；
 * - 可选格式 Markdown/PDF/JSON/PNG 长图、保留时间戳（默认开）、隐私脱敏；
 * - 导出按钮带加载态；成功按 kind 分流：
 *   file → 直接下载；raster → 客户端 canvas 光栅化为 PNG 长图或免打印多页 PDF
 *   （能力吸收自 dsh-conv-export，全程无 window.print() 对话框）；
 *   print → 打开打印窗口（仅旧契约降级路径）；失败 Toast 提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Checkbox,
  Modal,
  Select,
  Spinner,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  base64ToBlob,
  downloadBlob,
  fetchExportSessions,
  openPrintHtml,
  runExport,
  runExportBatch,
} from '../api.js'
import type { ExportFormat, SessionRecord } from '../api.js'
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

/** 导出对话框：格式/选项 + 批量会话多选 + 加载态与 Toast 反馈。 */
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
  const [exporting, setExporting] = useState(false)

  /** 挂载标记：异步回调在 setState 前检查，防止卸载后更新状态。 */
  const mountedRef = useRef(true)

  // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

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

  /** 执行导出：区分单会话与批量，按响应 kind 触发下载或打印（mounted 守卫）。 */
  const handleExport = useCallback(async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
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
        const result = await runExportBatch({ sessionIds, format, timestamps, redact })
        if (!mountedRef.current) return
        downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName)
        Toast.push(`已导出 ${sessionIds.length} 个会话（ZIP 压缩包）`, 'success')
      } else {
        if (!sessionId) {
          Toast.push('当前没有可导出的会话，可勾选“批量导出”选择会话', 'warning')
          return
        }
        const result = await runExport({ sessionId, format, timestamps, redact })
        if (!mountedRef.current) return
        if (result.kind === 'file') {
          downloadBlob(base64ToBlob(result.contentBase64, result.mimeType), result.fileName)
        } else if (result.kind === 'raster') {
          // 客户端光栅化：PNG 长图或免打印多页 PDF（无 window.print() 对话框）
          if (result.target === 'png') {
            await exportLongPng(result.html, result.fileName)
          } else {
            await exportRasterPdf(result.html, result.fileName)
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
      Toast.push(error instanceof Error ? error.message : '导出失败，请稍后重试', 'error')
    } finally {
      if (mountedRef.current) setExporting(false)
    }
  }, [exporting, batch, selectedIds, format, timestamps, redact, sessionId, onClose])

  return (
    <Modal
      open={props.open}
      title="导出对话"
      // 导出进行中禁止经遮罩/Esc 关闭：异步流仍在跑，关闭后成功回调会作用于已卸载的对话框。
      onClose={() => {
        if (!exporting) props.onClose()
      }}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={props.onClose} disabled={exporting}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleExport()} disabled={exporting}>
            {exporting ? (
              <Spinner label="正在导出…" />
            ) : batch ? (
              `导出所选（${selectedIds.size}）`
            ) : (
              '导出'
            )}
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

        {batch ? (
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
            {!sessionsLoading && !sessionsError
              ? sessions.map((session) => (
                  <div key={session.id} className={styles.sessionItem}>
                    <Checkbox
                      checked={selectedIds.has(session.id)}
                      onChange={() => toggleSelected(session.id)}
                      label={
                        <span className={styles.sessionMeta}>
                          <span className={styles.sessionTitle}>{session.title ?? `会话 ${session.id}`}</span>
                          <span className={styles.sessionTime}>{formatTime(session.createdAt)}</span>
                        </span>
                      }
                    />
                  </div>
                ))
              : null}
          </div>
        ) : null}

        {!batch && !props.sessionId ? (
          <div className={styles.hint}>未检测到当前会话，可勾选“批量导出”从列表中选择会话。</div>
        ) : null}
      </div>
    </Modal>
  )
}
