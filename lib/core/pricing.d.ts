/**
 * 计费桥接层。
 *
 * 动态计价引擎（官方定价页实时抓取 + 峰谷分时 + 多厂商目录）位于
 * `./price/`（移植自 dsh-usage-ledger）；本文件只保留：
 * - round4：金额聚合的四舍五入（历史用量表兼容）；
 * - tokenUsageToUsageLike：官方 usage 字段 → 计价引擎的用量形状。
 */
import type { TokenUsage } from './deepseek.js';
import type { UsageLike } from './price/types.js';
export declare function round4(value: number): number;
/**
 * 官方 usage → 计价引擎用量形状。
 * DeepSeek 的 prompt_tokens 已包含缓存命中部分：命中部分按缓存命中价计，
 * 其余输入按未命中价计。
 */
export declare function tokenUsageToUsageLike(usage: TokenUsage): UsageLike;
