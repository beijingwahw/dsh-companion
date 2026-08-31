/**
 * 命中解释器（轴线 15）：把「这个会话为什么排第一」变成透明账本。
 *
 * 设计动机：融合分 0.0432 对用户是纯粹的黑盒数字。混合引擎的得分
 * 实际由四个可分离的成分构成，本模块把它们逐一拆开：
 *
 * - **词法命中**：查询词元在文档中的出现频次（BM25 的原料）——
 *   「部署 ×3、docker ×2」直说命中了什么；
 * - **语义相似**：查询与文档的 trigram 形状余弦（0–100%）——
 *   「不用同一词但谈同一事」的形状重合度；
 * - **新近加成**：时序感知（轴线 9）贡献的乘性增量；
 * - **反馈加成**：相关性反馈学习（轴线 11）贡献的乘性增量。
 *
 * 输出结构化账本 + 一句话人话摘要，客户端悬停展示、命令面板直读。
 * 与质量诊断（轴线 10）互补：诊断评「整次检索」的质量，解释器评
 * 「单条命中」的构成。
 */
import { type IndexedDoc } from './engine.js';
/** 单个词法命中项。 */
export interface LexicalHitTerm {
    /** 命中的查询词元。 */
    readonly term: string;
    /** 该词元在文档中的出现频次。 */
    readonly tf: number;
}
/** 单条命中的解释账本。 */
export interface HitExplanation {
    /** 词法通道命中：查询词元 → 文档频次（tf 降序）。 */
    readonly lexicalHits: readonly LexicalHitTerm[];
    /** 语义形状相似度（trigram 向量余弦，0–1）。 */
    readonly semanticSimilarity: number;
    /** 时序新近加成（乘性增量；0 = 无）。 */
    readonly recencyBoost: number;
    /** 反馈学习加成（乘性增量；0 = 无）。 */
    readonly feedbackBoost: number;
    /** 一句话人话摘要（客户端/命令面板直读）。 */
    readonly summary: string;
}
/** 加成分解输入（由调用方在排序管线上游已算好）。 */
export interface BoostBreakdown {
    /** 时序感知加成（乘性增量）。 */
    readonly recency: number;
    /** 反馈学习加成（乘性增量）。 */
    readonly feedback: number;
}
/**
 * 解释一条命中：拆解融合分的四个成分。
 *
 * @param queryText 用户原始查询（不掺扩展词——解释的是「你搜的词」如何命中）。
 * @param doc 命中会话的索引文档。
 * @param boosts 加成分解（新近 + 反馈）。
 * @param queryVector 查询的哈希向量（调用方可缓存复用；缺省即时构建）。
 */
export declare function explainHit(queryText: string, doc: IndexedDoc, boosts: BoostBreakdown, queryVector?: ReadonlyMap<number, number>): HitExplanation;
