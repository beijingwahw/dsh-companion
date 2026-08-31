/** 一周的毫秒数。 */
const WEEK_MS = 7 * 24 * 3600_000;
/** 周级时间线的桶数（最近 8 周）。 */
export const TREND_WEEKS = 8;
/** 上升方向的判定阈值（动量超过且近窗口覆盖 ≥2 个会话）。 */
const RISING_MOMENTUM = 0.5;
/** 下降方向的判定阈值（动量低于 -0.6 视为骤降）。 */
const FALLING_MOMENTUM = -0.6;
/**
 * 计算实体趋势：近 `days` 天 vs 上一等长窗口的动量与方向，
 * 附最近 8 周逐周覆盖会话数。
 *
 * 排序按"信息量"：|动量| × log(1 + 两窗口频次和)——既显著又有
 * 量的变化排在前；两窗口均无信号的实体直接剔除。
 */
export function computeEntityTrends(input) {
    const windowMs = input.days * 24 * 3600_000;
    const recentCutoff = input.now - windowMs;
    const previousCutoff = input.now - 2 * windowMs;
    const trends = [];
    for (const record of input.records) {
        let recentSessions = 0;
        let previousSessions = 0;
        let recentFreq = 0;
        let previousFreq = 0;
        const series = new Array(TREND_WEEKS).fill(0);
        let signal = false;
        for (const [sessionId, freq] of Object.entries(record.sessions)) {
            if (!(freq > 0))
                continue;
            const time = input.sessionTimes.get(sessionId);
            if (time === undefined)
                continue;
            signal = true;
            if (time > recentCutoff) {
                recentSessions += 1;
                recentFreq += freq;
            }
            else if (time > previousCutoff) {
                previousSessions += 1;
                previousFreq += freq;
            }
            // 周级时间线：周桶 0（最近一周）… 7（8 周前）。
            const weeksAgo = Math.floor((input.now - time) / WEEK_MS);
            if (weeksAgo >= 0 && weeksAgo < TREND_WEEKS) {
                series[TREND_WEEKS - 1 - weeksAgo] += 1;
            }
        }
        if (!signal)
            continue;
        const momentum = (recentFreq - previousFreq) / (previousFreq + 1);
        let direction = 'stable';
        if (momentum > RISING_MOMENTUM && recentSessions >= 2) {
            direction = 'rising';
        }
        else if (previousSessions >= 2 && (recentSessions === 0 || momentum < FALLING_MOMENTUM)) {
            direction = 'falling';
        }
        trends.push({
            name: record.name,
            type: record.type,
            direction,
            momentum: Number(momentum.toFixed(4)),
            recentSessions,
            previousSessions,
            recentFreq,
            previousFreq,
            series,
        });
    }
    // 信息量排序：显著且量大的变化在前；平局按近期覆盖数、名称稳定序。
    trends.sort((a, b) => Math.abs(b.momentum) * Math.log(1 + b.recentFreq + b.previousFreq) -
        Math.abs(a.momentum) * Math.log(1 + a.recentFreq + a.previousFreq) ||
        b.recentSessions - a.recentSessions ||
        a.name.localeCompare(b.name));
    return trends;
}
