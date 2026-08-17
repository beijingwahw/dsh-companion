/**
 * 峰谷调度器：高峰时段（DEFAULT_PEAK_WINDOWS）将 normal 优先级调用排入延迟队列，
 * 空闲时段按 FIFO 逐个执行。
 *
 * - 预算复检：drain 执行每个任务前先调用注入的 recheckBudget 回调，
 *   抛错即拒绝执行该任务（如预算暂停期间将排队任务以预算不足错误 reject），
 *   防止延迟队列成为预算闸门的旁路；
 * - 队列容量上限（PEAK_QUEUE_CAPACITY）：超限以明确错误拒绝入队；
 * - drain 执行前检查调用方 AbortSignal：已中止的任务直接 reject，不发真实请求；
 * - 唤醒定时器为一次性 setTimeout，仅在队列非空时存在：
 *   高峰中用 nextOffPeakStart 精确计算下一个空闲时段起点作为唤醒时刻，
 *   取代恒定间隔的盲轮询；空闲时段入队（队列非空时）立即安排 drain。
 * - 高峰窗口动态化：构造时可注入窗口提供器（成本模块接入计价引擎的
 *   activePeakWindows，即官方定价页实时解析的高峰时段）；官方窗口变更
 *   后调度自动跟随，未注入时回退内置缺省窗口。
 *
 * 生命周期：定时器与队列随所属 fiber 卸载自动清理；卸载时拒绝所有未执行任务。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 高峰窗口提供器：返回 [起始小时, 结束小时) 形式的小数小时窗口。 */
export type PeakWindowsProvider = () => ReadonlyArray<readonly [number, number]>;
/** 延迟队列容量上限：超限拒绝入队，避免无限积压。 */
export declare const PEAK_QUEUE_CAPACITY = 100;
/** 入队结果：调用结果 Promise + 是否被真实延迟。 */
export interface EnqueueResult<T> {
    /** 调用结果的 Promise（延迟执行时在执行时刻才落定）。 */
    result: Promise<T>;
    /** 任务是否被真实延迟执行（false = 入队时立即执行）。 */
    deferred: boolean;
}
/** 等待队列快照条目。 */
export interface QueuedTaskInfo {
    /** 任务标签（taskHint 或调用来源）。 */
    label: string;
    /** 入队时间戳（毫秒）。 */
    enqueuedAt: number;
}
/** 峰谷调度器。 */
export declare class PeakScheduler {
    private readonly getEngineWindows?;
    private readonly queue;
    private readonly recheckBudget;
    private draining;
    private disposed;
    /** 一次性唤醒定时器；仅在队列非空时存在。 */
    private wakeTimer;
    /**
     * @param ctx 插件上下文（注册生命周期 effect）。
     * @param recheckBudget 网关注入的预算复检回调：drain 执行每个任务前调用，
     * 抛错即拒绝执行该任务（如预算暂停期间以预算不足错误 reject 排队任务）。
     * @param getEngineWindows 可选的高峰窗口提供器（计价引擎实时解析的官方
     * 高峰时段）；返回空或抛错时回退内置缺省窗口。
     */
    constructor(ctx: Context, recheckBudget: () => Promise<void>, getEngineWindows?: PeakWindowsProvider | undefined);
    /**
     * 当前生效的高峰窗口：优先取提供器的实时窗口（官方定价页解析），
     * 空表或异常时回退内置缺省窗口，保证调度永远有确定的窗口可用。
     */
    private windows;
    /**
     * 入队一次调用：空闲时段且无积压时立即执行（deferred=false）；
     * 否则排入延迟队列（deferred=true），空闲时段 FIFO 执行。
     * @param run 实际调用闭包。
     * @param label 任务标签（供队列快照展示）。
     * @param signal 调用方中止信号（可选）。
     * @returns 入队结果：结果 Promise + 是否真实延迟。
     */
    enqueue<T>(run: () => Promise<T>, label: string, signal?: AbortSignal): EnqueueResult<T>;
    /** 等待队列快照（FIFO 顺序）。 */
    queueSnapshot(): readonly QueuedTaskInfo[];
    /**
     * 空闲时段按 FIFO 逐个执行队列任务；仍在高峰或正在清空时直接返回。
     * 每个任务执行前：
     * 1. 中止检查：调用方 signal 已中止则直接 reject，不发真实请求；
     * 2. 预算复检：recheckBudget 抛错即 reject 该任务（预算不足等），继续处理后续任务。
     */
    private drain;
    /**
     * 安排一次性唤醒：高峰中精确唤醒于下一个空闲时段起点（nextOffPeakStart），
     * 空闲时段（队列非空待清空）立即唤醒。定时器仅在队列非空时存在。
     */
    private scheduleWake;
    /** 清理唤醒定时器。 */
    private clearWakeTimer;
    /** 卸载：拒绝所有尚未执行的排队任务。 */
    private shutdown;
}
