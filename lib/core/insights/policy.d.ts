/**
 * 主动智能策略内核 v2：分层抑制 + 效用学习 + 节律感知。
 *
 * v1（policy.ts）解决了「同源去重 + 冷却 + 可逆反馈」；但它把所有
 * 洞察拍平成「严重度权重 + 固定反馈增量」的一维优先级。真实世界的
 * 主动智能有三层被忽略的结构：
 *
 * 1. **语义抑制（semantic suppression）**：两条洞察来自不同 Provider、
 *    严重度不同，但讲的是**同一件事**（「5 条知识正在滑落」与
 *    「今日复习 5 条」）。v1 只能按指纹去重，语义重复会同时刷屏。
 *    本层用**词元 Jaccard + 主题锚重叠**做跨源近似重复检测——同一
 *    主题的冗余卡片只保留信息密度最高的一条，其余计入 `mergedCount`。
 *
 * 2. **效用学习（utility learning）**：v1 的反馈只做 ±60/−80 的固定
 *    偏移。真正的主动智能要学「**这个信号源历史上被我如何对待**」：
 *    同一 source 的 helpful/dismiss 比例应当影响该源**整体**的排序与
 *    通知资格——一个总被忽略的源应当自动降权，而不是靠用户逐条忽略。
 *    本层维护 per-source 的 Beta 后验（helpful = 成功，dismiss/unhelpful
 *    = 失败），用 Thompson 式乐观下界（Wilson 置信下界）作为源的
 *    可信度乘子——小样本保守、样本充足后收敛到真实比率。
 *
 * 3. **节律感知（rhythm awareness）**：通知的打扰成本不是常数。深夜、
 *    周末、用户刚刚连续忽略的时刻，同样严重度的卡片打扰成本更高。
 *    v1 的冷却时间是固定的墙钟时长。本层引入**注意力窗口**：把
 *    严重度映射为「可打扰等级」，把时刻映射为「窗口开放度」，
 *    二者共同决定通知资格；feed 本身永不被节律抑制（用户主动打开
 *    面板时永远看到全部信号，克制只作用于推送）。
 *
 * 纯函数、无状态、确定性（同输入同输出）。本文件只做计算，不接触
 * 存储、时钟或网络——时间由调用方以 `now` 注入。
 */
import type { InsightActionId, InsightCard, InsightSeverity } from './pulse.js';
export type { InsightActionId } from './pulse.js';
/** 用户对单条洞察的显式反馈。 */
export type InsightFeedback = 'helpful' | 'unhelpful';
/** 洞察处理结果；resolved/dismissed 会退出当前 feed。 */
export type InsightOutcome = 'acted' | 'resolved' | 'dismissed';
/** 可持久化的洞察状态（不含正文与查询原文）。 */
export interface InsightState {
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
    readonly lastNotifiedAt?: number;
    readonly lastNotifiedSeverity?: InsightSeverity;
    readonly acknowledgedAt?: number;
    readonly snoozeUntil?: number;
    readonly dismissed: boolean;
    readonly notificationCount: number;
    readonly feedback?: InsightFeedback;
    readonly outcome?: InsightOutcome;
    readonly updatedAt: number;
}
/** 携带稳定身份与用户反馈元数据的主动洞察卡片。 */
export interface ManagedInsightCard extends InsightCard {
    readonly id: string;
    readonly priority: number;
    readonly unread: boolean;
    readonly firstSeenAt: number;
    readonly lastNotifiedAt?: number;
    readonly notificationCount: number;
    readonly feedback?: InsightFeedback;
    readonly outcome?: InsightOutcome;
    readonly actionId?: InsightActionId;
    /** 语义抑制：本卡是合并后的代表（吸收了 merged 张同主题卡）。 */
    readonly mergedCount?: number;
    /** 本卡被合并进其它代表（不单独出现在 feed）。 */
    readonly mergedInto?: string;
    /** 效用学习：产生本卡的信号源可信度（Wilson 下界，[0,1]）。 */
    readonly sourceTrust?: number;
    /** 节律感知：本次是否因节律窗口关闭而未推送（feed 仍展示）。 */
    readonly rhythmSuppressed?: boolean;
}
/** 策略计算结果；nextStates 交由适配层持久化。 */
export interface InsightPolicyResult {
    readonly cards: readonly ManagedInsightCard[];
    readonly notifications: readonly string[];
    readonly nextStates: ReadonlyMap<string, InsightState>;
    readonly activeIds: ReadonlySet<string>;
    readonly snoozedCount: number;
    readonly dismissedCount: number;
    /** 被语义抑制合并掉的卡片数（跨源同主题冗余）。 */
    readonly mergedCount: number;
    /** 因节律窗口关闭而未推送的卡片数（仍在 feed 中可见）。 */
    readonly rhythmSuppressedCount: number;
    /** 各信号源的可信度快照（供诊断端点与 UI 解释）。 */
    readonly sourceTrust: ReadonlyMap<string, number>;
}
/** 主动反馈动作；restore 只恢复单条，restore-all 由 Center 展开。 */
export type InsightFeedbackAction = 'acknowledge' | 'snooze' | 'dismiss' | 'restore' | 'helpful' | 'unhelpful' | 'acted' | 'resolved';
/** 策略参数均有保守默认值，调用方可为测试显式固定。 */
export interface InsightPolicyOptions {
    readonly maxCards?: number;
    readonly maxNotifications?: number;
    readonly criticalCooldownMs?: number;
    readonly watchCooldownMs?: number;
    readonly infoCooldownMs?: number;
    /** 语义抑制：两卡主题词元 Jaccard 超过此值即视为同主题。 */
    readonly semanticMergeThreshold?: number;
    /** 语义抑制：参与比较的词元数上限（防超长正文拖慢 O(n²)）。 */
    readonly semanticMergeMaxTerms?: number;
    /** 效用学习：Beta 先验的伪计数（成功/失败各一份，冷启动居中）。 */
    readonly trustPriorSuccess?: number;
    readonly trustPriorFailure?: number;
    /** 效用学习：可信度乘子的下限（避免样本极少时把源打死）。 */
    readonly trustFloor?: number;
    /** 节律感知：本地小时数 → 窗口开放度 [0,1]；缺省全开放。 */
    readonly attentionWindow?: (hourOfDay: number, dayOfWeek: number) => number;
    /** 节律感知：静默窗口下的最高可打扰等级（缺省 watch：critical 仍可推）。 */
    readonly quietMaxSeverity?: InsightSeverity;
}
/** 一日毫秒数。 */
export declare const INSIGHT_DAY_MS = 86400000;
/** FNV-1a 64 位指纹：稳定、短且无需把正文写入存储键。 */
export declare function insightId(card: InsightCard): string;
/** 创建空状态；用于用户直接操作一张尚未进入 feed 的卡。 */
export declare function emptyInsightState(now: number): InsightState;
/** 语义合并分组结果。 */
interface SemanticGroup {
    /** 代表卡（信息密度最高者：严重度 > 文本长度 > 指纹序）。 */
    readonly representative: InsightCard;
    /** 被吸收的卡片。 */
    readonly absorbed: readonly InsightCard[];
}
/**
 * 跨源同主题合并：把「讲同一件事」的多张卡片折叠成一张代表卡。
 *
 * 代表选择：严重度最高者（信息价值上限）；同严重度取正文更长者
 * （信息密度更高）；再同则取指纹字典序最小者（全序确定性）。
 * 被吸收的卡片计入 mergedCount，不进入 feed——用户看到的是一条
 * 合并后的洞察，而不是三条同一主题的刷屏。
 */
