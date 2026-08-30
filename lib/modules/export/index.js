import { HttpError, sendJson } from '../../core/http.js';
import { SessionId } from '../../core/ids.js';
import { buildBatchExport, buildSingleExport, listTurns, toSafeHttpError, userFacingMessage, } from './service.js';
/** 插件名。 */
export const name = 'companion-export';
/** 依赖服务：companion 根服务、会话查询、命令面板。 */
export const inject = ['companion', 'sessionQuery', 'commands'];
/** 合法导出格式集合（png=长图，仅 HTTP 客户端可用，需 canvas 光栅化）。 */
const EXPORT_FORMATS = ['markdown', 'pdf', 'json', 'png'];
/** 命令面板文本通道的内容上限（字符）：超出改指路界面导出，避免巨幅文本刷屏。 */
const COMMAND_TEXT_LIMIT_CHARS = 20_000;
/**
 * 经命令面板文本通道交付导出产物：
 * - markdown/json（UTF-8 文本格式）且长度在上限内 → 回传真实内容（真正交付）；
 * - 二进制载荷（pdf/png 光栅等）或超长文本 → 如实报错并指路界面导出，
 *   绝不伪造「导出完成」（命令面板无文件下载通道，文件名≠文件）。
 */
function deliverViaTextChannel(payload) {
    const isTextFormat = payload.kind === 'file' &&
        (payload.mimeType.startsWith('text/') || payload.mimeType.includes('json'));
    if (!isTextFormat || payload.kind !== 'file') {
        return {
            kind: 'error',
            text: '该格式的导出产物为二进制文件，命令面板无法交付；请在对话界面使用「导出」经浏览器下载',
        };
    }
    const text = Buffer.from(payload.contentBase64, 'base64').toString('utf8');
    if (text.length > COMMAND_TEXT_LIMIT_CHARS) {
        return {
            kind: 'error',
            text: `导出内容过长（${text.length} 字符，上限 ${COMMAND_TEXT_LIMIT_CHARS}），命令面板无法回传；请在对话界面使用「导出」经浏览器下载`,
        };
    }
    return { kind: 'success', text };
}
/** 格式类型守卫。 */
function isExportFormat(value) {
    return EXPORT_FORMATS.includes(value);
}
/** 插件入口：所有注册经 ctx.effect，卸载时统一回卷。 */
export function apply(ctx) {
    ctx.effect(() => {
        const disposers = [
            // 会话列表（客户端导出选择器数据源）。
            ctx.companion.http.add('GET', '/export/sessions', async (_req, res) => {
                try {
                    const sessions = await ctx.sessionQuery.listSessions();
                    sendJson(res, 200, { sessions });
                }
                catch (error) {
                    throw toSafeHttpError(error, '获取会话列表失败');
                }
            }),
            // 单会话导出：响应为 file（base64）、print（html）或 raster（客户端光栅）。
            // HTTP 客户端具备 canvas 光栅能力，统一开启：PNG 长图与含 CJK 的 PDF
            // 由客户端光栅化成品，全程无 window.print() 对话框。
            // turns 字段（可选）：回合选择面板的选中回合下标，仅导出选中回合
            // （能力吸收自 dsh-conv-export 的回合级选择导出）。
            ctx.companion.http.add('POST', '/export/run', async (_req, res, hctx) => {
                try {
                    const { sessionId, options } = parseRunBody(hctx.body);
                    const payload = await buildSingleExport(ctx.sessionQuery, sessionId, {
                        ...options,
                        raster: true,
                    });
                    sendJson(res, 200, payload);
                }
                catch (error) {
                    throw toSafeHttpError(error, '导出会话失败');
                }
            }),
            // 回合预览列表：回合选择面板数据源（角色 + 截断预览 + 时间）。
            ctx.companion.http.add('GET', '/export/turns', async (_req, res, hctx) => {
                try {
                    const sessionId = parseSessionId(hctx.query.get('sessionId'));
                    const payload = await listTurns(ctx.sessionQuery, sessionId);
                    sendJson(res, 200, payload);
                }
                catch (error) {
                    throw toSafeHttpError(error, '获取回合列表失败');
                }
            }),
            // 批量导出：ZIP 文件载荷。
            ctx.companion.http.add('POST', '/export/batch', async (_req, res, hctx) => {
                try {
                    const { sessionIds, options } = parseBatchBody(hctx.body);
                    const payload = await buildBatchExport(ctx.sessionQuery, sessionIds, options);
                    sendJson(res, 200, payload);
                }
                catch (error) {
                    throw toSafeHttpError(error, '批量导出失败');
                }
            }),
            // 命令：导出当前/指定会话。
            // 命令面板只有文本通道（CommandResult 无文件交付能力）：
            // 可文本化的格式（markdown/json）在长度上限内回传真实内容；
            // 二进制（pdf/png 光栅等）与超长文本无法交付，如实报错并指路
            // 界面导出——绝不伪造「导出完成」（旧行为只回文件名，产物
            // 实际被丢弃，用户误以为文件已保存）。
            ctx.commands.register({
                name: 'companion-export',
                description: '导出对话',
                input: { hint: '<会话ID> [markdown|pdf|json]' },
                handler: async (invocation) => {
                    let payload;
                    try {
                        const { sessionId, options } = parseExportInput(invocation.rawInput, invocation.agent.id);
                        payload = await buildSingleExport(ctx.sessionQuery, sessionId, options);
                    }
                    catch (error) {
                        return { kind: 'error', text: userFacingMessage(error, '导出失败，请稍后重试') };
                    }
                    return deliverViaTextChannel(payload);
                },
            }),
            // 命令：批量导出为 ZIP。ZIP 为二进制，文本通道无法交付：
            // 校验输入后如实告知改用界面批量导出（不空跑打包再丢弃产物）。
            ctx.commands.register({
                name: 'companion-export-batch',
                description: '批量导出为 ZIP',
                input: { hint: '<会话ID1>,<会话ID2>,…' },
                handler: async (invocation) => {
                    const sessionIds = (invocation.rawInput ?? '')
                        .split(',')
                        .map((part) => part.trim())
                        .filter((part) => part.length > 0);
                    if (sessionIds.length === 0) {
                        return { kind: 'error', text: '请提供要导出的会话 ID（逗号分隔）' };
                    }
                    return {
                        kind: 'error',
                        text: `批量导出产物为 ZIP 二进制文件（共 ${sessionIds.length} 个会话），命令面板无法交付；请在导出对话框勾选「批量导出」经浏览器下载`,
                    };
                },
            }),
        ];
        return () => {
            for (const dispose of [...disposers].reverse())
                dispose();
        };
    }, 'companion-export.register');
}
/** 将请求体收窄为对象记录（形状不符抛 HttpError）。 */
function bodyAsRecord(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError('请求体必须是 JSON 对象');
    }
    return body;
}
/** 解析必填的会话 id（查询参数或请求体通用）。 */
function parseSessionId(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError('sessionId 必填');
    }
    return SessionId(value.trim());
}
/**
 * 解析可选的回合下标数组（回合级选择导出）：
 * - 缺省/undefined → undefined（导出全部回合）；
 * - 必须为非空数组且全部为非负整数，违例 400；
 * - 去重升序规范化（服务端过滤按下标匹配，顺序不影响结果）。
 */
