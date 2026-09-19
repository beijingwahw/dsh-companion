/**
 * 模块 G：跨会话知识合成（synthesis）——轴线 5/29「Deep Research over 历史对话」。
 *
 * 把"问自己的历史"变成一次研究流程：
 * 1. **召回**：FTS 关键词召回（sessionQuery.searchSessions）+ 近期会话兜底，
 *    合并去重为候选池（FTS 对长自然语言问句召回不稳，近期会话保证覆盖）；
 * 2. **块级检索**：逐会话读取转录 → 按回合边界分块 → 词法 + trigram
 *    双通道打分（复用 core/retrieval 分词器），片段粒度精排；
 * 3. **次模证据选择**（轴线 29）：设施选址次模目标（相关性 + 问题方面
 *    覆盖 × 稀有度权重）最大化，惰性贪婪（CELF）在「块数 × 单会话
 *    上限 × 字符预算」三重约束下选取——互补证据优于同义重复，冗余被
 *    目标函数自动惩罚，(1−1/e) 理论保证；
 * 4. **合成**：契约式 Prompt（只用证据 / 编号引用 / 结论先行 / 指出矛盾）
 *    经成本网关（或直连）调用 LLM，回答带 [编号] 引用；
 * 5. **来源回链**：每个贡献证据的会话生成来源视图（标题/日期/片段），
 *    点击可直达原会话——合成的每个论断都可回溯验证。
 *
 * 隐私边界：仅转录文本进入 DeepSeek API（与模块 B 摘要同一边界），
 * 不外发任何索引/实体/统计数据。
 *
 * HTTP 端点：`POST /synthesis/answer`（形状见 DESIGN.md 第 4 节）；
 * 命令 `research` 与端点复用同一服务函数。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatMessage } from '../../core/deepseek.js'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js'
import type { TranscriptTurn } from '../../core/transcript.js'
import type { SessionRecord } from '../../types/harness.js'
import {
  buildSynthesisPrompt,
  chunkTranscript,
  scoreText,
  type EvidenceChunk,
} from './retrieval.js'
import { analyzeEvolution, type EvolutionReport } from '../../core/synthesis/evolution.js'
import { selectSubmodular } from '../../core/synthesis/submodular.js'

/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-synthesis'

/** 依赖声明：核心服务 + 会话查询 + 命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 问题最大长度（超出 400）。 */
const QUESTION_MAX_CHARS = 500

/** FTS 关键词召回的候选会话数。 */
const RECALL_LIMIT = 24

/** 近期会话兜底条数（覆盖 FTS 对长问句召回不足）。 */
const RECENT_FALLBACK = 12

/** 候选会话总数上限（控制转录读取量）。 */
const MAX_CANDIDATE_SESSIONS = 32

/** 单会话参与分块的转录字符预算（超长保首尾回合）。 */
const TRANSCRIPT_CHAR_BUDGET = 40_000

/** 分块目标字符数。 */
const CHUNK_CHAR_TARGET = 1_800

/** 证据块数上限。 */
const MAX_EVIDENCE_CHUNKS = 10

/** 单会话最多贡献的证据块数（证据多样性）。 */
const PER_SESSION_CHUNK_CAP = 3

/** 证据总字符预算（控制 prompt 体积与费用）。 */
const EVIDENCE_CHAR_BUDGET = 26_000

/** 合成回答的 max_tokens 上限。 */
const ANSWER_MAX_TOKENS = 1_600

/** 来源片段展示长度。 */
const SNIPPET_CHARS = 160

/** 合成来源（贡献证据的会话视图）。 */
export interface SynthesisSource {
  readonly sessionId: string
  readonly title?: string
  readonly createdAt: number
  readonly snippet: string
}

/** 合成结果。 */
export interface SynthesisResult {
  readonly answer: string
  readonly model: string
  readonly sources: readonly SynthesisSource[]
  /** 知识演化追踪（轴线 17：证据中的跨会话信念变化；无演化时 events 为空）。 */
  readonly evolution: EvolutionReport
  /** 检索与合成统计（客户端展示沙盘透明度）。 */
  readonly stats: {
    readonly candidates: number
    readonly chunks: number
    readonly evidenceChunks: number
    readonly evidenceChars: number
    /** 次模选择诊断（轴线 29）。 */
    readonly selection: {
      /** 问题方面覆盖率（[0,1]）。 */
      readonly coverage: number
      /** 惰性贪婪边际增益评估次数（效率证据）。 */
      readonly evaluations: number
      /** 候选方面总数。 */
      readonly aspects: number
    }
  }
}

