/**
 * 模块 E：执行轨迹分析器 —— 解析与分析引擎。
 *
 * - deriveTraceFromLog：从会话事件日志派生轨迹（tool/step/agent/model 事件）；
 * - ingestRawTrace：摄入 Harness 原生导出的轨迹 JSON（宽松形状，逐项收窄）；
 * - detectAnomalies：异常模式识别（重试循环/Token 爆炸/缓存未命中/死循环）；
 * - diffTraces：按节点名对齐两条轨迹并输出差异；
 * - computeStats：汇总指标。
 */
import type { SessionLogSnapshot } from '../../types/harness.js'
import type {
  Trace,
  TraceAnomaly,
  TraceDiffEntry,
  TraceNode,
  TraceNodeKind,
  TraceNodeStatus,
  TraceStats,
} from './types.js'

/** 非负有限数字收窄（上游字段不可信，NaN/负数一律取 0）。 */
function toNonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 从会话事件日志派生轨迹。 */
export function deriveTraceFromLog(snapshot: SessionLogSnapshot): Trace {
  const nodes: TraceNode[] = []
  /** 节点 id → 数组下标索引：回填/配对走 O(1) 查找，避免大轨迹下 O(n²)。 */
  const nodeIndex = new Map<string, number>()
  /** 已闭合（收到 result）的工具节点 id，避免被后续 result 重复回填。 */
  const closedToolIds = new Set<string>()
  /** 未闭合的 model 调用（按出现顺序配对 completion 事件）。 */
  const openModelCalls: Array<{ id: string; name: string; startMs: number; seq: number }> = []
  /** openModelCalls 的消费游标（出队语义，避免 shift 的 O(n) 搬移）。 */
  let openCursor = 0

  /** 未闭合工具节点下标：按名栈（同名优先配对）+ 全局顺序栈（兜底取最后）。 */
  const openToolStacks = new Map<string, number[]>()
  const openToolOrder: number[] = []

  for (const event of snapshot.events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'tool/call' || event.type === 'tool/start') {
      const name = typeof data.name === 'string' ? data.name : '工具调用'
      const index = nodes.length
      nodes.push({
        id: `tool-${event.seq}`,
        name,
        kind: 'tool',
        startMs: event.time,
        endMs: event.time,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHit: false,
        status: 'ok',
        attempts: 1,
      })
      openToolOrder.push(index)
      const stack = openToolStacks.get(name)
      if (stack) stack.push(index)
      else openToolStacks.set(name, [index])
    } else if (event.type === 'tool/result') {
      // 回填最近一个同名（或最近一个）工具节点的结束时间与状态。
      const toolName = typeof data.name === 'string' ? data.name : undefined
      const targetIndex = findOpenToolIndex(nodes, closedToolIds, openToolStacks, openToolOrder, toolName)
      if (targetIndex >= 0) {
        const target = nodes[targetIndex]
        const isError = data.error !== undefined || data.isError === true
        nodes[targetIndex] = {
          ...target,
          endMs: event.time,
          durationMs: Math.max(0, event.time - target.startMs),
          status: isError ? 'error' : 'ok',
        }
        closedToolIds.add(target.id)
      }
    } else if (event.type === 'agent/dispatch') {
      nodes.push({
        id: `agent-${event.seq}`,
        name: typeof data.agent === 'string' ? data.agent : '子 Agent',
        kind: 'agent',
        startMs: event.time,
        endMs: event.time,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHit: false,
        status: 'ok',
        attempts: 1,
      })
    } else if (event.type === 'model/call' || event.type === 'llm/request') {
      const id = `model-${event.seq}`
      openModelCalls.push({
        id,
        name: typeof data.model === 'string' ? data.model : '模型调用',
        startMs: event.time,
        seq: event.seq,
      })
      nodeIndex.set(id, nodes.length)
      nodes.push({
        id,
        name: typeof data.model === 'string' ? data.model : '模型调用',
        kind: 'model',
        startMs: event.time,
        endMs: event.time,
        durationMs: 0,
        inputTokens: toNonNegative(data.inputTokens ?? data.promptTokens),
        outputTokens: 0,
        model: typeof data.model === 'string' ? data.model : undefined,
        cacheHit: false,
        status: 'ok',
        attempts: 1,
      })
    } else if (event.type === 'model/completion' || event.type === 'llm/response') {
      const open = openModelCalls[openCursor]
      if (!open) continue
      openCursor += 1
      const position = nodeIndex.get(open.id)
      if (position === undefined) continue
      const existing = nodes[position]
      const cacheHitTokens = toNonNegative(data.cacheHitTokens ?? data.promptCacheHitTokens)
      const inputTokens = Math.max(existing.inputTokens, toNonNegative(data.inputTokens ?? data.promptTokens))
      nodes[position] = {
        ...existing,
        endMs: event.time,
        durationMs: Math.max(0, event.time - open.startMs),
        inputTokens,
        outputTokens: toNonNegative(data.outputTokens ?? data.completionTokens),
        cacheHit: cacheHitTokens > 0,
        status: data.error !== undefined ? 'error' : 'ok',
      }
    }
  }

  // 单次遍历求边界；不用 Math.min/max(...spread)，避免大轨迹下参数过多与额外数组分配。
  let startedAt = snapshot.session.createdAt
  let endedAt = startedAt
  if (nodes.length > 0) {
    startedAt = nodes[0].startMs
    endedAt = nodes[0].endMs
    for (const node of nodes) {
      if (node.startMs < startedAt) startedAt = node.startMs
      if (node.endMs > endedAt) endedAt = node.endMs
    }
  }
  return {
    id: `trace-${snapshot.session.id}`,
    sessionId: snapshot.session.id,
    startedAt,
    endedAt,
    nodes: consolidateRetries(nodes),
  }
}

