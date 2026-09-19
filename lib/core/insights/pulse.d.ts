/**
 * 主动洞察引擎（轴线 18）：从「你问它答」到「它主动告诉你」。
 *
 * 设计动机：前 17 条轴线全部是反应式的——用户发起动作，系统响应。
 * 但系统在服务过程中持续积累着值得主动告知的信号：反复失败的搜索
 * （盲区）、越用越准的反馈画像（学习状态）、索引的覆盖健康。这些
 * 信号散落在各处，用户不问就永远看不见。
 *
 * 本模块是**信号提供者注入式**的聚合引擎：
 *
 * - 核心纯函数 `composePulse` 接收任意多个信号提供者的快照，
 *   统一为洞察卡片（分类 + 严重度 + 文本 + 建议动作）；
 * - 严重度驱动排序：critical > watch > info；
 * - 每卡片独立可解释（附信号来源），洞察不是黑箱推送；
 * - 模块独立性保持：现阶段由检索模块（E）注入盲区/学习/索引三类
 *   信号；架构上开放——任何模块未来可注册自己的信号提供者，
 *   聚合层不感知来源细节。
 *
 * 「Daily Pulse」语义：每次调用基于当前状态即时合成，无缓存无状态，
 * 同一时刻的两次调用产生相同结果（可测试性）。
 */
/** 洞察分类（决定展示分组与图标语义）。 */
export type InsightCategory = 'blindspot' | 'learning' | 'index' | 'cost' | 'context' | 'topic' | 'intention' | 'review' | 'forecast' | 'echo';
/** 洞察严重度（驱动排序与视觉强调）。 */
export type InsightSeverity = 'critical' | 'watch' | 'info';
/** 单条洞察卡片。 */
export interface InsightCard {
    /** 洞察分类。 */
    readonly category: InsightCategory;
    /** 严重度（critical > watch > info 排序）。 */
    readonly severity: InsightSeverity;
    /** 洞察正文（一句话陈述事实）。 */
    readonly text: string;
    /** 建议动作（一句话可执行指引；可缺省——纯知会型洞察）。 */
    readonly action?: string;
    /** 信号来源标识（可解释性：卡片来自哪个提供者）。 */
    readonly source: string;
}
/** 脉搏报告（一次主动合成的全部洞察）。 */
export interface PulseReport {
    /** 按严重度降序的洞察卡片。 */
    readonly cards: readonly InsightCard[];
    /** 人话摘要（无洞察时为「一切正常」类陈述）。 */
    readonly summary: string;
    /** 合成时间戳。 */
    readonly generatedAt: number;
}
/** 信号提供者：返回该来源此刻的全部洞察卡片。 */
export type InsightProvider = () => readonly InsightCard[];
/**
 * 合成当前脉搏：聚合全部信号提供者，按严重度排序，封顶 6 条。
 *
 * @param providers 信号提供者列表（空列表合法——返回空脉搏）。
 * @param now 合成时间戳。
 */
export declare function composePulse(providers: readonly InsightProvider[], now: number): PulseReport;
/** 盲区信号 → 洞察卡片（轴线 19 的主动化出口）。 */
export declare function blindSpotInsights(report: {
    blindSpots: ReadonlyArray<{
        anchor: string;
        searches: number;
        advice: string;
    }>;
}): readonly InsightCard[];
/** 学习状态信号 → 洞察卡片（轴线 11 的饱和度播报）。 */
export declare function learningInsights(stats: {
    profiledSessions: number;
    totalClicks: number;
}): readonly InsightCard[];
/** 索引健康信号 → 洞察卡片（覆盖与新鲜度）。 */
export declare function indexInsights(stats: {
    indexedSessions: number;
    totalSessions: number;
    lastSyncAt: number | null;
    now: number;
}): readonly InsightCard[];
/** 到期意图信号 → 洞察卡片（轴线 20 的主动化出口）。 */
export declare function dueIntentionInsights(due: ReadonlyArray<{
    text: string;
    overdueDays: number;
}>): readonly InsightCard[];
/** 到期复习信号 → 洞察卡片（轴线 21 的主动化出口）。 */
export declare function dueReviewInsights(due: ReadonlyArray<{
    fresh: boolean;
}>): readonly InsightCard[];
/** 片段资产信号 → 洞察卡片（轴线 21/22 的库容播报）。 */
export declare function episodeInsights(stats: {
    episodes: number;
    sessionsWithEpisodes: number;
    crossDomainReady: boolean;
}): readonly InsightCard[];
/** 遗忘预测信号 → 洞察卡片（轴线 23 的主动化出口）。 */
export declare function forgettingForecastInsights(stats: {
    criticalCount: number;
    warningCount: number;
    stableCount: number;
}): readonly InsightCard[];
/** 节律自适应信号 → 洞察卡片（轴线 24：显著偏离才播报，冷启动静默）。 */
export declare function rhythmInsights(profile: {
    remembered: number;
    forgotten: number;
    ease: number;
}): readonly InsightCard[];
/** 负荷调度信号 → 洞察卡片（轴线 25：只在洪峰时开口——顺延发生才有值得说的）。 */
export declare function loadInsights(plan: {
    totalDue: number;
    todayCount: number;
    deferredCount: number;
}): readonly InsightCard[];
/** 主题漂移信号 → 洞察卡片（轴线 30：注意力结构变化的主动播报）。 */
export declare function driftInsights(stats: {
    unitCount: number;
    changepoints: number;
    currentRunLength: number;
    lastUnitSurprise: number;
    currentRunTopTerms: readonly string[];
}): readonly InsightCard[];
/** 记忆固化信号 → 洞察卡片（轴线 31：近重复 = 天然强化证据）。 */
export declare function consolidationInsights(stats: {
    items: number;
    clusters: number;
    duplicates: number;
    topReinforcement: number;
}): readonly InsightCard[];
/** 回声雷达信号 → 洞察卡片（轴线 33：会话级复发 = 固化模板信号）。 */
export declare function echoRadarInsights(stats: {
    sessions: number;
    clusters: number;
    duplicates: number;
    templateWorthy: number;
    recentEchoes: number;
    recentTotal: number;
    medianRecurrenceDays: number | null;
}): readonly InsightCard[];