export declare function mergeSemanticDuplicates(cards: readonly InsightCard[], threshold?: number, maxTerms?: number): readonly SemanticGroup[];
/** 单个信号源的反馈计数（持久化派生，不入状态表）。 */
export interface SourceFeedbackCounts {
    helpful: number;
    unhelpful: number;
    dismissed: number;
}
/**
 * 信号源可信度：Wilson 置信下界（z = 1.0，约 68% 置信水平）。
 *
 * 成功 = helpful 计数；失败 = unhelpful + dismissed 计数（忽略是比
 * 「无用」更强的负信号，但不额外加权——二者都是「这条不该出现」）。
 * 加 Beta 先验伪计数（缺省各 1）保证冷启动有定义且偏保守。
 * 返回 [trustFloor, 1]，trustFloor 缺省 0.15——即使一个源被持续忽略，
 * 也保留 15% 的排序权重：不永久静音，留出「新类型的信号突然变好」
 * 的自愈通道。
 */
export declare function sourceTrust(counts: SourceFeedbackCounts | undefined, options?: InsightPolicyOptions): number;
/**
 * 对卡片列表做去重、语义合并、抑制、反馈加权、效用加权、排序和通知配额计算。
 *
 * 与 v1 的差别：
 * - 语义合并把跨源同主题卡折叠为一张（mergedCount 可观测）；
 * - 排序权重乘以 sourceTrust（per-source Wilson 下界）；
 * - 通知资格额外受节律窗口调制（feed 不受影响）。
 */
export declare function applyInsightPolicy(input: readonly InsightCard[], previous: ReadonlyMap<string, InsightState>, now: number, options?: InsightPolicyOptions, sourceFeedback?: ReadonlyMap<string, SourceFeedbackCounts>): InsightPolicyResult;
/** 应用单条用户反馈；所有时间字段单调且动作可逆（dismiss→restore）。 */
export declare function reduceInsightFeedback(previous: InsightState | undefined, action: InsightFeedbackAction, now: number): InsightState;
/** 历史状态净化：90 天未再出现的普通状态可回收，用户忽略决定永久保留。 */
export declare function pruneInsightStates(states: ReadonlyMap<string, InsightState>, activeIds: ReadonlySet<string>, now: number): ReadonlyMap<string, InsightState>;
/**
 * 从持久化状态派生 per-source 反馈计数（效用学习的输入）。
 *
 * 状态表以指纹为键、不保存 source；因此本函数要求调用方提供
 * 「指纹 → source」的映射（Center 在每次刷新时从当前卡片重建）。
 */
export declare function aggregateSourceFeedback(states: ReadonlyMap<string, InsightState>, sourceOf: ReadonlyMap<string, string>): Map<string, SourceFeedbackCounts>;
/** 将不可信持久化记录收窄为合法状态；损坏记录返回 undefined。 */
export declare function sanitizeInsightState(raw: unknown): InsightState | undefined;
