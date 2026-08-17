/**
 * 存储适配层：桥接插件内部存储契约与真实 Harness 存储 API。
 *
 * 插件内部使用的存储接口（Domain / KvTable / defineDomain）与
 * `@deepseek-ai/dsh-storage-domain` 的真实 API 存在以下差异：
 * - 表名：插件使用连字符（如 'usage-daily'），真实 API 要求 UNIT_NAME_RE（仅小写字母/数字/下划线）
 * - keys()/entries()：插件期望数组，真实 API 返回迭代器
 * - delete()：插件期望 Promise<void>，真实 API 返回 Promise<boolean>
 * - update()：插件回调返回 V|undefined（undefined=删除），真实 API 回调返回 V（键不存在则抛错）
 * - Domain.global：插件期望 KvTable，真实 API 是 DomainGlobal<G>
 * - defineDomain：插件仅传 name/version，真实 API 要求声明所有表及 zod schema
 *
 * 本模块提供适配函数，使插件代码无需修改即可运行在真实 Harness 上。
 */
import { type Domain as RealDomain, type DomainSpec as RealDomainSpec } from '@deepseek-ai/dsh-storage-domain';
/** 存储域规格：名称 + 单调递增的 schema 版本。 */
export interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly description?: string;
}
/** 类型化键值表：读同步（权威内存状态），写排入每域写链。 */
export interface KvTable<V = unknown> {
    get(key: string): V | undefined;
    keys(): string[];
    entries(): [string, V][];
    readonly size: number;
    put(key: string, value: V): Promise<void>;
    delete(key: string): Promise<void>;
    /** 原子读-改-写；回调返回 undefined 表示删除该键。 */
    update(key: string, fn: (prev: V | undefined) => V | undefined): Promise<void>;
}
/** 打开后的存储域。 */
export interface Domain {
    readonly spec: DomainSpec;
    table<V = unknown>(name: string): KvTable<V>;
    readonly global: KvTable;
}
/** 域设施（ctx.storageDomain）。 */
export interface DomainFacility {
    open(spec: DomainSpec): Promise<Domain>;
    get(name: string): Domain | undefined;
    closeAll(): Promise<void>;
}
/**
 * 声明存储域规格。内部将所有表以 z.unknown() schema 注册到真实 DomainSpec，
 * 使 Harness 存储层能正确打开域。插件自行负责记录级校验。
 */
export declare function defineDomain(spec: DomainSpec): DomainSpec;
/** 真实 DomainFacility 的类型（来自 @deepseek-ai/dsh-storage-domain）。 */
export interface RealDomainFacility {
    open<S extends RealDomainSpec>(spec: S): Promise<RealDomain<S>>;
    get(name: string): unknown;
    closeAll(): Promise<void>;
}
/**
 * 将真实 DomainFacility 包装为插件期望的 DomainFacility 接口。
 * 在 CompanionCoreService 初始化时调用。
 */
export declare function wrapFacility(real: RealDomainFacility): DomainFacility;
