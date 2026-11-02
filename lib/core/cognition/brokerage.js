/**
 * 结构洞掮客引擎（轴线 36「跨域翻译者识别」）：知识图谱上承载跨域
 * 翻译的桥梁实体检测（Burt 2004, "Structural Holes and Good Ideas"）。
 *
 * 设计动机：轴线 26「知识大陆」把共现图切成知识域，轴线 27 沿已有边
 * 扩散引力，轴线 34 预测缺失边——三者都没有回答一个关键问题：
 * **哪些实体是两块大陆之间的桥梁？** 现实的知识图里最被低估的资产
 * 是「掮客」实体：它不深入任何一块大陆的腹地，却同时与多块大陆的
 * 骨干共现——docker compose 同时连着前端构建域与运维部署域，
 * 「类型」这个词同时出现在类型论与 TypeScript 语境。Burt 2004 的
 * 经验发现：**跨越结构洞的人 disproportionately 地产生好想法**——
 * 他们同时暴露在多个领域的词汇与解法下，做的正是「跨域翻译」。
 * 这些实体是知识宇宙里的海峡：自己不是大陆，却让两块大陆通航。
 *
 * 两套互补的经典测量：
 *
 * - **Burt 结构洞测量**（Burt 1992 网络约束，2004 作为掮客的操作化）：
 *   - 网络约束 `C_i = Σ_j (p_ij + Σ_q p_iq·p_qj)²`——p 为边权行归一
 *     比例，直接项 p_ij 是 i 在 j 上的投入占比，间接项 Σ p_iq·p_qj
 *     是「经其他接触 q 绕到 j 的冗余投入」；约束越高 = 接触彼此抱团、
 *     跨的洞越少。**低约束 = 跨结构洞的掮客**；
 *   - 有效规模 `e_i = Σ_j (1 − Σ_q p_iq·m_jq)`——接触 j 的冗余折扣
 *     （m_jq 为 j 除回指 i 外的边权归一，Burt 原始冗余公式）；
 *     效率 = 有效规模 / 度数；
 * - **Gould-Fernandez 掮客角色**（Gould & Fernandez 1989）：以轴线 26
 *   同源 Louvain 大陆为分组，对 i 的每个有序接触对 (j→k) 分类五角色：
 *   协调 coordinator（三方同组）／顾问 consultant（j、k 同组，i 异组
 *   ——外请的翻译）／代表 representative（i、j 同组，k 异组——对外
 *   发声）／守门 gatekeeper（i、k 同组，j 异组——引进外部）／
 *   联络 liaison（三方三组——纯跨域桥）。无向图上守门与代表互为
 *   镜像（每个跨组无序对各计一次），这是 GF 分类在无向图上的已知
 *   对称性。**跨域翻译 = 非协调中介对**（totalPairs − coordinator）。
 *
 * 掮客分 = 0.5 × 洞分 + 0.3 × 跨域占比 + 0.2 × 规模分（候选集内归一）：
 * 低约束给洞分，跨组中介对占比给跨域占比，log 中介对量给规模分——
 * 一个只在单块大陆内当枢纽的实体跨域占比为零，一个只连两条边的
 * 微型桥规模不足，融合分同时要求「跨得开」与「扛得起」。
 *
 * 与相邻轴线的分工：大陆（26）切块，星图（27）沿已有边走，暗物质
 * （34）找该连未连的边，本轴识别**已经在承载跨域流量**的实体。
 * 掮客是双刃剑：跨域翻译的枢纽（Burt：好想法的来源），也是单点
 * 失效——掮客遗忘，两域失联。行动出口：掮客实体值得优先巩固
 * （轴线 21/23 复习优先级参考）。
 *
 * 守卫：掮客候选须度数 ≥ 2（单接触无从中介）；中介对展开设预算熔断
 * 防御病态稠密图；分组可选（缺省全库单组——五角色退化为纯协调计数，
 * 报告标注 groupCount 供前端提示）。纯本地、零 LLM、零网络；确定性输出。
 */
/**
 * 结构洞掮客主入口：识别承载跨域翻译的桥梁实体。
 *
 * @param graph 实体共现图（轴线 26 同源 buildEntityGraph 产物）。
 * @param options 参数（见 BrokerageOptions）。
 */