/** 研究预演结果（零 LLM）：证据预览 + 覆盖 + 预算占用，供"先看后买"。 */
export interface SynthesisPreview {
  readonly question: string
  /** 采用的证据块预览（编号与合成时的 [n] 引用一致）。 */
  readonly evidence: ReadonlyArray<{
    readonly index: number
    readonly sessionId: string
    readonly title?: string
    readonly createdAt: number
    readonly score: number
    readonly snippet: string
  }>
  readonly sources: readonly SynthesisSource[]
  /** 问题方面覆盖率（[0,1]；次模选择诊断）。 */
  readonly coverage: number
  readonly stats: {
    readonly candidates: number
    readonly chunks: number
    readonly evidenceChunks: number
    readonly evidenceChars: number
    readonly estimatedPromptTokens: number
  }
  readonly note: string
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  /**
   * 模型调用：成本模块在位时经 companionCost 策略层（研究为交互式
   * 操作，priority 'high' 不参与峰谷延迟）；否则直连核心服务。
   */
  async function callModel(messages: readonly ChatMessage[]): Promise<{ content: string; model: string }> {
    const costGateway = ctx.get('companionCost')
    if (costGateway) {
      const result = await costGateway.call({
        messages,
        taskHint: '研究',
        source: 'synthesis',
        priority: 'high',
        maxTokens: ANSWER_MAX_TOKENS,
      })
      return { content: result.content, model: result.model || 'deepseek-chat' }
    }
    const result = await ctx.companion.callDeepSeek({
      messages,
      model: 'deepseek-chat',
      source: 'synthesis',
      maxTokens: ANSWER_MAX_TOKENS,
    })
    return { content: result.content, model: result.model || 'deepseek-chat' }
  }

  /**
   * 候选召回：FTS 关键词召回 + 近期会话兜底，按 id 去重合并
   * （FTS 命中在前保证相关性，近期会话殿后保证覆盖）。
   * 两条通道各自容错：任一失败不阻塞另一条。
   */
  async function recallSessions(question: string): Promise<readonly SessionRecord[]> {
    const merged = new Map<string, SessionRecord>()
    try {
      const page = await ctx.sessionQuery.searchSessions({ query: question, limit: RECALL_LIMIT })
      for (const hit of page.hits) {
        merged.set(String(hit.session.id), hit.session)
      }
    } catch {
      // FTS 失败：仅近期会话兜底。
    }
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      const sorted = [...sessions].sort(
        (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
      )
      for (const session of sorted.slice(0, RECENT_FALLBACK)) {
        if (!merged.has(String(session.id))) merged.set(String(session.id), session)
      }
    } catch {
      // 列表失败：仅 FTS 结果。
    }
    return [...merged.values()].slice(0, MAX_CANDIDATE_SESSIONS)
  }

