/**
 * 记忆固化引擎（轴线 31）：MinHash-LSH 近重复检测与知识固化。
 *
 * 设计动机：同一个问题会在不同会话里反复出现——报错换了个文件名
 * 又来一遍、相似的配置改个参数再问一次。对人类记忆，重复接触是
 * **强化**信号（间隔重复的天然燃料）；对机器记忆，未合并的重复是
 * **污染**（检索结果同质化、复习清单冗余、知识库虚胖）。本引擎把
 * 「重复」从噪声变成资产：
 *
 * - **MinHash 签名**：token 集合压缩为固定长度（128 维）的最小哈希
 *   签名，签名期望相似度 = Jaccard 相似度——O(1) 估计集合重合度；
 * - **LSH 分带**：签名切 16 带 × 8 行，任一带相等即候选对——
 *   S 曲线阈值 ≈ (1/16)^(1/8) ≈ 0.71，把 O(n²) 配对压到近线性，
 *   且召回率在阈值以上接近 1；
 * - **精确验证**：候选对回退到真实 token 集合算 Jaccard（签名只是
 *   候选生成器，判定用真值）；
 * - **并查集聚类**：通过验证的候选对传递归并成簇（近重复的近重复
 *   也是近重复——知识以连通分量固化）；
 * - **固化计划**：每簇选代表（信息量最大：token 数优先，新近优先），
 *   报告重复次数（强化度）、首末出现时间、簇内成员——重复 N 次
 *   的知识天然值得更高的复习优先级（喂给轴线 21/23 的强化信号）。
 *
 * 纯函数、无状态、确定性（哈希种子固定）：同一输入同一计划。
 */

import { fnv1a32, tokenize } from '../retrieval/tokenize.js'

/** 待固化的记忆项（一条「问题→解法」片段、一条消息或一个会话摘要）。 */
export interface ConsolidationItem {
  /** 项 id（episodeId / sessionId / 任意稳定标识）。 */
  readonly id: string
  /** 文本（问题面或问题+解法的拼接——调用方决定固化粒度）。 */
  readonly text: string
  /** 时间戳（毫秒；缺省 0，仅影响代表选择与首末时间）。 */
  readonly at?: number
}

/** 固化配置。 */
export interface ConsolidationOptions {
  /** 归簇的 Jaccard 阈值；缺省 0.65。 */
  readonly jaccardThreshold?: number
  /** MinHash 签名长度；缺省 128（须为 bands × rows）。 */
  readonly signatureSize?: number
  /** LSH 带数；缺省 16。 */
  readonly bands?: number
  /** 每带行数；缺省 8。 */
  readonly rows?: number
  /** 项数上限（近端优先截断）；缺省 5000。 */
  readonly maxItems?: number
}

/** 一个近重复簇（同一知识的多次出现）。 */
export interface ConsolidationCluster {
  /** 代表项 id（信息量最大者）。 */
  readonly representativeId: string
  /** 全部成员 id（含代表，时间序）。 */
  readonly memberIds: readonly string[]
  /** 出现次数（= 成员数；间隔重复意义上的强化度）。 */
  readonly reinforcement: number
  /** 首次出现时间。 */
  readonly firstSeenAt: number
  /** 最近出现时间。 */
  readonly lastSeenAt: number
  /** 簇内成员与代表 token 集合的平均 Jaccard（紧致度）。 */
  readonly cohesion: number
}

/** 固化计划。 */
export interface ConsolidationPlan {
  /** 参与固化的项数。 */
  readonly items: number
  /** 近重复簇（≥ 2 成员，按强化度降序）。 */
  readonly clusters: readonly ConsolidationCluster[]
  /** 被折叠的重复项总数（成员数 − 簇数）。 */
  readonly duplicates: number
  /** 唯一项数（单成员）。 */
  readonly unique: number
  /** 压缩率（duplicates / items；0 = 无重复）。 */
  readonly compression: number
  /** 人话摘要。 */
  readonly summary: string
}

/** 两个 token 集合的真实 Jaccard 相似度。 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const term of a) {
    if (b.has(term)) inter += 1
  }
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * MinHash 签名：token 集合 → 长度 k 的 32 位哈希序列。
 * 双重哈希（h_i(x) = h1(x) + (i+1)·h2(x)，乘法混合）避免每维独立
 * 哈希的 k 倍开销；期望签名相似度 = Jaccard。
 */
export function minhashSignature(terms: ReadonlySet<string>, size: number): Int32Array {
  const signature = new Int32Array(size).fill(0x7fffffff)
  for (const term of terms) {
    const h1 = fnv1a32(term)
    const h2 = fnv1a32(`${term}\u0000${size}`)
    for (let i = 0; i < size; i += 1) {
      const value = (Math.imul(h1, 0x85ebca6b) ^ Math.imul(i + 1, h2)) >>> 0
      if (value < signature[i]) signature[i] = value
    }
  }
  return signature
}

/** 签名估计的 Jaccard（相等维度占比）。 */
export function estimatedJaccard(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const size = Math.min(a.length, b.length)
  if (size === 0) return 0
  let equal = 0
  for (let i = 0; i < size; i += 1) {
    if (a[i] === b[i]) equal += 1
  }
  return equal / size
}

