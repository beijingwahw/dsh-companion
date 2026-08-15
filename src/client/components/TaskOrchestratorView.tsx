/**
 * 任务编排视图页（模块 H 客户端 UI，挂载于 conversation.view）：
 * - H1 可视化流水线：步骤列表编辑（模型/Prompt/输入来源/条件/超时/重试/依赖），
 *   自动生成 YAML 配置；
 * - H2 断点续跑：启动/暂停/取消/恢复执行，进度条 + 每步中间结果展示；
 * - H3 批量任务队列：优先级/截止时间/失败策略，批量暂停/恢复/取消；
 * - H4 定时调度：Cron 与自然语言双输入，峰谷空闲时段选项，历史执行归档。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Checkbox, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  batchQueue,
  cancelPipelineRun,
  cancelQueueTask,
  deleteJob,
  deletePipeline,
  deletePipelineRun,
  deleteQueueTask,
  fetchJobRuns,
  fetchJobs,
  fetchPipelineRun,
  fetchPipelineRuns,
  fetchPipelineYaml,
  fetchPipelines,
  fetchQueue,
  pausePipelineRun,
  pauseQueueTask,
  parseSchedule,
  resumePipelineRun,
  resumeQueueTask,
  saveJob,
  savePipeline,
  startPipelineRun,
  submitQueueTask,
  toggleJob,
} from '../api.js'
import type {
  OrchestratorJob,
  OrchestratorJobRun,
  OrchestratorPipeline,
  OrchestratorQueueCounts,
  OrchestratorQueueTask,
  OrchestratorRun,
  OrchestratorRunSummary,
  OrchestratorStep,
} from '../api.js'
import styles from './TaskOrchestratorView.module.css'

/** 组件 props。 */
export interface TaskOrchestratorViewProps {
  readonly sessionId?: string
}

/** 子面板页签。 */
type Tab = 'pipelines' | 'queue' | 'jobs'

/** 任务编排视图页。 */
export function TaskOrchestratorView(_props: TaskOrchestratorViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('pipelines')
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>任务编排</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'pipelines' ? 'primary' : 'secondary'} onClick={() => setTab('pipelines')}>
          流水线
        </Button>
        <Button size="sm" variant={tab === 'queue' ? 'primary' : 'secondary'} onClick={() => setTab('queue')}>
          批量队列
        </Button>
        <Button size="sm" variant={tab === 'jobs' ? 'primary' : 'secondary'} onClick={() => setTab('jobs')}>
          定时调度
        </Button>
      </div>
      {tab === 'pipelines' && <PipelinePanel />}
      {tab === 'queue' && <QueuePanel />}
      {tab === 'jobs' && <JobPanel />}
    </div>
  )
}

/** 错误提示统一转 Toast。 */
function reportError(error: unknown, fallback: string): void {
  Toast.push(error instanceof Error ? error.message : fallback, 'error')
}

/** 时间戳格式化（0 显示为 -）。 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

// ---------------------------------------------------------------------------
// H1 + H2：流水线与执行
// ---------------------------------------------------------------------------

/** 步骤编辑草稿（表单态，字段可写）。 */
interface StepDraft {
  id: string
  name: string
  model: string
  prompt: string
  inputFrom: 'prev' | 'literal'
  input: string
  condition: string
  timeoutMs: string
  maxRetries: string
  dependsOn: string
}

/** 步骤 id 单调计数器：保证删除中间步骤后再添加也不会产生重复 id。 */
let stepIdCounter = 0

/** 新建空白步骤草稿（index 仅用于显示名称，id 全局唯一）。 */
function blankStep(index: number): StepDraft {
  stepIdCounter += 1
  return {
    id: `step-${stepIdCounter}`,
    name: `步骤 ${index}`,
    model: 'deepseek-chat',
    prompt: '',
    inputFrom: 'prev',
    input: '',
    condition: '',
    timeoutMs: '0',
    maxRetries: '0',
    dependsOn: '',
  }
}