function parseTurns(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length === 0) {
        throw new HttpError('turns 必须是非空的回合下标数组（导出全部回合时请省略该字段）');
    }
    const indices = [];
    for (const item of value) {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) {
            throw new HttpError('turns 必须全部为非负整数（回合在回合列表中的下标）');
        }
        indices.push(item);
    }
    return [...new Set(indices)].sort((a, b) => a - b);
}
/** 解析必填的格式字段。 */
function parseFormat(value) {
    if (typeof value === 'string' && isExportFormat(value))
        return value;
    throw new HttpError('format 必填，且必须为 markdown/pdf/json/png 之一');
}
/** 解析布尔开关（缺省取 fallback）。 */
function parseFlag(value, field, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        throw new HttpError(`${field} 必须是布尔值`);
    return value;
}
/** 解析 POST /export/run 请求体。 */
function parseRunBody(body) {
    const record = bodyAsRecord(body);
    if (typeof record.sessionId !== 'string' || record.sessionId.trim().length === 0) {
        throw new HttpError('sessionId 必填');
    }
    return {
        sessionId: SessionId(record.sessionId.trim()),
        options: {
            format: parseFormat(record.format),
            timestamps: parseFlag(record.timestamps, 'timestamps', true),
            redact: parseFlag(record.redact, 'redact', false),
            turns: parseTurns(record.turns),
        },
    };
}
/** 解析 POST /export/batch 请求体。 */
function parseBatchBody(body) {
    const record = bodyAsRecord(body);
    const rawIds = record.sessionIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw new HttpError('sessionIds 必填且必须为非空数组');
    }
    const sessionIds = [];
    for (const item of rawIds) {
        if (typeof item !== 'string' || item.trim().length === 0) {
            throw new HttpError('sessionIds 必须全部为非空字符串');
        }
        sessionIds.push(SessionId(item.trim()));
    }
    return {
        sessionIds,
        options: {
            format: parseFormat(record.format),
            timestamps: parseFlag(record.timestamps, 'timestamps', true),
            redact: parseFlag(record.redact, 'redact', false),
        },
    };
}
/**
 * 解析 export 命令输入："<会话ID> [markdown|pdf|json]"。
 * 单个 token 且为合法格式时视为格式（会话取调用来源会话）；
 * 缺省会话时回退 invocation.agent.id；格式缺省 markdown。
 */
function parseExportInput(input, fallbackSessionId) {
    const tokens = (input ?? '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    if (tokens.length === 0) {
        if (!fallbackSessionId)
            throw new HttpError('请指定要导出的会话 ID');
        return { sessionId: fallbackSessionId, options: { format: 'markdown' } };
    }
    const first = tokens[0].toLowerCase();
    if (tokens.length === 1 && isExportFormat(first)) {
        if (!fallbackSessionId)
            throw new HttpError('请指定要导出的会话 ID');
        return { sessionId: fallbackSessionId, options: { format: first } };
    }
    const sessionId = SessionId(tokens[0]);
    if (tokens.length === 1)
        return { sessionId, options: { format: 'markdown' } };
    const format = tokens[1].toLowerCase();
    if (!isExportFormat(format)) {
        throw new HttpError(`不支持的导出格式“${format}”，可选 markdown/pdf/json/png`);
    }
    return { sessionId, options: { format } };
}
