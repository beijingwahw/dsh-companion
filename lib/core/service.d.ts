/**
 * CompanionCore：插件根服务（服务名 `companion`）。
 *
 * 职责：
 * - 打开 companion 存储域（所有用户数据的唯一落盘位置，Harness 沙箱内）；
 * - 持有加密保险库（API Key）、用量账本、动态计价引擎、私有 HTTP 路由器；
 * - 提供直连 DeepSeek API 的基础调用（含记账与 companion/usage 事件）；
 *   策略层（路由/调度/预算）由成本模块的 companionCost 服务包装。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type Domain } from './storage-adapter.js';
import type { Config } from '../config.js';
import { type ChatMessage, type ChatResult } from './deepseek.js';
import { type CompanionRouter } from './http.js';
import { PriceService } from './price/service.js';
import type { PriceTable } from './price/types.js';
import { UsageStore } from './usage.js';
import { SecretVault } from './vault.js';
/** 存储域：所有表（vault/usage-daily/templates/tags）都在此域内。 */
export declare const COMPANION_DOMAIN: import("./storage-adapter.js").DomainSpec;
/** 保险库中 API Key 的秘密名。 */
export declare const API_KEY_SECRET = "deepseek-api-key";
/** credentials seam 中的 API Key 引用（环境变量名约定）。 */
export declare const API_KEY_CREDENTIAL_REF: import("../types/harness.js").CredentialRef;
/** 存储域初始化结果。 */
export interface CompanionStore {
    domain: Domain;
    vault: SecretVault;
    usage: UsageStore;
}
export interface CallParams {
    messages: readonly ChatMessage[];
    /** 缺省 deepseek-chat。 */
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** 开启 JSON 输出模式（response_format: json_object）。 */
    jsonMode?: boolean;
    signal?: AbortSignal;
    /** 调用方标识（如 handoff / cost-report），用于记账聚合。 */
    source: string;
}
/**
 * API 调用钩子（安全模块 J 的集成点）：
 * - beforeCall 抛错即拦截本次调用（如 DLP 严格模式、Key 权限范围越界）；
 * - afterCall 在调用结束后（无论成败）best-effort 执行，用于审计记录。
 */
export interface CallHook {
    beforeCall?(params: CallParams): void | Promise<void>;
    afterCall?(params: CallParams, result: ChatResult | undefined, error: Error | undefined, costCny: number): void;
}
/** ctx.companion 服务契约。 */
export interface CompanionCore {
    readonly config: Config;
    readonly http: CompanionRouter;
    /** 存储域就绪 Promise（open 是异步的）。 */
    readonly ready: Promise<CompanionStore>;
    /** 解析 API Key：保险库优先，其次 credentials seam。 */
    getApiKey(): Promise<string | undefined>;
    /** 加密保存 API Key。 */
    setApiKey(value: string): Promise<void>;
    /** 删除已保存的 API Key。 */
    clearApiKey(): Promise<void>;
    /** 直连 DeepSeek API（含记账）。 */
    callDeepSeek(params: CallParams): Promise<ChatResult>;
    /**
     * 动态计价引擎（移植自 dsh-usage-ledger）：官方定价页实时抓取 +
     * 峰谷分时 + 多厂商目录。费用估算一律经此解析单价。
     */
    readonly prices: PriceService;
    /** 覆盖用户自定义单价（模型 id → 单价，最长前缀匹配）。 */
    setPricingOverrides(table: PriceTable): void;
    /** 发出 companion/notice（UI 层呈现为 Toast）。 */
    notice(kind: 'info' | 'success' | 'warning' | 'error', message: string): void;
    /** 注册 API 调用钩子（DLP 拦截 + 审计采集）；返回注销 disposer。 */
    addCallHook(hook: CallHook): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        companion: CompanionCore;
    }
}
export declare class CompanionCoreService extends Service implements CompanionCore {
    readonly ctx: Context;
    readonly config: Config;
    /** 依赖服务：HTTP 路由宿主、存储域设施、凭据解析。 */
    static inject: string[];
    readonly http: CompanionRouter;
    readonly prices: PriceService;
    /** 内部存储域初始化 promise；失败后被重置，下次访问 ready 时重试 open。 */
    private readyPromise?;
    /** 经适配层包装的存储设施（懒初始化）。 */
    private storageFacility?;
    /** API 调用钩子集合（安全模块注入）。 */
    private readonly callHooks;
    constructor(ctx: Context, config: Config);
    /** 存储域就绪 Promise（open 失败后下次访问会重新 open）。 */
    get ready(): Promise<CompanionStore>;
    /** 懒性创建（或复用）存储域初始化 promise，并为其挂兜底 catch。 */
    private ensureReady;
    getApiKey(): Promise<string | undefined>;
    setApiKey(value: string): Promise<void>;
    clearApiKey(): Promise<void>;
    callDeepSeek(params: CallParams): Promise<ChatResult>;
    setPricingOverrides(table: PriceTable): void;
    notice(kind: 'info' | 'success' | 'warning' | 'error', message: string): void;
    addCallHook(hook: CallHook): () => void;
    /** 后置钩子统一出口：单个钩子抛错不影响其余钩子与调用结果。 */
    private runAfterCallHooks;
}
