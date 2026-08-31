import { type EpisodeShape } from './episodes.js';
/** 单条类比命中。 */
export interface AnalogyHit {
    /** 片段 id（sessionId:hash）。 */
    readonly episodeId: string;
    /** 来源会话 id。 */
    readonly sessionId: string;
    /** 来源会话标题（调用方补齐；可缺省）。 */
    readonly title?: string;
    /** 问题面（历史问题的描述）。 */
    readonly problem: string;
    /** 解法面（历史解法的描述）。 */
    readonly solution: string;
    /** 形状相似度（0..1）。 */
    readonly score: number;
    /** 共享约束类别（同构证据）。 */
    readonly sharedConstraints: readonly string[];
    /** 共享解法类别。 */
    readonly sharedResolutions: readonly string[];
    /** 跨域类比（true = 主题不同而结构同构——最有价值的命中）。 */
    readonly crossDomain: boolean;
    /** 主题词元重叠度（0..1；低重叠 + 高形状分 = crossDomain）。 */
    readonly termOverlap: number;
    /** 来源会话创建时间。 */
    readonly createdAt: number;
}
/** 类比检索结果。 */
export interface AnalogyReport {
    /** 查询形状（溯源：从你的描述提取到的结构标签）。 */
    readonly queryShape: EpisodeShape;
    /** 按相似度降序的类比命中。 */
    readonly analogies: readonly AnalogyHit[];
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 形状相似度：0.7 × 约束重叠系数 + 0.3 × 解法重叠系数（约束主导——
 * 问题像不像比解法像不像更重要）。
 *
 * 用重叠系数（交集 / 较小集大小）而非 Jaccard：查询侧常附带偶发
 * 约束（问网络问题时顺带提到「调用」），Jaccard 把这些噪声约束当成
 * 结构差异惩罚；类比关心的是「历史问题的结构是否被当前问题包含」，
 * 结构子类型也应算同构。双空 → 0（无形状信息不构成类比证据）。
 */
export declare function shapeSimilarity(a: EpisodeShape, b: EpisodeShape): number;
/**
 * 类比检索：给定当前问题描述，在片段库中找结构同构的历史经验。
 *
 * @param queryText 当前问题的自然语言描述。
 * @param episodes sessionId → 片段记录。
 * @param titles sessionId → 会话标题（可选，命中展示用）。
 */
export declare function findAnalogies(queryText: string, episodes: ReadonlyMap<string, import('./episodes.js').EpisodeRecord>, titles?: ReadonlyMap<string, string | undefined>): AnalogyReport;
