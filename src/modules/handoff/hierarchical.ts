/**
 * 分层摘要引擎（轴线 2：map-reduce 上下文工程）。
 *
 * 突破单次 prompt 的字符预算限制：超长对话不再「保首尾截中段」（旧策略
 * 丢弃中段信息），而是——
 * - **map**：按轮次边界切分为多个 ≤ 预算的片段，逐段生成要点摘要
 *   （每段 ≤200 字）；片段摘要按内容哈希缓存（`handoff-chunks` 表），
 *   append-only 日志下旧片段天然命中缓存，增量会话只重摘新增部分；
 * - **reduce**：将各段要点按出现顺序合并为最终 ≤500 字交接摘要；
 *   极端超长（片段摘要本身超预算）时递归归并（层级树）。
 *
 * 查询聚焦（focus）：可选主题词同时注入 map 与 reduce 提示词，
 * 保留与主题相关的内容（对话方向不同侧面的定向压缩）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'
import type { ChatMessage } from '../../core/deepseek.js'
import { fnv1a32 } from '../../core/retrieval/tokenize.js'
import type { TranscriptTurn } from '../../core/transcript.js'
import { buildMapPrompt, buildReducePrompt } from './prompt.js'

/** 分块摘要缓存记录（handoff-chunks 表）。 */
interface ChunkSummaryRecord {
  summary: string
  model: string
  createdAt: number
}

/** LLM 调用结果（与 core/deepseek 及 companionCost 网关的返回形状对齐）。 */
export interface LlmCallResult {
  content: string
  model: string
}

/** 模型调用函数（由模块入口注入：优先成本网关，缺省直连核心服务）。 */
export type LlmCaller = (messages: readonly ChatMessage[]) => Promise<LlmCallResult>

/** 分层摘要执行统计（回传客户端展示）。 */
export interface HierarchicalStats {
  /** 是否走了 map-reduce 路径（false = 单发路径）。 */
  hierarchical: boolean
  /** 片段总数（单发路径为 0）。 */
  chunks: number
  /** 命中缓存的片段数。 */
  cachedChunks: number
}

/** 分层摘要结果。 */
export interface HierarchicalResult {
  summary: string
  model: string
  stats: HierarchicalStats
}

/** 缓存滚动保留条数上限（超出按 createdAt 淘汰最旧）。 */
const CHUNK_CACHE_LIMIT = 500

/** 单条轮次格式化（与 formatTranscript 的单轮形状一致）。 */
function formatTurn(turn: TranscriptTurn): string {
  const speaker = turn.role === 'user' ? '用户' : turn.role === 'assistant' ? '助手' : turn.role
  return `### ${speaker}\n\n${turn.text}`
}

/**
 * 按轮次边界切分转录为多个 ≤ 预算字符的片段：
 * - 贪心装箱：装满即封块，保证块数最少；
 * - 单轮超预算时硬切文本并标注段序（第 x/y 段），不丢弃内容；
 * - 相邻小块不会产生空块（无轮次时返回空数组）。
 */
export function chunkTranscript(
  turns: readonly TranscriptTurn[],
  budget: number,
): string[] {
  if (budget <= 0 || turns.length === 0) return []
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  const flush = (): void => {
    if (current.length > 0) chunks.push(current.join('\n\n'))
    current = []
    currentLength = 0
  }
  for (const turn of turns) {
    const block = formatTurn(turn)
    // 单轮即超预算：硬切为多段，每段独立成块。
    if (block.length > budget) {
      flush()
      const pieceCount = Math.ceil(block.length / budget)
      for (let index = 0; index < pieceCount; index += 1) {
        const piece = block.slice(index * budget, (index + 1) * budget)
        chunks.push(`${piece}\n\n【超长轮次，第 ${index + 1}/${pieceCount} 段】`)
      }
      continue
    }
    // 常规轮次：贪心装箱（块间以空行连接，连接符计入长度）。
    const connector = current.length > 0 ? 2 : 0
    if (currentLength + connector + block.length > budget) flush()
    current.push(block)
    currentLength += (current.length > 1 ? 2 : 0) + block.length
  }
  flush()
  return chunks
}

/** 分块摘要缓存：内容哈希 → 摘要（含 focus 指纹，聚焦不同不共用缓存）。 */
export class HandoffChunkStore {
  private readonly table

  /** 在已打开的 companion 存储域上创建。 */
  constructor(domain: Domain) {
    this.table = domain.table<ChunkSummaryRecord>('handoff-chunks')
  }

  /** 缓存键：片段文本与 focus 联合哈希（十进制字符串键）。 */
  private keyOf(chunk: string, focus: string | undefined): string {
    return String(fnv1a32(`${chunk}\u0000${focus?.trim() ?? ''}`))
  }

