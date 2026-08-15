/**
 * DeepSeek Harness 服务契约适配层。
 *
 * 本文件按 DeepSeek Harness v0.1 官方文档（docs/subsystems/* 与 docs/cordis-api/*）
 * 声明插件所消费的 Harness 服务接口。仓库内其余代码只依赖这里定义的类型，
 * 与真实 `@deepseek-ai/dsh-*` 包的对接点全部集中在此：
 * 当目标 Harness 版本提供更精确的类型导出时，仅需对齐本文件。
 *
 * 对应文档：
 * - storage:      docs/subsystems/storage.md（ctx.storageDomain / defineDomain / KvTable）
 * - settings:     docs/subsystems/settings.md（ctx.settings.register / SettingsScope）
 * - credentials:  docs/subsystems/credentials.md（ctx.credentials resolve/set/unset）
 * - session-query:docs/subsystems/session-query.md（ctx.sessionQuery）
 * - commands:     docs/subsystems/commands.md（ctx.commands.register）
 * - system-prompt:docs/subsystems/system-prompt.md（ctx.systemPrompt.section/context）
 * - web-server:   docs/subsystems/web-server.md（ctx.webServer.register）
 * - user-questions:docs/subsystems/user-questions.md（ctx.userQuestions.ask）
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RealDomainFacility } from '../core/storage-adapter.js'

// ---------------------------------------------------------------------------
// 品牌类型（Harness 约定：跨边界的不透明 id 一律品牌化，不用裸 string）
// ---------------------------------------------------------------------------

/** 会话 id（品牌化字符串）。 */
export type SessionId = string & { readonly __dshSessionId: never }

/** 系统提示词装配作用域键（品牌化字符串）。 */
export type ScopeKey = string & { readonly __dshScopeKey: never }

/** 凭据引用：合法的 POSIX 环境变量名（品牌化字符串）。 */
export type CredentialRef = string & { readonly __dshCredentialRef: never }

// ---------------------------------------------------------------------------
// 会话与消息
// ---------------------------------------------------------------------------

/** 文本内容块。 */
export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** 其余内容块（工具调用、图片等）的宽松表示。 */
export interface GenericContentBlock {
  readonly type: string
  readonly [key: string]: unknown
}

export type ContentBlock = TextContentBlock | GenericContentBlock

/** 模型可见消息（从会话日志派生，见 docs/subsystems/session.md）。 */
export interface ChatMessageLike {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | readonly ContentBlock[]
  readonly createdAt?: number
}

/** 会话头信息。 */
export interface SessionHeader {
  readonly id: SessionId
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt?: number
  readonly cwd?: string
}

/** 会话列表记录。 */
export type SessionRecord = SessionHeader

/** 会话日志事件（append-only，类型化；这里保留宽松载荷）。 */
export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

/** readSession 的返回：完整分离、回放校验的原始日志。 */
export interface SessionLogSnapshot {
  readonly session: SessionHeader
  readonly events: readonly SessionEvent[]
}

// ---------------------------------------------------------------------------
// session-query（ctx.sessionQuery）
// ---------------------------------------------------------------------------

/** 时间范围（毫秒时间戳，闭区间）。 */
export interface SessionTimeRange {
  readonly from?: number
  readonly to?: number
}

/** 会话级结果过滤子句；数组内 AND，单子句 values 内 OR。 */
export type SessionResultFilter =
  | ({ readonly kind: 'created-at' } & SessionTimeRange)
  | { readonly kind: 'id'; readonly values: readonly SessionId[] }
  | { readonly kind: 'cwd'; readonly values: readonly string[] }

/** 跨会话全文检索请求。query 作为纯数据处理，不会被解释为 FTS 语法。 */
export interface SessionSearchRequest {
  readonly query?: string
  readonly limit?: number
  readonly cursor?: string
  readonly filters?: readonly SessionResultFilter[]
}

export interface SessionSearchHit {
  readonly session: SessionRecord
  readonly snippet?: string
  readonly score?: number
}

export interface SessionSearchPage {
  readonly hits: readonly SessionSearchHit[]
  readonly cursor?: string
}

/** 会话查询引擎（抽象 seam；SQLite 提供者负责全文索引）。 */
export interface SessionQueryEngine {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecord[]>
  readSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLogSnapshot>
  searchSessions(request: SessionSearchRequest, signal?: AbortSignal): Promise<SessionSearchPage>
  filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<readonly SessionRecord[]>
}

// ---------------------------------------------------------------------------
// settings（ctx.settings）
// ---------------------------------------------------------------------------

/** schemastery schema 的宽松表示，避免在契约层耦合其具体类型形状。 */
export interface SchemaLike<T> {
  readonly __output?: T
  readonly [key: string]: unknown
}

/** 注册后得到的命名空间作用域。 */
export interface SettingsScope<T> {
  get(): T
  update(patch: Partial<T>): Promise<void>
  replace(section: Partial<T>): Promise<void>
  watch(callback: (next: T, prev: T) => void): () => void
}

