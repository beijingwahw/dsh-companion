/**
 * 会话转录：从 session-query 的原始日志快照派生人类可读的对话文本。
 *
 * Harness 的会话是 append-only 的类型化事件日志；消息历史由日志派生
 * （docs/subsystems/session.md）。这里只提取两类表面事件：
 * `user/message` 与 `assistant/message`。
 */
import type { SessionHeader, SessionLogSnapshot } from '../types/harness.js'
import { formatBeijingTime } from './time.js'

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  time: number
  seq: number
}

/** 从日志快照提取对话轮次（提取后按 seq 稳定排序，防御上游乱序）。 */
export function transcriptFromLog(snapshot: SessionLogSnapshot): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const event of snapshot.events) {
    if (event.type === 'user/message') {
      const data = event.data as { content?: unknown } | undefined
      const text = extractContentText(data?.content ?? event.data)
      if (text) turns.push({ role: 'user', text, time: event.time, seq: event.seq })
    } else if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: unknown }; content?: unknown } | undefined
      const text = extractContentText(data?.message?.content ?? data?.content)
      if (text) turns.push({ role: 'assistant', text, time: event.time, seq: event.seq })
    }
  }
  // ES2019+ 的 Array.prototype.sort 保证稳定：seq 相同的轮次保持原始相对顺序。
  turns.sort((a, b) => a.seq - b.seq)
  return turns
}

/** 将消息 content（字符串或内容块数组）压平为纯文本。 */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown; name?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool_use') parts.push(`[工具调用${typeof b.name === 'string' ? `：${b.name}` : ''}]`)
    else if (b.type === 'tool_result') parts.push('[工具结果]')
  }
  return parts.join('\n')
}

/** 渲染为 Markdown 转录文本。 */
export function formatTranscript(
  turns: readonly TranscriptTurn[],
  options: { timestamps: boolean },
): string {
  const lines: string[] = []
  for (const turn of turns) {
    const speaker = turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : turn.role
    const stamp = options.timestamps ? `（${formatBeijingTime(turn.time)}）` : ''
    lines.push(`### ${speaker}${stamp}`, '', turn.text, '')
  }
  return lines.join('\n').trimEnd()
}

/** 完整的 Markdown 导出文档（含元信息头）。 */
export function transcriptToMarkdown(
  session: SessionHeader,
  turns: readonly TranscriptTurn[],
  options: { timestamps: boolean },
): string {
  const head: string[] = [
    `# ${session.title || '未命名对话'}`,
    '',
    `- 会话 ID：${session.id}`,
    `- 创建时间：${formatBeijingTime(session.createdAt)}`,
    `- 导出时间：${formatBeijingTime(Date.now())}`,
    `- 消息轮次：${turns.length}`,
    '',
    '---',
    '',
  ]
  return [...head, formatTranscript(turns, options), ''].join('\n')
}

/** JSON 导出（结构化，便于二次处理）。 */
export function transcriptToJson(
  session: SessionHeader,
  turns: readonly TranscriptTurn[],
  options: { timestamps: boolean },
): string {
  return JSON.stringify(
    {
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
    },
    null,
    2,
  )
}
