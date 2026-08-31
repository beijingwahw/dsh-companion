/**
 * 查询智能（轴线 8）：检索前的查询改写——拼写纠错 + 语料共现扩展。
 * 纯本地、纯函数（语料视图由调用方注入），零 LLM 调用。
 *
 * 设计动机：混合引擎的两路通道都依赖「查询词与语料的字面/形状重合」——
 * 一个拼写错误（perfomance）会让 BM25 词法通道整路失效；一个只出现
 * 英文缩写的对话（auth）会漏掉中文提问（鉴权怎么配）。本模块在检索前
 * 对查询做两级扩展，直接提升召回率：
 *
 * - **拼写纠错（did-you-mean）**：查询词不在语料词表中时，用字符 trigram
 *   余弦在词表里找最近邻（≥ 0.55 且词元文档频率 ≥ 2 才采纳）——纠错
 *   候选必须真实出现在你的对话里，不猜通用词典；
 * - **共现扩展（co-occurrence）**：对语料中真实出现的查询词，经倒排表
 *   直达包含它的文档，统计「同文档共现词」的 salience（共现文档数 ×
 *   IDF），取最强者追加进查询——它从你自己的语料里学到术语关联
 *  （中文提问 ↔ 英文术语、缩写 ↔ 全称），随语料生长而自进化。
 *
 * 扩展总量封顶（默认 4 个词），防止查询漂移稀释相关性；扩展项只追加
 * 不替换，原词仍在两路通道中保留全部权重。
 */
import { charTrigrams, tokenize } from './tokenize.js';
/** 扩展词总量上限（超过会稀释原查询的相关性）。 */
const MAX_EXPANSION_TERMS = 4;
/** 拼写纠错采纳的最低 trigram 余弦相似度。 */
const CORRECTION_MIN_COSINE = 0.55;
/** 纠错候选词的最低文档频率（避免建议语料里的孤例噪声词）。 */
const CORRECTION_MIN_DF = 2;
/** 参与纠错的最短查询词长度（更短的词误纠风险高于收益）。 */
const CORRECTION_MIN_TERM_LENGTH = 4;
/** 候选词与原词的最大长度差（剪枝，降低扫描成本）。 */
const CORRECTION_MAX_LENGTH_DELTA = 3;
/** 共现扩展要求的最低共现文档数（同文档出现 ≥2 次才算真关联）。 */
const COOCCURRENCE_MIN_DOCS = 2;
/** 共现扫描的文档数上限（高频词的全量扫描得不偿失）。 */
const COOCCURRENCE_SCAN_CAP = 400;
/** 纠错词表扫描上限（超大规模词表跳过纠错，优雅降级）。 */
const VOCABULARY_SCAN_CAP = 60_000;
/**
 * 查询智能主入口：对查询文本做拼写纠错 + 共现扩展。
 * @param queryText 原始查询（任意中英混合）。
 * @param corpus 语料视图（引擎的词表统计与倒排直达）。
 */
export function expandQuery(queryText, corpus) {
    const terms = [...new Set(tokenize(queryText))];
    if (terms.length === 0)
        return { queryText, extraTerms: [], notes: [] };
    const querySet = new Set(terms);
    const added = new Set();
    const notes = [];
    // 1) 拼写纠错：优先级最高（拼错的词在词法通道是纯损失）。
    for (const term of terms) {
        if (notes.length >= MAX_EXPANSION_TERMS)
            break;
        if (corpus.termDf.get(term) !== undefined)
            continue;
        const correction = nearestVocabularyTerm(term, corpus.termDf);
        if (correction === undefined || querySet.has(correction) || added.has(correction))
            continue;
        added.add(correction);
        notes.push({ kind: 'correction', from: term, to: correction });
    }
    // 2) 共现扩展：从语料学到的术语关联（中英互桥 / 缩写全称）。
    if (notes.length < MAX_EXPANSION_TERMS) {
        const candidates = [];
        for (const term of terms) {
            const expansion = strongestCooccurrence(term, corpus, querySet, added);
            if (expansion !== undefined)
                candidates.push(expansion);
        }
        candidates.sort((a, b) => b.salience - a.salience);
        for (const candidate of candidates) {
            if (notes.length >= MAX_EXPANSION_TERMS)
                break;
            added.add(candidate.note.to);
            notes.push(candidate.note);
        }
    }
    if (notes.length === 0)
        return { queryText, extraTerms: [], notes: [] };
    const extraTerms = notes.map((note) => note.to);
    return {
        queryText: `${queryText} ${extraTerms.join(' ')}`,
        extraTerms,
        notes,
    };
}
/**
 * 在语料词表中找查询词的最近邻（trigram 余弦）。
 * 只建议真实出现（df ≥ 2）且长度相近的词元——纠错结果必然可在语料命中。
 */
function nearestVocabularyTerm(term, termDf) {
    if (term.length < CORRECTION_MIN_TERM_LENGTH)
        return undefined;
    if (termDf.size > VOCABULARY_SCAN_CAP)
        return undefined;
    const queryGrams = charTrigrams(term);
    if (queryGrams.size === 0)
        return undefined;
    let best;
    let bestCosine = CORRECTION_MIN_COSINE;
    for (const [candidate, df] of termDf) {
        if (df < CORRECTION_MIN_DF)
            continue;
        if (Math.abs(candidate.length - term.length) > CORRECTION_MAX_LENGTH_DELTA)
            continue;
        const cosine = trigramCosine(queryGrams, charTrigrams(candidate));
        if (cosine > bestCosine) {
            bestCosine = cosine;
            best = candidate;
        }
    }
    return best;
}
/**
 * 找查询词在语料中的最强共现词：
 * 经倒排表直达包含该词的文档，统计同文档共现词频，按
 * salience = 共现文档数 × IDF(共现词) 排序取最优。
 * @returns 溯源注记与 salience；无合格候选时 undefined。
 */
function strongestCooccurrence(term, corpus, querySet, added) {
    const df = corpus.termDf.get(term) ?? 0;
    if (df < COOCCURRENCE_MIN_DOCS)
        return undefined;
    const coCounts = new Map();
    let scanned = 0;
    for (const doc of corpus.docsWithTerm(term)) {
        if (scanned >= COOCCURRENCE_SCAN_CAP)
            break;
        scanned += 1;
        for (const other of Object.keys(doc.termFreqs)) {
            if (other === term)
                continue;
            coCounts.set(other, (coCounts.get(other) ?? 0) + 1);
        }
    }
    let best;
    for (const [other, coDocs] of coCounts) {
        if (coDocs < COOCCURRENCE_MIN_DOCS)
            continue;
        if (querySet.has(other) || added.has(other))
            continue;
        const otherDf = corpus.termDf.get(other) ?? 1;
        const idf = Math.log(1 + corpus.docCount / otherDf);
        const salience = coDocs * idf;
        if (best === undefined || salience > best.salience) {
            best = { note: { kind: 'cooccurrence', from: term, to: other }, salience };
        }
    }
    return best;
}
/**
 * 两个 trigram 频次映射的余弦相似度（[0, 1]）。
 * 导出供零命中救援（轴线 16）复用——同样的形状度量，不同的放宽阈值。
 */
export function trigramCosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const value of a.values())
        normA += value * value;
    for (const [gram, value] of b) {
        normB += value * value;
        const other = a.get(gram);
        if (other !== undefined)
            dot += other * value;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / Math.sqrt(normA * normB);
}
