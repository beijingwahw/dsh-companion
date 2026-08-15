/**
 * Prompt 工程工作台视图页（模块 F 客户端 UI，挂载于 conversation.view）：
 * - F1 版本管理：保存/回滚/打标签，历史列表；
 * - F2 A/B 测试：左右分栏对比两版本输出，批量测试集，自动指标对比，人工评分；
 * - F3 模板库：内置 + 自定义模板，变量插值表单，一键生成 API 调用代码；
 * - F4 结构化校验：定义 JSON Schema，批量校验合规率，高亮违规字段。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, Select, Spinner, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchPromptTemplates,
  fetchPromptVersions,
  generateApiCode,
  rateAbTest,
  renderPromptTemplate,
  rollbackPromptVersion,
  runAbTest,
  savePromptTemplate,
  savePromptVersion,
  updatePromptTags,
  validateStructuredOutput,
} from '../api.js'
import type {
  AbTestResponse,
  PromptRatings,
  PromptTemplate,
  PromptVersion,
  ValidateResponse,
} from '../api.js'
import styles from './PromptWorkbenchView.module.css'

/** 组件 props。 */
export interface PromptWorkbenchViewProps {
  readonly sessionId?: string
}

/** 子面板页签。 */
type Tab = 'versions' | 'ab' | 'templates' | 'validate'

/** Prompt 工程工作台视图页。 */
export function PromptWorkbenchView(_props: PromptWorkbenchViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('versions')
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>Prompt 工程工作台</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'versions' ? 'primary' : 'secondary'} onClick={() => setTab('versions')}>
          版本管理
        </Button>
        <Button size="sm" variant={tab === 'ab' ? 'primary' : 'secondary'} onClick={() => setTab('ab')}>
          A/B 测试
        </Button>
        <Button size="sm" variant={tab === 'templates' ? 'primary' : 'secondary'} onClick={() => setTab('templates')}>
          模板库
        </Button>
        <Button size="sm" variant={tab === 'validate' ? 'primary' : 'secondary'} onClick={() => setTab('validate')}>
          结构化校验
        </Button>
      </div>
      {tab === 'versions' && <VersionsPanel />}
      {tab === 'ab' && <AbTestPanel />}
      {tab === 'templates' && <TemplatesPanel />}
      {tab === 'validate' && <ValidatePanel />}
    </div>
  )
}

