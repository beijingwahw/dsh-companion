/**
 * 问题→解决片段提取（轴线 21/22 的共享基座）：对话里的「知识时刻」。
 *
 * 设计动机：会话转录的绝大部分是过程噪音，真正值得长期持有的
 * 是「问题 → 解法」对——它们是可迁移的结构化经验。本模块把
 * 转录压成片段序列，每个片段自带**结构形状**（约束类别 × 解法
 * 类别），供两条下游轴线消费：
 *
 * - 轴线 21（间隔重复）：片段即复习卡片——检索式练习的素材；
 * - 轴线 22（类比检索）：片段形状即匹配键——跨域同构发现。
 *
 * 提取策略（行级配对，纯本地规则）：
 * - **问题行**：含问题关键词（报错/失败/超时/error…）；
 * - **解法行**：含解法关键词（解决了/原来是/改成/fixed…）；
 * - **配对**：每个问题行向后找窗口内（8 行）最近的未占用解法行；
 * - **形状**：约束类别（性能/网络/配置/版本/依赖/数据/并发/认证/
 *   构建/接口）× 解法类别（改配置/换依赖/重构/绕过/顿悟）。
 *
 * 一个片段的形状相同而主题不同——这正是类比检索要找的同构。
 */

/** 约束类别（问题的结构属性）。 */
export type ConstraintKind =
  | 'performance'
  | 'network'
  | 'config'
  | 'version'
  | 'dependency'
  | 'data'
  | 'concurrency'
  | 'auth'
  | 'build'
  | 'api'

/** 解法类别（解法的结构属性）。 */
export type ResolutionKind =
  | 'config-fix'
  | 'dependency-change'
  | 'refactor'
  | 'workaround'
  | 'understanding'

/** 片段结构形状（类比匹配的键）。 */
export interface EpisodeShape {
  /** 约束类别标签（去重排序）。 */
  readonly constraints: readonly ConstraintKind[]
  /** 解法类别标签（去重排序）。 */
  readonly resolutions: readonly ResolutionKind[]
}

/** 单个问题→解决片段。 */
export interface Episode {
  /** 稳定内容 id（模块层拼上 sessionId 后全局唯一）。 */
  readonly id: string
  /** 问题描述行（截断 200 字符）。 */
  readonly problem: string
  /** 解法描述行（截断 200 字符）。 */
  readonly solution: string
  /** 结构形状。 */
  readonly shape: EpisodeShape
}

/** 单会话片段记录（存储形状；key = sessionId）。 */
export interface EpisodeRecord {
  /** 会话创建时间（复习调度的起点）。 */
  readonly createdAt: number
  /** 该会话提取出的全部片段。 */
  readonly episodes: readonly Episode[]
}

/** 约束类别关键词表（小写子串匹配）。 */
const CONSTRAINT_KEYWORDS: Readonly<Record<ConstraintKind, readonly string[]>> = {
  performance: ['性能', '变慢', '很慢', '太慢', '延迟', '内存', '占用', '卡顿', '卡死', 'performance', 'slow', 'memory', 'latency'],
  network: ['网络', '连接不上', '连不上', '超时', 'dns', '代理', '端口', 'network', 'connection', 'timeout', 'proxy'],
  config: ['配置', '环境变量', '参数', 'config', 'env', 'setting', 'yaml', 'json 配置'],
  version: ['版本', '兼容', '升级后', '降级', 'version', 'compat', 'compatibility'],
  dependency: ['依赖', '装不上', '安装失败', 'npm', 'pnpm', 'yarn', 'pip', 'dependency', 'package', '模块找不到', 'module not found'],
  data: ['数据丢失', '数据', '迁移', '数据库', '查询', 'database', 'migration', 'sql', 'schema'],
  concurrency: ['并发', '竞态', '死锁', '锁', '线程', 'race', 'lock', 'deadlock', 'async', 'await'],
  auth: ['认证', '权限', '令牌', '登录', 'token', 'auth', 'permission', '401', '403', 'unauthorized'],
  build: ['编译', '构建', '打包', 'build', 'compile', 'bundle', 'webpack', 'tsc'],
  api: ['接口', '调用', '返回', 'api', 'endpoint', 'request', 'response', '请求'],
}

