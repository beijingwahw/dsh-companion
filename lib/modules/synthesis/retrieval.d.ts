import type { TranscriptTurn } from '../../core/transcript.js';
/** 证据块：候选片段及其与问题的相关分。 */
export interface EvidenceChunk {
    readonly sessionId: string;
    readonly title?: string;
    readonly createdAt: number;
    readonly text: string;
    /** 词法重合 + trigram 余弦的加权分（(0, 1]）。 */
    readonly score: number;
}
/**
 * 按回合边界分块：贪心装箱连续回合到 `targetChars`。
 * 单回合自身超目标时独立成块（回合是引用的最小可解释单元，不内切）。
 */
export declare function chunkTranscript(turns: readonly TranscriptTurn[], targetChars: number): readonly (readonly TranscriptTurn[])[];
/** 文本对问题的相关分：词法重合率与 trigram 余弦各占一半。 */
export declare function scoreText(question: string, text: string): number;
/**
 * 组装合成 Prompt：契约式指令（只用证据 / 编号引用 / 结论先行 /
 * 指出矛盾）+ 编号证据块（每块带来源会话标题与日期）。
 */
export declare function buildSynthesisPrompt(question: string, evidence: readonly EvidenceChunk[]): string;
