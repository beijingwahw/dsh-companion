/**
 * 知识考古引擎（轴线 32「板块构造学」）：时间切片回放知识大陆的形成史。
 *
 * 设计动机：轴线 26「知识大陆」回答"我的知识版图**现在**长什么样"——
 * 全量语料一次性 Louvain，得到一张静态地图。但知识是**长出来的**：
 * 三个月前还在密集讨论 docker 网络，后来分裂成 k8s 与 service mesh 两块，
 * 上个月又冒出一块全新的 rust 大陆。轴线 32 回答地图回答不了的问题——
 * "**这块版图是怎么演化的**"：
 *
 * - **时间切片**：会话流按序均分为 W 个「纪元」（index 均分而非按日历
 *   均分——活动稀疏期不会产生只有 1 个会话的空窗口）；
 * - **逐纪元大陆发现**：每个纪元内独立构建实体共现图 + Louvain 社区
 *   发现（复用轴线 26 同源算法，参数一致保证可比性）；
 * - **血脉匹配**：相邻纪元的社区按成员实体键集合算 Jaccard，重叠
 *   ≥ 阈值即建立血脉边；
 * - **板块事件分类**：
 *   - `birth` 新生——某纪元的社区无前置血脉（新知识域形成）；
 *   - `continuation` 延续——一对一血脉（同一块大陆存活到下一纪元）；
 *   - `split` 分裂——一个旧社区的主要成员流向 ≥2 个新社区
 *     （关注点分化，如 docker 网络分化出 k8s service 与 istio）；
 *   - `merge` 合并——≥2 个旧社区的血脉汇入同一新社区
 *     （此前分散的主题收拢成一块大陆）；
 *   - `dissolve` 消亡——某纪元的社区在下一纪元无任何血脉
 *     （知识域沉没：换工作/换技术栈/问题已解决）。
 *
 * 与轴线 30「主题漂移」的分工：漂移在**会话流**上逐会话检测注意力
 * 切换点（BOCPD），考古在**纪元间**检测知识**域**的结构性变迁
 * （社区级 birth/split/merge/dissolve）——漂移看浪，考古看洋流。
 *
 * 纯本地、零 LLM、零网络；纯函数、无状态、确定性。
 */

import { buildEntityGraph, type EntityGraph, type EntityGraphInput } from '../graph/graph.js'
import { detectCommunities } from '../graph/louvain.js'
import { jaccard } from './consolidation.js'

/** 考古输入：单会话的最小投影（实体倒排索引反查，零转录重读）。 */
export interface ArchaeologySession {
  /** 会话 id。 */
  readonly id: string
  /** 会话创建时间（毫秒）。 */
  readonly at: number
  /** 该会话出现的实体键列表（`<type>:<小写名>`；重复自动去重）。 */
  readonly entityKeys: readonly string[]
}

/** 考古参数。 */
export interface ArchaeologyOptions {
  /** 纪元数（时间切片数）；缺省 4，实际取 min(请求值, floor(会话数/2))，下限 2。 */
  readonly windows?: number
  /** 血脉匹配的成员 Jaccard 阈值；缺省 0.3。 */
  readonly lineageThreshold?: number
  /** 参与事件分析的社区最小成员数；缺省 2（单实体社区不构成"大陆"）。 */
  readonly minContinentSize?: number
}

/** 板块事件类型。 */
export type PlateEventKind = 'birth' | 'continuation' | 'split' | 'merge' | 'dissolve'

/** 一次板块事件（相邻纪元间的社区血脉变迁）。 */
export interface PlateEvent {
  readonly kind: PlateEventKind
  /** 源纪元下标（dissolve 为消亡前所在纪元；birth 无源，为 -1）。 */
  readonly fromWindow: number
  /** 目标纪元下标（dissolve 无目标，为 -1）。 */
  readonly toWindow: number
  /** 涉及社区的代表实体（并集按度数近似取头部）。 */
  readonly topEntities: readonly string[]
  /** 血脉强度（成员 Jaccard；split/merge 取最强分支；birth/dissolve 恒 0）。 */
  readonly strength: number
  /** 人话描述。 */
  readonly description: string
}

/** 单个纪元的大陆快照。 */
export interface EraWindow {
  /** 纪元下标（0 起，时间升序）。 */
  readonly index: number
  /** 纪元内会话数。 */
  readonly sessions: number
  /** 纪元起止时间（毫秒；首纪元起点即最早会话时间）。 */
  readonly fromAt: number
  readonly toAt: number
  /** 该纪元实体图规模。 */
  readonly entities: number
  readonly edges: number
  /** 该纪元模块度 Q。 */
  readonly modularity: number
  /** 该纪元的大陆（按成员数降序；含成员键供前端联动）。 */
  readonly continents: ReadonlyArray<{
    readonly id: number
    readonly size: number
    readonly sessionCount: number
    readonly topEntities: readonly string[]
    readonly memberKeys: readonly string[]
  }>
}

