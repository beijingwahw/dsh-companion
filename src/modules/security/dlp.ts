/**
 * 模块 J3：数据防泄漏（DLP）扫描器与脱敏工具。
 *
 * - 内置规则：硬编码密钥/密码、数据库连接串、手机号、邮箱、身份证号、
 *   常见 API Key 形态；用户可追加自定义正则规则；
 * - scan：返回命中（片段掩码展示）；redact：将命中替换为占位符；
 * - 脱敏用于审计日志落盘（J2）与报表，确保敏感内容不以明文留存。
 */
import type { DlpFinding, DlpRule } from './types.js'

/** 内置 DLP 规则（不可删除，可禁用）。 */
export const BUILTIN_DLP_RULES: readonly Omit<DlpRule, 'enabled'>[] = [
  {
    id: 'builtin-api-key',
    name: 'API Key / 访问令牌',
    builtin: true,
    pattern: '(?i)\\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\\b',
  },
  {
    id: 'builtin-password',
    name: '硬编码密码',
    builtin: true,
    pattern: "(?i)(password|passwd|pwd|secret|token)\\s*[:=]\\s*['\"][^'\"\\s]{6,}['\"]",
  },
  {
    id: 'builtin-db-conn',
    name: '数据库连接字符串',
    builtin: true,
    pattern: '(?i)\\b(mysql|postgres(?:ql)?|mongodb(?:\\+srv)?|redis|amqp)://[^\\s\'"<>]+:[^\\s\'"<>]+@[^\\s\'"<>]+',
  },
  {
    id: 'builtin-phone-cn',
    name: '手机号（中国大陆）',
    builtin: true,
    pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
  },
  {
    id: 'builtin-email',
    name: '电子邮箱',
    builtin: true,
    pattern: '(?i)\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
  },
  {
    id: 'builtin-id-cn',
    name: '身份证号（中国大陆）',
    builtin: true,
    pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)',
  },
  {
    id: 'builtin-private-key',
    name: '私钥块',
    builtin: true,
    pattern: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----',
  },
]

/** 单条规则最大命中数（防止超长文本刷屏）。 */
const MAX_FINDINGS_PER_RULE = 20

/** 掩码：保留前 2 与后 2 字符，中间以 *** 代替；过短则全部掩码。 */
export function maskSample(text: string): string {
  if (text.length <= 4) return '***'
  return `${text.slice(0, 2)}***${text.slice(-2)}`
}

/**
 * 已编译正则缓存（pattern+flags → RegExp）。
 * DLP 在每次 API 调用前都会执行扫描，规则集稳定时避免重复编译；
 * 容量上限防止自定义规则无限增长。
 */
const compiledCache = new Map<string, RegExp>()
const COMPILED_CACHE_MAX = 128

/** 编译规则为正则（带缓存）；非法正则抛错。 */
function compileRule(rule: DlpRule): RegExp {
  // 规则 pattern 支持 (?i) 前缀表示忽略大小写（转换为 i 标志）。
  let source = rule.pattern
  let flags = 'g'
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    flags += 'i'
  }
  const cacheKey = `${flags}:${source}`
  const cached = compiledCache.get(cacheKey)
  if (cached) {
    // 复用前重置 lastIndex（g 标志正则有状态，跨调用必须归零）。
    cached.lastIndex = 0
    return cached
  }
  const compiled = new RegExp(source, flags)
  if (compiledCache.size >= COMPILED_CACHE_MAX) compiledCache.clear()
  compiledCache.set(cacheKey, compiled)
  return compiled
}

/** 扫描文本，返回全部命中（片段已掩码）。 */
export function scanText(text: string, rules: readonly DlpRule[]): DlpFinding[] {
  const findings: DlpFinding[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    let regex: RegExp
    try {
      regex = compileRule(rule)
    } catch {
      continue // 非法正则跳过（保存时已校验，此处为兜底）。
    }
    let count = 0
    let sample = ''
    for (const match of text.matchAll(regex)) {
      count += 1
      if (!sample && match[0]) sample = maskSample(match[0])
      if (count >= MAX_FINDINGS_PER_RULE) break
    }
    if (count > 0) {
      findings.push({ ruleId: rule.id, ruleName: rule.name, sample, count })
    }
  }
  return findings
}

/** 脱敏：将命中片段替换为 [已脱敏:规则名]。 */
export function redactText(text: string, rules: readonly DlpRule[]): string {
  let result = text
  for (const rule of rules) {
    if (!rule.enabled) continue
    let regex: RegExp
    try {
      regex = compileRule(rule)
    } catch {
      continue
    }
    result = result.replace(regex, `[已脱敏:${rule.name}]`)
  }
  return result
}

/** 校验自定义正则是否可编译。 */
export function validatePattern(pattern: string): string | undefined {
  try {
    let source = pattern
    if (source.startsWith('(?i)')) source = source.slice(4)
    new RegExp(source)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : '正则表达式非法'
  }
}