/** 解法类别关键词表。 */
const RESOLUTION_KEYWORDS: Readonly<Record<ResolutionKind, readonly string[]>> = {
  'config-fix': ['配置', '环境变量', '参数改成', '设置成', '加上', '改成', 'config', 'env', 'flag'],
  'dependency-change': ['升级到', '降级到', '安装了', '换了依赖', '删掉依赖', 'upgrade', 'downgrade', 'install'],
  refactor: ['重构', '改写', '重写了', '换了种', '改成手动', 'refactor', 'rewrite'],
  workaround: ['绕过', '先用', '临时', '回退', 'workaround', 'fallback', '先跳过'],
  understanding: ['原来是', '原因是', '根本原因', '原理是', '理解了', '搞清楚', 'turns out', 'root cause', 'because'],
}

/** 问题行关键词。 */
const PROBLEM_KEYWORDS: readonly RegExp[] = [
  /报错|错误|异常|失败|崩[溃了]|挂了/,
  /不工作|不生效|不行|没反应|没效果|不起作用/,
  /超时|超不了时/,
  /error|failed|failure|crash|exception|timeout/i,
  /doesn'?t work|not working|broken/i,
  /\bbug\b/i,
]

/** 解法行关键词。 */
const SOLUTION_KEYWORDS: readonly RegExp[] = [
  /解决|修好|修复了|搞定|成功/,
  /原来是|原因是|根本原因|原理/,
  /改成|换成|加上|设置|配置了|需要先|需要在|只要/,
  /升级到|降级到|安装了|回退到/,
  /solved|fixed|works|resolved|solution|workaround/i,
]

/** 问题行向后配对解法行的窗口（行数）。 */
const PAIR_WINDOW_LINES = 8

/** 单会话片段条数上限。 */
const MAX_EPISODES_PER_SESSION = 10

/** 片段文本截断长度。 */
const EPISODE_TEXT_LIMIT = 200

/** 空形状（无任何类别命中的兜底）。 */
export const EMPTY_SHAPE: EpisodeShape = { constraints: [], resolutions: [] }

/**
 * 从文本提取结构形状：命中的约束类别 × 解法类别。
 * 问题文本与解法文本分别提取后由调用方合并（或直接对整段提取）。
 */
export function extractShape(text: string): EpisodeShape {
  const lower = text.toLowerCase()
  const constraints = (Object.keys(CONSTRAINT_KEYWORDS) as ConstraintKind[]).filter((kind) =>
    CONSTRAINT_KEYWORDS[kind].some((keyword) => lower.includes(keyword)),
  )
  const resolutions = (Object.keys(RESOLUTION_KEYWORDS) as ResolutionKind[]).filter((kind) =>
    RESOLUTION_KEYWORDS[kind].some((keyword) => lower.includes(keyword)),
  )
  return { constraints, resolutions }
}

/**
 * 判定是否问题行（含问题关键词且不像纯解法陈述）。
 * 同时含两类关键词的行按解法行处理（配对阶段向后看）。
 */
function isProblemLine(line: string): boolean {
  if (line.length < 6) return false
  const hasProblem = PROBLEM_KEYWORDS.some((pattern) => pattern.test(line))
  if (!hasProblem) return false
  return !SOLUTION_KEYWORDS.some((pattern) => pattern.test(line))
}

/** 判定是否解法行。 */
function isSolutionLine(line: string): boolean {
  if (line.length < 4) return false
  return SOLUTION_KEYWORDS.some((pattern) => pattern.test(line))
}

