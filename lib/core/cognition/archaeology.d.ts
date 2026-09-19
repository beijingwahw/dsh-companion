/**
 * 知识考古引擎（轴线 32「板块构造学」）：时间切片回放知识大陆的形成史。
 *
 * 设计动机：轴线 26「知识大陆」回答"我的知识版图**现在**长什么样"——
 * 全量语料一次性 Louvain，得到一张静态地图。但知识是**长出来的**：
 * 三个月前还在密集讨论 docker 网络，后来分裂成 k8s 与 service mesh 两块，
 * 上个月又冒出一块全新的 rust 大陆。轴线 32 回答地图回答不了的问题——
 * "**这块版图是怎么演化的**"：
 *
 * - **时间切片**：会话流按序均分为 W 个「纪元」（index 均分而非按日历
 *   均分——活动稀疏期不会产生只有 1 个会话的空窗口）；
 * - **逐纪元大陆发现**：每个纪元内独立构建实体共现图 + Louvain 社区
 *   发现（复用轴线 26 同源算法，参数一致保证可比性）；
 * - **血脉匹配**：相邻纪元的社区按成员实体键集合算 Jaccard，重叠
 *   ≥ 阈值即建立血脉边；
 * - **板块事件分类**：
 *   - `birth` 新生——某纪元的社区无前置血脉（新知识域形成）；
 *   - `continuation` 延续——一对一血脉（同一块大陆存活到下一纪元）；
 *   - `split` 分裂——一个旧社区的主要成员流向 ≥2 个新社区
 *     （关注点分化，如 docker 网络分化出 k8s service 与 istio）；
 *   - `merge` 合并——≥2 个旧社区的血脉汇入同一新社区
 *     （此前分散的主题收拢成一块大陆）；
 *   - `dissolve` 消亡——某纪元的社区在下一纪元无任何血脉
 *     （知识域沉没：换工作/换技术栈/问题已解决）。
 *
 * 与轴线 30「主题漂移」的分工：漂移在**会话流**上逐会话检测注意力
 * 切换点（BOCPD），考古在**纪元间**检测知识**域**的结构性变迁
 * （社区级 birth/split/merge/dissolve）——漂移看浪，考古看洋流。
 *
 * 纯本地、零 LLM、零网络；纯函数、无状态、确定性。
 */
/** 考古输入：单会话的最小投影（实体倒排索引反查，零转录重读）。 */
export interface ArchaeologySession {
    /** 会话 id。 */
    readonly id: string;
    /** 会话创建时间（毫秒）。 */
    readonly at: number;
    /** 该会话出现的实体键列表（`<type>:<小写名>`；重复自动去重）。 */
    readonly entityKeys: readonly string[];
}
/** 考古参数。 */
export interface ArchaeologyOptions {
    /** 纪元数（时间切片数）；缺省 4，实际取 min(请求值, floor(会话数/2))，下限 2。 */
    readonly windows?: number;
    /** 血脉匹配的成员 Jaccard 阈值；缺省 0.3。 */
    readonly lineageThreshold?: number;
    /** 参与事件分析的社区最小成员数；缺省 2（单实体社区不构成"大陆"）。 */
    readonly minContinentSize?: number;
}
/** 板块事件类型。 */
export type PlateEventKind = 'birth' | 'continuation' | 'split' | 'merge' | 'dissolve';
/** 一次板块事件（相邻纪元间的社区血脉变迁）。 */
export interface PlateEvent {
    readonly kind: PlateEventKind;
    /** 源纪元下标（dissolve 为消亡前所在纪元；birth 无源，为 -1）。 */
    readonly fromWindow: number;
    /** 目标纪元下标（dissolve 无目标，为 -1）。 */
    readonly toWindow: number;
    /** 涉及社区的代表实体（并集按度数近似取头部）。 */
    readonly topEntities: readonly string[];
    /** 血脉强度（成员 Jaccard；split/merge 取最强分支；birth/dissolve 恒 0）。 */
    readonly strength: number;
    /** 人话描述。 */
    readonly description: string;
}
/** 单个纪元的大陆快照。 */
export interface EraWindow {
    /** 纪元下标（0 起，时间升序）。 */
    readonly index: number;
    /** 纪元内会话数。 */
    readonly sessions: number;
    /** 纪元起止时间（毫秒；首纪元起点即最早会话时间）。 */
    readonly fromAt: number;
    readonly toAt: number;
    /** 该纪元实体图规模。 */
    readonly entities: number;
    readonly edges: number;
    /** 该纪元模块度 Q。 */
    readonly modularity: number;
    /** 该纪元的大陆（按成员数降序；含成员键供前端联动）。 */
    readonly continents: ReadonlyArray<{
        readonly id: number;
        readonly size: number;
        readonly sessionCount: number;
        readonly topEntities: readonly string[];
        readonly memberKeys: readonly string[];
    }>;
}
/** 考古报告。 */
export interface ArchaeologyReport {
    /** 纪元快照（时间升序；样本不足时为空）。 */
    readonly windows: readonly EraWindow[];
    /** 板块事件（按目标纪元升序）。 */
    readonly events: readonly PlateEvent[];
    /** 事件计数。 */
    readonly stats: {
        readonly windows: number;
        readonly births: number;
        readonly continuations: number;
        readonly splits: number;
        readonly merges: number;
        readonly dissolves: number;
    };
    /** 人话摘要。 */
    readonly summary: string;
}
/** 构造主入口：知识考古（板块事件挖掘）。 */
export declare function excavateKnowledge(sessions: readonly ArchaeologySession[], options?: ArchaeologyOptions): ArchaeologyReport;
