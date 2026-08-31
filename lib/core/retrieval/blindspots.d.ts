/**
 * 检索盲区分析（轴线 19）：知道自己不知道什么。
 *
 * 设计动机：检索系统的失败有两种——「搜到了但不好」（轴线 10 诊断、
 * 轴线 16 救援已覆盖）和「根本搜不到」反复发生却无人察觉。后者是
 * 知识资产的盲区：你反复想找某类对话，但历史里压根没有——
 * 这是「该补什么知识」的最真实信号。
 *
 * 本模块在零命中查询日志（`retrieval-misses` 表，轴线 19 新增）之上
 * 做纯本地聚合：
 *
 * - **词元级聚合**：同主题的多次失败搜索合并计数（「rust 错误处理」
 *   和「rust 错误」共享词元 rust/错误 → 同一盲区的两次敲击）；
 * - **盲区评分**：`搜索次数 × log(1 + 停留天数)` × 新近度——反复搜、
 *   最近还在搜的主题得分最高；
 * - **可行动建议**：每个盲区生成一句话建议（「这个主题在你的历史
 *   对话中不存在——是有价值的新话题，还是用词与历史习惯不一致？」）。
 *
 * 苏格拉底式的知识管理：检索系统不只想「帮你找到已知的」，
 * 还想「让你看见未知的」。
 */
/** 单条零命中查询的内存视图（存储记录的规范化形状）。 */
export interface MissRecord {
    /** 原始查询文本。 */
    readonly query: string;
    /** 该查询的零命中次数。 */
    readonly count: number;
    /** 首次零命中时间（毫秒时间戳；盲区持续时长的起点；旧记录可能缺省）。 */
    readonly firstAt?: number;
    /** 最近一次零命中时间（毫秒时间戳）。 */
    readonly lastAt: number;
}
/** 单个检索盲区。 */
export interface RetrievalBlindSpot {
    /** 盲区主题词（聚合锚，小写规范化）。 */
    readonly anchor: string;
    /** 该主题的零命中搜索总次数。 */
    readonly searches: number;
    /** 相关查询原形（去重，最近优先，≤3 条）。 */
    readonly queries: readonly string[];
    /** 最近一次零命中时间。 */
    readonly lastAt: number;
    /** 盲区强度（降序展示）。 */
    readonly score: number;
    /** 一句话建议。 */
    readonly advice: string;
}
/** 盲区分析结果。 */
export interface BlindSpotReport {
    /** 零命中日志的去重查询总数。 */
    readonly totalMisses: number;
    /** 按强度降序的盲区列表。 */
    readonly blindSpots: readonly RetrievalBlindSpot[];
    /** 人话摘要。 */
    readonly summary: string;
}
/** 分析时间基准选项。 */
export interface BlindSpotOptions {
    /** 当前时间（缺省由调用方传入；测试可注入固定值）。 */
    readonly now: number;
}
/**
 * 聚合零命中日志为盲区报告。
 *
 * 聚合策略：每条零命中查询拆词元；每个词元独立累计（次数继承自查询
 * 计数），词元即盲区锚——多主题长查询（「rust 错误处理 vs go」）会
 * 同时给 rust 和 go 两个锚记一次敲击，这正是期望的语义。
 *
 * @param records 零命中查询记录（任意顺序）。
 * @param options 时间基准。
 */
export declare function analyzeBlindSpots(records: readonly MissRecord[], options: BlindSpotOptions): BlindSpotReport;
/** 单条零命中记录的规范化净化（存储读出后的防御性处理）。 */
export declare function sanitizeMissRecord(raw: unknown): MissRecord | undefined;
