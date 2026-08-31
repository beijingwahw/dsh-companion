/**
 * 模块 B：上下文交接摘要（handoff）插件入口——轴线 2「上下文工程 2.0」。
 *
 * 职责：
 * - 为指定会话生成交接摘要（优先经 ctx.companionCost 策略层，缺省直连核心服务）；
 * - 超长对话走 map-reduce 分层摘要（hierarchical.ts）：分块抽取 → 内容哈希
 *   缓存 → 递归归并，突破单发 prompt 预算且不丢弃中段内容；
 * - 查询聚焦（focus）：可选主题词注入提示词，定向保留相关内容；
 * - 会话继承图谱（lineage.ts）：追踪摘要跨会话传播链路（血缘可视化）；
 * - 管理摘要模板（templates 表）与武装状态（handoff-armed 表）；
 * - 经 ctx.systemPrompt.context 注入已武装的摘要：
 *   特定会话武装按装配 scope 匹配注入；pending 武装只注入下一次装配。
 *
 * HTTP 端点经 ctx.companion.http 挂载在 /companion 前缀下（形状见 DESIGN.md 第 4 节）；
 * 命令 `handoff` / `handoff-import` 与端点复用同一套模块内服务函数。
 * 所有注册均为 effect，随 Cordis fiber 生命周期自动回卷。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatMessage } from '../../core/deepseek.js'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js'
import type { SessionLogSnapshot } from '../../types/harness.js'
import { ArmedStore } from './armed.js'
import { computeContextHealth } from './context-health.js'
import {
  HandoffChunkStore,
  mapReduceSummarize,
  type HierarchicalStats,
  type LlmCaller,
} from './hierarchical.js'
import { LineageStore } from './lineage.js'
import {
  buildHandoffPromptWithFocus,
  buildHandoffPromptWithTemplate,
} from './prompt.js'
import {
  MAX_TEMPLATES,
  MAX_TEMPLATE_CONTENT_CHARS,
  MAX_TEMPLATE_NAME_CHARS,
  TemplateStore,
} from './templates.js'

/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-handoff'

/** 依赖声明：核心服务 + 会话查询 + 命令面板 + 系统提示词装配。 */
export const inject = ['companion', 'sessionQuery', 'commands', 'systemPrompt']

/** 对话转录字符预算：单发 prompt 上限；超出走 map-reduce 分层摘要。 */
const TRANSCRIPT_CHAR_BUDGET = 60_000

/** pending 武装有效期（毫秒）：超时未投递自动作废，防僵尸注入。 */
const ARMED_TTL_MS = 24 * 3600_000

/** focus 参数最大长度（超出 400）。 */
const FOCUS_MAX_CHARS = 400

/** 交接摘要生成结果。 */
interface HandoffResult {
  summary: string
  model: string
  /** 分层摘要统计（轴线 2）；单发路径为缺省形状。 */
  stats?: HierarchicalStats
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  // 存储域异步打开：就绪后创建存储实例。armed 另持同步引用，
  // 因为系统提示词装配回调是同步的，无法 await。
  let armed: ArmedStore | undefined
  const storesReady = ctx.companion.ready.then(({ domain }) => {
    const stores = {
      templates: new TemplateStore(domain),
      armed: new ArmedStore(domain),
      chunks: new HandoffChunkStore(domain),
      lineage: new LineageStore(domain),
    }
    armed = stores.armed
    return stores
  })
  // 兜底 catch：存储域失败且尚无请求 await 时避免未处理 rejection
  // （对齐 search 模块写法；各端点 await 时仍会正常得到错误响应）。
  storesReady.catch(() => undefined)

  /**
   * 进程内 pending 认领标记：装配回调在「决定注入」时同步认领，
   * 堵住 peek（同步读）与 consumePending（异步落定）之间的窗口——
   * 否则并发的新会话装配会各自 peek 到同一条 pending 而双重注入。
   * 消费落定（成功/失败/身份不符）后释放，允许后续装配处理新武装。
   */
  let pendingClaim = false

