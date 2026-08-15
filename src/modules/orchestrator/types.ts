/**
 * 模块 H：断点续跑与任务编排 —— 数据模型。
 *
 * H1 可视化流水线：Pipeline + PipelineStep（模型/Prompt/输入来源/超时/重试/依赖）；
 * H2 断点续跑：PipelineRun 持久化每步中间结果，恢复时从最后成功步骤继续；
 * H3 批量队列：QueueTask（优先级/截止时间/失败策略）；
 * H4 定时调度：ScheduledJob（Cron 或自然语言）+ ScheduledRun 归档。
 */

/** 流水线步骤执行状态。 */
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** 流水线整体执行状态。 */
export type RunStatus = 'running' | 'done' | 'failed' | 'paused' | 'cancelled'

/** 流水线步骤定义（H1）。 */
export interface PipelineStep {
  readonly id: string
  readonly name: string
  /** 使用的模型（缺省 deepseek-chat）。 */
  readonly model: string
  /** Prompt 模板。 */
  readonly prompt: string
  /** 输入来源：prev=上游依赖输出拼接；literal=使用 input 字段。 */
  readonly inputFrom: 'prev' | 'literal'
  /** inputFrom='literal' 时的固定输入。 */
  readonly input: string
  /**
   * 条件分支：非空时，仅当全部依赖步骤的输出拼接包含该子串才执行，
   * 否则标记 skipped（下游依赖按“完成但输出为空”继续）。
   */
  readonly condition: string
  /** 单步超时（毫秒）；0=沿用全局 apiTimeoutMs。 */
  readonly timeoutMs: number
  /** 失败自动重试次数（0=不重试）。 */
  readonly maxRetries: number
  /** 重试间隔（毫秒）。 */
  readonly retryIntervalMs: number
  /** 依赖的上游步骤 id（空数组=无依赖，可并行）。 */
  readonly dependsOn: readonly string[]
}

/** 流水线定义（H1）。 */
export interface Pipeline {
  readonly id: string
  readonly name: string
  readonly steps: readonly PipelineStep[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** 单步运行记录（H2：中间结果持久化）。 */
export interface StepRun {
  readonly stepId: string
  status: StepStatus
  attempts: number
  /** 中间结果输出（断点恢复时直接复用，不重跑）。 */
  output: string
  error: string
  startedAt: number
  endedAt: number
  latencyMs: number
  tokens: number
}

/** 一次流水线执行（H2：断点续跑单元）。 */
export interface PipelineRun {
  readonly id: string
  readonly pipelineId: string
  status: RunStatus
  readonly startedAt: number
  endedAt: number
  /** stepId → 步骤运行记录。 */
  steps: Readonly<Record<string, StepRun>>
  /** 失败/暂停原因。 */
  message: string
}

/** 队列任务优先级（H3）。 */
export type TaskPriority = 'high' | 'medium' | 'low'

/** 队列任务失败策略（H3）。 */
export type FailurePolicy = 'skip' | 'retry' | 'notify'

/** 队列任务状态（H3）。 */
export type QueueTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused'

/** 批量队列任务（H3）。 */
export interface QueueTask {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly model: string
  readonly priority: TaskPriority
  /** 截止时间（毫秒时间戳）；0=无。 */
  readonly deadline: number
  readonly failurePolicy: FailurePolicy
  status: QueueTaskStatus
  readonly createdAt: number
  finishedAt: number
  output: string
  error: string
  attempts: number
}

/** 定时任务（H4）。 */
export interface ScheduledJob {
  readonly id: string
  readonly name: string
  /** 标准 5 字段 Cron 表达式（自然语言在保存时已转换）。 */
  readonly cron: string
  /** 用户原始输入（cron 或自然语言），用于界面展示。 */
  readonly scheduleText: string
  readonly prompt: string
  readonly model: string
  /** true=结合峰谷定价，仅在北京时间空闲时段执行。 */
  readonly offPeakOnly: boolean
  enabled: boolean
  readonly createdAt: number
  lastRunAt: number
  nextRunAt: number
}

/** 定时任务执行归档（H4）。 */
export interface ScheduledRun {
  readonly id: string
  readonly jobId: string
  readonly ts: number
  readonly ok: boolean
  readonly output: string
  readonly error: string
  readonly latencyMs: number
}
