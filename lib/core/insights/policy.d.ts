/**
 * 主动智能策略内核：为异构洞察建立稳定身份、克制通知与可逆反馈闭环。
 *
 * 本文件只做确定性的纯计算，不接触存储、HTTP 或 UI。卡片正文永不进入
 * 持久化状态；状态仅以 64 位指纹为键，避免把对话内容复制到第二份索引。
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
}
/** 策略计算结果；nextStates 交由适配层持久化。 */
export interface InsightPolicyResult {
    readonly cards: readonly ManagedInsightCard[];
    readonly notifications: readonly string[];
    readonly nextStates: ReadonlyMap<string, InsightState>;
    readonly activeIds: ReadonlySet<string>;
    readonly snoozedCount: number;
    readonly dismissedCount: number;
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
}
/** 一日毫秒数。 */
export declare const INSIGHT_DAY_MS = 86400000;
/** FNV-1a 64 位指纹：稳定、短且无需把正文写入存储键。 */
export declare function insightId(card: InsightCard): string;
/** 创建空状态；用于用户直接操作一张尚未进入 feed 的卡。 */
export declare function emptyInsightState(now: number): InsightState;
/**
 * 对卡片做去重、抑制、反馈加权、排序和通知配额计算。
 * 同一 id 的多源重复卡只保留严重度更高者；通知最多三条，但 feed 仍保留
 * 其他高优先级卡片，避免“冷却”被误实现成“藏起问题”。
 */
export declare function applyInsightPolicy(input: readonly InsightCard[], previous: ReadonlyMap<string, InsightState>, now: number, options?: InsightPolicyOptions): InsightPolicyResult;
/** 应用单条用户反馈；所有时间字段单调且动作可逆（dismiss→restore）。 */
export declare function reduceInsightFeedback(previous: InsightState | undefined, action: InsightFeedbackAction, now: number): InsightState;
/** 历史状态净化：90 天未再出现的普通状态可回收，用户忽略决定永久保留。 */
export declare function pruneInsightStates(states: ReadonlyMap<string, InsightState>, activeIds: ReadonlySet<string>, now: number): ReadonlyMap<string, InsightState>;
/** 将不可信持久化记录收窄为合法状态；损坏记录返回 undefined。 */
export declare function sanitizeInsightState(raw: unknown): InsightState | undefined;