/**
 * 定位回填目标工具节点的下标（优先同名，否则取最后一个未闭合的）。
 * 按名栈 + 全局顺序栈均做惰性清理（仅弹出尾部已闭合项），摊还 O(1)。
 */
function findOpenToolIndex(
  nodes: readonly TraceNode[],
  closed: ReadonlySet<string>,
  byName: Map<string, number[]>,
  order: number[],
  toolName?: string,
): number {
  if (toolName !== undefined) {
    const stack = byName.get(toolName)
    if (stack) {
      while (stack.length > 0 && closed.has(nodes[stack[stack.length - 1]].id)) stack.pop()
      if (stack.length > 0) return stack.pop() as number
    }
  }
  while (order.length > 0 && closed.has(nodes[order[order.length - 1]].id)) order.pop()
  return order.length > 0 ? order[order.length - 1] : -1
}

/**
 * 重试合并：同一名称的工具节点连续出现且均失败（≥2 次）时，
 * 合并为一个节点并累计 attempts，便于异常检测识别“重试循环”。
 */
function consolidateRetries(nodes: readonly TraceNode[]): TraceNode[] {
  const result: TraceNode[] = []
  for (const node of nodes) {
    const prev = result[result.length - 1]
    if (
      prev &&
      node.kind === 'tool' &&
      prev.kind === 'tool' &&
      prev.name === node.name &&
      prev.status === 'error' &&
      node.status === 'error'
    ) {
      result[result.length - 1] = {
        ...prev,
        endMs: node.endMs,
        durationMs: prev.durationMs + node.durationMs,
        attempts: prev.attempts + 1,
        status: 'retry',
      }
      continue
    }
    result.push(node)
  }
  return result
}

/**
 * 摄入 Harness 原生导出的轨迹 JSON（宽松形状）。
 * 接受 { steps: [...] } 或裸数组；每项至少需要 name，其余字段缺省安全值。
 */
export function ingestRawTrace(raw: unknown, traceId: string): Trace {
  const list = extractStepList(raw)
  const nodes: TraceNode[] = []
  let cursor = Date.now()
  list.forEach((entry, index) => {
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : `步骤 ${index + 1}`
    const startMs = toNonNegative(record.startMs ?? record.start ?? record.startTime) || cursor
    const durationMs = toNonNegative(record.durationMs ?? record.duration)
    const endMs = startMs + durationMs
    cursor = Math.max(cursor, endMs)
    const kind = normalizeKind(record.kind ?? record.type)
    nodes.push({
      id: typeof record.id === 'string' ? record.id : `raw-${index}`,
      name,
      kind,
      startMs,
      endMs,
      durationMs,
      inputTokens: toNonNegative(record.inputTokens ?? record.promptTokens),
      outputTokens: toNonNegative(record.outputTokens ?? record.completionTokens),
      model: typeof record.model === 'string' ? record.model : undefined,
      cacheHit: record.cacheHit === true || toNonNegative(record.cacheHitTokens) > 0,
      status: normalizeStatus(record.status),
      attempts: Math.max(1, Math.floor(toNonNegative(record.attempts)) || 1),
      parentId: typeof record.parentId === 'string' ? record.parentId : undefined,
    })
  })
  // 单次遍历求边界；不用 Math.min/max(...spread)，避免大轨迹下参数过多与额外数组分配。
  let startedAt = cursor
  let endedAt = cursor
  if (nodes.length > 0) {
    startedAt = Number.POSITIVE_INFINITY
    endedAt = Number.NEGATIVE_INFINITY
    for (const node of nodes) {
      if (node.startMs < startedAt) startedAt = node.startMs
      if (node.endMs > endedAt) endedAt = node.endMs
    }
  }
  return { id: traceId, startedAt, endedAt, nodes }
}

