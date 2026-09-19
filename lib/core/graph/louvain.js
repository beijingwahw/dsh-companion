/**
 * Louvain 社区发现主入口：在共现图上迭代「局部移动 + 聚合」，
 * 返回模块度最大化的社区划分与多层还原的成员归属。
 *
 * @param graph 共现图（buildEntityGraph 产物）。
 * @param options 参数（全部缺省即可用）。
 */
export function detectCommunities(graph, options = {}) {
    const maxPasses = options.maxPasses ?? 15;
    const maxLevels = options.maxLevels ?? 10;
    const order = graph.nodes.length;
    if (order === 0 || graph.totalWeight <= 0) {
        return {
            modularity: 0,
            levels: 0,
            communities: [],
            graph: { nodes: order, edges: graph.edgeCount },
            summary: order === 0
                ? '实体图为空：还没有可聚类的知识'
                : '实体图无共现边：实体尚未在任何会话中同时出现',
        };
    }
    let layer = toLayer(graph);
    // 成员折叠表：当前层节点 i → 其代表的原始实体索引列表。
    let membership = graph.nodes.map((_, index) => [index]);
    let assignment = [];
    let modularity = 0;
    let levels = 0;
    // 收敛保证：可聚合时层规模严格递减，maxLevels 只是额外护栏。
    for (;;) {
        assignment = localMoving(layer, maxPasses, options.seed ?? 0, levels);
        modularity = modularityOf(layer, assignment);
        levels += 1;
        if (levels >= maxLevels)
            break;
        if (new Set(assignment).size >= layer.order)
            break;
        const next = aggregate(layer, assignment);
        if (next === undefined)
            break;
        membership = foldMembership(membership, assignment, next.order);
        layer = next;
    }
    // 最终成员表：社区 → 原始实体索引并集。
    const memberTable = [];
    for (let node = 0; node < layer.order; node += 1) {
        const community = assignment[node];
        while (memberTable.length <= community)
            memberTable.push([]);
        memberTable[community].push(...membership[node]);
    }
    return buildReport(graph, memberTable, modularity, levels);
}
/** 原始共现图 → 初始层（索引邻接形态；节点顺序与 graph.nodes 一致）。 */
function toLayer(graph) {
    const order = graph.nodes.length;
    const keyToIndex = new Map();
    graph.nodes.forEach((node, index) => keyToIndex.set(node.key, index));
    const adjacency = Array.from({ length: order }, () => new Map());
    for (const [from, neighbors] of graph.adjacency) {
        const fromIndex = keyToIndex.get(from);
        if (fromIndex === undefined)
            continue;
        for (const [to, weight] of neighbors) {
            const toIndex = keyToIndex.get(to);
            if (toIndex === undefined || toIndex === fromIndex)
                continue;
            adjacency[fromIndex].set(toIndex, weight);
        }
    }
    return { order, adjacency, selfLoops: new Array(order).fill(0), totalWeight: graph.totalWeight };
}
/**
 * 阶段一（局部移动）：节点逐个迁入增益最大的邻居社区，直到无移动
 * 或轮数上限。增益为 `G(c) = 2m·k_i,in(c) − Σ_tot(c)·k_i`（2m²·ΔQ 尺度，
 * 常数因子不影响 argmax）。
 */
