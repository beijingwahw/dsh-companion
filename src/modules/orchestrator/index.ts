/**
 * 模块 H：断点续跑与任务编排（orchestrator）插件入口。
 *
 * HTTP 端点（经 ctx.companion.http 挂载）：
 * H1 流水线：GET/POST /orchestrator/pipelines、DELETE /orchestrator/pipelines、
 *    GET /orchestrator/pipelines/yaml（自动生成 YAML 配置）；
 * H2 执行与断点续跑：POST /orchestrator/runs（启动）、POST /orchestrator/runs/resume
 *    （从最后成功步骤继续）、POST /orchestrator/runs/pause、/cancel、
 *    GET /orchestrator/runs、GET /orchestrator/runs/get、DELETE /orchestrator/runs；
 * H3 批量队列：GET/POST /orchestrator/queue、POST /orchestrator/queue/cancel、
 *    /pause、/resume、DELETE /orchestrator/queue、GET /orchestrator/queue/counts；
 * H4 定时调度：GET/POST /orchestrator/jobs、DELETE /orchestrator/jobs、
 *    GET /orchestrator/jobs/runs、POST /orchestrator/parse-schedule（自然语言 → Cron）。
 *
 * 命令 `tasks`：查看队列与定时任务概览。
 */
import type { Context } from '@deepseek-ai/cordis'
import { HttpError, sendJson } from '../../core/http.js'
import type { CommandInvocation, CommandResult } from '../../types/harness.js'
import { naturalLanguageToCron, nextCronFire, parseCron } from './cron.js'
import { CronTicker, PipelineEngine, QueueWorker, pipelineToYaml, shortId, validatePipeline } from './engine.js'
import { PipelineRunStore, PipelineStore, QueueTaskStore, ScheduledJobStore, ScheduledRunStore } from './store.js'
import type { Pipeline, PipelineStep, QueueTask } from './types.js'

/** 插件名。 */
export const name = 'companion-orchestrator'

/** 依赖服务：companion 根服务、命令面板。 */
export const inject = ['companion', 'commands']

/** 单条流水线步骤数上限。 */
const MAX_PIPELINE_STEPS = 20

/** 批量队列任务数上限。 */
const MAX_QUEUE_TASKS = 50

/** 定时任务数上限。 */
const MAX_JOBS = 20

