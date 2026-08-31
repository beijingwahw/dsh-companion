/**
 * 类比检索（轴线 22）：按问题的结构形状跨域匹配历史经验。
 *
 * 设计动机：创新研究的基本共识——创造力的核心机制是**类比迁移**
 * （把远域的解法结构映射到近域问题）。但现有全部检索（关键词/
 * 语义/混合）都按**主题**匹配：搜「k8s service 互通」只会返回
 * 谈 k8s 的对话；而你三个月前解决 docker 网络隔离问题的思路
 * （「两个隔离环境互相看不见 → 查 DNS/端到端连通性」）可能正是
 * 同构解法。主题检索永远找不到它。
 *
 * 本模块把「问题」抽象为**结构形状**（episodes.ts 的约束类别 ×
 * 解法类别），做形状级匹配：
 *
 * - **查询形状提取**：用户描述当前问题 → 约束/解法类别标签；
 * - **形状相似度**：0.7 × 约束重叠系数 + 0.3 × 解法重叠系数
 *   （约束主导——问题像不像比解法像不像更重要）；
 * - **同域/跨域判定**：主题词元重叠低而形状相似度高 → **跨域类比**
 *   （最有价值的命中：结构同构、领域不同）；重叠高 → **同域先例**
 *   （领域经验复用）。
 *
 * 「远域同构」是检索系统的圣杯：不是找到说过同样话的对话，
 * 而是找到解决过同构问题的对话。
 */
import { tokenize } from '../retrieval/tokenize.js';
import { extractShape } from './episodes.js';
/** 跨域判定的形状分阈值（高于此才可能成为跨域类比）。 */
const CROSS_DOMAIN_SHAPE_THRESHOLD = 0.5;
/** 跨域判定的主题重叠阈值（低于此才算「领域不同」）。 */
const CROSS_DOMAIN_TERM_MAX_OVERLAP = 0.15;
/** 同域/跨域共同命中的最低形状分。 */
const MIN_SHAPE_SCORE = 0.2;
/** 返回条数上限。 */
const MAX_ANALOGIES = 8;
/** 主题锚词元的最小数量（不足时跳过重叠计算，按 0.5 中性处理）。 */
const MIN_ANCHOR_TERMS = 3;
/**
 * 形状相似度：0.7 × 约束重叠系数 + 0.3 × 解法重叠系数（约束主导——
 * 问题像不像比解法像不像更重要）。
 *
 * 用重叠系数（交集 / 较小集大小）而非 Jaccard：查询侧常附带偶发
 * 约束（问网络问题时顺带提到「调用」），Jaccard 把这些噪声约束当成
 * 结构差异惩罚；类比关心的是「历史问题的结构是否被当前问题包含」，
 * 结构子类型也应算同构。双空 → 0（无形状信息不构成类比证据）。
 */
export function shapeSimilarity(a, b) {
    const constraintO = overlapCoefficient(a.constraints, b.constraints);
    const resolutionO = overlapCoefficient(a.resolutions, b.resolutions);
    if (constraintO === 0 && resolutionO === 0)
        return 0;
    return Number((0.7 * constraintO + 0.3 * resolutionO).toFixed(4));
}
/** 集合重叠系数（交集 / 较小集大小；任一侧为空 = 0：无信息不是相似）。 */
function overlapCoefficient(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const item of setA)
        if (setB.has(item))
            intersection += 1;
    if (intersection === 0)
        return 0;
    return intersection / Math.min(setA.size, setB.size);
}
/** 文本主题锚词元集（去重）。 */
function anchorTerms(text) {
    return new Set(tokenize(text));
}
/** 主题重叠度（Jaccard；词元不足时返回 0.5 中性值）。 */
function termOverlap(queryTerms, episodeTerms) {
    if (queryTerms.size < MIN_ANCHOR_TERMS || episodeTerms.size < MIN_ANCHOR_TERMS)
        return 0.5;
    let intersection = 0;
    for (const term of queryTerms)
        if (episodeTerms.has(term))
            intersection += 1;
    if (intersection === 0)
        return 0;
    return intersection / (queryTerms.size + episodeTerms.size - intersection);
}
/**
 * 类比检索：给定当前问题描述，在片段库中找结构同构的历史经验。
 *
 * @param queryText 当前问题的自然语言描述。
 * @param episodes sessionId → 片段记录。
 * @param titles sessionId → 会话标题（可选，命中展示用）。
 */
export function findAnalogies(queryText, episodes, titles) {
    const queryShape = extractShape(queryText);
    if (queryShape.constraints.length === 0) {
        return {
            queryShape,
            analogies: [],
            summary: '未能从描述中识别问题结构——带上问题类型关键词（如 报错/超时/依赖/版本/内存）类比会更准',
        };
    }
    const queryTerms = anchorTerms(queryText);
    const hits = [];
    for (const [sessionId, record] of episodes) {
        for (const episode of record.episodes) {
            const score = shapeSimilarity(queryShape, episode.shape);
            if (score < MIN_SHAPE_SCORE)
                continue;
            const overlap = termOverlap(queryTerms, anchorTerms(`${episode.problem} ${episode.solution}`));
            hits.push({
                episodeId: `${sessionId}:${episode.id}`,
                sessionId,
                title: titles?.get(sessionId),
                problem: episode.problem,
                solution: episode.solution,
                score,
                sharedConstraints: queryShape.constraints.filter((kind) => episode.shape.constraints.includes(kind)),
                sharedResolutions: queryShape.resolutions.filter((kind) => episode.shape.resolutions.includes(kind)),
                crossDomain: score >= CROSS_DOMAIN_SHAPE_THRESHOLD &&
                    overlap <= CROSS_DOMAIN_TERM_MAX_OVERLAP &&
                    episode.shape.constraints.length > 0,
                termOverlap: Number(overlap.toFixed(4)),
                createdAt: record.createdAt,
            });
        }
    }
    hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    const top = hits.slice(0, MAX_ANALOGIES);
    return {
        queryShape,
        analogies: top,
        summary: summarize(queryShape, top),
    };
}
/** 人话摘要。 */
function summarize(queryShape, hits) {
    if (hits.length === 0) {
        return `识别到问题结构 [${queryShape.constraints.join('/')}]，但历史片段中没有同构问题`;
    }
    const cross = hits.filter((hit) => hit.crossDomain).length;
    if (cross > 0) {
        return `${hits.length} 条同构经验（含 ${cross} 条跨域类比——领域不同而结构相同，最值得参考）`;
    }
    return `${hits.length} 条同构经验（同域先例——结构相同且领域相近）`;
}
