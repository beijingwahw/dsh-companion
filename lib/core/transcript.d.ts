/**
 * 会话转录：从 session-query 的原始日志快照派生人类可读的对话文本。
 *
 * Harness 的会话是 append-only 的类型化事件日志；消息历史由日志派生
 * （docs/subsystems/session.md）。这里只提取两类表面事件：
 * `user/message` 与 `assistant/message`。
 */
import type { SessionHeader, SessionLogSnapshot } from '../types/harness.js';
export interface TranscriptTurn {
    role: 'user' | 'assistant' | 'system' | 'tool';
    text: string;
    time: number;
    seq: number;
}
/** 从日志快照提取对话轮次（提取后按 seq 稳定排序，防御上游乱序）。 */
export declare function transcriptFromLog(snapshot: SessionLogSnapshot): TranscriptTurn[];
/** 将消息 content（字符串或内容块数组）压平为纯文本。 */
export declare function extractContentText(content: unknown): string;
/** 渲染为 Markdown 转录文本。 */
export declare function formatTranscript(turns: readonly TranscriptTurn[], options: {
    timestamps: boolean;
}): string;
/** 完整的 Markdown 导出文档（含元信息头）。 */
export declare function transcriptToMarkdown(session: SessionHeader, turns: readonly TranscriptTurn[], options: {
    timestamps: boolean;
}): string;
/** JSON 导出（结构化，便于二次处理）。 */
export declare function transcriptToJson(session: SessionHeader, turns: readonly TranscriptTurn[], options: {
    timestamps: boolean;
}): string;
