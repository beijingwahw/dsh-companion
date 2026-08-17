/**
 * 模块 D 会话检索服务：HTTP 端点与命令面板共用。
 *
 * 有 query 时走 sessionQuery.searchSessions（created-at 时间范围经
 * filters 交给引擎）；否则按时间过滤走 filterSessions，无任何条件时
 * listSessions。随后与 TagStore 做标签交集过滤（tags 全部命中），
 * 为每个命中附加 tags 字段，按创建时间降序截取 limit。
 *
 * 限量与标签过滤策略：
 * - limit 受 MAX_SEARCH_LIMIT 封顶；
 * - 同时存在 tags 条件时，向引擎请求 min(limit*10, 1000) 条候选，
 *   再做标签全命中过滤，避免引擎提前截断导致漏命中；
 * - 无 query 的纯筛选路径同样受 limit 上限保护。
 */
import type { SessionQueryEngine, SessionRecord } from '../../types/harness.js';
import type { TagStore } from './tags.js';
/** 检索参数。 */
export interface SearchParams {
    /** 全文检索词；缺省时仅按时间/标签条件枚举。 */
    query?: string;
    /** 创建时间下界（毫秒时间戳，闭区间）。 */
    from?: number;
    /** 创建时间上界（毫秒时间戳，闭区间）。 */
    to?: number;
    /** 标签过滤：要求全部命中。 */
    tags?: readonly string[];
    /** 最大返回条数（缺省 50）。 */
    limit?: number;
}
/** 单条检索命中（附加该会话当前标签）。 */
export interface SearchHit {
    session: SessionRecord;
    /** 全文检索摘要（仅走检索引擎时可能存在）。 */
    snippet?: string;
    tags: string[];
}
/** 检索服务依赖。 */
export interface SearchDeps {
    sessionQuery: SessionQueryEngine;
    tagStore: TagStore;
}
/** 缺省最大返回条数。 */
export declare const DEFAULT_SEARCH_LIMIT = 50;
/** 最大返回条数上限：传入更大的 limit 也按此截取。 */
export declare const MAX_SEARCH_LIMIT = 200;
/**
 * 检索会话。
 * @param deps 会话查询引擎 + 标签存储。
 * @param params 检索条件（query/from/to/tags/limit）。
 * @returns 按创建时间降序、截取 limit 的命中列表（每条含 tags）。
 */
export declare function searchSessions(deps: SearchDeps, params: SearchParams): Promise<SearchHit[]>;
