/**
 * 主动智能中心 v2：从「Provider 聚合器」到「洞察操作系统」。
 *
 * v1 的 Center 是三件事的组合：Provider 注册表 + 20 秒缓存 + 串行化
 * 写队列。它解决了「多源不互相拖垮」，但没有回答主动智能的四个
 * 更深问题：
 *
 * 1. **信号何时值得打断？** v1 只在 feed() 被调用时被动合成——用户
 *    不打开面板，洞察永远不出现。真正的主动智能需要一个**节律器**
 *    （cadence）：按数据变更事件驱动合成，在「值得打断」时才发通知，
 *    而不是每次刷新都把前 3 条当通知。本层引入 `companion/insights`
 *    事件的**节律门**：距上次通知不足 quietMs 时不推，严重度升级可突破。
 *
 * 2. **打断成本是否可学？** v1 的反馈只影响单卡排序。本层把
 *    helpful/unhelpful/dismiss 聚合到 **source 维度**（Wilson 下界），
 *    让「总被忽略的信号源」自动降权——用户不必逐条关掉同一类噪音。
 *
 * 3. **洞察能否自我解释？** v1 的卡片只有 text + action。本层为每张卡
 *    附 `provenance`（信号来源 + 数据新鲜度 + 合并关系），让「为什么
 *    现在给我看这个」可追溯——主动智能的可信度来自可解释，不来自神秘。
 *
 * 4. **系统是否知道自己在退化？** 本层暴露 `health()`：Provider 成功率、
 *    平均延迟、缓存命中、通知抑制率。主动智能的可观测性不是锦上添花
 *    ——一个静默失败的信号源比没有信号源更危险。
 *
 * 设计纪律（与 v1 一致）：
 * - 状态只存 64 位指纹 + 时间 + 反馈 + 结果，**永不存卡片正文**；
 * - 所有 Provider 本地执行；单源失败只计入降级数，不影响其余；
 * - 动作只走白名单；`action` 文案永不作为命令执行；
 * - 纯本地、零网络、零 LLM。
 */
import type { KvTable } from '../storage-adapter.js';
import type { InsightCard } from './pulse.js';
import { type InsightFeedbackAction, type InsightPolicyOptions, type InsightState, type ManagedInsightCard } from './policy.js';
/** 异步洞察信号源；注册和注销均由宿主模块的 effect 管理。 */
export type AsyncInsightProvider = () => readonly InsightCard[] | Promise<readonly InsightCard[]>;
/** 单张卡片的溯源元数据（可解释性）。 */
export interface InsightProvenance {
    /** 信号来源标识。 */
    readonly source: string;
    /** 该源此刻的反馈可信度（Wilson 下界，[0,1]）。 */
    readonly trust: number;
    /** 本卡吸收的同主题卡数（0 = 未合并）。 */
    readonly merged: number;
    /** 是否因节律窗口关闭而未推送（仍在 feed 可见）。 */
    readonly rhythmSuppressed: boolean;
    /** 数据新鲜度：Provider 本次成功返回的耗时（毫秒；失败为 undefined）。 */
    readonly latencyMs?: number;
}
/** 统一主动智能 feed。 */
export interface InsightFeed {
    readonly cards: readonly ManagedInsightCard[];
    readonly summary: string;
    readonly generatedAt: number;
    readonly unreadCount: number;
    readonly snoozedCount: number;
    readonly dismissedCount: number;
    readonly providerFailures: number;
    /** 被语义抑制合并的卡片数（跨源同主题冗余）。 */
    readonly mergedCount: number;
    /** 因节律窗口关闭而未推送的卡片数。 */
    readonly rhythmSuppressedCount: number;
    /** 各信号源可信度快照。 */
    readonly sourceTrust: Readonly<Record<string, number>>;
    /** 各卡片溯源（键 = 卡片指纹）。 */
    readonly provenance: Readonly<Record<string, InsightProvenance>>;
}
/** 主动智能子系统健康报告（可观测性）。 */
export interface InsightHealth {
    /** 已注册 Provider 数。 */
    readonly providers: number;
    /** 最近一轮成功的 Provider 数。 */
    readonly healthyProviders: number;
    /** 最近一轮失败的 Provider 数。 */
    readonly failedProviders: number;
    /** 累计刷新轮次。 */
    readonly refreshes: number;
    /** 累计 Provider 失败次数。 */
    readonly providerFailures: number;
    /** Provider 成功率（[0,1]；无样本为 1）。 */
    readonly providerSuccessRate: number;
    /** 最近一轮耗时（毫秒）。 */
    readonly lastRefreshMs: number;
    /** 指数平滑平均耗时（毫秒）。 */
    readonly avgRefreshMs: number;
    /** 累计通知数。 */
    readonly notifications: number;
    /** 累计节律抑制数。 */
    readonly rhythmSuppressed: number;
    /** 累计语义合并数。 */
    readonly merged: number;
    /** 最近一次成功刷新的时间戳（无则 null）。 */
    readonly lastRefreshAt: number | null;
}
/** Center 反馈动作；restore-all 只恢复状态，不保存或重建任何正文。 */
export type InsightCenterFeedbackAction = InsightFeedbackAction | 'restore-all';
/** Center 可调参数；生产默认值保持低频与克制。 */
export interface InsightCenterOptions extends InsightPolicyOptions {
    readonly cacheMs?: number;
    readonly providerTimeoutMs?: number;
    readonly now?: () => number;
    readonly onNotifications?: (cards: readonly ManagedInsightCard[], feed: InsightFeed) => void;
    /** 节律门：两次通知之间的最小间隔（毫秒）；缺省 5 分钟。 */
    readonly quietMs?: number;
    /** 健康统计的指数平滑系数（0..1；越大越看重近期）。 */
    readonly healthSmoothing?: number;
}
/** 统一主动智能中心。 */
export declare class InsightCenter {
    private readonly resolveStateTable;
    private readonly options;
    private readonly providers;
    private readonly cacheMs;
    private readonly providerTimeoutMs;
    private readonly quietMs;
    private readonly smoothing;
    private readonly now;
    private cached?;
    private inFlight?;
    private states?;
    private stateTable?;
    private queue;
    /** 最近一次通知时间戳（节律门基准）。 */
    private lastNotifiedAt?;
    /** 累计健康统计。 */
    private healthStats;
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
    /** 主动智能子系统健康报告（可观测性：静默失败比没有信号更危险）。 */
    health(): InsightHealth;
    /** 串行化刷新和反馈，避免慢 Provider 与快速按钮操作互相覆盖。 */
    private enqueue;
    /** 首次访问时恢复并净化持久化状态；损坏记录不会进入内存。 */
    private ensureStates;
    /** 单航班实际刷新；仅在 enqueue 内调用。 */
    private refresh;
    /** 隔离单个 Provider 的同步异常、异步拒绝与超时；返回耗时。 */
    private collect;
}
