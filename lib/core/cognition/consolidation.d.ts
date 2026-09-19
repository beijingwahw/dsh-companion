/**
 * 记忆固化引擎（轴线 31）：MinHash-LSH 近重复检测与知识固化。
 *
 * 设计动机：同一个问题会在不同会话里反复出现——报错换了个文件名
 * 又来一遍、相似的配置改个参数再问一次。对人类记忆，重复接触是
 * **强化**信号（间隔重复的天然燃料）；对机器记忆，未合并的重复是
 * **污染**（检索结果同质化、复习清单冗余、知识库虚胖）。本引擎把
 * 「重复」从噪声变成资产：
 *
 * - **MinHash 签名**：token 集合压缩为固定长度（128 维）的最小哈希
 *   签名，签名期望相似度 = Jaccard 相似度——O(1) 估计集合重合度；
 * - **LSH 分带**：签名切 16 带 × 8 行，任一带相等即候选对——
 *   S 曲线阈值 ≈ (1/16)^(1/8) ≈ 0.71，把 O(n²) 配对压到近线性，
 *   且召回率在阈值以上接近 1；
 * - **精确验证**：候选对回退到真实 token 集合算 Jaccard（签名只是
 *   候选生成器，判定用真值）；
 * - **并查集聚类**：通过验证的候选对传递归并成簇（近重复的近重复
 *   也是近重复——知识以连通分量固化）；
 * - **固化计划**：每簇选代表（信息量最大：token 数优先，新近优先），
 *   报告重复次数（强化度）、首末出现时间、簇内成员——重复 N 次
 *   的知识天然值得更高的复习优先级（喂给轴线 21/23 的强化信号）。
 *
 * 纯函数、无状态、确定性（哈希种子固定）：同一输入同一计划。
 */
/** 待固化的记忆项（一条「问题→解法」片段、一条消息或一个会话摘要）。 */
export interface ConsolidationItem {
    /** 项 id（episodeId / sessionId / 任意稳定标识）。 */
    readonly id: string;
    /** 文本（问题面或问题+解法的拼接——调用方决定固化粒度）。 */
    readonly text: string;
    /** 时间戳（毫秒；缺省 0，仅影响代表选择与首末时间）。 */
    readonly at?: number;
}
/** 固化配置。 */
export interface ConsolidationOptions {
    /** 归簇的 Jaccard 阈值；缺省 0.65。 */
    readonly jaccardThreshold?: number;
    /** MinHash 签名长度；缺省 128（须为 bands × rows）。 */
    readonly signatureSize?: number;
    /** LSH 带数；缺省 16。 */
    readonly bands?: number;
    /** 每带行数；缺省 8。 */
    readonly rows?: number;
    /** 项数上限（近端优先截断）；缺省 5000。 */
    readonly maxItems?: number;
}
/** 一个近重复簇（同一知识的多次出现）。 */
export interface ConsolidationCluster {
    /** 代表项 id（信息量最大者）。 */
    readonly representativeId: string;
    /** 全部成员 id（含代表，时间序）。 */
    readonly memberIds: readonly string[];
    /** 出现次数（= 成员数；间隔重复意义上的强化度）。 */
    readonly reinforcement: number;
    /** 首次出现时间。 */
    readonly firstSeenAt: number;
    /** 最近出现时间。 */
    readonly lastSeenAt: number;
    /** 簇内成员与代表 token 集合的平均 Jaccard（紧致度）。 */
    readonly cohesion: number;
}
/** 固化计划。 */
export interface ConsolidationPlan {
    /** 参与固化的项数。 */
    readonly items: number;
    /** 近重复簇（≥ 2 成员，按强化度降序）。 */
    readonly clusters: readonly ConsolidationCluster[];
    /** 被折叠的重复项总数（成员数 − 簇数）。 */
    readonly duplicates: number;
    /** 唯一项数（单成员）。 */
    readonly unique: number;
    /** 压缩率（duplicates / items；0 = 无重复）。 */
    readonly compression: number;
    /** 人话摘要。 */
    readonly summary: string;
}
/** 两个 token 集合的真实 Jaccard 相似度。 */
export declare function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
/**
 * MinHash 签名：token 集合 → 长度 k 的 32 位哈希序列。
 * 双重哈希（h_i(x) = h1(x) + (i+1)·h2(x)，乘法混合）避免每维独立
 * 哈希的 k 倍开销；期望签名相似度 = Jaccard。
 */
export declare function minhashSignature(terms: ReadonlySet<string>, size: number): Int32Array;
/** 签名估计的 Jaccard（相等维度占比）。 */
export declare function estimatedJaccard(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number;
/**
 * 记忆固化主入口：近重复检测 + 聚类 + 固化计划。
 *
 * @param items 记忆项（任意顺序；内部按 id 稳定排序）。
 * @param options 配置（见 ConsolidationOptions）。
 */
export declare function consolidateMemories(items: readonly ConsolidationItem[], options?: ConsolidationOptions): ConsolidationPlan;
