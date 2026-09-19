/**
 * Louvain 社区发现（轴线 26「知识大陆」）：把共现图切成模块度最大化的
 * 社区——你的知识自然聚成的大陆。
 *
 * 设计动机：轴线 13 的知识地图用「质心贪心聚类」按内容相似度分组，
 * 回答"哪些会话在谈相近的事"；本模块在**实体图**上做图结构划分，
 * 回答一个更本质的问题——"我的知识域有几块，每块的骨架实体是什么"。
 * 与质心聚类相比，图社区发现的优势：
 *
 * - **枢纽自动平衡**：高频实体（npm、docker）与谁都共现，质心聚类会把
 *   它们吸进一切簇；模块度最大化显式惩罚"随机连接的稠密"，枢纽只归
 *   属它连接最紧密的一块大陆；
 * - **层次自组织**：Louvain 两阶段迭代（局部移动 → 社区聚合）自动发现
 *   多尺度结构——小簇先聚合，聚合图上再聚合成大陆，无需预设簇数。
 *
 * 算法（Blondel et al. 2008，实践复杂度 ~O(n·log n)）：
 * - **阶段一（局部移动）**：节点逐个尝试移入邻居社区，取模块度增益
 *   最大者；增益 `ΔQ ∝ k_i,in(c) − Σ_tot(c)·k_i/2m`，逐节点 O(度数)；
 * - **阶段二（聚合）**：社区收缩为超节点，社区内边转为自环、跨社区
 *   边权相加——图规模逐层指数收缩，直到模块度无法再提升；
 * - 多层社区归属经「成员折叠表」逐层还原到原始实体。
 *
 * 图论约定（自环）：自环权重 s 计入邻接一次、计入度数两次；
 * m = Σ自环 + Σ无向边（单侧），恒有 2m = Σ度数。
 *
 * 纯本地、零 LLM、零网络；纯函数、无状态、可单测。
 */
import type { EntityGraph } from './graph.js';
/** 单个社区（一块「知识大陆」）。 */
export interface Community {
    /** 社区序号（按成员数降序重编）。 */
    readonly id: number;
    /** 成员实体（按度数降序）。 */
    readonly entities: ReadonlyArray<{
        key: string;
        name: string;
        type: string;
        /** 加权度数（该实体全部共现边权之和——大陆内的骨干程度）。 */
        degree: number;
        /** 覆盖会话数。 */
        sessions: number;
    }>;
    /** 成员数。 */
    readonly size: number;
    /** 社区覆盖的会话总数（成员会话集并集）。 */
    readonly sessionCount: number;
    /** 社区内部边权（内聚度；越高说明大陆越"抱团"）。 */
    readonly internalWeight: number;
    /** 代表实体（按度数降序的头部——社区命名建议）。 */
    readonly topEntities: ReadonlyArray<{
        name: string;
        type: string;
    }>;
}
/** 社区发现报告。 */
export interface CommunityReport {
    /** 最终划分的模块度 Q（∈[-0.5, 1]，越大划分越显著）。 */
    readonly modularity: number;
    /** Louvain 聚合层数（1 = 单轮局部移动即收敛）。 */
    readonly levels: number;
    /** 社区列表（按成员数降序）。 */
    readonly communities: readonly Community[];
    /** 图规模摘要。 */
    readonly graph: {
        nodes: number;
        edges: number;
    };
    /** 人话摘要。 */
    readonly summary: string;
}
/** Louvain 参数。 */
export interface LouvainOptions {
    /** 单层内局部移动的最大轮数；缺省 15。 */
    readonly maxPasses?: number;
    /** 最大聚合层数；缺省 10。 */
    readonly maxLevels?: number;
    /** 节点访问顺序扰动种子（0 = 稳定顺序）。 */
    readonly seed?: number;
}
/**
 * Louvain 社区发现主入口：在共现图上迭代「局部移动 + 聚合」，
 * 返回模块度最大化的社区划分与多层还原的成员归属。
 *
 * @param graph 共现图（buildEntityGraph 产物）。
 * @param options 参数（全部缺省即可用）。
 */
export declare function detectCommunities(graph: EntityGraph, options?: LouvainOptions): CommunityReport;
