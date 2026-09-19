/**
 * Louvain 社区发现（轴线 26「知识大陆」）：把共现图切成模块度最大化的
 * 社区——你的知识自然聚成的大陆。
 *
 * 设计动机：轴线 13 的知识地图用「质心贪心聚类」按内容相似度分组，
 * 回答"哪些会话在谈相近的事"；本模块在**实体图**上做图结构划分，
 * 回答一个更本质的问题——"我的知识域有几块，每块的骨架实体是什么"。
 * 与质心聚类相比，图社区发现的优势：
 *
 * - **枢纽自动平衡**：高频实体（npm、docker）与谁都共现，质心聚类会把
 *   它们吸进一切簇；模块度最大化显式惩罚"随机连接的稠密"，枢纽只归
 *   属它连接最紧密的一块大陆；
 * - **层次自组织**：Louvain 两阶段迭代（局部移动 → 社区聚合）自动发现
 *   多尺度结构——小簇先聚合，聚合图上再聚合成大陆，无需预设簇数。
 *
 * 算法（Blondel et al. 2008，实践复杂度 ~O(n·log n)）：
 * - **阶段一（局部移动）**：节点逐个尝试移入邻居社区，取模块度增益
 *   最大者；增益 `ΔQ ∝ k_i,in(c) − Σ_tot(c)·k_i/2m`，逐节点 O(度数)；
 * - **阶段二（聚合）**：社区收缩为超节点，社区内边转为自环、跨社区
 *   边权相加——图规模逐层指数收缩，直到模块度无法再提升；
 * - 多层社区归属经「成员折叠表」逐层还原到原始实体。
 *
 * 图论约定（自环）：自环权重 s 计入邻接一次、计入度数两次；
 * m = Σ自环 + Σ无向边（单侧），恒有 2m = Σ度数。
 *
 * 纯本地、零 LLM、零网络；纯函数、无状态、可单测。
 */
import type { EntityGraph } from './graph.js'

/** 单个社区（一块「知识大陆」）。 */
export interface Community {
  /** 社区序号（按成员数降序重编）。 */
  readonly id: number
  /** 成员实体（按度数降序）。 */
  readonly entities: ReadonlyArray<{
    key: string
    name: string
    type: string
    /** 加权度数（该实体全部共现边权之和——大陆内的骨干程度）。 */
    degree: number
    /** 覆盖会话数。 */
    sessions: number
  }>
  /** 成员数。 */
  readonly size: number
  /** 社区覆盖的会话总数（成员会话集并集）。 */
  readonly sessionCount: number
  /** 社区内部边权（内聚度；越高说明大陆越"抱团"）。 */
  readonly internalWeight: number
  /** 代表实体（按度数降序的头部——社区命名建议）。 */
  readonly topEntities: ReadonlyArray<{ name: string; type: string }>
}

/** 社区发现报告。 */
export interface CommunityReport {
  /** 最终划分的模块度 Q（∈[-0.5, 1]，越大划分越显著）。 */
  readonly modularity: number
  /** Louvain 聚合层数（1 = 单轮局部移动即收敛）。 */
  readonly levels: number
  /** 社区列表（按成员数降序）。 */
  readonly communities: readonly Community[]
  /** 图规模摘要。 */
  readonly graph: { nodes: number; edges: number }
  /** 人话摘要。 */
  readonly summary: string
}

/** Louvain 参数。 */
export interface LouvainOptions {
  /** 单层内局部移动的最大轮数；缺省 15。 */
  readonly maxPasses?: number
  /** 最大聚合层数；缺省 10。 */
  readonly maxLevels?: number
  /** 节点访问顺序扰动种子（0 = 稳定顺序）。 */
  readonly seed?: number
}

/** 聚合层内部的紧凑图形态（索引邻接，逐层收缩）。 */
interface LayerGraph {
  readonly order: number
  /** 邻接表：节点索引 → (邻居索引 → 边权)。对称、无自环项。 */
  readonly adjacency: ReadonlyArray<ReadonlyMap<number, number>>
  /** 自环权重（聚合后的社区内边）。 */
  readonly selfLoops: ReadonlyArray<number>
  /** 总边权 m（自环 + 无向边单侧）。 */
  readonly totalWeight: number
}

