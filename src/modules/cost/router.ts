/**
 * 模型路由：按任务提示词选择简单/复杂模型，从源头降低成本。
 *
 * 判定优先级：
 * 1. 自定义规则（customRules）：pattern 作子串或正则匹配；
 * 2. 关键词启发式：简单类关键词 → simpleModel；复杂类关键词 → complexModel；
 * 3. 缺省：simpleModel。
 *
 * ReDoS 防护：用户自定义 pattern 在保存入口（/cost/settings）即预编译校验，
 * 编译失败拒绝保存（400）；语法合法但“星高”> MAX_STAR_HEIGHT 的模式
 * （如 (a+)+，嵌套无界量词在部分输入上回溯指数爆炸）同样拒绝保存；
 * 规则数 ≤ MAX_CUSTOM_RULES、pattern 长度 ≤ MAX_RULE_PATTERN_LENGTH；
 * 运行期正则经 ModelRouter 内部缓存预编译复用，不在热路径重复
 * new RegExp，且对绕过保存入口的规则来源做同样的星高兜底拒绝，
 * 并对正则测试输入长度设上界（MAX_REGEX_TEST_INPUT），为已接受
 * 模式的最坏回溯工作量封顶。
 */
import type { CostCustomRule, CostSettings } from './settings.js'

/** 自定义路由规则数量上限（保存入口校验）。 */
export const MAX_CUSTOM_RULES = 20

/** 自定义路由规则 pattern 最大长度（字符，保存入口校验）。 */
export const MAX_RULE_PATTERN_LENGTH = 200

/**
 * 允许的最大正则“星高”（无界量词嵌套深度）。
 * 星高 >1 的模式（如 (a+)+）在特定输入上回溯工作量随输入长度
 * 指数增长（ReDoS），保存入口与运行期双双拒绝。
 */
export const MAX_STAR_HEIGHT = 1

/** 运行期正则测试的输入长度上限（字符）：为已接受模式的最坏情况封顶。 */
export const MAX_REGEX_TEST_INPUT = 10_000

/** 路由判定结果。 */
export interface RouteDecision {
  /** 应使用的模型名。 */
  model: string
  /** 判定原因（供日志与诊断展示）。 */
  reason: string
}

/** 携带预编译正则的路由规则对象。 */
export interface CompiledCustomRule {
  pattern: string
  model: string
  /** 预编译的正则（大小写不敏感）。 */
  regex: RegExp
}

/**
 * 批量预编译自定义路由规则：为每条规则携带编译好的正则。
 * @throws SyntaxError 任一 pattern 不是合法正则时（调用方应拒绝保存并返回 400）。
 * @throws Error 任一 pattern 星高超过 MAX_STAR_HEIGHT（合法但存在 ReDoS 风险）。
 */
export function compileCustomRules(rules: readonly CostCustomRule[]): CompiledCustomRule[] {
  return rules.map((rule) => {
    const regex = new RegExp(rule.pattern, 'i')
    assertSafeStarHeight(rule.pattern)
    return { pattern: rule.pattern, model: rule.model, regex }
  })
}

/**
 * 计算正则的“星高”（无界量词嵌套深度）：只统计无界量词
 * （*、+、?、{n,}）；有界 {n} / {n,m} 重复次数有限，不抬升星高。
 * 跳过转义、字符类与组开场记号（(?:  (?=  (?!  (?<=  (?<name> 等），
 * 防止把组开场中的 ? 误判为量词；量词后的惰性修饰 ?（如 a*?）随量词
 * 一并吞掉。此为 safe-regex 一类的保守静态分析：可能误拒少数安全
 * 模式，但绝不放行已知指数回溯结构。
 */
function starHeight(pattern: string): number {
  // 栈：每层括号内已见量化单元的最大星高；栈底为全局结果。
  const stack: number[] = [0]
  // 最近一个可量化单元（字符/类/组整体）的星高。
  let lastUnitHeight = 0
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '\\') {
      i += 2
      lastUnitHeight = 0
      continue
    }
    if (ch === '[') {
      i += 1
      if (pattern[i] === '^') i += 1
      if (pattern[i] === ']') i += 1 // 紧随 [ 或 [^ 的 ] 是字面量成员
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 1
        i += 1
      }
      i += 1
      lastUnitHeight = 0
      continue
    }
    if (ch === '(') {
      i += 1
      // 组开场修饰：(?:  (?=  (?!  (?<=  (?<!  (?<name>  （旧式 (?P<name> 的 P 归入组名扫描）。
      if (pattern[i] === '?') {
        i += 1
        if (pattern[i] === '<') {
          i += 1
          if (pattern[i] === '=' || pattern[i] === '!') i += 1
          else {
            while (i < pattern.length && pattern[i] !== '>') i += 1
            if (pattern[i] === '>') i += 1
          }
        } else if (pattern[i] === ':' || pattern[i] === '=' || pattern[i] === '!') {
          i += 1
        }
      }
      stack.push(0)
      lastUnitHeight = 0
      continue
    }
    if (ch === ')') {
      const inner = stack.pop() ?? 0
      lastUnitHeight = inner // 组作为整体单元，继承内容最大星高
      i += 1
      continue
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      applyQuantifier(lastUnitHeight, stack)
      lastUnitHeight += 1 // (a+)*：量化后的单元可再被量化
      i += 1
      if (pattern[i] === '?') i += 1 // 惰性修饰
      continue
    }
    if (ch === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i))
      if (m) {
        const unbounded = m[0].endsWith(',}')
        // {n,}（无界）抬升星高；{n} / {n,m}（有界）不抬升。
        if (unbounded) {
          applyQuantifier(lastUnitHeight, stack)
          lastUnitHeight += 1
        }
        i += m[0].length
        if (pattern[i] === '?') i += 1 // 惰性修饰
        continue
      }
      // 非量词形式的 { 按字面量处理（语法问题由 new RegExp 编译另行报错）。
      lastUnitHeight = 0
      i += 1
      continue
    }
    // 普通字符、锚点、| 等原子。
    lastUnitHeight = 0
    i += 1
  }
  return stack[0]!
}

