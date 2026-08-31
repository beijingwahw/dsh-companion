/** 救援动作类型。 */
export type RescueActionKind = 'correction' | 'removal';
/** 单条救援动作溯源。 */
export interface RescueAction {
    readonly kind: RescueActionKind;
    /** 原查询词。 */
    readonly from: string;
    /** 纠错后的替换词（removal 时缺省）。 */
    readonly to?: string;
}
/** 查询放宽结果。 */
export interface RelaxedQuery {
    /** 放宽后的查询文本（纠错替换 + 噪声剔除后的幸存词序列）。 */
    readonly queryText: string;
    /** 救援动作溯源（UI 可解释性）。 */
    readonly actions: readonly RescueAction[];
    /** 是否实际改写了查询（false = 无可放宽之处）。 */
    readonly applied: boolean;
}
/**
 * 放宽一个零命中查询：宽阈值纠错 + 噪声词剔除。
 * 纯函数；语料统计由调用方注入。
 *
 * @param queryText 原始查询（已产生零命中的那个）。
 * @param termDf 语料词表（词元 → 文档频率）。
 * @returns 放宽结果；applied=false 表示原查询已无可放宽（语料真空）。
 */
export declare function relaxQuery(queryText: string, termDf: ReadonlyMap<string, number>): RelaxedQuery;
