import { applyInsightPolicy, pruneInsightStates, reduceInsightFeedback, sanitizeInsightState, } from './policy.js';
/** 统一主动智能中心。 */
export class InsightCenter {
    resolveStateTable;
    options;
    providers = new Set();
    cacheMs;
    providerTimeoutMs;
    now;
    cached;
    inFlight;
    states;
    stateTable;
    queue = Promise.resolve();
    constructor(resolveStateTable, options = {}) {
        this.resolveStateTable = resolveStateTable;
        this.options = options;
        this.cacheMs = Math.max(0, options.cacheMs ?? 20_000);
        this.providerTimeoutMs = Math.max(100, options.providerTimeoutMs ?? 10_000);
        this.now = options.now ?? Date.now;
    }
    /** 注册信号源并使旧缓存失效；返回幂等注销函数。 */
    register(provider) {
        this.providers.add(provider);
        this.invalidate();
        let active = true;
        return () => {
            if (!active)
                return;
            active = false;
            this.providers.delete(provider);
            this.invalidate();
        };
    }
    /** 数据变更后由模块调用；下一次读取会重新合成，不在写路径同步重算。 */
    invalidate() {
        this.cached = undefined;
    }
    /** 读取统一 feed；短时间重复读取共享缓存，并发强制刷新共享同一 Promise。 */
    async feed(force = false) {
        const now = this.now();
        if (!force && this.cached !== undefined && this.cached.expiresAt > now)
            return this.cached.feed;
        if (this.inFlight !== undefined)
            return this.inFlight;
        const promise = this.enqueue(() => this.refresh());
        this.inFlight = promise;
        try {
            return await promise;
        }
        finally {
            if (this.inFlight === promise)
                this.inFlight = undefined;
        }
    }
    /** 确认未读；all 只修改已持久化的指纹状态，不接触卡片正文。 */
    acknowledge(request) {
        return this.enqueue(async () => {
            await this.ensureStates();
            const states = this.states;
            const table = this.stateTable;
            const ids = request.all === true
                ? [...states.keys()]
                : [...new Set(request.ids ?? [])].slice(0, 50);
            const now = this.now();
            let changed = 0;
            for (const id of ids) {
                const previous = states.get(id);
                if (previous === undefined)
                    continue;
                const next = reduceInsightFeedback(previous, 'acknowledge', now);
                if (next.acknowledgedAt === previous.acknowledgedAt && previous.acknowledgedAt !== undefined)
                    continue;
                await table.put(id, next);
                states.set(id, next);
                changed += 1;
            }
            if (changed > 0)
                this.invalidate();
            return changed;
        });
    }
    /** 应用单条反馈或恢复全部忽略；未知单条指纹返回 false，防止伪造垃圾状态。 */
    feedback(id, action) {
        return this.enqueue(async () => {
            await this.ensureStates();
            const states = this.states;
            const table = this.stateTable;
            const now = this.now();
            if (action === 'restore-all') {
                let changed = false;
                for (const [key, previous] of states) {
                    if (!previous.dismissed && (previous.snoozeUntil ?? 0) <= now)
                        continue;
                    const next = reduceInsightFeedback(previous, 'restore', now);
                    await table.put(key, next);
                    states.set(key, next);
                    changed = true;
                }
                if (changed)
                    this.invalidate();
                return changed;
            }
            if (id === undefined)
                return false;
            const previous = states.get(id);
            if (previous === undefined)
                return false;
            const next = reduceInsightFeedback(previous, action, now);
            await table.put(id, next);
            states.set(id, next);
            this.invalidate();
            return true;
        });
    }
    /** 串行化刷新和反馈，避免慢 Provider 与快速按钮操作互相覆盖。 */
    enqueue(job) {
        const run = this.queue.then(job, job);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }
    /** 首次访问时恢复并净化持久化状态；损坏记录不会进入内存。 */
    async ensureStates() {
        if (this.states !== undefined)
            return;
        const table = await this.resolveStateTable();
        const restored = new Map();
        for (const [id, raw] of table.entries()) {
            if (!/^ins_[0-9a-f]{16}$/.test(id))
                continue;
            const state = sanitizeInsightState(raw);
            if (state !== undefined)
                restored.set(id, state);
        }
        this.stateTable = table;
        this.states = restored;
    }
    /** 单航班实际刷新；仅在 enqueue 内调用。 */
    async refresh() {
        await this.ensureStates();
        const previous = this.states;
        const table = this.stateTable;
        const providers = [...this.providers];
        const settled = await Promise.all(providers.map((provider) => this.collect(provider)));
        const input = [];
        let providerFailures = 0;
        for (const cards of settled) {
            if (cards === undefined)
                providerFailures += 1;
            else
                input.push(...cards);
        }
        const now = this.now();
        const result = applyInsightPolicy(input, previous, now, this.options);
        const nextStates = pruneInsightStates(result.nextStates, result.activeIds, now);
        for (const [id] of previous) {
            if (!nextStates.has(id))
                await table.delete(id);
        }
        for (const [id, state] of nextStates) {
            if (previous.get(id) !== state)
                await table.put(id, state);
        }
        this.states = new Map(nextStates);
        const feed = {
            cards: result.cards,
            summary: summarizeFeed(result.cards, providerFailures),
            generatedAt: now,
            unreadCount: result.cards.filter((card) => card.unread).length,
            snoozedCount: result.snoozedCount,
            dismissedCount: result.dismissedCount,
            providerFailures,
        };
        this.cached = { feed, expiresAt: now + this.cacheMs };
        if (result.notifications.length > 0 && this.options.onNotifications !== undefined) {
            const notified = new Set(result.notifications);
            const cards = result.cards.filter((card) => notified.has(card.id));
            try {
                this.options.onNotifications(cards, feed);
            }
            catch {
                // 通知订阅者属于增强体验，失败不影响 feed 和状态落盘。
            }
        }
        return feed;
    }
    /** 隔离单个 Provider 的同步异常、异步拒绝与超时。 */
    async collect(provider) {
        let timer;
        try {
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('insight provider timeout')), this.providerTimeoutMs);
                timer.unref();
            });
            return await Promise.race([Promise.resolve().then(provider), timeout]);
        }
        catch {
            return undefined;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
}
/** 面向用户的摘要只陈述当前可见信号与降级事实。 */
function summarizeFeed(cards, providerFailures) {
    const counts = { critical: 0, watch: 0, info: 0 };
    for (const card of cards)
        counts[card.severity] += 1;
    const parts = [];
    if (cards.length === 0)
        parts.push('当前没有需要主动展示的信号');
    else {
        parts.push(`${cards.length} 条主动洞察`);
        if (counts.critical > 0)
            parts.push(`${counts.critical} 条需立即关注`);
        if (counts.watch > 0)
            parts.push(`${counts.watch} 条建议留意`);
    }
    if (providerFailures > 0)
        parts.push(`${providerFailures} 个信号源暂时不可用`);
    return parts.join('，');
}
