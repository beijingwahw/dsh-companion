/**
 * 模块 D：全局对话检索插件。
 *
 * 经 ctx.companion.http 注册 GET /search、GET /tags、POST /tags，
 * 经 ctx.commands 注册 `search` 与 `tag` 命令；检索逻辑复用
 * ./service.js，标签数据落在 companion 存储域 'tags' 表（./tags.js）。
 *
 * apply 是同步函数，而存储域打开是异步的：内部用 void async IIFE
 * 先 await ctx.companion.ready 取 domain 建 TagStore，再把全部注册
 * 动作放进 ctx.effect，保证随插件卸载回卷。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import { formatBeijingTime } from '../../core/time.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import { searchSessions, type SearchParams } from './service.js'
import { TagStore } from './tags.js'

/** 插件名。 */
export const name = 'companion-search'

/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 北京时间偏移（UTC+8，毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 一日毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** YYYY-MM-DD 日期模式。 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** 插件入口：异步初始化后立即执行函数包裹，注册动作经 ctx.effect。 */
export function apply(ctx: Context): void {
  void (async () => {
    // 存储域异步打开；失败时模块保持静默（不注册任何端点/命令）。
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const tagStore = new TagStore(store.domain)

    try {
      ctx.effect(() => {
        const disposers: Array<() => void> = [
          // 全局检索：query/from/to/tags/limit。
          ctx.companion.http.add('GET', '/search', async (_req, res, hctx) => {
            try {
              const params = parseSearchParams(hctx.query)
              const hits = await searchSessions(
                { sessionQuery: ctx.sessionQuery, tagStore },
                params,
              )
              sendJson(res, 200, { hits })
            } catch (error) {
              throw toSafeHttpError(error, '检索会话失败')
            }
          }),

          // 标签读取：带 sessionId 返回单会话标签，缺省返回全量映射。
          ctx.companion.http.add('GET', '/tags', (_req, res, hctx) => {
            const sessionId = hctx.query.get('sessionId')
            if (sessionId && sessionId.trim().length > 0) {
              sendJson(res, 200, { tags: tagStore.getForSession(SessionId(sessionId.trim())) })
              return
            }
            sendJson(res, 200, { tags: tagStore.getAll() })
          }),

          // 标签写入：add/remove 原子增删。
          ctx.companion.http.add('POST', '/tags', async (_req, res, hctx) => {
            try {
              const { sessionId, add, remove } = parseTagsBody(hctx.body)
              const tags = await tagStore.mutate(sessionId, { add, remove })
              sendJson(res, 200, { tags })
            } catch (error) {
              throw toSafeHttpError(error, '更新标签失败')
            }
          }),

          // 命令：检索历史对话。
          ctx.commands.register({
            name: 'search',
            description: '检索历史对话',
            input: '<检索词>',
            handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
              const query = (invocation.input ?? '').trim()
              if (query.length === 0) return { text: '请输入检索词' }
              try {
                const hits = await searchSessions(
                  { sessionQuery: ctx.sessionQuery, tagStore },
                  { query },
                )
                if (hits.length === 0) return { text: `未找到与“${query}”匹配的对话` }
                const lines: string[] = [`共找到 ${hits.length} 个对话：`]
                let index = 1
                for (const hit of hits) {
                  lines.push(`${index}. ${hit.session.title || '未命名对话'}`)
                  lines.push(`   ID: ${hit.session.id}`)
                  lines.push(`   时间: ${formatBeijingTime(hit.session.createdAt)}`)
                  if (hit.snippet) lines.push(`   摘要: ${hit.snippet}`)
                  if (hit.tags.length > 0) lines.push(`   标签: ${hit.tags.join('、')}`)
                  index += 1
                }
                return { text: lines.join('\n'), data: { hits } }
              } catch {
                return { text: '检索失败，请稍后重试' }
              }
            },
          }),

          // 命令：为会话增删标签。
          ctx.commands.register({
            name: 'tag',
            description: '为会话增删标签',
            input: '<会话ID> +标签1 -标签2',
            handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
              const tokens = (invocation.input ?? '')
                .split(/\s+/)
                .map((token) => token.trim())
                .filter((token) => token.length > 0)
              if (tokens.length < 2) {
                return { text: '用法：tag <会话ID> +标签1 -标签2（+ 添加，- 移除）' }
              }
              const sessionId = SessionId(tokens[0])
              const add: string[] = []
              const remove: string[] = []
              for (const token of tokens.slice(1)) {
                if (token.startsWith('+')) {
                  const tag = token.slice(1).trim()
                  if (tag.length > 0) add.push(tag)
                } else if (token.startsWith('-')) {
                  const tag = token.slice(1).trim()
                  if (tag.length > 0) remove.push(tag)
                } else {
                  return { text: `无法解析标签参数“${token}”，请使用 +标签/-标签 形式` }
                }
              }
              try {
                const tags = await tagStore.mutate(sessionId, { add, remove })
                const text =
                  tags.length > 0
                    ? `会话 ${sessionId} 的标签已更新：${tags.join('、')}`
                    : `会话 ${sessionId} 的标签已清空`
                return { text, data: { tags } }
              } catch {
                return { text: '更新标签失败，请稍后重试' }
              }
            },
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-search.register')
    } catch {
      // 等待存储域期间插件已被卸载（INACTIVE_EFFECT），放弃注册。
    }
  })()
}

/**
 * 解析时间参数：兼容毫秒时间戳与 YYYY-MM-DD。
 * 日期按北京时间解释：from 取当日零点，to 取当日 23:59:59.999（闭区间）。
 * 日期解析后回验历法合法性（getUTCMonth/getUTCDate 与输入一致），
 * 拒绝 2024-13-40 这类会被 Date 静默规范化的非法日期。
 */
function parseTimeParam(value: string, edge: 'start' | 'end'): number {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const matched = DAY_PATTERN.exec(trimmed)
  if (matched) {
    const year = Number(matched[1])
    const month = Number(matched[2])
    const day = Number(matched[3])
    const probe = new Date(Date.UTC(year, month - 1, day))
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new HttpError(`时间参数不是合法日期：${value}`)
    }
    const utcMidnight = Date.UTC(year, month - 1, day)
    const dayStart = utcMidnight - BEIJING_OFFSET_MS
    return edge === 'start' ? dayStart : dayStart + DAY_MS - 1
  }
  throw new HttpError(`时间参数必须是毫秒时间戳或 YYYY-MM-DD：${value}`)
}

/** 解析 GET /search 的查询参数。 */
function parseSearchParams(query: URLSearchParams): SearchParams {
  const params: SearchParams = {}
  const queryText = query.get('query')
  if (queryText && queryText.trim().length > 0) params.query = queryText.trim()
  const from = query.get('from')
  if (from !== null && from.length > 0) params.from = parseTimeParam(from, 'start')
  const to = query.get('to')
  if (to !== null && to.length > 0) params.to = parseTimeParam(to, 'end')
  const tags = query.get('tags')
  if (tags !== null && tags.length > 0) {
    params.tags = tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
  }
  const limit = query.get('limit')
  if (limit !== null && limit.length > 0) {
    const parsed = Number(limit)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new HttpError('limit 必须是正整数')
    }
    params.limit = parsed
  }
  return params
}

/** 解析 POST /tags 请求体。 */
function parseTagsBody(body: unknown): {
  sessionId: SessionId
  add?: string[]
  remove?: string[]
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象')
  }
  const record = body as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
    throw new HttpError('sessionId 必填')
  }
  return {
    sessionId: SessionId(record.sessionId.trim()),
    add: parseTagList(record.add, 'add'),
    remove: parseTagList(record.remove, 'remove'),
  }
}

/** 解析可选的标签字符串数组。 */
function parseTagList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new HttpError(`${field} 必须是字符串数组`)
  const tags: string[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string') throw new HttpError(`${field} 必须全部为字符串`)
    tags.push(item)
  }
  return tags
}

/**
 * 将错误收敛为用户安全的 HttpError：
 * HttpError 原样透传；其余错误以通用文案包装，避免泄漏内部细节。
 */
function toSafeHttpError(error: unknown, fallbackMessage: string): HttpError {
  if (error instanceof HttpError) return error
  return new HttpError(fallbackMessage, 500)
}