function localMoving(layer, maxPasses, seed, level) {
    const { order, adjacency, selfLoops, totalWeight } = layer;
    const community = Array.from({ length: order }, (_, index) => index);
    const degree = new Float64Array(order);
    const sigmaTotal = new Float64Array(order);
    for (let node = 0; node < order; node += 1) {
        // 自环计入度数两次（图论约定），保证 2m = Σ度数。
        let sum = 2 * selfLoops[node];
        for (const weight of adjacency[node].values())
            sum += weight;
        degree[node] = sum;
        sigmaTotal[community[node]] = sum;
    }
    const twoM = 2 * totalWeight;
    if (twoM <= 0)
        return community;
    const visitOrder = visitOrderOf(order, seed, level);
    for (let pass = 0; pass < maxPasses; pass += 1) {
        let moved = false;
        for (const node of visitOrder) {
            const neighbors = adjacency[node];
            if (neighbors.size === 0)
                continue;
            const current = community[node];
            const k = degree[node];
            // 邻居社区 → k_i,in（节点与该社区的连接权重和）。
            const linksTo = new Map();
            for (const [neighbor, weight] of neighbors) {
                const target = community[neighbor];
                linksTo.set(target, (linksTo.get(target) ?? 0) + weight);
            }
            sigmaTotal[current] -= k;
            let bestCommunity = current;
            let bestGain = twoM * (linksTo.get(current) ?? 0) - sigmaTotal[current] * k;
            for (const [target, kIn] of linksTo) {
                if (target === current)
                    continue;
                const gain = twoM * kIn - sigmaTotal[target] * k;
                if (gain > bestGain + 1e-12) {
                    bestGain = gain;
                    bestCommunity = target;
                }
            }
            sigmaTotal[bestCommunity] += k;
            if (bestCommunity !== current) {
                community[node] = bestCommunity;
                moved = true;
            }
        }
        if (!moved)
            break;
    }
    return renumber(community);
}
/** 稳定访问顺序（seed=0）或线性同余扰动顺序（同种子可复现）。 */
function visitOrderOf(order, seed, level) {
    const visitOrder = Array.from({ length: order }, (_, index) => index);
    if (seed === 0)
        return visitOrder;
    let state = (Math.imul(seed + level + 1, 2654435761) >>> 0) || 1;
    for (let i = order - 1; i > 0; i -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = state % (i + 1);
        const temp = visitOrder[i];
        visitOrder[i] = visitOrder[j];
        visitOrder[j] = temp;
    }
    return visitOrder;
}
/** 社区 id 连续化（局部移动后可能出现空洞）。 */
function renumber(assignment) {
    const remap = new Map();
    const result = [];
    for (const community of assignment) {
        let next = remap.get(community);
        if (next === undefined) {
            next = remap.size;
            remap.set(community, next);
        }
        result.push(next);
    }
    return result;
}
/**
 * 阶段二（聚合）：社区收缩为超节点。社区内无向边与新节点自环等权
 * （单侧计一次），跨社区边权相加；旧自环随成员并入。2m 恒守恒。
 */
