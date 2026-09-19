/**
 * 个性化 PageRank（轴线 27「星图导航」）：在实体共现图上做多跳推理。
 *
 * 设计动机：共现边只回答"谁和谁直接同现过"——一跳邻居。但知识联想
 * 是多跳的："docker → 容器网络 → k8s service → service mesh"，主题
 * 检索永远无法给出的结构联想，图上的随机游走天然擅长。个性化
 * PageRank（Page & Brin 1998 的 personalized 变体）从种子实体出发做
 * 带重启的随机游走（teleport 只回到种子），稳态分布即「从你的出发点
 * 看，整个知识宇宙的引力场」：
 *
 * p(i) = (1−d)·r(i) + d·[ Σ_j p(j)·w_ji/deg(j) + 悬挂质量回注 ]
 *
 * - **重启分布 r**：种子实体归一（查询命中实体时按命中强度加权）；
 * - **阻尼 d = 0.85**：每步 15% 概率回到出发点——分数始终锚定在
 *   种子的视角上，越近的实体引力越强，但不切断远处的结构联想；
 * - **悬挂节点回注**：零度实体的游走质量回注重启分布（质量守恒）；
 * - **跳数标注**：种子出发的 BFS 距离（结构上"几步之遥"），与 PPR
 *   分数互补——分数是引力，跳数是路标。
 *
 * 纯本地、零 LLM、零网络；纯函数、无状态、可单测。
 */
import type { EntityGraph } from './graph.js'
import { tokenize } from '../retrieval/tokenize.js'

/** PageRank 参数。 */
export interface PageRankOptions {
  /** 阻尼系数（回到邻居的概率）；缺省 0.85。 */
  readonly damping?: number
  /** 幂迭代最大轮数；缺省 50。 */
  readonly maxIterations?: number
  /** L1 收敛阈值；缺省 1e-6。 */
  readonly tolerance?: number
}

/** 单个排序结果实体。 */
export interface PageRankNode {
  readonly key: string
  readonly name: string
  readonly type: string
  /** 稳态 PPR 分数（Σ=1；相对引力强度）。 */
  readonly score: number
  /** 是否种子实体（出发点）。 */
  readonly seed: boolean
  /** 距最近种子的 BFS 跳数（孤立项为 null）。 */
  readonly hopDistance: number | null
}

/**
 * 个性化 PageRank 主入口：从种子实体出发的带重启随机游走稳态分布。
 *
 * @param graph 共现图（buildEntityGraph 产物）。
 * @param seeds 种子权重（实体键 → 强度；会被归一，空映射返回空结果）。
 * @param options 参数（全部缺省即可用）。
 */
export function personalizedPageRank(
  graph: EntityGraph,
  seeds: ReadonlyMap<string, number>,
  options: PageRankOptions = {},
): PageRankNode[] {
  const damping = options.damping ?? 0.85
  const maxIterations = options.maxIterations ?? 50
  const tolerance = options.tolerance ?? 1e-6
  const { nodes, adjacency } = graph
  const keyToIndex = new Map<string, number>()
  nodes.forEach((node, index) => keyToIndex.set(node.key, index))
  // 重启分布：种子键过滤到图内，权重归一。
  const restart = new Float64Array(nodes.length)
  let restartMass = 0
  for (const [key, weight] of seeds) {
    const index = keyToIndex.get(key)
    if (index === undefined) continue
    const positive = Number.isFinite(weight) && weight > 0 ? weight : 1
    restart[index] += positive
    restartMass += positive
  }
  if (restartMass <= 0 || nodes.length === 0) return []
  for (let i = 0; i < restart.length; i += 1) restart[i] /= restartMass

  // 度数（加权）与悬挂节点判定。
  const degree = new Float64Array(nodes.length)
  for (let i = 0; i < nodes.length; i += 1) {
    const neighbors = adjacency.get(nodes[i].key)
    if (neighbors === undefined) continue
    for (const weight of neighbors.values()) degree[i] += weight
  }
  let rank = Float64Array.from(restart)
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next = new Float64Array(nodes.length)
    let danglingMass = 0
    for (let i = 0; i < nodes.length; i += 1) {
      if (rank[i] === 0) continue
      if (degree[i] <= 0) {
        danglingMass += rank[i]
        continue
      }
      const neighbors = adjacency.get(nodes[i].key)
      if (neighbors === undefined) continue
      for (const [neighborKey, weight] of neighbors) {
        const j = keyToIndex.get(neighborKey)
        if (j === undefined) continue
        next[j] += (rank[i] * weight) / degree[i]
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      next[i] = (1 - damping) * restart[i] + damping * (next[i] + danglingMass * restart[i])
    }
    let diff = 0
    for (let i = 0; i < nodes.length; i += 1) diff += Math.abs(next[i] - rank[i])
    rank = next
    if (diff < tolerance) break
  }

  const hop = hopDistances(graph, keyToIndex, seeds)
  const seedSet = new Set<string>()
  for (const key of seeds.keys()) seedSet.add(key)
  const result: PageRankNode[] = nodes.map((node, index) => ({
    key: node.key,
    name: node.name,
    type: node.type,
    score: rank[index],
    seed: seedSet.has(node.key),
    hopDistance: hop.get(node.key) ?? null,
  }))
  result.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return result
}

