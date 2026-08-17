/**
 * 用量记账：按北京时间日粒度聚合，支撑成本报表（每日/每周）。
 * 记录保存在存储域 usage-daily 表，原子 update 避免并发写丢失。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
export interface ModelUsageSlice {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省，读取侧按 0 处理）。 */
    cacheHitTokens?: number;
    costCny: number;
}
export interface DailyUsage {
    /** 北京时间日期键 YYYY-MM-DD。 */
    day: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    /** 命中缓存的输入 tokens（旧行可能缺省，读取侧按 0 处理）。 */
    cacheHitTokens?: number;
    costCny: number;
    /** 通过模型路由/峰谷调度节省的估算金额。 */
    savedCny: number;
    /** 被峰谷调度延迟执行的调用数。 */
    deferredCalls: number;
    byModel: Record<string, ModelUsageSlice>;
}
export interface UsageDelta {
    ts: number;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    costCny: number;
    savedCny?: number;
    deferred?: boolean;
}
export interface UsageTotal {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    costCny: number;
    savedCny: number;
    deferredCalls: number;
}
export declare class UsageStore {
    private readonly table;
    constructor(domain: Domain);
    /** 记录一次调用（原子并入当日聚合）。 */
    record(delta: UsageDelta): Promise<void>;
    /** 读取 [fromDay, toDay] 闭区间内的日聚合，按日期升序。 */
    range(fromDay: string, toDay: string): DailyUsage[];
    /** 读取某时间戳所在北京时间月的全部日聚合。 */
    month(ts: number): DailyUsage[];
    /** 汇总若干日聚合。 */
    total(rows: readonly DailyUsage[]): UsageTotal;
}