/** 插件入口。 */
export function apply(ctx: Context): void {
  void (async () => {
    const store = await ctx.companion.ready.catch(() => undefined)
    if (!store) return
    const pipelines = new PipelineStore(store.domain)
    const runs = new PipelineRunStore(store.domain)
    const tasks = new QueueTaskStore(store.domain)
    const jobs = new ScheduledJobStore(store.domain)
    const jobRuns = new ScheduledRunStore(store.domain)

    // 调用适配：经核心服务调用 DeepSeek（记账由核心服务完成）。
    const call = async (params: { prompt: string; model: string; timeoutMs: number; source: string }) => {
      const result = await ctx.companion.callDeepSeek({
        messages: [{ role: 'user', content: params.prompt }],
        model: params.model,
        source: params.source,
      })
      return {
        content: result.content,
        tokens: result.usage.promptTokens + result.usage.completionTokens,
      }
    }

    const engine = new PipelineEngine(ctx, runs, call, ctx.companion.config.apiTimeoutMs)
    const worker = new QueueWorker(ctx, tasks, call, ctx.companion.config.apiTimeoutMs)
    const ticker = new CronTicker(ctx, jobs, jobRuns, call, ctx.companion.config.apiTimeoutMs)

    try {
      ctx.effect(() => {
        worker.start()
        ticker.start()
        const disposers: Array<() => void> = [
          () => engine.dispose(),
          () => worker.dispose(),
          () => ticker.dispose(),

          // --------------------------------------------------------------
          // H1 流水线定义
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/orchestrator/pipelines', (_req, res) => {
            sendJson(res, 200, { pipelines: pipelines.list() })
          }),

          ctx.companion.http.add('POST', '/orchestrator/pipelines', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const steps = parseSteps(body.steps)
            const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : shortId('pipeline')
            const pipeline: Pipeline = {
              id,
              name,
              steps,
              createdAt: pipelines.get(id)?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
            }
            const problem = validatePipeline(pipeline)
            if (problem) throw new HttpError(problem, 400)
            await pipelines.put(pipeline)
            sendJson(res, 200, { pipeline })
          }),

          ctx.companion.http.add('DELETE', '/orchestrator/pipelines', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            await pipelines.delete(id)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('GET', '/orchestrator/pipelines/yaml', (_req, res, hctx) => {
            const id = requireQuery(hctx.query, 'id')
            const pipeline = pipelines.get(id)
            if (!pipeline) throw new HttpError(`流水线不存在：${id}`, 404)
            sendJson(res, 200, { id, yaml: pipelineToYaml(pipeline) })
          }),

          // --------------------------------------------------------------
          // H2 执行与断点续跑
          // --------------------------------------------------------------
          ctx.companion.http.add('POST', '/orchestrator/runs', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const pipelineId = requireString(body.pipelineId, 'pipelineId')
            const pipeline = pipelines.get(pipelineId)
            if (!pipeline) throw new HttpError(`流水线不存在：${pipelineId}`, 404)
            // 后台异步执行：立即返回 runId，进度经 /orchestrator/runs/get 轮询。
            const run = engine.start(pipeline)
            sendJson(res, 202, { runId: run.id, status: run.status })
          }),

          ctx.companion.http.add('POST', '/orchestrator/runs/resume', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const runId = requireString(body.runId, 'runId')
            const run = runs.get(runId)
            if (!run) throw new HttpError(`执行记录不存在：${runId}`, 404)
            if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'cancelled') {
              throw new HttpError('只有暂停/失败/已取消的执行可以恢复', 400)
            }
            const pipeline = pipelines.get(run.pipelineId)
            if (!pipeline) throw new HttpError('对应流水线已被删除', 404)
            const resumed = engine.start(pipeline, run)
            sendJson(res, 200, { runId: resumed.id, status: resumed.status })
          }),

          ctx.companion.http.add('POST', '/orchestrator/runs/pause', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const runId = requireString(body.runId, 'runId')
            if (!engine.requestPause(runId)) throw new HttpError('该执行不在运行中', 400)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/orchestrator/runs/cancel', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const runId = requireString(body.runId, 'runId')
            if (!engine.cancel(runId)) throw new HttpError('该执行不在运行中', 400)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('GET', '/orchestrator/runs', (_req, res, hctx) => {
            const pipelineId = hctx.query.get('pipelineId')
            const list = pipelineId ? runs.forPipeline(pipelineId) : runs.list()
            sendJson(
              res,
              200,
              {
                runs: list.slice(0, 50).map((run) => {
                  const steps = Object.values(run.steps)
                  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
                  return {
                    id: run.id,
                    pipelineId: run.pipelineId,
                    status: run.status,
                    startedAt: run.startedAt,
                    endedAt: run.endedAt,
                    message: run.message,
                    progress: { done, total: steps.length },
                  }
                }),
              },
            )
          }),

          ctx.companion.http.add('GET', '/orchestrator/runs/get', (_req, res, hctx) => {
            const id = requireQuery(hctx.query, 'id')
            const run = runs.get(id)
            if (!run) throw new HttpError(`执行记录不存在：${id}`, 404)
            sendJson(res, 200, { run })
          }),

          ctx.companion.http.add('DELETE', '/orchestrator/runs', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            await runs.delete(id)
            sendJson(res, 200, { ok: true })
          }),

          // --------------------------------------------------------------
          // H3 批量任务队列
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/orchestrator/queue', (_req, res) => {
            sendJson(res, 200, { tasks: tasks.list().slice(-MAX_QUEUE_TASKS), counts: tasks.counts() })
          }),

          ctx.companion.http.add('GET', '/orchestrator/queue/counts', (_req, res) => {
            sendJson(res, 200, { counts: tasks.counts() })
          }),

          ctx.companion.http.add('POST', '/orchestrator/queue', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const prompt = requireString(body.prompt, 'prompt')
            const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-chat'
            const priority = body.priority === 'high' || body.priority === 'low' ? body.priority : 'medium'
            const deadline = Number(body.deadline) || 0
            const failurePolicy =
              body.failurePolicy === 'retry' || body.failurePolicy === 'notify' ? body.failurePolicy : 'skip'
            if (tasks.list().filter((t) => t.status === 'queued' || t.status === 'running').length >= MAX_QUEUE_TASKS) {
              throw new HttpError(`队列中最多同时存在 ${MAX_QUEUE_TASKS} 个未完成任务`, 400)
            }
            const task: QueueTask = {
              id: shortId('task'),
              name,
              prompt,
              model,
              priority,
              deadline,
              failurePolicy,
              status: 'queued',
              createdAt: Date.now(),
              finishedAt: 0,
              output: '',
              error: '',
              attempts: 0,
            }
            await tasks.put(task)
            sendJson(res, 200, { task })
          }),

          ctx.companion.http.add('POST', '/orchestrator/queue/cancel', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const task = tasks.get(id)
            if (!task) throw new HttpError(`任务不存在：${id}`, 404)
            if (task.status === 'running') {
              worker.cancel(id)
            } else if (task.status === 'queued' || task.status === 'paused') {
              task.status = 'cancelled'
              task.finishedAt = Date.now()
              await tasks.put(task)
            } else {
              throw new HttpError('任务已结束，无法取消', 400)
            }
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/orchestrator/queue/pause', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const task = tasks.get(id)
            if (!task) throw new HttpError(`任务不存在：${id}`, 404)
            if (task.status !== 'queued') throw new HttpError('只有排队中的任务可以暂停', 400)
            task.status = 'paused'
            await tasks.put(task)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/orchestrator/queue/resume', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const task = tasks.get(id)
            if (!task) throw new HttpError(`任务不存在：${id}`, 404)
            if (task.status !== 'paused') throw new HttpError('只有已暂停的任务可以恢复', 400)
            task.status = 'queued'
            await tasks.put(task)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('POST', '/orchestrator/queue/batch', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const action = body.action
            if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
              throw new HttpError("action 必须是 'pause'、'resume' 或 'cancel'", 400)
            }
            let changed = 0
            for (const task of tasks.list()) {
              if (action === 'pause' && task.status === 'queued') {
                task.status = 'paused'
                await tasks.put(task)
                changed += 1
              } else if (action === 'resume' && task.status === 'paused') {
                task.status = 'queued'
                await tasks.put(task)
                changed += 1
              } else if (action === 'cancel' && (task.status === 'queued' || task.status === 'paused')) {
                task.status = 'cancelled'
                task.finishedAt = Date.now()
                await tasks.put(task)
                changed += 1
              }
            }
            sendJson(res, 200, { ok: true, changed })
          }),

          ctx.companion.http.add('DELETE', '/orchestrator/queue', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const task = tasks.get(id)
            if (!task) throw new HttpError(`任务不存在：${id}`, 404)
            if (task.status === 'running') throw new HttpError('运行中的任务请先取消', 400)
            await tasks.delete(id)
            sendJson(res, 200, { ok: true })
          }),

          // --------------------------------------------------------------
          // H4 定时任务调度
          // --------------------------------------------------------------
          ctx.companion.http.add('GET', '/orchestrator/jobs', (_req, res) => {
            sendJson(res, 200, { jobs: jobs.list() })
          }),

          ctx.companion.http.add('POST', '/orchestrator/parse-schedule', (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const text = requireString(body.text, 'text')
            try {
              const cron = naturalLanguageToCron(text)
              const parsed = parseCron(cron)
              sendJson(res, 200, { cron, nextRunAt: requireNextFire(parsed) })
            } catch (error) {
              throw new HttpError(error instanceof Error ? error.message : '无法解析定时表达式', 400)
            }
          }),

          ctx.companion.http.add('POST', '/orchestrator/jobs', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const name = requireString(body.name, 'name')
            const prompt = requireString(body.prompt, 'prompt')
            const scheduleText = requireString(body.schedule, 'schedule')
            const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-chat'
            const offPeakOnly = body.offPeakOnly === true
            if (jobs.list().length >= MAX_JOBS) {
              throw new HttpError(`最多创建 ${MAX_JOBS} 个定时任务`, 400)
            }
            let cron: string
            try {
              cron = naturalLanguageToCron(scheduleText)
            } catch (error) {
              throw new HttpError(error instanceof Error ? error.message : '无法解析定时表达式', 400)
            }
            const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : shortId('job')
            const existing = jobs.get(id)
            const job = {
              id,
              name,
              cron,
              scheduleText,
              prompt,
              model,
              offPeakOnly,
              enabled: body.enabled === false ? false : true,
              createdAt: existing?.createdAt ?? Date.now(),
              lastRunAt: existing?.lastRunAt ?? 0,
              nextRunAt: 0,
            }
            ticker.reschedule(job)
            await jobs.put(job)
            sendJson(res, 200, { job })
          }),

          ctx.companion.http.add('POST', '/orchestrator/jobs/toggle', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            const job = jobs.get(id)
            if (!job) throw new HttpError(`定时任务不存在：${id}`, 404)
            job.enabled = body.enabled === true
            ticker.reschedule(job)
            if (!job.enabled) job.nextRunAt = 0
            await jobs.put(job)
            sendJson(res, 200, { job })
          }),

          ctx.companion.http.add('DELETE', '/orchestrator/jobs', async (_req, res, hctx) => {
            const body = readObject(hctx.body)
            const id = requireString(body.id, 'id')
            await jobs.delete(id)
            sendJson(res, 200, { ok: true })
          }),

          ctx.companion.http.add('GET', '/orchestrator/jobs/runs', (_req, res, hctx) => {
            const jobId = requireQuery(hctx.query, 'jobId')
            sendJson(res, 200, { runs: jobRuns.forJob(jobId) })
          }),

          // --------------------------------------------------------------
          // 命令面板
          // --------------------------------------------------------------
          ctx.commands.register({
            name: 'tasks',
            description: '查看任务队列与定时任务概览',
            handler: async (_invocation: CommandInvocation): Promise<CommandResult> => {
              const counts = tasks.counts()
              const lines: string[] = [
                '任务队列：',
                `- 运行中 ${counts.running ?? 0} / 排队 ${counts.queued ?? 0} / 完成 ${counts.done ?? 0} / 失败 ${counts.failed ?? 0}`,
              ]
              const activeJobs = jobs.list().filter((job) => job.enabled)
              lines.push(`定时任务：${activeJobs.length} 个启用`)
              for (const job of activeJobs.slice(0, 5)) {
                lines.push(`  · ${job.name}（${job.scheduleText}）${job.offPeakOnly ? '【空闲时段执行】' : ''}`)
              }
              return { text: lines.join('\n') }
            },
          }),
        ]
        return () => {
          for (const dispose of [...disposers].reverse()) dispose()
        }
      }, 'companion-orchestrator.register')
    } catch {
      // 等待存储域期间插件已被卸载，放弃注册。
      engine.dispose()
      worker.dispose()
      ticker.dispose()
    }
  })()
}

