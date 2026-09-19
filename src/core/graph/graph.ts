/**
 * 知识图谱构建（轴线 26/27 的共享基座）：实体共现图的纯函数构造。
 *
 * 设计动机：模块 F 的实体倒排索引回答「每个实体出现在哪些会话」，
 * 但实体之间的**共现结构**才是知识域的真实形状——同一会话里同时
 * 出现的实体在讲同一件事，跨会话反复共现的实体对构成稳定的知识
 * 边。把倒排索引投影为无向带权图后，图算法（社区发现 / PageRank）
 * 才有可计算的底座：
 *
 * - **节点** = 实体（`<type>:<小写名>` 唯一键，携带展示名与覆盖会话集）；
 * - **边权** = 共现会话数——每有一个会话同时包含两实体，边权 +1。
 *   高频实体（如 npm）天然成为枢纽，社区发现按模块度自动平衡。
 *
 * 纯本地、零 LLM、零网络——隐私红线与轴线 1/4 一致。
 */

/** 图节点：一个实体（展示信息 + 覆盖会话集）。 */
export interface GraphNode {
  /** 实体唯一键（`<type>:<小写名>`，与 knowledge-entities 表键对齐）。 */
  readonly key: string
  /** 展示名。 */
  readonly name: string
  /** 实体类型（command/path/tech/code/term/version）。 */
  readonly type: string
  /** 覆盖的会话 id 集合（社区会话覆盖数 = 节点集合并集）。 */
  readonly sessions: ReadonlySet<string>
}

/** 实体共现图（无向带权；邻接表双侧对称）。 */
export interface EntityGraph {
  /** 全部节点（顺序稳定：按构造输入顺序）。 */
  readonly nodes: readonly GraphNode[]
  /** 邻接表：节点键 → (邻接节点键 → 共现权重)。 */
  readonly adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** 全部边权总和（每条无向边计一次；模块度归一基准）。 */
  readonly totalWeight: number
  /** 边总数（去重后的无向边数）。 */
  readonly edgeCount: number
}

/** 实体倒排记录的最小输入形状（knowledge-entities 表 `e/` 记录的投影）。 */
export interface EntityGraphInput {
  /** 实体唯一键。 */
  readonly key: string
  /** 展示名。 */
  readonly name: string
  /** 实体类型。 */
  readonly type: string
  /** 会话 id → 频次（仅用会话集合，频次不参与共现权重）。 */
  readonly sessions: Readonly<Record<string, number>>
}

/**
 * 从实体倒排记录构建共现图。
 *
 * 每个会话内包含的全部实体两两连边（团），边权 = 共享会话数累计。
 * 单会话实体数上不封顶但受抽取器自身封顶约束；超大会话的团展开
 * 为 O(k²) 边，实体条数上限（提取器侧）保证规模可控。
 *
 * @param records 实体倒排记录（键含非法会话条目时静默忽略该条目）。
 */
export function buildEntityGraph(records: readonly EntityGraphInput[]): EntityGraph {
  const nodes: GraphNode[] = []
  const nodeKeys = new Set<string>()
  // 会话 id → 该会话内的实体键列表（倒排 → 正排投影）。
  const sessionEntities = new Map<string, string[]>()
  for (const record of records) {
    if (typeof record.key !== 'string' || record.key.length === 0) continue
    const sessions = new Set<string>()
    if (typeof record.sessions === 'object' && record.sessions !== null) {
      for (const [sessionId, freq] of Object.entries(record.sessions)) {
        if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0) {
          sessions.add(sessionId)
          const list = sessionEntities.get(sessionId) ?? []
          if (list.length === 0) sessionEntities.set(sessionId, list)
          list.push(record.key)
        }
      }
    }
    if (sessions.size === 0) continue
    if (nodeKeys.has(record.key)) continue
    nodeKeys.add(record.key)
    nodes.push({
      key: record.key,
      name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.key,
      type: typeof record.type === 'string' ? record.type : '',
      sessions,
    })
  }
  const adjacency = new Map<string, Map<string, number>>()
  for (const node of nodes) adjacency.set(node.key, new Map())
  let totalWeight = 0
  let edgeCount = 0
  // 会话内团展开：同一会话的实体两两加边（去重后）。
  for (const entityKeys of sessionEntities.values()) {
    const unique = [...new Set(entityKeys)]
    if (unique.length < 2) continue
    for (let i = 0; i < unique.length; i += 1) {
      const neighbors = adjacency.get(unique[i])
      if (neighbors === undefined) continue
      for (let j = i + 1; j < unique.length; j += 1) {
        const other = adjacency.get(unique[j])
        if (other === undefined) continue
        const prev = neighbors.get(unique[j]) ?? 0
        if (prev === 0) edgeCount += 1
        // 每次共现使该边权重 +1，边权总和恰增加 1。
        neighbors.set(unique[j], prev + 1)
        other.set(unique[i], prev + 1)
        totalWeight += 1
      }
    }
  }
  return { nodes, adjacency, totalWeight, edgeCount }
}
