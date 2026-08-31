/** 悬边（pending）的目标占位符。 */
const PENDING_TARGET = 'pending';
/** 摘录最大长度（超出截断）。 */
const EXCERPT_LIMIT = 80;
/** 图谱滚动保留边数上限（超出按 linkedAt 淘汰最旧）。 */
const EDGE_KEEP_LIMIT = 500;
/** 从摘要正文提取首行摘录（≤80 字符）。 */
function firstLineExcerpt(summary) {
    const line = summary
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (line === undefined)
        return '';
    return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT)}…` : line;
}
/** 会话继承图谱存储。 */
export class LineageStore {
    table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain) {
        this.table = domain.table('handoff-lineage');
    }
    /** 存储键：source>target:linkedAt（悬边 target 用 pending 占位）。 */
    keyOf(source, target, linkedAt) {
        return `${source}>${target ?? PENDING_TARGET}:${linkedAt}`;
    }
    /**
     * 记录一条继承边；target 为 null 表示悬边（pending 待解析）。
     * 写入后滚动修剪到 EDGE_KEEP_LIMIT 条。
     */
    async recordEdge(source, target, summary) {
        const linkedAt = Date.now();
        const edge = {
            sourceSessionId: source,
            targetSessionId: target,
            excerpt: firstLineExcerpt(summary),
            linkedAt,
        };
        await this.table.put(this.keyOf(source, target, linkedAt), edge);
        const entries = this.table.entries();
        if (entries.length <= EDGE_KEEP_LIMIT)
            return;
        const stale = entries
            .sort((a, b) => a[1].linkedAt - b[1].linkedAt)
            .slice(0, entries.length - EDGE_KEEP_LIMIT);
        for (const [key] of stale)
            await this.table.delete(key);
    }
    /**
     * 解析悬边：pending 摘要已投递到 target 会话时，把全部 target=null
     * 的边改写为该目标（pending 槽位是单例，悬边只能属于同一次武装）。
     * 同时保留原 linkedAt（血缘时间 = 武装时刻）。
     */
    async resolvePendingTargets(target) {
        const pending = this.table
            .entries()
            .filter(([, edge]) => edge.targetSessionId === null);
        for (const [key, edge] of pending) {
            if (edge.sourceSessionId === target) {
                // 自环（摘要武装回来源会话）：删除而非改写，保持 DAG 语义。
                await this.table.delete(key);
                continue;
            }
            await this.table.delete(key);
            await this.table.put(this.keyOf(edge.sourceSessionId, target, edge.linkedAt), {
                ...edge,
                targetSessionId: target,
            });
        }
    }
    /** 删除全部悬边（pending 被解除/过期时调用，防止误认领）。 */
    async deletePendingEdges() {
        const pending = this.table
            .entries()
            .filter(([, edge]) => edge.targetSessionId === null);
        for (const [key] of pending)
            await this.table.delete(key);
    }
    /**
     * 祖先链：沿 source 方向向上遍历（谁的内容流入了本会话）。
     * 环安全（visited 去重）；按跳数升序、同跳数按时间升序。
     */
    ancestorsOf(sessionId, maxDepth = 10) {
        const edges = this.table.entries().map(([, edge]) => edge);
        const visited = new Set([sessionId]);
        let frontier = [sessionId];
        const result = [];
        for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
            const next = [];
            const found = [];
            for (const node of frontier) {
                for (const edge of edges) {
                    if (edge.targetSessionId !== node)
                        continue;
                    if (visited.has(edge.sourceSessionId))
                        continue;
                    visited.add(edge.sourceSessionId);
                    next.push(edge.sourceSessionId);
                    found.push({
                        sessionId: edge.sourceSessionId,
                        depth,
                        excerpt: edge.excerpt,
                        linkedAt: edge.linkedAt,
                    });
                }
            }
            found.sort((a, b) => a.linkedAt - b.linkedAt);
            result.push(...found);
            frontier = next;
        }
        return result;
    }
    /**
     * 后代链：沿 target 方向向下遍历（本会话的内容流向了哪些会话）。
     * 环安全（visited 去重）；按跳数升序、同跳数按时间升序。
     */
    descendantsOf(sessionId, maxDepth = 10) {
        const edges = this.table.entries().map(([, edge]) => edge);
        const visited = new Set([sessionId]);
        let frontier = [sessionId];
        const result = [];
        for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
            const next = [];
            const found = [];
            for (const node of frontier) {
                for (const edge of edges) {
                    if (edge.sourceSessionId !== node)
                        continue;
                    if (edge.targetSessionId === null || visited.has(edge.targetSessionId))
                        continue;
                    visited.add(edge.targetSessionId);
                    next.push(edge.targetSessionId);
                    found.push({
                        sessionId: edge.targetSessionId,
                        depth,
                        excerpt: edge.excerpt,
                        linkedAt: edge.linkedAt,
                    });
                }
            }
            found.sort((a, b) => a.linkedAt - b.linkedAt);
            result.push(...found);
            frontier = next;
        }
        return result;
    }
    /** 图谱总览：全部已解析边（悬边除外），按时间降序（调试/面板用）。 */
    listEdges() {
        return this.table
            .entries()
            .map(([, edge]) => edge)
            .filter((edge) => edge.targetSessionId !== null)
            .sort((a, b) => b.linkedAt - a.linkedAt);
    }
}
