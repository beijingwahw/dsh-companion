/**
 * CompanionCore：插件根服务（服务名 `companion`）。
 *
 * 职责：
 * - 打开 companion 存储域（所有用户数据的唯一落盘位置，Harness 沙箱内）；
 * - 持有加密保险库（API Key）、用量账本、动态计价引擎、私有 HTTP 路由器；
 * - 提供直连 DeepSeek API 的基础调用（含记账与 companion/usage 事件）；
 *   策略层（路由/调度/预算）由成本模块的 companionCost 服务包装。
 */
import { Service } from '@deepseek-ai/cordis';
import { defineDomain, wrapFacility } from './storage-adapter.js';
import { chatCompletion, DeepSeekApiError, } from './deepseek.js';
import { createRouter } from './http.js';
import { CredentialRef } from './ids.js';
import { round4, tokenUsageToUsageLike } from './pricing.js';
import { OFFICIAL_PRICING_URL, PriceService } from './price/service.js';
import { UsageStore } from './usage.js';
import { SecretVault } from './vault.js';
/** 存储域：所有表（vault/usage-daily/templates/tags）都在此域内。 */
export const COMPANION_DOMAIN = defineDomain({
    name: 'companion',
    version: 1,
    description: 'DeepSeek Companion 插件本地数据（设置以外的用户数据）',
});
/** 保险库中 API Key 的秘密名。 */
export const API_KEY_SECRET = 'deepseek-api-key';
/** credentials seam 中的 API Key 引用（环境变量名约定）。 */
export const API_KEY_CREDENTIAL_REF = CredentialRef('DEEPSEEK_API_KEY');
export class CompanionCoreService extends Service {
    ctx;
    config;
    /** 依赖服务：HTTP 路由宿主、存储域设施、凭据解析。 */
    static inject = ['webServer', 'storageDomain', 'credentials'];
    http = createRouter('/companion');
    prices;
    /** 内部存储域初始化 promise；失败后被重置，下次访问 ready 时重试 open。 */
    readyPromise;
    /** 经适配层包装的存储设施（懒初始化）。 */
    storageFacility;
    /** API 调用钩子集合（安全模块注入）。 */
    callHooks = new Set();
    constructor(ctx, config) {
        super(ctx, 'companion');
        this.ctx = ctx;
        this.config = config;
        // 动态计价引擎：官方定价页抓取失败静降级（保留上一份有效表），
        // 仅官方价格真实变更时经 info → notice 提示用户；warn 不打扰 UI。
        const log = {
            info: (...args) => this.notice('info', args.map(String).join(' ')),
            warn: () => undefined,
            error: (...args) => this.notice('warning', args.map(String).join(' ')),
        };
        this.prices = new PriceService(OFFICIAL_PRICING_URL, config.pricingTimeoutMs, log);
        // 私有 HTTP 前缀路由：各模块经 ctx.companion.http 挂载端点。
        ctx.effect(() => {
            const dispose = ctx.webServer.register({
                kind: 'prefix',
                path: '/companion',
                handler: (req, res) => this.http.handle(req, res),
            });
            return dispose;
        }, 'companion.http-route');
        // 构造时即启动初始化（ensureReady 内部已挂兜底 catch，无未处理 rejection）。
        void this.ensureReady();
    }
    /** 存储域就绪 Promise（open 失败后下次访问会重新 open）。 */
    get ready() {
        return this.ensureReady();
    }
    /** 懒性创建（或复用）存储域初始化 promise，并为其挂兜底 catch。 */
    ensureReady() {
        if (!this.readyPromise) {
            this.storageFacility ??= wrapFacility(this.ctx.storageDomain);
            const promise = this.storageFacility.open(COMPANION_DOMAIN).then((domain) => ({
                domain,
                vault: new SecretVault(domain),
                usage: new UsageStore(domain),
            }));
            // 兜底 catch：记录错误并重置内部 promise，使失败后可重新初始化。
            promise.catch((error) => {
                if (this.readyPromise === promise)
                    this.readyPromise = undefined;
                try {
                    this.notice('error', `companion 存储域初始化失败：${error instanceof Error ? error.message : String(error)}`);
                }
                catch {
                    // notice 自身失败时静默，避免产生新的未处理 rejection。
                }
            });
            this.readyPromise = promise;
        }
        return this.readyPromise;
    }
    async getApiKey() {
        const { vault } = await this.ready;
        const stored = await vault.getSecret(API_KEY_SECRET);
        if (stored)
            return stored;
        try {
            const resolved = await this.ctx.credentials.resolve(API_KEY_CREDENTIAL_REF);
            return resolved?.value;
        }
        catch {
            return undefined;
        }
    }
    async setApiKey(value) {
        const trimmed = value.trim();
        if (!trimmed)
            throw new DeepSeekApiError('API Key 不能为空', 'NO_API_KEY');
        const { vault } = await this.ready;
        await vault.setSecret(API_KEY_SECRET, trimmed);
    }
    async clearApiKey() {
        const { vault } = await this.ready;
        await vault.deleteSecret(API_KEY_SECRET);
    }
    async callDeepSeek(params) {
        // 前置钩子（DLP 拦截 / Key 权限校验）：任一抛错即中止调用。
        for (const hook of this.callHooks) {
            await hook.beforeCall?.(params);
        }
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new DeepSeekApiError('尚未配置 DeepSeek API Key：请在设置 → 开发者模式中填写，或配置凭据 DEEPSEEK_API_KEY', 'NO_API_KEY');
        }
        const requestedModel = params.model ?? 'deepseek-chat';
        let result;
        try {
            result = await chatCompletion({
                baseUrl: this.config.apiBaseUrl,
                apiKey,
                timeoutMs: this.config.apiTimeoutMs,
                model: requestedModel,
                messages: params.messages,
                temperature: params.temperature,
                maxTokens: params.maxTokens,
                jsonMode: params.jsonMode,
                signal: params.signal,
            });
        }
        catch (error) {
            // 失败路径同样通知后置钩子（审计需要记录失败调用）。
            this.runAfterCallHooks(params, undefined, error instanceof Error ? error : new Error(String(error)), 0);
            throw error;
        }
        const model = result.model || requestedModel;
        // 记账与事件发射是 best-effort：失败降级为 warning 提示，不影响调用结果的返回。
        // usage.record 与事件复用同一个 ts，保证两侧时间一致；
        // 费用经动态计价引擎按调用时刻解析（峰谷分时感知）。
        const ts = Date.now();
        const costCny = round4(this.prices.costOfCall(model, tokenUsageToUsageLike(result.usage), ts));
        try {
            const { usage } = await this.ready;
            await usage.record({
                ts,
                model,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                cacheHitTokens: Math.min(result.usage.promptCacheHitTokens, result.usage.promptTokens),
                costCny,
            });
            this.ctx.emit('companion/usage', {
                ts,
                model,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                costCny,
                source: params.source,
            });
        }
        catch (error) {
            this.notice('warning', `用量记账失败（本次调用结果不受影响）：${error instanceof Error ? error.message : String(error)}`);
        }
        this.runAfterCallHooks(params, result, undefined, costCny);
        return result;
    }
    setPricingOverrides(table) {
        this.prices.setOverrides(table);
    }
    notice(kind, message) {
        this.ctx.emit('companion/notice', { kind, message });
    }
    addCallHook(hook) {
        this.callHooks.add(hook);
        return () => {
            this.callHooks.delete(hook);
        };
    }
    /** 后置钩子统一出口：单个钩子抛错不影响其余钩子与调用结果。 */
    runAfterCallHooks(params, result, error, costCny) {
        for (const hook of this.callHooks) {
            try {
                hook.afterCall?.(params, result, error, costCny);
            }
            catch {
                // 审计钩子失败静默，不影响主流程。
            }
        }
    }
}
