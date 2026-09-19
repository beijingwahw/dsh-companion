/** 特征名（固定六维，全部归一到 [0,1]）。 */
export type RankerFeatureName = 'lexicalRank' | 'semanticRank' | 'recency' | 'feedback' | 'titleMatch' | 'bias';
/** 全部特征（展示与诊断顺序）。 */
export declare const RANKER_FEATURES: readonly RankerFeatureName[];
/** 推断微调封顶（±30%：与反馈加成同量级的温和先验）。 */
export declare const RANKER_NUDGE_CAP = 0.3;
/** 暖机目标更新次数（此前按比例退火学习影响）。 */
export declare const RANKER_WARMUP_TARGET = 50;
/** 特征向量（键与 RANKER_FEATURES 对齐，值域 [0,1]）。 */
export type RankerFeatures = Readonly<Record<RankerFeatureName, number>>;
/** 模型持久化形状（companion 域 retrieval-ranker 表单记录）。 */
export interface RankerModel {
    /** 惰性权重状态 z（FTRL-Proximal 累积器）。 */
    readonly z: Readonly<Record<string, number>>;
    /** 逐坐标梯度平方累积 n。 */
    readonly n: Readonly<Record<string, number>>;
    /** 累计参数更新次数（暖机基准）。 */
    readonly updates: number;
    /** 累计点击数（训练事件数）。 */
    readonly clicks: number;
    /** 累计训练样本数（正例 + 负例）。 */
    readonly examples: number;
    /** 最近训练时间（毫秒时间戳）。 */
    readonly trainedAt: number;
}
/** 特征构造输入（训练与推断共用，保证两态特征一致）。 */
export interface RankerFeatureInput {
    /** 引擎词法排名（1 起；未入词法候选池可缺省）。 */
    readonly lexicalRank?: number;
    /** 引擎语义排名（1 起；未入语义候选池可缺省）。 */
    readonly semanticRank?: number;
    /** 时序加成（recencyBoostFor 输出）。 */
    readonly recencyBoost: number;
    /** 反馈加成（feedbackBoost 输出）。 */
    readonly feedbackBoost: number;
    /** 用户原始查询文本。 */
    readonly query: string;
    /** 会话标题（索引快照）。 */
    readonly title: string;
}
/** 空模型（冷启动）。 */
export declare function emptyRankerModel(): RankerModel;
/** 从损坏/旧格式记录恢复的收窄辅助：非法记录静默丢弃。 */
export declare function sanitizeRankerModel(raw: unknown): RankerModel | undefined;
/**
 * 构造特征向量（训练与推断的唯一特征口径）。
 * 排名特征做 RRF 式变换 `1/(60+rank)`（排名语义与融合分同构）；
 * 加成特征按封顶值归一；标题命中 = 查询词元在标题中的覆盖比例。
 */
export declare function buildRankerFeatures(input: RankerFeatureInput): RankerFeatures;
/**
 * 惰性权重：FTRL-Proximal 每轮按累积器即时解出 w_i
 * （L1 软阈值：|z_i| ≤ λ1 时恰为 0——稀疏性的来源）。
 */
export declare function effectiveWeights(model: RankerModel): Record<RankerFeatureName, number>;
/** 预测点击概率（logistic 于有效权重点积）。 */
export declare function predictClickProbability(model: RankerModel, features: RankerFeatures): number;
/**
 * FTRL-Proximal 单步更新（logistic 损失；exampleWeight 缩放梯度）。
 * 返回新模型（原模型不可变）。
 *
 * @param model 当前模型。
 * @param features 样本特征。
 * @param label 标签（1 = 点击 / 0 = 未点击）。
 * @param exampleWeight 样本权重（正例 1、skip-above 负例 0.25）。
 */
export declare function updateRanker(model: RankerModel, features: RankerFeatures, label: number, exampleWeight?: number): RankerModel;
/** 暖机系数（0 = 冷启动无影响 → 1 = 全幅微调）。 */
export declare function rankerWarmup(model: RankerModel): number;
/**
 * 排序微调乘数：`1 + 0.3 × (2p−1) × warmup`。
 * 冷启动恰为 1（零影响）；暖机后 ∈ [0.7, 1.3]——相关性仍占主导。
 */
export declare function learnedMultiplier(model: RankerModel, features: RankerFeatures): number;
/** skip-above 负例权重（训练编排层使用）。 */
export declare const RANKER_NEGATIVE_WEIGHT = 0.25;
/** 模型诊断视图（特征权重透明化：每个特征对点击概率的贡献方向）。 */
export declare function rankerDiagnostics(model: RankerModel): {
    updates: number;
    clicks: number;
    examples: number;
    warmup: number;
    trainedAt: number;
    features: ReadonlyArray<{
        name: RankerFeatureName;
        weight: number;
    }>;
};
