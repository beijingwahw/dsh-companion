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
import { beijingParts } from '../../core/time.js';
const DAY_MS = 24 * 3600_000;
/** 当天（北京时间）00:00:00.000 的时间戳。 */
function startOfBeijingDay(ts) {
    const p = beijingParts(ts);
    return Date.UTC(p.year, p.month - 1, p.day) - 8 * 3600_000;
}
/**
 * 解析自然语言时间范围。
 * @param text 时间表达（如「近7天」「上周」）；空白或未识别返回 undefined。
 * @param now 基准时刻（缺省 Date.now()；测试注入）。
 */
export function parseTimeRange(text, now = Date.now()) {
    const trimmed = text.trim().toLowerCase();
    if (trimmed.length === 0)
        return undefined;
    const today = startOfBeijingDay(now);
    // 相对窗口：近/最近 N 天|周|月。
    const relative = /^(?:近|最近|last\s+(?:few\s+)?)?(\d{1,3})\s*(天|日|周|星期|周|week|weeks|月|个月|month|months|d|w|m)[以之内前]?(?:以来|内|前)?$/.exec(trimmed)
        ?? /^(?:近|最近)([一二三四五六七八九十百]+)\s*(天|日|周|月)/.exec(trimmed);
    if (relative !== null) {
        const count = chineseOrDigit(relative[1]);
        const unit = relative[2];
        if (count > 0) {
            if (unit === '天' || unit === '日' || unit === 'd') {
                return { from: today - (count - 1) * DAY_MS, to: now };
            }
            if (unit === '周' || unit === '星期' || unit === 'week' || unit === 'weeks' || unit === 'w') {
                return { from: today - (count * 7 - 1) * DAY_MS, to: now };
            }
            // 月：按 30 天近似（自然月边界对「近 3 个月」语义差异可忽略）。
            return { from: today - (count * 30 - 1) * DAY_MS, to: now };
        }
    }
    // 命名窗口。
    const named = {
        今天: () => ({ from: today, to: now }),
        今日: () => ({ from: today, to: now }),
        'today': () => ({ from: today, to: now }),
        昨天: () => ({ from: today - DAY_MS, to: today - 1 }),
        昨日: () => ({ from: today - DAY_MS, to: today - 1 }),
        'yesterday': () => ({ from: today - DAY_MS, to: today - 1 }),
        本周: () => weekWindow(now, 0),
        这周: () => weekWindow(now, 0),
        'this week': () => weekWindow(now, 0),
        上周: () => weekWindow(now, 1),
        上週: () => weekWindow(now, 1),
        'last week': () => weekWindow(now, 1),
        本月: () => monthWindow(now, 0),
        这个月: () => monthWindow(now, 0),
        'this month': () => monthWindow(now, 0),
        上个月: () => monthWindow(now, 1),
        上月: () => monthWindow(now, 1),
        'last month': () => monthWindow(now, 1),
    };
    const resolver = named[trimmed];
    return resolver?.();
}
/** 以周一为一周起点（与中文习惯一致），offset=0 本周 / 1 上周。 */
function weekWindow(now, offset) {
    const today = startOfBeijingDay(now);
    const p = beijingParts(now);
    // getUTCDay：0=周日；周一起点 → 偏移 = (day + 6) % 7。
    const dayOfWeek = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const monday = today - ((dayOfWeek + 6) % 7) * DAY_MS;
    const from = monday - offset * 7 * DAY_MS;
    return { from, to: from + 7 * DAY_MS - 1 };
}
/** 自然月窗口，offset=0 本月 / 1 上个月。 */
function monthWindow(now, offset) {
    const p = beijingParts(now);
    const year = p.month - offset >= 1 ? p.year : p.year - 1;
    const month = ((p.month - offset - 1) % 12 + 12) % 12 + 1;
    const from = Date.UTC(year, month - 1, 1) - 8 * 3600_000;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from, to: from + daysInMonth * DAY_MS - 1 };
}
/** 中文数字（一~百）或阿拉伯数字 → 数值；无法解析返回 0。 */
function chineseOrDigit(text) {
    if (/^\d+$/.test(text))
        return Number(text);
    const digits = {
        一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100,
    };
    if (text.length === 1)
        return digits[text] ?? 0;
    // 简单组合：十几 / 几十 / 几十几。
    const ten = text.indexOf('十');
    if (ten === -1)
        return 0;
    const head = ten > 0 ? digits[text[ten - 1]] ?? 1 : 1;
    const tailRaw = text.slice(ten + 1);
    const tail = tailRaw.length > 0 ? digits[tailRaw] ?? 0 : 0;
    return head * 10 + tail;
}