/** 量化单元抬升所在层的最大星高记录。 */
function applyQuantifier(unitHeight: number, stack: number[]): void {
  const top = stack.length - 1
  const height = unitHeight + 1
  if (height > stack[top]!) stack[top] = height
}

/** 断言星高在安全上限内，超限抛错（保存入口 400 / 运行期按未命中处理）。 */
function assertSafeStarHeight(pattern: string): void {
  if (starHeight(pattern) > MAX_STAR_HEIGHT) {
    throw new Error(
      `pattern 存在嵌套无界量词（星高 >${MAX_STAR_HEIGHT}），有灾难性回溯（ReDoS）风险：${pattern}`,
    )
  }
}

/** 简单任务关键词（小写，英文匹配大小写不敏感）。 */
const SIMPLE_KEYWORDS: readonly string[] = [
  '翻译',
  '摘要',
  '总结',
  '润色',
  '改写',
  'translate',
  'summarize',
  'polish',
  'rewrite',
]

/** 复杂任务关键词（小写，英文匹配大小写不敏感）。 */
const COMPLEX_KEYWORDS: readonly string[] = [
  '代码',
  'code',
  '实现',
  '重构',
  'debug',
  '推理',
  '证明',
  '数学',
  '算法',
  '架构',
  'reason',
]

/** 正则编译缓存条目上限：超限整体清空重建，防止无界增长。 */
const REGEX_CACHE_LIMIT = 64

/** 模型路由器（规则正则预编译缓存于实例内部）。 */
export class ModelRouter {
  /** 预编译正则缓存：pattern → 编译好的 RegExp，热路径不重复 new RegExp。 */
  private readonly regexCache = new Map<string, RegExp>()

  /**
   * 解析应使用的模型。
   * @param taskHint 调用方给出的任务提示词（可缺省）。
   * @param settings 当前成本设置（提供模型名与自定义规则）。
   * @returns 模型与判定原因。
   */
  resolve(taskHint: string | undefined, settings: CostSettings): RouteDecision {
    const hint = (taskHint ?? '').trim()
    if (!hint) {
      return { model: settings.simpleModel, reason: '无任务提示，缺省使用简单模型' }
    }
    // 1. 自定义规则优先。
    for (const rule of settings.customRules) {
      const pattern = rule.pattern.trim()
      if (pattern && this.matchPattern(hint, pattern)) {
        return { model: rule.model, reason: `自定义规则命中：${pattern}` }
      }
    }
    // 2. 关键词启发式（先简单类，后复杂类）。
    const lowered = hint.toLowerCase()
    for (const keyword of SIMPLE_KEYWORDS) {
      if (lowered.includes(keyword)) {
        return { model: settings.simpleModel, reason: `简单任务关键词命中：${keyword}` }
      }
    }
    for (const keyword of COMPLEX_KEYWORDS) {
      if (lowered.includes(keyword)) {
        return { model: settings.complexModel, reason: `复杂任务关键词命中：${keyword}` }
      }
    }
    // 3. 缺省简单模型。
    return { model: settings.simpleModel, reason: '未命中关键词，缺省使用简单模型' }
  }

  /**
   * pattern 是否命中 hint：先大小写不敏感子串匹配，
   * 再用缓存的预编译正则（大小写不敏感）匹配；非法正则视为未命中
   * （保存入口已校验，此处为绕过入口的规则来源兜底）。正则测试的
   * 输入截断至 MAX_REGEX_TEST_INPUT：为已接受模式的回溯工作量封顶
   * （taskHint 远短于此上限，截断仅在异常超长输入时生效）。
   */
  private matchPattern(hint: string, pattern: string): boolean {
    if (hint.toLowerCase().includes(pattern.toLowerCase())) return true
    const regex = this.compilePattern(pattern)
    if (regex === undefined) return false
    const subject =
      hint.length > MAX_REGEX_TEST_INPUT ? hint.slice(0, MAX_REGEX_TEST_INPUT) : hint
    return regex.test(subject)
  }

  /**
   * 取或编译 pattern 对应的正则并缓存；编译失败或星高超限
   * （ReDoS 兜底，与保存入口同规则）返回 undefined。
   */
  private compilePattern(pattern: string): RegExp | undefined {
    const cached = this.regexCache.get(pattern)
    if (cached !== undefined) return cached
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
      assertSafeStarHeight(pattern)
    } catch {
      return undefined
    }
    if (this.regexCache.size >= REGEX_CACHE_LIMIT) this.regexCache.clear()
    this.regexCache.set(pattern, regex)
    return regex
  }
}
