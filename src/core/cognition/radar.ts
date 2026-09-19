/**
 * 回声雷达（轴线 33「会话级复发检测」）：你的问题正在历史里回响。
 *
 * 设计动机：轴线 31「记忆固化」在**片段**粒度（问题→解法）折叠近重复；
 * 但人还有一种更隐蔽的重复——**整场会话级别的复发**：两周前问过
 * "docker 容器怎么互相访问"，今天又开了一场几乎一样的会话（标题换了、
 * 报错文件换了，主题纹丝不动）。片段级折叠看不见这种宏观浪费：
 * 每场会话里的问题片段各不相同，但会话作为整体是回声。
 *
 * 回声雷达把 MinHash-LSH 基础设施（复用轴线 31 同源实现，保证签名
 * 与阈值数学一致）应用到会话粒度，并回答三个片段级折叠回答不了的问题：
 *
 * - **回声簇**：哪些会话在整体上互为近重复（复用 consolidateMemories，
 *   输入换成会话级文本投影：标题 + 实体名——零转录重读）；
 * - **复发周期**：每簇的平均复发间隔（首末间隔 / (次数-1)）——
 *   "你平均每 12.3 天重新问一次 docker 网络"——这是把知识固化成
 *   模板/文档的最强信号：复发周期 < 遗忘阶梯（轴线 21）就意味着
 *   你总在遗忘后重新发现；
 * - **回声率**：近 N 天的新会话中，命中历史回声（簇内非首次出现）
 *   的占比——你的新对话有多少是在"重新发现已知"。
 *
 * 行动分层：复发 ≥3 次 → 建议固化为交接模板（模块 B）；恰好 2 次 →
 * 关注级提示。纯本地、零 LLM、零网络；纯函数、无状态、确定性。
 */

import { consolidateMemories, type ConsolidationItem } from './consolidation.js'

const DAY_MS = 24 * 3600_000

/** 雷达输入：单会话投影（标题 + 实体名由调用方拼接）。 */
export interface RadarSession {
  /** 会话 id。 */
  readonly id: string
  /** 会话创建时间（毫秒）。 */
  readonly at: number
  /** 会话级文本投影（推荐 `标题 + 实体名列表`，零转录重读）。 */
  readonly text: string
}

/** 雷达参数。 */
export interface RadarOptions {
  /** 回声率观察窗（天）；缺省 30。 */
  readonly days?: number
  /** 会话级归簇 Jaccard 阈值；缺省 0.55（会话比片段更长更杂，阈值略宽）。 */
  readonly jaccardThreshold?: number
  /** 参与雷达的会话上限（新近优先截断，与轴线 31 一致）；缺省 2000。 */
  readonly maxSessions?: number
}

/** 一个回声簇（同一主题的多次会话复发）。 */
export interface EchoCluster {
  /** 代表会话 id（信息量最大者，与轴线 31 同规则）。 */
  readonly representativeId: string
  /** 全部成员（时间序）。 */
  readonly memberIds: readonly string[]
  /** 复发次数（= 成员数）。 */
  readonly occurrences: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  /** 平均复发周期（天）；occurrences < 3 时为 null（两次出现无法估周期）。 */
  readonly recurrenceDays: number | null
  /** 簇紧致度（成员与代表的平均 Jaccard）。 */
  readonly cohesion: number
  /** 行动建议：≥3 次复发 → 固化模板；2 次 → 关注。 */
  readonly action: 'template' | 'watch'
}

/** 雷达报告。 */
export interface RadarReport {
  /** 参与雷达的会话数。 */
  readonly sessions: number
  /** 回声簇（按复发次数降序）。 */
  readonly clusters: readonly EchoCluster[]
  /** 回声覆盖的冗余会话数（簇成员数 − 簇数）。 */
  readonly duplicates: number
  /** 回声率观察窗（天）。 */
  readonly echoRateWindowDays: number
  /** 观察窗内新会话总数。 */
  readonly recentTotal: number
  /** 观察窗内命中历史回声的新会话数。 */
  readonly recentEchoes: number
  /** 回声率（recentEchoes / recentTotal；无样本为 0）。 */
  readonly echoRate: number
  /** 全部 ≥3 次簇的平均复发周期中位数（天）；无样本为 null。 */
  readonly medianRecurrenceDays: number | null
  /** 人话摘要。 */
  readonly summary: string
}

