/**
 * `@deepseek-ai/dsh-storage` 环境模块声明（存储能力契约）。
 *
 * 按 docs/subsystems/storage.md 声明：hub（ctx.storageDomain）不做 IO，
 * 后端（json/sqlite）拥有介质，域层拥有语义；读同步、写走每域写链。
 * 本文件必须是全局脚本（无顶层 import/export），才能作为环境模块声明。
 */

declare module '@deepseek-ai/dsh-storage' {
  /** 存储域规格：名称 + 单调递增的 schema 版本。 */
  export interface DomainSpec {
    readonly name: string
    readonly version: number
    readonly description?: string
  }

  /** 类型化键值表：读同步（权威内存状态），写排入每域写链。 */
  export interface KvTable<V = unknown> {
    get(key: string): V | undefined
    keys(): string[]
    entries(): [string, V][]
    readonly size: number
    put(key: string, value: V): Promise<void>
    delete(key: string): Promise<void>
    /** 原子读-改-写。 */
    update(key: string, fn: (prev: V | undefined) => V | undefined): Promise<void>
  }

  /** 打开后的存储域。 */
  export interface Domain {
    readonly spec: DomainSpec
    table<V = unknown>(name: string): KvTable<V>
    readonly global: KvTable
  }

  /** 域设施（ctx.storageDomain）。 */
  export interface DomainFacility {
    open(spec: DomainSpec): Promise<Domain>
    get(name: string): Domain | undefined
    closeAll(): Promise<void>
  }

  /** 声明一个存储域规格。 */
  export function defineDomain(spec: DomainSpec): DomainSpec
}