/** 流水线面板：定义管理 + 执行监控。 */
function PipelinePanel(): ReactElement {
  const [pipelines, setPipelines] = useState<readonly OrchestratorPipeline[]>([])
  const [runs, setRuns] = useState<readonly OrchestratorRunSummary[]>([])
  const [editing, setEditing] = useState<{ id?: string; name: string; steps: StepDraft[] } | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<OrchestratorRun | null>(null)
  const [yaml, setYaml] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)

  const reload = useCallback(() => {
    fetchPipelines()
      .then((response) => setPipelines(response.pipelines))
      .catch((error) => reportError(error, '加载流水线失败'))
    fetchPipelineRuns()
      .then((response) => setRuns(response.runs))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // 运行中的执行：链式 setTimeout 轮询详情（上次响应返回后再排下一次，
  // 避免慢响应下 setInterval 造成请求堆积）。
  useEffect(() => {
    if (!activeRunId) return
    let cancelled = false
    const tick = (): void => {
      fetchPipelineRun(activeRunId)
        .then((response) => {
          if (cancelled) return
          setActiveRun(response.run)
          if (response.run.status !== 'running') {
            reload()
            return
          }
          pollTimer.current = window.setTimeout(tick, 2000)
        })
        .catch(() => {
          if (!cancelled) pollTimer.current = window.setTimeout(tick, 2000)
        })
    }
    tick()
    return () => {
      cancelled = true
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [activeRunId, reload])

  const startEditing = (pipeline?: OrchestratorPipeline): void => {
    if (pipeline) {
      setEditing({
        id: pipeline.id,
        name: pipeline.name,
        steps: pipeline.steps.map((step) => ({
          id: step.id,
          name: step.name,
          model: step.model,
          prompt: step.prompt,
          inputFrom: step.inputFrom,
          input: step.input,
          condition: step.condition,
          timeoutMs: String(step.timeoutMs),
          maxRetries: String(step.maxRetries),
          dependsOn: step.dependsOn.join(','),
        })),
      })
    } else {
      setEditing({ name: '', steps: [blankStep(1)] })
    }
    setYaml(null)
  }

  const submitEditing = (): void => {
    if (!editing) return
    if (!editing.name.trim()) {
      Toast.push('请填写流水线名称', 'warning')
      return
    }
    const steps = editing.steps.map((draft) => ({
      id: draft.id.trim(),
      name: draft.name.trim(),
      model: draft.model.trim(),
      prompt: draft.prompt,
      inputFrom: draft.inputFrom,
      input: draft.input,
      condition: draft.condition.trim(),
      timeoutMs: Number(draft.timeoutMs) || 0,
      maxRetries: Number(draft.maxRetries) || 0,
      dependsOn: draft.dependsOn
        .split(',')
        .map((dep) => dep.trim())
        .filter((dep) => dep.length > 0),
    }))
    savePipeline({ id: editing.id, name: editing.name.trim(), steps })
      .then(() => {
        Toast.push('流水线已保存', 'success')
        setEditing(null)
        reload()
      })
      .catch((error) => reportError(error, '保存流水线失败'))
  }

  const startRun = (pipelineId: string): void => {
    startPipelineRun(pipelineId)
      .then((response) => {
        setActiveRunId(response.runId)
        setActiveRun(null)
        reload()
      })
      .catch((error) => reportError(error, '启动执行失败'))
  }

  const showYaml = (pipelineId: string): void => {
    fetchPipelineYaml(pipelineId)
      .then((response) => setYaml(response.yaml))
      .catch((error) => reportError(error, '读取 YAML 失败'))
  }

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>流水线定义（H1）</h3>
          <Button size="sm" variant="primary" onClick={() => startEditing()}>
            新建流水线
          </Button>
        </div>
        {pipelines.length === 0 ? (
          <p className={styles.empty}>暂无流水线，点击右上角新建。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>步骤</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.map((pipeline) => (
                <tr key={pipeline.id}>
                  <td>{pipeline.name}</td>
                  <td>{pipeline.steps.length}</td>
                  <td>{formatTime(pipeline.updatedAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button size="sm" variant="primary" onClick={() => startRun(pipeline.id)}>
                        运行
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => startEditing(pipeline)}>
                        编辑
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => showYaml(pipeline.id)}>
                        YAML
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          deletePipeline(pipeline.id)
                            .then(() => {
                              Toast.push('已删除', 'success')
                              reload()
                            })
                            .catch((error) => reportError(error, '删除失败'))
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {yaml !== null && <pre className={styles.output}>{yaml}</pre>}
      </section>

      {editing !== null && (
        <section className={styles.section}>
          <h3>{editing.id ? '编辑流水线' : '新建流水线'}</h3>
          <div className={styles.field}>
            <span>流水线名称</span>
            <Input
              value={editing.name}
              placeholder="如：每日数据报告"
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </div>
          <div className={styles.stepList}>
            {editing.steps.map((step, index) => (
              <div key={step.id} className={styles.stepCard}>
                <div className={styles.stepHead}>
                  <span className={styles.stepName}>#{index + 1}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={editing.steps.length <= 1}
                    onClick={() =>
                      setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== index) })
                    }
                  >
                    移除步骤
                  </Button>
                </div>
                <div className={styles.formGrid}>
                  <label className={styles.field}>
                    <span>步骤名称</span>
                    <Input
                      value={step.name}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, name: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>模型</span>
                    <Input
                      value={step.model}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, model: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>输入来源</span>
                    <Select
                      value={step.inputFrom}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, inputFrom: event.target.value === 'literal' ? 'literal' : 'prev' }
                        setEditing({ ...editing, steps })
                      }}
                    >
                      <option value="prev">上游输出</option>
                      <option value="literal">固定输入</option>
                    </Select>
                  </label>
                  <label className={styles.field}>
                    <span>依赖步骤 id（逗号分隔，空=可并行）</span>
                    <Input
                      value={step.dependsOn}
                      placeholder="step-1,step-2"
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, dependsOn: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>超时（毫秒，0=默认）</span>
                    <Input
                      type="number"
                      value={step.timeoutMs}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, timeoutMs: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>失败重试次数</span>
                    <Input
                      type="number"
                      value={step.maxRetries}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, maxRetries: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  <label className={`${styles.field} ${styles.fieldFull}`}>
                    <span>Prompt 模板</span>
                    <Textarea
                      rows={3}
                      value={step.prompt}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, prompt: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                  {step.inputFrom === 'literal' && (
                    <label className={`${styles.field} ${styles.fieldFull}`}>
                      <span>固定输入</span>
                      <Textarea
                        rows={2}
                        value={step.input}
                        onChange={(event) => {
                          const steps = [...editing.steps]
                          steps[index] = { ...step, input: event.target.value }
                          setEditing({ ...editing, steps })
                        }}
                      />
                    </label>
                  )}
                  <label className={`${styles.field} ${styles.fieldFull}`}>
                    <span>条件分支（上游输出包含该子串才执行，空=无条件）</span>
                    <Input
                      value={step.condition}
                      onChange={(event) => {
                        const steps = [...editing.steps]
                        steps[index] = { ...step, condition: event.target.value }
                        setEditing({ ...editing, steps })
                      }}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <div className={styles.rowActions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setEditing({ ...editing, steps: [...editing.steps, blankStep(editing.steps.length + 1)] })
              }
            >
              添加步骤
            </Button>
            <Button size="sm" variant="primary" onClick={submitEditing}>
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
          </div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>执行记录（H2 断点续跑）</h3>
          <Button size="sm" variant="secondary" onClick={reload}>
            刷新
          </Button>
        </div>
        {runs.length === 0 ? (
          <p className={styles.empty}>暂无执行记录。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>状态</th>
                <th>进度</th>
                <th>开始时间</th>
                <th>信息</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <RunStatusPill status={run.status} />
                  </td>
                  <td>
                    <ProgressBar done={run.progress.done} total={run.progress.total} />
                  </td>
                  <td>{formatTime(run.startedAt)}</td>
                  <td>{run.message || '-'}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button size="sm" variant="secondary" onClick={() => setActiveRunId(run.id)}>
                        详情
                      </Button>
                      {(run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled') && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            resumePipelineRun(run.id)
                              .then(() => {
                                setActiveRunId(run.id)
                                Toast.push('已从断点恢复', 'success')
                              })
                              .catch((error) => reportError(error, '恢复失败'))
                          }}
                        >
                          断点续跑
                        </Button>
                      )}
                      {run.status === 'running' && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => pausePipelineRun(run.id).catch((error) => reportError(error, '暂停失败'))}
                          >
                            暂停
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => cancelPipelineRun(run.id).catch((error) => reportError(error, '取消失败'))}
                          >
                            取消
                          </Button>
                        </>
                      )}
                      {run.status !== 'running' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            deletePipelineRun(run.id)
                              .then(reload)
                              .catch((error) => reportError(error, '删除失败'))
                          }}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {activeRunId !== null && (
          <RunDetail
            run={activeRun}
            onClose={() => {
              setActiveRunId(null)
              setActiveRun(null)
            }}
          />
        )}
      </section>
    </>
  )
}

/** 执行状态徽标。 */
function RunStatusPill(props: { status: OrchestratorRun['status'] }): ReactElement {
  const labels: Record<OrchestratorRun['status'], string> = {
    running: '运行中',
    done: '已完成',
    failed: '失败',
    paused: '已暂停',
    cancelled: '已取消',
  }
  const cls =
    props.status === 'running'
      ? `${styles.status} ${styles.statusRunning}`
      : props.status === 'done'
        ? `${styles.status} ${styles.statusDone}`
        : props.status === 'failed'
          ? `${styles.status} ${styles.statusFailed}`
          : props.status === 'paused'
            ? `${styles.status} ${styles.statusPaused}`
            : styles.status
  return <span className={cls}>{labels[props.status]}</span>
}

/** 进度条（done/total）。 */
function ProgressBar(props: { done: number; total: number }): ReactElement {
  const percent = props.total > 0 ? Math.round((props.done / props.total) * 100) : 0
  return (
    <div className={styles.progress}>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
      <span>
        {props.done}/{props.total}
      </span>
    </div>
  )
}

/** 单次执行详情：每步状态与中间结果。 */
function RunDetail(props: { run: OrchestratorRun | null; onClose: () => void }): ReactElement {
  if (!props.run) {
    return (
      <div className={styles.section}>
        <Spinner label="加载执行详情…" />
      </div>
    )
  }
  const run = props.run
  const stepRuns = Object.values(run.steps).sort((a, b) => a.startedAt - b.startedAt || a.stepId.localeCompare(b.stepId))
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>
          执行详情 {run.id} <RunStatusPill status={run.status} />
        </h3>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          收起
        </Button>
      </div>
      {run.message ? <p className={styles.hint}>{run.message}</p> : null}
      <div className={styles.stepList}>
        {stepRuns.map((step) => (
          <div key={step.stepId} className={styles.stepCard}>
            <div className={styles.stepHead}>
              <span className={styles.stepName}>{step.stepId}</span>
              <span className={styles.stepMeta}>
                {step.status} · 尝试 {step.attempts} 次 · {step.latencyMs}ms · {step.tokens} tokens
              </span>
            </div>
            {step.error ? <p className={styles.hint}>错误：{step.error}</p> : null}
            {step.output ? <pre className={styles.output}>{step.output}</pre> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// H3：批量任务队列
// ---------------------------------------------------------------------------

/** 队列面板。 */
function QueuePanel(): ReactElement {
  const [tasks, setTasks] = useState<readonly OrchestratorQueueTask[]>([])
  const [counts, setCounts] = useState<OrchestratorQueueCounts>({})
  const [form, setForm] = useState({
    name: '',
    prompt: '',
    model: 'deepseek-chat',
    priority: 'medium',
    failurePolicy: 'skip',
  })
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(() => {
    fetchQueue()
      .then((response) => {
        setTasks(response.tasks)
        setCounts(response.counts)
      })
      .catch((error) => reportError(error, '加载队列失败'))
  }, [])

  // 链式 setTimeout 轮询（上次响应返回后再排下一次，避免慢响应下请求堆积）。
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const tick = (): void => {
      fetchQueue()
        .then((response) => {
          if (cancelled) return
          setTasks(response.tasks)
          setCounts(response.counts)
        })
        .catch((error) => {
          if (!cancelled) reportError(error, '加载队列失败')
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(tick, 5000)
        })
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  const submit = (): void => {
    if (!form.name.trim() || !form.prompt.trim()) {
      Toast.push('任务名称与 Prompt 必填', 'warning')
      return
    }
    setSubmitting(true)
    submitQueueTask({
      name: form.name.trim(),
      prompt: form.prompt,
      model: form.model.trim(),
      priority: form.priority as 'high' | 'medium' | 'low',
      failurePolicy: form.failurePolicy as 'skip' | 'retry' | 'notify',
    })
      .then(() => {
        Toast.push('任务已入队', 'success')
        // 函数式更新：只清 name/prompt，保留提交期间用户改动的其他字段。
        setForm((prev) => ({ ...prev, name: '', prompt: '' }))
        reload()
      })
      .catch((error) => reportError(error, '提交任务失败'))
      .finally(() => setSubmitting(false))
  }

  const batch = (action: 'pause' | 'resume' | 'cancel'): void => {
    batchQueue(action)
      .then((response) => {
        Toast.push(`已影响 ${response.changed} 个任务`, 'success')
        reload()
      })
      .catch((error) => reportError(error, '批量操作失败'))
  }

  return (
    <>
      <section className={styles.section}>
        <h3>队列状态</h3>
        <div className={styles.counts}>
          <div className={styles.countCard}>
            <span className={styles.countValue}>{counts.running ?? 0}</span>
            <span>运行中</span>
          </div>
          <div className={styles.countCard}>
            <span className={styles.countValue}>{counts.queued ?? 0}</span>
            <span>排队中</span>
          </div>
          <div className={styles.countCard}>
            <span className={styles.countValue}>{counts.done ?? 0}</span>
            <span>已完成</span>
          </div>
          <div className={styles.countCard}>
            <span className={styles.countValue}>{counts.failed ?? 0}</span>
            <span>失败</span>
          </div>
        </div>
        <div className={styles.rowActions}>
          <Button size="sm" variant="secondary" onClick={() => batch('pause')}>
            批量暂停
          </Button>
          <Button size="sm" variant="secondary" onClick={() => batch('resume')}>
            批量恢复
          </Button>
          <Button size="sm" variant="danger" onClick={() => batch('cancel')}>
            批量取消
          </Button>
          <Button size="sm" variant="ghost" onClick={reload}>
            刷新
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h3>提交新任务</h3>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>任务名称</span>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>模型</span>
            <Input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>优先级</span>
            <Select
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value })}
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </Select>
          </label>
          <label className={styles.field}>
            <span>失败策略</span>
            <Select
              value={form.failurePolicy}
              onChange={(event) => setForm({ ...form, failurePolicy: event.target.value })}
            >
              <option value="skip">跳过</option>
              <option value="retry">重试</option>
              <option value="notify">通知</option>
            </Select>
          </label>
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span>Prompt</span>
            <Textarea rows={3} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} />
          </label>
        </div>
        <div>
          <Button size="sm" variant="primary" disabled={submitting} onClick={submit}>
            {submitting ? '提交中…' : '提交任务'}
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h3>任务列表</h3>
        {tasks.length === 0 ? (
          <p className={styles.empty}>队列为空。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>优先级</th>
                <th>状态</th>
                <th>尝试</th>
                <th>输出/错误</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.name}</td>
                  <td>{task.priority}</td>
                  <td>{task.status}</td>
                  <td>{task.attempts}</td>
                  <td>{task.error || task.output.slice(0, 80) || '-'}</td>
                  <td>
                    <div className={styles.rowActions}>
                      {task.status === 'queued' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => pauseQueueTask(task.id).then(reload).catch((error) => reportError(error, '暂停失败'))}
                        >
                          暂停
                        </Button>
                      )}
                      {task.status === 'paused' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => resumeQueueTask(task.id).then(reload).catch((error) => reportError(error, '恢复失败'))}
                        >
                          恢复
                        </Button>
                      )}
                      {(task.status === 'queued' || task.status === 'running' || task.status === 'paused') && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => cancelQueueTask(task.id).then(reload).catch((error) => reportError(error, '取消失败'))}
                        >
                          取消
                        </Button>
                      )}
                      {task.status !== 'running' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteQueueTask(task.id).then(reload).catch((error) => reportError(error, '删除失败'))}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// H4：定时任务调度