/** 考古报告。 */
export interface ArchaeologyReport {
  /** 纪元快照（时间升序；样本不足时为空）。 */
  readonly windows: readonly EraWindow[]
  /** 板块事件（按目标纪元升序）。 */
  readonly events: readonly PlateEvent[]
  /** 事件计数。 */
  readonly stats: {
    readonly windows: number
    readonly births: number
    readonly continuations: number
    readonly splits: number
    readonly merges: number
    readonly dissolves: number
  }
  /** 人话摘要。 */
  readonly summary: string
}

/** 从实体键解出展示名（`<type>:<name>` → name）。 */
function displayName(key: string): string {
  const idx = key.indexOf(':')
  return idx >= 0 ? key.slice(idx + 1) : key
}

/**
 * 单纪元共现图：复用轴线 26 同源的 buildEntityGraph
 * （团展开 + 边权 = 共现会话数，保证跨纪元可比）。
 */
function eraGraph(sessions: readonly ArchaeologySession[]): EntityGraph {
  // 实体键 → 会话 id 集合：从会话正排投影回倒排记录形状。
  const acc = new Map<string, Map<string, number>>()
  for (const session of sessions) {
    for (const key of new Set(session.entityKeys)) {
      const existing = acc.get(key)
      if (existing === undefined) acc.set(key, new Map([[session.id, 1]]))
      else existing.set(session.id, 1)
    }
  }
  const records: EntityGraphInput[] = []
  for (const [key, sessionCounts] of acc) {
    const counts: Record<string, number> = {}
    for (const [sessionId, freq] of sessionCounts) counts[sessionId] = freq
    records.push({
      key,
      name: displayName(key),
      type: key.slice(0, key.indexOf(':')) || '',
      sessions: counts,
    })
  }
  return buildEntityGraph(records)
}

