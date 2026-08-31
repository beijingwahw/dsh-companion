/**
 * 前瞻记忆引擎（轴线 20）： remembering to remember——对话里的未兑现意图。
 *
 * 设计动机：认知科学区分两种记忆——回溯记忆（记住过去的事）与前瞻记忆
 * （记住将来要做的事）。全部 19 条既有轴线都在做回溯记忆；但对话中
 * 每天都在产生前瞻陈述：「明天我试试这个」「下周再优化」「回头重构」。
 * 这些意图说完即沉底，没有任何产品把它们捞起来在正确的时刻浮现——
 * 于是对话历史成了一个「说过就忘」的黑洞。
 *
 * 本模块在会话转录之上做纯本地提取与到期计算：
 *
 * - **意图提取**：句子级扫描——时间标记（明天/下周/回头/TODO…）×
 *   意图信号（试试/修复/研究…）共现，问句排除（问「怎么修」不是
 *   承诺「会修」）；
 * - **到期视界**：显式时间标记映射为天数（明天=1、下周=7、下个月=30），
 *   模糊标记（回头/以后/有空）取 7 天缺省视界；
 * - **到期浮现**：`createdAt + horizonDays <= now` 即到期，超期越久
 *   严重度越高——「5 天前你说要试试 X，做了吗？」
 *
 * 红线与前 19 轴一致：零 LLM、零网络、纯函数、隐私不出域。
 */
/** 单条提取出的意图。 */
export interface Intention {
    /** 意图句原文（截断 160 字符）。 */
    readonly text: string;
    /** 命中的时间标记原形（展示与溯源）。 */
    readonly marker: string;
    /** 到期视界（天）：会话创建后 N 天应被提醒。 */
    readonly horizonDays: number;
    /** 是否显式时间标记（明天/下周 vs 回头/以后）。 */
    readonly explicit: boolean;
}
/** 单会话意图记录（存储形状；key = sessionId）。 */
export interface IntentionRecord {
    /** 会话创建时间（到期计算基准）。 */
    readonly createdAt: number;
    /** 该会话提取出的全部意图。 */
    readonly intentions: readonly Intention[];
}
/** 到期意图视图（到期计算结果）。 */
export interface DueIntention {
    /** 会话 id（调用方填入）。 */
    readonly sessionId: string;
    /** 意图句。 */
    readonly text: string;
    /** 时间标记原形。 */
    readonly marker: string;
    /** 应到期时间（毫秒时间戳）。 */
    readonly dueAt: number;
    /** 超期天数（0 = 刚好到期）。 */
    readonly overdueDays: number;
    /** 来源会话创建时间。 */
    readonly createdAt: number;
}
/**
 * 从会话转录提取意图（句子级共现扫描）。
 *
 * 规则：句子含时间标记 + 意图动词（或独立 TODO 标记）→ 一条意图；
 * 问句排除（句尾 ？/?）；会话内按规范化文本去重。
 *
 * @param text 会话转录（formatTranscript 产物或原文）。
 */
export declare function extractIntentions(text: string): readonly Intention[];
/**
 * 计算到期意图：遍历全部记录，`createdAt + horizonDays` 已过即到期。
 *
 * @param records sessionId → 意图记录。
 * @param now 当前时间。
 * @param maxReturned 返回条数上限（缺省 20）。
 */
export declare function dueIntentions(records: ReadonlyMap<string, IntentionRecord>, now: number, maxReturned?: number): readonly DueIntention[];
/**
 * 未到期意图（即将到来）：`createdAt + horizonDays` 在未来 7 天内。
 * 与 dueIntentions 互补，构成「即将到来 / 已到期」两栏视图。
 */
export declare function upcomingIntentions(records: ReadonlyMap<string, IntentionRecord>, now: number, maxReturned?: number): readonly DueIntention[];
/** 存储读出的意图记录净化：非法记录静默丢弃。 */
export declare function sanitizeIntentionRecord(raw: unknown): IntentionRecord | undefined;
