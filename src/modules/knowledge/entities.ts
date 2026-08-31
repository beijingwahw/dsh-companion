/**
 * 对话知识资产核心（轴线 4）：从会话转录中抽取结构化实体。
 *
 * 纯函数、零 LLM 调用、零网络请求——与轴线 1 同一条设计红线：
 * 所有计算本地完成，隐私不出域。
 *
 * 抽取目标（六类实体，按信号强度降序）：
 * - **command**：命令行（行首动词表命中，如 `git commit`、`npm install`）；
 * - **path**：文件路径（含斜杠 + 扩展名，如 `src/core/service.ts`）；
 * - **tech**：技术专名（全大写缩写如 HTTP/JSON；内部大写的驼峰如
 *   JavaScript/OpenAI；出现 ≥2 次的首字母大写词如 DeepSeek）；
 * - **code**：代码标识符（小写驼峰、snake_case、反引号包裹的行内代码、
 *   点号链式标识符如 `ctx.effect`）；
 * - **term**：中文术语（书名号/引号/方头括号包裹，如「上下文工程」）；
 * - **version**：版本号（v1.2.3 / 2.0）。
 *
 * 抽取采用"有序消费"策略：URL 先整体让位（避免被 path/code 规则误吞），
 * 各规则按优先级匹配后标记消费区间，后续规则不再重复提取同一段文本；
 * 同一名称命中多个类型时归并到优先级最高的类型（command > path >
 * tech > code > term > version）。
 *
 * 显著性打分：freq × 类型权重。类型权重反映先验信号强度——一条命令
 * 的知识密度高于一个普通标识符。全局稀有度（IDF）由调用方结合
 * 实体倒排索引补充计算，本模块不感知语料级统计。
 */

/** 实体类型（按优先级降序排列，索引即优先级）。 */
export type EntityType = 'command' | 'path' | 'tech' | 'code' | 'term' | 'version'

/** 全部实体类型（有序）。 */
export const ENTITY_TYPES: readonly EntityType[] = [
  'command',
  'path',
  'tech',
  'code',
  'term',
  'version',
]

/** 类型优先级表（数值越小优先级越高）。 */
const TYPE_PRIORITY: Readonly<Record<EntityType, number>> = {
  command: 0,
  path: 1,
  tech: 2,
  code: 3,
  term: 4,
  version: 5,
}

/** 类型显著性权重（打分用）。 */
const TYPE_WEIGHT: Readonly<Record<EntityType, number>> = {
  command: 3,
  path: 2.5,
  tech: 2,
  code: 1.5,
  term: 1.5,
  version: 0.6,
}

/** 单会话抽取的实体条数上限（按分数截取，防止超长会话撑爆索引）。 */
const MAX_ENTITIES_PER_SESSION = 120

/** 实体名称最大长度（超长截断）。 */
const MAX_NAME_LENGTH = 40

/** 命令行实体允许的最大词数（动词 + 最多 2 个参数词）。 */
const MAX_COMMAND_WORDS = 3

/** 命令行动词表（小写；行首命中才算命令，避免中文行内误报）。 */
const COMMAND_VERBS: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'git', 'docker', 'kubectl', 'helm',
  'curl', 'wget', 'python', 'python3', 'pip', 'pip3', 'uv', 'node', 'tsc',
  'cargo', 'rustc', 'go', 'make', 'cmake', 'brew', 'apt', 'apt-get',
  'conda', 'ssh', 'scp', 'rsync', 'tar', 'gzip', 'zip', 'unzip',
  'cd', 'ls', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'head',
  'tail', 'grep', 'rg', 'sed', 'awk', 'find', 'chmod', 'chown', 'ps',
  'kill', 'top', 'df', 'du', 'env', 'export', 'source', 'sudo',
  'systemctl', 'service', 'nginx', 'redis-cli', 'mysql', 'psql', 'sqlite3',
  'mongosh', 'jq', 'xargs', 'tee', 'diff', 'patch', 'ln', 'touch', 'which',
])

/** 全大写缩写的噪声表（TODO/NOTE 这类注释标记不是技术实体）。 */
const ACRONYM_STOPWORDS: ReadonlySet<string> = new Set([
  'TODO', 'FIXME', 'NOTE', 'BUG', 'HACK', 'XXX', 'OK', 'YES', 'NO',
  'AND', 'THE', 'FOR', 'YOU', 'NOT', 'CAN', 'ALL', 'ANY', 'NEW', 'OLD',
  'USE', 'SEE', 'E.G', 'IE', 'ETC', 'AI', 'ME', 'MY', 'WE', 'IT', 'IS',
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII',
])

