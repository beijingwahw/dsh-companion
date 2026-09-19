/**
 * 交接摘要质量评分（上下文工程质检）：本地可解释的摘要体检报告。
 *
 * 设计动机：模块 B 把整场对话压进 ≤500 字的四段式摘要，但压缩是有损
 * 的——用户拿到摘要时没有任何信号回答"这份摘要**丢了什么**"。质量
 * 评分引擎在摘要生成后做一次纯本地体检，四个维度全部可解释：
 *
 * - **词元覆盖**（权重 50%）：源转录按词频 × 长度取头部显著词
 *   （停用词与过短词天然被低频/长度过滤），摘要覆盖了其中多少——
 *   `missingTerms` 直接列出漏掉的头部词（"该带走的背景没带走"）；
 * - **结构完整**（20%）：四段式契约标题（核心结论 / 已解决 / 背景 /
 *   待办）逐项在场——缺段 = 下一段对话缺那类上下文；
 * - **长度纪律**（15%）：≤ 预算（缺省 500 字）满分；每超 10% 扣一分
 *   （超长摘要塞回新对话本身就是上下文压力）；
 * - **压缩充分**（15%）：压缩比（源/摘）≥ 3× 满分——交接摘要的
 *   存在意义就是压缩；接近 1:1 说明"摘要"只是复述。
 *
 * verdict 三档：strong（≥80）/ fair（60–79）/ weak（<60）。
 * 纯函数、无状态、零 LLM——评分针对文本本身，与生成模型无关
 * （换模型、换模板、改 Prompt 后同一把尺子可横向比较）。
 */
/** 质量评分参数。 */
export interface HandoffQualityOptions {
    /** 摘要长度预算（字符）；缺省 500（与模块 B 契约一致）。 */
    readonly budgetChars?: number;
    /** 头部显著词数量（覆盖率的评估口径）；缺省 15。 */
    readonly salientTerms?: number;
}
/** 质量体检报告。 */
export interface HandoffQuality {
    /** 综合分（0–100）。 */
    readonly score: number;
    /** 档位：strong（≥80）/ fair（60–79）/ weak（<60）。 */
    readonly verdict: 'strong' | 'fair' | 'weak';
    /** 词元覆盖率（0–1；源转录无显著词时为 1）。 */
    readonly termCoverage: number;
    /** 摘要漏掉的头部显著词（按显著性降序）。 */
    readonly missingTerms: readonly string[];
    /** 四段式契约标题在场情况。 */
    readonly structure: Readonly<Record<SectionKey, boolean>>;
    /** 摘要字符数与预算。 */
    readonly summaryChars: number;
    readonly budgetChars: number;
    /** 压缩比（源字符 / 摘要字符；摘要为空时为 0）。 */
    readonly compression: number;
    /** 人话结论。 */
    readonly summary: string;
}
/** 四段式契约的段键。 */
export type SectionKey = 'conclusion' | 'resolved' | 'context' | 'todo';
/**
 * 摘要质量体检主入口。
 * @param sourceText 源转录全文（formatTranscript 产物）。
 * @param summaryText 待检摘要。
 * @param options 评分参数。
 */
export declare function scoreHandoffQuality(sourceText: string, summaryText: string, options?: HandoffQualityOptions): HandoffQuality;
