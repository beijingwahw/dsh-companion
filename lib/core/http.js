/** 带状态码的业务错误。 */
export class HttpError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.name = 'HttpError';
    }
}
/**
 * 创建路由器。
 * @param basePath 前缀路径（默认 /companion）。
 */
export function createRouter(basePath = '/companion') {
    const routes = new Map();
    return {
        add(method, path, handler) {
            const key = `${method} ${path}`;
            if (routes.has(key))
                throw new Error(`companion http: duplicate route ${key}`);
            routes.set(key, handler);
            return () => {
                // 身份比对：仅当当前注册的仍是同一个 handler 时才注销，
                // 避免误删注销期间被重新注册到同一 key 的新 handler。
                if (routes.get(key) === handler)
                    routes.delete(key);
            };
        },
        async handle(req, res) {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://localhost');
            }
            catch {
                return sendJson(res, 400, { error: 'bad request url' });
            }
            // 前缀匹配要求完全相等，或其后紧跟 '/'（防止 /companion-x 被误匹配）。
            if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
                return sendJson(res, 404, { error: 'not found' });
            }
            const sub = url.pathname.slice(basePath.length) || '/';
            const key = `${req.method ?? 'GET'} ${sub}`;
            const handler = routes.get(key);
            if (!handler) {
                return sendJson(res, 404, { error: `no route: ${key}` });
            }
            try {
                const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJsonBody(req);
                await handler(req, res, { query: url.searchParams, body });
            }
            catch (error) {
                // 错误响应本身也可能失败（如连接已断开）：兜底销毁连接，杜绝未处理 rejection。
                try {
                    if (error instanceof HttpError) {
                        sendJson(res, error.status, { error: error.message });
                    }
                    else {
                        sendJson(res, 500, {
                            error: error instanceof Error ? error.message : 'internal error',
                        });
                    }
                }
                catch {
                    res.destroy();
                }
            }
        },
    };
}
/** 发送 JSON 响应。 */
export function sendJson(res, status, payload) {
    if (res.writableEnded)
        return;
    if (res.headersSent) {
        // 响应头已发出（handler 已开始写 body）：无法再改写状态行，直接结束响应。
        res.end();
        return;
    }
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}
/** 请求体读取默认超时（毫秒）。 */
const BODY_READ_TIMEOUT_MS = 30_000;
/**
 * 读取并解析 JSON 请求体（大小上限默认 8 MB；空正文返回 {}）。
 * @param req 请求对象。
 * @param limitBytes 大小上限（字节）。
 * @param timeoutMs 读取超时（默认 30 秒）：慢速/停滞的 body 不会无限挂起，超时抛 408。
 */
export async function readJsonBody(req, limitBytes = 8 * 1024 * 1024, timeoutMs = BODY_READ_TIMEOUT_MS) {
    const chunks = await new Promise((resolve, reject) => {
        const buffer = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => {
            fail(new HttpError('request body read timeout', 408));
            req.destroy();
        }, timeoutMs);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        req.on('data', (chunk) => {
            if (settled)
                return;
            size += chunk.byteLength;
            if (size > limitBytes) {
                fail(new HttpError('request body too large', 413));
                req.destroy();
                return;
            }
            buffer.push(chunk);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(buffer);
        });
        req.on('error', (error) => fail(error));
        req.on('close', () => {
            // 正常结束时 close 在 end 之后到达，settled 已置位；此处只处理提前断开。
            fail(new HttpError('request body stream closed early', 400));
        });
    });
    if (chunks.length === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError('request body is not valid JSON', 400);
    }
}