/** 首字母大写单词的噪声表（英文句首虚词的高频假阳性）。 */
const CAPITALIZED_STOPWORDS: ReadonlySet<string> = new Set([
  'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'Them',
  'When', 'What', 'Where', 'Which', 'While', 'Who', 'Why', 'How',
  'Also', 'But', 'And', 'For', 'You', 'Your', 'Can', 'Will', 'Would',
  'Let', 'Yes', 'No', 'Please', 'Thanks', 'Thank', 'Here', 'Some',
  'Just', 'Like', 'With', 'From', 'Have', 'Has', 'Been', 'Were',
  'The', 'Was', 'Are', 'Its', 'His', 'Her', 'Our', 'Their', 'If',
  'In', 'On', 'At', 'To', 'Of', 'By', 'Or', 'As', 'Is', 'It', 'We',
  'He', 'She', 'So', 'Do', 'Does', 'Did', 'Not', 'Now', 'Next', 'First',
  'Second', 'Third', 'Finally', 'However', 'Therefore', 'Meanwhile',
  'Example', 'Examples', 'Note', 'Notes', 'Warning', 'Summary', 'Overview',
])

/** 中文术语的停用表（引号内的常见非术语）。 */
const TERM_STOPWORDS: ReadonlySet<string> = new Set([
  '这样', '那样', '这个', '那个', '什么', '怎么', '如何', '为什么',
  '可以', '不能', '需要', '应该', '可能', '已经', '还是', '或者',
  '一下', '一些', '有点', '请问', '谢谢', '好的', '是的', '不是',
])

/** 抽取出的单个实体（未含全局统计）。 */
export interface ExtractedEntity {
  /** 展示名（众数原形，保留大小写）。 */
  name: string
  type: EntityType
  /** 会话内出现次数。 */
  freq: number
  /** 显著性分 = freq × 类型权重。 */
  score: number
  /** 倒排索引规范化键（type:小写名；跨会话聚合的稳定标识）。 */
  key: string
}

/** 实体在倒排索引中的规范化键（type 与 name 冒号分隔；name 可含任意字符）。 */
export function entityKey(type: EntityType, name: string): string {
  return `${type}:${name}`
}

/** 从倒排键解析回 (type, name)；非法键返回 undefined。 */
export function parseEntityKey(key: string): { type: EntityType; name: string } | undefined {
  const sep = key.indexOf(':')
  if (sep <= 0) return undefined
  const type = key.slice(0, sep) as EntityType
  if (!(ENTITY_TYPES as readonly string[]).includes(type)) return undefined
  const name = key.slice(sep + 1)
  if (name.length === 0) return undefined
  return { type, name }
}

/**
 * 从会话转录文本抽取实体。
 * @param text 会话转录（formatTranscript 输出；任意中英混合）。
 * @returns 按分数降序的实体列表（≤ MAX_ENTITIES_PER_SESSION 条）。
 */