/** F1：版本管理面板。 */
function VersionsPanel(): ReactElement {
  const [versions, setVersions] = useState<readonly PromptVersion[]>([])
  const [content, setContent] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    fetchPromptVersions()
      .then((response) => setVersions(response.versions))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载版本失败', 'error'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const save = useCallback(async () => {
    if (!content.trim()) return
    setBusy(true)
    try {
      await savePromptVersion({ content, note })
      setContent('')
      setNote('')
      reload()
      Toast.push('已保存新版本', 'success')
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [content, note, reload])

  const rollback = useCallback(
    async (version: number) => {
      setBusy(true)
      try {
        await rollbackPromptVersion({ version })
        reload()
        Toast.push(`已回滚：v${version} 的内容已存为新版本`, 'success')
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '回滚失败', 'error')
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const toggleTag = useCallback(
    async (version: number, tag: string, has: boolean) => {
      try {
        await updatePromptTags({ version, add: has ? [] : [tag], remove: has ? [tag] : [] })
        reload()
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '更新标签失败', 'error')
      }
    },
    [reload],
  )

  const presetTags = ['稳定版', '实验版', '生产版']

  return (
    <section className={styles.section}>
      <h3>保存新版本</h3>
      <Textarea value={content} rows={6} placeholder="粘贴或编辑 Prompt 内容…" onChange={(event) => setContent(event.target.value)} />
      <div className={styles.row}>
        <Input value={note} placeholder="备注（如：加了 few-shot 示例）" onChange={(event) => setNote(event.target.value)} />
        <Button variant="primary" size="sm" disabled={busy || !content.trim()} onClick={save}>
          保存版本
        </Button>
      </div>

      <h3>版本历史（{versions.length}）</h3>
      {versions.length === 0 ? (
        <p className={styles.empty}>尚未保存任何版本。</p>
      ) : (
        <ul className={styles.versionList}>
          {[...versions].reverse().map((version) => (
            <li key={version.version} className={styles.versionItem}>
              <div className={styles.versionHeader}>
                <strong>v{version.version}</strong>
                <span className={styles.versionNote}>{version.note || '无备注'}</span>
                <span className={styles.versionTime}>
                  {new Date(version.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </div>
              <pre className={styles.versionContent}>{version.content.slice(0, 300)}{version.content.length > 300 ? '…' : ''}</pre>
              <div className={styles.row}>
                {presetTags.map((tag) => {
                  const has = version.tags.includes(tag)
                  return (
                    <Button key={tag} size="sm" variant={has ? 'primary' : 'ghost'} onClick={() => toggleTag(version.version, tag, has)}>
                      {has ? `✓ ${tag}` : tag}
                    </Button>
                  )
                })}
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => rollback(version.version)}>
                  回滚到此版本
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** F2：A/B 测试面板。 */
function AbTestPanel(): ReactElement {
  const [promptA, setPromptA] = useState('')
  const [promptB, setPromptB] = useState('')
  const [casesText, setCasesText] = useState('')
  const [result, setResult] = useState<AbTestResponse | undefined>()
  const [ratings, setRatings] = useState<PromptRatings | undefined>()
  const [busy, setBusy] = useState(false)

  // 长请求可取消：AbortController 在卸载时中止，避免对已卸载组件 setState。
  const abortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const run = useCallback(async () => {
    if (!promptA.trim() || !promptB.trim()) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setResult(undefined)
    try {
      const cases = casesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const response = await runAbTest(
        { promptA, promptB, cases },
        { timeoutMs: 300_000, signal: controller.signal },
      )
      if (!controller.signal.aborted) {
        setResult(response)
        setRatings(response.ratings)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        Toast.push(err instanceof Error ? err.message : 'A/B 测试失败', 'error')
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [promptA, promptB, casesText])

  /** 取消进行中的 A/B 测试。 */
  const cancel = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }, [])

  const rate = useCallback(
    async (winner: 'A' | 'B' | 'tie') => {
      try {
        const response = await rateAbTest({ winner, promptA, promptB })
        setRatings(response.ratings)
        Toast.push('评分已记录', 'success')
      } catch (err) {
        Toast.push(err instanceof Error ? err.message : '评分失败', 'error')
      }
    },
    [promptA, promptB],
  )

  return (
    <section className={styles.section}>
      <div className={styles.split}>
        <div className={styles.splitCol}>
          <h3>版本 A</h3>
          <Textarea value={promptA} rows={5} placeholder="Prompt 版本 A…" onChange={(event) => setPromptA(event.target.value)} />
        </div>
        <div className={styles.splitCol}>
          <h3>版本 B</h3>
          <Textarea value={promptB} rows={5} placeholder="Prompt 版本 B…" onChange={(event) => setPromptB(event.target.value)} />
        </div>
      </div>
      <h3>测试集（每行一条，可留空）</h3>
      <Textarea value={casesText} rows={3} placeholder={'用例 1\n用例 2'} onChange={(event) => setCasesText(event.target.value)} />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || !promptA.trim() || !promptB.trim()} onClick={run}>
          {busy ? '测试中…' : '运行 A/B 测试'}
        </Button>
        {busy && (
          <Button variant="ghost" size="sm" onClick={cancel}>
            取消
          </Button>
        )}
        {result && (
          <>
            <Button size="sm" variant="secondary" onClick={() => rate('A')}>A 更好</Button>
            <Button size="sm" variant="secondary" onClick={() => rate('B')}>B 更好</Button>
            <Button size="sm" variant="ghost" onClick={() => rate('tie')}>平局</Button>
          </>
        )}
      </div>
      {busy && <Spinner label="正在批量调用模型…" />}

      {ratings && ratings.total > 0 && (
        <p className={styles.ratings}>
          历史评分：共 {ratings.total} 次 · A 胜 {ratings.winsA} · B 胜 {ratings.winsB} · 平局 {ratings.ties}
          {ratings.winsA + ratings.winsB > 0 &&
            ` · A 胜率 ${((ratings.winsA / (ratings.winsA + ratings.winsB)) * 100).toFixed(0)}%`}
        </p>
      )}

      {result && (
        <div className={styles.split}>
          <div className={styles.splitCol}>
            <h3>A 输出（{result.a.summary.totalTokens} tokens · 平均 {result.a.summary.avgLatencyMs}ms）</h3>
            {result.a.results.map((run) => (
              <pre key={run.caseIndex} className={run.ok ? styles.outputOk : styles.outputFail}>
                {run.ok ? run.output : `错误：${run.error}`}
              </pre>
            ))}
          </div>
          <div className={styles.splitCol}>
            <h3>B 输出（{result.b.summary.totalTokens} tokens · 平均 {result.b.summary.avgLatencyMs}ms）</h3>
            {result.b.results.map((run) => (
              <pre key={run.caseIndex} className={run.ok ? styles.outputOk : styles.outputFail}>
                {run.ok ? run.output : `错误：${run.error}`}
              </pre>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** F3：模板库面板。 */
function TemplatesPanel(): ReactElement {
  const [templates, setTemplates] = useState<readonly PromptTemplate[]>([])
  const [selected, setSelected] = useState<PromptTemplate | undefined>()
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [rendered, setRendered] = useState('')
  const [codeLanguage, setCodeLanguage] = useState<'python' | 'nodejs' | 'curl'>('python')
  const [code, setCode] = useState('')

  const reload = useCallback(() => {
    fetchPromptTemplates()
      .then((response) => setTemplates(response.templates))
      .catch((err: unknown) => Toast.push(err instanceof Error ? err.message : '加载模板失败', 'error'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const selectTemplate = useCallback((template: PromptTemplate) => {
    setSelected(template)
    setVariables({})
    setRendered('')
    setCode('')
  }, [])

  const render = useCallback(async () => {
    if (!selected) return
    try {
      const response = await renderPromptTemplate({ template: selected.content, variables })
      setRendered(response.rendered)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '渲染失败', 'error')
    }
  }, [selected, variables])

  const genCode = useCallback(async () => {
    const source = rendered || selected?.content || ''
    if (!source) return
    try {
      const response = await generateApiCode({ prompt: source, language: codeLanguage })
      setCode(response.code)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '生成代码失败', 'error')
    }
  }, [rendered, selected, codeLanguage])

  const saveAsTemplate = useCallback(async () => {
    const name = window.prompt('模板名称：')
    if (!name) return
    const source = rendered || selected?.content || ''
    if (!source) return
    try {
      await savePromptTemplate({ name, content: source })
      reload()
      Toast.push('模板已保存', 'success')
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '保存模板失败', 'error')
    }
  }, [rendered, selected, reload])

  return (
    <section className={styles.section}>
      <div className={styles.split}>
        <div className={styles.splitCol}>
          <h3>模板列表</h3>
          <ul className={styles.templateList}>
            {templates.map((template) => (
              <li key={template.name}>
                <button
                  type="button"
                  className={selected?.name === template.name ? styles.templateActive : styles.templateItem}
                  onClick={() => selectTemplate(template)}
                >
                  {template.name}
                  <span className={styles.templateCategory}>
                    {template.category}
                    {template.builtin ? ' · 内置' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.splitCol}>
          {selected ? (
            <>
              <h3>
                {selected.name}
                {selected.variables.length > 0 && `（变量：${selected.variables.join('、')}）`}
              </h3>
              <pre className={styles.versionContent}>{selected.content}</pre>
              {selected.variables.map((name) => (
                <div key={name} className={styles.row}>
                  <label className={styles.varLabel}>{`{{${name}}}`}</label>
                  <Input
                    value={variables[name] ?? ''}
                    placeholder={`输入 ${name} 的值`}
                    onChange={(event) => setVariables((prev) => ({ ...prev, [name]: event.target.value }))}
                  />
                </div>
              ))}
              <div className={styles.row}>
                <Button size="sm" variant="primary" onClick={render}>
                  渲染
                </Button>
                <Select value={codeLanguage} onChange={(event) => setCodeLanguage(event.target.value as 'python' | 'nodejs' | 'curl')}>
                  <option value="python">Python</option>
                  <option value="nodejs">Node.js</option>
                  <option value="curl">curl</option>
                </Select>
                <Button size="sm" variant="secondary" onClick={genCode}>
                  生成调用代码
                </Button>
                <Button size="sm" variant="ghost" onClick={saveAsTemplate}>
                  另存为模板
                </Button>
              </div>
              {rendered && <pre className={styles.versionContent}>{rendered}</pre>}
              {code && <pre className={styles.codeBlock}>{code}</pre>}
            </>
          ) : (
            <p className={styles.empty}>从左侧选择一个模板。</p>
          )}
        </div>
      </div>
    </section>
  )
}

/** F4：结构化输出校验面板。 */
function ValidatePanel(): ReactElement {
  const [prompt, setPrompt] = useState('')
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "required": [],\n  "properties": {}\n}')
  const [casesText, setCasesText] = useState('')
  const [result, setResult] = useState<ValidateResponse | undefined>()
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    if (!prompt.trim()) return
    setBusy(true)
    setResult(undefined)
    try {
      const cases = casesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const response = await validateStructuredOutput({ prompt, schema: schemaText, cases }, { timeoutMs: 300_000 })
      setResult(response)
    } catch (err) {
      Toast.push(err instanceof Error ? err.message : '校验失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [prompt, schemaText, casesText])

  return (
    <section className={styles.section}>
      <h3>Prompt（要求模型输出 JSON）</h3>
      <Textarea value={prompt} rows={4} placeholder="例如：提取以下文本中的人名与年龄，输出 JSON…" onChange={(event) => setPrompt(event.target.value)} />
      <h3>期望的 JSON Schema</h3>
      <Textarea value={schemaText} rows={6} onChange={(event) => setSchemaText(event.target.value)} />
      <h3>测试集（每行一条，可留空）</h3>
      <Textarea value={casesText} rows={3} onChange={(event) => setCasesText(event.target.value)} />
      <div className={styles.row}>
        <Button variant="primary" size="sm" disabled={busy || !prompt.trim()} onClick={run}>
          {busy ? '校验中…' : '批量校验'}
        </Button>
      </div>
      {busy && <Spinner label="正在批量调用并校验…" />}

      {result && (
        <>
          <p className={result.complianceRate === 1 ? styles.complianceFull : styles.compliancePartial}>
            合规率：{(result.complianceRate * 100).toFixed(0)}%（{result.compliant}/{result.total}）
            {result.complianceRate === 1 ? ' · 已达 100%，可上线' : ' · 请修复不合规项后再上线'}
          </p>
          <ul className={styles.versionList}>
            {result.runs.map((run) => (
              <li key={run.caseIndex} className={run.ok ? styles.runOk : styles.runFail}>
                <div className={styles.versionHeader}>
                  <strong>用例 {run.caseIndex + 1}</strong>
                  <span>{run.ok ? '合规' : run.error ? `调用失败：${run.error}` : `违规 ${run.violations.length} 项`}</span>
                </div>
                {!run.ok && run.violations.length > 0 && (
                  <ul className={styles.violationList}>
                    {run.violations.map((violation, index) => (
                      <li key={index}>
                        <code>{violation.path || '(根)'}</code>：{violation.message}
                      </li>
                    ))}
                  </ul>
                )}
                <pre className={styles.versionContent}>{run.output.slice(0, 500) || '(无输出)'}</pre>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
