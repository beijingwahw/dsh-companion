/**
 * 次模证据选择（轴线 29「证据的覆盖最大化」）：把证据挑选从
 * 「分数降序装满预算」升级为「带理论保证的组合优化」。
 *
 * 设计动机：轴线 5 的证据选择按相关分降序贪心装入字符预算——它优化
 * 的是「每块都相关」，但三个各讲一半的互补证据常常比三块同义的
 * 高分证据更有价值，分数降序看不见这一点。组合优化给出正确的目标：
 *
 * **设施选址次模函数**（Cornuéjols et al. 1977；Lin & Bilmes 2011
 * 用于摘要抽取的同族目标）：
 *
 *   f(S) = Σ_{s∈S} score(s)            （模块化项：单块相关性）
 *        + W · Σ_{a∈A} w_a · max_{s∈S} cov(s,a)   （设施选址项：方面覆盖）
 *
 * - **方面集 A** = 问题词元，权重 = 稀有度（包含该词元的候选块越少
 *   越重要——长尾词是问题的真指纹）；
 * - **覆盖 cov(s,a)** = 词元 a 在块 s 中的频次 / 全候选最大频次（[0,1]）；
 * - **次模性**：第二块讲同样内容的证据，边际覆盖增益 ≈ 0——冗余
 *   被目标函数自动惩罚；单调性：加块永不降分；
 * - **惰性贪婪（CELF，Leskovec et al. 2007）**：优先队列按边际增益
 *   排序，弹出重估值后若仍居首则采纳——评估次数远小于朴素贪婪的
 *   k×n（`evaluations` 字段可证）；
 * - **理论保证**：基数约束下贪婪达到最优的 (1−1/e) ≈ 63.2%
 *   （Nemhauser et al. 1978 经典结果）；字符预算（背包约束）下
 *   按增益/成本比选取保证至少 (1−1/e)/2 ≈ 31.6%——牺牲常数换取
 *   单遍流式复杂度。
 *
 * 纯函数、无状态、可单测；候选块只需 { sessionId, text, score }
 * 结构形状（与模块 G 的 EvidenceChunk 结构兼容）。
 */
import { tokenize } from '../retrieval/tokenize.js';
/** 覆盖项缺省权重（两块互补证据优于两块同义高分证据）。 */
const DEFAULT_COVERAGE_WEIGHT = 2.0;
/** 尾部截断缺省下限。 */
const DEFAULT_TAIL_FLOOR = 200;
/** 单块的最小有效字符数（空白折叠后）。 */
const MIN_CHUNK_CHARS = 1;
/**
 * 次模证据选择主入口：惰性贪婪在「块数 × 单会话上限 × 字符预算」
 * 三重约束下最大化相关 × 覆盖目标。
 *
 * @param candidates 候选块（任意顺序；结果携带原始下标供回溯）。
 * @param question 研究问题（方面集与权重的来源）。
 * @param options 约束与权重。
 */
