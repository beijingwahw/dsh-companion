/**
 * 问题→解决片段提取（轴线 21/22 的共享基座）：对话里的「知识时刻」。
 *
 * 设计动机：会话转录的绝大部分是过程噪音，真正值得长期持有的
 * 是「问题 → 解法」对——它们是可迁移的结构化经验。本模块把
 * 转录压成片段序列，每个片段自带**结构形状**（约束类别 × 解法
 * 类别），供两条下游轴线消费：
 *
 * - 轴线 21（间隔重复）：片段即复习卡片——检索式练习的素材；
 * - 轴线 22（类比检索）：片段形状即匹配键——跨域同构发现。
 *
 * 提取策略（行级配对，纯本地规则）：
 * - **问题行**：含问题关键词（报错/失败/超时/error…）；
 * - **解法行**：含解法关键词（解决了/原来是/改成/fixed…）；
 * - **配对**：每个问题行向后找窗口内（8 行）最近的未占用解法行；
 * - **形状**：约束类别（性能/网络/配置/版本/依赖/数据/并发/认证/
 *   构建/接口）× 解法类别（改配置/换依赖/重构/绕过/顿悟）。
 *
 * 一个片段的形状相同而主题不同——这正是类比检索要找的同构。
 */
/** 约束类别（问题的结构属性）。 */
export type ConstraintKind = 'performance' | 'network' | 'config' | 'version' | 'dependency' | 'data' | 'concurrency' | 'auth' | 'build' | 'api';
/** 解法类别（解法的结构属性）。 */
export type ResolutionKind = 'config-fix' | 'dependency-change' | 'refactor' | 'workaround' | 'understanding';
/** 片段结构形状（类比匹配的键）。 */
export interface EpisodeShape {
    /** 约束类别标签（去重排序）。 */
    readonly constraints: readonly ConstraintKind[];
    /** 解法类别标签（去重排序）。 */
    readonly resolutions: readonly ResolutionKind[];
}
/** 单个问题→解决片段。 */
export interface Episode {
    /** 稳定内容 id（模块层拼上 sessionId 后全局唯一）。 */
    readonly id: string;
    /** 问题描述行（截断 200 字符）。 */
    readonly problem: string;
    /** 解法描述行（截断 200 字符）。 */
    readonly solution: string;
    /** 结构形状。 */
    readonly shape: EpisodeShape;
}
/** 单会话片段记录（存储形状；key = sessionId）。 */
export interface EpisodeRecord {
    /** 会话创建时间（复习调度的起点）。 */
    readonly createdAt: number;
    /** 该会话提取出的全部片段。 */
    readonly episodes: readonly Episode[];
}
/** 空形状（无任何类别命中的兜底）。 */
export declare const EMPTY_SHAPE: EpisodeShape;
/**
 * 从文本提取结构形状：命中的约束类别 × 解法类别。
 * 问题文本与解法文本分别提取后由调用方合并（或直接对整段提取）。
 */
export declare function extractShape(text: string): EpisodeShape;
/**
 * 从会话转录提取问题→解决片段。
 *
 * 行级扫描 + 窗口配对：每个问题行消费其后窗口内最近的一个未占用
 * 解法行；未被配对的问题行/解法行静默丢弃（单边信号不成知识）。
 *
 * @param text 会话转录。
 */
export declare function extractEpisodes(text: string): readonly Episode[];
/** 合并两个形状（约束取并、解法取并，各自排序去重）。 */
export declare function mergeShape(a: EpisodeShape, b: EpisodeShape): EpisodeShape;
/** 存储读出的片段记录净化：非法记录静默丢弃。 */
export declare function sanitizeEpisodeRecord(raw: unknown): EpisodeRecord | undefined;
/** 全部约束类别（展示顺序）。 */
export declare const CONSTRAINT_KINDS: readonly ConstraintKind[];
/** 全部解法类别（展示顺序）。 */
export declare const RESOLUTION_KINDS: readonly ResolutionKind[];
