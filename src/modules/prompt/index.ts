/**
 * 模块 F：Prompt 工程工作台（prompt）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * F1 版本管理：GET/POST /prompt/versions、POST /prompt/rollback、POST /prompt/tags；
 * F2 A/B 测试：POST /prompt/ab-test（批量跑两个版本并对比指标）、
 *    POST /prompt/rate、GET /prompt/ratings；
 * F3 模板库：GET/POST/DELETE /prompt/templates、POST /prompt/render（变量插值）、
 *    POST /prompt/codegen（一键生成 Python/Node.js/curl 调用代码）；
 * F4 结构化校验：POST /prompt/validate（批量发送并按 JSON Schema 校验合规率）。
 *
 * 命令 `prompt`：查看当前 Prompt 版本历史。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import { extractJsonFromOutput, parseSchema, validateAgainstSchema } from './schema.js'
import {
  extractTemplateVariables,
  interpolateTemplate,
  PromptRatingStore,
  PromptTemplateStore,
  PromptVersionStore,
} from './store.js'

/** 插件名。 */
export const name = 'companion-prompt'

/** 依赖服务：companion 根服务、命令面板。 */
export const inject = ['companion', 'commands']

/** 单次 A/B 或校验批量的最大测试用例数（防误操作刷爆配额）。 */
const MAX_BATCH_CASES = 20

