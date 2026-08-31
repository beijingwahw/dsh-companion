import type { IndexedDoc } from './engine.js';
/** 扩展来源类型。 */
export type QueryExpansionKind = 'correction' | 'cooccurrence';
/** 单条扩展溯源（谁把哪个词带进了查询；UI 可解释性）。 */
export interface QueryExpansionNote {
    readonly kind: QueryExpansionKind;
    /** 触发扩展的原查询词。 */
    readonly from: string;
    /** 被追加的扩展词。 */
    readonly to: string;
}
/** 语料视图：引擎注入的只读统计 + 倒排直达（避免全量文档扫描）。 */
export interface QueryCorpusView {
    /** 语料文档总数。 */
    readonly docCount: number;
    /** 词元 → 文档频率（全量词表）。 */
    readonly termDf: ReadonlyMap<string, number>;
    /** 词元 → 包含它的文档迭代器（倒排表直达）。 */
    readonly docsWithTerm: (term: string) => Iterable<IndexedDoc>;
}
/** 查询扩展结果。 */
export interface ExpandedQuery {
    /** 扩展后的查询文本（原文本 + 追加扩展词）。 */
    readonly queryText: string;
    /** 追加的扩展词（去重、有序）。 */
    readonly extraTerms: readonly string[];
    /** 扩展溯源（供 UI/命令输出解释）。 */
    readonly notes: readonly QueryExpansionNote[];
}
/**
 * 查询智能主入口：对查询文本做拼写纠错 + 共现扩展。
 * @param queryText 原始查询（任意中英混合）。
 * @param corpus 语料视图（引擎的词表统计与倒排直达）。
 */
export declare function expandQuery(queryText: string, corpus: QueryCorpusView): ExpandedQuery;
/**
 * 两个 trigram 频次映射的余弦相似度（[0, 1]）。
 * 导出供零命中救援（轴线 16）复用——同样的形状度量，不同的放宽阈值。
 */
export declare function trigramCosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number;
