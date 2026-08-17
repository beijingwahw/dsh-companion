/**
 * 预算闸门：按北京时间日/月双档预算拦截非必要调用
 * （日预算吸收自 dsh-usage-ledger 的 dailyBudget 控制）。
 *
 * - 用量达 80%：告警一次（warning）；
 * - 用量达 100%：告警一次（error）并暂停非必要调用
 *   （抛 DeepSeekApiError 'INSUFFICIENT_BALANCE'；essential 调用仍放行）。
 * 任一档（日或月）用尽即暂停。告警去重经 Domain 表 `budget-state`
 * （键=北京日/月周期键）持久化，每周期每级只告警一次；
 * 进程内另以 Set 防并发重复。
 *
 * 已知局限（TOCTOU）：check() 是“读时放行”的闸门，而调用费用在调用完成
 * 之后才记账落盘；并发场景下多个调用可能在任一记账落地前集体通过检查，
 * 超支量级 ≈ 并发调用数 × 单次调用费用。暂不引入锁/额度预占等复杂方案。
 * 另：用量读取带短 TTL 内存缓存（见 SPENT_CACHE_TTL_MS），缓存窗口内
 * 的新增花费对闸门不可见，属同一量级的已知近似。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Domain } from '@deepseek-ai/dsh-storage';
import type { UsageStore } from '../../core/usage.js';
import type { CostSettings } from './settings.js';
/** 预算告警状态记录：某周期（日/月）各级告警是否已发出。 */
export interface BudgetStateRecord {
    alerted80: boolean;
    alerted100: boolean;
}
/** 预算状态快照（供 /cost/state 等展示）。 */
export interface BudgetSnapshot {
    /** 日预算（元）；0 表示不限。 */
    dailyCny: number;
    /** 今日已花费（元，北京时间日）。 */
    dailySpentCny: number;
    /** 日用量/日预算比值（日预算为 0 时取 0）。 */
    dailyRatio: number;
    /** 月度预算（元）；0 表示不限。 */
    monthlyCny: number;
    /** 本月已花费（元）。 */
    spentCny: number;
    /** 用量/预算比值（预算为 0 时取 0）。 */
    ratio: number;
    /** 是否已暂停非必要调用（任一档用尽）。 */
    paused: boolean;
}
/** 预算闸门（日/月双档）。 */
export declare class BudgetGuard {
    private readonly ctx;
    private readonly usage;
    private readonly getSettings;
    private readonly table;
    /** 进程内去重：避免并发调用在写链落盘前重复告警。 */
    private readonly alerted;
    /** 日用量短 TTL 缓存：跨日或过期失效。 */
    private dailyCache;
    /** 月用量短 TTL 缓存：跨月或过期失效。 */
    private monthlyCache;
    /**
     * @param ctx 插件上下文（发事件与通知）。
     * @param domain companion 存储域（budget-state 表）。
     * @param usage 用量账本。
     * @param getSettings 实时读取成本设置。
     */
    constructor(ctx: Context, domain: Domain, usage: UsageStore, getSettings: () => CostSettings);
    /**
     * 调用前预算检查：先日后月，任一档用尽即拦截非必要调用。
     * @param essential 必要调用：预算用尽时仍放行（只告警不拦截）。
     * @throws DeepSeekApiError 预算用尽且非必要调用。
     */
    check(essential: boolean): Promise<void>;
    /** 当前是否已暂停非必要调用（任一档预算>0 且用量已达该档预算）。 */
    paused(): boolean;
    /** 预算状态快照（日/月各读一次用量，TTL 缓存内复用）。 */
    state(): BudgetSnapshot;
    /**
     * 今日（北京时间）已花费合计。
     * 带短 TTL 内存缓存：跨日或过期失效，避免热路径反复全表扫描。
     */
    private spentToday;
    /**
     * 本月（北京时间）已花费合计。
     * 带短 TTL 内存缓存：跨月或过期失效，避免热路径（每次调用检查、
     * state/paused 重复调用）反复全表扫描。
     */
    private spentThisMonth;
    /**
     * 每周期（日/月）每级只告警一次：持久化状态 + 进程内去重，随后发事件与通知。
     * 先写盘、成功后才标记进程内去重：写盘失败不标记也不阻塞调用，
     * 告警照常发出（宁可后续重复告警，不可永久吞掉）。
     */
    private alertOnce;
}
