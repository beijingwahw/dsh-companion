/**
 * 结构洞掮客引擎（轴线 36「跨域翻译者识别」）：知识图谱上承载跨域
 * 翻译的桥梁实体检测（Burt 2004, "Structural Holes and Good Ideas"）。
 *
 * 设计动机：轴线 26「知识大陆」把共现图切成知识域，轴线 27 沿已有边
 * 扩散引力，轴线 34 预测缺失边——三者都没有回答一个关键问题：
 * **哪些实体是两块大陆之间的桥梁？** 现实的知识图里最被低估的资产
 * 是「掮客」实体：它不深入任何一块大陆的腹地，却同时与多块大陆的
 * 骨干共现——docker compose 同时连着前端构建域与运维部署域，
 * 「类型」这个词同时出现在类型论与 TypeScript 语境。Burt 2004 的
 * 经验发现：**跨越结构洞的人 disproportionately 地产生好想法**——
 * 他们同时暴露在多个领域的词汇与解法下，做的正是「跨域翻译」。
 * 这些实体是知识宇宙里的海峡：自己不是大陆，却让两块大陆通航。
 *
 * 两套互补的经典测量：
 *
 * - **Burt 结构洞测量**（Burt 1992 网络约束，2004 作为掮客的操作化）：
 *   - 网络约束 `C_i = Σ_j (p_ij + Σ_q p_iq·p_qj)²`——p 为边权行归一
 *     比例，直接项 p_ij 是 i 在 j 上的投入占比，间接项 Σ p_iq·p_qj
 *     是「经其他接触 q 绕到 j 的冗余投入」；约束越高 = 接触彼此抱团、
 *     跨的洞越少。**低约束 = 跨结构洞的掮客**；
 *   - 有效规模 `e_i = Σ_j (1 − Σ_q p_iq·m_jq)`——接触 j 的冗余折扣
 *     （m_jq 为 j 除回指 i 外的边权归一，Burt 原始冗余公式）；
 *     效率 = 有效规模 / 度数；
 * - **Gould-Fernandez 掮客角色**（Gould & Fernandez 1989）：以轴线 26
 *   同源 Louvain 大陆为分组，对 i 的每个有序接触对 (j→k) 分类五角色：
 *   协调 coordinator（三方同组）／顾问 consultant（j、k 同组，i 异组
 *   ——外请的翻译）／代表 representative（i、j 同组，k 异组——对外
 *   发声）／守门 gatekeeper（i、k 同组，j 异组——引进外部）／
 *   联络 liaison（三方三组——纯跨域桥）。无向图上守门与代表互为
 *   镜像（每个跨组无序对各计一次），这是 GF 分类在无向图上的已知
 *   对称性。**跨域翻译 = 非协调中介对**（totalPairs − coordinator）。
 *
 * 掮客分 = 0.5 × 洞分 + 0.3 × 跨域占比 + 0.2 × 规模分（候选集内归一）：
 * 低约束给洞分，跨组中介对占比给跨域占比，log 中介对量给规模分——
 * 一个只在单块大陆内当枢纽的实体跨域占比为零，一个只连两条边的
 * 微型桥规模不足，融合分同时要求「跨得开」与「扛得起」。
 *
 * 与相邻轴线的分工：大陆（26）切块，星图（27）沿已有边走，暗物质
 * （34）找该连未连的边，本轴识别**已经在承载跨域流量**的实体。
 * 掮客是双刃剑：跨域翻译的枢纽（Burt：好想法的来源），也是单点
 * 失效——掮客遗忘，两域失联。行动出口：掮客实体值得优先巩固
 * （轴线 21/23 复习优先级参考）。
 *
 * 守卫：掮客候选须度数 ≥ 2（单接触无从中介）；中介对展开设预算熔断
 * 防御病态稠密图；分组可选（缺省全库单组——五角色退化为纯协调计数，
 * 报告标注 groupCount 供前端提示）。纯本地、零 LLM、零网络；确定性输出。
 */
import type { EntityGraph } from '../graph/graph.js';
/** 掮客扫描参数。 */
export interface BrokerageOptions {
    /** 返回条数上限；缺省 15。 */
    readonly topK?: number;
    /** 分组表（实体键 → 组 id；轴线 26 Louvain 大陆的投影）；缺省全库单组。 */
    readonly groups?: ReadonlyMap<string, number>;
    /** 掮客候选的最小度数；缺省 2（单接触无从中介）。 */
    readonly minDegree?: number;
    /** 中介对展开预算（防御病态稠密图）；缺省 500_000。 */
    readonly pairBudget?: number;
}
/** Gould-Fernandez 五类掮客角色计数（有序中介对口径）。 */
export interface BrokerageRoles {
    /** 协调：三方同组（组内调解）。 */
    readonly coordinator: number;
    /** 顾问：j、k 同组，i 异组（外请的翻译）。 */
    readonly consultant: number;
    /** 代表：i、j 同组，k 异组（对外发声）。 */
    readonly representative: number;
    /** 守门：i、k 同组，j 异组（引进外部）。 */
    readonly gatekeeper: number;
    /** 联络：三方三组（纯跨域桥）。 */
    readonly liaison: number;
}
/** 一位掮客（承载跨域翻译的桥梁实体）。 */
export interface BrokerNode {
    /** 实体唯一键（`<type>:<小写名>`，供前端联动检索）。 */
    readonly key: string;
    /** 展示名。 */
    readonly name: string;
    /** 实体类型。 */
    readonly type: string;
    /** 度数（接触数）。 */
    readonly degree: number;
    /** Burt 有效规模（冗余折扣后的接触当量）。 */
    readonly effectiveSize: number;
    /** 效率 = 有效规模 / 度数，[0,1]。 */
    readonly efficiency: number;
    /** Burt 网络约束（越低 = 跨的结构洞越多）。 */
    readonly constraint: number;
    /** 五角色计数。 */
    readonly roles: BrokerageRoles;
    /** 有序中介对总数 = Σ deg·(deg−1)。 */
    readonly totalPairs: number;
    /** 跨组中介对数（totalPairs − coordinator）。 */
    readonly crossGroupPairs: number;
    /** 跨组中介对占比，[0,1]。 */
    readonly crossShare: number;
    /** 融合掮客分 [0,1]。 */
    readonly score: number;
    /** 人话解读。 */
    readonly interpretation: string;
}
/** 掮客报告。 */
export interface BrokerageReport {
    /** 图规模。 */
    readonly graph: {
        nodes: number;
        edges: number;
    };
    /** 图内节点覆盖的分组数（1 = 无分组/单组，跨域角色退化）。 */
    readonly groupCount: number;
    /** 掮客候选数（度数达标的实体）。 */
    readonly candidates: number;
    /** 是否触达中介对预算熔断。 */
    readonly budgetExhausted: boolean;
    /** 掮客清单（按融合分降序，封顶 topK）。 */
    readonly brokers: readonly BrokerNode[];
    /** 人话摘要。 */
    readonly summary: string;
}
/**
 * 结构洞掮客主入口：识别承载跨域翻译的桥梁实体。
 *
 * @param graph 实体共现图（轴线 26 同源 buildEntityGraph 产物）。
 * @param options 参数（见 BrokerageOptions）。
 */
export declare function detectBrokerage(graph: EntityGraph, options?: BrokerageOptions): BrokerageReport;