export interface SettingsRegisterOptions<T> {
  readonly base?: Partial<T>
  readonly applies?: 'live' | 'restart'
  readonly validate?: (value: T) => string | undefined
}

export interface SettingsDescriptor {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
}

/** 设置能力 seam。wire 表面必须 describe({ redactSecrets: true })。 */
export interface SettingsProvider {
  register<T>(ns: string, schema: SchemaLike<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptor[]
}

// ---------------------------------------------------------------------------
// credentials（ctx.credentials）
// ---------------------------------------------------------------------------

export interface ResolvedCredential {
  readonly value: string
  readonly source: string
}

export interface CredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** 凭据 seam：配置中只保存引用，值由提供者持有；每次操作重新解析，不得缓存。 */
export interface CredentialProvider {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  describe(ref: CredentialRef): Promise<CredentialInfo>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

// ---------------------------------------------------------------------------
// commands（ctx.commands）
// ---------------------------------------------------------------------------

/** 命令输入提示描述符（真实 Harness 要求 { hint: string } 对象）。 */
export interface CommandInputDescriptor {
  readonly hint: string
}

/** 传递给命令 handler 的调用对象（真实 Harness 形态）。 */
export interface CommandInvocation {
  /** 本次调用的配对 ID（写入 command/run 事件）。 */
  readonly commandId: string
  /** 接收命令的 agent 句柄；agent.id 即 SessionId。 */
  readonly agent: { readonly id: SessionId }
  /** 命令名之后的原始文本（含分隔空白）。 */
  readonly rawInput: string
  /** 派发方 UI 请求持有的取消信号。 */
  readonly signal: AbortSignal
}

/** 命令 handler 的返回值（真实 Harness 形态）。 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandDefinition {
  /** 小写、不带斜杠的命令名。 */
  readonly name: string
  readonly description: string
  /** 可选输入提示（必须是 { hint: string } 对象，不能是纯字符串）。 */
  readonly input?: CommandInputDescriptor
  readonly recordInput?: boolean
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

export interface CommandRuntime {
  register(definition: CommandDefinition): () => void
}

// ---------------------------------------------------------------------------
// system-prompt（ctx.systemPrompt）
// ---------------------------------------------------------------------------

/** 一次提示词装配的上下文（可合并扩展）。 */
export interface AssembleContext {
  readonly scope?: ScopeKey
  readonly signal?: AbortSignal
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}

export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
}

export interface SystemPromptRegistry {
  section(section: PromptSection): () => void
  context(context: PromptContext): () => void
}

// ---------------------------------------------------------------------------
// web-server（ctx.webServer）
// ---------------------------------------------------------------------------

export type WebRouteKind = 'exact' | 'prefix'

export interface WebRoute {
  readonly kind: WebRouteKind
  /** 绝对路径，不以斜杠结尾。 */
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServer {
  register(route: WebRoute): () => void
}

// ---------------------------------------------------------------------------
// user-questions（ctx.userQuestions）
// ---------------------------------------------------------------------------

export interface AskUserQuestionItem {
  readonly question: string
  readonly options?: readonly string[]
  readonly multiSelect?: boolean
}

export interface AskUserQuestionRequest {
  readonly questions: readonly AskUserQuestionItem[]
}

export interface AskUserQuestionAnswer {
  readonly answers?: readonly string[]
  readonly aborted?: boolean
  readonly [key: string]: unknown
}

export interface UserQuestionService {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

// ---------------------------------------------------------------------------
// Cordis Context / Events 声明合并
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: RealDomainFacility
    settings: SettingsProvider
    credentials: CredentialProvider
    sessionQuery: SessionQueryEngine
    commands: CommandRuntime
    systemPrompt: SystemPromptRegistry
    webServer: WebServer
    userQuestions: UserQuestionService
  }

  interface Events {
    /** 一次 DeepSeek API 调用完成并记账后发出。 */
    'companion/usage'(entry: {
      readonly ts: number
      readonly model: string
      readonly promptTokens: number
      readonly completionTokens: number
      readonly costCny: number
      readonly source: string
    }): void
    /** 预算预警（日/月双档）：level 为 80 或 100。 */
    'companion/budget-alert'(alert: {
      readonly level: 80 | 100
      /** 预算档位：daily=日预算，monthly=月预算。 */
      readonly tier: 'daily' | 'monthly'
      /** 预警所属周期键（日 YYYY-MM-DD 或月 YYYY-MM）。 */
      readonly period: string
      readonly spentCny: number
      readonly budgetCny: number
      readonly paused: boolean
    }): void
    /** 插件对用户的一般性提醒（由 UI 层以 Toast 呈现）。 */
    'companion/notice'(notice: {
      readonly kind: 'info' | 'success' | 'warning' | 'error'
      readonly message: string
    }): void
  }
}