export function selectSubmodular(candidates, question, options) {
    const coverageWeight = options.coverageWeight ?? DEFAULT_COVERAGE_WEIGHT;
    const tailFloor = options.tailFloorChars ?? DEFAULT_TAIL_FLOOR;
    const usable = candidates
        .map((chunk, index) => ({ chunk, index }))
        .filter((item) => item.chunk.text.trim().length >= MIN_CHUNK_CHARS);
    if (usable.length === 0) {
        return { selected: [], coverage: 0, evaluations: 0, aspects: 0 };
    }
    // 方面集：问题词元 → 稀有度权重（含该词元的候选块越少越重）。
    const aspects = buildAspects(question, usable.map((item) => item.chunk.text));
    // 逐块覆盖向量（稀疏：只记出现过的方面）。
    const coverageVectors = usable.map((item) => coverageVectorOf(item.chunk.text, aspects));
    // 当前已覆盖最优值（方面 → [0,1]）。
    const covered = new Map();
    for (const aspect of aspects.keys())
        covered.set(aspect, 0);
    /** 块的边际增益（相对当前 covered 状态；O(方面数)）。 */
    const marginalGain = (position) => {
        const chunk = usable[position].chunk;
        let gain = chunk.score;
        for (const [aspect, cov] of coverageVectors[position]) {
            const prev = covered.get(aspect) ?? 0;
            if (cov > prev)
                gain += coverageWeight * aspectWeightOf(aspects, aspect) * (cov - prev);
        }
        return gain;
    };
    // 惰性贪婪主循环：按「增益/成本」维护降序队列，弹头重估后择优。
    let evaluations = 0;
    const perSession = new Map();
    const selected = [];
    let totalChars = 0;
    let queue = usable.map((_, position) => {
        const gain = marginalGain(position);
        evaluations += 1;
        const cost = Math.max(1, usable[position].chunk.text.length);
        return { position, staleGain: gain, priority: gain / cost };
    });
    queue.sort((a, b) => b.priority - a.priority);
    /** 仅会话配额超限的块（预算不足的块恰是尾部截断的目标，不算不可行）。 */
    const sessionCapped = new Set();
    while (selected.length < options.maxChunks && queue.length > 0) {
        const head = queue[0];
        const chunk = usable[head.position].chunk;
        // 可行性预检：单会话上限 / 字符预算（预算不足交给尾部截断处理）。
        const used = perSession.get(chunk.sessionId) ?? 0;
        const sessionFull = used >= options.perSessionCap;
        if (sessionFull)
            sessionCapped.add(head.position);
        if (sessionFull || totalChars + chunk.text.length > options.charBudget) {
            queue = queue.slice(1);
            continue;
        }
        // 弹头重估：增益仍是当前最高优先级 → 采纳（惰性命中）。
        const freshGain = marginalGain(head.position);
        evaluations += 1;
        if (freshGain <= 0) {
            queue = queue.slice(1);
            continue;
        }
        const cost = Math.max(1, chunk.text.length);
        const freshPriority = freshGain / cost;
        if (queue.length === 1 || freshPriority >= queue[1].priority) {
            // 采纳：更新覆盖状态、会话配额、预算。
            for (const [aspect, cov] of coverageVectors[head.position]) {
                if (cov > (covered.get(aspect) ?? 0))
                    covered.set(aspect, cov);
            }
            perSession.set(chunk.sessionId, used + 1);
            selected.push({ index: usable[head.position].index, text: chunk.text });
            totalChars += chunk.text.length;
            queue = queue.slice(1);
            continue;
        }
        // 重估值失效：回插队列（按新优先级二分定位）。
        const reinserted = { position: head.position, staleGain: freshGain, priority: freshPriority };
        queue = queue.slice(1);
        insertSorted(queue, reinserted);
    }
    // 尾部截断收束：剩余预算足够装下有意义片段时，取边际增益最高的
    // 可行未选块截断装入（对齐轴线 5 的「截断而非丢弃」语义）。
    // 过滤只排除会话配额超限与已选块——主循环里因预算不足落选的块
    // 恰恰是这里的截断目标。
    const remaining = options.charBudget - totalChars;
    if (remaining >= tailFloor && selected.length < options.maxChunks) {
        let bestPosition = -1;
        let bestGain = 0;
        for (let position = 0; position < usable.length; position += 1) {
            if (sessionCapped.has(position))
                continue;
            if (selected.some((item) => item.index === usable[position].index))
                continue;
            const chunk = usable[position].chunk;
            if (chunk.text.length < tailFloor)
                continue;
            const used = perSession.get(chunk.sessionId) ?? 0;
            if (used >= options.perSessionCap)
                continue;
            const gain = marginalGain(position);
            evaluations += 1;
            if (gain > bestGain) {
                bestGain = gain;
                bestPosition = position;
            }
        }
        if (bestPosition >= 0) {
            const chunk = usable[bestPosition].chunk;
            const text = chunk.text.slice(0, remaining);
            if (text.trim().length > 0) {
                for (const [aspect, cov] of coverageVectors[bestPosition]) {
                    if (cov > (covered.get(aspect) ?? 0))
                        covered.set(aspect, cov);
                }
                selected.push({ index: usable[bestPosition].index, text });
                totalChars += text.length;
            }
        }
    }
    void totalChars;
    return {
        selected,
        coverage: coverageScore(covered, aspects),
        evaluations,
        aspects: aspects.size,
    };
}
/**
 * 证据集合的问题方面覆盖率（对照组口径：轴线 5 的分数降序贪心
 * 用同一函数计算 baseline，增益可量化）。
 *
 * @param question 研究问题。
 * @param texts 证据文本列表。
 */
