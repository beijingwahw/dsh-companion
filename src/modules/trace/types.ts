/**
 * 模块 E：执行轨迹分析器 —— 数据模型。
 *
 * Harness 原生“执行轨迹”记录每个步骤，但只是线性流水。这里把它规范化为
 * 带层级、耗时、Token 消耗与缓存命中的节点树，供可视化/异常标注/对比/统计复用。
 * 节点来源有两类：
 * 1. 从 session-query 的会话事件日志派生（tool/step/agent/model 事件）；
 * 2. 直接摄入 Harness 导出的原生轨迹 JSON（`ingestRawTrace`）。
 */

/** 轨迹节点类别。 */
export type TraceNodeKind = 'step' | 'tool' | 'agent' | 'model'

/** 节点执行结果。 */
export type TraceNodeStatus = 'ok' | 'error' | 'retry'

/** 单个轨迹节点（一次步骤/工具调用/子 Agent 派发/模型调用）。 */
export interface TraceNode {
  /** 节点唯一 id（派生自事件 seq 或原生 trace 的 span id）。 */
  readonly id: string
  /** 展示名（步骤名/工具名/Agent 名/模型名）。 */
  readonly name: string
  readonly kind: TraceNodeKind
  /** 开始时间（毫秒时间戳）。 */
  readonly startMs: number
  /** 结束时间（毫秒时间戳）。 */
  readonly endMs: number
  /** 耗时（毫秒）= endMs - startMs。 */
  readonly durationMs: number
  /** 输入 Token。 */
  readonly inputTokens: number
  /** 输出 Token。 */
  readonly outputTokens: number
  /** 使用的模型（仅 model/step 节点可能有）。 */
  readonly model?: string
  /** 是否命中前缀缓存。 */
  readonly cacheHit: boolean
  readonly status: TraceNodeStatus
  /** 累计尝试次数（含首次）。 */
  readonly attempts: number
  /** 父节点 id（用于层级/火焰图）。 */
  readonly parentId?: string
}

/** 一条完整执行轨迹。 */
export interface Trace {
  readonly id: string
  /** 关联会话（派生轨迹有；外部摄入可缺省）。 */
  readonly sessionId?: string
  readonly startedAt: number
  readonly endedAt: number
  readonly nodes: readonly TraceNode[]
}

/** 异常类别。 */
export type AnomalyKind = 'retry-loop' | 'token-explosion' | 'cache-miss' | 'infinite-loop'

/** 单个异常标注。 */
export interface TraceAnomaly {
  readonly kind: AnomalyKind
  /** 触发异常的节点 id 列表。 */
  readonly nodeIds: readonly string[]
  /** 人类可读的原因说明。 */
  readonly reason: string
  /** 处理建议。 */
  readonly suggestion: string
  /** 严重度（1-3）。 */
  readonly severity: 1 | 2 | 3
}

/** 轨迹汇总指标（E4 统计面板）。 */
export interface TraceStats {
  readonly totalDurationMs: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  /** 缓存命中率（0-1）。 */
  readonly cacheHitRate: number
  /** 工具调用成功率（0-1）。 */
  readonly toolSuccessRate: number
  /** 子 Agent 派发数量。 */
  readonly agentDispatches: number
  readonly nodeCount: number
}

/** 两条轨迹的差异条目（E3 对比）。 */
export interface TraceDiffEntry {
  readonly name: string
  /** added=仅新轨迹有；removed=仅旧轨迹有；changed=两侧都有但指标变化。 */
  readonly change: 'added' | 'removed' | 'changed' | 'same'
  readonly oldDurationMs?: number
  readonly newDurationMs?: number
  readonly durationDeltaMs?: number
  readonly oldTokens?: number
  readonly newTokens?: number
  readonly tokenDelta?: number
}
