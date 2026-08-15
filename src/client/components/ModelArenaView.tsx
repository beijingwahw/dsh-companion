/**
 * 多模型竞技场视图页（模块 G 客户端 UI，挂载于 conversation.view）：
 * - G1 并行对比：输入 Prompt 勾选模型（最多 5 个），表格并排展示输出/耗时/Token/费用；
 * - G2 批量评测排行榜：导入 JSON/JSONL 测试集，跑完整评测并导出 MD/HTML 报告；
 * - G3 模型推荐：任务类型 + 预算 + 延迟要求 → 推荐排序与理由；
 * - 外部厂商 Key 管理（加密保存，不回传明文）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Checkbox, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  downloadBlob,
  fetchArenaModels,
  fetchArenaRecommendation,
  removeArenaKey,
  runArenaCompare,
  runArenaLeaderboard,
  saveArenaKey,
} from '../api.js'
import type { ArenaLeaderboardRow, ArenaModelInfo, ArenaRecommendation, ArenaRunResult } from '../api.js'
import styles from './ModelArenaView.module.css'

/** 组件 props。 */
export interface ModelArenaViewProps {
  readonly sessionId?: string
}

/** 子面板页签。 */
type Tab = 'compare' | 'leaderboard' | 'recommend' | 'keys'

/** 多模型竞技场视图页。 */
export function ModelArenaView(_props: ModelArenaViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('compare')
  const [models, setModels] = useState<readonly ArenaModelInfo[]>([])

  const reloadModels = useCallback(() => {
    fetchArenaModels()
      .then((response) => setModels(response.models))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载模型目录失败', 'error'))
  }, [])

  useEffect(() => {
    reloadModels()
  }, [reloadModels])

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>多模型竞技场</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'compare' ? 'primary' : 'secondary'} onClick={() => setTab('compare')}>
          并行对比
        </Button>
        <Button size="sm" variant={tab === 'leaderboard' ? 'primary' : 'secondary'} onClick={() => setTab('leaderboard')}>
          评测排行榜
        </Button>
        <Button size="sm" variant={tab === 'recommend' ? 'primary' : 'secondary'} onClick={() => setTab('recommend')}>
          模型推荐
        </Button>
        <Button size="sm" variant={tab === 'keys' ? 'primary' : 'secondary'} onClick={() => setTab('keys')}>
          外部 Key 管理
        </Button>
      </div>
      {tab === 'compare' && <ComparePanel models={models} />}
      {tab === 'leaderboard' && <LeaderboardPanel models={models} />}
      {tab === 'recommend' && <RecommendPanel />}
      {tab === 'keys' && <KeysPanel models={models} onChanged={reloadModels} />}
    </div>
  )
}

/** 模型多选（最多 5 个）。 */
function useModelSelection(models: readonly ArenaModelInfo[]): {
  selected: ReadonlySet<string>
  toggle: (id: string) => void
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const toggle = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          if (next.size >= 5) {
            Toast.push('最多同时选择 5 个模型', 'warning')
            return prev
          }
          next.add(id)
        }
        return next
      })
    },
    [],
  )
  void models
  return { selected, toggle }
}