function aggregate(layer, assignment) {
    const { order, adjacency, selfLoops } = layer;
    const distinct = new Set(assignment);
    if (distinct.size >= order)
        return undefined;
    const communityIndex = new Map();
    for (const community of distinct)
        communityIndex.set(community, communityIndex.size);
    const newOrder = communityIndex.size;
    const newSelfLoops = new Array(newOrder).fill(0);
    for (let node = 0; node < order; node += 1) {
        newSelfLoops[communityIndex.get(assignment[node]) ?? 0] += selfLoops[node];
    }
    // 跨社区边与社区内边：邻接双侧对称 → 累计后除 2 还原单侧。
    const crossPairs = new Map();
    const internal = new Array(newOrder).fill(0);
    for (let node = 0; node < order; node += 1) {
        const from = communityIndex.get(assignment[node]) ?? 0;
        for (const [neighbor, weight] of adjacency[node]) {
            const to = communityIndex.get(assignment[neighbor]) ?? 0;
            if (from === to)
                internal[from] += weight / 2;
            else {
                let targets = crossPairs.get(from);
                if (targets === undefined) {
                    targets = new Map();
                    crossPairs.set(from, targets);
                }
                targets.set(to, (targets.get(to) ?? 0) + weight / 2);
            }
        }
    }
    for (let community = 0; community < newOrder; community += 1)
        newSelfLoops[community] += internal[community];
    const newAdjacency = Array.from({ length: newOrder }, () => new Map());
    let total = 0;
    for (let community = 0; community < newOrder; community += 1)
        total += newSelfLoops[community];
    for (const [from, targets] of crossPairs) {
        for (const [to, weight] of targets) {
            newAdjacency[from].set(to, weight);
            newAdjacency[to].set(from, weight);
            total += weight;
        }
    }
    return { order: newOrder, adjacency: newAdjacency, selfLoops: newSelfLoops, totalWeight: total };
}
/** 成员折叠：新层节点（社区）→ 旧层成员代表的原始实体索引并集。 */
function foldMembership(membership, assignment, newOrder) {
    const folded = Array.from({ length: newOrder }, () => []);
    for (let node = 0; node < assignment.length; node += 1) {
        folded[assignment[node]].push(...membership[node]);
    }
    return folded;
}
/** 模块度 Q = Σ_c [ Σ_in(c)/2m − (Σ_tot(c)/2m)² ]；Σ_in = 2×(社区内边 + 自环)。 */
function modularityOf(layer, assignment) {
    const twoM = 2 * layer.totalWeight;
    if (twoM <= 0)
        return 0;
    // sigmaHalf：社区内边（单侧）+ 成员自环——最终 ×2 得 Σ_in。
    const sigmaHalf = new Map();
    const sigmaTotal = new Map();
    for (let node = 0; node < layer.order; node += 1) {
        const community = assignment[node];
        let degree = 2 * layer.selfLoops[node];
        for (const weight of layer.adjacency[node].values())
            degree += weight;
        sigmaTotal.set(community, (sigmaTotal.get(community) ?? 0) + degree);
        sigmaHalf.set(community, (sigmaHalf.get(community) ?? 0) + layer.selfLoops[node]);
        for (const [neighbor, weight] of layer.adjacency[node]) {
            if (assignment[neighbor] === community) {
                // 双侧循环各计一次 → 除 2 还原单侧。
                sigmaHalf.set(community, (sigmaHalf.get(community) ?? 0) + weight / 2);
            }
        }
    }
    let q = 0;
    for (const [community, total] of sigmaTotal) {
        const intra = 2 * (sigmaHalf.get(community) ?? 0);
        q += intra / twoM - (total / twoM) * (total / twoM);
    }
    return q;
}
/** 组装最终报告：社区成员表（原始索引）→ 实体视图与统计。 */
function buildReport(graph, memberTable, modularity, levels) {
    const communities = [];
    for (const members of memberTable) {
        if (members.length === 0)
            continue;
        const sessions = new Set();
        const entityViews = [];
        for (const index of members) {
            const node = graph.nodes[index];
            if (node === undefined)
                continue;
            for (const sessionId of node.sessions)
                sessions.add(sessionId);
            let degree = 0;
            const neighbors = graph.adjacency.get(node.key);
            if (neighbors !== undefined)
                for (const weight of neighbors.values())
                    degree += weight;
            entityViews.push({ key: node.key, name: node.name, type: node.type, degree, sessions: node.sessions.size });
        }
        if (entityViews.length === 0)
            continue;
        entityViews.sort((a, b) => b.degree - a.degree || a.key.localeCompare(b.key));
        communities.push({
            id: communities.length,
            entities: entityViews,
            size: entityViews.length,
            sessionCount: sessions.size,
            internalWeight: internalWeightOf(graph, entityViews),
            topEntities: entityViews.slice(0, 5).map((view) => ({ name: view.name, type: view.type })),
        });
    }
    communities.sort((a, b) => b.size - a.size || b.sessionCount - a.sessionCount);
    communities.forEach((community, index) => {
        community.id = index;
    });
    return {
        modularity,
        levels,
        communities,
        graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
        summary: communitySummary(communities, modularity),
    };
}
/** 社区内边权（无向单侧计）。 */
function internalWeightOf(graph, entities) {
    const keys = new Set(entities.map((view) => view.key));
    let internal = 0;
    for (const key of keys) {
        const neighbors = graph.adjacency.get(key);
        if (neighbors === undefined)
            continue;
        for (const [other, weight] of neighbors) {
            if (other > key && keys.has(other))
                internal += weight;
        }
    }
    return internal;
}
/** 人话摘要。 */
function communitySummary(communities, modularity) {
    if (communities.length === 0)
        return '未发现任何知识社区';
    const top = communities[0];
    const names = top.topEntities.slice(0, 3).map((entity) => entity.name).join('、');
    return `发现 ${communities.length} 块知识大陆（模块度 ${modularity.toFixed(3)}），最大一块以 ${names} 为骨架，覆盖 ${top.sessionCount} 个会话`;
}