/**
 * Louvain 社区发现主入口：在共现图上迭代「局部移动 + 聚合」，
 * 返回模块度最大化的社区划分与多层还原的成员归属。
 *
 * @param graph 共现图（buildEntityGraph 产物）。
 * @param options 参数（全部缺省即可用）。
 */
export function detectCommunities(
  graph: EntityGraph,
  options: LouvainOptions = {},
): CommunityReport {
  const maxPasses = options.maxPasses ?? 15
  const maxLevels = options.maxLevels ?? 10
  const order = graph.nodes.length
  if (order === 0 || graph.totalWeight <= 0) {
    return {
      modularity: 0,
      levels: 0,
      communities: [],
      graph: { nodes: order, edges: graph.edgeCount },
      summary:
        order === 0
          ? '实体图为空：还没有可聚类的知识'
          : '实体图无共现边：实体尚未在任何会话中同时出现',
    }
  }
  let layer = toLayer(graph)
  // 成员折叠表：当前层节点 i → 其代表的原始实体索引列表。
  let membership: readonly number[][] = graph.nodes.map((_, index) => [index])
  let assignment: number[] = []
  let modularity = 0
  let levels = 0
  // 收敛保证：可聚合时层规模严格递减，maxLevels 只是额外护栏。
  for (;;) {
    assignment = localMoving(layer, maxPasses, options.seed ?? 0, levels)
    modularity = modularityOf(layer, assignment)
    levels += 1
    if (levels >= maxLevels) break
    if (new Set(assignment).size >= layer.order) break
    const next = aggregate(layer, assignment)
    if (next === undefined) break
    membership = foldMembership(membership, assignment, next.order)
    layer = next
  }
  // 最终成员表：社区 → 原始实体索引并集。
  const memberTable: number[][] = []
  for (let node = 0; node < layer.order; node += 1) {
    const community = assignment[node]
    while (memberTable.length <= community) memberTable.push([])
    memberTable[community].push(...membership[node])
  }
  return buildReport(graph, memberTable, modularity, levels)
}

/** 原始共现图 → 初始层（索引邻接形态；节点顺序与 graph.nodes 一致）。 */
function toLayer(graph: EntityGraph): LayerGraph {
  const order = graph.nodes.length
  const keyToIndex = new Map<string, number>()
  graph.nodes.forEach((node, index) => keyToIndex.set(node.key, index))
  const adjacency: Map<number, number>[] = Array.from({ length: order }, () => new Map())
  for (const [from, neighbors] of graph.adjacency) {
    const fromIndex = keyToIndex.get(from)
    if (fromIndex === undefined) continue
    for (const [to, weight] of neighbors) {
      const toIndex = keyToIndex.get(to)
      if (toIndex === undefined || toIndex === fromIndex) continue
      adjacency[fromIndex].set(toIndex, weight)
    }
  }
  return { order, adjacency, selfLoops: new Array<number>(order).fill(0), totalWeight: graph.totalWeight }
}

/**
 * 阶段一（局部移动）：节点逐个迁入增益最大的邻居社区，直到无移动
 * 或轮数上限。增益为 `G(c) = 2m·k_i,in(c) − Σ_tot(c)·k_i`（2m²·ΔQ 尺度，
 * 常数因子不影响 argmax）。
 */
function localMoving(
  layer: LayerGraph,
  maxPasses: number,
  seed: number,
  level: number,
): number[] {
  const { order, adjacency, selfLoops, totalWeight } = layer
  const community = Array.from({ length: order }, (_, index) => index)
  const degree = new Float64Array(order)
  const sigmaTotal = new Float64Array(order)
  for (let node = 0; node < order; node += 1) {
    // 自环计入度数两次（图论约定），保证 2m = Σ度数。
    let sum = 2 * selfLoops[node]
    for (const weight of adjacency[node].values()) sum += weight
    degree[node] = sum
    sigmaTotal[community[node]] = sum
  }
  const twoM = 2 * totalWeight
  if (twoM <= 0) return community
  const visitOrder = visitOrderOf(order, seed, level)
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false
    for (const node of visitOrder) {
      const neighbors = adjacency[node]
      if (neighbors.size === 0) continue
      const current = community[node]
      const k = degree[node]
      // 邻居社区 → k_i,in（节点与该社区的连接权重和）。
      const linksTo = new Map<number, number>()
      for (const [neighbor, weight] of neighbors) {
        const target = community[neighbor]
        linksTo.set(target, (linksTo.get(target) ?? 0) + weight)
      }
      sigmaTotal[current] -= k
      let bestCommunity = current
      let bestGain = twoM * (linksTo.get(current) ?? 0) - sigmaTotal[current] * k
      for (const [target, kIn] of linksTo) {
        if (target === current) continue
        const gain = twoM * kIn - sigmaTotal[target] * k
        if (gain > bestGain + 1e-12) {
          bestGain = gain
          bestCommunity = target
        }
      }
      sigmaTotal[bestCommunity] += k
      if (bestCommunity !== current) {
        community[node] = bestCommunity
        moved = true
      }
    }
    if (!moved) break
  }
  return renumber(community)
}

