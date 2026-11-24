/**
 * 意图预报引擎（intent forecasting）：从「记录你说过要做的事」到
 * 「预测你接下来要做什么」。
 *
 * 设计动机：轴线 20（前瞻记忆）已经能从对话里抽出「明天试试 X」这类
 * 承诺并在到期时浮现。但它是**被动记账**：只有你明确说了时间标记 +
 * 意图动词，才会形成一条意图。真实工作里有大量**未言明的意图**：
 * 你连续三场对话都在查同一个报错、你反复打开某个项目的配置、你在
 * 深夜时段集中处理某类任务——这些行为模式本身就是「你接下来大概率
 * 要做什么」的预测信号。
 *
 * 本引擎把意图预测从「抽取」升级为「**学习**」：用会话流的时间结构
 * 与主题结构，学习三类可计算的意图先验：
 *
 * 1. **节律先验（rhythm prior）**：把会话按「小时 × 星期」分桶，统计
 *    每个桶的主题分布。周五下午你大概率在看周报相关的东西，周一上午
 *    在处理积压——这是**时间→主题**的条件分布，用拉普拉斯平滑避免
 *    稀疏桶爆炸。预测：给定当前时刻，返回最可能的主题桶。
 *
 * 2. **延续先验（continuation prior）**：上一个会话的主题，是下一个
 *    会话主题的最强预测因子（工作会话的连续性）。算法：会话主题序列
 *    的一阶马尔可夫转移（主题 = 实体键集合的 Jaccard 聚类），
 *    拉普拉斯平滑；预测「接下来最可能延续的主题」。
 *
 * 3. **回访先验（return prior）**：某些主题呈周期性回访（你每 12 天
 *    重新问一次 docker 网络——轴线 33 的回声雷达在**事后**检测这个
 *    周期）。本引擎在**事前**预测：给定主题的历史回访间隔序列，用
 *    中位数间隔外推下一次回访窗口，当当前时间落入窗口时给出「你
 *    可能又要处理 X 了」的预测。
 *
 * 三类先验都是纯本地、确定性、可测的。输出统一为 `IntentForecast`，
 * 由洞察中心接入（「接下来你可能需要…」）或独立端点。
 *
 * 与轴线 20/33 的分工：
 * - 轴线 20 记录**你明确承诺的**未来意图（到期提醒）；
 * - 轴线 33 检测**已发生的**回声（事后统计）；
 * - 本引擎**预测**你未言明的下一步（事前推断）。
 * 三者共同构成「前瞻记忆」的完整闭环：承诺 → 预测 → 回声。
 */
import { tokenize } from '../retrieval/tokenize.js'

/** 单场会话的最小投影（意图预报的输入）。 */
export interface ForecastSession {
  /** 会话 id。 */
  readonly id: string
  /** 创建时间（毫秒时间戳）。 */
  readonly at: number
  /** 会话主题文本（标题 + 实体名拼接，零转录重读）。 */
  readonly text: string
}

/** 主题桶：一组语义相近的会话（Jaccard 聚类）。 */
export interface TopicBucket {
  /** 桶 id（b0、b1…按首次出现顺序）。 */
  readonly id: string
  /** 代表词（出现频次最高的 3 个词元）。 */
  readonly label: readonly string[]
  /** 桶内会话 id。 */
  readonly sessionIds: readonly string[]
}

/** 意图预测（三类先验之一）。 */
export type IntentForecastKind = 'rhythm' | 'continuation' | 'return'

/** 单条意图预测。 */
export interface IntentForecast {
  /** 预测类型。 */
  readonly kind: IntentForecastKind
  /** 预测的主题标签（词元）。 */
  readonly topic: readonly string[]
  /** 置信度 [0,1]（各类先验内部归一，跨类型近似可比）。 */
  readonly confidence: number
  /** 人话解释（为什么是这个预测）。 */
  readonly reason: string
}

/** 意图预报报告。 */
export interface IntentForecastReport {
  /** 当前时刻。 */
  readonly now: number
  /** 参与学习的会话数。 */
  readonly sessions: number
  /** 主题桶数。 */
  readonly topics: number
  /** 三类预测（按置信度降序，封顶 topK）。 */
  readonly forecasts: readonly IntentForecast[]
  /** 节律先验：当前时段的主题分布。 */
  readonly rhythmTopTopics: readonly TopicBucket[]
  /** 延续先验：当前主题的下一主题转移。 */
  readonly continuationTopTopics: readonly TopicBucket[]
  /** 回访先验：当前时间窗口内可能回访的主题。 */
  readonly returnTopTopics: readonly TopicBucket[]
  /** 人话摘要。 */
  readonly summary: string
}