export function evidenceCoverage(question, texts) {
    if (texts.length === 0)
        return 0;
    const aspects = buildAspects(question, texts);
    if (aspects.size === 0)
        return 0;
    const covered = new Map();
    for (const text of texts) {
        for (const [aspect, cov] of coverageVectorOf(text, aspects)) {
            if (cov > (covered.get(aspect) ?? 0))
                covered.set(aspect, cov);
        }
    }
    return coverageScore(covered, aspects);
}
/** 方面覆盖分：Σ w_a·covered_a / Σ w_a（无方面 → 0）。 */
function coverageScore(covered, aspects) {
    let totalWeight = 0;
    let coveredWeight = 0;
    for (const [aspect, info] of aspects) {
        if (info.maxTf <= 0)
            continue;
        totalWeight += info.weight;
        coveredWeight += info.weight * (covered.get(aspect) ?? 0);
    }
    if (totalWeight <= 0)
        return 0;
    return coveredWeight / totalWeight;
}
/**
 * 方面集构造：问题词元 → { 权重 = 1/(1+包含块数)，maxTf = 全候选
 * 最大词频（覆盖归一基准）}。无候选包含的词元 maxTf=0（不参与计分）。
 */
function buildAspects(question, texts) {
    const aspects = new Map();
    for (const token of new Set(tokenize(question))) {
        aspects.set(token, { weight: 1, maxTf: 0 });
    }
    if (aspects.size === 0)
        return aspects;
    const docFreq = new Map();
    for (const text of texts) {
        const tf = new Map();
        for (const token of tokenize(text))
            tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const aspect of aspects.keys()) {
            const count = tf.get(aspect);
            if (count === undefined || count <= 0)
                continue;
            docFreq.set(aspect, (docFreq.get(aspect) ?? 0) + 1);
            const info = aspects.get(aspect);
            if (info !== undefined && count > info.maxTf)
                info.maxTf = count;
        }
    }
    for (const [aspect, info] of aspects) {
        info.weight = 1 / (1 + (docFreq.get(aspect) ?? 0));
    }
    return aspects;
}
/** 块的覆盖向量：出现过的方面 → tf/maxTf（[0,1]）。 */
function coverageVectorOf(text, aspects) {
    const vector = new Map();
    if (aspects.size === 0)
        return vector;
    const tf = new Map();
    for (const token of tokenize(text)) {
        if (aspects.has(token))
            tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const [aspect, count] of tf) {
        const info = aspects.get(aspect);
        if (info !== undefined && info.maxTf > 0)
            vector.set(aspect, count / info.maxTf);
    }
    return vector;
}
/** 方面权重读取（缺省 1 防御）。 */
function aspectWeightOf(aspects, aspect) {
    return aspects.get(aspect)?.weight ?? 1;
}
/** 二分回插（队列按 priority 降序）。 */
function insertSorted(queue, item) {
    let low = 0;
    let high = queue.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (queue[mid].priority >= item.priority)
            low = mid + 1;
        else
            high = mid;
    }
    queue.splice(low, 0, item);
}
