/**
 * 安全与审计视图页（模块 J 客户端 UI，挂载于 conversation.view）：
 * - J1 API Key 安全管理：多 Key 配置/激活/删除、权限范围、轮换提醒、泄露检测；
 * - J2 操作审计日志：时间/模型/状态筛选、CSV/JSON 导出（脱敏后落盘）；
 * - J3 数据防泄漏（DLP）：总开关/严格模式、内置+自定义规则、发送前预检扫描；
 * - J4 合规报表：调用/费用/模型占比/拦截/告警汇总，导出自包含 HTML（可打印为 PDF）。
 *
 * 安全红线：任何界面不回传 Key 明文，仅展示掩码元数据。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Checkbox, Input, Select, Textarea, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  activateSecurityKey,
  addDlpRule,
  checkKeyLeak,
  deleteDlpRule,
  deleteSecurityKey,
  exportAuditLog,
  exportComplianceReport,
  fetchAuditLog,
  fetchComplianceReport,
  fetchDlpState,
  fetchKeyRotation,
  fetchSecurityKeys,
  saveSecurityKey,
  scanDlp,
  toggleDlpRule,
  updateDlpSettings,
} from '../api.js'
import type {
  AuditEntry,
  ComplianceReport,
  DlpFinding,
  DlpRule,
  DlpSettings,
  SecurityKeyView,
} from '../api.js'
import { downloadBlob, openPrintHtml } from '../api.js'
import styles from './SecurityAuditView.module.css'

/** 组件 props。 */
export interface SecurityAuditViewProps {
  readonly sessionId?: string
}

/** 子面板页签。 */
type Tab = 'keys' | 'audit' | 'dlp' | 'report'

