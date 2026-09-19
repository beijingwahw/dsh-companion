/**
 * FTRL-Proximal 在线学习排序器（轴线 28「学习排序」）：
 * 让检索排序从你的每一次点击中持续学习，且带遗憾界保证。
 *
 * 设计动机：轴线 11 的反馈学习是「画像 × 乘性加成」——查询词与点击
 * 画像重叠就加分，简单、可解释，但它是**词级启发式**：它不知道
 * "词法排名第 3 且标题命中且三天内更新过的会话，你点开的概率是
 * 82%"这类**特征级规律**。在线学习排序（Learning to Rank）用参数化
 * 模型吸收它，而 FTRL-Proximal（McMahan et al. 2013，Google 大规模
 * CTR 预测的同款优化器）是流式场景的工业标准：
 *
 * - **逐坐标自适应学习率** `η_i = (β + √n_i)/α`：被频繁更新的特征
 *   自动放慢步长——新信号快速吸收、旧规律稳定保持；
 * - **L1 稀疏 + L2 平滑**：proximal 步在每轮更新时做软阈值收缩，
 *   无用特征权重精确归零（模型保持极小、可解释）；
 * - **单遍流式**：每条训练样本 O(特征数) 更新，零历史重放；
 * - **遗憾界**：FTRL 系对凸损失的 regret 次线性（O(√T)）——
 *   学得比任何固定权重都好，且不需要批量训练。
 *
 * 训练信号（skip-above 偏好对）：点击会话为正例；**引擎排名在点击
 * 之上的未点击会话**为负例（点击模型经典的无偏负采样——用户看到了
 * 排在前面的结果却没点，是"点了它而非它们"的成对证据）。
 *
 * 推断姿态（保守融合）：学到的点击概率 p 经 `1 + 0.3×(2p−1)×warmup`
 * 转为乘性微调——冷启动（< 50 次更新）按比例退火到无影响，暖机后
 * 最大 ±30%，与轴线 11 的反馈加成同构（相关性主导，学习只做先验）。
 *
 * 纯本地、零 LLM、零网络；模型持久化 companion 域，隐私不出域。
 */
import { tokenize } from './tokenize.js';
/** 全部特征（展示与诊断顺序）。 */
export const RANKER_FEATURES = [
    'lexicalRank',
    'semanticRank',
    'recency',
    'feedback',
    'titleMatch',
    'bias',
];
/** RRF 风格的排名特征变换基数（与检索引擎 RRF_K=60 对齐）。 */
const RANK_FEATURE_K = 60;
/** 时序加成的封顶值（与引擎缺省强度 0.25 对齐）。 */
const RECENCY_CAP = 0.25;
/** 反馈加成的封顶值（与轴线 11 的 35% 对齐）。 */
const FEEDBACK_CAP = 0.35;
/** FTRL-Proximal 超参数。 */
const FTRL_ALPHA = 0.2;
const FTRL_BETA = 1.0;
const FTRL_L1 = 1e-6;
const FTRL_L2 = 0.01;
/** 推断微调封顶（±30%：与反馈加成同量级的温和先验）。 */
export const RANKER_NUDGE_CAP = 0.3;
/** 暖机目标更新次数（此前按比例退火学习影响）。 */
export const RANKER_WARMUP_TARGET = 50;
/** skip-above 负例的单例权重（未点击是弱证据，降权防过强负梯度）。 */
const NEGATIVE_WEIGHT = 0.25;
/** 空模型（冷启动）。 */
export function emptyRankerModel() {
    return { z: {}, n: {}, updates: 0, clicks: 0, examples: 0, trainedAt: 0 };
}
/** 从损坏/旧格式记录恢复的收窄辅助：非法记录静默丢弃。 */
export function sanitizeRankerModel(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const accumulator = (value) => {
        const result = {};
        if (typeof value !== 'object' || value === null)
            return result;
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === 'number' && Number.isFinite(entry))
                result[key] = entry;
        }
        return result;
    };
    const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const model = {
        z: accumulator(record.z),
        n: accumulator(record.n),
        updates: count(record.updates),
        clicks: count(record.clicks),
        examples: count(record.examples),
        trainedAt: typeof record.trainedAt === 'number' && Number.isFinite(record.trainedAt) ? record.trainedAt : 0,
    };
    if (model.updates === 0 && model.clicks === 0 && model.examples === 0)
        return undefined;
    return model;
}
/**
 * 构造特征向量（训练与推断的唯一特征口径）。
 * 排名特征做 RRF 式变换 `1/(60+rank)`（排名语义与融合分同构）；
 * 加成特征按封顶值归一；标题命中 = 查询词元在标题中的覆盖比例。
 */
