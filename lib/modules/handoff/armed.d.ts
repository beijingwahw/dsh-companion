/**
 * 交接摘要武装存储：companion 存储域 `handoff-armed` 表 + 投递回执
 * `handoff-receipts` 表。
 *
 * 键为会话 ID 或特殊键 `__pending__`（武装给“下一个新对话”）；
 * 记录形状 `{ summary, armedAt, knownSessions?, expiresAt? }`。
 * 被系统提示词装配（同步）与 HTTP/命令（异步）共同消费。
 *
 * 世代门闩（generation latch）：pending 记录携带武装时刻的已知会话 ID
 * 快照（knownSessions）——装配回调只向「快照之外」的会话投递摘要，
 * 旧会话无论怎么重建都在快照内，天然免疫误投递；无需宿主新增钩子。
 * 记录带 expiresAt 过期时间，超时未投递自动作废（防僵尸注入）。
 * 投递成功写入回执（receipts 表，按会话去重、滚动保留最近若干条），
 * dock 由此可展示「已注入会话 X」而非无声消失。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
/** pending 武装的存储键：摘要将注入下一个新对话。 */
export declare const PENDING_KEY = "__pending__";
/** 武装记录：摘要正文 + 武装时间戳（毫秒）+ 世代门闩字段。 */
export interface ArmedRecord {
    summary: string;
    armedAt: number;
    /**
     * 世代门闩：武装时刻已存在的会话 ID 快照（仅 pending 记录携带）。
     * 缺省（旧格式记录）回退 v0.1 近似：注入下一次系统提示词装配。
     */
    knownSessions?: readonly string[];
    /** 过期时间戳（毫秒）；超过后未投递的记录自动作废。 */
    expiresAt?: number;
}
/** 武装列表条目；sessionId 为 null 表示 pending（武装给下一个新对话）。 */
export interface ArmedEntry {
    sessionId: string | null;
    summary: string;
    armedAt: number;
}
/** 投递回执：pending 摘要已注入哪个会话。 */
export interface ReceiptRecord {
    sessionId: string;
    injectedAt: number;
}
/** 武装选项（世代门闩参数）。 */
export interface ArmOptions {
    /** 武装时刻的已知会话 ID 快照；仅 pending 武装需要。 */
    knownSessions?: readonly string[];
    /** 有效期（毫秒）；超时未投递自动作废。 */
    ttlMs?: number;
}
/** 交接摘要武装存储。 */
export declare class ArmedStore {
    private readonly table;
    private readonly receipts;
    /** 在已打开的 companion 存储域上创建。 */
    constructor(domain: Domain);
    /**
     * 武装摘要；sessionId 为 null 时武装给下一个新对话（pending，同键覆盖）。
     * pending 武装可携带世代快照与有效期（详见文件头注释）。
     */
    arm(sessionId: string | null, summary: string, options?: ArmOptions): Promise<void>;
    /** 解除武装；sessionId 为 null 时解除 pending。不存在时静默成功。 */
    disarm(sessionId: string | null): Promise<void>;
    /** 作废过期的 pending 武装（装配回调发现超时后调用）。 */
    expirePending(): Promise<void>;
    /** 列出当前全部武装（同步读）；特定会话按武装时间升序，pending 排在最后。 */
    list(): ArmedEntry[];
    /** 读取 pending 武装记录（同步读）；不存在返回 undefined。 */
    peekPending(): ArmedRecord | undefined;
    /**
     * 消费 pending 武装：删除并返回摘要；不存在返回 undefined。
     * 用一次 table.update 原子地读取并删除（回调返回 undefined 即删除该键），
     * 避免 get→await delete 的间隙中新武装的摘要被误删。
     * @param expect 身份校验（armedAt + summary）：记录在 peek 与消费之间
     * 被新武装覆盖时不误删新记录（返回 undefined，新记录留给后续装配投递）。
     */
    consumePending(expect?: {
        armedAt: number;
        summary: string;
    }): Promise<string | undefined>;
    /** 写入投递回执（按会话覆盖），并滚动修剪到最近 RECEIPT_KEEP_LIMIT 条。 */
    writeReceipt(sessionId: string): Promise<void>;
    /** 列出投递回执（按注入时间降序，同步读）。 */
    listReceipts(): ReceiptRecord[];
}
