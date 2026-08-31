/**
 * 个体节律自适应（轴线 24）：让间隔阶梯学会你的遗忘速度。
 *
 * 设计动机：轴线 21 的固定阶梯（1/3/7/14/30/60 天）假设了一个
 * 「平均人类」的遗忘曲线——但你不是平均人类。有人过目不忘
 * （固定间隔 = 浪费时间在已巩固的知识上），有人遗忘飞快
 * （固定间隔 = 每次复习都在补已经忘光的）。学习科学的合意困难
 * 原则（Bjork）给出了最优工作点：**约 85% 的复习命中率**——
 * 难到刚好有点想不起来，又不至于全忘。
 *
 * 本模块实现一个闭环比例控制器：
 * - 每次评分更新命中样本（remembered / forgotten 计数）；
 * - 命中率高于 85% 目标 → 节律系数（ease）上调 → 间隔拉长；
 * - 命中率低于目标 → ease 下调 → 间隔压缩，抢在遗忘前巩固；
 * - ease ∈ [0.5, 2.0]，系数直接乘进轴线 21 的档位间隔。
 *
 * 闭环的自稳性：间隔拉长 → 命中率下降 → ease 回落——控制器
 * 自动收敛到 85% 命中率对应的那条「你的」遗忘曲线上。
 */
import { INTERVALS_DAYS } from './spaced.js';
/** 节律系数下限（遗忘极快：间隔压缩一半保住知识）。 */
export const EASE_MIN = 0.5;
/** 节律系数上限（记忆极牢：间隔翻倍省出注意力）。 */
export const EASE_MAX = 2;
/** 目标命中率（合意困难工作点：难到刚好，不忘光也不无聊）。 */
export const TARGET_HIT_RATE = 0.85;
/** 冷启动最小样本数：样本不足时不动 ease（避免被前两次运气带偏）。 */
export const MIN_SAMPLES = 3;
/** 比例控制增益：命中率偏差 → ease 增量的放大倍数。 */
const EASE_GAIN = 1.5;
/** 空档案（冷启动：标准曲线 + 零样本）。 */
export function emptyRhythm() {
    return { remembered: 0, forgotten: 0, ease: 1, updatedAt: null };
}
/** 命中率（0..1；零样本返回 0，由调用方在展示层规避）。 */
export function rhythmHitRate(profile) {
    const total = profile.remembered + profile.forgotten;
    if (total === 0)
        return 0;
    return profile.remembered / total;
}
/** 节律系数收敛到合法区间。 */
export function clampEase(value) {
    return Math.min(EASE_MAX, Math.max(EASE_MIN, value));
}
/**
 * 复习评分后更新节律：比例控制一步。
 * 样本不足 MIN_SAMPLES 时只计数不动系数（冷启动保护）。
 */
export function updateRhythm(profile, remembered, now) {
    const rememberedCount = profile.remembered + (remembered ? 1 : 0);
    const forgottenCount = profile.forgotten + (remembered ? 0 : 1);
    const total = rememberedCount + forgottenCount;
    let ease = profile.ease;
    if (total >= MIN_SAMPLES) {
        const hitRate = rememberedCount / total;
        ease = clampEase(profile.ease + (hitRate - TARGET_HIT_RATE) * EASE_GAIN);
    }
    return { remembered: rememberedCount, forgotten: forgottenCount, ease, updatedAt: now };
}
/**
 * 节律自适应间隔：基准天数 × ease（四舍五入，至少 1 天）。
 * ease = 1 时与固定阶梯完全一致（纯函数退化，向后兼容）。
 */
export function adaptiveIntervalDays(baseDays, ease) {
    return Math.max(1, Math.round(baseDays * ease));
}
/**
 * 投影间隔阶梯：标准档位 → 你的档位（节律报告的展示基座）。
 */
export function projectedLadder(ease) {
    return INTERVALS_DAYS.map((baseDays, stage) => ({
        stage,
        baseDays,
        adaptedDays: adaptiveIntervalDays(baseDays, ease),
    }));
}
/** 节律档案人话摘要（三向判定 + 命中率播报）。 */
export function rhythmSummary(profile) {
    const total = profile.remembered + profile.forgotten;
    if (total === 0) {
        return '尚无复习记录——间隔按标准遗忘曲线调度（冷启动中）';
    }
    const pct = Math.round(rhythmHitRate(profile) * 100);
    if (profile.ease >= 1.05) {
        return `记忆节律 ×${profile.ease.toFixed(2)}——你比标准曲线记得牢（命中率 ${pct}%），间隔已自动拉长 ${Math.round((profile.ease - 1) * 100)}%`;
    }
    if (profile.ease <= 0.95) {
        return `记忆节律 ×${profile.ease.toFixed(2)}——遗忘比标准曲线快（命中率 ${pct}%），间隔已自动压缩 ${Math.round((1 - profile.ease) * 100)}% 保住知识`;
    }
    return `记忆节律 ×${profile.ease.toFixed(2)}——与标准遗忘曲线基本一致（命中率 ${pct}%，样本 ${total} 次）`;
}
/** 存储读出的节律档案净化：计数非法整体丢弃；ease 越界收敛修复。 */
export function sanitizeRhythmProfile(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const profile = raw;
    if (typeof profile.remembered !== 'number' ||
        !Number.isInteger(profile.remembered) ||
        profile.remembered < 0) {
        return undefined;
    }
    if (typeof profile.forgotten !== 'number' ||
        !Number.isInteger(profile.forgotten) ||
        profile.forgotten < 0) {
        return undefined;
    }
    if (typeof profile.ease !== 'number' || !Number.isFinite(profile.ease))
        return undefined;
    const updatedAt = typeof profile.updatedAt === 'number' &&
        Number.isFinite(profile.updatedAt) &&
        profile.updatedAt > 0
        ? profile.updatedAt
        : null;
    return {
        remembered: profile.remembered,
        forgotten: profile.forgotten,
        ease: clampEase(profile.ease),
        updatedAt,
    };
}