  // ------------------------------------------------------------------
  // 系统提示词上下文：注入已武装的交接摘要
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'companion-handoff-summary',
        order: -80,
        text: (assembly) => {
          const store = armed
          if (!store) return ''
          // 特定会话武装：装配作用域与武装会话 ID 相等时注入。
          const scopeText = String(assembly.scope)
          for (const entry of store.list()) {
            if (entry.sessionId !== null && scopeText === entry.sessionId) {
              return renderHandoffSection(entry.summary)
            }
          }
          // pending 武装只投递给有具体会话作用域的装配：
          // 无作用域的全局/默认装配不消费摘要（防止误耗）。
          if (assembly.scope === undefined || assembly.scope === null) return ''
          const pending = store.peekPending()
          if (!pending) return ''
          // 世代门闩——过期自清：超时未投递自动作废，防僵尸注入。
          if (pending.expiresAt !== undefined && Date.now() > pending.expiresAt) {
            queueMicrotask(() => {
              void store.expirePending().catch(() => undefined)
            })
            return ''
          }
          // 世代门闩——快照判定：武装时刻已存在的会话（快照内）不投递，
          // 旧会话无论怎么重建都免疫；旧格式记录（无快照）回退
          // v0.1 近似：注入下一次系统提示词装配。
          if (pending.knownSessions !== undefined && pending.knownSessions.includes(scopeText)) {
            return ''
          }
          // 同步认领：认领后、消费落定前的其他装配一律不再注入本条
          // pending（双重注入防线，详见 pendingClaim 声明处注释）。
          if (pendingClaim) return ''
          pendingClaim = true
          // 原子消费（带身份校验：peek 后被 re-arm 覆盖时不误删新记录）
          // + 投递回执（dock 可观测）+ 继承图谱悬边解析（轴线 2）。
          queueMicrotask(() => {
            void store
              .consumePending({ armedAt: pending.armedAt, summary: pending.summary })
              .then((summary) => {
                if (summary !== undefined) {
                  void store.writeReceipt(scopeText).catch(() => undefined)
                  // pending 已投递到 scopeText：图谱悬边解析为真实目标。
                  void storesReady
                    .then((stores) => stores.lineage.resolvePendingTargets(scopeText))
                    .catch(() => undefined)
                }
                // summary === undefined：记录已被新武装覆盖，新记录
                // 留给后续装配投递，不误删。
              })
              .catch(() => {
                // 消费失败静默降级并释放认领（摘要至多重复注入一次），
                // 避免未处理 rejection。
              })
              .finally(() => {
                pendingClaim = false
              })
          })
          return renderHandoffSection(pending.summary)
        },
      }),
    'companion.handoff-prompt-context',
  )

  // ------------------------------------------------------------------
  // 模块内服务函数（HTTP 端点与命令共用）
  // ------------------------------------------------------------------

  /**
   * 模型调用函数（单发与分层路径共用）：成本模块在位时经 companionCost
   * 策略层调用（taskHint 供模型路由判断）；handoff 是交互式操作：
   * priority 'high' 不参与峰谷延迟；否则直连核心服务（固定 deepseek-chat）。
   */
  const callModel: LlmCaller = async (messages: readonly ChatMessage[]) => {
    const costGateway = ctx.get('companionCost')
    if (costGateway) {
      const result = await costGateway.call({
        messages,
        taskHint: '摘要',
        source: 'handoff',
        priority: 'high',
      })
      return { content: result.content, model: result.model || 'deepseek-chat' }
    }
    const result = await ctx.companion.callDeepSeek({
      messages,
      model: 'deepseek-chat',
      source: 'handoff',
    })
    return { content: result.content, model: result.model || 'deepseek-chat' }
  }

  /**
   * 生成指定会话的交接摘要（轴线 2：上下文工程 2.0）。
   * - 转录在预算内：单发路径（模板/固定契约 Prompt，行为与旧版一致）；
   * - 转录超预算：map-reduce 分层摘要（分块抽取 → 缓存 → 递归归并），
   * 不再丢弃中段内容；模板内容作为最终 reduce 的自定义指令。
   * @param templateName 可选模板名：存在时以该模板内容作为摘要指令文本。
   * @param focus 可选查询聚焦主题：保留与该主题相关的内容。
   */
  async function generate(
    sessionId: SessionId,
    templateName?: string,
    focus?: string,
  ): Promise<HandoffResult> {
    let snapshot: SessionLogSnapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(sessionId)
    } catch (error) {
      throw new HttpError(
        `读取会话失败：${error instanceof Error ? error.message : String(error)}`,
        404,
      )
    }
    const turns = transcriptFromLog(snapshot)
    if (turns.length === 0) {
      throw new HttpError('会话中没有可摘要的对话内容', 400)
    }
    // 模板打通：指定模板名且模板存在时以其内容作为指令文本；否则回退固定契约 Prompt。
    let templateContent: string | undefined
    if (templateName !== undefined) {
      const stores = await storesReady
      templateContent = stores.templates.get(templateName)
    }
    const formatted = formatTranscript(turns, { timestamps: false })
    if (!formatted.trim()) {
      throw new HttpError('会话中没有可摘要的对话内容', 400)
    }
    // 分层路径：转录超预算 → map-reduce（缓存复用旧片段摘要）。
    if (formatted.length > TRANSCRIPT_CHAR_BUDGET) {
      const stores = await storesReady
      const result = await mapReduceSummarize(
        turns,
        TRANSCRIPT_CHAR_BUDGET,
        callModel,
        stores.chunks,
        focus,
        templateContent,
      )
      return { summary: result.summary, model: result.model || 'deepseek-chat', stats: result.stats }
    }
    // 单发路径：预算内直接一次调用（模板优先，focus 注入契约 Prompt）。
    const promptText =
      templateContent !== undefined
        ? buildHandoffPromptWithTemplate(templateContent, formatted)
        : buildHandoffPromptWithFocus(formatted, focus)
    const result = await callModel([{ role: 'user', content: promptText }])
    return {
      summary: result.content.trim(),
      model: result.model || 'deepseek-chat',
      stats: { hierarchical: false, chunks: 0, cachedChunks: 0 },
    }
  }

  /**
   * 武装摘要给下一个新对话（pending）：世代门闩——武装时刻快照全部
   * 已知会话 ID，装配回调只向「快照之外」的会话投递（详见 armed.ts 头注释）。
   * 快照失败（会话引擎异常）时退化为无快照记录（v0.1 近似），不阻塞武装。
   */
  async function armPending(summary: string): Promise<void> {
    const stores = await storesReady
    let knownSessions: string[] | undefined
    try {
      const sessions = await ctx.sessionQuery.listSessions()
      knownSessions = sessions.map((session) => String(session.id))
    } catch {
      knownSessions = undefined
    }
    await stores.armed.arm(null, summary, { knownSessions, ttlMs: ARMED_TTL_MS })
  }

  // ------------------------------------------------------------------
  // HTTP 端点（经 ctx.companion.http 挂载；注册即 effect）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/handoff/generate', async (_req, res, { body }) => {
        const record = readObject(body)
        const sessionId = SessionId(requireString(record.sessionId, 'sessionId'))
        // 可选 template 字段：模板名；未指定或模板不存在时回退固定契约 Prompt。
        const templateName = optionalString(record.template, 'template')
        // 可选 focus 字段（轴线 2）：查询聚焦主题，保留相关内容。
        const focus = optionalString(record.focus, 'focus')
        if (focus !== undefined && focus.length > FOCUS_MAX_CHARS) {
          throw new HttpError(`focus 长度不能超过 ${FOCUS_MAX_CHARS} 字符`, 400)
        }
        sendJson(res, 200, await generate(sessionId, templateName, focus))
      }),
    'companion.handoff-http-generate',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/handoff/templates', async (_req, res) => {
        const stores = await storesReady
        sendJson(res, 200, { templates: stores.templates.list() })
      }),
    'companion.handoff-http-templates-list',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/handoff/templates', async (_req, res, { body }) => {
        const record = readObject(body)
        const templateName = requireString(record.name, 'name')
        if (templateName.length > MAX_TEMPLATE_NAME_CHARS) {
          throw new HttpError(`name 长度不能超过 ${MAX_TEMPLATE_NAME_CHARS} 字符`, 400)
        }
        if (typeof record.content !== 'string' || record.content.length === 0) {
          throw new HttpError('content 必须是非空字符串', 400)
        }
        if (record.content.length > MAX_TEMPLATE_CONTENT_CHARS) {
          throw new HttpError(`content 长度不能超过 ${MAX_TEMPLATE_CONTENT_CHARS} 字符`, 400)
        }
        const stores = await storesReady
        // 数量上限：覆盖已有模板不受限，新建时超出即 400。
        if (stores.templates.get(templateName) === undefined && stores.templates.count >= MAX_TEMPLATES) {
          throw new HttpError(`模板数量已达上限（${MAX_TEMPLATES}），请先删除不再使用的模板`, 400)
        }
        await stores.templates.save(templateName, record.content)
        sendJson(res, 200, { ok: true })
      }),
    'companion.handoff-http-templates-save',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('DELETE', '/handoff/templates', async (_req, res, { body }) => {
        const record = readObject(body)
        const templateName = requireString(record.name, 'name')
        const stores = await storesReady
        await stores.templates.remove(templateName)
        sendJson(res, 200, { ok: true })
      }),
    'companion.handoff-http-templates-remove',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('POST', '/handoff/import', async (_req, res, { body }) => {
        const record = readObject(body)
        const summary = requireString(record.summary, 'summary')
        const sessionId = optionalString(record.sessionId, 'sessionId')
        // 可选 sourceSessionId（轴线 2）：摘要来源会话，用于记录继承边。
        const sourceSessionId = optionalString(record.sourceSessionId, 'sourceSessionId')
        // 无 sessionId = 武装给“下一个新对话”（pending，世代门闩）。
        if (sessionId === undefined) {
          await armPending(summary)
        } else {
          const stores = await storesReady
          await stores.armed.arm(sessionId, summary)
        }
        // 继承图谱：携带来源会话时记录边（pending 悬边待投递解析）。
        if (sourceSessionId !== undefined) {
          const stores = await storesReady
          await stores.lineage.recordEdge(sourceSessionId, sessionId ?? null, summary)
        }
        sendJson(res, 200, { ok: true, sessionId: sessionId ?? null })
      }),
    'companion.handoff-http-import',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/handoff/lineage', async (_req, res, { query }) => {
        const sessionId = query.get('sessionId')
        if (sessionId === null || sessionId.trim().length === 0) {
          throw new HttpError('sessionId 必填', 400)
        }
        const stores = await storesReady
        sendJson(res, 200, {
          ancestors: stores.lineage.ancestorsOf(sessionId.trim()),
          descendants: stores.lineage.descendantsOf(sessionId.trim()),
        })
      }),
    'companion.handoff-http-lineage',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/handoff/armed', async (_req, res) => {
        const stores = await storesReady
        // receipts：pending 摘要的投递回执（dock 展示「已注入会话 X」）。
        sendJson(res, 200, {
          armed: stores.armed.list(),
          receipts: stores.armed.listReceipts(),
        })
      }),
    'companion.handoff-http-armed-list',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('GET', '/handoff/context-health', async (_req, res, { query }) => {
        const sessionId = (query.get('sessionId') ?? '').trim()
        if (sessionId.length === 0) throw new HttpError('sessionId 必填', 400)
        let snapshot: SessionLogSnapshot
        try {
          snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
        } catch (error) {
          throw new HttpError(
            `读取会话失败：${error instanceof Error ? error.message : String(error)}`,
            404,
          )
        }
        // 上下文压力监测（轴线 6）：token 估算 + 耗尽预测 + 分级建议。
        sendJson(res, 200, {
          sessionId,
          turns: snapshot.events.length,
          ...computeContextHealth(transcriptFromLog(snapshot)),
        })
      }),
    'companion.handoff-http-context-health',
  )

  ctx.effect(
    () =>
      ctx.companion.http.add('DELETE', '/handoff/armed', async (_req, res, { body }) => {
        const record = readObject(body)
        const sessionId = optionalString(record.sessionId, 'sessionId')
        const stores = await storesReady
        // 缺省 sessionId = 解除 pending 武装（与 import 的缺省语义对称）；
        // 同时清理继承图谱悬边（防后续 pending 消费误认领）。
        if (sessionId === undefined) {
          await stores.lineage.deletePendingEdges()
        }
        await stores.armed.disarm(sessionId ?? null)
        sendJson(res, 200, { ok: true })
      }),
    'companion.handoff-http-armed-disarm',
  )

  // ------------------------------------------------------------------
  // 命令面板（与 HTTP 端点复用 generate / armed 服务函数）
  // ------------------------------------------------------------------

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'handoff',
        description: '生成当前（或指定）会话的交接摘要',
        input: { hint: '会话 ID（缺省使用当前会话）' },
        handler: async (invocation) => {
          const target = invocation.rawInput.trim() || invocation.agent.id
          if (!target) {
            return { kind: 'error', text: '未指定会话：请提供会话 ID 或在会话内调用' }
          }
          try {
            const result = await generate(SessionId(target))
            return { kind: 'success', text: result.summary }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'companion.handoff-command',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'handoff-import',
        description: '导入交接摘要（输入为摘要全文），武装给下一个新对话',
        input: { hint: '交接摘要全文' },
        handler: async (invocation) => {
          const summary = invocation.rawInput.trim()
          if (!summary) {
            return { kind: 'error', text: '请提供交接摘要全文作为命令输入' }
          }
          try {
            await armPending(summary)
            return { kind: 'success', text: '交接摘要已武装：将注入下一个新对话的系统提示词（24 小时内有效）。' }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'companion.handoff-import-command',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'context',
        description: '上下文压力报告：当前会话的 token 估算、耗尽预测与交接建议',
        input: { hint: '会话 ID（缺省使用当前会话）' },
        handler: async (invocation) => {
          const target = invocation.rawInput.trim() || invocation.agent.id
          if (!target) {
            return { kind: 'error', text: '未指定会话：请提供会话 ID 或在会话内调用' }
          }
          try {
            const snapshot = await ctx.sessionQuery.readSession(SessionId(target))
            const turns = transcriptFromLog(snapshot)
            const health = computeContextHealth(turns)
            const percent = Math.round(health.ratio * 100)
            const lines = [
              `上下文压力：${percent}%（估算 ${health.estimatedTokens} / ${health.windowTokens} token）`,
              `回合数：${turns.length}（近端平均每回合约 ${health.avgTurnTokens} token）`,
              health.remainingTurns !== null
                ? `耗尽预测：按当前增速约还可进行 ${health.remainingTurns} 回合`
                : '耗尽预测：回合数不足，暂不预测',
              `建议：${health.suggestion}`,
            ]
            return { kind: 'success', text: lines.join('\n') }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'companion.handoff-command-context',
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

/** 读取可选字符串字段；null/undefined/空白串返回 undefined。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new HttpError(`${field} 必须是字符串`, 400)
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** 将摘要渲染为注入系统提示词的段落。 */
function renderHandoffSection(summary: string): string {
  return [
    '【上下文交接摘要】',
    '以下是此前对话留下的交接摘要，请在此基础上继续当前工作：',
    '',
    summary.trim(),
  ].join('\n')
}