/** 从未知输入中提取步骤数组。 */
function extractStepList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>
    if (Array.isArray(record.steps)) return record.steps
    if (Array.isArray(record.nodes)) return record.nodes
    if (Array.isArray(record.spans)) return record.spans
  }
  return []
}

function normalizeKind(value: unknown): TraceNodeKind {
  if (value === 'tool' || value === 'agent' || value === 'model' || value === 'step') return value
  return 'step'
}

function normalizeStatus(value: unknown): TraceNodeStatus {
  if (value === 'error' || value === 'failed' || value === 'failure') return 'error'
  if (value === 'retry' || value === 'retrying') return 'retry'
  return 'ok'
}

/** 异常检测阈值。 */
export interface AnomalyThresholds {
  /** 单步骤输出 Token 超过该值视为 Token 爆炸。 */
  readonly tokenExplosion: number
  /** 同一工具连续失败达到该次数视为重试循环。 */
  readonly retryLoopAttempts: number
  /** 相似操作重复达到该次数视为死循环。 */
  readonly infiniteLoopRepeats: number
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  tokenExplosion: 8000,
  retryLoopAttempts: 3,
  infiniteLoopRepeats: 5,
}

/** 异常自动标注（E2）。 */
export function detectAnomalies(
  trace: Trace,
  thresholds: AnomalyThresholds = DEFAULT_ANOMALY_THRESHOLDS,
): TraceAnomaly[] {
  const anomalies: TraceAnomaly[] = []

  // 重试循环：同一工具连续失败 ≥ N 次（consolidateRetries 已合并为 attempts）。
  const retryNodes = trace.nodes.filter(
    (node) => node.kind === 'tool' && node.attempts >= thresholds.retryLoopAttempts,
  )
  if (retryNodes.length > 0) {
    anomalies.push({
      kind: 'retry-loop',
      nodeIds: retryNodes.map((node) => node.id),
      reason: retryNodes
        .map((node) => `「${node.name}」连续失败 ${node.attempts} 次`)
        .join('；'),
      suggestion: '检查该工具的输入参数与外部依赖是否稳定，必要时增加前置校验或降级路径。',
      severity: 3,
    })
  }

  // Token 爆炸：单步骤输出 Token 超过阈值。
  const explosionNodes = trace.nodes.filter((node) => node.outputTokens > thresholds.tokenExplosion)
  if (explosionNodes.length > 0) {
    anomalies.push({
      kind: 'token-explosion',
      nodeIds: explosionNodes.map((node) => node.id),
      reason: explosionNodes
        .map((node) => `「${node.name}」输出 ${node.outputTokens} tokens（阈值 ${thresholds.tokenExplosion}）`)
        .join('；'),
      suggestion: '为该步骤设置 max_tokens 上限，或拆分任务、要求更精简的输出格式。',
      severity: 2,
    })
  }

  // 缓存未命中：同名模型调用出现 ≥2 次且全部未命中缓存。
  const modelByName = new Map<string, TraceNode[]>()
  for (const node of trace.nodes) {
    if (node.kind !== 'model') continue
    const list = modelByName.get(node.name) ?? []
    list.push(node)
    modelByName.set(node.name, list)
  }
  const missNodes: TraceNode[] = []
  for (const list of modelByName.values()) {
    if (list.length >= 2 && list.every((node) => !node.cacheHit)) missNodes.push(...list)
  }
  if (missNodes.length > 0) {
    anomalies.push({
      kind: 'cache-miss',
      nodeIds: missNodes.map((node) => node.id),
      reason: `${missNodes.length} 次重复模型调用均未命中前缀缓存`,
      suggestion: '保持重复请求的公共前缀（system prompt、示例）稳定不变，以复用前缀缓存降低成本。',
      severity: 1,
    })
  }

  // 死循环：同名节点（工具/步骤）重复出现 ≥ N 次。
  const nameCounts = new Map<string, TraceNode[]>()
  for (const node of trace.nodes) {
    if (node.kind === 'model') continue
    const list = nameCounts.get(node.name) ?? []
    list.push(node)
    nameCounts.set(node.name, list)
  }
  for (const [name, list] of nameCounts) {
    if (list.length >= thresholds.infiniteLoopRepeats) {
      anomalies.push({
        kind: 'infinite-loop',
        nodeIds: list.map((node) => node.id),
        reason: `「${name}」重复执行 ${list.length} 次，疑似死循环`,
        suggestion: '检查 Agent 的终止条件与状态推进逻辑，避免在相同状态下反复执行同一操作。',
        severity: 3,
      })
    }
  }

  return anomalies
}

