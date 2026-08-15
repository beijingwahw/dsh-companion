/**
 * 模块 F：结构化输出校验器（F4）。
 *
 * 轻量 JSON Schema 校验（子集：type/required/properties/items/enum/
 * minimum/maximum/minLength/maxLength/pattern/additionalProperties），
 * 不引入第三方依赖。校验失败时返回具体字段路径，供 UI 高亮标注。
 */

/** 单个校验错误。 */
export interface SchemaViolation {
  /** 字段路径（如 `user.address.city`；根为 ``）。 */
  readonly path: string
  readonly message: string
}

/** 校验值是否为有限数字。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Schema pattern 正则缓存（批量校验大数组时避免逐元素重复编译）。 */
const patternCache = new Map<string, RegExp | null>()
const PATTERN_CACHE_MAX = 64

/** 编译 schema pattern；非法返回 null（视为跳过该约束）。 */
function compilePattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern)
  if (cached !== undefined) return cached
  let compiled: RegExp | null
  try {
    compiled = new RegExp(pattern)
  } catch {
    compiled = null
  }
  if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.clear()
  patternCache.set(pattern, compiled)
  return compiled
}

/** 校验单个值的类型（返回错误消息，合法返回 undefined）。 */
function checkType(value: unknown, type: unknown, path: string): SchemaViolation | undefined {
  if (type === undefined) return undefined
  const types = Array.isArray(type) ? type : [type]
  const matches = types.some((t) => {
    switch (t) {
      case 'string':
        return typeof value === 'string'
      case 'number':
        return isFiniteNumber(value)
      case 'integer':
        return isFiniteNumber(value) && Number.isInteger(value)
      case 'boolean':
        return typeof value === 'boolean'
      case 'array':
        return Array.isArray(value)
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'null':
        return value === null
      default:
        return false
    }
  })
  if (matches) return undefined
  return { path, message: `期望类型 ${types.join('|')}，实际为 ${describeType(value)}` }
}

/** 描述值的实际类型（用于错误消息）。 */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 校验值是否符合 Schema（递归）。
 * @param value 待校验值（通常是 JSON.parse 后的结果）。
 * @param schema JSON Schema 子集。
 * @param path 当前路径（内部递归用）。
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path: string = '',
): SchemaViolation[] {
  const violations: SchemaViolation[] = []
  if (typeof schema !== 'object' || schema === null) return violations
  const s = schema as Record<string, unknown>

  const typeViolation = checkType(value, s.type, path)
  if (typeViolation) {
    violations.push(typeViolation)
    return violations
  }

  // enum
  if (Array.isArray(s.enum)) {
    const allowed = s.enum as unknown[]
    if (!allowed.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
      violations.push({ path, message: `值必须是枚举之一：${JSON.stringify(allowed)}` })
    }
  }

  // 数字约束
  if (isFiniteNumber(value)) {
    if (isFiniteNumber(s.minimum) && value < s.minimum) {
      violations.push({ path, message: `不能小于 ${s.minimum}` })
    }
    if (isFiniteNumber(s.maximum) && value > s.maximum) {
      violations.push({ path, message: `不能大于 ${s.maximum}` })
    }
  }

  // 字符串约束
  if (typeof value === 'string') {
    if (isFiniteNumber(s.minLength) && value.length < s.minLength) {
      violations.push({ path, message: `长度不能小于 ${s.minLength}` })
    }
    if (isFiniteNumber(s.maxLength) && value.length > s.maxLength) {
      violations.push({ path, message: `长度不能大于 ${s.maxLength}` })
    }
    if (typeof s.pattern === 'string') {
      const regex = compilePattern(s.pattern)
      if (regex && !regex.test(value)) {
        violations.push({ path, message: `不匹配模式 ${s.pattern}` })
      }
    }
  }

  // 对象约束
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (Array.isArray(s.required)) {
      for (const key of s.required as unknown[]) {
        if (typeof key === 'string' && !(key in record)) {
          violations.push({ path: joinPath(path, key), message: '缺少必填字段' })
        }
      }
    }
    const properties = typeof s.properties === 'object' && s.properties !== null
      ? (s.properties as Record<string, unknown>)
      : {}
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record) {
        violations.push(...validateAgainstSchema(record[key], propSchema, joinPath(path, key)))
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          violations.push({ path: joinPath(path, key), message: '不允许多余字段' })
        }
      }
    }
  }

  // 数组约束
  if (Array.isArray(value)) {
    if (isFiniteNumber(s.minItems) && value.length < s.minItems) {
      violations.push({ path, message: `元素数量不能少于 ${s.minItems}` })
    }
    if (isFiniteNumber(s.maxItems) && value.length > s.maxItems) {
      violations.push({ path, message: `元素数量不能多于 ${s.maxItems}` })
    }
    if (s.items !== undefined) {
      value.forEach((item, index) => {
        violations.push(...validateAgainstSchema(item, s.items, joinPath(path, String(index))))
      })
    }
  }

  return violations
}

/** 拼接字段路径。 */
function joinPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`
}

/** 解析并校验 Schema 自身是否可用（对象即可，宽松处理）。 */
export function parseSchema(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('JSON Schema 必须是对象')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(`JSON Schema 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  throw new Error('JSON Schema 必须是 JSON 对象')
}

/**
 * 从模型输出文本中提取 JSON（容忍 ```json 代码块包裹与前后杂散文本）。
 * 解析失败返回 undefined。
 */
export function extractJsonFromOutput(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)
  const candidate = fenced ? fenced[1] : output
  const trimmed = candidate.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // 尝试截取首个 { 到末尾 } 的子串（模型可能在 JSON 前后附加说明）。
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}