  /**
   * 转录预算：超长会话保首尾回合（中段舍弃）——与研究问答
   * "首部背景 + 尾部最新结论"的信号分布对齐。
   */
  function budgetTurns(turns: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
    let total = 0
    for (const turn of turns) total += turn.text.length
    if (total <= TRANSCRIPT_CHAR_BUDGET) return turns
    const halfBudget = Math.floor(TRANSCRIPT_CHAR_BUDGET / 2)
    const head: TranscriptTurn[] = []
    let headChars = 0
    for (const turn of turns) {
      if (headChars + turn.text.length > halfBudget) break
      head.push(turn)
      headChars += turn.text.length
    }
    const tail: TranscriptTurn[] = []
    let tailChars = 0
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]
      if (head.includes(turn)) break
      if (tailChars + turn.text.length > halfBudget) break
      tail.unshift(turn)
      tailChars += turn.text.length
    }
    return [...head, ...tail]
  }

  /** 证据收集产物：召回候选 / 全部候选块 / 次模选择结果 / 采用证据。 */
  interface CollectedEvidence {
    candidates: readonly SessionRecord[]
    chunks: EvidenceChunk[]
    selection: ReturnType<typeof selectSubmodular>
    evidence: EvidenceChunk[]
  }

  /**
   * 证据收集管线（召回 → 块级检索 → 次模选择）：answer 与 preview 共用。
   * 零 LLM 调用——预演端点在管线终点停下，合成端点继续走模型。
   */
  async function collectEvidence(question: string): Promise<CollectedEvidence> {
    // 1) 候选召回。
    const candidates = await recallSessions(question)
    // 2) 块级检索：逐会话读取 → 预算截断 → 分块 → 双通道打分。
    const chunks: EvidenceChunk[] = []
    for (const session of candidates) {
      let turns: readonly TranscriptTurn[]
      try {
        const snapshot = await ctx.sessionQuery.readSession(SessionId(String(session.id)))
        turns = transcriptFromLog(snapshot)
      } catch {
        // 单会话读取失败：跳过，不阻塞整体合成。
        continue
      }
      if (turns.length === 0) continue
      const bounded = budgetTurns(turns)
      for (const group of chunkTranscript(bounded, CHUNK_CHAR_TARGET)) {
        const text = formatTranscript(group, { timestamps: false })
        if (!text.trim()) continue
        const score = scoreText(question, text)
        if (score <= 0) continue
        chunks.push({
          sessionId: String(session.id),
          title: session.title,
          createdAt: session.createdAt,
          text,
          score,
        })
      }
    }
    // 3) 次模证据选择（轴线 29）：设施选址目标最大化相关 × 覆盖，
    //    惰性贪婪逼近 (1−1/e) 最优；selected 携带原始下标，预算尾截断
    //    的文本回写到 EvidenceChunk。
    const selection = selectSubmodular(chunks, question, {
      maxChunks: MAX_EVIDENCE_CHUNKS,
      perSessionCap: PER_SESSION_CHUNK_CAP,
      charBudget: EVIDENCE_CHAR_BUDGET,
    })
    const evidence: EvidenceChunk[] = selection.selected.map((item) => {
      const original = chunks[item.index]
      return item.text === original.text ? original : { ...original, text: item.text }
    })
    return { candidates, chunks, selection, evidence }
  }

  /**
   * 跨会话知识合成主流程：召回 → 块级检索 → 证据选择 → LLM 合成。
   * @param question 自然语言研究问题。
   */
  async function answerQuestion(question: string): Promise<SynthesisResult> {
    const { candidates, chunks, selection, evidence } = await collectEvidence(question)
    if (evidence.length === 0) {
      throw new HttpError('历史对话中没有找到与问题相关的内容，请换个问法或先积累更多对话', 404)
    }
    // 4) 合成。
    const prompt = buildSynthesisPrompt(question, evidence)
    const result = await callModel([{ role: 'user', content: prompt }])
    // 5) 知识演化追踪（轴线 17）：证据块的跨会话信念比较——同一主题的
    // 版本号/数值随时间变化即演化事件（纯本地，无 LLM 开销）。
    const evolution = analyzeEvolution(
      evidence.map((chunk) => ({
        sessionId: chunk.sessionId,
        title: chunk.title,
        createdAt: chunk.createdAt,
        text: chunk.text,
      })),
    )
    // 6) 来源视图：每会话取最优块（证据已按分数降序）。
    const sources: SynthesisSource[] = []
    const seenSessions = new Set<string>()
    for (const chunk of evidence) {
      if (seenSessions.has(chunk.sessionId)) continue
      seenSessions.add(chunk.sessionId)
      sources.push({
        sessionId: chunk.sessionId,
        title: chunk.title,
        createdAt: chunk.createdAt,
        snippet: chunk.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      })
    }
    return {
      answer: result.content.trim(),
      model: result.model,
      sources,
      evolution,
      stats: {
        candidates: candidates.length,
        chunks: chunks.length,
        evidenceChunks: evidence.length,
        evidenceChars: evidence.reduce((sum, chunk) => sum + chunk.text.length, 0),
        selection: {
          coverage: selection.coverage,
          evaluations: selection.evaluations,
          aspects: selection.aspects,
        },
      },
    }
  }

  /**
   * 研究预演（零 LLM）：证据收集管线跑到底但不进模型——先看证据、
   * 覆盖与预算占用，再决定是否花钱合成。证据为空时返回引导而不报错。
   */
  async function previewQuestion(question: string): Promise<SynthesisPreview> {
    const { candidates, chunks, selection, evidence } = await collectEvidence(question)
    const evidenceChars = evidence.reduce((sum, chunk) => sum + chunk.text.length, 0)
    const sources: SynthesisSource[] = []
    const seenSessions = new Set<string>()
    for (const chunk of evidence) {
      if (seenSessions.has(chunk.sessionId)) continue
      seenSessions.add(chunk.sessionId)
      sources.push({
        sessionId: chunk.sessionId,
        title: chunk.title,
        createdAt: chunk.createdAt,
        snippet: chunk.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      })
    }
    return {
      question,
      evidence: evidence.map((chunk, index) => ({
        index: index + 1,
        sessionId: chunk.sessionId,
        title: chunk.title,
        createdAt: chunk.createdAt,
        score: Number(chunk.score.toFixed(4)),
        snippet: chunk.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      })),
      sources,
      coverage: selection.coverage,
      stats: {
        candidates: candidates.length,
        chunks: chunks.length,
        evidenceChunks: evidence.length,
        evidenceChars,
        /** 合成 prompt 的粗估 token 数（中英混排按 ~2 字符/token 保守估）。 */
        estimatedPromptTokens: Math.ceil((question.length + evidenceChars) / 2),
      },
      note:
        evidence.length === 0
          ? '历史对话中没有找到与问题相关的内容——预演零证据，不建议发起合成'
          : '预演完成（零 LLM 调用）：以上是合成将采用的证据与覆盖，确认后再调 /synthesis/answer',
    }
  }

  // ------------------------------------------------------------------
  // HTTP 端点（注册即 effect）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/synthesis/answer', async (_req, res, { body }) => {
        const record = readObject(body)
        const question = requireString(record.question, 'question')
        if (question.length > QUESTION_MAX_CHARS) {
          throw new HttpError(`question 长度不能超过 ${QUESTION_MAX_CHARS} 字符`, 400)
        }
        sendJson(res, 200, await answerQuestion(question))
      }),
    'companion.synthesis-http-answer',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/synthesis/preview', async (_req, res, { body }) => {
        const record = readObject(body)
        const question = requireString(record.question, 'question')
        if (question.length > QUESTION_MAX_CHARS) {
          throw new HttpError(`question 长度不能超过 ${QUESTION_MAX_CHARS} 字符`, 400)
        }
        sendJson(res, 200, await previewQuestion(question))
      }),
    'companion.synthesis-http-preview',
  )

  // ------------------------------------------------------------------
  // 命令面板（与 HTTP 端点复用同一服务函数）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'research',
        description: '跨会话深度研究：检索全部历史对话并合成带引用来源的回答',
        input: { hint: '研究问题，如：我之前对性能优化得出过哪些结论？' },
        handler: async (invocation) => {
          const question = (invocation.rawInput ?? '').trim()
          if (!question) {
            return { kind: 'error', text: '请提供研究问题作为命令输入' }
          }
          try {
            const result = await answerQuestion(question)
            const lines: string[] = [result.answer, '']
            lines.push(
              `（检索 ${result.stats.candidates} 个会话 · ${result.stats.evidenceChunks} 个证据片段 · ${result.model}）`,
            )
            lines.push('')
            lines.push('证据来源：')
            result.sources.forEach((source, index) => {
              const date = new Date(source.createdAt).toLocaleDateString('zh-CN')
              lines.push(`  [${index + 1}] ${source.title ?? '未命名对话'}（${date}）`)
              if (source.snippet.length > 0) lines.push(`      ${source.snippet}`)
            })
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'companion.synthesis-command-research',
  )
}

// --------------------------------------------------------------------
// 请求体收窄辅助（unknown → 具体形状；strict 下不用 any）
// --------------------------------------------------------------------

/** 将请求体收窄为 JSON 对象，否则 400。 */
function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(`${field} 必须是非空字符串`, 400)
  }
  return value.trim()
}