/** 稳定访问顺序（seed=0）或线性同余扰动顺序（同种子可复现）。 */
function visitOrderOf(order: number, seed: number, level: number): number[] {
  const visitOrder = Array.from({ length: order }, (_, index) => index)
  if (seed === 0) return visitOrder
  let state = (Math.imul(seed + level + 1, 2654435761) >>> 0) || 1
  for (let i = order - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    const temp = visitOrder[i]
    visitOrder[i] = visitOrder[j]
    visitOrder[j] = temp
  }
  return visitOrder
}

/** 社区 id 连续化（局部移动后可能出现空洞）。 */
function renumber(assignment: readonly number[]): number[] {
  const remap = new Map<number, number>()
  const result: number[] = []
  for (const community of assignment) {
    let next = remap.get(community)
    if (next === undefined) {
      next = remap.size
      remap.set(community, next)
    }
    result.push(next)
  }
  return result
}

/**
 * 阶段二（聚合）：社区收缩为超节点。社区内无向边与新节点自环等权
 * （单侧计一次），跨社区边权相加；旧自环随成员并入。2m 恒守恒。
 */
function aggregate(layer: LayerGraph, assignment: readonly number[]): LayerGraph | undefined {
  const { order, adjacency, selfLoops } = layer
  const distinct = new Set(assignment)
  if (distinct.size >= order) return undefined
  const communityIndex = new Map<number, number>()
  for (const community of distinct) communityIndex.set(community, communityIndex.size)
  const newOrder = communityIndex.size
  const newSelfLoops = new Array<number>(newOrder).fill(0)
  for (let node = 0; node < order; node += 1) {
    newSelfLoops[communityIndex.get(assignment[node]) ?? 0] += selfLoops[node]
  }
  // 跨社区边与社区内边：邻接双侧对称 → 累计后除 2 还原单侧。
  const crossPairs = new Map<number, Map<number, number>>()
  const internal = new Array<number>(newOrder).fill(0)
  for (let node = 0; node < order; node += 1) {
    const from = communityIndex.get(assignment[node]) ?? 0
    for (const [neighbor, weight] of adjacency[node]) {
      const to = communityIndex.get(assignment[neighbor]) ?? 0
      if (from === to) internal[from] += weight / 2
      else {
        let targets = crossPairs.get(from)
        if (targets === undefined) {
          targets = new Map()
          crossPairs.set(from, targets)
        }
        targets.set(to, (targets.get(to) ?? 0) + weight / 2)
      }
    }
  }
  for (let community = 0; community < newOrder; community += 1) newSelfLoops[community] += internal[community]
  const newAdjacency: Map<number, number>[] = Array.from({ length: newOrder }, () => new Map())
  let total = 0
  for (let community = 0; community < newOrder; community += 1) total += newSelfLoops[community]
  for (const [from, targets] of crossPairs) {
    for (const [to, weight] of targets) {
      newAdjacency[from].set(to, weight)
      newAdjacency[to].set(from, weight)
      total += weight
    }
  }
  return { order: newOrder, adjacency: newAdjacency, selfLoops: newSelfLoops, totalWeight: total }
}

/** 成员折叠：新层节点（社区）→ 旧层成员代表的原始实体索引并集。 */
function foldMembership(
  membership: readonly (readonly number[])[],
  assignment: readonly number[],
  newOrder: number,
): number[][] {
  const folded: number[][] = Array.from({ length: newOrder }, () => [])
  for (let node = 0; node < assignment.length; node += 1) {
    folded[assignment[node]].push(...membership[node])
  }
  return folded
}