/** 构造主入口：知识考古（板块事件挖掘）。 */
export function excavateKnowledge(
  sessions: readonly ArchaeologySession[],
  options: ArchaeologyOptions = {},
): ArchaeologyReport {
  const lineage = Math.min(0.9, Math.max(0.1, options.lineageThreshold ?? 0.3))
  const minSize = Math.max(1, options.minContinentSize ?? 2)
  const empty: ArchaeologyReport = {
    windows: [],
    events: [],
    stats: { windows: 0, births: 0, continuations: 0, splits: 0, merges: 0, dissolves: 0 },
    summary: '',
  }

  const ordered = [...sessions]
    .filter((s) => s.entityKeys.length > 0)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  if (ordered.length < 4) {
    return {
      ...empty,
      summary: '会话样本不足（< 4 个含实体会话）——再积累一些对话，地层才有考古价值',
    }
  }

  // 纪元划分：index 均分（活动稀疏期不产生空窗口）。
  const requested = Math.max(2, Math.min(options.windows ?? 4, Math.floor(ordered.length / 2)))
  const windowCount = Math.max(2, requested)
  const slices: ArchaeologySession[][] = []
  for (let w = 0; w < windowCount; w += 1) {
    const from = Math.floor((ordered.length * w) / windowCount)
    const to = Math.floor((ordered.length * (w + 1)) / windowCount)
    slices.push(ordered.slice(from, to))
  }

  // 逐纪元大陆发现。
  const windows: EraWindow[] = slices.map((slice, index) => {
    const graph = eraGraph(slice)
    const report = detectCommunities(graph)
    return {
      index,
      sessions: slice.length,
      fromAt: slice[0]?.at ?? 0,
      toAt: slice[slice.length - 1]?.at ?? slice[0]?.at ?? 0,
      entities: graph.nodes.length,
      edges: graph.edgeCount,
      modularity: Number(report.modularity.toFixed(4)),
      continents: report.communities
        .filter((c) => c.entities.length >= minSize)
        .map((c) => ({
          id: c.id,
          size: c.entities.length,
          sessionCount: c.sessionCount,
          topEntities: c.topEntities.slice(0, 5).map((e) => e.name),
          memberKeys: c.entities.map((e) => e.key),
        })),
    }
  })

  // 相邻纪元血脉匹配 + 板块事件。
  const events: PlateEvent[] = []
  for (let t = 0; t + 1 < windows.length; t += 1) {
    const prev = windows[t].continents
    const next = windows[t + 1].continents
    // 匹配矩阵：prev i ↔ next j（Jaccard ≥ 阈值）。
    const match: number[][] = []
    for (let i = 0; i < prev.length; i += 1) {
      match[i] = []
      for (let j = 0; j < next.length; j += 1) {
        match[i][j] = jaccard(new Set(prev[i].memberKeys), new Set(next[j].memberKeys))
      }
    }
    const predsOf: number[][] = Array.from({ length: next.length }, () => [])
    const succsOf: number[][] = Array.from({ length: prev.length }, () => [])
    for (let i = 0; i < prev.length; i += 1) {
      for (let j = 0; j < next.length; j += 1) {
        if (match[i][j] >= lineage) {
          predsOf[j].push(i)
          succsOf[i].push(j)
        }
      }
    }
    const label = (w: number, c: number): string => `纪元${w + 1}-大陆${c + 1}`
    const tops = (w: number, c: number): readonly string[] => windows[w].continents[c].topEntities
    // 新生：无前置血脉。
    for (let j = 0; j < next.length; j += 1) {
      if (predsOf[j].length === 0) {
        const names = tops(t + 1, j).join('、')
        events.push({
          kind: 'birth',
          fromWindow: -1,
          toWindow: t + 1,
          topEntities: tops(t + 1, j),
          strength: 0,
          description: `${label(t + 1, j)} 新生${names ? `：${names}` : ''}——新知识域在此纪元形成`,
        })
      }
    }
    // 消亡：无后继血脉。
    for (let i = 0; i < prev.length; i += 1) {
      if (succsOf[i].length === 0) {
        const names = tops(t, i).join('、')
        events.push({
          kind: 'dissolve',
          fromWindow: t,
          toWindow: -1,
          topEntities: tops(t, i),
          strength: 0,
          description: `${label(t, i)} 沉没${names ? `：${names}` : ''}——该知识域在下一纪元消失`,
        })
      }
    }
    // 分裂 / 合并 / 延续。
    for (let i = 0; i < prev.length; i += 1) {
      if (succsOf[i].length >= 2) {
        const targets = succsOf[i].map((j) => `${label(t + 1, j)}（${Math.round(match[i][j] * 100)}%）`)
        events.push({
          kind: 'split',
          fromWindow: t,
          toWindow: t + 1,
          topEntities: tops(t, i),
          strength: Math.max(...succsOf[i].map((j) => match[i][j])),
          description: `${label(t, i)} 分裂 → ${targets.join(' 与 ')}——关注点在此分化`,
        })
      } else if (succsOf[i].length === 1) {
        const j = succsOf[i][0]
        if (predsOf[j].length === 1) {
          events.push({
            kind: 'continuation',
            fromWindow: t,
            toWindow: t + 1,
            topEntities: tops(t + 1, j),
            strength: match[i][j],
            description: `${label(t, i)} 延续为 ${label(t + 1, j)}（成员重叠 ${Math.round(match[i][j] * 100)}%）`,
          })
        }
      }
    }
    for (let j = 0; j < next.length; j += 1) {
      if (predsOf[j].length >= 2) {
        const sources = predsOf[j].map((i) => `${label(t, i)}（${Math.round(match[i][j] * 100)}%）`)
        events.push({
          kind: 'merge',
          fromWindow: t,
          toWindow: t + 1,
          topEntities: tops(t + 1, j),
          strength: Math.max(...predsOf[j].map((i) => match[i][j])),
          description: `${sources.join(' 与 ')} 合并为 ${label(t + 1, j)}——分散的主题在此收拢`,
        })
      }
    }
  }
  events.sort((a, b) => a.toWindow - b.toWindow || a.fromWindow - b.fromWindow)

  const count = (kind: PlateEventKind): number => events.filter((e) => e.kind === kind).length
  const stats = {
    windows: windows.length,
    births: count('birth'),
    continuations: count('continuation'),
    splits: count('split'),
    merges: count('merge'),
    dissolves: count('dissolve'),
  }
  return {
    windows,
    events,
    stats,
    summary: summarize(stats),
  }
}

/** 考古报告人话摘要。 */
function summarize(stats: ArchaeologyReport['stats']): string {
  const movements = stats.births + stats.splits + stats.merges + stats.dissolves
  const parts: string[] = []
  if (stats.births > 0) parts.push(`${stats.births} 块大陆新生`)
  if (stats.dissolves > 0) parts.push(`${stats.dissolves} 块沉没`)
  if (stats.splits > 0) parts.push(`${stats.splits} 次分裂`)
  if (stats.merges > 0) parts.push(`${stats.merges} 次合并`)
  if (stats.continuations > 0) parts.push(`${stats.continuations} 次延续`)
  if (movements === 0) {
    return `${stats.windows} 个纪元间知识版图稳定——大陆全部延续，无结构性变迁`
  }
  return `${stats.windows} 个纪元间发生 ${movements} 次构造运动：${parts.join('、')}`
}
