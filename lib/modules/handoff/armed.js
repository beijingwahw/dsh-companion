/** pending 武装的存储键：摘要将注入下一个新对话。 */
export const PENDING_KEY = '__pending__';
/** 交接摘要武装存储。 */
export class ArmedStore {
    table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain) {
        this.table = domain.table('handoff-armed');
    }
    /** 武装摘要；sessionId 为 null 时武装给下一个新对话（pending，同键覆盖）。 */
    async arm(sessionId, summary) {
        await this.table.put(sessionId ?? PENDING_KEY, { summary, armedAt: Date.now() });
    }
    /** 解除武装；sessionId 为 null 时解除 pending。不存在时静默成功。 */
    async disarm(sessionId) {
        await this.table.delete(sessionId ?? PENDING_KEY);
    }
    /** 列出当前全部武装（同步读）；特定会话按武装时间升序，pending 排在最后。 */
    list() {
        return this.table
            .entries()
            .map(([key, record]) => ({
            sessionId: key === PENDING_KEY ? null : key,
            summary: record.summary,
            armedAt: record.armedAt,
        }))
            .sort((a, b) => {
            if (a.sessionId === null)
                return 1;
            if (b.sessionId === null)
                return -1;
            return a.armedAt - b.armedAt;
        });
    }
    /** 读取 pending 武装记录（同步读）；不存在返回 undefined。 */
    peekPending() {
        return this.table.get(PENDING_KEY);
    }
    /**
     * 消费 pending 武装：删除并返回摘要；不存在返回 undefined。
     * 用一次 table.update 原子地读取并删除（回调返回 undefined 即删除该键），
     * 避免 get→await delete 的间隙中新武装的摘要被误删。
     */
    async consumePending() {
        let summary;
        await this.table.update(PENDING_KEY, (prev) => {
            summary = prev?.summary;
            return undefined;
        });
        return summary;
    }
}
