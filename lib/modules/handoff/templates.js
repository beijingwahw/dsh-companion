/** 交接摘要模板存储。 */
export class TemplateStore {
    table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain) {
        this.table = domain.table('templates');
    }
    /** 读取指定模板的正文内容；模板不存在返回 undefined。 */
    get(name) {
        return this.table.get(name)?.content;
    }
    /** 列出全部模板（含名称），按模板名升序。 */
    list() {
        return this.table
            .entries()
            .map(([name, record]) => ({ name, ...record }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    /** 保存（新建或覆盖）一个模板，updatedAt 取当前时间。 */
    async save(name, content) {
        await this.table.put(name, { content, updatedAt: Date.now() });
    }
    /** 删除一个模板；不存在时静默成功。 */
    async remove(name) {
        await this.table.delete(name);
    }
}
