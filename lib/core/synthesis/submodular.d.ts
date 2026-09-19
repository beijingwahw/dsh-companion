/** 可选证据块的最小结构形状（EvidenceChunk 结构兼容，零适配）。 */
export interface SelectableChunk {
    readonly sessionId: string;
    readonly text: string;
    readonly score: number;
}
/** 选择约束（与轴线 5 的证据预算同参）。 */
export interface SubmodularOptions {
    /** 证据块数上限。 */
    readonly maxChunks: number;
    /** 单会话最多贡献的块数（证据多样性）。 */
    readonly perSessionCap: number;
    /** 证据总字符预算。 */
    readonly charBudget: number;
    /** 覆盖项权重（相对模块化相关项的强度）。 */
    readonly coverageWeight?: number;
    /** 尾部截断的最小有意义字符数（低于此值提前收束）。 */
    readonly tailFloorChars?: number;
}
/** 次模选择结果。 */
export interface SubmodularResult {
    /** 选中的块（按选择顺序；text 可能为预算尾截断版本）。 */
    readonly selected: ReadonlyArray<{
        index: number;
        text: string;
    }>;
    /** 选后集合的问题方面覆盖率（[0,1]）。 */
    readonly coverage: number;
    /** 边际增益评估次数（惰性贪婪效率的证据）。 */
    readonly evaluations: number;
    /** 候选方面总数（覆盖率的分母口径）。 */
    readonly aspects: number;
}
/**
 * 次模证据选择主入口：惰性贪婪在「块数 × 单会话上限 × 字符预算」
 * 三重约束下最大化相关 × 覆盖目标。
 *
 * @param candidates 候选块（任意顺序；结果携带原始下标供回溯）。
 * @param question 研究问题（方面集与权重的来源）。
 * @param options 约束与权重。
 */
export declare function selectSubmodular<T extends SelectableChunk>(candidates: readonly T[], question: string, options: SubmodularOptions): SubmodularResult;
/**
 * 证据集合的问题方面覆盖率（对照组口径：轴线 5 的分数降序贪心
 * 用同一函数计算 baseline，增益可量化）。
 *
 * @param question 研究问题。
 * @param texts 证据文本列表。
 */
export declare function evidenceCoverage(question: string, texts: readonly string[]): number;