/** 意图预报参数。 */
export interface IntentForecastOptions {
  /** 主题聚类的 Jaccard 阈值（缺省 0.35）。 */
  readonly topicThreshold?: number
  /** 返回预测条数上限（缺省 5）。 */
  readonly topK?: number
  /** 节律分桶的小时粒度（缺省 4：6 个桶/天）。 */
  readonly hourBuckets?: number
  /** 回访先验的最小历史间隔数（缺省 2）。 */
  readonly minReturnSamples?: number
}

/** 主题聚类缺省阈值。 */
const DEFAULT_TOPIC_THRESHOLD = 0.35

/** 每类预测返回上限。 */
const DEFAULT_TOP_K = 5

/** 节律分桶缺省粒度（小时）。 */
const DEFAULT_HOUR_BUCKETS = 4

/** 回访先验最小样本。 */
const DEFAULT_MIN_RETURN_SAMPLES = 2

/** 毫秒/天。 */
const DAY_MS = 86_400_000

/**
 * 会话主题聚类：按词元 Jaccard 做 leader-follower 聚类。
 *
 * 新会话优先（时间倒序）——簇由最新表述定义，旧表述向新表述靠拢
 * （与轴线 13 同纪律）。阈值 0.35 对中文短标题经验良好。
 */
export function clusterTopics(
  sessions: readonly ForecastSession[],
  threshold = DEFAULT_TOPIC_THRESHOLD,
): readonly TopicBucket[] {
  const ordered = [...sessions].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
  const buckets: Array<{ terms: Set<string>; sessionIds: string[]; termFreq: Map<string, number> }> = []
  for (const session of ordered) {
    const terms = new Set(tokenize(session.text))
    if (terms.size === 0) continue
    let bestIndex = -1
    let bestSimilarity = 0
    for (let index = 0; index < buckets.length; index += 1) {
      const similarity = jaccard(terms, buckets[index].terms)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestIndex = index
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= threshold) {
      const bucket = buckets[bestIndex]
      for (const term of terms) {
        bucket.terms.add(term)
        bucket.termFreq.set(term, (bucket.termFreq.get(term) ?? 0) + 1)
      }
      bucket.sessionIds.push(session.id)
    } else {
      const termFreq = new Map<string, number>()
      for (const term of terms) termFreq.set(term, 1)
      buckets.push({ terms, sessionIds: [session.id], termFreq })
    }
  }
  return buckets
    .filter((bucket) => bucket.sessionIds.length > 0)
    .map((bucket, index) => ({
      id: `b${index}`,
      label: [...bucket.termFreq.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([term]) => term),
      sessionIds: bucket.sessionIds,
    }))
}

/** Jaccard 相似度（空集按不相似处理）。 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 会话 → 主题桶下标（按词元重叠最大者归类）。 */
function topicIndexOf(
  session: ForecastSession,
  buckets: readonly TopicBucket[],
  threshold: number,
): number {
  const terms = new Set(tokenize(session.text))
  let bestIndex = -1
  let bestSimilarity = 0
  for (let index = 0; index < buckets.length; index += 1) {
    const bucketTerms = new Set(buckets[index].label)
    // 用代表词做快速匹配（完整 terms 未持久化，label 是可用代理）。
    const similarity = jaccard(terms, bucketTerms)
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      bestIndex = index
    }
  }
  return bestSimilarity >= threshold ? bestIndex : -1
}

/** 主题归属（会话 → 桶下标）。 */
function assignTopics(
  sessions: readonly ForecastSession[],
  buckets: readonly TopicBucket[],
  threshold: number,
): Map<string, number> {
  const assignment = new Map<string, number>()
  for (const session of sessions) {
    const index = topicIndexOf(session, buckets, threshold)
    if (index >= 0) assignment.set(session.id, index)
  }
  return assignment
}

/** 两个词元集合的 Jaccard（用于回访窗口的主题匹配）。 */
function topicSimilarity(a: readonly string[], b: readonly string[]): number {
  return jaccard(new Set(a), new Set(b))
}

/**
 * 节律先验：当前「小时 × 星期」桶内最活跃的主题。
 *
 * 拉普拉斯平滑：每个主题加 1 个伪计数，避免小样本桶给出 100% 置信。
 */
