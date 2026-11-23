/**
 * 主动智能中心：统一注册异步信号源，并提供缓存、单航班、状态持久化与反馈闭环。
 *
 * 这里只保存 policy.ts 的指纹状态，不保存卡片正文。所有 Provider 都在本地执行；
 * 任一 Provider 失败或超时只计入降级数量，不影响其他信号源。
 */
import type { KvTable } from '../storage-adapter.js';
import type { InsightCard } from './pulse.js';
import { type InsightFeedbackAction, type InsightPolicyOptions, type InsightState, type ManagedInsightCard } from './policy.js';
/** 异步洞察信号源；注册和注销均由宿主模块的 effect 管理。 */
export type AsyncInsightProvider = () => readonly InsightCard[] | Promise<readonly InsightCard[]>;
/** 统一主动智能 feed。 */
export interface InsightFeed {
    readonly cards: readonly ManagedInsightCard[];
    readonly summary: string;
    readonly generatedAt: number;
    readonly unreadCount: number;
    readonly snoozedCount: number;
    readonly dismissedCount: number;
    readonly providerFailures: number;
}
/** Center 反馈动作；restore-all 只恢复状态，不保存或重建任何正文。 */
export type InsightCenterFeedbackAction = InsightFeedbackAction | 'restore-all';
/** Center 可调参数；生产默认值保持低频与克制。 */
export interface InsightCenterOptions extends InsightPolicyOptions {
    readonly cacheMs?: number;
    readonly providerTimeoutMs?: number;
    readonly now?: () => number;
    readonly onNotifications?: (cards: readonly ManagedInsightCard[], feed: InsightFeed) => void;
}
/** 统一主动智能中心。 */
export declare class InsightCenter {
    private readonly resolveStateTable;
    private readonly options;
    private readonly providers;
    private readonly cacheMs;
    private readonly providerTimeoutMs;
    private readonly now;
    private cached?;
    private inFlight?;
    private states?;
    private stateTable?;
    private queue;
    constructor(resolveStateTable: () => Promise<KvTable<InsightState>>, options?: InsightCenterOptions);
    /** 注册信号源并使旧缓存失效；返回幂等注销函数。 */
    register(provider: AsyncInsightProvider): () => void;
    /** 数据变更后由模块调用；下一次读取会重新合成，不在写路径同步重算。 */
    invalidate(): void;
    /** 读取统一 feed；短时间重复读取共享缓存，并发强制刷新共享同一 Promise。 */
    feed(force?: boolean): Promise<InsightFeed>;
    /** 确认未读；all 只修改已持久化的指纹状态，不接触卡片正文。 */
    acknowledge(request: {
        readonly ids?: readonly string[];
        readonly all?: boolean;
    }): Promise<number>;
    /** 应用单条反馈或恢复全部忽略；未知单条指纹返回 false，防止伪造垃圾状态。 */
    feedback(id: string | undefined, action: InsightCenterFeedbackAction): Promise<boolean>;
    /** 串行化刷新和反馈，避免慢 Provider 与快速按钮操作互相覆盖。 */
    private enqueue;
    /** 首次访问时恢复并净化持久化状态；损坏记录不会进入内存。 */
    private ensureStates;
    /** 单航班实际刷新；仅在 enqueue 内调用。 */
    private refresh;
    /** 隔离单个 Provider 的同步异常、异步拒绝与超时。 */
    private collect;
}
