/**
 * 交接摘要模板存储：companion 存储域 `templates` 表。
 *
 * 记录形状 `{ content, updatedAt }`，键为模板名；
 * 读同步（权威内存状态），写走存储域写链（put/delete 返回 Promise）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
/** 模板记录：正文 + 更新时间戳（毫秒）。 */
export interface TemplateRecord {
    content: string;
    updatedAt: number;
}
/** 模板列表条目（记录 + 模板名）。 */
export interface TemplateEntry extends TemplateRecord {
    name: string;
}
/** 模板数量上限：新建（非覆盖）时超出即拒绝，防无界增长。 */
export declare const MAX_TEMPLATES = 50;
/** 模板名长度上限（字符）。 */
export declare const MAX_TEMPLATE_NAME_CHARS = 64;
/** 模板正文长度上限（字符）：交接指令远用不到，防滥用存储。 */
export declare const MAX_TEMPLATE_CONTENT_CHARS = 50000;
/** 交接摘要模板存储。 */
export declare class TemplateStore {
    private readonly table;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain: Domain);
    /** 当前模板总数（同步读）。 */
    get count(): number;
    /** 读取指定模板的正文内容；模板不存在返回 undefined。 */
    get(name: string): string | undefined;
    /** 列出全部模板（含名称），按模板名升序。 */
    list(): TemplateEntry[];
    /**
     * 保存（新建或覆盖）一个模板，updatedAt 取当前时间。
     * 存储层守卫（HTTP 入口已前置校验并转 400，此处为其他调用方的兜底）：
     * @throws 名称/正文超长，或新建时数量超上限。
     */
    save(name: string, content: string): Promise<void>;
    /** 删除一个模板；不存在时静默成功。 */
    remove(name: string): Promise<void>;
}
