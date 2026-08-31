/**
 * 命中解释器（轴线 15）：把「这个会话为什么排第一」变成透明账本。
 *
 * 设计动机：融合分 0.0432 对用户是纯粹的黑盒数字。混合引擎的得分
 * 实际由四个可分离的成分构成，本模块把它们逐一拆开：
 *
 * - **词法命中**：查询词元在文档中的出现频次（BM25 的原料）——
 *   「部署 ×3、docker ×2」直说命中了什么；
 * - **语义相似**：查询与文档的 trigram 形状余弦（0–100%）——
 *   「不用同一词但谈同一事」的形状重合度；
 * - **新近加成**：时序感知（轴线 9）贡献的乘性增量；
 * - **反馈加成**：相关性反馈学习（轴线 11）贡献的乘性增量。
 *
 * 输出结构化账本 + 一句话人话摘要，客户端悬停展示、命令面板直读。
 * 与质量诊断（轴线 10）互补：诊断评「整次检索」的质量，解释器评
 * 「单条命中」的构成。
 */
import { docGramVector, sparseCosine, textGramVector } from './engine.js';
import { tokenize } from './tokenize.js';
/** 人话摘要里展示的词法命中词上限。 */
const LEXICAL_TERMS_IN_SUMMARY = 3;
/** 加成显示阈值：低于 1% 的乘性增量不值得出现在摘要里。 */
const BOOST_DISPLAY_THRESHOLD = 0.01;
/**
 * 解释一条命中：拆解融合分的四个成分。
 *
 * @param queryText 用户原始查询（不掺扩展词——解释的是「你搜的词」如何命中）。
 * @param doc 命中会话的索引文档。
 * @param boosts 加成分解（新近 + 反馈）。
 * @param queryVector 查询的哈希向量（调用方可缓存复用；缺省即时构建）。
 */
export function explainHit(queryText, doc, boosts, queryVector) {
    const vector = queryVector ?? textGramVector(queryText);
    const semanticSimilarity = sparseCosine(vector, docGramVector(doc));
    // 词法命中：查询词元 ∩ 文档词表，按 tf 降序。
    const terms = [...new Set(tokenize(queryText))];
    const lexicalHits = [];
    for (const term of terms) {
        const tf = doc.termFreqs[term] ?? 0;
        if (tf > 0)
            lexicalHits.push({ term, tf });
    }
    lexicalHits.sort((a, b) => b.tf - a.tf);
    return {
        lexicalHits,
        semanticSimilarity: Number(semanticSimilarity.toFixed(4)),
        recencyBoost: Number(boosts.recency.toFixed(4)),
        feedbackBoost: Number(boosts.feedback.toFixed(4)),
        summary: summarize(lexicalHits, semanticSimilarity, boosts),
    };
}
/** 人话摘要：词法命中 + 语义相似 + 有感的加成项。 */
function summarize(lexicalHits, semanticSimilarity, boosts) {
    const parts = [];
    if (lexicalHits.length > 0) {
        const traced = lexicalHits
            .slice(0, LEXICAL_TERMS_IN_SUMMARY)
            .map((hit) => `${hit.term}×${hit.tf}`)
            .join('、');
        parts.push(`词法命中 ${traced}`);
    }
    if (semanticSimilarity > 0) {
        parts.push(`语义形状相似 ${Math.round(semanticSimilarity * 100)}%`);
    }
    if (boosts.recency >= BOOST_DISPLAY_THRESHOLD) {
        parts.push(`新近 +${Math.round(boosts.recency * 100)}%`);
    }
    if (boosts.feedback >= BOOST_DISPLAY_THRESHOLD) {
        parts.push(`历史点击 +${Math.round(boosts.feedback * 100)}%`);
    }
    if (parts.length === 0)
        return '无显性命中（可能经扩展词或形状残差进入结果）';
    return parts.join(' · ');
}