/** 种子集合到全图的 BFS 跳数（无权最短结构距离）。 */
function hopDistances(
  graph: EntityGraph,
  keyToIndex: ReadonlyMap<string, number>,
  seeds: ReadonlyMap<string, number>,
): Map<string, number> {
  const hops = new Map<string, number>()
  const queue: string[] = []
  for (const key of seeds.keys()) {
    if (keyToIndex.has(key) && !hops.has(key)) {
      hops.set(key, 0)
      queue.push(key)
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    const distance = hops.get(current) ?? 0
    const neighbors = graph.adjacency.get(current)
    if (neighbors === undefined) continue
    for (const neighbor of neighbors.keys()) {
      if (hops.has(neighbor)) continue
      hops.set(neighbor, distance + 1)
      queue.push(neighbor)
    }
  }
  return hops
}

/**
 * 从自然语言查询构造种子权重：查询词元命中实体名（子串或词元包含）
 * 即为种子，权重 = 命中词元数 × 稀有度加成（覆盖会话越少的实体，
 * 命中信号越强——长尾实体名几乎不会误命中）。
 *
 * @param graph 共现图。
 * @param queryText 查询文本（任意中英混合）。
 * @returns 种子权重表（无命中返回空映射）。
 */
export function seedFromQuery(
  graph: EntityGraph,
  queryText: string,
): Map<string, number> {
  const seeds = new Map<string, number>()
  const query = queryText.trim().toLowerCase()
  if (query.length === 0) return seeds
  const queryTokens = new Set(tokenize(queryText))
  if (queryTokens.size === 0) return seeds
  const totalSessions = Math.max(1, graph.nodes.length)
  for (const node of graph.nodes) {
    const name = node.name.toLowerCase()
    // 命中条件：查询包含完整实体名（专名直接命中），或实体名分词后
    // 全部词元都在查询词元中（多词实体名被查询覆盖）。
    let matched = 0
    if (name.length >= 2 && query.includes(name)) {
      matched = nameTokensOf(node.name).length
    } else {
      const nameTokens = nameTokensOf(node.name)
      if (nameTokens.length > 0 && nameTokens.every((token) => queryTokens.has(token))) {
        matched = nameTokens.length
      }
    }
    if (matched <= 0) continue
    // 稀有度加成：覆盖会话少的实体命中权重更高（log 压缩量级）。
    const rarity = 1 + Math.log(1 + totalSessions / Math.max(1, node.sessions.size))
    seeds.set(node.key, matched * rarity)
  }
  return seeds
}

/** 实体名的词元分解（复用检索分词器；中文实体名走 bigram）。 */
function nameTokensOf(name: string): string[] {
  return tokenize(name)
}
