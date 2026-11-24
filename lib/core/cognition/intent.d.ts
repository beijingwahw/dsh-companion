/** 单场会话的最小投影（意图预报的输入）。 */
export interface ForecastSession {
    /** 会话 id。 */
    readonly id: string;
    /** 创建时间（毫秒时间戳）。 */
    readonly at: number;
    /** 会话主题文本（标题 + 实体名拼接，零转录重读）。 */
    readonly text: string;
}
/** 主题桶：一组语义相近的会话（Jaccard 聚类）。 */
export interface TopicBucket {
    /** 桶 id（b0、b1…按首次出现顺序）。 */
    readonly id: string;
    /** 代表词（出现频次最高的 3 个词元）。 */
    readonly label: readonly string[];
    /** 桶内会话 id。 */
    readonly sessionIds: readonly string[];
}
/** 意图预测（三类先验之一）。 */
export type IntentForecastKind = 'rhythm' | 'continuation' | 'return';
/** 单条意图预测。 */
export interface IntentForecast {
    /** 预测类型。 */
    readonly kind: IntentForecastKind;
    /** 预测的主题标签（词元）。 */
    readonly topic: readonly string[];
    /** 置信度 [0,1]（各类先验内部归一，跨类型近似可比）。 */
    readonly confidence: number;
    /** 人话解释（为什么是这个预测）。 */
    readonly reason: string;
}
/** 意图预报报告。 */
export interface IntentForecastReport {
    /** 当前时刻。 */
    readonly now: number;
    /** 参与学习的会话数。 */
    readonly sessions: number;
    /** 主题桶数。 */
    readonly topics: number;
    /** 三类预测（按置信度降序，封顶 topK）。 */
    readonly forecasts: readonly IntentForecast[];
    /** 节律先验：当前时段的主题分布。 */
    readonly rhythmTopTopics: readonly TopicBucket[];
    /** 延续先验：当前主题的下一主题转移。 */
    readonly continuationTopTopics: readonly TopicBucket[];
    /** 回访先验：当前时间窗口内可能回访的主题。 */
    readonly returnTopTopics: readonly TopicBucket[];
    /** 人话摘要。 */
    readonly summary: string;
}
/** 意图预报参数。 */
export interface IntentForecastOptions {
    /** 主题聚类的 Jaccard 阈值（缺省 0.35）。 */
    readonly topicThreshold?: number;
    /** 返回预测条数上限（缺省 5）。 */
    readonly topK?: number;
    /** 节律分桶的小时粒度（缺省 4：6 个桶/天）。 */
    readonly hourBuckets?: number;
    /** 回访先验的最小历史间隔数（缺省 2）。 */
    readonly minReturnSamples?: number;
}
/**
 * 会话主题聚类：按词元 Jaccard 做 leader-follower 聚类。
 *
 * 新会话优先（时间倒序）——簇由最新表述定义，旧表述向新表述靠拢
 * （与轴线 13 同纪律）。阈值 0.35 对中文短标题经验良好。
 */
export declare function clusterTopics(sessions: readonly ForecastSession[], threshold?: number): readonly TopicBucket[];
/**
 * 节律先验：当前「小时 × 星期」桶内最活跃的主题。
 *
 * 拉普拉斯平滑：每个主题加 1 个伪计数，避免小样本桶给出 100% 置信。
 */
export declare function rhythmPrior(sessions: readonly ForecastSession[], buckets: readonly TopicBucket[], assignment: ReadonlyMap<string, number>, now: number, hourBuckets?: number): ReadonlyArray<{
    topic: TopicBucket;
    confidence: number;
    reason: string;
}>;
/**
 * 延续先验：一阶马尔可夫转移——上一个会话的主题 → 下一个主题。
 *
 * 转移矩阵按会话时间序构建；拉普拉斯平滑；返回从「当前主题」出发
 * 最可能的 3 个下一主题。当前主题 = 最近一场会话的主题。
 */
export declare function continuationPrior(sessions: readonly ForecastSession[], buckets: readonly TopicBucket[], assignment: ReadonlyMap<string, number>): ReadonlyArray<{
    topic: TopicBucket;
    confidence: number;
    reason: string;
}>;
/**
 * 回访先验：主题的历史回访间隔中位数外推下一次回访窗口。
 *
 * 给定主题桶内会话的时间序列，计算相邻间隔，取中位数作为周期估计；
 * 若当前时间距最后一次会话已超过周期的 0.7 倍，认为「可能又要回访」。
 * 与轴线 33 的区别：33 是事后检测回声，本引擎是事前预测。
 */
export declare function returnPrior(sessions: readonly ForecastSession[], buckets: readonly TopicBucket[], assignment: ReadonlyMap<string, number>, now: number, minSamples?: number): ReadonlyArray<{
    topic: TopicBucket;
    confidence: number;
    reason: string;
}>;
/**
 * 意图预报主入口：三类先验 → 统一预测列表。
 *
 * @param sessions 会话投影（时间 + 主题文本）。
 * @param now 当前时刻。
 * @param options 参数。
 */
export declare function forecastIntents(sessions: readonly ForecastSession[], now: number, options?: IntentForecastOptions): IntentForecastReport;
