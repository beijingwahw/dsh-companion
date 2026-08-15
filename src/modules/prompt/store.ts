/**
 * 模块 F：Prompt 工程工作台 —— 存储。
 *
 * - PromptVersionStore：'prompt-versions' 表，每次保存生成自增版本号（v1, v2...），
 *   支持备注、标签（稳定版/实验版/生产版）与回滚（回滚=复制历史版本为新版本）；
 * - PromptTemplateStore：'prompt-templates' 表，用户模板覆盖同名内置模板；
 * - PromptRatingStore：'prompt-ratings' 表，A/B 人工评分（👍/👎 → 胜率统计）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'

/** Prompt 版本记录（F1）。 */
export interface PromptVersion {
  /** 自增版本号（1 起）。 */
  readonly version: number
  readonly content: string
  /** 备注（如“加了 few-shot 示例”）。 */
  readonly note: string
  /** 标签（如“稳定版”“实验版”“生产版”）。 */
  readonly tags: readonly string[]
  readonly createdAt: number
}

/** Prompt 模板（F3）。 */
export interface PromptTemplate {
  readonly name: string
  /** 模板分类。 */
  readonly category: string
  readonly content: string
  /** true=内置模板（不可删除，可被同名用户模板覆盖）。 */
  readonly builtin: boolean
  readonly updatedAt: number
}

/** A/B 评分记录（F2）。 */
export interface PromptRating {
  readonly ts: number
  /** 'A' | 'B' | 'tie'。 */
  readonly winner: string
  readonly promptA: string
  readonly promptB: string
}

/** 内置模板库（F3）：代码生成/代码审查/文档生成/数据分析/翻译/摘要。 */
export const BUILTIN_TEMPLATES: readonly Omit<PromptTemplate, 'updatedAt'>[] = [
  {
    name: '代码生成',
    category: '代码生成',
    builtin: true,
    content:
      '你是一名资深 {{language}} 工程师。请遵循 {{code_style}} 代码风格，实现以下需求：\n\n{{requirement}}\n\n要求：\n1. 只输出可运行代码与必要注释；\n2. 处理边界情况与错误；\n3. 在结尾用一句话说明实现思路。',
  },
  {
    name: '代码审查',
    category: '代码审查',
    builtin: true,
    content:
      '请审查以下 {{language}} 代码，从正确性、性能、可读性、安全性四个维度给出意见：\n\n```\n{{code}}\n```\n\n输出格式：按维度列出问题（严重度：高/中/低）与修改建议，最后给出总体评价。',
  },
  {
    name: '文档生成',
    category: '文档生成',
    builtin: true,
    content:
      '为以下代码生成 {{doc_type}} 文档（语言：{{language}}）：\n\n```\n{{code}}\n```\n\n要求：包含用途说明、参数/返回值、使用示例与注意事项。',
  },
  {
    name: '数据分析',
    category: '数据分析',
    builtin: true,
    content:
      '你是一名数据分析师。请分析以下数据并回答问题：{{question}}\n\n数据：\n{{data}}\n\n要求：先给出结论摘要，再展示分析过程与关键数字，最后给出可执行建议。',
  },
  {
    name: '翻译',
    category: '翻译',
    builtin: true,
    content:
      '请将以下{{source_lang}}翻译为{{target_lang}}，保持专业术语准确、语气自然，只输出译文：\n\n{{text}}',
  },
  {
    name: '摘要',
    category: '摘要',
    builtin: true,
    content:
      '请对以下内容生成不超过 {{max_length}} 字的摘要，突出关键事实与结论：\n\n{{text}}',
  },
]

