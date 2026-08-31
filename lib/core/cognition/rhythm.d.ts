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
/** 节律档案（存储形状；单记录，键 = 'profile'）。 */
export interface RhythmProfile {
    /** 评分「记得」的累计次数。 */
    readonly remembered: number;
    /** 评分「忘了」的累计次数。 */
    readonly forgotten: number;
    /** 节律系数（间隔乘子；1 = 标准曲线）。 */
    readonly ease: number;
    /** 最近一次评分时间（null = 从未评分）。 */
    readonly updatedAt: number | null;
}
/** 节律系数下限（遗忘极快：间隔压缩一半保住知识）。 */
export declare const EASE_MIN = 0.5;
/** 节律系数上限（记忆极牢：间隔翻倍省出注意力）。 */
export declare const EASE_MAX = 2;
/** 目标命中率（合意困难工作点：难到刚好，不忘光也不无聊）。 */
export declare const TARGET_HIT_RATE = 0.85;
/** 冷启动最小样本数：样本不足时不动 ease（避免被前两次运气带偏）。 */
export declare const MIN_SAMPLES = 3;
/** 空档案（冷启动：标准曲线 + 零样本）。 */
export declare function emptyRhythm(): RhythmProfile;
/** 命中率（0..1；零样本返回 0，由调用方在展示层规避）。 */
export declare function rhythmHitRate(profile: RhythmProfile): number;
/** 节律系数收敛到合法区间。 */
export declare function clampEase(value: number): number;
/**
 * 复习评分后更新节律：比例控制一步。
 * 样本不足 MIN_SAMPLES 时只计数不动系数（冷启动保护）。
 */
export declare function updateRhythm(profile: RhythmProfile, remembered: boolean, now: number): RhythmProfile;
/**
 * 节律自适应间隔：基准天数 × ease（四舍五入，至少 1 天）。
 * ease = 1 时与固定阶梯完全一致（纯函数退化，向后兼容）。
 */
export declare function adaptiveIntervalDays(baseDays: number, ease: number): number;
/**
 * 投影间隔阶梯：标准档位 → 你的档位（节律报告的展示基座）。
 */
export declare function projectedLadder(ease: number): ReadonlyArray<{
    stage: number;
    baseDays: number;
    adaptedDays: number;
}>;
/** 节律档案人话摘要（三向判定 + 命中率播报）。 */
export declare function rhythmSummary(profile: RhythmProfile): string;
/** 存储读出的节律档案净化：计数非法整体丢弃；ease 越界收敛修复。 */
export declare function sanitizeRhythmProfile(raw: unknown): RhythmProfile | undefined;