/** FNV-1a 字符串哈希（16 进制；片段稳定 id 的内容指纹）。 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 从会话转录提取问题→解决片段。
 *
 * 行级扫描 + 窗口配对：每个问题行消费其后窗口内最近的一个未占用
 * 解法行；未被配对的问题行/解法行静默丢弃（单边信号不成知识）。
 *
 * @param text 会话转录。
 */
export function extractEpisodes(text: string): readonly Episode[] {
  const lines = text.split('\n').map((line) => line.trim())
  const episodes: Episode[] = []
  const usedSolutionIndexes = new Set<number>()
  for (let i = 0; i < lines.length; i += 1) {
    if (episodes.length >= MAX_EPISODES_PER_SESSION) break
    const line = lines[i]
    if (!isProblemLine(line)) continue
    // 向后窗口内找最近的未占用解法行。
    for (let j = i + 1; j <= Math.min(i + PAIR_WINDOW_LINES, lines.length - 1); j += 1) {
      if (usedSolutionIndexes.has(j)) continue
      if (!isSolutionLine(lines[j])) continue
      usedSolutionIndexes.add(j)
      const problem = line.slice(0, EPISODE_TEXT_LIMIT)
      const solution = lines[j].slice(0, EPISODE_TEXT_LIMIT)
      // 形状：问题行提取约束，解法行提取解法，各自兜底到对方补全。
      const problemShape = extractShape(line)
      const solutionShape = extractShape(lines[j])
      const shape = mergeShape(problemShape, solutionShape)
      episodes.push({
        id: fnv1aHex(`${problem}→${solution}`),
        problem,
        solution,
        shape,
      })
      break
    }
  }
  return episodes
}

/** 合并两个形状（约束取并、解法取并，各自排序去重）。 */
export function mergeShape(a: EpisodeShape, b: EpisodeShape): EpisodeShape {
  return {
    constraints: [...new Set([...a.constraints, ...b.constraints])].sort(),
    resolutions: [...new Set([...a.resolutions, ...b.resolutions])].sort(),
  }
}

/** 存储读出的片段记录净化：非法记录静默丢弃。 */
export function sanitizeEpisodeRecord(raw: unknown): EpisodeRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt <= 0) {
    return undefined
  }
  if (!Array.isArray(record.episodes)) return undefined
  const episodes: Episode[] = []
  for (const item of record.episodes) {
    if (typeof item !== 'object' || item === null) continue
    const episode = item as Record<string, unknown>
    if (typeof episode.id !== 'string' || episode.id.length === 0) continue
    if (typeof episode.problem !== 'string' || episode.problem.length === 0) continue
    if (typeof episode.solution !== 'string' || episode.solution.length === 0) continue
    if (typeof episode.shape !== 'object' || episode.shape === null) continue
    const shape = episode.shape as Record<string, unknown>
    if (!Array.isArray(shape.constraints) || !Array.isArray(shape.resolutions)) continue
    const constraints = shape.constraints.filter(
      (kind): kind is ConstraintKind => typeof kind === 'string' && kind in CONSTRAINT_KEYWORDS,
    )
    const resolutions = shape.resolutions.filter(
      (kind): kind is ResolutionKind => typeof kind === 'string' && kind in RESOLUTION_KEYWORDS,
    )
    episodes.push({
      id: episode.id,
      problem: episode.problem,
      solution: episode.solution,
      shape: { constraints, resolutions },
    })
  }
  // 全部片段非法 → 空记录无持有价值，整体丢弃（与意图记录净化一致）。
  if (episodes.length === 0) return undefined
  return { createdAt: record.createdAt, episodes }
}

/** 全部约束类别（展示顺序）。 */
export const CONSTRAINT_KINDS: readonly ConstraintKind[] = Object.keys(
  CONSTRAINT_KEYWORDS,
) as readonly ConstraintKind[]

/** 全部解法类别（展示顺序）。 */
export const RESOLUTION_KINDS: readonly ResolutionKind[] = Object.keys(
  RESOLUTION_KEYWORDS,
) as readonly ResolutionKind[]
