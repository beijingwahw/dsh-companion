/**
 * 好奇心引擎（curiosity）：主动智能的「发现层」。
 *
 * 设计动机：现有 36 条轴线全部是**分析器**——它们回答「我的知识长什么样」
 * （大陆）、「注意力何时切换」（漂移）、「什么正在遗忘」（预测）。但它们
 * 都是**被动分析**：有数据才算，有查询才答。真正的主动智能还需要一个
 * 「**发现层**」：在没有人提问的时候，主动指出「你还没看到但值得看的
 * 东西」。这就是好奇心——不是随机探索，而是**有信息价值的探索**。
 *
 * 信息价值的经典定义（认知科学 / 主动学习）：一个观察的价值 = 它降低
 * 的不确定性。把这条原则落到个人知识资产上，得到三类可计算的「好奇
 * 心信号」：
 *
 * 1. **知识缺口（gap）**：你的知识图谱上存在**高密度社区之间的空洞**——
 *    两块大陆各自内部连接紧密，但之间几乎没有边。这不是「暗物质」
 *    （轴线 34 找的是**共同邻居**暗示的缺失边），而是**结构性缺口**：
 *    两块都已成型的大陆之间缺少翻译层。算法：对共现图做社区发现，
 *    计算社区间边密度 vs 社区内边密度，密度比越低 = 缺口越大；
 *    缺口的「价值」= 两侧社区规模乘积（两侧都大 = 翻译收益高）。
 *
 * 2. **衰减先兆（decay）**：某个曾经活跃的主题正在**退烧**——最近窗口
 *    的提及频次相对历史基线显著下滑，且该主题在知识图谱中仍是枢纽
 *    （说明它重要）。算法：指数滑动平均 vs 长窗口基线的比率，乘以
 *    图上的介数中心性（近似用度数）。这是「你正在失去什么」的预警。
 *
 * 3. **桥接机会（bridge）**：两个主题在**时间上交替活跃**（一个退烧
 *    时另一个升温），暗示它们在认知上是替代或配套关系，但图上无
 *    强连接。算法：主题活跃度序列的负相关（Spearman）+ 图距离 ≥ 3。
 *
 * 三类信号都是纯本地、确定性、可测的。输出统一为 `CuriositySignal`，
 * 由模块层接入洞察中心（作为新的 Provider）或独立端点。
 *
 * 与既有轴线的分工：
 * - 轴线 34（暗物质）预测**缺失的边**（微观：两个实体该连）；
 * - 轴线 36（掮客）识别**已在承载跨域流量的实体**（中观：谁是桥）；
 * - 本引擎识别**结构性的知识缺口与注意力退潮**（宏观：整块大陆的
 *   关系与兴衰）。三者互补：暗物质告诉你加哪条边，掮客告诉你守住
 *   谁，好奇心告诉你**下一场对话该往哪走**。
 */
import { tokenize } from '../retrieval/tokenize.js';
import { detectCommunities } from '../graph/louvain.js';
/** 缺口判定：社区规模下限（缺省 4）。 */
const DEFAULT_MIN_COMMUNITY_SIZE = 4;
/** 桥接判定：最小跳数（缺省 3）。 */
const DEFAULT_MIN_BRIDGE_HOP = 3;
/** 每类信号返回上限（缺省 3）。 */
const DEFAULT_TOP_K = 3;
/** 衰减检测窗口（缺省：近 8 点 vs 前 32 点）。 */
const DEFAULT_RECENT_WINDOW = 8;
const DEFAULT_BASELINE_WINDOW = 32;
/**
 * 计算共现图上的**结构性知识缺口**。
 *
 * 算法：
 * 1. Louvain 社区发现（复用轴线 26 实现）；
 * 2. 对每对社区 (i, j)：crossEdges = 跨社区边权，internal = 两社区
 *    内部边密度（边权 / 可能边数）的加权平均；
 * 3. 缺口分 = (1 − crossEdges / max(internal, ε)) × 规模项；
 *    规模项 = log(minSize) / log(maxSize)，两侧都大才值得打通。
 *
 * 与轴线 34 的分工：暗物质找「有共同邻居的实体对」，缺口找「两个
 * 已成型社区之间没有桥」——前者是微观补边，后者是宏观打通。
 */