export function rhythmPrior(
  sessions: readonly ForecastSession[],
  buckets: readonly TopicBucket[],
  assignment: ReadonlyMap<string, number>,
  now: number,
  hourBuckets = DEFAULT_HOUR_BUCKETS,
): ReadonlyArray<{ topic: TopicBucket; confidence: number; reason: string }> {
  if (buckets.length === 0) return []
  const date = new Date(now)
  const hourBucket = Math.floor(date.getHours() / Math.max(1, Math.floor(24 / hourBuckets)))
  const dayOfWeek = date.getDay()
  const counts = new Array<number>(buckets.length).fill(0)
  let total = 0
  for (const session of sessions) {
    const index = assignment.get(session.id)
    if (index === undefined) continue
    const sessionDate = new Date(session.at)
    const sessionHourBucket = Math.floor(sessionDate.getHours() / Math.max(1, Math.floor(24 / hourBuckets)))
    if (sessionHourBucket !== hourBucket || sessionDate.getDay() !== dayOfWeek) continue
    counts[index] += 1
    total += 1
  }
  if (total === 0) return []
  // 拉普拉斯平滑：+1 伪计数 / (total + 桶数)。
  const smoothed = counts.map((count) => (count + 1) / (total + buckets.length))
  const ranked = smoothed
    .map((confidence, index) => ({ index, confidence }))
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
  return ranked.slice(0, 3).map(({ index, confidence }) => ({
    topic: buckets[index],
    confidence: Number(confidence.toFixed(4)),
    reason: `这个时段（${dayLabel(dayOfWeek)} ${hourLabel(hourBucket, hourBuckets)}）你历史上最常处理「${buckets[index].label.join('、')}」`,
  }))
}

/** 星期的人话标签。 */
function dayLabel(dayOfWeek: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayOfWeek] ?? '未知'
}

/** 小时桶的人话标签。 */
function hourLabel(bucket: number, hourBuckets: number): string {
  const span = Math.max(1, Math.floor(24 / hourBuckets))
  const start = bucket * span
  return `${start}:00-${start + span}:00`
}

/**
 * 延续先验：一阶马尔可夫转移——上一个会话的主题 → 下一个主题。
 *
 * 转移矩阵按会话时间序构建；拉普拉斯平滑；返回从「当前主题」出发
 * 最可能的 3 个下一主题。当前主题 = 最近一场会话的主题。
 */
export function continuationPrior(
  sessions: readonly ForecastSession[],
  buckets: readonly TopicBucket[],
  assignment: ReadonlyMap<string, number>,
): ReadonlyArray<{ topic: TopicBucket; confidence: number; reason: string }> {
  if (buckets.length < 2) return []
  const ordered = [...sessions].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  const transitions = new Map<number, Map<number, number>>()
  let previous: number | undefined
  for (const session of ordered) {
    const current = assignment.get(session.id)
    if (current === undefined) continue
    if (previous !== undefined && previous !== current) {
      const row = transitions.get(previous) ?? new Map<number, number>()
      row.set(current, (row.get(current) ?? 0) + 1)
      transitions.set(previous, row)
    }
    previous = current
  }
  // 当前主题 = 最近一场会话。
  const latest = [...sessions].sort((a, b) => b.at - a.at)[0]
  if (latest === undefined) return []
  const currentTopic = assignment.get(latest.id)
  if (currentTopic === undefined) return []
  const row = transitions.get(currentTopic)
  if (row === undefined) return []
  const total = [...row.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const ranked = [...row.entries()]
    .map(([index, count]) => ({ index, confidence: (count + 1) / (total + buckets.length) }))
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
  return ranked.slice(0, 3).map(({ index, confidence }) => ({
    topic: buckets[index],
    confidence: Number(confidence.toFixed(4)),
    reason: `你处理完「${buckets[currentTopic]?.label.join('、') ?? '当前主题'}」后，历史上最常接着处理「${buckets[index].label.join('、')}」`,
  }))
}

/**
 * 回访先验：主题的历史回访间隔中位数外推下一次回访窗口。
 *
 * 给定主题桶内会话的时间序列，计算相邻间隔，取中位数作为周期估计；
 * 若当前时间距最后一次会话已超过周期的 0.7 倍，认为「可能又要回访」。
 * 与轴线 33 的区别：33 是事后检测回声，本引擎是事前预测。
 */
export function returnPrior(
  sessions: readonly ForecastSession[],
  buckets: readonly TopicBucket[],
  assignment: ReadonlyMap<string, number>,
  now: number,
  minSamples = DEFAULT_MIN_RETURN_SAMPLES,
): ReadonlyArray<{ topic: TopicBucket; confidence: number; reason: string }> {
  const results: Array<{ topic: TopicBucket; confidence: number; reason: string }> = []
  for (let index = 0; index < buckets.length; index += 1) {
    const times = sessions
      .filter((session) => assignment.get(session.id) === index)
      .map((session) => session.at)
      .sort((a, b) => a - b)
    if (times.length < minSamples + 1) continue
    const intervals: number[] = []
    for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1])
    if (intervals.length < minSamples) continue
    const period = median(intervals)
    if (period <= 0) continue
    const sinceLast = now - times[times.length - 1]
    if (sinceLast < period * 0.7 || sinceLast > period * 2) continue
    // 置信度：间隔越稳定（变异系数越小）越可信。
    const variance = intervals.reduce((acc, value) => acc + (value - period) ** 2, 0) / intervals.length
    const coefficient = period > 0 ? Math.sqrt(variance) / period : 1
    const stability = Math.max(0.1, 1 - coefficient)
    const confidence = Number((stability * Math.min(1, sinceLast / period)).toFixed(4))
    results.push({
      topic: buckets[index],
      confidence,
      reason: `「${buckets[index].label.join('、')}」平均每 ${Math.round(period / DAY_MS)} 天回访一次，现在已到回访窗口`,
    })
  }
  results.sort((a, b) => b.confidence - a.confidence)
  return results.slice(0, 3)
}

