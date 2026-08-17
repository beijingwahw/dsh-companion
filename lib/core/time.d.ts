/**
 * 北京时间（UTC+8，无夏令时）工具：峰谷判定、日/月键、格式化。
 * 成本模块的峰谷调度与预算按月统计都以北京时间为准。
 */
/** 高峰时段窗口（北京时间，左闭右开）。 */
export interface PeakWindow {
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
}
/** 需求规定的高峰时段：9:00-12:00 与 14:00-18:00。 */
export declare const DEFAULT_PEAK_WINDOWS: readonly PeakWindow[];
export interface BeijingParts {
    year: number;
    /** 1-12 */
    month: number;
    /** 1-31 */
    day: number;
    hour: number;
    minute: number;
    /** 0-59 */
    second: number;
    /** 0=周日 */
    weekday: number;
}
/** 取某时间戳的北京时间各分量。 */
export declare function beijingParts(ts: number): BeijingParts;
/** 北京时间日期键 YYYY-MM-DD。 */
export declare function beijingDayKey(ts: number): string;
/** 北京时间月份键 YYYY-MM。 */
export declare function beijingMonthKey(ts: number): string;
/** 北京时间格式化 YYYY-MM-DD HH:mm:ss。 */
export declare function formatBeijingTime(ts: number): string;
/** 判断某时刻是否处于高峰时段（支持跨午夜窗口：start > end 时视为环绕）。 */
export declare function isPeakTime(ts: number, windows?: readonly PeakWindow[]): boolean;
/**
 * 从某时刻起，下一个处于空闲（非高峰）时段的分钟边界。
 * 仅在调用方已确认 isPeakTime(ts) 为真时使用；48 小时内必有解。
 */
export declare function nextOffPeakStart(ts: number, windows?: readonly PeakWindow[]): number;
