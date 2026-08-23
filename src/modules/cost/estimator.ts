/**
 * 调用期权协议的 P95 估值器：为 reserve 预授权提供单次调用费用估算。
 *
 * 估值口径（两层）：
 * - 上界：估算输入 tokens × 输入单价 + 输出上限 tokens × 输出单价；
 * - 统计收紧：按「模型 × 输入长度分桶」维护最近若干次实际费用样本，
 *   取 P95 × 安全系数，与上界取小；样本不足或无单价时退回上界。
 *
 * 样本仅驻内存（重启后冷启动用上界，行为保守但正确）；
 * 估值偏低造成的赤字会在结算后自动反映进可用额度，无需单独账本。
 */
import type { ModelPrice } from '../../core/price/types.js'

/** 每桶保留的实际费用样本数上限（滚动窗口）。 */
const SAMPLES_PER_BUCKET = 32

/** P95 安全系数：估值略高于历史 P95，降低赤字概率。 */
const P95_SAFETY_FACTOR = 1.15

/** 估值下限系数：统计值不至上界低一个数量级，保留保守性。 */
const MIN_FRACTION_OF_UPPER = 0.1

/** 输入长度分桶宽度（估算 tokens）。 */
const BUCKET_WIDTH_TOKENS = 2048

/** 缺省输出上限 tokens（DeepSeek API 文档缺省 max_tokens）。 */
const DEFAULT_OUTPUT_TOKEN_CAP = 4096

/** 字符 → tokens 的混合启发式（英文 ≈4 字符/token，中文 ≈1.5，取折中）。 */
const CHARS_PER_TOKEN = 3

/** 单桶统计：最近 N 次实际费用（元）。 */
interface Bucket {
  samples: number[]
}

/** 调用费用估值器（纯内存，无 I/O）。 */
export class CostEstimator {
  private readonly buckets = new Map<string, Bucket>()

  /**
   * 估算一次调用的费用上界（元）。
   * @param model 模型 id。
   * @param inputChars 输入消息总字符数。
   * @param maxTokens 调用指定的输出上限；缺省用模型缺省上限。
   * @param price 模型单价（元/百万 tokens）；无价模型返回 0（与计费口径一致）。
   */
  estimate(model: string, inputChars: number, maxTokens: number | undefined, price: ModelPrice | undefined): number {
    if (price === undefined) return 0
    const inputTokens = Math.ceil(Math.max(inputChars, 0) / CHARS_PER_TOKEN)
    const outputTokens = Math.max(1, maxTokens ?? DEFAULT_OUTPUT_TOKEN_CAP)
    const upper =
      (inputTokens * price.inputMiss + outputTokens * price.output) / 1_000_000
    const p95 = this.percentile95(model, inputTokens)
    if (p95 === undefined) return upper
    return Math.min(upper, Math.max(p95 * P95_SAFETY_FACTOR, upper * MIN_FRACTION_OF_UPPER))
  }

  /**
   * 结算时回填样本：按「模型 × 输入长度分桶」滚动记录实际费用。
   * @param actualCny 实际费用（元）。
   */
  observe(model: string, inputChars: number, actualCny: number): void {
    if (!Number.isFinite(actualCny) || actualCny < 0) return
    const inputTokens = Math.ceil(Math.max(inputChars, 0) / CHARS_PER_TOKEN)
    const key = this.bucketKey(model, inputTokens)
    const bucket = this.buckets.get(key) ?? { samples: [] }
    bucket.samples.push(actualCny)
    if (bucket.samples.length > SAMPLES_PER_BUCKET) {
      bucket.samples.splice(0, bucket.samples.length - SAMPLES_PER_BUCKET)
    }
    this.buckets.set(key, bucket)
  }

  /** 当前桶数（诊断用）。 */
  get bucketCount(): number {
    return this.buckets.size
  }

  /** 读取桶内 P95；样本不足（<5）返回 undefined。 */
  private percentile95(model: string, inputTokens: number): number | undefined {
    const bucket = this.buckets.get(this.bucketKey(model, inputTokens))
    if (bucket === undefined || bucket.samples.length < 5) return undefined
    const sorted = [...bucket.samples].sort((a, b) => a - b)
    // 经验 P95：向下取索引，保证统计值不超过观察到的最大值。
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    return sorted[index]
  }

  private bucketKey(model: string, inputTokens: number): string {
    return `${model}#${Math.ceil(inputTokens / BUCKET_WIDTH_TOKENS)}`
  }
}