/** 计算下次触发时刻（辅助 parse-schedule 端点）。 */
function requireNextFire(parsed: ReturnType<typeof parseCron>): number {
  return nextCronFire(parsed, Date.now()) ?? 0
}

/** 解析流水线步骤数组。 */
function parseSteps(raw: unknown): PipelineStep[] {
  if (!Array.isArray(raw)) throw new HttpError('steps 必须是数组', 400)
  if (raw.length === 0) throw new HttpError('steps 不能为空', 400)
  if (raw.length > MAX_PIPELINE_STEPS) {
    throw new HttpError(`步骤数不能超过 ${MAX_PIPELINE_STEPS}`, 400)
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new HttpError(`steps[${index}] 必须是对象`, 400)
    }
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) throw new HttpError(`steps[${index}].name 必须是非空字符串`, 400)
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `step-${index + 1}`
    const inputFrom = record.inputFrom === 'literal' ? 'literal' : 'prev'
    const dependsOn = Array.isArray(record.dependsOn)
      ? (record.dependsOn as unknown[]).map((dep) => {
          if (typeof dep !== 'string' || !dep.trim()) {
            throw new HttpError(`steps[${index}].dependsOn 必须全部为非空字符串`, 400)
          }
          return dep.trim()
        })
      : []
    return {
      id,
      name,
      model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : 'deepseek-chat',
      prompt: typeof record.prompt === 'string' ? record.prompt : '',
      inputFrom,
      input: typeof record.input === 'string' ? record.input : '',
      condition: typeof record.condition === 'string' ? record.condition : '',
      timeoutMs: Number(record.timeoutMs) > 0 ? Number(record.timeoutMs) : 0,
      maxRetries: Number.isInteger(Number(record.maxRetries)) && Number(record.maxRetries) > 0 ? Number(record.maxRetries) : 0,
      retryIntervalMs: Number(record.retryIntervalMs) > 0 ? Number(record.retryIntervalMs) : 2_000,
      dependsOn,
    } satisfies PipelineStep
  })
}

/** 读取必填查询参数。 */
function requireQuery(query: URLSearchParams, key: string): string {
  const value = query.get(key)
  if (!value || !value.trim()) throw new HttpError(`${key} 必填`, 400)
  return value.trim()
}

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