export function buildRankerFeatures(input) {
    const queryTerms = new Set(tokenize(input.query));
    let titleMatch = 0;
    if (queryTerms.size > 0) {
        const titleTerms = new Set(tokenize(input.title));
        let hits = 0;
        for (const term of queryTerms) {
            if (titleTerms.has(term))
                hits += 1;
        }
        titleMatch = hits / queryTerms.size;
    }
    return {
        lexicalRank: input.lexicalRank !== undefined && input.lexicalRank > 0
            ? 1 / (RANK_FEATURE_K + input.lexicalRank)
            : 0,
        semanticRank: input.semanticRank !== undefined && input.semanticRank > 0
            ? 1 / (RANK_FEATURE_K + input.semanticRank)
            : 0,
        recency: clamp01(input.recencyBoost / RECENCY_CAP),
        feedback: clamp01(input.feedbackBoost / FEEDBACK_CAP),
        titleMatch,
        bias: 1,
    };
}
/**
 * 惰性权重：FTRL-Proximal 每轮按累积器即时解出 w_i
 * （L1 软阈值：|z_i| ≤ λ1 时恰为 0——稀疏性的来源）。
 */
export function effectiveWeights(model) {
    const weights = {};
    for (const feature of RANKER_FEATURES) {
        const z = model.z[feature] ?? 0;
        const n = model.n[feature] ?? 0;
        const denominator = FTRL_L2 + (FTRL_BETA + Math.sqrt(n)) / FTRL_ALPHA;
        if (Math.abs(z) <= FTRL_L1) {
            weights[feature] = 0;
            continue;
        }
        const numerator = z > 0 ? z - FTRL_L1 : z + FTRL_L1;
        weights[feature] = -numerator / denominator;
    }
    return weights;
}
/** 预测点击概率（logistic 于有效权重点积）。 */
export function predictClickProbability(model, features) {
    const weights = effectiveWeights(model);
    let dot = 0;
    for (const feature of RANKER_FEATURES) {
        const value = features[feature];
        if (value !== 0)
            dot += weights[feature] * value;
    }
    return sigmoid(dot);
}
/**
 * FTRL-Proximal 单步更新（logistic 损失；exampleWeight 缩放梯度）。
 * 返回新模型（原模型不可变）。
 *
 * @param model 当前模型。
 * @param features 样本特征。
 * @param label 标签（1 = 点击 / 0 = 未点击）。
 * @param exampleWeight 样本权重（正例 1、skip-above 负例 0.25）。
 */
export function updateRanker(model, features, label, exampleWeight = 1) {
    const prediction = predictClickProbability(model, features);
    const z = { ...model.z };
    const n = { ...model.n };
    const weights = effectiveWeights(model);
    for (const feature of RANKER_FEATURES) {
        const x = features[feature];
        if (x === 0)
            continue;
        const gradient = exampleWeight * (prediction - label) * x;
        const prevSqrt = Math.sqrt(n[feature] ?? 0);
        const nextSqrt = Math.sqrt(prevSqrt * prevSqrt + gradient * gradient);
        const sigma = nextSqrt - prevSqrt;
        z[feature] = (z[feature] ?? 0) + gradient - sigma * weights[feature];
        n[feature] = prevSqrt * prevSqrt + gradient * gradient;
    }
    return {
        z,
        n,
        updates: model.updates + 1,
        clicks: model.clicks + (label >= 1 ? 1 : 0),
        examples: model.examples + 1,
        trainedAt: Date.now(),
    };
}
/** 暖机系数（0 = 冷启动无影响 → 1 = 全幅微调）。 */
export function rankerWarmup(model) {
    if (model.updates <= 0)
        return 0;
    return Math.min(1, model.updates / RANKER_WARMUP_TARGET);
}
/**
 * 排序微调乘数：`1 + 0.3 × (2p−1) × warmup`。
 * 冷启动恰为 1（零影响）；暖机后 ∈ [0.7, 1.3]——相关性仍占主导。
 */
export function learnedMultiplier(model, features) {
    const warmup = rankerWarmup(model);
    if (warmup <= 0)
        return 1;
    const p = predictClickProbability(model, features);
    return 1 + RANKER_NUDGE_CAP * (2 * p - 1) * warmup;
}
/** skip-above 负例权重（训练编排层使用）。 */
export const RANKER_NEGATIVE_WEIGHT = NEGATIVE_WEIGHT;
/** 模型诊断视图（特征权重透明化：每个特征对点击概率的贡献方向）。 */
export function rankerDiagnostics(model) {
    const weights = effectiveWeights(model);
    return {
        updates: model.updates,
        clicks: model.clicks,
        examples: model.examples,
        warmup: rankerWarmup(model),
        trainedAt: model.trainedAt,
        features: RANKER_FEATURES.map((name) => ({ name, weight: weights[name] })),
    };
}
/** sigmoid（数值稳定）。 */
function sigmoid(x) {
    if (x >= 0)
        return 1 / (1 + Math.exp(-x));
    const exp = Math.exp(x);
    return exp / (1 + exp);
}
/** 钳到 [0,1]。 */
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