/**
 * 记忆固化主入口：近重复检测 + 聚类 + 固化计划。
 *
 * @param items 记忆项（任意顺序；内部按 id 稳定排序）。
 * @param options 配置（见 ConsolidationOptions）。
 */
export function consolidateMemories(
  items: readonly ConsolidationItem[],
  options: ConsolidationOptions = {},
): ConsolidationPlan {
  const threshold = Math.min(0.95, Math.max(0.3, options.jaccardThreshold ?? 0.65))
  const bands = Math.max(1, options.bands ?? 16)
  const rows = Math.max(1, options.rows ?? 8)
  const size = Math.max(bands * rows, options.signatureSize ?? bands * rows)
  const maxItems = Math.max(10, options.maxItems ?? 5000)

  const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const pool = ordered.slice(-maxItems)
  const n = pool.length
  if (n < 2) return emptyPlan(n)

  // token 集合 + 签名。
  const tokenSets: ReadonlySet<string>[] = pool.map((item) => new Set(tokenize(item.text)))
  const signatures = tokenSets.map((set) => minhashSignature(set, size))

  // ---- LSH 分带：任一带相等 → 候选对 ----
  const candidates = new Set<number>() // 编码 i·n + j（i < j）
  let pairBudget = 400_000 // 候选对验证预算（病态大桶的熔断）
  for (let band = 0; band < bands; band += 1) {
    const buckets = new Map<string, number[]>()
    for (let i = 0; i < n; i += 1) {
      const signature = signatures[i]
      const parts: string[] = []
      for (let r = 0; r < rows; r += 1) {
        parts.push(String(signature[band * rows + r]))
      }
      const key = parts.join(',')
      const bucket = buckets.get(key)
      if (bucket === undefined) {
        buckets.set(key, [i])
        continue
      }
      bucket.push(i)
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      const capped = bucket.length > 64 ? bucket.slice(-64) : bucket
      for (let x = 0; x < capped.length && pairBudget > 0; x += 1) {
        for (let y = x + 1; y < capped.length && pairBudget > 0; y += 1) {
          const i = capped[x] < capped[y] ? capped[x] : capped[y]
          const j = capped[x] < capped[y] ? capped[y] : capped[x]
          candidates.add(i * n + j)
          pairBudget -= 1
        }
      }
    }
  }

  // ---- 精确验证 + 并查集 ----
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  let merged = 0
  for (const code of candidates) {
    const i = Math.floor(code / n)
    const j = code % n
    if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
      const ri = find(i)
      const rj = find(j)
      if (ri !== rj) {
        parent[rj] = ri
        merged += 1
      }
    }
  }
  if (merged === 0) return emptyPlan(n)

  // ---- 簇整理 ----
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i += 1) {
    const root = find(i)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [i])
    else group.push(i)
  }
  const clusters: ConsolidationCluster[] = []
  let duplicates = 0
  let unique = 0
  for (const group of groups.values()) {
    if (group.length < 2) {
      unique += 1
      continue
    }
    duplicates += group.length - 1
    const members = group
      .map((i) => ({
        index: i,
        at: pool[i].at ?? 0,
        tokens: tokenSets[i].size,
      }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
    // 代表选择：信息量（token 数）优先，新近次之。
    let repIndex = 0
    for (let x = 1; x < members.length; x += 1) {
      const cur = members[repIndex]
      const cand = members[x]
      if (
        cand.tokens > cur.tokens ||
        (cand.tokens === cur.tokens && cand.at > cur.at)
      ) {
        repIndex = x
      }
    }
    const repTokenSet = tokenSets[members[repIndex].index]
    let cohesion = 0
    for (const member of members) {
      cohesion += jaccard(repTokenSet, tokenSets[member.index])
    }
    clusters.push({
      representativeId: pool[members[repIndex].index].id,
      memberIds: members.map((m) => pool[m.index].id),
      reinforcement: members.length,
      firstSeenAt: members[0].at,
      lastSeenAt: members[members.length - 1].at,
      cohesion: Number((cohesion / members.length).toFixed(4)),
    })
  }
  clusters.sort(
    (a, b) => b.reinforcement - a.reinforcement || (a.representativeId < b.representativeId ? -1 : 1),
  )

  return {
    items: n,
    clusters,
    duplicates,
    unique,
    compression: Number((duplicates / n).toFixed(4)),
    summary: summarizeConsolidation(n, clusters, duplicates),
  }
}

/** 无重复时的平凡计划。 */
function emptyPlan(n: number): ConsolidationPlan {
  return {
    items: n,
    clusters: [],
    duplicates: 0,
    unique: n,
    compression: 0,
    summary: n < 2
      ? '记忆项不足 2 条，固化引擎待启动'
      : '未检测到近重复记忆——每条知识都是独立的新知',
  }
}

/** 固化计划人话摘要。 */
function summarizeConsolidation(
  n: number,
  clusters: readonly ConsolidationCluster[],
  duplicates: number,
): string {
  const top = clusters[0]
  const multi = clusters.filter((c) => c.reinforcement >= 3).length
  const multiPart = multi > 0 ? `，其中 ${multi} 簇出现 ≥3 次（高频知识，已自然强化）` : ''
  return `${n} 条记忆中检测到 ${clusters.length} 组近重复（折叠 ${duplicates} 条冗余）${multiPart}——代表已按信息量选出，重复计数可作为复习强化信号`
}
