/**
 * 模块 H：断点续跑与任务编排 —— 存储。
 *
 * 全部落在 companion 域：
 * - 'pipelines'：流水线定义（H1）；
 * - 'pipeline-runs'：执行记录，含每步中间结果（H2 断点续跑）；
 * - 'queue-tasks'：批量队列任务（H3）；
 * - 'scheduled-jobs' / 'scheduled-runs'：定时任务与归档（H4）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'
import type {
  Pipeline,
  PipelineRun,
  QueueTask,
  ScheduledJob,
  ScheduledRun,
} from './types.js'

/** 流水线定义仓库。 */
export class PipelineStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<Pipeline>('pipelines')
  }

  list(): Pipeline[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Pipeline | undefined {
    return this.table.get(id)
  }

  async put(pipeline: Pipeline): Promise<void> {
    await this.table.put(pipeline.id, pipeline)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** 流水线执行仓库（H2：中间结果持久化，断点恢复的数据基础）。 */
export class PipelineRunStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<PipelineRun>('pipeline-runs')
  }

  list(): PipelineRun[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** 某流水线的执行记录（新→旧）。 */
  forPipeline(pipelineId: string): PipelineRun[] {
    return this.list().filter((run) => run.pipelineId === pipelineId)
  }

  get(id: string): PipelineRun | undefined {
    return this.table.get(id)
  }

  async put(run: PipelineRun): Promise<void> {
    await this.table.put(run.id, run)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** 批量队列任务仓库（H3）。 */
export class QueueTaskStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<QueueTask>('queue-tasks')
  }

  list(): QueueTask[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): QueueTask | undefined {
    return this.table.get(id)
  }

  async put(task: QueueTask): Promise<void> {
    await this.table.put(task.id, task)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }

  /** 队列统计：各状态数量。 */
  counts(): Record<string, number> {
    const result: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, paused: 0 }
    for (const task of this.list()) {
      result[task.status] = (result[task.status] ?? 0) + 1
    }
    return result
  }
}

/** 定时任务仓库（H4）。 */
export class ScheduledJobStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ScheduledJob>('scheduled-jobs')
  }

  list(): ScheduledJob[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ScheduledJob | undefined {
    return this.table.get(id)
  }

  async put(job: ScheduledJob): Promise<void> {
    await this.table.put(job.id, job)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}

/** 定时执行归档仓库（H4）。 */
export class ScheduledRunStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<ScheduledRun>('scheduled-runs')
  }

  /** 某任务的执行记录（新→旧），最多保留 limit 条。 */
  forJob(jobId: string, limit: number = 50): ScheduledRun[] {
    return this.table
      .entries()
      .map(([, value]) => value)
      .filter((run) => run.jobId === jobId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
  }

  async put(run: ScheduledRun): Promise<void> {
    await this.table.put(run.id, run)
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id)
  }
}
