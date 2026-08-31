/** 建议来源（打分基础权重：你点过的 > 你聊过的 > 语料共现）。 */
export type SuggestionSource = 'profile' | 'prefix' | 'cooccurrence';
/** 单条查询建议。 */
export interface QuerySuggestion {
    /** 完整建议查询文本（可直接作为检索输入）。 */
    readonly text: string;
    /** 建议补入的核心词。 */
    readonly term: string;
    /** 建议来源。 */
    readonly source: SuggestionSource;
    /** 建议强度（降序展示）。 */
    readonly score: number;
}
/** 建议引擎的语料视图（与查询智能共用同一注入契约）。 */
export interface SuggestCorpusView {
    /** 语料文档总数。 */
    readonly docCount: number;
    /** 词元 → 文档频率（全量词表）。 */
    readonly termDf: ReadonlyMap<string, number>;
    /** 词元 → 包含它的文档迭代器（倒排表直达）。 */
    readonly docsWithTerm: (term: string) => Iterable<{
        readonly termFreqs: Record<string, number>;
    }>;
}
/** 建议选项。 */
export interface SuggestOptions {
    /** 点击画像聚合词频（词 → 总点击次数；曾导致点击的查询词）。 */
    readonly profileTerms?: ReadonlyMap<string, number>;
    /** 建议条数上限（缺省 5）。 */
    readonly limit?: number;
}
/**
 * 查询建议主入口。
 * @param input 输入框当前内容（任意中英混合，可能含未完成的尾部词）。
 * @param corpus 语料视图。
 * @param options 点击画像词频与条数上限。
 * @returns 建议列表（强度降序；无合格建议时为空）。
 */
export declare function suggestQueries(input: string, corpus: SuggestCorpusView, options?: SuggestOptions): QuerySuggestion[];
