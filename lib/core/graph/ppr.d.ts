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
import type { EntityGraph } from './graph.js';
/** PageRank 参数。 */
export interface PageRankOptions {
    /** 阻尼系数（回到邻居的概率）；缺省 0.85。 */
    readonly damping?: number;
    /** 幂迭代最大轮数；缺省 50。 */
    readonly maxIterations?: number;
    /** L1 收敛阈值；缺省 1e-6。 */
    readonly tolerance?: number;
}
/** 单个排序结果实体。 */
export interface PageRankNode {
    readonly key: string;
    readonly name: string;
    readonly type: string;
    /** 稳态 PPR 分数（Σ=1；相对引力强度）。 */
    readonly score: number;
    /** 是否种子实体（出发点）。 */
    readonly seed: boolean;
    /** 距最近种子的 BFS 跳数（孤立项为 null）。 */
    readonly hopDistance: number | null;
}
/**
 * 个性化 PageRank 主入口：从种子实体出发的带重启随机游走稳态分布。
 *
 * @param graph 共现图（buildEntityGraph 产物）。
 * @param seeds 种子权重（实体键 → 强度；会被归一，空映射返回空结果）。
 * @param options 参数（全部缺省即可用）。
 */
export declare function personalizedPageRank(graph: EntityGraph, seeds: ReadonlyMap<string, number>, options?: PageRankOptions): PageRankNode[];
/**
 * 从自然语言查询构造种子权重：查询词元命中实体名（子串或词元包含）
 * 即为种子，权重 = 命中词元数 × 稀有度加成（覆盖会话越少的实体，
 * 命中信号越强——长尾实体名几乎不会误命中）。
 *
 * @param graph 共现图。
 * @param queryText 查询文本（任意中英混合）。
 * @returns 种子权重表（无命中返回空映射）。
 */
export declare function seedFromQuery(graph: EntityGraph, queryText: string): Map<string, number>;
