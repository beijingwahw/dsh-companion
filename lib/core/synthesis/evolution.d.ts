/** 单个证据块的声明视图（合成模块 EvidenceChunk 的演化视角投影）。 */
export interface EvolutionInput {
    /** 来源会话 ID。 */
    readonly sessionId: string;
    /** 来源会话标题（展示用）。 */
    readonly title?: string;
    /** 会话创建时间（毫秒时间戳；时间线排序基准）。 */
    readonly createdAt: number;
    /** 证据块文本。 */
    readonly text: string;
}
/** 演化事件类型。 */
export type EvolutionKind = 'upgrade' | 'downgrade' | 'change';
/** 单条信念演化事件。 */
export interface EvolutionEvent {
    /** 主题锚词（展示原形）。 */
    readonly anchor: string;
    /** 事件类型：upgrade（版本升）/ downgrade（版本降）/ change（数值或不可比变化）。 */
    readonly kind: EvolutionKind;
    /** 旧值（版本号或数值）。 */
    readonly from: string;
    /** 新值（版本号或数值）。 */
    readonly to: string;
    /** 旧信念的会话时间。 */
    readonly fromAt: number;
    /** 新信念的会话时间。 */
    readonly toAt: number;
    /** 旧信念来源会话 ID。 */
    readonly fromSession: string;
    /** 新信念来源会话 ID。 */
    readonly toSession: string;
}
/** 知识演化分析结果。 */
export interface EvolutionReport {
    /** 按时间升序的演化事件（最新信念在末尾）。 */
    readonly events: readonly EvolutionEvent[];
    /** 人话摘要（无演化时为「未检测到信念变化」类陈述）。 */
    readonly summary: string;
}
/**
 * 分析证据块的信念演化：提取声明 → 锚定比较 → 生成事件时间线。
 * 纯函数；输入通常来自合成模块的块级检索（同主题的跨会话证据）。
 *
 * @param inputs 同主题的证据块（任意顺序；内部按时间排序）。
 * @returns 演化报告（事件按时间升序）。
 */
export declare function analyzeEvolution(inputs: readonly EvolutionInput[]): EvolutionReport;
/**
 * 语义化版本比较：v2.10 > v2.9（数字段逐段比，非字典序）。
 * 不可比（段数差异过大等）时返回 change。
 */
export declare function compareVersions(a: string, b: string): EvolutionKind;
