/**
 * 会话聚类知识地图（轴线 13）：把全部历史会话自动组织成主题簇。
 *
 * 设计动机：会话列表是「时间流」，但知识是「主题网」——你可能在三周里
 * 分 5 次解决同一个部署问题、用 4 段对话啃同一个性能坑。时间流里这些
 * 分散为孤岛，聚类后它们变成 2 个簇，一眼回答三个问题：
 * - 「我重复解决过哪些问题」（簇规模 ≥2 = 重复投入，可合并/沉淀模板）；
 * - 「我的知识都分布在哪些主题」（簇列表 = 个人知识地图的目录页）;
 * - 「这段时期我在忙什么」（簇的时间跨度 + 规模 = 注意力流向）。
 *
 * 算法：**质心贪心聚类**（leader-follower）——文档按更新时间从新到旧
 * 依次归簇，与各簇质心做 trigram 哈希向量余弦，≥ 阈值则并入（质心增量
 * 累加），否则自立新簇。复杂度 O(n × k)（k = 簇数），远低于层次聚类的
 * O(n²)，千级会话毫秒完成；「新会话优先」的遍历序让簇由最新表述定义，
 * 旧表述向新表述靠拢（主题演化天然被吸收进簇，而非裂成两簇）。
 *
 * 簇标签：簇内文档频率 × 全局 IDF 打分取 top 词——「簇内常见且全局
 * 罕见」即该簇的判别性签名，与模块 F 实体抽取互补（F 抽语法实体，
 * 这里抽统计主题词）。
 *
 * 隐私红线：纯本地计算，聚类结果只存内存/响应，不落盘不外传。
 */
import { docGramVector, sparseCosine } from './engine.js';
/** 并簇相似度阈值（trigram 向量余弦；经验值：同话题的中文会话普遍 ≥ 0.3）。 */
const DEFAULT_THRESHOLD = 0.3;
/** 簇标签词数上限。 */
const DEFAULT_LABEL_TERMS = 3;
/** 单簇返回的会话 id 上限（超大簇只列最近成员，规模字段仍是真实值）。 */
const SESSION_IDS_CAP = 200;
/** 聚类输入文档数上限（超限取最近的 N 篇，保护毫秒级延迟承诺）。 */
const CLUSTER_DOC_CAP = 4000;
/** 返回簇数上限（按规模降序取头部；其余合并统计进 summary）。 */
const CLUSTER_CAP = 60;
/**
 * 对全部已索引会话做主题聚类。
 * @param docs 索引文档集合（任意顺序；内部按 updatedAt 从新到旧遍历）。
 * @param options 阈值与标签词数。
 * @returns 簇列表（规模降序；单会话簇也在内，调用方按需过滤）。
 */
export function clusterSessions(docs, options = {}) {
    if (docs.length === 0)
        return [];
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const labelTerms = options.labelTerms ?? DEFAULT_LABEL_TERMS;
    // 遍历序：新会话优先（簇由最新表述定义，旧表述向新靠拢）。
    const ordered = [...docs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CLUSTER_DOC_CAP);
    const clusters = [];
    for (const doc of ordered) {
        const vector = docGramVector(doc);
        let best;
        let bestSimilarity = threshold;
        for (const cluster of clusters) {
            const similarity = sparseCosine(vector, cluster.centroid);
            if (similarity >= bestSimilarity) {
                best = cluster;
                bestSimilarity = similarity;
            }
        }
        if (best !== undefined) {
            // 并入：质心增量累加（成员向量之和），成员表追加。
            for (const [dim, value] of vector) {
                best.centroid.set(dim, (best.centroid.get(dim) ?? 0) + value);
            }
            best.docs.push(doc);
            best.from = Math.min(best.from, doc.createdAt);
            best.to = Math.max(best.to, doc.createdAt);
        }
        else {
            clusters.push({
                centroid: new Map(vector),
                docs: [doc],
                from: doc.createdAt,
                to: doc.createdAt,
            });
        }
    }
    // 簇标签：簇内文档频率 × 全局 IDF（判别性主题词）。
    const totalDocs = ordered.length;
    const globalDf = new Map();
    for (const doc of ordered) {
        for (const term of Object.keys(doc.termFreqs)) {
            globalDf.set(term, (globalDf.get(term) ?? 0) + 1);
        }
    }
    const labeled = clusters.map((cluster) => {
        const intraDf = new Map();
        for (const doc of cluster.docs) {
            for (const term of Object.keys(doc.termFreqs)) {
                intraDf.set(term, (intraDf.get(term) ?? 0) + 1);
            }
        }
        const scored = [...intraDf.entries()]
            .map(([term, df]) => ({
            term,
            score: df * Math.log(1 + totalDocs / (globalDf.get(term) ?? 1)),
        }))
            .sort((a, b) => b.score - a.score);
        const topTerms = scored.slice(0, labelTerms).map((entry) => entry.term);
        // 代表强度：头部判别词得分之和（簇间排序的次级键）。
        const score = scored.slice(0, labelTerms).reduce((sum, entry) => sum + entry.score, 0);
        const members = [...cluster.docs].sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            id: '',
            label: topTerms.length > 0 ? topTerms.join(' · ') : '未命名主题',
            size: cluster.docs.length,
            sessionIds: members.slice(0, SESSION_IDS_CAP).map((doc) => doc.sessionId),
            from: cluster.from,
            to: cluster.to,
            topTerms,
            score,
        };
    });
    // 输出序：规模降序为主键，判别强度为次键；编号 c1、c2…
    labeled.sort((a, b) => b.size - a.size || b.score - a.score);
    return labeled.slice(0, CLUSTER_CAP).map((cluster, index) => ({
        ...cluster,
        id: `c${index + 1}`,
    }));
}
