/**
 * 模块 A：对话智能导出插件。
 *
 * 经 ctx.companion.http 注册三个私有端点（GET /export/sessions、
 * POST /export/run、POST /export/batch），经 ctx.commands 注册
 * `export` 与 `export-batch` 两个命令。HTTP 与命令复用 ./service.js
 * 的同一套服务函数，不重复实现逻辑（DESIGN.md 第 5 节）。
 * 全部注册经 ctx.effect，随插件卸载自动回卷；错误一律收敛为
 * HttpError / 用户可读文本，不泄漏内部细节。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import { SessionId } from '../../core/ids.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import {
  buildBatchExport,
  buildSingleExport,
  toSafeHttpError,
  userFacingMessage,
  type ExportFormat,
  type ExportOptions,
} from './service.js'

/** 插件名。 */
export const name = 'companion-export'

/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands']

/** 合法导出格式集合（png=长图，仅 HTTP 客户端可用，需 canvas 光栅化）。 */
const EXPORT_FORMATS: readonly ExportFormat[] = ['markdown', 'pdf', 'json', 'png']

/** 格式类型守卫。 */
function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

/** 插件入口：所有注册经 ctx.effect，卸载时统一回卷。 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = [
      // 会话列表（客户端导出选择器数据源）。
      ctx.companion.http.add('GET', '/export/sessions', async (_req, res) => {
        try {
          const sessions = await ctx.sessionQuery.listSessions()
          sendJson(res, 200, { sessions })
        } catch (error) {
          throw toSafeHttpError(error, '获取会话列表失败')
        }
      }),

      // 单会话导出：响应为 file（base64）、print（html）或 raster（客户端光栅）。
      // HTTP 客户端具备 canvas 光栅能力，统一开启：PNG 长图与含 CJK 的 PDF
      // 由客户端光栅化成品，全程无 window.print() 对话框。
      ctx.companion.http.add('POST', '/export/run', async (_req, res, hctx) => {
        try {
          const { sessionId, options } = parseRunBody(hctx.body)
          const payload = await buildSingleExport(ctx.sessionQuery, sessionId, {
            ...options,
            raster: true,
          })
          sendJson(res, 200, payload)
        } catch (error) {
          throw toSafeHttpError(error, '导出会话失败')
        }
      }),

      // 批量导出：ZIP 文件载荷。
      ctx.companion.http.add('POST', '/export/batch', async (_req, res, hctx) => {
        try {
          const { sessionIds, options } = parseBatchBody(hctx.body)
          const payload = await buildBatchExport(ctx.sessionQuery, sessionIds, options)
          sendJson(res, 200, payload)
        } catch (error) {
          throw toSafeHttpError(error, '批量导出失败')
        }
      }),

      // 命令：导出当前/指定会话。
      ctx.commands.register({
        name: 'export',
        description: '导出对话',
        input: '<会话ID> [markdown|pdf|json]',
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          try {
            const { sessionId, options } = parseExportInput(
              invocation.input,
              invocation.sessionId,
            )
            const payload = await buildSingleExport(ctx.sessionQuery, sessionId, options)
            const text =
              payload.kind === 'file'
                ? `导出完成：${payload.fileName}`
                : `内容包含宽字符（如中文），已生成打印页 ${payload.fileName}，请在浏览器打印对话框中另存为 PDF`
            return { text, data: payload }
          } catch (error) {
            return { text: userFacingMessage(error, '导出失败，请稍后重试') }
          }
        },
      }),

      // 命令：批量导出为 ZIP。
      ctx.commands.register({
        name: 'export-batch',
        description: '批量导出为 ZIP',
        input: '<会话ID1>,<会话ID2>,…',
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          try {
            const sessionIds = (invocation.input ?? '')
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
              .map((part) => SessionId(part))
            if (sessionIds.length === 0) {
              return { text: '请提供要导出的会话 ID（逗号分隔）' }
            }
            const payload = await buildBatchExport(ctx.sessionQuery, sessionIds, {
              format: 'markdown',
            })
            return { text: `批量导出完成：${payload.fileName}`, data: payload }
          } catch (error) {
            return { text: userFacingMessage(error, '批量导出失败，请稍后重试') }
          }
        },
      }),
    ]
    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'companion-export.register')
}

/** 将请求体收窄为对象记录（形状不符抛 HttpError）。 */
function bodyAsRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

/** 解析必填的格式字段。 */
function parseFormat(value: unknown): ExportFormat {
  if (typeof value === 'string' && isExportFormat(value)) return value
  throw new HttpError('format 必填，且必须为 markdown/pdf/json/png 之一')
}

/** 解析布尔开关（缺省取 fallback）。 */
function parseFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new HttpError(`${field} 必须是布尔值`)
  return value
}

/** 解析 POST /export/run 请求体。 */
function parseRunBody(body: unknown): { sessionId: SessionId; options: ExportOptions } {
  const record = bodyAsRecord(body)
  if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
    throw new HttpError('sessionId 必填')
  }
  return {
    sessionId: SessionId(record.sessionId.trim()),
    options: {
      format: parseFormat(record.format),
      timestamps: parseFlag(record.timestamps, 'timestamps', true),
      redact: parseFlag(record.redact, 'redact', false),
    },
  }
}

/** 解析 POST /export/batch 请求体。 */
function parseBatchBody(body: unknown): { sessionIds: SessionId[]; options: ExportOptions } {
  const record = bodyAsRecord(body)
  const rawIds: unknown = record.sessionIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new HttpError('sessionIds 必填且必须为非空数组')
  }
  const sessionIds: SessionId[] = []
  for (const item of rawIds as readonly unknown[]) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new HttpError('sessionIds 必须全部为非空字符串')
    }
    sessionIds.push(SessionId(item.trim()))
  }
  return {
    sessionIds,
    options: {
      format: parseFormat(record.format),
      timestamps: parseFlag(record.timestamps, 'timestamps', true),
      redact: parseFlag(record.redact, 'redact', false),
    },
  }
}

/**
 * 解析 export 命令输入：“<会话ID> [markdown|pdf|json]”。
 * 单个 token 且为合法格式时视为格式（会话取调用来源会话）；
 * 缺省会话时回退 invocation.sessionId；格式缺省 markdown。
 */
function parseExportInput(
  input: string | undefined,
  fallbackSessionId: SessionId | undefined,
): { sessionId: SessionId; options: ExportOptions } {
  const tokens = (input ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    if (!fallbackSessionId) throw new HttpError('请指定要导出的会话 ID')
    return { sessionId: fallbackSessionId, options: { format: 'markdown' } }
  }

  const first = tokens[0].toLowerCase()
  if (tokens.length === 1 && isExportFormat(first)) {
    if (!fallbackSessionId) throw new HttpError('请指定要导出的会话 ID')
    return { sessionId: fallbackSessionId, options: { format: first } }
  }

  const sessionId = SessionId(tokens[0])
  if (tokens.length === 1) return { sessionId, options: { format: 'markdown' } }

  const format = tokens[1].toLowerCase()
  if (!isExportFormat(format)) {
    throw new HttpError(`不支持的导出格式“${format}”，可选 markdown/pdf/json/png`)
  }
  return { sessionId, options: { format } }
}
