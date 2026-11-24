import { aggregateSourceFeedback, applyInsightPolicy, pruneInsightStates, reduceInsightFeedback, sanitizeInsightState, } from './policy.js';
/** 默认通知最小间隔（毫秒）：主动智能的「别烦我」下限。 */
const DEFAULT_QUIET_MS = 5 * 60_000;
/** 默认健康统计平滑系数。 */
const DEFAULT_HEALTH_SMOOTHING = 0.3;
/** 统一主动智能中心。 */
export class InsightCenter {
    resolveStateTable;
    options;
    providers = new Set();
    cacheMs;
    providerTimeoutMs;
    quietMs;
    smoothing;
    now;
    cached;
    inFlight;
    states;
    stateTable;
    queue = Promise.resolve();
    /** 最近一次通知时间戳（节律门基准）。 */
    lastNotifiedAt;
    /** 累计健康统计。 */
    healthStats = {
        refreshes: 0,
        providerFailures: 0,
        providerSamples: 0,
        notifications: 0,
        rhythmSuppressed: 0,
        merged: 0,
        lastRefreshMs: 0,
        avgRefreshMs: 0,
        lastRefreshAt: null,
        failedProvidersNow: 0,
    };
    constructor(resolveStateTable, options = {}) {
        this.resolveStateTable = resolveStateTable;
        this.options = options;
        this.cacheMs = Math.max(0, options.cacheMs ?? 20_000);
        this.providerTimeoutMs = Math.max(100, options.providerTimeoutMs ?? 10_000);
        this.quietMs = Math.max(0, options.quietMs ?? DEFAULT_QUIET_MS);
        this.smoothing = Math.min(1, Math.max(0, options.healthSmoothing ?? DEFAULT_HEALTH_SMOOTHING));
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
    /** 主动智能子系统健康报告（可观测性：静默失败比没有信号更危险）。 */
    health() {
        const providers = this.providers.size;
        const successRate = this.healthStats.providerSamples === 0
            ? 1
            : (this.healthStats.providerSamples - this.healthStats.providerFailures) /
                this.healthStats.providerSamples;
        return {
            providers,
            healthyProviders: Math.max(0, providers - this.healthStats.failedProvidersNow),
            failedProviders: this.healthStats.failedProvidersNow,
            refreshes: this.healthStats.refreshes,
            providerFailures: this.healthStats.providerFailures,
            providerSuccessRate: Number(successRate.toFixed(4)),
            lastRefreshMs: this.healthStats.lastRefreshMs,
            avgRefreshMs: Number(this.healthStats.avgRefreshMs.toFixed(1)),
            notifications: this.healthStats.notifications,
            rhythmSuppressed: this.healthStats.rhythmSuppressed,
            merged: this.healthStats.merged,
            lastRefreshAt: this.healthStats.lastRefreshAt,
        };
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
        const startedAt = this.now();
        // 并行采集 + 单源超时/异常隔离；记录每个源的耗时供溯源。
        const collected = await Promise.all(providers.map((provider) => this.collect(provider)));
        const input = [];
        let providerFailures = 0;
        const latencyBySource = new Map();
        for (const item of collected) {
            if (item === undefined) {
                providerFailures += 1;
                continue;
            }
            input.push(...item.cards);
            if (item.latencyMs !== undefined) {
                for (const card of item.cards)
                    latencyBySource.set(card.source, item.latencyMs);
            }
        }
        // 指纹 → source 映射：效用学习需要按源聚合反馈，而状态表只存指纹。
        const sourceOf = new Map();
        for (const card of input)
            sourceOf.set(insightIdOf(card), card.source);
        const sourceFeedback = aggregateSourceFeedback(previous, sourceOf);
        const now = this.now();
        const result = applyInsightPolicy(input, previous, now, this.options, sourceFeedback);
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
        // 溯源：把 sourceTrust / 合并关系 / 节律抑制 / 采集延迟附到每张卡。
        const provenance = {};
        for (const card of result.cards) {
            provenance[card.id] = {
                source: card.source,
                trust: card.sourceTrust ?? 1,
                merged: card.mergedCount ?? 0,
                rhythmSuppressed: card.rhythmSuppressed === true,
                latencyMs: latencyBySource.get(card.source),
            };
        }
        const sourceTrust = {};
        for (const [source, trust] of result.sourceTrust)
            sourceTrust[source] = trust;
        const feed = {
            cards: result.cards,
            summary: summarizeFeed(result.cards, providerFailures, result.mergedCount),
            generatedAt: now,
            unreadCount: result.cards.filter((card) => card.unread).length,
            snoozedCount: result.snoozedCount,
            dismissedCount: result.dismissedCount,
            providerFailures,
            mergedCount: result.mergedCount,
            rhythmSuppressedCount: result.rhythmSuppressedCount,
            sourceTrust,
            provenance,
        };
        // 健康统计（指数平滑耗时；累计计数）。
        this.healthStats.refreshes += 1;
        this.healthStats.providerSamples += providers.length;
        this.healthStats.providerFailures += providerFailures;
        this.healthStats.failedProvidersNow = providerFailures;
        this.healthStats.merged += result.mergedCount;
        this.healthStats.rhythmSuppressed += result.rhythmSuppressedCount;
        this.healthStats.lastRefreshAt = now;
        const elapsed = Math.max(0, this.now() - startedAt);
        this.healthStats.lastRefreshMs = elapsed;
        this.healthStats.avgRefreshMs =
            this.healthStats.avgRefreshMs === 0
                ? elapsed
                : this.healthStats.avgRefreshMs * (1 - this.smoothing) + elapsed * this.smoothing;
        this.cached = { feed, expiresAt: now + this.cacheMs };
        // 节律门：通知是打断，不是刷新的副产品。距上次通知不足 quietMs 时
        // 不推新通知（卡片仍在 feed 中可见，未读态照常累积）。
        const notifyEligible = result.notifications.filter((id) => {
            if (this.lastNotifiedAt === undefined)
                return true;
            if (now - this.lastNotifiedAt < this.quietMs) {
                // 严重度升级可突破节律门（critical 永不因节律被吞）。
                const card = feed.cards.find((item) => item.id === id);
                return card?.severity === 'critical';
            }
            return true;
        });
        if (notifyEligible.length > 0) {
            this.lastNotifiedAt = now;
            this.healthStats.notifications += notifyEligible.length;
        }
        if (notifyEligible.length > 0 && this.options.onNotifications !== undefined) {
            const notified = new Set(notifyEligible);
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
    /** 隔离单个 Provider 的同步异常、异步拒绝与超时；返回耗时。 */
    async collect(provider) {
        let timer;
        const startedAt = this.now();
        try {
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('insight provider timeout')), this.providerTimeoutMs);
                timer.unref();
            });
            const cards = await Promise.race([Promise.resolve().then(provider), timeout]);
            return { cards, latencyMs: Math.max(0, this.now() - startedAt) };
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
/** 指纹计算（与 policy 同源；Center 内部避免重复 import 循环）。 */
function insightIdOf(card) {
    const identity = card.key ?? card.actionId ?? card.source;
    const input = `${card.category}\n${card.source}\n${identity}`;
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `ins_${hash.toString(16).padStart(16, '0')}`;
}
/** 面向用户的摘要只陈述当前可见信号与降级事实。 */
function summarizeFeed(cards, providerFailures, mergedCount) {
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
    if (mergedCount > 0)
        parts.push(`${mergedCount} 条同主题信号已合并`);
    if (providerFailures > 0)
        parts.push(`${providerFailures} 个信号源暂时不可用`);
    return parts.join('，');
}
