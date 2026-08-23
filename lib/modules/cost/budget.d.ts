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
 * 调用期权协议（预授权-结算两阶段提交）：
 * check() 是“读时放行”，费用在调用完成后才记账——并发调用可能在任一
 * 记账落地前集体通过检查（TOCTOU）。为此在 invoke 时刻增加 reserve()：
 * 按估算金额锁定额度（预授权），调用完成后 settle(actual) 入账并释放
 * 差额，失败则 release() 全额释放。可用额度恒为
 *   available = budget − spent − Σ在途预留，
 * 不变式收紧为「最终支出 ≤ 预算 + Σ在途(实际−估算)⁺」——超支上界从
 * 「并发数 × 单次全额」降为「并发数 × 估算误差」。预留带 TTL 懒回收
 * （惰性清扫，无空闲定时器）：超时未结算的孤儿预留（调用崩溃路径）在
 * 下次访问时自动释放；TTL 取 apiTimeoutMs + 缓冲，覆盖在途调用窗口。
 * settle 同步推进 spent 缓存，使缓存窗口内的新增花费对闸门即时可见
 * （15s TTL 缓存由此退化为全量扫描的兜底优化，不再是精度近似）。
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
    /** 在途预留合计（元）：已预授权未结算的调用估算费用。 */
    reservedCny: number;
}
/** 预授权句柄：settle/release 幂等，交给调用方在 invoke 前后配对使用。 */
export interface Reservation {
    /** 预授权金额（元）。 */
    readonly amountCny: number;
    /** 结算：按实际费用入账并释放预留（差额自动回到可用额度）。 */
    settle(actualCny: number): void;
    /** 全额释放预留（调用失败/中止路径）。 */
    release(): void;
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
    /** 在途预留（调用期权协议）：id → 记录。 */
    private readonly reservations;
    /** 预留自增 id。 */
    private nextReservationId;
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
    /**
     * 预授权（调用期权协议）：按估算金额锁定额度，返回结算句柄。
     *
     * 投影口径：任一档（日/月）的 projected = spent + Σ在途预留 + 本次估算
     * 达到该档预算即拒绝非必要调用；essential 调用透支放行（告警）。
     * 告警按「档位 + 周期键」经既有 alertOnce 去重（fire-and-forget，
     * 写盘失败不阻塞调用）。预留带 TTL，由惰性清扫回收孤儿记录。
     * @param estimateCny 估算费用（元）。
     * @param essential 必要调用：预授权不足时仍放行（透支告警）。
     * @param ttlMs 预留有效期：应覆盖单次调用窗口（apiTimeoutMs + 缓冲）。
     * @throws DeepSeekApiError 投影超预算且非必要调用。
     */
    reserve(estimateCny: number, essential: boolean, ttlMs: number): Reservation;
    /** 在途预留合计（元）。 */
    reservedTotalCny(): number;
    /**
     * 结算推进 spent 缓存：结算的实际费用已由核心服务记账落盘（usage.record），
     * 此处同步累加缓存值使闸门即时可见。并发下若他方恰好全量刷新了缓存，
     * 存在短暂保守方向的重复计入（自愈于缓存 TTL 内，闸门偏严不偏松）。
     */
    private applySettlement;
    /** 惰性清扫：释放超时未结算的孤儿预留（调用崩溃路径），无空闲定时器。 */
    private sweepExpired;
    /** fire-and-forget 告警：写盘与通知失败均不阻塞预授权路径。 */
    private fireAlert;
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
     * @param includesReserved 金额口径是否含在途预授权（预授权路径的投影口径）。
     */
    private alertOnce;
}
