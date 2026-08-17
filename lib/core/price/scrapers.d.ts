import type { PriceTable } from './types.js';
interface RawCell {
    text: string;
    rowspan: number;
    colspan: number;
}
/** 提取全部表格为原始单元格行（保留 span 属性）。 */
export declare function parseRawTables(html: string): RawCell[][][];
/** 展开 rowspan/colspan 为矩形文本网格。 */
export declare function toGrid(rows: RawCell[][]): string[][];
/**
 * 解析单个价格单元格为 元/百万 tokens。
 * "免费" → 0；美元单元格 → undefined（不支持，调用方回退）。
 */
export declare function parsePriceCell(text: string): number | undefined;
/**
 * 从某厂商官方定价页 HTML 自动发现全部带价模型。
 * 无可识别内容（如纯 JS 渲染页）时返回空表，调用方沿用现有价格。
 */
export declare function parseVendorSheet(html: string, vendorId: string): PriceTable;
/** 浏览器 UA：部分站点拒绝或非正常响应非浏览器客户端。 */
export declare const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/**
 * 百度文心（千帆）定价。cloud.baidu.com 对非浏览器客户端重置 TLS，
 * 但同一文档的 Gatsby CDN 镜像在 page-data JSON 信封中提供渲染后的
 * markdown HTML。表格形如 [模型名称, 版本名称, 服务内容, 子项, 在线推理, 批量推理, 单位]，
 * 行如 [ERNIE 5.1, ERNIE-5.1, 推理服务, 输入（输入<=32k）, 0.004, -, 元/千tokens]。
 * 阶梯行按最低档在前；每模型每类型取首个档位。
 */
export declare function parseErnieSheet(html: string): PriceTable;
/**
 * 智谱 GLM 现役旗舰定价。open.bigmodel.cn/pricing 是 Vue SPA 空壳（3.7KB，无数据），
 * 实时价格内嵌于其 app.*.js i18n 包中，形如
 * `newModel:{...modelList:[{name:"GLM-5.2",...,inPrice:["8元"],outPrice:["28元"],hit:["2元"]}]}`。
 * 阶梯模型重复为 name:"" 条目；只读具名行，故首个（最低）档位生效。"免费"条目记 0。
 */
export declare function parseZhipuBundleSheet(js: string): PriceTable;
/**
 * 智谱旧模型（GLM-4 代及更早）来自公开的 /api/biz/operation/query 接口（无鉴权）。
 * 运营位 1122/1123 携带字符串化 JSON `content`，fieldList 将随机行键码映射到列标签。
 * 单价为按 token 计的单一费率，输入输出同价；只接受"元 / 百万Tokens"/"免费"单元格，
 * 以排除按图/按次等类目。
 */
export declare function parseZhipuLegacySheet(jsonText: string): PriceTable;
/**
 * 字节豆包（火山方舟）定价。文档页为客户端渲染 Quill 富文本，
 * 但文档中心接口以服务端 Markdown（Result.MDContent）提供同一内容。
 * 文本模型表位于 `# 大语言模型` H1 之下，视频/图像模型（doubao-seedance-*）
 * 位于其他 H1 之下，故章节过滤即可可靠排除。合并阶梯行的模型单元格为空
 * （更高档位）会被跳过——最低档生效。
 */
export declare function parseDoubaoSheet(markdown: string): PriceTable;
/**
 * Kimi 定价。文档站为客户端渲染 Next.js，价格表位于 RSC flight payload 中，形如
 * `columns:[{title:`输入价格（缓存命中）`...}],rows:[[`kimi-k2.6`,`1M tokens`,`¥1.10`,...]]`。
 * 列语义来自标题，故列的增删可自适应。
 */
export declare function parseKimiSheet(rscText: string): PriceTable;
export {};