/** 构造主入口：会话级回声扫描。 */
export function scanSessionEchoes(
  sessions: readonly RadarSession[],
  options: RadarOptions = {},
): RadarReport {
  const days = Math.max(1, options.days ?? 30)
  const threshold = Math.min(0.95, Math.max(0.3, options.jaccardThreshold ?? 0.55))
  const maxSessions = Math.max(10, options.maxSessions ?? 2000)

  const ordered = [...sessions]
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  const pool = ordered.slice(-maxSessions)
  const n = pool.length
  const echoRateBase = {
    sessions: n,
    echoRateWindowDays: days,
    recentTotal: 0,
    recentEchoes: 0,
    echoRate: 0,
  }
  if (n < 2) {
    return {
      ...echoRateBase,
      clusters: [],
      duplicates: 0,
      medianRecurrenceDays: null,
      summary: n < 2 ? '会话不足 2 场，雷达待启动' : '会话文本投影为空，无法扫描回声',
    }
  }

  const items: ConsolidationItem[] = pool.map((s) => ({ id: s.id, text: s.text, at: s.at }))
  const plan = consolidateMemories(items, { jaccardThreshold: threshold })

  // id → 会话投影（算回声率与复发周期需要成员时间）。
  const byId = new Map(pool.map((s) => [s.id, s]))
  const clusters: EchoCluster[] = plan.clusters.map((cluster) => {
    const memberTimes = cluster.memberIds.map((id) => byId.get(id)?.at ?? 0)
    const recurrenceDays =
      cluster.reinforcement >= 3 && cluster.lastSeenAt > cluster.firstSeenAt
        ? Number(
            (
              (cluster.lastSeenAt - cluster.firstSeenAt) /
              (cluster.reinforcement - 1) /
              DAY_MS
            ).toFixed(1),
          )
        : null
    return {
      representativeId: cluster.representativeId,
      memberIds: cluster.memberIds,
      occurrences: cluster.reinforcement,
      firstSeenAt: cluster.firstSeenAt,
      lastSeenAt: cluster.lastSeenAt,
      recurrenceDays,
      cohesion: cluster.cohesion,
      action: cluster.reinforcement >= 3 ? 'template' : 'watch',
    }
  })

  // 回声率：观察窗内的新会话中，属于某簇且**非该簇时间序首个**的占比。
  const cutoff = pool[n - 1].at - days * DAY_MS
  const firstOfCluster = new Map<string, string>()
  for (const cluster of clusters) {
    firstOfCluster.set(cluster.memberIds[0], cluster.memberIds[0])
  }
  const echoedIds = new Set<string>()
  for (const cluster of clusters) {
    for (const id of cluster.memberIds.slice(1)) echoedIds.add(id)
  }
  let recentTotal = 0
  let recentEchoes = 0
  for (const session of pool) {
    if (session.at <= cutoff) continue
    recentTotal += 1
    if (echoedIds.has(session.id) && !firstOfCluster.has(session.id)) recentEchoes += 1
  }

  // 复发周期中位数（仅 ≥3 次的簇）。
  const periods = clusters
    .filter((c) => c.recurrenceDays !== null)
    .map((c) => c.recurrenceDays as number)
    .sort((a, b) => a - b)
  const medianRecurrenceDays =
    periods.length === 0 ? null : periods[Math.floor((periods.length - 1) / 2)]

  return {
    ...echoRateBase,
    recentTotal,
    recentEchoes,
    echoRate: recentTotal === 0 ? 0 : Number((recentEchoes / recentTotal).toFixed(4)),
    clusters,
    duplicates: plan.duplicates,
    medianRecurrenceDays,
    summary: summarize(n, clusters, plan.duplicates, recentEchoes, recentTotal, medianRecurrenceDays),
  }
}

/** 雷达报告人话摘要。 */
function summarize(
  n: number,
  clusters: readonly EchoCluster[],
  duplicates: number,
  recentEchoes: number,
  recentTotal: number,
  medianRecurrenceDays: number | null,
): string {
  if (clusters.length === 0) {
    return `${n} 场会话中未检测到整体级重复——每场对话都在开辟新主题`
  }
  const templateWorthy = clusters.filter((c) => c.action === 'template').length
  const echoPart =
    recentTotal > 0 ? `；近窗新会话回声率 ${Math.round((recentEchoes / recentTotal) * 100)}%` : ''
  const periodPart =
    medianRecurrenceDays !== null ? `，平均复发周期约 ${medianRecurrenceDays} 天` : ''
  const templatePart =
    templateWorthy > 0
      ? `——${templateWorthy} 个主题复发 ≥3 次，建议固化为交接模板`
      : '——复发尚在 2 次以内，保持关注即可'
  return `${n} 场会话中检测到 ${clusters.length} 组回声（${duplicates} 场冗余）${echoPart}${periodPart}${templatePart}`
}