/** Prompt 版本仓库。 */
export class PromptVersionStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<PromptVersion>('prompt-versions')
  }

  /** 全部版本（版本号升序）。 */
  list(): PromptVersion[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.version - b.version)
  }

  get(version: number): PromptVersion | undefined {
    return this.table.get(String(version))
  }

  latest(): PromptVersion | undefined {
    const all = this.list()
    return all[all.length - 1]
  }

  /** 保存新版本（自增版本号）。 */
  async save(content: string, note: string, tags: readonly string[]): Promise<PromptVersion> {
    const next = (this.latest()?.version ?? 0) + 1
    const record: PromptVersion = { version: next, content, note, tags, createdAt: Date.now() }
    await this.table.put(String(next), record)
    return record
  }

  /** 回滚：将历史版本内容复制为新版本（保留完整历史，不删除中间版本）。 */
  async rollback(version: number, note: string): Promise<PromptVersion> {
    const target = this.get(version)
    if (!target) throw new Error(`版本 v${version} 不存在`)
    return this.save(target.content, note || `回滚自 v${version}`, target.tags)
  }

  /** 为版本增删标签。 */
  async mutateTags(version: number, add: readonly string[], remove: readonly string[]): Promise<PromptVersion> {
    const target = this.get(version)
    if (!target) throw new Error(`版本 v${version} 不存在`)
    const tags = new Set(target.tags)
    for (const tag of add) tags.add(tag)
    for (const tag of remove) tags.delete(tag)
    const updated: PromptVersion = { ...target, tags: [...tags] }
    await this.table.put(String(version), updated)
    return updated
  }
}

/** Prompt 模板仓库（用户模板表 + 内置模板合并）。 */
export class PromptTemplateStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<PromptTemplate>('prompt-templates')
  }

  /** 全部模板：内置 + 用户（同名时用户覆盖内置）。 */
  list(): PromptTemplate[] {
    const merged = new Map<string, PromptTemplate>()
    for (const builtin of BUILTIN_TEMPLATES) {
      merged.set(builtin.name, { ...builtin, updatedAt: 0 })
    }
    for (const [, value] of this.table.entries()) {
      merged.set(value.name, value)
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  get(name: string): PromptTemplate | undefined {
    const stored = this.table.get(name)
    if (stored) return stored
    const builtin = BUILTIN_TEMPLATES.find((t) => t.name === name)
    if (!builtin) return undefined
    return { ...builtin, updatedAt: 0 }
  }

  async save(name: string, category: string, content: string): Promise<PromptTemplate> {
    const record: PromptTemplate = {
      name,
      category: category || '自定义',
      content,
      builtin: false,
      updatedAt: Date.now(),
    }
    await this.table.put(name, record)
    return record
  }

  /** 删除用户模板（内置模板不可删：删除同名覆盖即恢复内置）。 */
  async delete(name: string): Promise<void> {
    await this.table.delete(name)
  }
}

/** A/B 评分仓库。 */
export class PromptRatingStore {
  private readonly table
  private counter = 0

  constructor(domain: Domain) {
    this.table = domain.table<PromptRating>('prompt-ratings')
  }

  async rate(winner: 'A' | 'B' | 'tie', promptA: string, promptB: string): Promise<void> {
    this.counter += 1
    await this.table.put(`${Date.now()}-${this.counter}`, {
      ts: Date.now(),
      winner,
      promptA,
      promptB,
    })
  }

  /** 胜率统计。 */
  summary(): { total: number; winsA: number; winsB: number; ties: number } {
    const entries = this.table.entries().map(([, value]) => value)
    return {
      total: entries.length,
      winsA: entries.filter((entry) => entry.winner === 'A').length,
      winsB: entries.filter((entry) => entry.winner === 'B').length,
      ties: entries.filter((entry) => entry.winner === 'tie').length,
    }
  }
}

/**
 * 变量插值：将 {{name}} 替换为 variables[name]；
 * 未提供的变量保留原样（便于发现缺失变量）。
 */
export function interpolateTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g, (match, name: string) => {
    const value = variables[name]
    return value === undefined ? match : value
  })
}

/** 提取模板中的全部变量名（去重，按出现顺序）。 */
export function extractTemplateVariables(template: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of template.matchAll(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}