export function extractEntities(text: string): ExtractedEntity[] {
  // 0) URL 整体让位：替换为空白，避免 URL 被拆成 path/code 实体。
  const sanitized = text.replace(/https?:\/\/[^\s<>"'`]+/g, ' ')

  /** 消费标记：matchSpan 内的字符已被高优先级规则提取。 */
  const consumed = new Uint8Array(sanitized.length)
  /** 名称（小写归一键）→ { type, freq, display }：display 保留最常见原形。 */
  const found = new Map<string, { type: EntityType; freq: number; display: Map<string, number> }>()

  /** 尝试记录一个实体命中（区间未被消费时）。 */
  const record = (start: number, end: number, rawName: string, type: EntityType): void => {
    if (rawName.length < 2 || rawName.length > MAX_NAME_LENGTH) return
    for (let i = start; i < end; i += 1) {
      if (consumed[i]) return
    }
    for (let i = start; i < end; i += 1) consumed[i] = 1
    // 归一键：小写化统一大小写变体；display 保留原形计数（取众数）。
    const key = entityKey(type, rawName.toLowerCase())
    const entry = found.get(key)
    if (entry) {
      entry.freq += 1
      entry.display.set(rawName, (entry.display.get(rawName) ?? 0) + 1)
    } else {
      const display = new Map<string, number>()
      display.set(rawName, 1)
      found.set(key, { type, freq: 1, display })
    }
  }

  // 1) 命令行：行首（允许 $ > # 提示符前缀）动词表命中。
  for (const match of sanitized.matchAll(/^[ \t]*(?:[$>#][ \t]*)?([a-z][\w.:-]*)((?:[ \t]+[\w@:/.=+-]+){0,2})/gm)) {
    const verb = match[1]
    if (!COMMAND_VERBS.has(verb)) continue
    const args = (match[2] ?? '')
      .split(/[ \t]+/)
      .filter((word) => word.length > 0)
      .slice(0, MAX_COMMAND_WORDS - 1)
    const name = [verb, ...args].join(' ').slice(0, MAX_NAME_LENGTH)
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, name, 'command')
  }

  // 2) 文件路径：至少一个斜杠 + 扩展名（src/core/service.ts）。
  for (const match of sanitized.matchAll(/[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z]{1,10}/g)) {
    const raw = match[0]
    // 排除纯点号段（如 a/../b 的中间态）与无字母路径。
    if (!/[A-Za-z]/.test(raw)) continue
    record(match.index ?? 0, (match.index ?? 0) + raw.length, raw, 'path')
  }

  // 3a) 全大写缩写（HTTP、JSON、K8S）。
  for (const match of sanitized.matchAll(/\b[A-Z][A-Z0-9]{1,7}\b/g)) {
    if (ACRONYM_STOPWORDS.has(match[0])) continue
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'tech')
  }

  // 3b) 内部大写驼峰专名（JavaScript、OpenAI、GitHub）。
  for (const match of sanitized.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) {
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'tech')
  }

  // 3c) 首字母大写单词（DeepSeek、Kubernetes）——先收集候选与频次，
  //     频次 ≥2 才采纳（一次性句首大写多为假阳性）。
  const capitalized = new Map<string, { count: number; indices: Array<[number, number]> }>()
  for (const match of sanitized.matchAll(/\b[A-Z][a-z]{2,15}\b/g)) {
    if (CAPITALIZED_STOPWORDS.has(match[0])) continue
    const entry = capitalized.get(match[0]) ?? { count: 0, indices: [] }
    entry.count += 1
    entry.indices.push([match.index ?? 0, (match.index ?? 0) + match[0].length])
    capitalized.set(match[0], entry)
  }
  for (const [word, entry] of capitalized) {
    if (entry.count < 2) continue
    for (const [start, end] of entry.indices) record(start, end, word, 'tech')
  }

  // 4a) 反引号行内代码（`ctx.effect`）。
  const inlineCodePattern = new RegExp("`([^`\\n]{2," + MAX_NAME_LENGTH + "})`", 'g')
  for (const match of sanitized.matchAll(inlineCodePattern)) {
    const inner = match[1].trim()
    if (inner.length === 0 || /\s{3,}/.test(inner)) continue
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, inner, 'code')
  }

  // 4b) 小写驼峰标识符（sessionQuery、hybridSearch）。
  for (const match of sanitized.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,3}\b/g)) {
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'code')
  }

  // 4c) snake_case 标识符（parse_time_param、usage_daily）。
  for (const match of sanitized.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,3}\b/g)) {
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'code')
  }

  // 4d) 点号链式标识符（ctx.effect、companion.http）。
  for (const match of sanitized.matchAll(/\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}\b/g)) {
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'code')
  }

  // 5) 中文术语：中文引号包裹（「上下文工程」）。
  //    不匹配英文直引号——JSON 字段名的引号会产生大量假阳性。
  for (const match of sanitized.matchAll(/[「『]([^」』]{2,20})[」』]/g)) {
    const inner = match[1].trim()
    if (TERM_STOPWORDS.has(inner)) continue
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, inner, 'term')
  }
  for (const match of sanitized.matchAll(/【([^】]{2,20})】/g)) {
    const inner = match[1].trim()
    if (TERM_STOPWORDS.has(inner)) continue
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, inner, 'term')
  }

  // 6) 版本号（v1.2.3、2.0、18.04）。
  for (const match of sanitized.matchAll(/\bv?\d+\.\d+(?:\.\d+){0,2}\b/g)) {
    record(match.index ?? 0, (match.index ?? 0) + match[0].length, match[0], 'version')
  }

  // 归并与输出：键保持 type:小写名（大小写变体已在 found 阶段归一）；
  // 跨类型同名归并到高优先级类型，频次相加；display 取众数原形。
  const merged = new Map<string, { type: EntityType; lower: string; display: string; freq: number }>()
  for (const [key, entry] of found) {
    const parsed = parseEntityKey(key)
    if (parsed === undefined) continue
    // 众数原形作为展示名（出现最多的原形；平手取较短者）。
    let display = parsed.name
    let bestCount = -1
    for (const [form, count] of entry.display) {
      if (count > bestCount || (count === bestCount && form.length < display.length)) {
        display = form
        bestCount = count
      }
    }
    merged.set(key, { type: parsed.type, lower: parsed.name, display, freq: entry.freq })
  }

  // 跨类型同名归并：低优先级条目并入高优先级条目后删除。
  for (const [key, entity] of [...merged.entries()]) {
    const canonicalKey = findCanonicalKey(merged, entity.lower)
    if (canonicalKey === undefined || canonicalKey === key) continue
    const canonical = merged.get(canonicalKey)
    if (canonical === undefined) continue
    canonical.freq += entity.freq
    merged.delete(key)
  }

  const entities: ExtractedEntity[] = []
  for (const [key, entity] of merged) {
    entities.push({
      name: entity.display,
      type: entity.type,
      freq: entity.freq,
      score: entity.freq * TYPE_WEIGHT[entity.type],
      key,
    })
  }
  entities.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return entities.slice(0, MAX_ENTITIES_PER_SESSION)
}

/** 在归并表中找同名（小写）里类型优先级最高的条目键。 */
function findCanonicalKey(
  merged: ReadonlyMap<string, { type: EntityType; lower: string }>,
  lowerName: string,
): string | undefined {
  let bestKey: string | undefined
  let bestPriority = Number.POSITIVE_INFINITY
  for (const [key, entity] of merged) {
    if (entity.lower !== lowerName) continue
    const priority = TYPE_PRIORITY[entity.type]
    if (priority < bestPriority) {
      bestKey = key
      bestPriority = priority
    }
  }
  return bestKey
}

/** 实体的类型权重（打分与展示徽章共用）。 */
export function entityTypeWeight(type: EntityType): number {
  return TYPE_WEIGHT[type]
}