// ---------------------------------------------------------------------------

/** 定时调度面板。 */
function JobPanel(): ReactElement {
  const [jobs, setJobs] = useState<readonly OrchestratorJob[]>([])
  const [form, setForm] = useState({ name: '', prompt: '', schedule: '', model: 'deepseek-chat', offPeakOnly: false })
  const [preview, setPreview] = useState<{ cron: string; nextRunAt: number } | null>(null)
  const [historyJobId, setHistoryJobId] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly OrchestratorJobRun[]>([])

  const reload = useCallback(() => {
    fetchJobs()
      .then((response) => setJobs(response.jobs))
      .catch((error) => reportError(error, '加载定时任务失败'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const doPreview = (): void => {
    if (!form.schedule.trim()) return
    parseSchedule(form.schedule.trim())
      .then((response) => setPreview(response))
      .catch((error) => {
        setPreview(null)
        reportError(error, '无法解析定时表达式')
      })
  }

  const submit = (): void => {
    if (!form.name.trim() || !form.prompt.trim() || !form.schedule.trim()) {
      Toast.push('名称、Prompt 与调度表达式必填', 'warning')
      return
    }
    saveJob({
      name: form.name.trim(),
      prompt: form.prompt,
      schedule: form.schedule.trim(),
      model: form.model.trim(),
      offPeakOnly: form.offPeakOnly,
    })
      .then(() => {
        Toast.push('定时任务已保存', 'success')
        setForm({ name: '', prompt: '', schedule: '', model: 'deepseek-chat', offPeakOnly: false })
        setPreview(null)
        reload()
      })
      .catch((error) => reportError(error, '保存定时任务失败'))
  }

  const showHistory = (jobId: string): void => {
    setHistoryJobId(jobId)
    fetchJobRuns(jobId)
      .then((response) => setHistory(response.runs))
      .catch((error) => reportError(error, '加载执行历史失败'))
  }

  return (
    <>
      <section className={styles.section}>
        <h3>新建定时任务（Cron 或自然语言）</h3>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>任务名称</span>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>调度表达式（如「每天凌晨 2 点」或 0 2 * * *）</span>
            <Input value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>模型</span>
            <Input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
          </label>
          <div className={styles.field}>
            <Checkbox
              checked={form.offPeakOnly}
              label="仅在空闲（谷时）时段执行，享受更低价格"
              onChange={(checked) => setForm({ ...form, offPeakOnly: checked })}
            />
          </div>
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span>Prompt</span>
            <Textarea rows={3} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} />
          </label>
        </div>
        <div className={styles.rowActions}>
          <Button size="sm" variant="secondary" onClick={doPreview}>
            解析预览
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            保存任务
          </Button>
        </div>
        {preview !== null && (
          <p className={styles.hint}>
            Cron：{preview.cron} · 下次执行：{formatTime(preview.nextRunAt)}
          </p>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>定时任务列表</h3>
          <Button size="sm" variant="secondary" onClick={reload}>
            刷新
          </Button>
        </div>
        {jobs.length === 0 ? (
          <p className={styles.empty}>暂无定时任务。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>调度</th>
                <th>状态</th>
                <th>下次执行</th>
                <th>最近执行</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.name}
                    {job.offPeakOnly ? '（空闲时段）' : ''}
                  </td>
                  <td>{job.scheduleText}</td>
                  <td>{job.enabled ? '启用' : '停用'}</td>
                  <td>{job.enabled ? formatTime(job.nextRunAt) : '-'}</td>
                  <td>{formatTime(job.lastRunAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          toggleJob(job.id, !job.enabled)
                            .then(reload)
                            .catch((error) => reportError(error, '切换状态失败'))
                        }}
                      >
                        {job.enabled ? '停用' : '启用'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => showHistory(job.id)}>
                        历史
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          deleteJob(job.id)
                            .then(() => {
                              Toast.push('已删除', 'success')
                              reload()
                            })
                            .catch((error) => reportError(error, '删除失败'))
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {historyJobId !== null && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>执行历史（{historyJobId}）</h3>
              <Button size="sm" variant="ghost" onClick={() => setHistoryJobId(null)}>
                收起
              </Button>
            </div>
            {history.length === 0 ? (
              <p className={styles.empty}>暂无执行记录。</p>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>结果</th>
                    <th>耗时</th>
                    <th>输出/错误</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((run) => (
                    <tr key={run.id}>
                      <td>{formatTime(run.ts)}</td>
                      <td>{run.ok ? '成功' : '失败'}</td>
                      <td>{run.latencyMs}ms</td>
                      <td>{run.error || run.output.slice(0, 120) || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </>
  )
}