export function detectKnowledgeGaps(graph, options = {}) {
    const minSize = Math.max(2, options.minCommunitySize ?? DEFAULT_MIN_COMMUNITY_SIZE);
    const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
    if (graph.nodes.length < minSize * 2 || graph.edgeCount === 0)
        return [];
    const report = detectCommunities(graph);
    const communities = report.communities.filter((c) => c.entities.length >= minSize);
    if (communities.length < 2)
        return [];
    // 社区成员键集合 → 下标。
    const members = communities.map((c) => new Set(c.entities.map((e) => e.key)));
    // 计算社区内部边密度与跨社区边权。
    const internal = new Array(communities.length).fill(0);
    const cross = new Map();
    for (const node of graph.nodes) {
        const neighbors = graph.adjacency.get(node.key);
        if (neighbors === undefined)
            continue;
        const i = members.findIndex((set) => set.has(node.key));
        if (i < 0)
            continue;
        for (const [other, weight] of neighbors) {
            const j = members.findIndex((set) => set.has(other));
            if (j < 0)
                continue;
            if (i === j)
                internal[i] += weight;
            else {
                const key = i < j ? `${i}:${j}` : `${j}:${i}`;
                cross.set(key, (cross.get(key) ?? 0) + weight);
            }
        }
    }
    // 内部边密度（归一：边权 / 可能边数）。
    const density = communities.map((c, index) => {
        const n = c.entities.length;
        const possible = (n * (n - 1)) / 2;
        return possible > 0 ? internal[index] / possible : 0;
    });
    const signals = [];
    for (let i = 0; i < communities.length; i += 1) {
        for (let j = i + 1; j < communities.length; j += 1) {
            const key = `${i}:${j}`;
            const crossEdges = cross.get(key) ?? 0;
            const internalDensity = (density[i] + density[j]) / 2;
            // 缺口：跨社区边远少于社区内密度 → 两侧缺少翻译层。
            const ratio = internalDensity > 0 ? crossEdges / internalDensity : crossEdges;
            const gapScore = Math.max(0, 1 - ratio);
            if (gapScore <= 0)
                continue;
            const leftSize = communities[i].entities.length;
            const rightSize = communities[j].entities.length;
            const minSide = Math.min(leftSize, rightSize);
            const maxSide = Math.max(leftSize, rightSize);
            // 规模项：两侧都大才值得打通（log 压缩避免大社区垄断）。
            const scale = maxSide > 1 ? Math.log(minSide) / Math.log(maxSide) : 0;
            const score = Number((gapScore * scale).toFixed(4));
            if (score <= 0)
                continue;
            signals.push({
                kind: 'gap',
                leftTerms: communities[i].topEntities.slice(0, 3).map((e) => e.name),
                rightTerms: communities[j].topEntities.slice(0, 3).map((e) => e.name),
                leftSize,
                rightSize,
                crossEdges,
                internalDensity: Number(internalDensity.toFixed(4)),
                score,
                severity: score >= 0.7 ? 'watch' : 'info',
            });
        }
    }
    signals.sort((a, b) => b.score - a.score);
    return signals.slice(0, topK);
}
/**
 * 检测**注意力退潮**：曾经活跃的主题正在降温，且它在图上仍是枢纽。
 *
 * 输入是每个实体的活跃度时间序列（由调用方从会话时间线投影）。
 * 算法：近 `recentWindow` 点的均值 vs 前 `baselineWindow` 点的均值；
 * ratio = recent / baseline；衰减分 = (1 − ratio) × 度数权重（度数经
 * log 压缩，避免超级枢纽垄断）。
 */
