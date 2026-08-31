/**
 * 多样性重排（轴线 12）：MMR（Maximal Marginal Relevance，最大边际相关）。
 *
 * 设计动机：混合引擎按相关度排序天然偏好「同一话题的近似文档」——
 * 搜"部署"时头部可能挤满 8 个讲同一件事的会话，而你真正想要的另一
 * 个相关话题被挤到第二屏。MMR 是工业界（搜索摘要/推荐）处理该问题的
 * 标准答案：贪心选择，每一步都最大化
 *
 * `MMR = λ × 相关度 − (1−λ) × 与已选集合的最大相似度`
 *
 * - λ = 1 退化为纯相关度排序（现状）；
 * - λ = 0 退化为纯多样性（最不相似优先）；
 * - 缺省 λ = 0.7：相关性仍主导，仅在「已选里已有高度相似的」时压制
 *   同质候选——头部从「最优的重复」变成「最优且互补的组合」。
 *
 * 相似度用文档 trigram 哈希向量的余弦（engine.docGramVector），与语义
 * 通道同一形状度量，无需任何额外索引。
 */
/** MMR 缺省权衡系数（0.7：相关性主导，多样性做温和修正）。 */
export declare const DEFAULT_MMR_LAMBDA = 0.7;
/** 触发多样性重排的最小候选池规模（更小的池无同质化可言）。 */
export declare const MMR_MIN_POOL = 3;
/** 多样性重排的元信息（响应携带，客户端展示用）。 */
export interface DiversityInfo {
    /** 是否实际执行了重排（候选池不足时跳过，保持原序）。 */
    readonly applied: boolean;
    /** 参与重排的候选池规模。 */
    readonly pool: number;
    /** 权衡系数 λ。 */
    readonly lambda: number;
}
/**
 * 通用 MMR 贪心选择：从候选池中选出 `limit` 个「相关且互补」的条目。
 * 纯函数、零副作用——条目的相关度与两两相似度均由调用方注入。
 *
 * @param pool 候选池（任意顺序；内部先按相关度建索引）。
 * @param relevanceOf 条目相关度（越大越相关）。
 * @param similarityOf 两条目的相似度（[0, 1]）。
 * @param limit 选择条数（超出池规模时选全部）。
 * @param lambda 相关性/多样性权衡（缺省 0.7）。
 * @returns 选中的条目（按 MMR 得分降序，即推荐展示顺序）。
 */
export declare function mmrSelect<T>(pool: readonly T[], relevanceOf: (item: T) => number, similarityOf: (a: T, b: T) => number, limit: number, lambda?: number): T[];
/**
 * 计算多样性重排的候选池规模：`min(2 × limit, 上限, 命中总数)`——
 * 池略大于返回条数，给多样性留挑选余地，同时控制两两比较成本。
 */
export declare function diversityPoolSize(limit: number, totalHits: number): number;
