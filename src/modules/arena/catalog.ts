/**
 * 模块 G：多模型竞技场 —— 模型目录与推荐引擎。
 *
 * 目录内置 DeepSeek 与常见外部模型的元信息（任务类型准确率先验、
 * 延迟档位）；外部厂商需用户另行配置 API Key（arena-keys 加密存储）。
 * 推荐引擎（G3）结合任务类型 + 预算 + 延迟要求 + 峰谷定价给出排序建议。
 */
import { isPeakTime } from '../../core/time.js'

/** 任务类型。 */
export type TaskType = 'code' | 'translation' | 'summarization' | 'reasoning' | 'general'

/** 模型目录条目。 */
export interface ArenaModelInfo {
  readonly id: string
  readonly label: string
  /** deepseek=官方 API；external=需另配 Key 的外部厂商。 */
  readonly provider: 'deepseek' | 'external'
  /** 外部厂商的 API 基址（provider=external 时）。 */
  readonly baseUrl?: string
  /** 各任务类型的准确率先验（0-1，来自公开评测的经验值）。 */
  readonly accuracyPrior: Readonly<Record<TaskType, number>>
  /** 典型延迟档位：fast / balanced / slow。 */
  readonly latencyTier: 'fast' | 'balanced' | 'slow'
}

/** 内置模型目录（准确率先验为公开评测经验值，仅用于推荐排序）。 */
export const ARENA_MODEL_CATALOG: readonly ArenaModelInfo[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V4-Flash（deepseek-chat）',
    provider: 'deepseek',
    accuracyPrior: { code: 0.88, translation: 0.9, summarization: 0.9, reasoning: 0.82, general: 0.88 },
    latencyTier: 'fast',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek V4-Pro（deepseek-reasoner）',
    provider: 'deepseek',
    accuracyPrior: { code: 0.94, translation: 0.92, summarization: 0.92, reasoning: 0.95, general: 0.93 },
    latencyTier: 'slow',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'external',
    baseUrl: 'https://api.openai.com/v1',
    accuracyPrior: { code: 0.93, translation: 0.93, summarization: 0.93, reasoning: 0.92, general: 0.93 },
    latencyTier: 'balanced',
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    provider: 'external',
    baseUrl: 'https://api.anthropic.com/v1',
    accuracyPrior: { code: 0.95, translation: 0.92, summarization: 0.93, reasoning: 0.94, general: 0.94 },
    latencyTier: 'balanced',
  },
]

/** 延迟档位 → 数值（用于推荐打分）。 */
const LATENCY_SCORE: Record<ArenaModelInfo['latencyTier'], number> = {
  fast: 1,
  balanced: 0.6,
  slow: 0.35,
}

/** 推荐请求。 */
export interface RecommendRequest {
  readonly taskType: TaskType
  /** 单次调用预算上限（元）；0=不限。 */
  readonly budgetPerCallCny: number
  /** 延迟要求：fast=尽量快 / balanced=均衡 / any=不限。 */
  readonly latencyRequirement: 'fast' | 'balanced' | 'any'
}

/** 推荐结果条目。 */
export interface Recommendation {
  readonly model: ArenaModelInfo
  readonly score: number
  readonly reason: string
}

/**
 * 模型推荐引擎（G3）：
 * 得分 = 准确率先验 × 0.6 + 延迟匹配 × 0.25 + 成本优势 × 0.15；
 * 峰谷感知：空闲时段在理由中提示低成本窗口。
 */
export function recommendModels(
  request: RecommendRequest,
  costPerCall: Readonly<Record<string, number>>,
  now: number = Date.now(),
): Recommendation[] {
  const offPeak = !isPeakTime(now)
  const candidates = ARENA_MODEL_CATALOG.filter((model) => {
    if (request.latencyRequirement === 'fast' && model.latencyTier === 'slow') return false
    if (request.budgetPerCallCny > 0) {
      const cost = costPerCall[model.id]
      if (cost !== undefined && cost > request.budgetPerCallCny) return false
    }
    return true
  })

  const costs = candidates.map((model) => costPerCall[model.id] ?? 0)
  const minCost = costs.length > 0 ? Math.min(...costs) : 0
  const maxCost = costs.length > 0 ? Math.max(...costs) : 0

  const scored = candidates.map((model) => {
    const accuracy = model.accuracyPrior[request.taskType] ?? 0.85
    const latencyScore =
      request.latencyRequirement === 'any'
        ? 0.8
        : request.latencyRequirement === 'fast'
          ? model.latencyTier === 'fast'
            ? 1
            : model.latencyTier === 'balanced'
              ? 0.5
              : 0.2
          : LATENCY_SCORE[model.latencyTier]
    const cost = costPerCall[model.id] ?? 0
    const costScore = maxCost > minCost ? 1 - (cost - minCost) / (maxCost - minCost) : 1
    const score = accuracy * 0.6 + latencyScore * 0.25 + costScore * 0.15
    const reason = buildReason(model, request, cost, offPeak, costPerCall)
    return { model, score, reason }
  })

  return scored.sort((a, b) => b.score - a.score)
}

/** 生成推荐理由文案。 */
function buildReason(
  model: ArenaModelInfo,
  request: RecommendRequest,
  cost: number,
  offPeak: boolean,
  costPerCall: Readonly<Record<string, number>>,
): string {
  const parts: string[] = []
  const accuracy = model.accuracyPrior[request.taskType] ?? 0.85
  parts.push(`该任务类型准确率先验 ${(accuracy * 100).toFixed(0)}%`)
  if (cost > 0) parts.push(`单次估算成本 ¥${cost.toFixed(4)}`)
  if (offPeak) {
    // 与最贵候选对比，突出空闲时段性价比。
    const others = Object.entries(costPerCall).filter(([id]) => id !== model.id)
    const pricier = others.filter(([, otherCost]) => otherCost > cost)
    if (pricier.length > 0) {
      const [topId, topCost] = pricier.sort((a, b) => b[1] - a[1])[0]
      if (topCost > 0 && cost > 0) {
        parts.push(
          `当前为空闲时段，成本仅为 ${topId} 的 ${(cost / topCost).toFixed(2)} 倍`,
        )
      }
    } else {
      parts.push('当前为空闲时段（峰谷定价优惠窗口）')
    }
  } else {
    parts.push('当前为高峰时段，可考虑延迟非紧急任务至空闲时段')
  }
  return parts.join('；')
}

/** 任务类型中文标签。 */
export function taskTypeLabel(taskType: TaskType): string {
  switch (taskType) {
    case 'code':
      return '代码生成'
    case 'translation':
      return '翻译'
    case 'summarization':
      return '摘要'
    case 'reasoning':
      return '推理'
    default:
      return '通用'
  }
}