/** G1：并行对比面板。 */
function ComparePanel(props: { models: readonly ArenaModelInfo[] }): ReactElement {
  const { models } = props
  const { selected, toggle } = useModelSelection(models)
  const [prompt, setPrompt] = useState('')
  const [results, setResults] = useState<readonly ArenaRunResult[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    if (!prompt.trim() || selected.size === 0) return
    setBusy(true)
    setResults([])
    try {
      const response = await runArenaCompare({ prompt, models: [...selected] }, { timeoutMs: 300_000 })
      setResults(response.results)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '对比失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [prompt, selected])

  return (
    <section className={styles.section}>
      <h3>模型选择（最多 5 个）</h3>
      <div className={styles.modelGrid}>
        {models.map((model) => (
          <label key={model.id} className={styles.modelOption}>
            <Checkbox
              checked={selected.has(model.id)}
              label={`${model.label}${model.provider === 'external' && !model.keyConfigured ? '（未配置 Key）' : ''}`}
              onChange={() => toggle(model.id)}
            />
          </label>
        ))}
      </div>
      <h3>Prompt</h3>
      <Textarea value={prompt} rows={4} placeholder="输入要对比的 Prompt…" onChange={(event) => setPrompt(event.target.value)} />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || !prompt.trim() || selected.size === 0} onClick={run}>
          {busy ? '对比中…' : '并行对比'}
        </Button>
      </div>
      {busy && <Spinner label="正在并行调用多个模型…" />}

      {results.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>模型</th>
              <th>耗时</th>
              <th>Token（输入/输出）</th>
              <th>费用</th>
              <th>输出</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.model}>
                <td>{result.model}</td>
                <td>{result.ok ? `${result.latencyMs}ms` : '失败'}</td>
                <td>{result.ok ? `${result.promptTokens}/${result.completionTokens}` : '-'}</td>
                <td>{result.ok ? `¥${result.costCny.toFixed(4)}` : '-'}</td>
                <td>
                  <pre className={styles.outputCell}>{result.ok ? result.output : result.error}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** G2：评测排行榜面板。 */
function LeaderboardPanel(props: { models: readonly ArenaModelInfo[] }): ReactElement {
  const { models } = props
  const { selected, toggle } = useModelSelection(models)
  const [casesText, setCasesText] = useState('')
  const [rows, setRows] = useState<readonly ArenaLeaderboardRow[]>([])
  const [busy, setBusy] = useState(false)

  /** 运行评测（format 缺省返回 json 并渲染表格）。 */
  const run = useCallback(async () => {
    if (selected.size === 0 || !casesText.trim()) return
    setBusy(true)
    try {
      const response = await runArenaLeaderboard(
        { models: [...selected], cases: casesText },
        { timeoutMs: 600_000 },
      )
      if (response.format === 'json') {
        setRows(response.rows)
      }
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '评测失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [selected, casesText])

  /** 导出报告：复用服务端缓存的最近评测结果，不重跑评测。 */
  const exportReport = useCallback(
    async (format: 'markdown' | 'html') => {
      setBusy(true)
      try {
        const response = await runArenaLeaderboard({ format, useCache: true }, { timeoutMs: 60_000 })
        if (response.format === 'markdown' || response.format === 'html') {
          const mime = response.format === 'html' ? 'text/html' : 'text/markdown'
          downloadBlob(new Blob([response.content], { type: mime }), response.fileName)
          Toast.push('评测报告已导出', 'success')
        }
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '导出失败', 'error')
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return (
    <section className={styles.section}>
      <h3>模型选择（最多 5 个）</h3>
      <div className={styles.modelGrid}>
        {models.map((model) => (
          <label key={model.id} className={styles.modelOption}>
            <Checkbox checked={selected.has(model.id)} label={model.label} onChange={() => toggle(model.id)} />
          </label>
        ))}
      </div>
      <h3>测试集（JSONL：每行一个 JSON 对象，字段 input / expected / judge）</h3>
      <Textarea
        value={casesText}
        rows={6}
        placeholder={'{"input": "1+1=?", "expected": "2", "judge": "contains"}\n{"input": "翻译 hello"}'}
        onChange={(event) => setCasesText(event.target.value)}
      />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || selected.size === 0 || !casesText.trim()} onClick={() => void run()}>
          {busy ? '评测中…' : '运行评测'}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || rows.length === 0} onClick={() => void exportReport('markdown')}>
          导出 Markdown
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || rows.length === 0} onClick={() => void exportReport('html')}>
          导出 HTML
        </Button>
      </div>
      {busy && <Spinner label="正在跑完整评测（可能耗时较长）…" />}

      {rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>排名</th>
              <th>模型</th>
              <th>综合得分</th>
              <th>成功率</th>
              <th>准确率</th>
              <th>P50/P95/P99</th>
              <th>平均Token</th>
              <th>单任务成本</th>
              <th>合规率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.model}>
                <td>{index + 1}</td>
                <td>{row.model}</td>
                <td>{row.compositeScore.toFixed(3)}</td>
                <td>{(row.successRate * 100).toFixed(0)}%</td>
                <td>{row.accuracy === null ? 'N/A' : `${(row.accuracy * 100).toFixed(0)}%`}</td>
                <td>{`${row.p50Ms}/${row.p95Ms}/${row.p99Ms}ms`}</td>
                <td>{row.avgTokens}</td>
                <td>{`¥${row.costPerTaskCny.toFixed(4)}`}</td>
                <td>{row.complianceRate === null ? 'N/A' : `${(row.complianceRate * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** G3：模型推荐面板。 */
function RecommendPanel(): ReactElement {
  const [taskType, setTaskType] = useState('code')
  const [budget, setBudget] = useState('')
  const [latency, setLatency] = useState('any')
  const [recommendations, setRecommendations] = useState<readonly ArenaRecommendation[]>([])
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    // 预算输入校验：非空时必须是合法非负数字，避免 NaN 经 JSON 变 null 发给服务端。
    let budgetPerCallCny: number | undefined
    if (budget.trim() !== '') {
      const parsed = Number(budget)
      if (!Number.isFinite(parsed) || parsed < 0) {
        Toast.push('单次预算必须是非负数字', 'warning')
        return
      }
      budgetPerCallCny = parsed
    }
    setBusy(true)
    try {
      const response = await fetchArenaRecommendation({
        taskType,
        budgetPerCallCny,
        latency,
      })
      setRecommendations(response.recommendations)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '推荐失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [taskType, budget, latency])

  return (
    <section className={styles.section}>
      <div className={styles.row}>
        <Select value={taskType} onChange={(event) => setTaskType(event.target.value)}>
          <option value="code">代码生成</option>
          <option value="translation">翻译</option>
          <option value="summarization">摘要</option>
          <option value="reasoning">推理</option>
          <option value="general">通用</option>
        </Select>
        <Input value={budget} type="number" placeholder="单次预算上限（元，可留空）" onChange={(event) => setBudget(event.target.value)} />
        <Select value={latency} onChange={(event) => setLatency(event.target.value)}>
          <option value="any">延迟不限</option>
          <option value="fast">尽量快</option>
          <option value="balanced">均衡</option>
        </Select>
        <Button variant="primary" size="sm" disabled={busy} onClick={run}>
          获取推荐
        </Button>
      </div>
      {busy && <Spinner label="正在计算推荐…" />}
      {recommendations.length > 0 && (
        <ol className={styles.recList}>
          {recommendations.map((rec, index) => (
            <li key={rec.model} className={styles.recItem}>
              <div className={styles.recHeader}>
                <strong>
                  #{index + 1} {rec.label}
                </strong>
                <span className={styles.recScore}>得分 {rec.score.toFixed(3)}</span>
                {rec.estimatedCostCny > 0 && <span className={styles.recCost}>估算 ¥{rec.estimatedCostCny.toFixed(4)}/次</span>}
              </div>
              <p className={styles.recReason}>{rec.reason}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** 外部厂商 Key 管理面板。 */
function KeysPanel(props: { models: readonly ArenaModelInfo[]; onChanged: () => void }): ReactElement {
  const { models, onChanged } = props
  const [editing, setEditing] = useState<string | undefined>()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  const save = useCallback(async () => {
    if (!editing || !apiKey.trim()) return
    try {
      await saveArenaKey({ modelId: editing, apiKey, baseUrl: baseUrl || undefined })
      Toast.push('Key 已加密保存', 'success')
      setEditing(undefined)
      setApiKey('')
      setBaseUrl('')
      onChanged()
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }, [editing, apiKey, baseUrl, onChanged])

  const remove = useCallback(
    async (modelId: string) => {
      try {
        await removeArenaKey(modelId)
        Toast.push('Key 已删除', 'success')
        onChanged()
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '删除失败', 'error')
      }
    },
    [onChanged],
  )

  return (
    <section className={styles.section}>
      <p className={styles.hint}>外部厂商 Key 以 AES-256-GCM 加密保存在本地保险库，任何接口不回传明文。</p>
      {models
        .filter((model) => model.provider === 'external')
        .map((model) => (
          <div key={model.id} className={styles.keyRow}>
            <div className={styles.keyInfo}>
              <strong>{model.label}</strong>
              <span className={model.keyConfigured ? styles.keyOk : styles.keyMissing}>
                {model.keyConfigured ? '已配置' : '未配置'}
              </span>
            </div>
            {editing === model.id ? (
              <div className={styles.keyForm}>
                <Input value={apiKey} type="password" placeholder="API Key" onChange={(event) => setApiKey(event.target.value)} />
                <Input value={baseUrl} placeholder={`API 基址（缺省 ${model.id} 官方）`} onChange={(event) => setBaseUrl(event.target.value)} />
                <div className={styles.row}>
                  <Button size="sm" variant="primary" disabled={!apiKey.trim()} onClick={save}>
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.row}>
                <Button size="sm" variant="secondary" onClick={() => setEditing(model.id)}>
                  {model.keyConfigured ? '更换 Key' : '配置 Key'}
                </Button>
                {model.keyConfigured && (
                  <Button size="sm" variant="danger" onClick={() => remove(model.id)}>
                    删除
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
    </section>
  )
}
