import { round4 } from './pricing.js';
import { beijingDayKey, beijingMonthKey } from './time.js';
export class UsageStore {
    table;
    constructor(domain) {
        this.table = domain.table('usage-daily');
    }
    /** 记录一次调用（原子并入当日聚合）。 */
    async record(delta) {
        // 入口校验时间戳：非法值（NaN/Infinity 等）会派生出 "NaN-NaN-NaN" 日键并污染落盘数据。
        if (!Number.isFinite(delta.ts)) {
            throw new TypeError(`usage.record: delta.ts 必须是有限数字，实际为 ${String(delta.ts)}`);
        }
        const day = beijingDayKey(delta.ts);
        const cacheHitTokens = delta.cacheHitTokens ?? 0;
        await this.table.update(day, (prev) => {
            const base = prev ?? {
                day,
                calls: 0,
                promptTokens: 0,
                completionTokens: 0,
                cacheHitTokens: 0,
                costCny: 0,
                savedCny: 0,
                deferredCalls: 0,
                byModel: {},
            };
            const slice = base.byModel[delta.model] ?? {
                calls: 0,
                promptTokens: 0,
                completionTokens: 0,
                cacheHitTokens: 0,
                costCny: 0,
            };
            return {
                ...base,
                calls: base.calls + 1,
                promptTokens: base.promptTokens + delta.promptTokens,
                completionTokens: base.completionTokens + delta.completionTokens,
                cacheHitTokens: (base.cacheHitTokens ?? 0) + cacheHitTokens,
                costCny: round4(base.costCny + delta.costCny),
                savedCny: round4(base.savedCny + (delta.savedCny ?? 0)),
                deferredCalls: base.deferredCalls + (delta.deferred ? 1 : 0),
                byModel: {
                    ...base.byModel,
                    [delta.model]: {
                        calls: slice.calls + 1,
                        promptTokens: slice.promptTokens + delta.promptTokens,
                        completionTokens: slice.completionTokens + delta.completionTokens,
                        cacheHitTokens: (slice.cacheHitTokens ?? 0) + cacheHitTokens,
                        costCny: round4(slice.costCny + delta.costCny),
                    },
                },
            };
        });
    }
    /** 读取 [fromDay, toDay] 闭区间内的日聚合，按日期升序。 */
    range(fromDay, toDay) {
        return this.table
            .entries()
            .map(([, value]) => value)
            .filter((u) => u.day >= fromDay && u.day <= toDay)
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
    /** 读取某时间戳所在北京时间月的全部日聚合。 */
    month(ts) {
        const prefix = beijingMonthKey(ts);
        return this.range(`${prefix}-01`, `${prefix}-31`);
    }
    /** 汇总若干日聚合。 */
    total(rows) {
        const total = {
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheHitTokens: 0,
            costCny: 0,
            savedCny: 0,
            deferredCalls: 0,
        };
        for (const row of rows) {
            total.calls += row.calls;
            total.promptTokens += row.promptTokens;
            total.completionTokens += row.completionTokens;
            total.cacheHitTokens += row.cacheHitTokens ?? 0;
            total.costCny = round4(total.costCny + row.costCny);
            total.savedCny = round4(total.savedCny + row.savedCny);
            total.deferredCalls += row.deferredCalls;
        }
        return total;
    }
}
