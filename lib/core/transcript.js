import { formatBeijingTime } from './time.js';
/** 从日志快照提取对话轮次（提取后按 seq 稳定排序，防御上游乱序）。 */
export function transcriptFromLog(snapshot) {
    const turns = [];
    for (const event of snapshot.events) {
        if (event.type === 'user/message') {
            const data = event.data;
            const text = extractContentText(data?.content ?? event.data);
            if (text)
                turns.push({ role: 'user', text, time: event.time, seq: event.seq });
        }
        else if (event.type === 'assistant/message') {
            const data = event.data;
            const text = extractContentText(data?.message?.content ?? data?.content);
            if (text)
                turns.push({ role: 'assistant', text, time: event.time, seq: event.seq });
        }
    }
    // ES2019+ 的 Array.prototype.sort 保证稳定：seq 相同的轮次保持原始相对顺序。
    turns.sort((a, b) => a.seq - b.seq);
    return turns;
}
/** 将消息 content（字符串或内容块数组）压平为纯文本。 */
export function extractContentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const b = block;
        if (b.type === 'text' && typeof b.text === 'string')
            parts.push(b.text);
        else if (b.type === 'tool_use')
            parts.push(`[工具调用${typeof b.name === 'string' ? `：${b.name}` : ''}]`);
        else if (b.type === 'tool_result')
            parts.push('[工具结果]');
    }
    return parts.join('\n');
}
/** 渲染为 Markdown 转录文本。 */
export function formatTranscript(turns, options) {
    const lines = [];
    for (const turn of turns) {
        const speaker = turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : turn.role;
        const stamp = options.timestamps ? `（${formatBeijingTime(turn.time)}）` : '';
        lines.push(`### ${speaker}${stamp}`, '', turn.text, '');
    }
    return lines.join('\n').trimEnd();
}
/** 完整的 Markdown 导出文档（含元信息头）。 */
export function transcriptToMarkdown(session, turns, options) {
    const head = [
        `# ${session.title || '未命名对话'}`,
        '',
        `- 会话 ID：${session.id}`,
        `- 创建时间：${formatBeijingTime(session.createdAt)}`,
        `- 导出时间：${formatBeijingTime(Date.now())}`,
        `- 消息轮次：${turns.length}`,
        '',
        '---',
        '',
    ];
    return [...head, formatTranscript(turns, options), ''].join('\n');
}
/** JSON 导出（结构化，便于二次处理）。 */
export function transcriptToJson(session, turns, options) {
    return JSON.stringify({
        session: {
            id: session.id,
            title: session.title ?? null,
            createdAt: session.createdAt,
        },
        exportedAt: Date.now(),
        turns: turns.map((t) => ({
            role: t.role,
            text: t.text,
            ...(options.timestamps ? { time: t.time } : {}),
        })),
    }, null, 2);
}
