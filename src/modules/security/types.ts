/**
 * 模块 J：安全与审计 —— 数据模型。
 *
 * J1 API Key 安全管理：NamedKeyMeta（多 Key + 权限范围 + 轮换提醒）；
 * J2 操作审计日志：AuditEntry（时间/模型/Prompt 摘要/Token/费用/状态，脱敏后落盘）；
 * J3 数据防泄漏：DlpRule（内置 + 自定义正则）、DlpFinding、DlpSettings；
 * J4 合规报表：ComplianceReport（调用/费用/拦截/异常告警汇总）。
 */

/** Key 权限范围（J1）。 */
export interface KeyScope {
  /** 'read'=只读（仅允许查询类调用）；'full'=不限。 */
  readonly access: 'full' | 'read'
  /** 仅允许使用的模型前缀（空=不限；如 ['deepseek-v4-flash']）。 */
  readonly models: readonly string[]
  /** 日预算上限（元）；0=不限。 */
  readonly dailyBudgetCny: number
}

/** 命名 API Key 元数据（J1；Key 明文只存于保险库）。 */
export interface NamedKeyMeta {
  readonly name: string
  readonly createdAt: number
  /** 最近一次使用时间（用于轮换提醒与展示）。 */
  lastUsedAt: number
  readonly scope: KeyScope
  /** 备注（如所属项目）。 */
  readonly note: string
}

/** 审计日志条目（J2；Prompt 摘要已脱敏）。 */
export interface AuditEntry {
  readonly id: string
  readonly ts: number
  readonly model: string
  /** Prompt 摘要（前 100 字，已脱敏）。 */
  readonly promptSummary: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costCny: number
  /** ok / 错误分类码（如 TIMEOUT、AUTH_FAILED）。 */
  readonly status: string
  /** 调用来源（handoff / arena / orchestrator…）。 */
  readonly source: string
}

/** DLP 规则（J3）。 */
export interface DlpRule {
  readonly id: string
  readonly name: string
  readonly pattern: string
  /** true=内置规则（不可删除）。 */
  readonly builtin: boolean
  enabled: boolean
}

/** DLP 命中。 */
export interface DlpFinding {
  readonly ruleId: string
  readonly ruleName: string
  /** 命中片段（已掩码）。 */
  readonly sample: string
  readonly count: number
}

/** DLP 设置（J3）。 */
export interface DlpSettings {
  /** 总开关：关闭时不扫描不拦截。 */
  enabled: boolean
  /** 严格模式：检测到敏感内容直接拦截（否则仅警告，用户确认后放行）。 */
  strict: boolean
}

/** 合规报表（J4）。 */
export interface ComplianceReport {
  readonly from: string
  readonly to: string
  readonly totalCalls: number
  readonly totalCostCny: number
  readonly totalTokens: number
  /** 模型 → 调用占比（0~1）。 */
  readonly modelShare: Readonly<Record<string, number>>
  /** 敏感内容拦截次数（按规则名）。 */
  readonly blocks: Readonly<Record<string, number>>
  readonly blockTotal: number
  /** 异常调用告警记录。 */
  readonly alerts: readonly AuditAlert[]
}

/** 异常调用告警（J4）。 */
export interface AuditAlert {
  readonly ts: number
  readonly kind: 'token-threshold' | 'rate-burst'
  readonly detail: string
}
