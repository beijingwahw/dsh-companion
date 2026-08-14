/**
 * 上下文交接 dock 行（模块 B 客户端 UI，挂载于 conversation.input.dock）：
 * - 左侧文案“上下文交接”，按钮“导入历史摘要”打开粘贴模态框；
 * - 粘贴摘要后 POST /handoff/import { summary, sessionId }；
 * - GET /handoff/armed 展示已武装徽标，可“移除”。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal, Pill, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { dismissArmedHandoff, fetchArmedHandoffs, importHandoff } from '../api.js'
import type { ArmedHandoff } from '../api.js'
import styles from './ImportSummaryDock.module.css'

/** 组件 props：sessionId 由 slot 的 inject 注入。 */
export interface ImportSummaryDockProps {
  /** 当前会话 id；存在时摘要导入该会话，否则武装给下一个新对话。 */
  readonly sessionId?: string
}

/** 截断过长文本用于徽标行内展示。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 输入区 dock 行：导入历史摘要入口 + 已武装摘要徽标与移除操作。 */
export function ImportSummaryDock(props: ImportSummaryDockProps): ReactElement {
  const [modalOpen, setModalOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [armed, setArmed] = useState<readonly ArmedHandoff[]>([])
  const [armedLoading, setArmedLoading] = useState(false)
  const [armedError, setArmedError] = useState('')
  const [removing, setRemoving] = useState(false)

  /** 挂载标记：所有异步回调在 setState 前检查，防止卸载后更新状态。 */
  const mountedRef = useRef(true)

  // 维护 mountedRef：StrictMode 下 effect 会重执行，故在 effect 内重置。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 拉取已武装的交接摘要列表（mounted 守卫：卸载后不再 setState）。 */
  const loadArmed = useCallback(async (): Promise<void> => {
    setArmedLoading(true)
    try {
      const response = await fetchArmedHandoffs()
      if (!mountedRef.current) return
      setArmed(response.armed)
      setArmedError('')
    } catch (error) {
      if (!mountedRef.current) return
      setArmedError(error instanceof Error ? error.message : '已武装摘要加载失败')
    } finally {
      if (mountedRef.current) setArmedLoading(false)
    }
  }, [])

  // 挂载时读取已武装状态
  useEffect(() => {
    void loadArmed()
  }, [loadArmed])

  // 监听武装状态变化事件（HandoffDialog 武装成功 / 其他入口变更时派发），刷新徽标
  useEffect(() => {
    const onArmedChanged = (): void => {
      void loadArmed()
    }
    window.addEventListener('companion:armed-changed', onArmedChanged)
    return () => {
      window.removeEventListener('companion:armed-changed', onArmedChanged)
    }
  }, [loadArmed])

  /** 提交粘贴的摘要：带 sessionId 注入当前会话，不带则武装给下一个新对话。 */
  const handleImport = useCallback(async (): Promise<void> => {
    const text = summary.trim()
    if (!text) {
      Toast.push('请先粘贴历史摘要内容', 'warning')
      return
    }
    setSubmitting(true)
    try {
      const result = await importHandoff({ summary: text, sessionId: props.sessionId })
      if (!mountedRef.current) return
      Toast.push(
        result.sessionId ? '历史摘要已导入当前会话' : '历史摘要已武装给下一个新对话',
        'success',
      )
      setSummary('')
      setModalOpen(false)
      await loadArmed()
    } catch (error) {
      if (!mountedRef.current) return
      Toast.push(error instanceof Error ? error.message : '导入失败', 'error')
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }, [summary, props.sessionId, loadArmed])

  /** 移除一条已武装摘要；sessionId 为 null 时为全局武装（下一个新对话）。 */
  const handleRemove = useCallback(
    async (item: ArmedHandoff): Promise<void> => {
      setRemoving(true)
      try {
        if (item.sessionId) {
          await dismissArmedHandoff({ sessionId: item.sessionId })
        } else {
          await dismissArmedHandoff({})
        }
        if (!mountedRef.current) return
        Toast.push('已移除武装摘要', 'success')
        await loadArmed()
      } catch (error) {
        if (!mountedRef.current) return
        Toast.push(error instanceof Error ? error.message : '移除失败', 'error')
      } finally {
        if (mountedRef.current) setRemoving(false)
      }
    },
    [loadArmed],
  )

  return (
    <div className={styles.dock}>
      <span className={styles.label}>上下文交接</span>

      {armedLoading ? <Spinner label="加载已武装摘要…" /> : null}
      {!armedLoading && armedError ? <span className={styles.error}>{armedError}</span> : null}

      {armed.map((item) => (
        <div key={`${item.sessionId ?? 'global'}-${item.armedAt}`} className={styles.armed}>
          <Pill className={styles.armedBadge}>已武装</Pill>
          <span className={styles.armedSummary} title={item.summary}>
            {item.sessionId ? `会话 ${item.sessionId}：` : '下一个新对话：'}
            {truncate(item.summary, 40)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleRemove(item)}
            disabled={removing}
            title="移除该武装摘要"
          >
            移除
          </Button>
        </div>
      ))}

      <div className={styles.spacer} />

      <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
        导入历史摘要
      </Button>

      <Modal
        open={modalOpen}
        title="导入历史摘要"
        onClose={() => setModalOpen(false)}
        footer={
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleImport()} disabled={submitting}>
              {submitting ? <Spinner label="导入中…" /> : '导入'}
            </Button>
          </div>
        }
      >
        <div className={styles.pasteBody}>
          <p className={styles.pasteHint}>
            粘贴上一段对话的交接摘要；导入后
            {props.sessionId ? '将注入当前会话，作为后续回复的上下文。' : '将武装给下一个新对话。'}
          </p>
          <Textarea
            rows={8}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="在此粘贴摘要文本…"
          />
        </div>
      </Modal>
    </div>
  )
}