/** 模块度 Q = Σ_c [ Σ_in(c)/2m − (Σ_tot(c)/2m)² ]；Σ_in = 2×(社区内边 + 自环)。 */
function modularityOf(layer: LayerGraph, assignment: readonly number[]): number {
  const twoM = 2 * layer.totalWeight
  if (twoM <= 0) return 0
  // sigmaHalf：社区内边（单侧）+ 成员自环——最终 ×2 得 Σ_in。
  const sigmaHalf = new Map<number, number>()
  const sigmaTotal = new Map<number, number>()
  for (let node = 0; node < layer.order; node += 1) {
    const community = assignment[node]
    let degree = 2 * layer.selfLoops[node]
    for (const weight of layer.adjacency[node].values()) degree += weight
    sigmaTotal.set(community, (sigmaTotal.get(community) ?? 0) + degree)
    sigmaHalf.set(community, (sigmaHalf.get(community) ?? 0) + layer.selfLoops[node])
    for (const [neighbor, weight] of layer.adjacency[node]) {
      if (assignment[neighbor] === community) {
        // 双侧循环各计一次 → 除 2 还原单侧。
        sigmaHalf.set(community, (sigmaHalf.get(community) ?? 0) + weight / 2)
      }
    }
  }
  let q = 0
  for (const [community, total] of sigmaTotal) {
    const intra = 2 * (sigmaHalf.get(community) ?? 0)
    q += intra / twoM - (total / twoM) * (total / twoM)
  }
  return q
}

/** 组装最终报告：社区成员表（原始索引）→ 实体视图与统计。 */
function buildReport(
  graph: EntityGraph,
  memberTable: readonly (readonly number[])[],
  modularity: number,
  levels: number,
): CommunityReport {
  const communities: Community[] = []
  for (const members of memberTable) {
    if (members.length === 0) continue
    const sessions = new Set<string>()
    const entityViews: Community['entities'][number][] = []
    for (const index of members) {
      const node = graph.nodes[index]
      if (node === undefined) continue
      for (const sessionId of node.sessions) sessions.add(sessionId)
      let degree = 0
      const neighbors = graph.adjacency.get(node.key)
      if (neighbors !== undefined) for (const weight of neighbors.values()) degree += weight
      entityViews.push({ key: node.key, name: node.name, type: node.type, degree, sessions: node.sessions.size })
    }
    if (entityViews.length === 0) continue
    entityViews.sort((a, b) => b.degree - a.degree || a.key.localeCompare(b.key))
    communities.push({
      id: communities.length,
      entities: entityViews,
      size: entityViews.length,
      sessionCount: sessions.size,
      internalWeight: internalWeightOf(graph, entityViews),
      topEntities: entityViews.slice(0, 5).map((view) => ({ name: view.name, type: view.type })),
    })
  }
  communities.sort((a, b) => b.size - a.size || b.sessionCount - a.sessionCount)
  communities.forEach((community, index) => {
    (community as { id: number }).id = index
  })
  return {
    modularity,
    levels,
    communities,
    graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
    summary: communitySummary(communities, modularity),
  }
}

/** 社区内边权（无向单侧计）。 */
function internalWeightOf(graph: EntityGraph, entities: ReadonlyArray<{ key: string }>): number {
  const keys = new Set(entities.map((view) => view.key))
  let internal = 0
  for (const key of keys) {
    const neighbors = graph.adjacency.get(key)
    if (neighbors === undefined) continue
    for (const [other, weight] of neighbors) {
      if (other > key && keys.has(other)) internal += weight
    }
  }
  return internal
}

/** 人话摘要。 */
function communitySummary(communities: readonly Community[], modularity: number): string {
  if (communities.length === 0) return '未发现任何知识社区'
  const top = communities[0]
  const names = top.topEntities.slice(0, 3).map((entity) => entity.name).join('、')
  return `发现 ${communities.length} 块知识大陆（模块度 ${modularity.toFixed(3)}），最大一块以 ${names} 为骨架，覆盖 ${top.sessionCount} 个会话`
}
