import { DeepSeekApiError } from '../../core/deepseek.js';
import { DEFAULT_PEAK_WINDOWS, isPeakTime, nextOffPeakStart, } from '../../core/time.js';
/** 将小数小时窗口转换为 time.ts 的 PeakWindow 形状（分钟取整）。 */
function toPeakWindows(windows) {
    const result = [];
    for (const [start, end] of windows) {
        if (!Number.isFinite(start) || !Number.isFinite(end))
            continue;
        result.push({
            startHour: Math.floor(start),
            startMinute: Math.round((start - Math.floor(start)) * 60),
            endHour: Math.floor(end),
            endMinute: Math.round((end - Math.floor(end)) * 60),
        });
    }
    return result;
}
/** 延迟队列容量上限：超限拒绝入队，避免无限积压。 */
export const PEAK_QUEUE_CAPACITY = 100;
/** 峰谷调度器。 */
export class PeakScheduler {
    getEngineWindows;
    queue = [];
    recheckBudget;
    draining = false;
    disposed = false;
    /** 一次性唤醒定时器；仅在队列非空时存在。 */
    wakeTimer;
    /**
     * @param ctx 插件上下文（注册生命周期 effect）。
     * @param recheckBudget 网关注入的预算复检回调：drain 执行每个任务前调用，
     * 抛错即拒绝执行该任务（如预算暂停期间以预算不足错误 reject 排队任务）。
     * @param getEngineWindows 可选的高峰窗口提供器（计价引擎实时解析的官方
     * 高峰时段）；返回空或抛错时回退内置缺省窗口。
     */
    constructor(ctx, recheckBudget, getEngineWindows) {
        this.getEngineWindows = getEngineWindows;
        this.recheckBudget = recheckBudget;
        ctx.effect(() => () => {
            this.clearWakeTimer();
            this.shutdown();
        }, 'companion.peak-scheduler-timer');
    }
    /**
     * 当前生效的高峰窗口：优先取提供器的实时窗口（官方定价页解析），
     * 空表或异常时回退内置缺省窗口，保证调度永远有确定的窗口可用。
     */
    windows() {
        if (this.getEngineWindows !== undefined) {
            try {
                const live = toPeakWindows(this.getEngineWindows());
                if (live.length > 0)
                    return live;
            }
            catch {
                // 提供器异常：回退缺省窗口。
            }
        }
        return DEFAULT_PEAK_WINDOWS;
    }
    /**
     * 入队一次调用：空闲时段且无积压时立即执行（deferred=false）；
     * 否则排入延迟队列（deferred=true），空闲时段 FIFO 执行。
     * @param run 实际调用闭包。
     * @param label 任务标签（供队列快照展示）。
     * @param signal 调用方中止信号（可选）。
     * @returns 入队结果：结果 Promise + 是否真实延迟。
     */
    enqueue(run, label, signal) {
        if (this.disposed) {
            return {
                result: Promise.reject(new Error('峰谷调度器已卸载，任务被拒绝')),
                deferred: false,
            };
        }
        // 空闲且无积压：立即执行（真实未延迟）；
        // 有积压或正在清空时入队，保持 FIFO 公平。
        if (!this.draining && this.queue.length === 0 && !isPeakTime(Date.now(), this.windows())) {
            return { result: run(), deferred: false };
        }
        if (this.queue.length >= PEAK_QUEUE_CAPACITY) {
            return {
                result: Promise.reject(new Error(`峰谷延迟队列已满（容量上限 ${PEAK_QUEUE_CAPACITY}），任务被拒绝：${label}`)),
                deferred: false,
            };
        }
        const result = new Promise((resolve, reject) => {
            this.queue.push({
                label,
                enqueuedAt: Date.now(),
                signal,
                execute: () => {
                    try {
                        return run().then(resolve, reject);
                    }
                    catch (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                        return Promise.resolve();
                    }
                },
                reject,
            });
        });
        this.scheduleWake();
        return { result, deferred: true };
    }
    /** 等待队列快照（FIFO 顺序）。 */
    queueSnapshot() {
        return this.queue.map((item) => ({ label: item.label, enqueuedAt: item.enqueuedAt }));
    }
    /**
     * 空闲时段按 FIFO 逐个执行队列任务；仍在高峰或正在清空时直接返回。
     * 每个任务执行前：
     * 1. 中止检查：调用方 signal 已中止则直接 reject，不发真实请求；
     * 2. 预算复检：recheckBudget 抛错即 reject 该任务（预算不足等），继续处理后续任务。
     */
    async drain() {
        if (this.draining || this.disposed)
            return;
        this.draining = true;
        try {
            while (this.queue.length > 0 &&
                !this.disposed &&
                !isPeakTime(Date.now(), this.windows())) {
                const item = this.queue.shift();
                if (!item)
                    break;
                if (item.signal?.aborted) {
                    item.reject(new DeepSeekApiError('请求已被取消', 'ABORTED'));
                    continue;
                }
                try {
                    await this.recheckBudget();
                }
                catch (error) {
                    item.reject(error instanceof Error ? error : new Error(String(error)));
                    continue;
                }
                await item.execute();
            }
        }
        finally {
            this.draining = false;
            // 仍有积压（如被高峰到来打断）：安排下一次唤醒。
            if (this.queue.length > 0 && !this.disposed)
                this.scheduleWake();
        }
    }
    /**
     * 安排一次性唤醒：高峰中精确唤醒于下一个空闲时段起点（nextOffPeakStart），
     * 空闲时段（队列非空待清空）立即唤醒。定时器仅在队列非空时存在。
     */
    scheduleWake() {
        if (this.wakeTimer !== undefined || this.disposed || this.queue.length === 0)
            return;
        const now = Date.now();
        const windows = this.windows();
        const delayMs = isPeakTime(now, windows)
            ? Math.max(nextOffPeakStart(now, windows) - now, 1_000)
            : 0;
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = undefined;
            void this.drain();
        }, delayMs);
    }
    /** 清理唤醒定时器。 */
    clearWakeTimer() {
        if (this.wakeTimer !== undefined) {
            clearTimeout(this.wakeTimer);
            this.wakeTimer = undefined;
        }
    }
    /** 卸载：拒绝所有尚未执行的排队任务。 */
    shutdown() {
        this.disposed = true;
        const pending = this.queue.splice(0, this.queue.length);
        for (const item of pending) {
            item.reject(new Error('成本模块已卸载，延迟任务被取消'));
        }
    }
}
