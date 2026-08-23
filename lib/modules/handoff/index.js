import { HttpError, sendJson } from '../../core/http.js';
import { SessionId } from '../../core/ids.js';
import { formatTranscript, transcriptFromLog } from '../../core/transcript.js';
import { ArmedStore } from './armed.js';
import { buildHandoffPrompt, buildHandoffPromptWithTemplate } from './prompt.js';
import { TemplateStore } from './templates.js';
/** 插件名（Cordis fiber 诊断名）。 */
export const name = 'companion-handoff';
/** 依赖声明：核心服务 + 会话查询 + 命令面板 + 系统提示词装配。 */
export const inject = ['companion', 'sessionQuery', 'commands', 'systemPrompt'];
/** 对话转录字符预算：防止超长会话产生超长 prompt。 */
const TRANSCRIPT_CHAR_BUDGET = 60_000;
/** 转录截断时插入的中段提示行。 */
const TRANSCRIPT_TRUNCATION_NOTICE = '\n\n【对话内容过长，已截断中间部分，仅保留首尾】\n\n';
/** pending 武装有效期（毫秒）：超时未投递自动作废，防僵尸注入。 */
const ARMED_TTL_MS = 24 * 3600_000;
/** 插件入口。 */
export function apply(ctx) {
    // 存储域异步打开：就绪后创建两个存储实例。armed 另持同步引用，
    // 因为系统提示词装配回调是同步的，无法 await。
    let armed;
    const storesReady = ctx.companion.ready.then(({ domain }) => {
        const stores = {
            templates: new TemplateStore(domain),
            armed: new ArmedStore(domain),
        };
        armed = stores.armed;
        return stores;
    });
    // 兜底 catch：存储域失败且尚无请求 await 时避免未处理 rejection
    // （对齐 search 模块写法；各端点 await 时仍会正常得到错误响应）。
    storesReady.catch(() => undefined);
    // ------------------------------------------------------------------
    // 系统提示词上下文：注入已武装的交接摘要
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.systemPrompt.context({
        name: 'companion-handoff-summary',
        order: -80,
        text: (assembly) => {
            const store = armed;
            if (!store)
                return '';
            // 特定会话武装：装配作用域与武装会话 ID 相等时注入。
            const scopeText = String(assembly.scope);
            for (const entry of store.list()) {
                if (entry.sessionId !== null && scopeText === entry.sessionId) {
                    return renderHandoffSection(entry.summary);
                }
            }
            // pending 武装只投递给有具体会话作用域的装配：
            // 无作用域的全局/默认装配不消费摘要（防止误耗）。
            if (assembly.scope === undefined || assembly.scope === null)
                return '';
            const pending = store.peekPending();
            if (!pending)
                return '';
            // 世代门闩——过期自清：超时未投递自动作废，防僵尸注入。
            if (pending.expiresAt !== undefined && Date.now() > pending.expiresAt) {
                queueMicrotask(() => {
                    void store.expirePending().catch(() => undefined);
                });
                return '';
            }
            // 世代门闩——快照判定：武装时刻已存在的会话（快照内）不投递，
            // 旧会话无论怎么重建都免疫；旧格式记录（无快照）回退
            // v0.1 近似：注入下一次系统提示词装配。
            if (pending.knownSessions !== undefined && pending.knownSessions.includes(scopeText)) {
                return '';
            }
            // 原子消费（保留既有并发正确性）+ 投递回执（dock 可观测）。
            queueMicrotask(() => {
                // 消费失败静默降级（摘要至多重复注入一次），避免未处理 rejection。
                void store
                    .consumePending()
                    .then((summary) => {
                    if (summary !== undefined) {
                        void store.writeReceipt(scopeText).catch(() => undefined);
                    }
                })
                    .catch(() => undefined);
            });
            return renderHandoffSection(pending.summary);
        },
    }), 'companion.handoff-prompt-context');
    // ------------------------------------------------------------------
    // 模块内服务函数（HTTP 端点与命令共用）
    // ------------------------------------------------------------------
    /**
     * 生成指定会话的交接摘要：读会话 → 转录（按字符预算截断）→ 提示词 → 模型调用。
     * @param templateName 可选模板名：存在时以该模板内容作为摘要指令文本，
     * 未指定或模板不存在时回退固定契约 Prompt。
     */
    async function generate(sessionId, templateName) {
        let snapshot;
        try {
            snapshot = await ctx.sessionQuery.readSession(sessionId);
        }
        catch (error) {
            throw new HttpError(`读取会话失败：${error instanceof Error ? error.message : String(error)}`, 404);
        }
        // 按字符预算截断转录，防止超长 prompt。
        const conversation = truncateTranscript(formatTranscript(transcriptFromLog(snapshot), { timestamps: false }));
        if (!conversation.trim()) {
            throw new HttpError('会话中没有可摘要的对话内容', 400);
        }
        // 模板打通：指定模板名且模板存在时以其内容作为指令文本；否则回退固定契约 Prompt。
        let templateContent;
        if (templateName !== undefined) {
            const stores = await storesReady;
            templateContent = stores.templates.get(templateName);
        }
        const promptText = templateContent !== undefined
            ? buildHandoffPromptWithTemplate(templateContent, conversation)
            : buildHandoffPrompt(conversation);
        const messages = [{ role: 'user', content: promptText }];
        // 成本模块在位时经 companionCost 策略层调用（taskHint 供模型路由判断）；
        // handoff 是交互式操作：priority 'high' 不参与峰谷延迟；
        // 否则直连核心服务（固定 deepseek-chat）。
        const costGateway = ctx.get('companionCost');
        if (costGateway) {
            const result = await costGateway.call({
                messages,
                taskHint: '摘要',
                source: 'handoff',
                priority: 'high',
            });
            return { summary: result.content.trim(), model: result.model || 'deepseek-chat' };
        }
        const result = await ctx.companion.callDeepSeek({
            messages,
            model: 'deepseek-chat',
            source: 'handoff',
        });
        return { summary: result.content.trim(), model: result.model || 'deepseek-chat' };
    }
    /**
     * 武装摘要给下一个新对话（pending）：世代门闩——武装时刻快照全部
     * 已知会话 ID，装配回调只向「快照之外」的会话投递（详见 armed.ts 头注释）。
     * 快照失败（会话引擎异常）时退化为无快照记录（v0.1 近似），不阻塞武装。
     */
    async function armPending(summary) {
        const stores = await storesReady;
        let knownSessions;
        try {
            const sessions = await ctx.sessionQuery.listSessions();
            knownSessions = sessions.map((session) => String(session.id));
        }
        catch {
            knownSessions = undefined;
        }
        await stores.armed.arm(null, summary, { knownSessions, ttlMs: ARMED_TTL_MS });
    }
    // ------------------------------------------------------------------
    // HTTP 端点（经 ctx.companion.http 挂载；注册即 effect）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.companion.http.add('POST', '/handoff/generate', async (_req, res, { body }) => {
        const record = readObject(body);
        const sessionId = SessionId(requireString(record.sessionId, 'sessionId'));
        // 可选 template 字段：模板名；未指定或模板不存在时回退固定契约 Prompt。
        const templateName = optionalString(record.template, 'template');
        sendJson(res, 200, await generate(sessionId, templateName));
    }), 'companion.handoff-http-generate');
    ctx.effect(() => ctx.companion.http.add('GET', '/handoff/templates', async (_req, res) => {
        const stores = await storesReady;
        sendJson(res, 200, { templates: stores.templates.list() });
    }), 'companion.handoff-http-templates-list');
    ctx.effect(() => ctx.companion.http.add('POST', '/handoff/templates', async (_req, res, { body }) => {
        const record = readObject(body);
        const templateName = requireString(record.name, 'name');
        if (typeof record.content !== 'string' || record.content.length === 0) {
            throw new HttpError('content 必须是非空字符串', 400);
        }
        const stores = await storesReady;
        await stores.templates.save(templateName, record.content);
        sendJson(res, 200, { ok: true });
    }), 'companion.handoff-http-templates-save');
    ctx.effect(() => ctx.companion.http.add('DELETE', '/handoff/templates', async (_req, res, { body }) => {
        const record = readObject(body);
        const templateName = requireString(record.name, 'name');
        const stores = await storesReady;
        await stores.templates.remove(templateName);
        sendJson(res, 200, { ok: true });
    }), 'companion.handoff-http-templates-remove');
    ctx.effect(() => ctx.companion.http.add('POST', '/handoff/import', async (_req, res, { body }) => {
        const record = readObject(body);
        const summary = requireString(record.summary, 'summary');
        const sessionId = optionalString(record.sessionId, 'sessionId');
        // 无 sessionId = 武装给“下一个新对话”（pending，世代门闩）。
        if (sessionId === undefined) {
            await armPending(summary);
        }
        else {
            const stores = await storesReady;
            await stores.armed.arm(sessionId, summary);
        }
        sendJson(res, 200, { ok: true, sessionId: sessionId ?? null });
    }), 'companion.handoff-http-import');
    ctx.effect(() => ctx.companion.http.add('GET', '/handoff/armed', async (_req, res) => {
        const stores = await storesReady;
        // receipts：pending 摘要的投递回执（dock 展示「已注入会话 X」）。
        sendJson(res, 200, {
            armed: stores.armed.list(),
            receipts: stores.armed.listReceipts(),
        });
    }), 'companion.handoff-http-armed-list');
    ctx.effect(() => ctx.companion.http.add('DELETE', '/handoff/armed', async (_req, res, { body }) => {
        const record = readObject(body);
        const sessionId = optionalString(record.sessionId, 'sessionId');
        const stores = await storesReady;
        // 缺省 sessionId = 解除 pending 武装（与 import 的缺省语义对称）。
        await stores.armed.disarm(sessionId ?? null);
        sendJson(res, 200, { ok: true });
    }), 'companion.handoff-http-armed-disarm');
    // ------------------------------------------------------------------
    // 命令面板（与 HTTP 端点复用 generate / armed 服务函数）
    // ------------------------------------------------------------------
    ctx.effect(() => ctx.commands.register({
        name: 'handoff',
        description: '生成当前（或指定）会话的交接摘要',
        input: { hint: '会话 ID（缺省使用当前会话）' },
        handler: async (invocation) => {
            const target = invocation.rawInput.trim() || invocation.agent.id;
            if (!target) {
                return { kind: 'error', text: '未指定会话：请提供会话 ID 或在会话内调用' };
            }
            try {
                const result = await generate(SessionId(target));
                return { kind: 'success', text: result.summary };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    }), 'companion.handoff-command');
    ctx.effect(() => ctx.commands.register({
        name: 'handoff-import',
        description: '导入交接摘要（输入为摘要全文），武装给下一个新对话',
        input: { hint: '交接摘要全文' },
        handler: async (invocation) => {
            const summary = invocation.rawInput.trim();
            if (!summary) {
                return { kind: 'error', text: '请提供交接摘要全文作为命令输入' };
            }
            try {
                await armPending(summary);
                return { kind: 'success', text: '交接摘要已武装：将注入下一个新对话的系统提示词（24 小时内有效）。' };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    }), 'companion.handoff-import-command');
}
// --------------------------------------------------------------------
// 请求体收窄辅助（unknown → 具体形状；strict 下不用 any）
// --------------------------------------------------------------------
/** 将请求体收窄为 JSON 对象，否则 400。 */
function readObject(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象', 400);
    }
    return body;
}
/** 读取必填非空字符串字段（自动去除首尾空白）。 */
function requireString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(`${field} 必须是非空字符串`, 400);
    }
    return value.trim();
}
/** 读取可选字符串字段；null/undefined/空白串返回 undefined。 */
function optionalString(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new HttpError(`${field} 必须是字符串`, 400);
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
/** 将摘要渲染为注入系统提示词的段落。 */
function renderHandoffSection(summary) {
    return [
        '【上下文交接摘要】',
        '以下是此前对话留下的交接摘要，请在此基础上继续当前工作：',
        '',
        summary.trim(),
    ].join('\n');
}
/**
 * 按字符预算截断转录文本：保留首尾、截断中段并附提示行；
 * 截断后总长度不超过 TRANSCRIPT_CHAR_BUDGET。
 */
function truncateTranscript(text) {
    if (text.length <= TRANSCRIPT_CHAR_BUDGET)
        return text;
    const keepTotal = TRANSCRIPT_CHAR_BUDGET - TRANSCRIPT_TRUNCATION_NOTICE.length;
    const headLength = Math.ceil(keepTotal / 2);
    const tailLength = keepTotal - headLength;
    return (text.slice(0, headLength) +
        TRANSCRIPT_TRUNCATION_NOTICE +
        text.slice(text.length - tailLength));
}
