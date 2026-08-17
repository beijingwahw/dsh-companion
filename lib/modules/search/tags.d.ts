/**
 * 标签存储：companion 存储域 'tags' 表上的会话标签读写。
 *
 * 记录形状 { tags: string[], updatedAt }；写操作走 KvTable.update
 * 原子读-改-写，避免并发写丢失。标签规范化：去首尾空白、去空、
 * 去重、单条长度不超过 32（超长截断）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
import type { SessionId } from '../../core/ids.js';
/** 标签记录：一个会话的标签列表与最近更新时间。 */
export interface TagRecord {
    tags: string[];
    updatedAt: number;
}
/** 单个标签的最大长度（超出截断）。 */
export declare const MAX_TAG_LENGTH = 32;
/** 会话标签存储（伴随 companion 存储域生命周期）。 */
export declare class TagStore {
    private readonly table;
    /** 在已打开的存储域上建表视图。 */
    constructor(domain: Domain);
    /** 读取某会话的标签（副本；无记录返回空数组）。 */
    getForSession(sessionId: SessionId): string[];
    /** 读取全部会话的标签映射（sessionId → 标签副本）。 */
    getAll(): Record<string, string[]>;
    /**
     * 原子增删某会话的标签。
     * 规范化：trim、去空、去重、单条长度 ≤ 32（超长截断）；
     * 结果为空时删除记录，保持存储干净。
     * @param sessionId 目标会话品牌 id。
     * @param patch add 为待加入标签，remove 为待移除标签（均可缺省）。
     * @returns 变更后该会话的最新标签列表。
     */
    mutate(sessionId: SessionId, patch: {
        add?: readonly string[];
        remove?: readonly string[];
    }): Promise<string[]>;
}
