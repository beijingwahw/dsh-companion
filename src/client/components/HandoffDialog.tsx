/**
 * 交接摘要对话框（模块 B 客户端 UI）：
 * - 会话选择可视化面板：列出全部历史会话（复用 GET /export/sessions），
 *   支持按标题/ID 实时筛选、单选任意会话（不限于当前会话）、当前会话
 *   带「当前」徽章；打开时默认选中当前会话并自动生成摘要，
 *   切换选中后自动重新生成（取消在途请求、重置脏标记）；
 * - 结果置于可编辑 Textarea，可复制到剪贴板、保存为模板、作为新对话起点武装；
 * - 模板列表支持载入与删除；加载与错误态齐全。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Input,
  Modal,
  Spinner,
  Textarea,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  deleteHandoffTemplate,
  fetchExportSessions,
  fetchHandoffTemplates,
  generateHandoff,
  importHandoff,
  saveHandoffTemplate,
} from '../api.js'
import type { HandoffTemplate, SessionRecord } from '../api.js'
import styles from './HandoffDialog.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface HandoffDialogProps {
  /** 当前会话 id；存在时打开对话框自动生成摘要。 */
  readonly sessionId?: string
  readonly open: boolean
  readonly onClose: () => void
}

/** 毫秒时间戳 → 本地可读日期时间。 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 交接摘要对话框：会话选择 + 生成/编辑摘要 + 模板管理 + 武装到新对话。 */
export function HandoffDialog(props: HandoffDialogProps): ReactElement {
  /** 当前会话 id（const 局部量，便于在回调中保持类型收窄）。 */
  const sessionId = props.sessionId
  /** 会话选择面板状态：历史会话列表 + 选中项 + 筛选词。 */
  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [summary, setSummary] = useState('')
  const [model, setModel] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [templates, setTemplates] = useState<readonly HandoffTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deletingName, setDeletingName] = useState<string | null>(null)

  /** 脏标记：用户一旦手动编辑过摘要，后续（慢）生成结果返回时不再覆盖内容。 */
  const dirtyRef = useRef(false)

  /** 调用服务端为指定会话生成交接摘要。
   *
   * - signal 被中止或 isCancelled 为真（卸载 / sessionId 变化）时静默返回，不再更新任何状态；
   * - 用户已手动编辑过内容（dirtyRef）时，返回的摘要不再覆盖编辑区。
   */
  const generate = useCallback(
    async (targetSessionId: string, signal?: AbortSignal, isCancelled?: () => boolean): Promise<void> => {
      /** 统一取消判定：外部 cancelled 守卫或中止信号任一生效即视为已取消。 */
      const cancelled = (): boolean => (signal?.aborted ?? false) || (isCancelled?.() ?? false)
      setGenerating(true)
      setGenerateError('')
      try {
        const result = await generateHandoff({ sessionId: targetSessionId }, { signal })
        if (cancelled()) return
        if (!dirtyRef.current) {
          setSummary(result.summary)
        }
        setModel(result.model)
      } catch (error) {
        if (cancelled()) return
        setGenerateError(error instanceof Error ? error.message : '交接摘要生成失败')
      } finally {
        if (!cancelled()) setGenerating(false)
      }
    },
    [],
  )

  /** 拉取模板列表。 */
  const loadTemplates = useCallback(async (): Promise<void> => {
    setTemplatesLoading(true)
    setTemplatesError('')
    try {
      const response = await fetchHandoffTemplates()
      setTemplates(response.templates)
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : '模板列表加载失败')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  /** 拉取历史会话列表（会话选择面板数据源；复用模块 A 的 /export/sessions）。 */
  const loadSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true)
    setSessionsError('')
    try {
      const response = await fetchExportSessions()
      setSessions(response.sessions)
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : '会话列表加载失败')
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  /** 会话筛选结果：按标题或会话 ID 子串匹配（大小写不敏感）。 */
  const filteredSessions = useMemo(() => {
    const keyword = sessionFilter.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter(
      (session) =>
        (session.title ?? '').toLowerCase().includes(keyword) ||
        session.id.toLowerCase().includes(keyword),
    )
  }, [sessions, sessionFilter])

  // 打开对话框：刷新模板与会话列表；默认选中当前会话（存在时）。
  // 无当前会话则不预选，用户从列表手动选择后才开始生成。
  useEffect(() => {
    if (!props.open) return
    setSessionFilter('')
    setSelectedSessionId(sessionId ?? '')
    void loadTemplates()
    void loadSessions()
  }, [props.open, sessionId, loadTemplates, loadSessions])

  // 选中会话变化时自动生成交接摘要（打开时的默认选中同样经此触发）。
  // 摘要生成可能较慢：以 AbortController + cancelled 守卫，卸载 / 切换选中时
  // 取消在途请求，避免过期响应覆盖新选中会话的状态；每次切换重置脏标记
  // （切换即表明用户想要新会话的摘要，编辑中的旧内容不再保留）。
  useEffect(() => {
    if (!props.open || !selectedSessionId) return
    const controller = new AbortController()
    let cancelled = false
    dirtyRef.current = false
    void generate(selectedSessionId, controller.signal, () => cancelled)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [props.open, selectedSessionId, generate])

  /** 选中某个会话（单选）：点击已选中项不重复触发生成。 */
  const selectSession = useCallback(
    (id: string): void => {
      setSelectedSessionId((prev) => (prev === id ? prev : id))
    },
    [],
  )

  /** 复制当前摘要到剪贴板。 */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!summary.trim()) {
      Toast.push('没有可复制的内容', 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(summary)
      Toast.push('已复制到剪贴板', 'success')
    } catch {
      Toast.push('复制失败：浏览器未授权剪贴板访问', 'error')
    }
  }, [summary])

  /** 以输入的名称保存当前摘要为模板。 */
  const handleSaveTemplate = useCallback(async (): Promise<void> => {
    const name = templateName.trim()
    if (!name) {
      Toast.push('请输入模板名称', 'warning')
      return
    }
    if (!summary.trim()) {
      Toast.push('摘要内容为空，无法保存模板', 'warning')
      return
    }
    setSavingTemplate(true)
    try {
      await saveHandoffTemplate({ name, content: summary })
      Toast.push(`模板「${name}」已保存`, 'success')
      setTemplateName('')
      await loadTemplates()
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '模板保存失败', 'error')
    } finally {
      setSavingTemplate(false)
    }
  }, [templateName, summary, loadTemplates])

  /** 将当前摘要作为新对话起点：不带 sessionId 导入 = 武装给下一个新对话。
   *
   * 武装成功后派发 `companion:armed-changed` 自定义事件，供 dock（ImportSummaryDock）刷新武装状态。
   */
  const handleImport = useCallback(async (): Promise<void> => {
    if (!summary.trim()) {
      Toast.push('摘要内容为空，无法武装到新对话', 'warning')
      return
    }
    setImporting(true)
    try {
      await importHandoff({ summary })
      window.dispatchEvent(new CustomEvent('companion:armed-changed'))
      Toast.push('已武装给下一个新对话，新建对话时将自动注入该摘要', 'success')
      props.onClose()
    } catch (error) {
      Toast.push(error instanceof Error ? error.message : '武装摘要失败', 'error')
    } finally {
      setImporting(false)
    }
  }, [summary, props.onClose])

  /** 载入模板内容到编辑区（视为用户主动设置的内容，同样置脏以防在途生成覆盖）。 */
  const handleLoadTemplate = useCallback((template: HandoffTemplate): void => {
    dirtyRef.current = true
    setSummary(template.content)
    Toast.push(`已载入模板「${template.name}」，可继续编辑`, 'info')
  }, [])

  /** 删除模板。 */
  const handleDeleteTemplate = useCallback(
    async (name: string): Promise<void> => {
      setDeletingName(name)
      try {
        await deleteHandoffTemplate(name)
        Toast.push(`模板「${name}」已删除`, 'success')
        await loadTemplates()
      } catch (error) {
        Toast.push(error instanceof Error ? error.message : '模板删除失败', 'error')
      } finally {
        setDeletingName(null)
      }
    },
    [loadTemplates],
  )

  return (
    <Modal
      open={props.open}
      title="交接摘要"
      onClose={props.onClose}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={props.onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.sessionSection}>
          <div className={styles.sessionToolbar}>
            <span className={styles.sectionTitle}>选择会话</span>
            {selectedSessionId ? (
              <span className={styles.sessionCount}>已选中 · 共 {filteredSessions.length} 个会话</span>
            ) : (
              <span className={styles.sessionCount}>共 {filteredSessions.length} 个会话</span>
            )}
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
              <div className={styles.empty}>暂无可选择的会话</div>
            ) : null}
            {!sessionsLoading &&
            !sessionsError &&
            sessions.length > 0 &&
            filteredSessions.length === 0 ? (
              <div className={styles.empty}>没有匹配「{sessionFilter.trim()}」的会话</div>
            ) : null}
            {!sessionsLoading && !sessionsError
              ? filteredSessions.map((session) => {
                  const checked = selectedSessionId === session.id
                  const isCurrent = session.id === sessionId
                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      className={checked ? styles.sessionItemSelected : styles.sessionItem}
                      onClick={() => selectSession(session.id)}
                      onKeyDown={(event) => {
                        // Enter / Space 与点击等价（键盘可达性）
                        if (event.key === 'Enter' || event.key === ' ') selectSession(session.id)
                      }}
                    >
                      <span className={checked ? styles.radioOn : styles.radioOff} aria-hidden="true" />
                      <span className={styles.sessionMeta}>
                        <span className={styles.sessionTitleRow}>
                          <span className={styles.sessionTitle}>
                            {session.title ?? `会话 ${session.id}`}
                          </span>
                          {isCurrent ? <span className={styles.currentBadge}>当前</span> : null}
                        </span>
                        <span className={styles.sessionTime}>{formatTime(session.createdAt)}</span>
                      </span>
                    </div>
                  )
                })
              : null}
          </div>
          {!selectedSessionId && !sessionsLoading && !sessionsError ? (
            <div className={styles.hint}>从上方列表选择一个会话后自动生成交接摘要。</div>
          ) : null}
        </div>

        <div className={styles.status}>
          {generating ? <Spinner label="正在生成所选会话的交接摘要…" /> : null}
          {!generating && generateError ? (
            <div className={styles.error}>
              <span>{generateError}</span>
              {selectedSessionId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    // 手动重试 = 用户明确要求重新生成：重置脏标记允许结果覆盖
                    dirtyRef.current = false
                    void generate(selectedSessionId)
                  }}
                >
                  重试
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <Textarea
          className={styles.summaryInput}
          rows={10}
          value={summary}
          disabled={generating}
          onChange={(event) => {
            // 用户手动输入即置脏：后续（慢）生成结果返回时不再覆盖已编辑内容
            dirtyRef.current = true
            setSummary(event.target.value)
          }}
          placeholder="生成的交接摘要将显示在这里；也可以直接粘贴或编辑内容…"
        />
        {model ? <div className={styles.modelInfo}>生成模型：{model}</div> : null}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => void handleCopy()}>
            复制到剪贴板
          </Button>
          <Button variant="primary" onClick={() => void handleImport()} disabled={importing}>
            {importing ? <Spinner label="武装中…" /> : '作为新对话起点'}
          </Button>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>保存为模板</div>
          <div className={styles.templateNameRow}>
            <Input
              className={styles.templateNameInput}
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              onKeyDown={(event) => {
                // Enter 快捷提交：与“保存为模板”按钮等价
                if (event.key === 'Enter' && !savingTemplate) void handleSaveTemplate()
              }}
              placeholder="模板名称，如：前端项目交接"
            />
            <Button
              variant="secondary"
              onClick={() => void handleSaveTemplate()}
              disabled={savingTemplate}
            >
              {savingTemplate ? <Spinner label="保存中…" /> : '保存为模板'}
            </Button>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>我的模板</div>
          {templatesLoading ? <Spinner label="加载模板列表…" /> : null}
          {!templatesLoading && templatesError ? (
            <div className={styles.error}>
              <span>{templatesError}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadTemplates()}>
                重试
              </Button>
            </div>
          ) : null}
          {!templatesLoading && !templatesError && templates.length === 0 ? (
            <div className={styles.empty}>暂无模板，保存摘要后可在此复用</div>
          ) : null}
          {!templatesLoading && !templatesError
            ? templates.map((template) => (
                <div key={template.name} className={styles.templateItem}>
                  <div className={styles.templateMeta}>
                    <span className={styles.templateName}>{template.name}</span>
                    <span className={styles.templateTime}>更新于 {formatTime(template.updatedAt)}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleLoadTemplate(template)}>
                    载入
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => void handleDeleteTemplate(template.name)}
                    disabled={deletingName === template.name}
                  >
                    {deletingName === template.name ? <Spinner label="删除中…" /> : '删除'}
                  </Button>
                </div>
              ))
            : null}
        </div>
      </div>
    </Modal>
  )
}
