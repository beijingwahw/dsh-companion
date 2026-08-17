/** 缺省最大返回条数。 */
export const DEFAULT_SEARCH_LIMIT = 50;
/** 最大返回条数上限：传入更大的 limit 也按此截取。 */
export const MAX_SEARCH_LIMIT = 200;
/** 有标签条件时向引擎请求候选的放大倍数。 */
const TAG_CANDIDATE_FACTOR = 10;
/** 有标签条件时向引擎请求候选的数量上限。 */
const TAG_CANDIDATE_MAX = 1000;
/**
 * 检索会话。
 * @param deps 会话查询引擎 + 标签存储。
 * @param params 检索条件（query/from/to/tags/limit）。
 * @returns 按创建时间降序、截取 limit 的命中列表（每条含 tags）。
 */
export async function searchSessions(deps, params) {
    const limit = Math.min(params.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const query = params.query?.trim();
    const requiredTags = (params.tags ?? [])
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    const filters = [];
    if (params.from !== undefined || params.to !== undefined) {
        filters.push({ kind: 'created-at', from: params.from, to: params.to });
    }
    // 有标签条件时放大引擎候选量，避免标签过滤前被引擎截断而漏命中。
    const engineLimit = requiredTags.length > 0 ? Math.min(limit * TAG_CANDIDATE_FACTOR, TAG_CANDIDATE_MAX) : limit;
    let hits;
    if (query) {
        // 全文检索：时间范围作为 created-at 过滤子句交给引擎。
        const page = await deps.sessionQuery.searchSessions({ query, limit: engineLimit, filters });
        hits = page.hits.map((hit) => ({
            session: hit.session,
            snippet: hit.snippet,
            tags: deps.tagStore.getForSession(hit.session.id),
        }));
    }
    else if (filters.length > 0) {
        const records = await deps.sessionQuery.filterSessions(filters);
        hits = records.map((session) => ({
            session,
            tags: deps.tagStore.getForSession(session.id),
        }));
    }
    else {
        const records = await deps.sessionQuery.listSessions();
        hits = records.map((session) => ({
            session,
            tags: deps.tagStore.getForSession(session.id),
        }));
    }
    // 标签交集过滤：要求的标签必须全部命中。
    if (requiredTags.length > 0) {
        hits = hits.filter((hit) => requiredTags.every((tag) => hit.tags.includes(tag)));
    }
    hits.sort((a, b) => b.session.createdAt - a.session.createdAt);
    return hits.slice(0, limit);
}
