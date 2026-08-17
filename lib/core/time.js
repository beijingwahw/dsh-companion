/**
 * 北京时间（UTC+8，无夏令时）工具：峰谷判定、日/月键、格式化。
 * 成本模块的峰谷调度与预算按月统计都以北京时间为准。
 */
/** 需求规定的高峰时段：9:00-12:00 与 14:00-18:00。 */
export const DEFAULT_PEAK_WINDOWS = [
    { startHour: 9, startMinute: 0, endHour: 12, endMinute: 0 },
    { startHour: 14, startMinute: 0, endHour: 18, endMinute: 0 },
];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 取某时间戳的北京时间各分量。 */
export function beijingParts(ts) {
    const d = new Date(ts + BEIJING_OFFSET_MS);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
        weekday: d.getUTCDay(),
    };
}
/** 北京时间日期键 YYYY-MM-DD。 */
export function beijingDayKey(ts) {
    const p = beijingParts(ts);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}
/** 北京时间月份键 YYYY-MM。 */
export function beijingMonthKey(ts) {
    const p = beijingParts(ts);
    return `${p.year}-${pad2(p.month)}`;
}
/** 北京时间格式化 YYYY-MM-DD HH:mm:ss。 */
export function formatBeijingTime(ts) {
    const p = beijingParts(ts);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}
/** 判断某时刻是否处于高峰时段（支持跨午夜窗口：start > end 时视为环绕）。 */
export function isPeakTime(ts, windows = DEFAULT_PEAK_WINDOWS) {
    const { hour, minute } = beijingParts(ts);
    const nowMinutes = hour * 60 + minute;
    return windows.some((w) => {
        const start = w.startHour * 60 + w.startMinute;
        const end = w.endHour * 60 + w.endMinute;
        if (start > end) {
            // 跨午夜窗口（如 22:00-06:00）：now >= start 或 now < end 均算高峰。
            return nowMinutes >= start || nowMinutes < end;
        }
        return nowMinutes >= start && nowMinutes < end;
    });
}
/**
 * 从某时刻起，下一个处于空闲（非高峰）时段的分钟边界。
 * 仅在调用方已确认 isPeakTime(ts) 为真时使用；48 小时内必有解。
 */
export function nextOffPeakStart(ts, windows = DEFAULT_PEAK_WINDOWS) {
    let t = Math.floor(ts / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < 48 * 60; i += 1, t += 60_000) {
        if (!isPeakTime(t, windows))
            return t;
    }
    return t;
}
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