/** 安全与审计视图页。 */
export function SecurityAuditView(_props: SecurityAuditViewProps): ReactElement {
  const [tab, setTab] = useState<Tab>('keys')
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>安全与审计</h2>
      <div className={styles.tabs}>
        <Button size="sm" variant={tab === 'keys' ? 'primary' : 'secondary'} onClick={() => setTab('keys')}>
          API Key 管理
        </Button>
        <Button size="sm" variant={tab === 'audit' ? 'primary' : 'secondary'} onClick={() => setTab('audit')}>
          审计日志
        </Button>
        <Button size="sm" variant={tab === 'dlp' ? 'primary' : 'secondary'} onClick={() => setTab('dlp')}>
          数据防泄漏
        </Button>
        <Button size="sm" variant={tab === 'report' ? 'primary' : 'secondary'} onClick={() => setTab('report')}>
          合规报表
        </Button>
      </div>
      {tab === 'keys' && <KeysPanel />}
      {tab === 'audit' && <AuditPanel />}
      {tab === 'dlp' && <DlpPanel />}
      {tab === 'report' && <ReportPanel />}
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

/** 北京时间日键（YYYY-MM-DD）。 */
function beijingDay(ts: number): string {
  const shifted = new Date(ts + 8 * 3600_000)
  return shifted.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// J1：API Key 安全管理
// ---------------------------------------------------------------------------

/** Key 管理面板。 */
function KeysPanel(): ReactElement {
  const [keys, setKeys] = useState<readonly SecurityKeyView[]>([])
  const [rotationDays, setRotationDays] = useState(30)
  const [form, setForm] = useState({
    name: '',
    apiKey: '',
    note: '',
    access: 'full',
    models: '',
    dailyBudgetCny: '0',
  })
  const [leakInput, setLeakInput] = useState('')

  const reload = useCallback(() => {
    fetchSecurityKeys()
      .then((response) => {
        setKeys(response.keys)
        setRotationDays(response.rotationDays)
      })
      .catch((error) => reportError(error, '加载 Key 列表失败'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const submit = (): void => {
    if (!form.name.trim() || !form.apiKey.trim()) {
      Toast.push('Key 名称与明文必填', 'warning')
      return
    }
    saveSecurityKey({
      name: form.name.trim(),
      apiKey: form.apiKey.trim(),
      note: form.note.trim(),
      scope: {
        access: form.access === 'read' ? 'read' : 'full',
        models: form.models
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
        dailyBudgetCny: Number(form.dailyBudgetCny) || 0,
      },
    })
      .then(() => {
        Toast.push('Key 已加密保存', 'success')
        setForm({ name: '', apiKey: '', note: '', access: 'full', models: '', dailyBudgetCny: '0' })
        reload()
      })
      .catch((error) => reportError(error, '保存 Key 失败'))
  }

  const runLeakCheck = (): void => {
    if (!leakInput.trim()) return
    checkKeyLeak(leakInput)
      .then((response) => {
        if (response.safe) {
          Toast.push('未检测到已知 API Key 泄露', 'success')
        } else {
          Toast.push(`检测到泄露：${response.leaked.join('、')}`, 'error')
        }
      })
      .catch((error) => reportError(error, '泄露检测失败'))
  }

  return (
    <>
      <section className={styles.section}>
        <h3>新增 API Key（加密落盘，不回传明文）</h3>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>名称（如项目名）</span>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>API Key 明文</span>
            <Input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>权限范围</span>
            <Select value={form.access} onChange={(event) => setForm({ ...form, access: event.target.value })}>
              <option value="full">不限</option>
              <option value="read">只读</option>
            </Select>
          </label>
          <label className={styles.field}>
            <span>限定模型前缀（逗号分隔，空=不限）</span>
            <Input value={form.models} placeholder="deepseek-v4-flash" onChange={(event) => setForm({ ...form, models: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>日预算上限（元，0=不限）</span>
            <Input type="number" value={form.dailyBudgetCny} onChange={(event) => setForm({ ...form, dailyBudgetCny: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>备注</span>
            <Input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
          </label>
        </div>
        <div>
          <Button size="sm" variant="primary" onClick={submit}>
            保存 Key
          </Button>
        </div>
        <p className={styles.hint}>轮换提醒阈值：使用超过 {rotationDays} 天会标记为待轮换。</p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>已配置 Key</h3>
          <Button size="sm" variant="secondary" onClick={reload}>
            刷新
          </Button>
        </div>
        {keys.length === 0 ? (
          <p className={styles.empty}>暂无命名 Key。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>权限</th>
                <th>创建时间</th>
                <th>最近使用</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.name}>
                  <td>
                    {key.name}
                    {key.note ? `（${key.note}）` : ''}
                  </td>
                  <td>
                    {key.scope.access === 'read' ? '只读' : '不限'}
                    {key.scope.models.length > 0 ? ` · ${key.scope.models.join('/')}` : ''}
                    {key.scope.dailyBudgetCny > 0 ? ` · ¥${key.scope.dailyBudgetCny}/天` : ''}
                  </td>
                  <td>{formatTime(key.createdAt)}</td>
                  <td>{formatTime(key.lastUsedAt)}</td>
                  <td>{key.rotationDue ? <span className={`${styles.pill} ${styles.pillWarning}`}>待轮换</span> : <span className={styles.pill}>正常</span>}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => activateSecurityKey(key.name).then(() => Toast.push(`已激活 ${key.name}`, 'success')).catch((error) => reportError(error, '激活失败'))}
                      >
                        激活
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => deleteSecurityKey(key.name).then(() => { Toast.push('已删除', 'success'); reload() }).catch((error) => reportError(error, '删除失败'))}
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
      </section>

      <section className={styles.section}>
        <h3>Key 泄露检测</h3>
        <p className={styles.hint}>粘贴疑似泄露的代码/提交内容，检查是否包含已配置的 API Key。</p>
        <Textarea rows={4} value={leakInput} onChange={(event) => setLeakInput(event.target.value)} />
        <div>
          <Button size="sm" variant="secondary" onClick={runLeakCheck}>
            检测
          </Button>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// J2：操作审计日志
// ---------------------------------------------------------------------------

/** 审计日志面板。 */
function AuditPanel(): ReactElement {
  const [entries, setEntries] = useState<readonly AuditEntry[]>([])
  const [filter, setFilter] = useState({ model: '', status: '', limit: '200' })

  const reload = useCallback(() => {
    fetchAuditLog({
      model: filter.model.trim() || undefined,
      status: filter.status.trim() || undefined,
      limit: Number(filter.limit) || 200,
    })
      .then((response) => setEntries(response.entries))
      .catch((error) => reportError(error, '加载审计日志失败'))
  }, [filter])

  // 仅挂载时自动加载一次；筛选条件变化不触发请求，由「查询」按钮显式触发，
  // 避免每敲一个字符就发一次请求。
  const initialLoaded = useRef(false)
  useEffect(() => {
    if (initialLoaded.current) return
    initialLoaded.current = true
    reload()
  }, [reload])

  const doExport = (format: 'csv' | 'json'): void => {
    exportAuditLog({ format })
      .then((response) => {
        const blob = new Blob([response.content], { type: format === 'csv' ? 'text/csv' : 'application/json' })
        downloadBlob(blob, response.fileName)
      })
      .catch((error) => reportError(error, '导出失败'))
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>操作审计日志（Prompt 摘要已脱敏）</h3>
        <div className={styles.rowActions}>
          <Button size="sm" variant="secondary" onClick={() => doExport('csv')}>
            导出 CSV
          </Button>
          <Button size="sm" variant="secondary" onClick={() => doExport('json')}>
            导出 JSON
          </Button>
        </div>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>模型筛选</span>
          <Input value={filter.model} onChange={(event) => setFilter({ ...filter, model: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>状态筛选（ok / TIMEOUT / AUTH_FAILED…）</span>
          <Input value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>条数上限</span>
          <Input type="number" value={filter.limit} onChange={(event) => setFilter({ ...filter, limit: event.target.value })} />
        </label>
        <div className={styles.field}>
          <Button size="sm" variant="primary" onClick={reload}>
            查询
          </Button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className={styles.empty}>暂无审计记录。</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>Prompt 摘要</th>
              <th>Token</th>
              <th>费用</th>
              <th>状态</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatTime(entry.ts)}</td>
                <td>{entry.model}</td>
                <td>{entry.promptSummary}</td>
                <td>
                  {entry.promptTokens}/{entry.completionTokens}
                </td>
                <td>¥{entry.costCny.toFixed(4)}</td>
                <td>
                  {entry.status === 'ok' ? (
                    <span className={`${styles.pill} ${styles.pillSuccess}`}>ok</span>
                  ) : (
                    <span className={`${styles.pill} ${styles.pillDanger}`}>{entry.status}</span>
                  )}
                </td>
                <td>{entry.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// J3：数据防泄漏（DLP）
// ---------------------------------------------------------------------------

/** DLP 面板。 */
function DlpPanel(): ReactElement {
  const [settings, setSettings] = useState<DlpSettings | null>(null)
  const [rules, setRules] = useState<readonly DlpRule[]>([])
  const [newRule, setNewRule] = useState({ name: '', pattern: '' })
  const [scanText, setScanText] = useState('')
  const [findings, setFindings] = useState<readonly DlpFinding[] | null>(null)

  const reload = useCallback(() => {
    fetchDlpState()
      .then((response) => {
        setSettings(response.settings)
        setRules(response.rules)
      })
      .catch((error) => reportError(error, '加载 DLP 状态失败'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const toggleSetting = (patch: { enabled?: boolean; strict?: boolean }): void => {
    updateDlpSettings(patch)
      .then((response) => setSettings(response.settings))
      .catch((error) => reportError(error, '更新设置失败'))
  }

  const submitRule = (): void => {
    if (!newRule.name.trim() || !newRule.pattern.trim()) {
      Toast.push('规则名称与正则必填', 'warning')
      return
    }
    addDlpRule({ name: newRule.name.trim(), pattern: newRule.pattern.trim() })
      .then((response) => {
        setRules(response.rules)
        setNewRule({ name: '', pattern: '' })
        Toast.push('规则已添加', 'success')
      })
      .catch((error) => reportError(error, '添加规则失败'))
  }

  const runScan = (): void => {
    if (!scanText.trim()) return
    scanDlp(scanText)
      .then((response) => {
        setFindings(response.findings)
        if (response.clean) Toast.push('未检测到敏感内容', 'success')
        else Toast.push(`检测到 ${response.findings.length} 类敏感内容`, 'warning')
      })
      .catch((error) => reportError(error, '扫描失败'))
  }

  return (
    <>
      <section className={styles.section}>
        <h3>DLP 设置</h3>
        {settings === null ? (
          <p className={styles.empty}>加载中…</p>
        ) : (
          <div className={styles.rowActions}>
            <Checkbox
              checked={settings.enabled}
              label="启用发送前敏感内容扫描"
              onChange={(checked) => toggleSetting({ enabled: checked })}
            />
            <Checkbox
              checked={settings.strict}
              label="严格模式：检测到敏感内容直接拦截（否则仅警告）"
              onChange={(checked) => toggleSetting({ strict: checked })}
            />
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h3>检测规则（内置 + 自定义）</h3>
        {rules.length === 0 ? (
          <p className={styles.empty}>暂无规则。</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>正则</th>
                <th>启用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.name}</td>
                  <td>{rule.builtin ? '内置' : '自定义'}</td>
                  <td>
                    <code>{rule.pattern}</code>
                  </td>
                  <td>
                    <Checkbox
                      checked={rule.enabled}
                      onChange={(checked) =>
                        toggleDlpRule(rule.id, checked)
                          .then((response) => setRules(response.rules))
                          .catch((error) => reportError(error, '切换失败'))
                      }
                    />
                  </td>
                  <td>
                    {!rule.builtin && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          deleteDlpRule(rule.id)
                            .then((response) => setRules(response.rules))
                            .catch((error) => reportError(error, '删除失败'))
                        }
                      >
                        删除
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>自定义规则名称</span>
            <Input value={newRule.name} onChange={(event) => setNewRule({ ...newRule, name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span>正则表达式</span>
            <Input value={newRule.pattern} placeholder="如内部工号 \\bEMP\\d{6}\\b" onChange={(event) => setNewRule({ ...newRule, pattern: event.target.value })} />
          </label>
        </div>
        <div>
          <Button size="sm" variant="primary" onClick={submitRule}>
            添加自定义规则
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h3>发送前预检扫描</h3>
        <Textarea rows={4} value={scanText} onChange={(event) => setScanText(event.target.value)} />
        <div>
          <Button size="sm" variant="secondary" onClick={runScan}>
            扫描
          </Button>
        </div>
        {findings !== null &&
          (findings.length === 0 ? (
            <p className={styles.empty}>内容干净，可安全发送。</p>
          ) : (
            <ul className={styles.findingList}>
              {findings.map((finding) => (
                <li key={finding.ruleId} className={styles.findingItem}>
                  {finding.ruleName} × {finding.count}（示例：{finding.sample}）
                </li>
              ))}
            </ul>
          ))}
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// J4：合规报表
// ---------------------------------------------------------------------------

/** 合规报表面板。 */
function ReportPanel(): ReactElement {
  const today = Date.now()
  const [from, setFrom] = useState(beijingDay(today - 6 * 24 * 3600_000))
  const [to, setTo] = useState(beijingDay(today))
  const [report, setReport] = useState<ComplianceReport | null>(null)

  const load = useCallback(() => {
    fetchComplianceReport({ from, to })
      .then((response) => setReport(response))
      .catch((error) => reportError(error, '加载合规报表失败'))
  }, [from, to])

  useEffect(() => {
    load()
  }, [load])

  const doExport = (): void => {
    exportComplianceReport({ from, to })
      .then((response) => {
        // 自包含 HTML：新窗口打印，可另存为 PDF 提交安全团队。
        openPrintHtml(response.content)
      })
      .catch((error) => reportError(error, '导出报表失败'))
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>合规报表</h3>
        <div className={styles.rowActions}>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <Button size="sm" variant="primary" onClick={load}>
            查询
          </Button>
          <Button size="sm" variant="secondary" onClick={doExport}>
            导出（打印为 PDF）
          </Button>
        </div>
      </div>
      {report === null ? (
        <p className={styles.empty}>加载中…</p>
      ) : (
        <>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{report.totalCalls}</span>
              <span className={styles.statLabel}>API 调用总量</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>¥{report.totalCostCny.toFixed(4)}</span>
              <span className={styles.statLabel}>总费用</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{report.totalTokens}</span>
              <span className={styles.statLabel}>总 Token 消耗</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>{report.blockTotal}</span>
              <span className={styles.statLabel}>敏感内容拦截次数</span>
            </div>
          </div>

          <h3>各模型使用占比</h3>
          {Object.keys(report.modelShare).length === 0 ? (
            <p className={styles.empty}>无数据。</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.modelShare).map(([model, share]) => (
                  <tr key={model}>
                    <td>{model}</td>
                    <td>{(share * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>敏感内容拦截统计</h3>
          {Object.keys(report.blocks).length === 0 ? (
            <p className={styles.empty}>无拦截记录。</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>规则</th>
                  <th>次数</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.blocks).map(([ruleName, count]) => (
                  <tr key={ruleName}>
                    <td>{ruleName}</td>
                    <td>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>异常调用告警记录</h3>
          {report.alerts.length === 0 ? (
            <p className={styles.empty}>无告警。</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {report.alerts.map((alert) => (
                  <tr key={`${alert.ts}-${alert.kind}`}>
                    <td>{formatTime(alert.ts)}</td>
                    <td>
                      <span className={`${styles.pill} ${styles.pillDanger}`}>{alert.kind}</span>
                    </td>
                    <td>{alert.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}
