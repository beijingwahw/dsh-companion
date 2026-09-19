/**
 * 主题漂移检测引擎（轴线 30）：贝叶斯在线变点检测（BOCPD）。
 *
 * 设计动机：前 29 条轴线把历史当作「平铺的语料」——检索按相似度取回、
 * 知识按实体聚合，但没有一个组件回答「你的注意力**何时**从 A 主题
 * 切换到了 B 主题」。时间结构是认知的一等信息：主题段是工作记忆的
 * 「情节单元」，段边界是天然的交接点、回顾锚点、也是复习日程的
 * 自然分组。
 *
 * 本引擎把对话流建模为隐马尔可夫变点过程（Adams & MacKay 2007 的
 * 生成式精确形式）：
 *
 * - **状态**：运行长度 r_t = 当前主题段内、x_t 之前的观测单元数；
 * - **发射**：一元语言模型（Dirichlet 平滑的 unigram LM）——
 *   π_t(r) = P(x_t | 段内前 r 个单元)，词表限定为窗口内 df ≥ 2 的
 *   高频词（重复出现的词才有主题区分力，单现词是噪声）；
 * - **转移**：恒定危险率 h = 1/λ（λ = 期望段长），段内生长
 *   r → r+1 概率 1−h，变点 r → 0 概率 h；
 * - **推断**：
 *   1. 前向（α）：逐单元更新运行长度后验（归一化 log 域，数值稳定）；
 *   2. 后向（β）：log 域行归一化的反向信息向量；
 *   3. 平滑变点概率：P(变点@t | 全部数据) ∝ α_t(0)·β_t(0)——
 *      这是**回看**意义上的变点置信度，数据敏感（恒定危险率下
 *      纯前向边际 R_t(0)≡h，与数据无关，这是本实现选择精确
 *      生成式转移 + 前向后向的关键原因）；
 *   4. MAP 分段（Viterbi）：最大后验路径给出主题段切分。
 *
 * 复杂度 O(T²·|x|)（T = 窗口单元数）：相邻段历史计数用逐 r 增量
 * 维护，无 T×V 前缀矩阵；300 单元窗口在毫秒级完成。
 *
 * 产出：变点列表（置信度 + 前后段关键词 + JS 散度跳变强度）、
 * 主题段（时间范围 + 提升度关键词）、当前段长度、最近单元的
 * 「意外度」（当前主题下每词元的交叉熵，bit/token）。
 */
/** 漂移检测的观测单元：一条消息、或一个会话的摘要文本。 */
export interface DriftUnit {
    /** 单元 id（会话 id、消息 id 或任意稳定标识）。 */
    readonly id: string;
    /** 时间戳（毫秒）。 */
    readonly at: number;
    /** 文本（标题 / 首若干条消息拼接 / 实体串联——调用方决定粒度）。 */
    readonly text: string;
}
/** 漂移检测配置。 */
export interface DriftOptions {
    /** 期望段长（单元数）——危险率 λ⁻¹ 的先验；缺省 24。 */
    readonly hazardLambda?: number;
    /** Dirichlet 平滑系数；缺省 0.1。 */
    readonly alpha?: number;
    /** 滑窗单元上限；缺省 300（时间近端优先）。 */
    readonly maxUnits?: number;
    /** 入词表的最小文档频（df）；缺省 2。 */
    readonly minDf?: number;
    /** 词表容量上限（按 tf 取头部）；缺省 2048。 */
    readonly maxVocab?: number;
    /** 每段/每变点展示的关键词数；缺省 5。 */
    readonly topTerms?: number;
    /** 变点采纳阈值（平滑概率低于此值的 MAP 切分并入前段）；缺省 0.5。 */
    readonly changepointThreshold?: number;
}
/** 一次检测到的主题切换。 */
export interface DriftChangepoint {
    /** 变点单元下标（该单元是新主题段的第一个单元）。 */
    readonly index: number;
    /** 变点单元 id。 */
    readonly id: string;
    /** 变点时间戳。 */
    readonly at: number;
    /** 平滑变点概率 P(变点@t | 全部数据)。 */
    readonly probability: number;
    /** 前后段一元分布的 JS 散度（bit，0..1）——切换强度。 */
    readonly jump: number;
    /** 前一段特征词（提升度排序）。 */
    readonly beforeTerms: readonly string[];
    /** 后一段特征词。 */
    readonly afterTerms: readonly string[];
}
/** 一个主题段（两个变点之间的连续单元）。 */
export interface DriftSegment {
    /** 起止单元下标（含端点）。 */
    readonly startIndex: number;
    readonly endIndex: number;
    /** 起止时间戳。 */
    readonly startAt: number;
    readonly endAt: number;
    /** 段内单元数。 */
    readonly units: number;
    /** 段内词表内 token 总数。 */
    readonly tokenCount: number;
    /** 特征词（段内频次 × 窗口提升度）。 */
    readonly topTerms: readonly string[];
}
/** 主题漂移报告。 */
export interface DriftReport {
    /** 报告基准时间（最后单元时间戳）。 */
    readonly now: number;
    /** 窗口内单元数。 */
    readonly unitCount: number;
    /** 主题词表大小。 */
    readonly vocabSize: number;
    /** MAP 分段得到的变点（时间序）。 */
    readonly changepoints: readonly DriftChangepoint[];
    /** 主题段（与变点一致切分；至少 1 段）。 */
    readonly segments: readonly DriftSegment[];
    /** 当前段已持续单元数。 */
    readonly currentRunLength: number;
    /** 当前段特征词。 */
    readonly currentRunTopTerms: readonly string[];
    /** 最近单元在当前主题下的意外度（bit/token；高 = 偏离当前主题）。 */
    readonly lastUnitSurprise: number;
    /** 终末运行长度后验均值（单元）。 */
    readonly meanRunLength: number;
    /** 危险率（1/λ）。 */
    readonly hazard: number;
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 主题漂移检测主入口。
 *
 * @param units 观测单元（任意顺序；内部按时间稳定排序后取近端滑窗）。
 * @param options 配置（见 DriftOptions）。
 */
export declare function detectTopicDrift(units: readonly DriftUnit[], options?: DriftOptions): DriftReport;