export function detectDecay(graph, activity, options = {}) {
    const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
    const recentWindow = Math.max(2, options.recentWindow ?? DEFAULT_RECENT_WINDOW);
    const baselineWindow = Math.max(4, options.baselineWindow ?? DEFAULT_BASELINE_WINDOW);
    if (activity.size === 0)
        return [];
    const degreeOf = new Map();
    for (const node of graph.nodes) {
        degreeOf.set(node.key, graph.adjacency.get(node.key)?.size ?? 0);
    }
    const maxDegree = Math.max(1, ...degreeOf.values());
    const signals = [];
    for (const [key, series] of activity) {
        if (series.length < recentWindow + 2)
            continue;
        const recent = series.slice(-recentWindow);
        const baseline = series.slice(-(recentWindow + baselineWindow), -recentWindow);
        if (baseline.length === 0)
            continue;
        const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const baselineMean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
        if (baselineMean <= 0)
            continue;
        const ratio = recentMean / baselineMean;
        if (ratio >= 0.85)
            continue; // 退潮不明显
        const degree = degreeOf.get(key) ?? 0;
        // 度数权重：枢纽退潮比边缘退潮更值得预警。
        const weight = degree > 0 ? Math.log(1 + degree) / Math.log(1 + maxDegree) : 0;
        const score = Number(((1 - ratio) * weight).toFixed(4));
        if (score <= 0)
            continue;
        const node = graph.nodes.find((n) => n.key === key);
        signals.push({
            kind: 'decay',
            anchor: node?.name ?? key,
            recent: Number(recentMean.toFixed(3)),
            baseline: Number(baselineMean.toFixed(3)),
            ratio: Number(ratio.toFixed(3)),
            degree,
            score,
            severity: score >= 0.5 ? 'watch' : 'info',
        });
    }
    signals.sort((a, b) => b.score - a.score);
    return signals.slice(0, topK);
}
/**
 * 检测**桥接机会**：两个主题在时间上交替活跃，但图上疏远。
 *
 * 算法：
 * 1. 对每对实体计算活跃度序列的 Spearman 秩相关（负 = 交替）；
 * 2. 图上 BFS 最短路径 ≥ minBridgeHop（说明认知上疏远）；
 * 3. 分 = |负相关| × 疏远度（跳数归一）。
 */
export function detectBridges(graph, activity, options = {}) {
    const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
    const minHop = Math.max(2, options.minBridgeHop ?? DEFAULT_MIN_BRIDGE_HOP);
    const keys = [...activity.keys()].filter((key) => (activity.get(key)?.length ?? 0) >= 6);
    if (keys.length < 2)
        return [];
    const nameOf = new Map();
    for (const node of graph.nodes)
        nameOf.set(node.key, node.name);
    const hop = shortestHopCache(graph);
    const signals = [];
    for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
            const a = activity.get(keys[i]);
            const b = activity.get(keys[j]);
            const length = Math.min(a.length, b.length);
            if (length < 6)
                continue;
            const corr = spearman(a.slice(-length), b.slice(-length));
            if (corr >= -0.3)
                continue; // 不算交替
            const hopDistance = hop(keys[i], keys[j]);
            if (hopDistance !== null && hopDistance < minHop)
                continue;
            const distance = hopDistance === null ? 1 : Math.min(1, hopDistance / (minHop * 2));
            const score = Number((Math.abs(corr) * distance).toFixed(4));
            if (score <= 0)
                continue;
            signals.push({
                kind: 'bridge',
                left: nameOf.get(keys[i]) ?? keys[i],
                right: nameOf.get(keys[j]) ?? keys[j],
                correlation: Number(corr.toFixed(3)),
                hopDistance,
                score,
                severity: score >= 0.5 ? 'info' : 'info',
            });
        }
    }
    signals.sort((a, b) => b.score - a.score);
    return signals.slice(0, topK);
}
/** BFS 最短跳数（带缓存：一次构建，多次查询）。 */
function shortestHopCache(graph) {
    const cache = new Map();
    return (a, b) => {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const cached = cache.get(key);
        if (cached !== undefined)
            return cached;
        const distance = bfsHop(graph, a, b);
        cache.set(key, distance);
        return distance;
    };
}
/** 两点间 BFS 最短跳数（不可达为 null）。 */
function bfsHop(graph, from, to) {
    if (from === to)
        return 0;
    const visited = new Set([from]);
    let frontier = [from];
    let depth = 0;
    while (frontier.length > 0) {
        depth += 1;
        if (depth > 8)
            break; // 跳数上限：更远的视为不可达
        const next = [];
        for (const node of frontier) {
            const neighbors = graph.adjacency.get(node);
            if (neighbors === undefined)
                continue;
            for (const other of neighbors.keys()) {
                if (other === to)
                    return depth;
                if (visited.has(other))
                    continue;
                visited.add(other);
                next.push(other);
            }
        }
        frontier = next;
    }
    return null;
}
/** Spearman 秩相关（并列取平均秩；序列长度 < 3 返回 0）。 */
function spearman(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3)
        return 0;
    const rank = (values) => {
        const indexed = values.map((value, index) => ({ value, index }));
        indexed.sort((x, y) => x.value - y.value || x.index - y.index);
        const ranks = new Array(values.length).fill(0);
        let position = 0;
        while (position < indexed.length) {
            let end = position;
            while (end + 1 < indexed.length && indexed[end + 1].value === indexed[position].value) {
                end += 1;
            }
            const average = (position + end) / 2 + 1;
            for (let k = position; k <= end; k += 1)
                ranks[indexed[k].index] = average;
            position = end + 1;
        }
        return ranks;
    };
    const ra = rank(a.slice(0, n));
    const rb = rank(b.slice(0, n));
    const meanA = ra.reduce((x, y) => x + y, 0) / n;
    const meanB = rb.reduce((x, y) => x + y, 0) / n;
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < n; i += 1) {
        const da = ra[i] - meanA;
        const db = rb[i] - meanB;
        num += da * db;
        denA += da * da;
        denB += db * db;
    }
    if (denA === 0 || denB === 0)
        return 0;
    return num / Math.sqrt(denA * denB);
}
/**
 * 好奇心引擎主入口：一次性产出三类信号与人话摘要。
 *
 * @param graph 实体共现图（轴线 26 同源）。
 * @param activity 实体活跃度时间序列（实体键 → 按时间序的计数字典）。
 * @param options 参数。
 */