/** 中位数。 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * 意图预报主入口：三类先验 → 统一预测列表。
 *
 * @param sessions 会话投影（时间 + 主题文本）。
 * @param now 当前时刻。
 * @param options 参数。
 */
export function forecastIntents(
  sessions: readonly ForecastSession[],
  now: number,
  options: IntentForecastOptions = {},
): IntentForecastReport {
  const threshold = options.topicThreshold ?? DEFAULT_TOPIC_THRESHOLD
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K)
  const hourBuckets = options.hourBuckets ?? DEFAULT_HOUR_BUCKETS
  if (sessions.length < 3) {
    return {
      now,
      sessions: sessions.length,
      topics: 0,
      forecasts: [],
      rhythmTopTopics: [],
      continuationTopTopics: [],
      returnTopTopics: [],
      summary: '会话样本不足（< 3 场）——意图预报需要至少几场对话才能学习节律与延续模式',
    }
  }
  const buckets = clusterTopics(sessions, threshold)
  const assignment = assignTopics(sessions, buckets, threshold)
  const rhythm = rhythmPrior(sessions, buckets, assignment, now, hourBuckets)
  const continuation = continuationPrior(sessions, buckets, assignment)
  const ret = returnPrior(sessions, buckets, assignment, now, options.minReturnSamples)

  const forecasts: Array<{ kind: IntentForecastKind; topic: TopicBucket; confidence: number; reason: string }> = []
  for (const item of rhythm) forecasts.push({ kind: 'rhythm', ...item })
  for (const item of continuation) forecasts.push({ kind: 'continuation', ...item })
  for (const item of ret) forecasts.push({ kind: 'return', ...item })
  forecasts.sort((a, b) => b.confidence - a.confidence)
  const top = forecasts.slice(0, topK).map<IntentForecast>(({ kind, topic, confidence, reason }) => ({
    kind,
    topic: topic.label,
    confidence,
    reason,
  }))

  return {
    now,
    sessions: sessions.length,
    topics: buckets.length,
    forecasts: top,
    rhythmTopTopics: rhythm.map((item) => item.topic),
    continuationTopTopics: continuation.map((item) => item.topic),
    returnTopTopics: ret.map((item) => item.topic),
    summary: summarizeIntents(top, buckets.length),
  }
}

/** 意图预报人话摘要。 */
function summarizeIntents(forecasts: readonly IntentForecast[], topics: number): string {
  if (forecasts.length === 0) {
    return `已从 ${topics} 个主题中学习，但当前时刻没有足够强的意图信号`
  }
  const top = forecasts[0]
  const kindLabel = top.kind === 'rhythm' ? '节律' : top.kind === 'continuation' ? '延续' : '回访'
  return `最强意图信号（${kindLabel}，置信度 ${(top.confidence * 100).toFixed(0)}%）：${top.reason}`
}