/** 轨迹对比（E3）：按节点名对齐，输出差异条目。 */
export function diffTraces(oldTrace: Trace, newTrace: Trace): TraceDiffEntry[] {
  const oldByName = aggregateByName(oldTrace)
  const newByName = aggregateByName(newTrace)
  const entries: TraceDiffEntry[] = []
  const names = new Set([...oldByName.keys(), ...newByName.keys()])
  for (const name of names) {
    const oldAgg = oldByName.get(name)
    const newAgg = newByName.get(name)
    if (oldAgg && !newAgg) {
      entries.push({
        name,
        change: 'removed',
        oldDurationMs: oldAgg.durationMs,
        oldTokens: oldAgg.tokens,
      })
      continue
    }
    if (!oldAgg && newAgg) {
      entries.push({
        name,
        change: 'added',
        newDurationMs: newAgg.durationMs,
        newTokens: newAgg.tokens,
      })
      continue
    }
    if (oldAgg && newAgg) {
      const durationDeltaMs = newAgg.durationMs - oldAgg.durationMs
      const tokenDelta = newAgg.tokens - oldAgg.tokens
      entries.push({
        name,
        change: durationDeltaMs === 0 && tokenDelta === 0 ? 'same' : 'changed',
        oldDurationMs: oldAgg.durationMs,
        newDurationMs: newAgg.durationMs,
        durationDeltaMs,
        oldTokens: oldAgg.tokens,
        newTokens: newAgg.tokens,
        tokenDelta,
      })
    }
  }
  // 变化最大的排前面，便于 UI 直接展示。
  entries.sort((a, b) => {
    const score = (entry: TraceDiffEntry): number =>
      Math.abs(entry.durationDeltaMs ?? entry.oldDurationMs ?? entry.newDurationMs ?? 0)
    return score(b) - score(a)
  })
  return entries
}

/** 按名称聚合（同名节点合并耗时与 Token）。 */
function aggregateByName(trace: Trace): Map<string, { durationMs: number; tokens: number }> {
  const map = new Map<string, { durationMs: number; tokens: number }>()
  for (const node of trace.nodes) {
    const agg = map.get(node.name) ?? { durationMs: 0, tokens: 0 }
    agg.durationMs += node.durationMs
    agg.tokens += node.inputTokens + node.outputTokens
    map.set(node.name, agg)
  }
  return map
}

/** 汇总指标（E4）。单次遍历聚合全部指标。 */
export function computeStats(trace: Trace): TraceStats {
  let toolCount = 0
  let toolSuccess = 0
  let modelCount = 0
  let cacheHits = 0
  let agentDispatches = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  for (const node of trace.nodes) {
    totalInputTokens += node.inputTokens
    totalOutputTokens += node.outputTokens
    if (node.kind === 'tool') {
      toolCount += 1
      if (node.status === 'ok') toolSuccess += 1
    } else if (node.kind === 'model') {
      modelCount += 1
      if (node.cacheHit) cacheHits += 1
    } else if (node.kind === 'agent') {
      agentDispatches += 1
    }
  }
  return {
    totalDurationMs: trace.endedAt - trace.startedAt,
    totalInputTokens,
    totalOutputTokens,
    cacheHitRate: modelCount > 0 ? cacheHits / modelCount : 0,
    toolSuccessRate: toolCount > 0 ? toolSuccess / toolCount : 1,
    agentDispatches,
    nodeCount: trace.nodes.length,
  }
}

/** 按 key 取前 limit 大（插入式部分选择，O(n·limit)，limit 小时优于全排序）。 */
function topByLimit(
  nodes: readonly TraceNode[],
  limit: number,
  key: (node: TraceNode) => number,
): TraceNode[] {
  const top: TraceNode[] = []
  for (const node of nodes) {
    const value = key(node)
    let position = top.length
    while (position > 0 && key(top[position - 1]) < value) position -= 1
    if (position < limit) {
      top.splice(position, 0, node)
      if (top.length > limit) top.pop()
    }
  }
  return top
}

/** 按耗时降序取前 N（定位最慢步骤）。 */
export function slowestNodes(trace: Trace, limit: number = 3): TraceNode[] {
  return topByLimit(trace.nodes, limit, (node) => node.durationMs)
}

/** 按 Token 消耗降序取前 N（定位最贵步骤）。 */
export function costliestNodes(trace: Trace, limit: number = 3): TraceNode[] {
  return topByLimit(trace.nodes, limit, (node) => node.inputTokens + node.outputTokens)
}