export function computeCuriosity(graph, activity, options = {}) {
    const gaps = detectKnowledgeGaps(graph, options);
    const decays = detectDecay(graph, activity, options);
    const bridges = detectBridges(graph, activity, options);
    return {
        entities: graph.nodes.length,
        communities: detectCommunities(graph).communities.length,
        gaps,
        decays,
        bridges,
        summary: summarizeCuriosity(gaps, decays, bridges),
    };
}
/** 好奇心报告人话摘要。 */
function summarizeCuriosity(gaps, decays, bridges) {
    const parts = [];
    if (gaps.length > 0) {
        const top = gaps[0];
        parts.push(`发现 ${gaps.length} 处知识缺口（最大一处：「${top.leftTerms.join('、')}」与「${top.rightTerms.join('、')}」之间缺少翻译层）`);
    }
    if (decays.length > 0) {
        const top = decays[0];
        parts.push(`${decays.length} 个主题正在退潮（最明显：「${top.anchor}」活跃度降至基线的 ${Math.round(top.ratio * 100)}%）`);
    }
    if (bridges.length > 0) {
        parts.push(`${bridges.length} 对主题在时间上交替活跃但图上疏远——可能是替代或配套关系`);
    }
    return parts.length === 0
        ? '知识图谱结构均衡，暂未发现值得主动指出的缺口或退潮'
        : parts.join('；');
}
/** 从会话实体投影构建活跃度序列（时间分桶）。 */
export function buildActivitySeries(sessions, buckets, now, windowMs) {
    const series = new Map();
    const bucketMs = Math.max(1, Math.floor(windowMs / Math.max(1, buckets)));
    for (const session of sessions) {
        const offset = Math.max(0, Math.floor((now - session.at) / bucketMs));
        if (offset >= buckets)
            continue;
        const index = buckets - 1 - offset;
        for (const key of session.entityKeys) {
            let array = series.get(key);
            if (array === undefined) {
                array = new Array(buckets).fill(0);
                series.set(key, array);
            }
            array[index] += 1;
        }
    }
    return new Map([...series]);
}
/** 词元集合（供外部做主题词提取）。 */
export function curiosityTokens(text) {
    return tokenize(text);
}
