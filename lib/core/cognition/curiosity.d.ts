import type { EntityGraph } from '../graph/graph.js';
/** 好奇心信号类型。 */
export type CuriosityKind = 'gap' | 'decay' | 'bridge';
/** 严重度（沿用洞察三档，便于直接接入 feed）。 */
export type CuriositySeverity = 'critical' | 'watch' | 'info';
/** 知识缺口信号：两块成型大陆之间缺少翻译层。 */
export interface GapSignal {
    readonly kind: 'gap';
    /** 两侧社区的代表实体（各最多 3 个）。 */
    readonly leftTerms: readonly string[];
    readonly rightTerms: readonly string[];
    /** 左社区规模（实体数）。 */
    readonly leftSize: number;
    /** 右社区规模。 */
    readonly rightSize: number;
    /** 社区间边数。 */
    readonly crossEdges: number;
    /** 社区内边密度基准（两侧加权平均）。 */
    readonly internalDensity: number;
    /** 缺口分 [0,1]：越大越值得打通。 */
    readonly score: number;
    /** 严重度。 */
    readonly severity: CuriositySeverity;
}
/** 衰减先兆信号：曾经的枢纽主题正在退烧。 */
export interface DecaySignal {
    readonly kind: 'decay';
    /** 主题锚实体名。 */
    readonly anchor: string;
    /** 近期活跃度（指数平滑）。 */
    readonly recent: number;
    /** 历史基线活跃度。 */
    readonly baseline: number;
    /** 衰减比（recent / baseline）。 */
    readonly ratio: number;
    /** 图上度数（重要性代理）。 */
    readonly degree: number;
    /** 衰减分 [0,1]。 */
    readonly score: number;
    readonly severity: CuriositySeverity;
}
/** 桥接机会信号：时间上交替活跃但图上疏远的主题对。 */
export interface BridgeSignal {
    readonly kind: 'bridge';
    /** 主题 A / B 的代表实体。 */
    readonly left: string;
    readonly right: string;
    /** 活跃度序列的 Spearman 相关（负 = 交替）。 */
    readonly correlation: number;
    /** 图上最短路径跳数（≥ 3 才算疏远；不可达为 null）。 */
    readonly hopDistance: number | null;
    readonly score: number;
    readonly severity: CuriositySeverity;
}
/** 好奇心信号（三类联合）。 */
/** 好奇心报告。 */
export interface CuriosityReport {
    /** 参与分析的实体数。 */
    readonly entities: number;
    /** 社区数。 */
    readonly communities: number;
    /** 缺口信号（按分降序）。 */
    readonly gaps: readonly GapSignal[];
    /** 衰减信号（按分降序）。 */
    readonly decays: readonly DecaySignal[];
    /** 桥接信号（按分降序）。 */
    readonly bridges: readonly BridgeSignal[];
    /** 人话摘要。 */
    readonly summary: string;
}
/** 好奇心引擎参数。 */
export interface CuriosityOptions {
    /** 返回信号条数上限（每类）。 */
    readonly topK?: number;
    /** 衰减检测的近期窗口（单元数）。 */
    readonly recentWindow?: number;
    /** 衰减检测的历史基线窗口（单元数）。 */
    readonly baselineWindow?: number;
    /** 缺口判定的最小社区规模。 */
    readonly minCommunitySize?: number;
    /** 桥接判定的最小跳数。 */
    readonly minBridgeHop?: number;
    /** 活跃度序列（实体 → 时间序计数字典），由调用方提供。 */
    readonly activity?: ReadonlyMap<string, readonly number[]>;
}
/**
 * 计算共现图上的**结构性知识缺口**。
 *
 * 算法：
 * 1. Louvain 社区发现（复用轴线 26 实现）；
 * 2. 对每对社区 (i, j)：crossEdges = 跨社区边权，internal = 两社区
 *    内部边密度（边权 / 可能边数）的加权平均；
 * 3. 缺口分 = (1 − crossEdges / max(internal, ε)) × 规模项；
 *    规模项 = log(minSize) / log(maxSize)，两侧都大才值得打通。
 *
 * 与轴线 34 的分工：暗物质找「有共同邻居的实体对」，缺口找「两个
 * 已成型社区之间没有桥」——前者是微观补边，后者是宏观打通。
 */
export declare function detectKnowledgeGaps(graph: EntityGraph, options?: CuriosityOptions): readonly GapSignal[];
/**
 * 检测**注意力退潮**：曾经活跃的主题正在降温，且它在图上仍是枢纽。
 *
 * 输入是每个实体的活跃度时间序列（由调用方从会话时间线投影）。
 * 算法：近 `recentWindow` 点的均值 vs 前 `baselineWindow` 点的均值；
 * ratio = recent / baseline；衰减分 = (1 − ratio) × 度数权重（度数经
 * log 压缩，避免超级枢纽垄断）。
 */
export declare function detectDecay(graph: EntityGraph, activity: ReadonlyMap<string, readonly number[]>, options?: CuriosityOptions): readonly DecaySignal[];
/**
 * 检测**桥接机会**：两个主题在时间上交替活跃，但图上疏远。
 *
 * 算法：
 * 1. 对每对实体计算活跃度序列的 Spearman 秩相关（负 = 交替）；
 * 2. 图上 BFS 最短路径 ≥ minBridgeHop（说明认知上疏远）；
 * 3. 分 = |负相关| × 疏远度（跳数归一）。
 */
export declare function detectBridges(graph: EntityGraph, activity: ReadonlyMap<string, readonly number[]>, options?: CuriosityOptions): readonly BridgeSignal[];
/**
 * 好奇心引擎主入口：一次性产出三类信号与人话摘要。
 *
 * @param graph 实体共现图（轴线 26 同源）。
 * @param activity 实体活跃度时间序列（实体键 → 按时间序的计数字典）。
 * @param options 参数。
 */
export declare function computeCuriosity(graph: EntityGraph, activity: ReadonlyMap<string, readonly number[]>, options?: CuriosityOptions): CuriosityReport;
/** 从会话实体投影构建活跃度序列（时间分桶）。 */
export declare function buildActivitySeries(sessions: ReadonlyArray<{
    at: number;
    entityKeys: readonly string[];
}>, buckets: number, now: number, windowMs: number): Map<string, number[]>;
/** 词元集合（供外部做主题词提取）。 */
export declare function curiosityTokens(text: string): readonly string[];
