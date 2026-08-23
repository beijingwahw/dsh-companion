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
import type { ModelPrice } from '../../core/price/types.js';
/** 调用费用估值器（纯内存，无 I/O）。 */
export declare class CostEstimator {
    private readonly buckets;
    /**
     * 估算一次调用的费用上界（元）。
     * @param model 模型 id。
     * @param inputChars 输入消息总字符数。
     * @param maxTokens 调用指定的输出上限；缺省用模型缺省上限。
     * @param price 模型单价（元/百万 tokens）；无价模型返回 0（与计费口径一致）。
     */
    estimate(model: string, inputChars: number, maxTokens: number | undefined, price: ModelPrice | undefined): number;
    /**
     * 结算时回填样本：按「模型 × 输入长度分桶」滚动记录实际费用。
     * @param actualCny 实际费用（元）。
     */
    observe(model: string, inputChars: number, actualCny: number): void;
    /** 当前桶数（诊断用）。 */
    get bucketCount(): number;
    /** 读取桶内 P95；样本不足（<5）返回 undefined。 */
    private percentile95;
    private bucketKey;
}
