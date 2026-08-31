/** 会话的点击画像（持久化形状；键 = 会话 id）。 */
export interface FeedbackProfile {
    /** 累计点击次数。 */
    clicks: number;
    /** 曾导致点击的查询词 → 计数（该会话的「相关性签名」）。 */
    terms: Record<string, number>;
    /** 最近一次点击时间（毫秒时间戳；新近度基准）。 */
    lastAt: number;
}
/** 从损坏/旧格式记录恢复时的收窄辅助：静默丢弃非法记录。 */
export declare function sanitizeFeedbackProfile(raw: unknown): FeedbackProfile | undefined;
/**
 * 记录一次点击反馈：把查询词并入会话画像。
 * @param profile 现有画像（首次点击传 undefined）。
 * @param queryText 触发点击的查询文本（任意中英混合）。
 * @param at 点击时间（毫秒时间戳）。
 * @returns 更新后的画像（新对象；调用方负责持久化）。
 */
export declare function recordClick(profile: FeedbackProfile | undefined, queryText: string, at: number): FeedbackProfile;
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
export declare function feedbackBoost(profile: FeedbackProfile | undefined, queryText: string, now: number): number;
/** 反馈加成封顶常量（模块层展示用）。 */
export declare const FEEDBACK_MAX_BOOST = 0.35;
