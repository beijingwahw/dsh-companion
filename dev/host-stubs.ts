/**
 * 开发期宿主服务桩（仅 `npm run dev` 的独立 cordis 进程使用，不参与构建产物）。
 *
 * 本插件宿主入口挂载 CompanionCoreService（inject: webServer / storageDomain /
 * credentials）与四个功能模块（inject: sessionQuery / commands / settings /
 * systemPrompt）。独立 cordis 进程没有 dsh 宿主，缺桩时 fiber 永远 PENDING。
 * 各桩按模块实际消费的最小面给出：
 * - webServer.register({kind,path,handler}) → 返回函数型 disposer（core 经 ctx.effect 回卷）
 * - storageDomain.open(spec) → 内存版 Domain（真实 KvTable 形状：keys/entries 为迭代器）；
 *   域缓存按名字复用，插件热重载后开发数据不丢
 * - credentials.resolve(ref) → undefined（无 Key 时各模块静默降级）
 * - commands.register(def) → 函数型 disposer（模块注册期即调用）
 * - settings.register(ns, schema) → 作用域（get 返回 schema 默认值，缺省空对象）
 * - sessionQuery → 空会话列表（端点真正被调用时才触及）
 * - systemPrompt.context(def) → 函数型 disposer（handoff 经 ctx.effect 回卷）
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dev-host-stubs'

/** 真实形状的内存 KvTable：keys()/entries() 返回迭代器（对齐 dsh-storage-domain）。 */
function memTable() {
  const map = new Map<string, unknown>()
  return {
    get: (key: string) => map.get(key),
    *keys() {
      yield* map.keys()
    },
    *entries() {
      yield* map.entries()
    },
    get size() {
      return map.size
    },
    put: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    delete: async (key: string) => {
      map.delete(key)
    },
    update: async (key: string, fn: (prev: unknown) => unknown) => {
      map.set(key, fn(map.get(key)))
    },
  }
}

export function apply(ctx: Context): void {
  const domains = new Map<string, { table: (name: string) => ReturnType<typeof memTable> }>()

  ctx.provide('webServer', {
    register: (_def: unknown) => () => {},
  })

  ctx.provide('credentials', {
    resolve: async (_ref: unknown) => undefined,
  })

  ctx.provide('storageDomain', {
    open: async (spec: { name: string }) => {
      let domain = domains.get(spec.name)
      if (!domain) {
        const tables = new Map<string, ReturnType<typeof memTable>>()
        domain = {
          table: (name: string) => {
            let table = tables.get(name)
            if (!table) {
              table = memTable()
              tables.set(name, table)
            }
            return table
          },
        }
        domains.set(spec.name, domain)
      }
      return domain
    },
    get: (name: string) => domains.get(name),
    closeAll: async () => {
      domains.clear()
    },
  })

  ctx.provide('commands', {
    register: (_def: unknown) => () => {},
  })

  ctx.provide('settings', {
    register(_ns: string, schema: { meta?: { default?: unknown } } | undefined) {
      const base = (schema?.meta?.default ?? {}) as Record<string, unknown>
      let value = { ...base }
      return {
        get: () => value,
        update: async (patch: Record<string, unknown>) => {
          value = { ...value, ...patch }
        },
        replace: async (section: Record<string, unknown>) => {
          value = { ...base, ...section }
        },
        watch: (_cb: (next: unknown, prev: unknown) => void) => () => {},
      }
    },
  })

  ctx.provide('sessionQuery', {
    listSessions: async () => [],
    readSession: async (id: string) => {
      throw new Error(`[dev-stub] sessionQuery.readSession(${id})：开发桩无会话数据`)
    },
  })

  ctx.provide('systemPrompt', {
    context: (_def: unknown) => () => {},
  })
}
