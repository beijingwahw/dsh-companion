/**
 * 相关性反馈学习（轴线 11）：把「你点击过什么」变成检索系统的先验知识。
 * 纯本地、纯统计——零 LLM、零网络，学习信号完全来自你自己的点击行为。
 *
 * 设计动机：混合引擎再聪明，也不知道「上周搜 deploy 时你最终打开的是
 * 哪个会话」——那个点击是用户亲手给出的相关性判决。经典 IR 的相关性
 * 反馈（Rocchio 家族）用查询向量修正来吸收这个信号；本模块做无嵌入
 * 约束下的等价物：
 *
 * - **画像（profile）**：每个会话维护一张「曾导致点击的查询词 × 计数」
 *   表。你在"部署"和"deploy"两个查询下都点击过会话 X → X 的画像同时
 *   记住这两个词，下次任一写法都能命中；
 * - **加成（boost）**：检索时对查询词与画像的重叠做饱和计数
 *   `matched / (matched + K)`，再乘点击新近度 `2^(-年龄/90天)` 与封顶
 *   强度 35%——乘性加成、相关性仍占主导，与轴线 9 的时序加成同构；
 * - **防漂移**：画像词项封顶（LRU 按计数淘汰）、单次点击只记有限词、
 *   半衰期让过时偏好自然遗忘——三条护栏保证学习不退化成偏见放大器。
 *
 * 隐私红线：反馈数据只存 companion 域本地表，永不外传。
 */
import { tokenize } from './tokenize.js'

/** 反馈加成封顶（35%：相关性主导，反馈只做温和先验）。 */
const MAX_BOOST = 0.35

/** 反馈记忆半衰期（天）：90 天前的点击权重衰减一半。 */
const HALF_LIFE_DAYS = 90

/** 词项匹配饱和常数：匹配数越大边际收益越低（防高频词刷分）。 */
const SATURATION = 2

/** 单个会话画像的词项上限（超限按计数淘汰最不活跃的词）。 */
const TERM_CAP = 200

/** 单次点击最多记录的查询词数（长查询只记头部词）。 */
const MAX_TERMS_PER_CLICK = 12

/** 天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 会话的点击画像（持久化形状；键 = 会话 id）。 */
export interface FeedbackProfile {
  /** 累计点击次数。 */
  clicks: number
  /** 曾导致点击的查询词 → 计数（该会话的「相关性签名」）。 */
  terms: Record<string, number>
  /** 最近一次点击时间（毫秒时间戳；新近度基准）。 */
  lastAt: number
}

/** 从损坏/旧格式记录恢复时的收窄辅助：静默丢弃非法记录。 */
export function sanitizeFeedbackProfile(raw: unknown): FeedbackProfile | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.lastAt !== 'number' || !Number.isFinite(record.lastAt)) return undefined
  const terms: Record<string, number> = {}
  if (typeof record.terms === 'object' && record.terms !== null) {
    for (const [term, count] of Object.entries(record.terms as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) terms[term] = count
    }
  }
  return {
    clicks: typeof record.clicks === 'number' && Number.isFinite(record.clicks) ? record.clicks : 0,
    terms,
    lastAt: record.lastAt,
  }
}

/**
 * 记录一次点击反馈：把查询词并入会话画像。
 * @param profile 现有画像（首次点击传 undefined）。
 * @param queryText 触发点击的查询文本（任意中英混合）。
 * @param at 点击时间（毫秒时间戳）。
 * @returns 更新后的画像（新对象；调用方负责持久化）。
 */
export function recordClick(
  profile: FeedbackProfile | undefined,
  queryText: string,
  at: number,
): FeedbackProfile {
  const terms: Record<string, number> = { ...(profile?.terms ?? {}) }
  // 去重保序后截头部：长查询只记最有信息量的前几个词。
  const fresh = [...new Set(tokenize(queryText))].slice(0, MAX_TERMS_PER_CLICK)
  for (const term of fresh) terms[term] = (terms[term] ?? 0) + 1
  // 词项封顶：超限时淘汰计数最低的词（LRU 式，保留长期活跃的相关性签名）。
  const entries = Object.entries(terms)
  if (entries.length > TERM_CAP) {
    entries.sort((a, b) => b[1] - a[1])
    const kept: Record<string, number> = {}
    for (const [term, count] of entries.slice(0, TERM_CAP)) kept[term] = count
    return { clicks: (profile?.clicks ?? 0) + 1, terms: kept, lastAt: Math.max(profile?.lastAt ?? 0, at) }
  }
  return { clicks: (profile?.clicks ?? 0) + 1, terms, lastAt: Math.max(profile?.lastAt ?? 0, at) }
}

/**
 * 计算查询对会话的反馈加成（乘性系数增量，范围 [0, MAX_BOOST]）。
 *
 * 公式：`boost = MAX_BOOST × matched/(matched+K) × 2^(-点击年龄/90天)`
 * - 无画像 / 无词项重叠 / 点击太久远 → 0（对排序零影响）；
 * - 词项匹配越多、点击越新 → 越接近 35% 封顶，但永不越过。
 *
 * @param profile 会话画像（无则 0）。
 * @param queryText 当前查询文本。
 * @param now 当前时间（毫秒时间戳）。
 */
export function feedbackBoost(
  profile: FeedbackProfile | undefined,
  queryText: string,
  now: number,
): number {
  if (profile === undefined || profile.clicks <= 0) return 0
  const queryTerms = new Set(tokenize(queryText))
  if (queryTerms.size === 0) return 0
  let matched = 0
  for (const term of queryTerms) matched += profile.terms[term] ?? 0
  if (matched <= 0) return 0
  const saturation = matched / (matched + SATURATION)
  const ageDays = Math.max(0, (now - profile.lastAt) / DAY_MS)
  const recency = Math.pow(2, -ageDays / HALF_LIFE_DAYS)
  return MAX_BOOST * saturation * recency
}

/** 反馈加成封顶常量（模块层展示用）。 */
export const FEEDBACK_MAX_BOOST = MAX_BOOST
