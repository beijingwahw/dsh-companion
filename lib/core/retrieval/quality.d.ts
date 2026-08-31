/**
 * 检索质量诊断（轴线 10）：把「这次检索结果可信吗」变成可计算的指标。
 * 纯函数、零依赖——输入命中列表与语料规模，输出四级判定与可执行建议。
 *
 * 设计动机：混合检索的 RRF 融合分对用户是黑盒数字（0.0328 是什么意思？）。
 * 本模块把它翻译成可解释的质量信号：
 *
 * - **相关度强度**：头部命中融合分 / 理论满分（两路皆第 1 名）的比值——
 *   ≥50% 判 strong、≥25% 判 fair、更低判 weak（结果「有」，但别太信）；
 * - **通道覆盖**：命中中带词法排名 / 语义排名的比例——词法覆盖低说明
 *   查询用词未在对话中字面出现（靠语义形状兜底），语义覆盖低说明字符
 *   形状差异大（检查拼写）；
 * - **区分度**：头部与尾部融合分的落差（gap 大 = 头部显著强于长尾，
 *   排序信息量高）；
 * - **空结果诊断**：区分「索引还没建好」与「查询写法问题」，给出
 *   可直接照做的建议（换短词 / 放宽过滤 / 切换关键词模式对照）。
 *
 * 这些指标同时服务两端：客户端展示一行人话提示；命令面板输出质量摘要。
 */
import { type HybridHit } from './engine.js';
/** 检索质量四级判定。 */
export type RetrievalVerdict = 'strong' | 'fair' | 'weak' | 'empty';
/** 检索质量诊断结果。 */
export interface RetrievalDiagnostics {
    /** 质量判定：strong（可信）/ fair（尚可）/ weak（存疑）/ empty（无命中）。 */
    readonly verdict: RetrievalVerdict;
    /** 头部命中融合分。 */
    readonly topScore: number;
    /** 融合分理论满分（两路皆第 1）。 */
    readonly maxScore: number;
    /** 头部与尾部融合分落差（区分度；单条命中时等于 topScore）。 */
    readonly scoreGap: number;
    /** 带词法排名的命中占比（0–1）。 */
    readonly lexicalCoverage: number;
    /** 带语义排名的命中占比（0–1）。 */
    readonly semanticCoverage: number;
    /** 可执行建议（按优先级排序；strong 时为空）。 */
    readonly suggestions: readonly string[];
}
/**
 * 诊断一次混合检索的结果质量。
 * @param hits 引擎返回的命中列表（已按融合分降序）。
 * @param totalDocs 语料文档总数（区分「索引为空」与「查询无命中」）。
 */
export declare function diagnoseRetrieval(hits: readonly HybridHit[], totalDocs: number): RetrievalDiagnostics;
/** 质量判定的人话标签（命令面板与客户端共用）。 */
export declare const VERDICT_LABELS: Readonly<Record<RetrievalVerdict, string>>;
