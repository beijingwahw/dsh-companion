/**
 * 分层摘要引擎（轴线 2：map-reduce 上下文工程）。
 *
 * 突破单次 prompt 的字符预算限制：超长对话不再「保首尾截中段」（旧策略
 * 丢弃中段信息），而是——
 * - **map**：按轮次边界切分为多个 ≤ 预算的片段，逐段生成要点摘要
 *   （每段 ≤200 字）；片段摘要按内容哈希缓存（`handoff-chunks` 表），
 *   append-only 日志下旧片段天然命中缓存，增量会话只重摘新增部分；
 * - **reduce**：将各段要点按出现顺序合并为最终 ≤500 字交接摘要；
 *   极端超长（片段摘要本身超预算）时递归归并（层级树）。
 *
 * 查询聚焦（focus）：可选主题词同时注入 map 与 reduce 提示词，
 * 保留与主题相关的内容（对话方向不同侧面的定向压缩）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
import type { ChatMessage } from '../../core/deepseek.js';
import type { TranscriptTurn } from '../../core/transcript.js';
/** 分块摘要缓存记录（handoff-chunks 表）。 */
interface ChunkSummaryRecord {
    summary: string;
    model: string;
    createdAt: number;
}
/** LLM 调用结果（与 core/deepseek 及 companionCost 网关的返回形状对齐）。 */
export interface LlmCallResult {
    content: string;
    model: string;
}
/** 模型调用函数（由模块入口注入：优先成本网关，缺省直连核心服务）。 */
export type LlmCaller = (messages: readonly ChatMessage[]) => Promise<LlmCallResult>;
/** 分层摘要执行统计（回传客户端展示）。 */
export interface HierarchicalStats {
    /** 是否走了 map-reduce 路径（false = 单发路径）。 */
    hierarchical: boolean;
    /** 片段总数（单发路径为 0）。 */
    chunks: number;
    /** 命中缓存的片段数。 */
    cachedChunks: number;
}
/** 分层摘要结果。 */
export interface HierarchicalResult {
    summary: string;
    model: string;
    stats: HierarchicalStats;
}
/**
 * 按轮次边界切分转录为多个 ≤ 预算字符的片段：
 * - 贪心装箱：装满即封块，保证块数最少；
 * - 单轮超预算时硬切文本并标注段序（第 x/y 段），不丢弃内容；
 * - 相邻小块不会产生空块（无轮次时返回空数组）。
 */
export declare function chunkTranscript(turns: readonly TranscriptTurn[], budget: number): string[];
/** 分块摘要缓存：内容哈希 → 摘要（含 focus 指纹，聚焦不同不共用缓存）。 */
export declare class HandoffChunkStore {
    private readonly table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain: Domain);
    /** 缓存键：片段文本与 focus 联合哈希（十进制字符串键）。 */
    private keyOf;
    /** 读取缓存（同步内存读）；不存在返回 undefined。 */
    get(chunk: string, focus: string | undefined): ChunkSummaryRecord | undefined;
    /** 写入缓存并滚动修剪到 CHUNK_CACHE_LIMIT 条。 */
    put(chunk: string, focus: string | undefined, summary: string, model: string): Promise<void>;
}
/**
 * map-reduce 分层摘要编排：
 * 1. 切分片段 → 逐段生成要点（缓存命中直接复用）；
 * 2. 递归归并：片段摘要拼接超预算时分组再摘要（层级树）；
 * 3. 最终 reduce 输出 ≤500 字交接摘要（可注入自定义指令模板）。
 * @param turns 会话转录轮次。
 * @param budget 单次 prompt 的字符预算（与单发路径共用）。
 * @param callModel 模型调用函数（模块入口注入成本网关或直连）。
 * @param cache 分块摘要缓存（undefined 时跳过缓存）。
 * @param focus 可选查询聚焦主题。
 * @param templateInstruction 可选自定义摘要指令（作用于最终 reduce）。
 */
export declare function mapReduceSummarize(turns: readonly TranscriptTurn[], budget: number, callModel: LlmCaller, cache: HandoffChunkStore | undefined, focus: string | undefined, templateInstruction?: string): Promise<HierarchicalResult>;
export {};