/** 插件入口。 */
export function apply(ctx: Context): void {
  void (async () => {
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const versions = new PromptVersionStore(store.domain)
    const templates = new PromptTemplateStore(store.domain)
    const ratings = new PromptRatingStore(store.domain)

    try {
      ctx.effect(() => {
        const disposers: Array<() => void> = [
          // --------------------------------------------------------------
          // F1 版本管理
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/prompt/versions', (_req, res) => {
            sendJson(res, 200, { versions: versions.list() })
          }),

          ctx.companion.http.add('POST', '/prompt/versions', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const content = requireString(body.content, 'content')
            const note = typeof body.note === 'string' ? body.note.trim() : ''
            const tags = parseStringArray(body.tags, 'tags')
            const record = await versions.save(content, note, tags)
            sendJson(res, 200, { version: record })
          }),

          ctx.companion.http.add('POST', '/prompt/rollback', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const version = requireInt(body.version, 'version')
            const note = typeof body.note === 'string' ? body.note.trim() : ''
            try {
              const record = await versions.rollback(version, note)
              sendJson(res, 200, { version: record })
            } catch (error) {
              throw new HttpError(error instanceof Error ? error.message : '回滚失败', 400)
            }
          }),

          ctx.companion.http.add('POST', '/prompt/tags', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const version = requireInt(body.version, 'version')
            try {
              const record = await versions.mutateTags(
                version,
                parseStringArray(body.add, 'add'),
                parseStringArray(body.remove, 'remove'),
              )
              sendJson(res, 200, { version: record })
            } catch (error) {
              throw new HttpError(error instanceof Error ? error.message : '更新标签失败', 400)
            }
          }),

          // --------------------------------------------------------------
          // F2 A/B 测试
          // --------------------------------------------------------------
          ctx.companion.http.add('POST', '/prompt/ab-test', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const promptA = requireString(body.promptA, 'promptA')
            const promptB = requireString(body.promptB, 'promptB')
            const cases = parseStringArray(body.cases, 'cases')
            if (cases.length === 0) cases.push('')
            if (cases.length > MAX_BATCH_CASES) {
              throw new HttpError(`测试用例不能超过 ${MAX_BATCH_CASES} 条`, 400)
            }
            const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-chat'

            const resultsA = await runBatch(ctx, promptA, cases, model)
            const resultsB = await runBatch(ctx, promptB, cases, model)
            sendJson(res, 200, {
              model,
              a: { prompt: promptA, results: resultsA, summary: summarizeBatch(resultsA) },
              b: { prompt: promptB, results: resultsB, summary: summarizeBatch(resultsB) },
              ratings: ratings.summary(),
            })
          }),

          ctx.companion.http.add('POST', '/prompt/rate', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const winner = body.winner
            if (winner !== 'A' && winner !== 'B' && winner !== 'tie') {
              throw new HttpError("winner 必须是 'A'、'B' 或 'tie'", 400)
            }
            await ratings.rate(
              winner,
              typeof body.promptA === 'string' ? body.promptA : '',
              typeof body.promptB === 'string' ? body.promptB : '',
            )
            sendJson(res, 200, { ok: true, ratings: ratings.summary() })
          }),

          ctx.companion.http.add('GET', '/prompt/ratings', (_req, res) => {
            sendJson(res, 200, { ratings: ratings.summary() })
          }),

          // --------------------------------------------------------------
          // F3 模板库
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/prompt/templates', (_req, res) => {
            const list = templates.list()
            sendJson(
              res,
              200,
              {
                templates: list.map((template) => ({
                  ...template,
                  variables: extractTemplateVariables(template.content),
                })),
              },
            )
          }),

          ctx.companion.http.add('POST', '/prompt/templates', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const content = requireString(body.content, 'content')
            const category = typeof body.category === 'string' ? body.category.trim() : '自定义'
            const record = await templates.save(name, category, content)
            sendJson(res, 200, { template: record })
          }),

          ctx.companion.http.add('DELETE', '/prompt/templates', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            await templates.delete(name)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/prompt/render', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const template = requireString(body.template, 'template')
            const variables = parseVariables(body.variables)
            sendJson(res, 200, { rendered: interpolateTemplate(template, variables) })
          }),

          ctx.companion.http.add('POST', '/prompt/codegen', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const prompt = requireString(body.prompt, 'prompt')
            const language = body.language
            if (language !== 'python' && language !== 'nodejs' && language !== 'curl') {
              throw new HttpError("language 必须是 'python'、'nodejs' 或 'curl'", 400)
            }
            const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-chat'
            sendJson(res, 200, { code: buildApiCallCode(language, model, prompt) })
          }),

          // --------------------------------------------------------------
          // F4 结构化输出校验
          // --------------------------------------------------------------
          ctx.companion.http.add('POST', '/prompt/validate', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const prompt = requireString(body.prompt, 'prompt')
            let schema: Record<string, unknown>
            try {
              schema = parseSchema(body.schema)
            } catch (error) {
              throw new HttpError(error instanceof Error ? error.message : 'JSON Schema 非法', 400)
            }
            const cases = parseStringArray(body.cases, 'cases')
            if (cases.length === 0) cases.push('')
            if (cases.length > MAX_BATCH_CASES) {
              throw new HttpError(`测试用例不能超过 ${MAX_BATCH_CASES} 条`, 400)
            }
            const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-chat'

            const runs: Array<{
              caseIndex: number
              input: string
              ok: boolean
              output: string
              violations: Array<{ path: string; message: string }>
              latencyMs: number
              tokens: number
              error?: string
            }> = []
            for (let index = 0; index < cases.length; index += 1) {
              const userContent = cases[index] ? `${prompt}\n\n${cases[index]}` : prompt
              try {
                const result = await ctx.companion.callDeepSeek({
                  messages: [{ role: 'user', content: userContent }],
                  model,
                  jsonMode: true,
                  source: 'prompt-validate',
                })
                const parsed = extractJsonFromOutput(result.content)
                const violations = parsed === undefined
                  ? [{ path: '', message: '输出不是合法 JSON' }]
                  : validateAgainstSchema(parsed, schema)
                runs.push({
                  caseIndex: index,
                  input: cases[index],
                  ok: violations.length === 0,
                  output: result.content,
                  violations,
                  latencyMs: result.latencyMs,
                  tokens: result.usage.promptTokens + result.usage.completionTokens,
                })
              } catch (error) {
                runs.push({
                  caseIndex: index,
                  input: cases[index],
                  ok: false,
                  output: '',
                  violations: [],
                  latencyMs: 0,
                  tokens: 0,
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
            const compliant = runs.filter((run) => run.ok).length
            sendJson(res, 200, {
              model,
              total: runs.length,
              compliant,
              complianceRate: runs.length > 0 ? compliant / runs.length : 0,
              runs,
            })
          }),

          // --------------------------------------------------------------
          // 命令面板
          // --------------------------------------------------------------
          ctx.commands.register({
            name: 'prompt',
            description: '查看 Prompt 版本历史',
            handler: async (_invocation: CommandInvocation): Promise<CommandResult> => {
              const list = versions.list()
              if (list.length === 0) return { text: '尚未保存任何 Prompt 版本' }
              const lines = [`Prompt 版本历史（共 ${list.length} 个版本）：`]
              for (const record of list.slice(-10)) {
                const tags = record.tags.length > 0 ? `（${record.tags.join('、')}）` : ''
                lines.push(`v${record.version}${tags} ${record.note || ''}`.trim())
              }
              return { text: lines.join('\n') }
            },
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-prompt.register')
    } catch {
      // 等待存储域期间插件已被卸载，放弃注册。
    }
  })()
}

/** 单条批量运行结果。 */
interface BatchRunResult {
  readonly caseIndex: number
  readonly input: string
  readonly ok: boolean
  readonly output: string
  readonly latencyMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly error?: string
}

/** 批量运行一个 Prompt（A/B 测试共用）。 */
async function runBatch(
  ctx: Context,
  prompt: string,
  cases: string[],
  model: string,
): Promise<BatchRunResult[]> {
  const results: BatchRunResult[] = []
  for (let index = 0; index < cases.length; index += 1) {
    const userContent = cases[index] ? `${prompt}\n\n${cases[index]}` : prompt
    try {
      const result = await ctx.companion.callDeepSeek({
        messages: [{ role: 'user', content: userContent }],
        model,
        source: 'prompt-ab-test',
      })
      results.push({
        caseIndex: index,
        input: cases[index],
        ok: true,
        output: result.content,
        latencyMs: result.latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      })
    } catch (error) {
      results.push({
        caseIndex: index,
        input: cases[index],
        ok: false,
        output: '',
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

/** 汇总批量指标：输出长度/响应时间/Token 消耗/成功率。 */
function summarizeBatch(results: readonly BatchRunResult[]): Record<string, number> {
  const okResults = results.filter((result) => result.ok)
  const totalTokens = okResults.reduce(
    (sum, result) => sum + result.promptTokens + result.completionTokens,
    0,
  )
  return {
    successRate: results.length > 0 ? okResults.length / results.length : 0,
    avgOutputLength:
      okResults.length > 0
        ? Math.round(okResults.reduce((sum, result) => sum + result.output.length, 0) / okResults.length)
        : 0,
    avgLatencyMs:
      okResults.length > 0
        ? Math.round(okResults.reduce((sum, result) => sum + result.latencyMs, 0) / okResults.length)
        : 0,
    totalTokens,
  }
}

/** 从模板一键生成 API 调用代码（Python/Node.js/curl）。 */
function buildApiCallCode(language: 'python' | 'nodejs' | 'curl', model: string, prompt: string): string {
  const escaped = JSON.stringify(prompt)
  if (language === 'python') {
    return `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ.get("DEEPSEEK_API_KEY"),
    base_url="https://api.deepseek.com",
)

response = client.chat.completions.create(
    model=${JSON.stringify(model)},
    messages=[{"role": "user", "content": ${escaped}}],
    stream=False,
)
print(response.choices[0].message.content)`
  }
  if (language === 'nodejs') {
    return `const response = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: \`Bearer \${process.env.DEEPSEEK_API_KEY}\`,
  },
  body: JSON.stringify({
    model: ${JSON.stringify(model)},
    messages: [{ role: 'user', content: ${escaped} }],
    stream: false,
  }),
})
const data = await response.json()
console.log(data.choices[0].message.content)`
  }
  return `curl https://api.deepseek.com/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \\
  -d '{
    "model": ${JSON.stringify(model)},
    "messages": [{"role": "user", "content": ${escaped}}],
    "stream": false
  }'`
}

// --------------------------------------------------------------------
// 请求体收窄辅助
// --------------------------------------------------------------------

/** 将请求体收窄为 JSON 对象。 */
function readObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('请求体必须是 JSON 对象', 400)
  }
  return body as Record<string, unknown>
}

/** 读取必填非空字符串字段。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(`${field} 必须是非空字符串`, 400)
  }
  return value.trim()
}

/** 读取必填正整数字段。 */
function requireInt(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(`${field} 必须是正整数`, 400)
  }
  return n
}

/** 解析字符串数组（缺省返回空数组）。 */
function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(`${field} 必须是字符串数组`, 400)
  const result: string[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string') throw new HttpError(`${field} 必须全部为字符串`, 400)
    result.push(item)
  }
  return result
}

/** 解析变量表（字符串 → 字符串）。 */
function parseVariables(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError('variables 必须是“变量名 → 值”的对象', 400)
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new HttpError(`variables.${key} 必须是字符串`, 400)
    result[key] = item
  }
  return result
}
