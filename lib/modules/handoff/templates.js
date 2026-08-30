/** 模板数量上限：新建（非覆盖）时超出即拒绝，防无界增长。 */
export const MAX_TEMPLATES = 50;
/** 模板名长度上限（字符）。 */
export const MAX_TEMPLATE_NAME_CHARS = 64;
/** 模板正文长度上限（字符）：交接指令远用不到，防滥用存储。 */
export const MAX_TEMPLATE_CONTENT_CHARS = 50_000;
/** 交接摘要模板存储。 */
export class TemplateStore {
    table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain) {
        this.table = domain.table('templates');
    }
    /** 当前模板总数（同步读）。 */
    get count() {
        return this.table.size;
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
    /**
     * 保存（新建或覆盖）一个模板，updatedAt 取当前时间。
     * 存储层守卫（HTTP 入口已前置校验并转 400，此处为其他调用方的兜底）：
     * @throws 名称/正文超长，或新建时数量超上限。
     */
    async save(name, content) {
        if (name.length > MAX_TEMPLATE_NAME_CHARS) {
            throw new Error(`模板名长度不能超过 ${MAX_TEMPLATE_NAME_CHARS} 字符`);
        }
        if (content.length > MAX_TEMPLATE_CONTENT_CHARS) {
            throw new Error(`模板正文长度不能超过 ${MAX_TEMPLATE_CONTENT_CHARS} 字符`);
        }
        if (this.table.get(name) === undefined && this.table.size >= MAX_TEMPLATES) {
            throw new Error(`模板数量已达上限（${MAX_TEMPLATES}），请先删除不再使用的模板`);
        }
        await this.table.put(name, { content, updatedAt: Date.now() });
    }
    /** 删除一个模板；不存在时静默成功。 */
    async remove(name) {
        await this.table.delete(name);
    }
}