export function detectBrokerage(graph, options = {}) {
    const topK = Math.max(1, options.topK ?? 15);
    const minDegree = Math.max(2, options.minDegree ?? 2);
    const budget = Math.max(100, options.pairBudget ?? 500_000);
    const groups = options.groups;
    const groupOf = (key) => groups?.get(key) ?? 0;
    const empty = {
        graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
        groupCount: 0,
        candidates: 0,
        budgetExhausted: false,
        brokers: [],
        summary: '',
    };
    if (graph.nodes.length < 3 || graph.edgeCount === 0) {
        return { ...empty, summary: '实体图规模不足（< 3 节点或无边）——共现结构还撑不起掮客检测' };
    }
    // 全库节点强度表（p_ij 与 p_qj 归一化基准）。
    const strength = new Map();
    for (const [key, neighbors] of graph.adjacency) {
        let sum = 0;
        for (const weight of neighbors.values())
            sum += weight;
        strength.set(key, sum);
    }
    const names = new Map();
    for (const node of graph.nodes)
        names.set(node.key, { name: node.name, type: node.type });
    // 候选统计：度数达标者逐个计算约束 / 有效规模 / 角色。
    const stats = [];
    let pairCount = 0;
    let budgetExhausted = false;
    for (const node of graph.nodes) {
        const neighbors = graph.adjacency.get(node.key);
        if (neighbors === undefined || neighbors.size < minDegree)
            continue;
        const degree = neighbors.size;
        const totalPairs = degree * (degree - 1);
        if (pairCount + totalPairs > budget) {
            budgetExhausted = true;
            break;
        }
        pairCount += totalPairs;
        stats.push(brokerStatsOf(node.key, neighbors, strength, graph.adjacency, groupOf));
    }
    if (stats.length === 0) {
        return {
            ...empty,
            budgetExhausted,
            summary: budgetExhausted
                ? `中介对展开触达预算 ${budget}——图已枢纽化，掮客检测结果为下界`
                : `没有度数 ≥ ${minDegree} 的实体——还没有实体同时连接两个以上邻居`,
        };
    }
    // 归一化基准：约束区间与最大中介对量（候选集内）。
    let minConstraint = Infinity;
    let maxConstraint = -Infinity;
    let maxPairs = 0;
    for (const stat of stats) {
        if (stat.constraint < minConstraint)
            minConstraint = stat.constraint;
        if (stat.constraint > maxConstraint)
            maxConstraint = stat.constraint;
        if (stat.totalPairs > maxPairs)
            maxPairs = stat.totalPairs;
    }
    const constraintRange = maxConstraint - minConstraint;
    const logMaxPairs = Math.log(1 + maxPairs);
    // 分组数按全图节点统计（角色分类涉及掮客的接触方，不止掮客自身）。
    const groupSeen = new Set();
    for (const node of graph.nodes)
        groupSeen.add(groupOf(node.key));
    const brokers = stats
        .map((stat) => {
        // 洞分：约束倒序归一（区间退化时全部 0——约束无区分度不贡献分数）。
        const holeEvidence = constraintRange > 1e-12 ? 1 - (stat.constraint - minConstraint) / constraintRange : 0;
        const crossShare = stat.crossGroupPairs / stat.totalPairs;
        const volumeEvidence = logMaxPairs > 0 ? Math.log(1 + stat.totalPairs) / logMaxPairs : 0;
        const score = round4(0.5 * holeEvidence + 0.3 * crossShare + 0.2 * volumeEvidence);
        const info = names.get(stat.key) ?? { name: stat.key, type: '' };
        return {
            key: stat.key,
            name: info.name,
            type: info.type,
            degree: stat.degree,
            effectiveSize: round4(stat.effectiveSize),
            efficiency: round4(stat.effectiveSize / stat.degree),
            constraint: round4(stat.constraint),
            roles: stat.roles,
            totalPairs: stat.totalPairs,
            crossGroupPairs: stat.crossGroupPairs,
            crossShare: round4(crossShare),
            score,
            interpretation: interpret(stat, info.name),
        };
    })
        .sort((a, b) => b.score - a.score ||
        b.crossGroupPairs - a.crossGroupPairs ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .slice(0, topK);
    return {
        graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
        groupCount: groupSeen.size,
        candidates: stats.length,
        budgetExhausted,
        brokers,
        summary: summarize(brokers, stats.length, groupSeen.size, budgetExhausted),
    };
}
/** 单个掮客候选的约束 / 有效规模 / 角色统计。 */
function brokerStatsOf(key, neighbors, strength, adjacency, groupOf) {
    // p_ij = w_ij / Σ_k w_ik（Burt 比例矩阵的行归一）。
    const own = strength.get(key) ?? 1;
    const p = new Map();
    for (const [neighbor, weight] of neighbors)
        p.set(neighbor, weight / own);
    // 网络约束：c_ij = (p_ij + Σ_q p_iq·p_qj)²，q 取遍 i 的接触
    // （q 与 j 无边时 p_qj = 0，间接项自然为零）。
    let constraint = 0;
    for (const [j, pij] of p) {
        let indirect = 0;
        const jStrength = strength.get(j) ?? 1;
        for (const [q, piq] of p) {
            const wqj = adjacency.get(q)?.get(j) ?? 0;
            if (wqj > 0)
                indirect += piq * (wqj / jStrength);
        }
        constraint += (pij + indirect) ** 2;
    }
    // 有效规模：e = Σ_j (1 − Σ_q p_iq·m_jq)；m_jq 在 j 的边权上归一且
    // 剔除回指 i 的边（Burt 冗余公式——经过 i 自己的环路不是冗余）。
    let effectiveSize = 0;
    for (const [j, pij] of p) {
        const jEdges = adjacency.get(j);
        if (jEdges === undefined) {
            effectiveSize += pij > 0 ? 1 : 0;
            continue;
        }
        let jStrengthEx = 0;
        for (const [other, weight] of jEdges) {
            if (other !== key)
                jStrengthEx += weight;
        }
        if (jStrengthEx <= 0) {
            // j 的全部投入都在 i 上（悬挂接触）：无冗余可折。
            effectiveSize += pij > 0 ? 1 : 0;
            continue;
        }
        let redundancy = 0;
        for (const [q, piq] of p) {
            const wjq = jEdges.get(q) ?? 0;
            if (wjq > 0)
                redundancy += piq * (wjq / jStrengthEx);
        }
        effectiveSize += 1 - redundancy;
    }
    // 五角色计数：i 的全部有序接触对 (j→k) 按 Gould-Fernandez 三元组分类。
    let coordinator = 0;
    let consultant = 0;
    let representative = 0;
    let gatekeeper = 0;
    let liaison = 0;
    const gi = groupOf(key);
    for (const j of p.keys()) {
        const gj = groupOf(j);
        for (const k of p.keys()) {
            if (j === k)
                continue;
            const gk = groupOf(k);
            if (gj === gk) {
                if (gi === gj)
                    coordinator += 1;
                else
                    consultant += 1;
            }
            else if (gi === gj) {
                representative += 1;
            }
            else if (gi === gk) {
                gatekeeper += 1;
            }
            else {
                liaison += 1;
            }
        }
    }
    const roles = { coordinator, consultant, representative, gatekeeper, liaison };
    const degree = neighbors.size;
    const totalPairs = degree * (degree - 1);
    return {
        key,
        degree,
        effectiveSize,
        constraint,
        roles,
        totalPairs,
        crossGroupPairs: totalPairs - coordinator,
    };
}
/** 掮客人话解读：主导跨域角色 + 关键指标。 */
function interpret(stat, name) {
    const { roles } = stat;
    if (stat.crossGroupPairs === 0) {
        return `${name} 的 ${stat.totalPairs} 组中介对全部在组内（协调 ${roles.coordinator}）——是大陆内部的调度者，不是跨域桥梁`;
    }
    const dominant = roles.liaison >= roles.consultant && roles.liaison >= Math.max(roles.representative, roles.gatekeeper)
        ? '纯跨域联络官'
        : roles.consultant >= Math.max(roles.representative, roles.gatekeeper)
            ? '外请的跨域顾问'
            : roles.representative >= roles.gatekeeper
                ? '对外的域代表'
                : '域守门人';
    return `${name} 的 ${stat.totalPairs} 组中介对中 ${stat.crossGroupPairs} 组跨域（联络 ${roles.liaison}／顾问 ${roles.consultant}／代表 ${roles.representative}／守门 ${roles.gatekeeper}），约束 ${stat.constraint.toFixed(2)}——两块大陆之间的${dominant}，跨域翻译在此发生`;
}
/** 掮客报告人话摘要。 */
function summarize(brokers, candidates, groupCount, budgetExhausted) {
    if (brokers.length === 0)
        return '未检出掮客实体——候选集为空';
    const top = brokers[0];
    const tail = groupCount <= 1
        ? '（当前分组为单块大陆：跨域角色需要多块大陆，建议先看 continents）'
        : budgetExhausted
            ? '（中介对展开触达预算，结果为下界）'
            : '';
    return `${candidates} 个候选实体中 ${brokers.length} 位掮客，最强桥梁：${top.name}（掮客分 ${(top.score * 100).toFixed(0)}%，跨域中介 ${top.crossGroupPairs}/${top.totalPairs}）${tail}`;
}
/** 保留 4 位小数。 */
function round4(value) {
    return Number(value.toFixed(4));
}
