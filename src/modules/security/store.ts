/**
 * 模块 J：安全与审计 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'named-keys'：命名 Key 元数据（J1；明文只在保险库，此处仅元数据）；
 * - 'audit-log'：审计日志（J2；Prompt 摘要已脱敏，滚动保留上限）；
 * - 'dlp-rules' / 'dlp-settings'：DLP 自定义规则与设置（J3）；
 * - 'dlp-blocks-daily'：拦截次数日聚合（J4 报表）；
 * - 'audit-alerts'：异常调用告警（J4）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'
import { beijingDayKey } from '../../core/time.js'
import type { AuditAlert, AuditEntry, DlpRule, DlpSettings, NamedKeyMeta } from './types.js'
import { BUILTIN_DLP_RULES } from './dlp.js'

/** 审计日志滚动保留上限（条）。 */
export const AUDIT_LOG_LIMIT = 5_000

/** 命名 Key 元数据仓库（J1）。 */
export class NamedKeyStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<NamedKeyMeta>('named-keys')
  }

  list(): NamedKeyMeta[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(name: string): NamedKeyMeta | undefined {
    return this.table.get(name)
  }

  async put(meta: NamedKeyMeta): Promise<void> {
    await this.table.put(meta.name, meta)
  }

  async delete(name: string): Promise<void> {
    await this.table.delete(name)
  }
}

/** 审计日志仓库（J2；滚动保留 AUDIT_LOG_LIMIT 条）。 */
export class AuditLogStore {
  private readonly table
  private counter = 0

  constructor(domain: Domain) {
    this.table = domain.table<AuditEntry>('audit-log')
  }

  /** 追加一条日志（超出上限时删除最旧记录）。 */
  async append(entry: AuditEntry): Promise<void> {
    await this.table.put(entry.id, entry)
    this.counter += 1
    // 每 100 条触发一次滚动清理，摊薄开销。
    if (this.counter % 100 === 0) await this.trim()
  }

  /** 滚动清理：仅保留最新 AUDIT_LOG_LIMIT 条。 */
  async trim(): Promise<void> {
    const all = this.list()
    if (all.length <= AUDIT_LOG_LIMIT) return
    const overflow = all.slice(AUDIT_LOG_LIMIT)
    for (const entry of overflow) {
      await this.table.delete(entry.id)
    }
  }

  /** 全部日志（新→旧）。 */
  list(): AuditEntry[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.ts - a.ts)
  }

  /** 按条件筛选。 */
  filter(options: {
    from?: number
    to?: number
    model?: string
    status?: string
    limit?: number
  }): AuditEntry[] {
    return this.list()
      .filter((entry) => {
        if (options.from !== undefined && entry.ts < options.from) return false
        if (options.to !== undefined && entry.ts > options.to) return false
        if (options.model && entry.model !== options.model) return false
        if (options.status && entry.status !== options.status) return false
        return true
      })
      .slice(0, options.limit ?? 500)
  }

  /** 区间 [fromDay, toDay] 内的日志。 */
  range(fromDay: string, toDay: string): AuditEntry[] {
    return this.list().filter((entry) => {
      const day = beijingDayKey(entry.ts)
      return day >= fromDay && day <= toDay
    })
  }
}

/** 生成审计条目 id。 */
export function auditId(): string {
  return `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** DLP 规则仓库（J3：内置 + 自定义合并）。 */
export class DlpRuleStore {
  private readonly table
  /** 内置规则启用状态覆盖表（id → enabled）。 */
  private readonly builtinOverrides

  constructor(domain: Domain) {
    this.table = domain.table<DlpRule>('dlp-rules')
    this.builtinOverrides = domain.table<{ enabled: boolean }>('dlp-builtin-overrides')
  }

  /** 全部规则：内置（应用启用覆盖）+ 自定义。 */
  list(): DlpRule[] {
    const builtin = BUILTIN_DLP_RULES.map((rule) => ({
      ...rule,
      enabled: this.builtinOverrides.get(rule.id)?.enabled ?? true,
    }))
    const custom = this.table.entries().map(([, value]) => value)
    return [...builtin, ...custom]
  }

  /** 切换内置规则启用状态。 */
  async toggleBuiltin(id: string, enabled: boolean): Promise<void> {
    await this.builtinOverrides.put(id, { enabled })
  }

  async put(rule: DlpRule): Promise<void> {
    await this.table.put(rule.id, rule)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** DLP 设置仓库（J3）。 */
export class DlpSettingsStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<DlpSettings>('dlp-settings')
  }

  get(): DlpSettings {
    return this.table.get('main') ?? { enabled: true, strict: false }
  }

  async update(patch: Partial<DlpSettings>): Promise<DlpSettings> {
    const current = this.get()
    const next: DlpSettings = { ...current, ...patch }
    await this.table.put('main', next)
    return next
  }
}

/** DLP 拦截日聚合（J4 报表）。 */
export interface DlpDailyBlock {
  readonly day: string
  total: number
  byRule: Record<string, number>
}

/** DLP 拦截统计仓库。 */
export class DlpBlockStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<DlpDailyBlock>('dlp-blocks-daily')
  }

  /** 记录一次拦截（按规则名计数）。 */
  async recordBlock(ts: number, ruleNames: readonly string[]): Promise<void> {
    const day = beijingDayKey(ts)
    await this.table.update(day, (prev) => {
      const base: DlpDailyBlock = prev ?? { day, total: 0, byRule: {} }
      const byRule = { ...base.byRule }
      for (const name of ruleNames) byRule[name] = (byRule[name] ?? 0) + 1
      return { day, total: base.total + 1, byRule }
    })
  }

  range(fromDay: string, toDay: string): DlpDailyBlock[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((row) => row.day >= fromDay && row.day <= toDay)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }
}

/** 异常告警仓库（J4）。 */
export class AuditAlertStore {
  private readonly table
  private counter = 0

  constructor(domain: Domain) {
    this.table = domain.table<AuditAlert>('audit-alerts')
  }

  async push(alert: AuditAlert): Promise<void> {
    this.counter += 1
    await this.table.put(`${alert.ts}-${this.counter}`, alert)
  }

  range(fromDay: string, toDay: string): AuditAlert[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((alert) => {
        const day = beijingDayKey(alert.ts)
        return day >= fromDay && day <= toDay
      })
      .sort((a, b) => b.ts - a.ts)
  }
}
