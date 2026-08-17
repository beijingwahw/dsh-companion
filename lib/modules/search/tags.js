/** 单个标签的最大长度（超出截断）。 */
export const MAX_TAG_LENGTH = 32;
/** 存储域内的表名。 */
const TAGS_TABLE = 'tags';
/** 会话标签存储（伴随 companion 存储域生命周期）。 */
export class TagStore {
    table;
    /** 在已打开的存储域上建表视图。 */
    constructor(domain) {
        this.table = domain.table(TAGS_TABLE);
    }
    /** 读取某会话的标签（副本；无记录返回空数组）。 */
    getForSession(sessionId) {
        const record = this.table.get(sessionId);
        return record ? [...record.tags] : [];
    }
    /** 读取全部会话的标签映射（sessionId → 标签副本）。 */
    getAll() {
        const result = {};
        for (const [sessionId, record] of this.table.entries()) {
            result[sessionId] = [...record.tags];
        }
        return result;
    }
    /**
     * 原子增删某会话的标签。
     * 规范化：trim、去空、去重、单条长度 ≤ 32（超长截断）；
     * 结果为空时删除记录，保持存储干净。
     * @param sessionId 目标会话品牌 id。
     * @param patch add 为待加入标签，remove 为待移除标签（均可缺省）。
     * @returns 变更后该会话的最新标签列表。
     */
    async mutate(sessionId, patch) {
        let latest = [];
        await this.table.update(sessionId, (prev) => {
            const next = new Set(prev?.tags ?? []);
            for (const tag of patch.add ?? []) {
                const cleaned = normalizeTag(tag);
                if (cleaned.length > 0)
                    next.add(cleaned);
            }
            for (const tag of patch.remove ?? []) {
                const cleaned = normalizeTag(tag);
                if (cleaned.length > 0)
                    next.delete(cleaned);
            }
            latest = [...next];
            if (latest.length === 0)
                return undefined;
            return { tags: latest, updatedAt: Date.now() };
        });
        return latest;
    }
}
/** 标签规范化：去首尾空白并截断到最大长度。 */
function normalizeTag(tag) {
    return tag.trim().slice(0, MAX_TAG_LENGTH);
}