  /** 读取缓存（同步内存读）；不存在返回 undefined。 */
  get(chunk: string, focus: string | undefined): ChunkSummaryRecord | undefined {
    return this.table.get(this.keyOf(chunk, focus))
  }

  /** 写入缓存并滚动修剪到 CHUNK_CACHE_LIMIT 条。 */
  async put(chunk: string, focus: string | undefined, summary: string, model: string): Promise<void> {
    const key = this.keyOf(chunk, focus)
    await this.table.put(key, { summary, model, createdAt: Date.now() })
    const entries = this.table.entries()
    if (entries.length <= CHUNK_CACHE_LIMIT) return
    const stale = entries
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, entries.length - CHUNK_CACHE_LIMIT)
    for (const [staleKey] of stale) await this.table.delete(staleKey)
  }
}

/**
 * map-reduce 分层摘要编排：
 * 1. 切分片段 → 逐段生成要点（缓存命中直接复用）；
 * 2. 递归归并：片段摘要拼接超预算时分组再摘要（层级树）；
 * 3. 最终 reduce 输出 ≤500 字交接摘要（可注入自定义指令模板）。
 * @param turns 会话转录轮次。
 * @param budget 单次 prompt 的字符预算（与单发路径共用）。
 * @param callModel 模型调用函数（模块入口注入成本网关或直连）。
 * @param cache 分块摘要缓存（undefined 时跳过缓存）。
 * @param focus 可选查询聚焦主题。
 * @param templateInstruction 可选自定义摘要指令（作用于最终 reduce）。
 */
export async function mapReduceSummarize(
  turns: readonly TranscriptTurn[],
  budget: number,
  callModel: LlmCaller,
  cache: HandoffChunkStore | undefined,
  focus: string | undefined,
  templateInstruction?: string,
): Promise<HierarchicalResult> {
  const chunks = chunkTranscript(turns, budget)
  if (chunks.length === 0) {
    throw new Error('会话中没有可摘要的对话内容')
  }
  // map：逐段要点摘要（缓存优先）。
  const summaries: string[] = []
  let model = ''
  let cachedChunks = 0
  for (let index = 0; index < chunks.length; index += 1) {
    const positionHint = `第 ${index + 1}/${chunks.length} 段（约 ${Math.round(
      ((index + 0.5) / chunks.length) * 100,
    )}% 处）`
    const cached = cache?.get(chunks[index], focus)
    if (cached !== undefined) {
      summaries.push(cached.summary)
      cachedChunks += 1
      continue
    }
    const result = await callModel([
      { role: 'user', content: buildMapPrompt(chunks[index], positionHint, focus) },
    ])
    const summary = result.content.trim()
    summaries.push(summary)
    model = result.model || model
    await cache?.put(chunks[index], focus, summary, result.model || '')
  }
  // reduce：递归归并（摘要拼接超预算时分组再摘，直至可一次合并）。
  const reduceOnce = async (inputs: readonly string[]): Promise<{ text: string; model: string }> => {
    const labeled = inputs
      .map((text, index) => `【片段 ${index + 1}】\n${text}`)
      .join('\n\n')
    const result = await callModel([
      { role: 'user', content: buildReducePrompt(labeled, focus, templateInstruction) },
    ])
    return { text: result.content.trim(), model: result.model || '' }
  }
  let level: string[] = summaries
  while (level.length > 1) {
    // 分组：每组拼接后不超过预算（首条无条件入组）。
    const groups: string[][] = []
    let currentGroup: string[] = []
    let currentLength = 0
    for (const summary of level) {
      const connector = currentGroup.length > 0 ? 2 : 0
      if (currentLength + connector + summary.length > budget && currentGroup.length > 0) {
        groups.push(currentGroup)
        currentGroup = []
        currentLength = 0
      }
      currentGroup.push(summary)
      currentLength += (currentGroup.length > 1 ? 2 : 0) + summary.length
    }
    if (currentGroup.length > 0) groups.push(currentGroup)
    // 每条摘要都单独成组（无法再分组压缩）：直接全量合并（单次调用），
    // 合并后归一为单条，循环必然退出。
    if (groups.length === level.length) {
      const merged = await reduceOnce(level)
      model = merged.model || model
      level = [merged.text]
      break
    }
    // 至少一个组含 ≥2 条：归并后层数严格递减，循环必然终止。
    const next: string[] = []
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0])
        continue
      }
      const merged = await reduceOnce(group)
      model = merged.model || model
      next.push(merged.text)
    }
    level = next
  }
  return {
    summary: level[0],
    model,
    stats: { hierarchical: true, chunks: chunks.length, cachedChunks },
  }
}
