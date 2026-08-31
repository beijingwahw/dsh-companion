/**
 * 会话继承图谱（轴线 2：上下文血缘）：追踪交接摘要跨会话的传播链路。
 *
 * 概念模型：有向无环图。
 * - 节点 = 会话；边 = 一次摘要交接（source → target）；
 * - 边在 `POST /handoff/import` 时记录（携带 sourceSessionId 时）：
 *   指定 target 会话的武装直接落边；pending 武装先落「悬边」
 *   （target = null），待 pending 被消费（投递回执）时解析为真实目标；
 * - pending 被解除/过期时删除悬边，避免后续 pending 消费误认领；
 * - ancestorsOf / descendantsOf 做环安全图遍历（visited 集合），
 *   按「跳数」升序返回（近源优先）。
 *
 * 存储域：companion `handoff-lineage` 表；键 = `${source}>${target}:${linkedAt}`
 * （target 为悬边时用 `pending` 占位）。摘要摘录（首行 ≤80 字）随边存储，
 * 供客户端展示「经由什么内容传播」。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
/** 继承边记录。 */
export interface LineageEdge {
    /** 摘要来源会话 id。 */
    sourceSessionId: string;
    /** 摘要去向会话 id；null = 悬边（pending 待解析）。 */
    targetSessionId: string | null;
    /** 摘要首行摘录（展示用）。 */
    excerpt: string;
    /** 边建立时间（毫秒）。 */
    linkedAt: number;
}
/** 图遍历结果条目（含跳数）。 */
export interface LineageNode {
    sessionId: string;
    /** 距查询起点的跳数（1 = 直接相邻）。 */
    depth: number;
    /** 传播所用摘要摘录。 */
    excerpt: string;
    linkedAt: number;
}
/** 会话继承图谱存储。 */
export declare class LineageStore {
    private readonly table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain: Domain);
    /** 存储键：source>target:linkedAt（悬边 target 用 pending 占位）。 */
    private keyOf;
    /**
     * 记录一条继承边；target 为 null 表示悬边（pending 待解析）。
     * 写入后滚动修剪到 EDGE_KEEP_LIMIT 条。
     */
    recordEdge(source: string, target: string | null, summary: string): Promise<void>;
    /**
     * 解析悬边：pending 摘要已投递到 target 会话时，把全部 target=null
     * 的边改写为该目标（pending 槽位是单例，悬边只能属于同一次武装）。
     * 同时保留原 linkedAt（血缘时间 = 武装时刻）。
     */
    resolvePendingTargets(target: string): Promise<void>;
    /** 删除全部悬边（pending 被解除/过期时调用，防止误认领）。 */
    deletePendingEdges(): Promise<void>;
    /**
     * 祖先链：沿 source 方向向上遍历（谁的内容流入了本会话）。
     * 环安全（visited 去重）；按跳数升序、同跳数按时间升序。
     */
    ancestorsOf(sessionId: string, maxDepth?: number): LineageNode[];
    /**
     * 后代链：沿 target 方向向下遍历（本会话的内容流向了哪些会话）。
     * 环安全（visited 去重）；按跳数升序、同跳数按时间升序。
     */
    descendantsOf(sessionId: string, maxDepth?: number): LineageNode[];
    /** 图谱总览：全部已解析边（悬边除外），按时间降序（调试/面板用）。 */
    listEdges(): LineageEdge[];
}
