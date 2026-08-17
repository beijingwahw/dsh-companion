/**
 * 成本网关服务（服务名 `companionCost`）：包装核心调用的策略层。
 *
 * 开发者模式开启时依次执行：
 * 预算闸门（budget.check）→ 模型路由（modelRouting）→ 峰谷调度
 * （peakScheduling 且 priority='normal' → scheduler.enqueue；
 * 是否真实延迟以调度器返回值为准，网关不自行预判峰谷）
 * → ctx.companion.callDeepSeek(model)（记账与事件由核心服务完成）
 * → 节省额结算：仅当优化真实发生时计入 savedCny——
 *   modelRouting 开启且实际模型确比 complexModel 便宜时基线才取 complexModel，
 *   否则基线=实际模型（节省为 0）；deferredCalls 以调度器真实延迟为准。
 *   结算失败不反转已成功的调用结果：内部捕获并降级为 warning 通知。
 * 延迟队列在 drain 执行每个任务前经网关注入的预算复检回调复查闸门，
 * 暂停期间排队任务以预算不足错误被 reject，队列不构成闸门旁路。
 * 开发者模式关闭时直通核心服务。
 *
 * 跨模块协作（如 handoff 生成摘要）经 ctx.get('companionCost') 使用本服务，
 * 不直接 import 本文件（DESIGN.md 第 1 节）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ChatMessage, ChatResult } from '../../core/deepseek.js';
import { type BudgetSnapshot } from './budget.js';
import { type QueuedTaskInfo } from './scheduler.js';
import type { CostSettings } from './settings.js';
/** 经成本网关发起的一次调用参数。 */
export interface CostCallParams {
    /** 模型可见消息。 */
    messages: readonly ChatMessage[];
    /** 任务提示词（供模型路由判断难易）。 */
    taskHint?: string;
    /** 优先级；'high' 不参与峰谷延迟。缺省 'normal'。 */
    priority?: 'normal' | 'high';
    /** 必要调用：预算用尽时仍放行。缺省 false。 */
    essential?: boolean;
    /** 调用方标识（记账聚合）。 */
    source: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
}
/** ctx.companionCost 服务契约。 */
export interface CostGateway {
    /** 经策略层发起一次 DeepSeek 调用。 */
    call(params: CostCallParams): Promise<ChatResult>;
    /** 当前预算状态快照。 */
    budgetState(): Promise<BudgetSnapshot>;
    /** 峰谷调度等待队列快照。 */
    queueSnapshot(): readonly QueuedTaskInfo[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        companionCost: CostGateway;
    }
}
/** 成本网关服务实现（经 ctx.plugin 挂载；服务名 companionCost）。 */
export declare class CostGatewayService extends Service implements CostGateway {
    readonly ctx: Context;
    private readonly router;
    private readonly scheduler;
    private readonly getSettings;
    /** 预算守卫：存储域就绪后懒性创建；创建失败后重置，下次访问重试。 */
    private budgetGuardInstance;
    private budgetGuardPromise;
    /**
     * @param ctx 插件上下文。
     * @param getSettings 实时读取成本设置（settings scope 的 getter 闭包）。
     */
    constructor(ctx: Context, getSettings: () => CostSettings);
    call(params: CostCallParams): Promise<ChatResult>;
    budgetState(): Promise<BudgetSnapshot>;
    queueSnapshot(): readonly QueuedTaskInfo[];
    /**
     * 预算守卫就绪 Promise（懒性）：存储域就绪后创建；
     * 创建失败时挂兜底 catch 避免未处理 rejection，并重置内部 promise，
     * 使存储域恢复后的下次访问得以重试（与核心服务 ensureReady 同构）。
     */
    private budgetReady;
    /**
     * 节省额结算：仅当优化真实发生时计入 savedCny——
     * modelRouting 开启且实际模型确比 complexModel 便宜时基线才取 complexModel，
     * 否则基线=实际模型（节省为 0）；
     * 节省>0 或真实发生延迟时，经存储域 usage-daily 表的原子 update
     * 并入当日 savedCny/deferredCalls 字段。
     * 单价经动态计价引擎按结算时刻解析（峰谷分时感知，与实际记账同源）。
     */
    private recordSavings;
}
