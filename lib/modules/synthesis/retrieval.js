/**
 * 跨会话知识合成的块级检索算法（轴线 5，纯函数，无状态，可单测）。
 *
 * 与模块 E（会话级检索）的分工：
 * - E 回答"哪些会话相关"（会话粒度，RRF 混合排序，服务于检索浏览）；
 * - 本模块回答"哪些片段能作为证据"（片段粒度，服务于合成质量）——
 *   会话级命中的超长转录里可能只有一段与问题相关，整篇塞给模型
 *   既浪费预算又稀释注意力，故先分块再精排。
 *
 * 设计：
 * - 分块：按回合边界贪心装箱到目标字符数（单回合超目标时独立成块，
 *   不在回合内部切开——保持语义单元完整，引用边界可解释）；
 * - 打分：词法（问题词元与块词元的重合率）+ 字符 trigram 余弦
 *   （中文换说法仍可命中），复用混合检索引擎的同一套分词器；
 * - 选择：分数降序贪心装入证据预算，单会话块数封顶（证据多样性，
 *   防一个超长会话吞掉全部预算）。
 */
import { charTrigrams, tokenize } from '../../core/retrieval/tokenize.js';
/**
 * 按回合边界分块：贪心装箱连续回合到 `targetChars`。
 * 单回合自身超目标时独立成块（回合是引用的最小可解释单元，不内切）。
 */
export function chunkTranscript(turns, targetChars) {
    const chunks = [];
    let current = [];
    let currentChars = 0;
    for (const turn of turns) {
        if (current.length > 0 && currentChars + turn.text.length > targetChars) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(turn);
        currentChars += turn.text.length;
        if (currentChars >= targetChars) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
    }
    if (current.length > 0)
        chunks.push(current);
    return chunks;
}
/** 文本对问题的相关分：词法重合率与 trigram 余弦各占一半。 */
export function scoreText(question, text) {
    const questionTokens = new Set(tokenize(question));
    let lexical = 0;
    if (questionTokens.size > 0) {
        const textTokens = new Set(tokenize(text));
        let hits = 0;
        for (const token of questionTokens) {
            if (textTokens.has(token))
                hits += 1;
        }
        lexical = hits / questionTokens.size;
    }
    const questionGrams = charTrigrams(question);
    const textGrams = charTrigrams(text);
    let dot = 0;
    for (const [gram, count] of questionGrams) {
        dot += count * (textGrams.get(gram) ?? 0);
    }
    let questionNorm = 0;
    for (const count of questionGrams.values())
        questionNorm += count * count;
    let textNorm = 0;
    for (const count of textGrams.values())
        textNorm += count * count;
    const semantic = questionNorm > 0 && textNorm > 0 ? dot / Math.sqrt(questionNorm * textNorm) : 0;
    return 0.5 * lexical + 0.5 * semantic;
}
/**
 * 选择证据块：分数降序贪心装入预算。
 * 剩余预算装不下有意义片段（<200 字符）时提前收束；
 * 超预算的尾部块截断到剩余预算而非整块丢弃。
 */
export function selectEvidence(candidates, options) {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const perSession = new Map();
    const picked = [];
    let totalChars = 0;
    for (const chunk of sorted) {
        if (picked.length >= options.maxChunks)
            break;
        const used = perSession.get(chunk.sessionId) ?? 0;
        if (used >= options.perSessionCap)
            continue;
        let text = chunk.text;
        if (totalChars + text.length > options.charBudget) {
            const remaining = options.charBudget - totalChars;
            if (remaining < 200)
                break;
            text = text.slice(0, remaining);
        }
        if (text.trim().length === 0)
            continue;
        perSession.set(chunk.sessionId, used + 1);
        picked.push(text === chunk.text ? chunk : { ...chunk, text });
        totalChars += text.length;
        if (totalChars >= options.charBudget)
            break;
    }
    return picked;
}
/**
 * 组装合成 Prompt：契约式指令（只用证据 / 编号引用 / 结论先行 /
 * 指出矛盾）+ 编号证据块（每块带来源会话标题与日期）。
 */
export function buildSynthesisPrompt(question, evidence) {
    const blocks = evidence.map((chunk, index) => {
        const date = new Date(chunk.createdAt).toISOString().slice(0, 10);
        return `[${index + 1}] 来源：会话「${chunk.title || '未命名对话'}」（${date}）\n${chunk.text}`;
    });
    const header = [
        '你是一个严谨的研究助手。请仅基于下方编号的证据片段回答问题。',
        '要求：',
        '1. 只使用证据中出现的信息，不要编造；证据不足以回答时明确说明"证据不足"。',
        '2. 引用依据时使用 [编号] 标注（如 [1][3]），每个关键论断都应有出处。',
        '3. 先给直接结论，再分点列出依据；若不同证据之间存在矛盾，请明确指出。',
        '',
        `【问题】${question}`,
        '',
        '【证据片段】',
    ].join('\n');
    return `${header}\n\n${blocks.join('\n\n')}`;
}
