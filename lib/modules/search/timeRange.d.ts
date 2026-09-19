/**
 * 自然语言时间范围解析（检索时间过滤）：`range` 文本 → from/to 时间戳。
 *
 * 设计动机：模块 D 的时间过滤要求用户在日期选择器里点两个日期；
 * 但人的检索意图是自然语言——"上周的对话"、"最近一个月"、"昨天调试
 * 那会儿"。解析器把常见中文时间表达翻成 {from, to} 闭区间边界：
 *
 * - 相对窗口：`近N天` / `最近N天` / `近N周|月` / `N天前以来`；
 * - 命名窗口：`今天` / `昨天` / `本周` / `上周` / `本月` / `上个月` / `上週`（繁体兼容）；
 * - 语法糖：`last week` / `this month` 等英文等价表达。
 *
 * 语义约定：窗口按**北京时间自然日**对齐（与 beijingDayKey 同口径），
 * 闭区间 [from, to]（to 为窗口末日 23:59:59.999）。未识别的表达返回
 * undefined（调用方回退显式 from/to 参数——解析失败不报错，静默降级）。
 * 纯函数、确定性（相对 now 计算）。
 */
/** 解析结果：闭区间毫秒时间戳。 */
export interface TimeRange {
    readonly from: number;
    readonly to: number;
}
/**
 * 解析自然语言时间范围。
 * @param text 时间表达（如「近7天」「上周」）；空白或未识别返回 undefined。
 * @param now 基准时刻（缺省 Date.now()；测试注入）。
 */
export declare function parseTimeRange(text: string, now?: number): TimeRange | undefined;
