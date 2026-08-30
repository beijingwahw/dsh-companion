/**
 * 存储适配层：桥接插件内部存储契约与真实 Harness 存储 API。
 *
 * 插件内部使用的存储接口（Domain / KvTable / defineDomain）与
 * `@deepseek-ai/dsh-storage-domain` 的真实 API 存在以下差异：
 * - 表名：插件使用连字符（如 'usage-daily'），真实 API 要求 UNIT_NAME_RE（仅小写字母/数字/下划线）
 * - keys()/entries()：插件期望数组，真实 API 返回迭代器
 * - delete()：插件期望 Promise<void>，真实 API 返回 Promise<boolean>
 * - update()：插件回调为原子读改写 `(prev: V|undefined) => V|undefined`（undefined=删除），
 *   真实 API 回调只接受 `(prev: V) => V` 且键不存在时抛错——经同键写串行化队列适配（见下）
 * - Domain.global：插件期望 KvTable，真实 API 是 DomainGlobal<G>
 * - defineDomain：插件仅传 name/version，真实 API 要求声明所有表及 zod schema
 *
 * 本模块提供适配函数，使插件代码无需修改即可运行在真实 Harness 上。
 */
import { defineDomain as realDefineDomain, domainTable, } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
// ---------------------------------------------------------------------------
// 表名转换：连字符 → 下划线（满足 UNIT_NAME_RE）
// ---------------------------------------------------------------------------
/** 将插件内部表名（可含连字符）转换为 Harness 合法表名（仅下划线）。 */
function toUnitName(name) {
    return name.replace(/-/g, '_');
}
// ---------------------------------------------------------------------------
// 插件使用的全部表名清单（用于 defineDomain 声明）
// ---------------------------------------------------------------------------
/** 插件所有模块使用的表名（连字符形式）。 */
const ALL_TABLE_NAMES = [
    // core
    'vault-meta', 'vault', 'usage-daily',
    // handoff
    'templates', 'handoff-armed', 'handoff-receipts',
    // cost
    'cost-extra', 'budget-state',
    // search
    'tags',
    // trace
    'traces', 'trace-stats-daily',
    // prompt
    'prompt-versions', 'prompt-templates', 'prompt-ratings',
    // orchestrator
    'pipelines', 'pipeline-runs', 'queue-tasks', 'scheduled-jobs', 'scheduled-runs',
    // team
    'team-prefs', 'team-snapshots', 'experience-cards',
    'review-requests', 'review-comments', 'review-decisions',
    // security
    'named-keys', 'audit-log', 'dlp-rules', 'dlp-builtin-overrides',
    'dlp-settings', 'dlp-blocks-daily', 'audit-alerts',
];
// ---------------------------------------------------------------------------
// defineDomain：创建真实 Harness DomainSpec
// ---------------------------------------------------------------------------
/**
 * 声明存储域规格。内部将所有表以 z.unknown() schema 注册到真实 DomainSpec，
 * 使 Harness 存储层能正确打开域。插件自行负责记录级校验。
 */
export function defineDomain(spec) {
    return spec;
}
/**
 * 从插件 DomainSpec 构建真实 Harness DomainSpec（含全部表声明）。
 * 在 openDomain 时调用。
 */
function buildRealSpec(spec) {
    const tables = {};
    for (const name of ALL_TABLE_NAMES) {
        tables[toUnitName(name)] = domainTable(z.unknown());
    }
    return realDefineDomain({
        name: spec.name,
        version: spec.version,
        tables,
    });
}
// ---------------------------------------------------------------------------
// KvTable 适配
// ---------------------------------------------------------------------------
/**
 * 同键写串行化队列：保证「读-改-写」在同进程内原子。
 *
 * 真实 API 的 `update(key, fn)` 回调只接受 `(prev: V) => V`（键不存在时
 * 整体抛错，回调也不能返回 undefined 表示删除），因此无法直接承载插件
 * 契约的 `(prev: V | undefined) => V | undefined`。此前适配层在写链之外
 * 预读快照再写入，导致并发更新互相覆盖（丢增量）。
 *
 * 现改为：本插件对同一键的全部写操作（put/delete/update）都排入该键的
 * 串行队列，任务在队首执行时才同步读取权威内存值并计算结果——同进程内
 * 任意并发的读改写不再交错，键的创建竞态也随之消除。
 */
const writeChains = new Map();
function serializeWrite(key, job) {
    const prev = writeChains.get(key) ?? Promise.resolve();
    // 前序任务失败不阻塞本任务。
    const run = prev.then(job, job);
    const tail = run.then(() => undefined, () => undefined);
    writeChains.set(key, tail);
    // 队列归零后清理，避免 Map 随键数无界增长（新任务入队时跳过清理）。
    void tail.then(() => {
        if (writeChains.get(key) === tail)
            writeChains.delete(key);
    });
    return run;
}
/** 将真实 KvTable 包装为插件期望的 KvTable 接口。 */
function wrapTable(real) {
    return {
        get: (key) => real.get(key),
        keys: () => [...real.keys()],
        entries: () => [...real.entries()],
        get size() { return real.size; },
        put: (key, value) => serializeWrite(key, () => real.put(key, value)),
        delete: (key) => serializeWrite(key, async () => { await real.delete(key); }),
        update: (key, fn) => serializeWrite(key, async () => {
            // 队首执行：此刻的同步读即权威内存状态，并发调用不会互相覆盖。
            const current = real.get(key);
            const next = fn(current);
            if (next === undefined) {
                if (current !== undefined)
                    await real.delete(key);
                return;
            }
            await real.put(key, next);
        }),
    };
}
// ---------------------------------------------------------------------------
// Domain 适配
// ---------------------------------------------------------------------------
/** 将真实 Domain 包装为插件期望的 Domain 接口。 */
function wrapDomain(real, spec) {
    const tableCache = new Map();
    return {
        spec,
        table(name) {
            if (!tableCache.has(name)) {
                tableCache.set(name, wrapTable(real.table(toUnitName(name))));
            }
            return tableCache.get(name);
        },
        get global() {
            // 插件未使用 domain.global；提供空实现以满足接口。
            throw new Error('companion storage: domain.global is not used by this plugin');
        },
    };
}
/**
 * 将真实 DomainFacility 包装为插件期望的 DomainFacility 接口。
 * 在 CompanionCoreService 初始化时调用。
 */
export function wrapFacility(real) {
    const openDomains = new Map();
    return {
        async open(spec) {
            const realSpec = buildRealSpec(spec);
            const realDomain = await real.open(realSpec);
            const wrapped = wrapDomain(realDomain, spec);
            openDomains.set(spec.name, wrapped);
            return wrapped;
        },
        get(name) {
            return openDomains.get(name);
        },
        async closeAll() {
            await real.closeAll();
            openDomains.clear();
        },
    };
}
