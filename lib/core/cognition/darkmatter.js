/**
 * 知识暗物质引擎（轴线 34「缺失连接预测」）：图上尚未建立的连接。
 *
 * 设计动机：轴线 26「知识大陆」把共现图切成社区，轴线 27「星图」沿
 * **已有边**扩散引力——两者都只看图上**看得见的连接**。但一张真实的
 * 知识图谱里最值钱的信息往往是**该连而未连的边**：docker 与 systemd
 * 从未在同一场对话里出现过，但它们共享 5 个共同邻居（nginx、journalctl、
 * systemd-unit…）——你的历史在用共现结构大声暗示"这两件事相关"，
 * 只是从没有一场对话把它们放到一起。这就是知识图谱的**暗物质**：
 * 不发光（无共现边），但有引力（共同邻居结构）。
 *
 * 算法（链路预测的经典局部指数族，Liben-Nowell & Kleinberg 2003）：
 * 对每个**未连接**且**存在共同邻居**的实体对 (u, v)：
 *
 * - **CN**（Common Neighbors）= |Γ(u) ∩ Γ(v)|——朴素计数；
 * - **AA**（Adamic-Adar）= Σ_{w ∈ 共同邻居} 1/ln(deg(w))——度数折扣：
 *   经过枢纽（npm、docker 这类与谁都共现的实体）的"认识"不值钱，
 *   经过低度专业实体的桥才是强证据；
 * - **RA**（Resource Allocation）= Σ_{w ∈ 共同邻居} 1/deg(w)——更强的
 *   折扣（线性而非对数），对小社区桥最敏感。
 *
 * 融合分 = 0.5 × AA 归一 + 0.5 × RA 归一（按全库最大值归一，跨对可比）。
 * 暗连接是**研究建议**而非事实：它们回答"下一场对话值得把谁和谁
 * 放到一起"——暗物质清单 = 你的知识宇宙里最值得点亮的暗区。
 *
 * 候选对生成按"桥节点"展开（对每个低度节点 w，其邻居两两组合），
 * 天然跳过无共同邻居的对；枢纽节点（度数 > hubDegreeCap）不作桥
 * 证据（其邻居对的组合爆炸与证据稀释同时避免）；候选对预算熔断
 * 防御病态稠密图。纯本地、零 LLM、零网络；确定性输出。
 */
/**
 * 暗物质主入口：未连接实体对的链路预测。
 *
 * @param graph 实体共现图（轴线 26 同源 buildEntityGraph 产物）。
 * @param options 参数（见 DarkMatterOptions）。
 */
export function detectDarkMatter(graph, options = {}) {
    const topK = Math.max(1, options.topK ?? 20);
    const hubCap = Math.max(2, options.hubDegreeCap ?? 40);
    const budget = Math.max(1000, options.pairBudget ?? 200_000);
    const empty = {
        graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
        links: [],
        candidates: 0,
        budgetExhausted: false,
        summary: '',
    };
    if (graph.nodes.length < 3 || graph.edgeCount === 0) {
        return { ...empty, summary: '实体图规模不足（< 3 节点或无边）——共现结构还撑不起链路预测' };
    }
    // 度数表 + 名称表。
    const degree = new Map();
    const names = new Map();
    for (const [key, neighbors] of graph.adjacency) {
        degree.set(key, neighbors.size);
    }
    for (const node of graph.nodes)
        names.set(node.key, node.name);
    // 桥节点 = 度数 ≤ hubCap 的实体（枢纽不作证据）。
    const bridges = [];
    for (const [key, deg] of degree) {
        if (deg > 1 && deg <= hubCap)
            bridges.push(key);
    }
    if (bridges.length === 0) {
        return {
            ...empty,
            summary: `全部实体度数超过桥上限 ${hubCap}——图已枢纽化，局部指数失去区分度`,
        };
    }
    // 候选对生成：对每个桥 w，其邻居两两组合（跳过已连接对）。
    const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    const acc = new Map();
    let candidates = 0;
    let budgetExhausted = false;
    for (const bridge of bridges) {
        const neighbors = [...(graph.adjacency.get(bridge) ?? new Map()).keys()];
        for (let x = 0; x < neighbors.length && !budgetExhausted; x += 1) {
            for (let y = x + 1; y < neighbors.length && !budgetExhausted; y += 1) {
                const u = neighbors[x];
                const v = neighbors[y];
                budgetExhausted = acc.size > budget;
                if (budgetExhausted)
                    break;
                // 已连接的对不是暗物质。
                if ((graph.adjacency.get(u) ?? new Map()).has(v))
                    continue;
                const key = pairKey(u, v);
                const deg = degree.get(bridge) ?? 1;
                const contribution = { cn: 1, aa: 1 / Math.log(Math.max(2, deg)), ra: 1 / Math.max(1, deg) };
                const existing = acc.get(key);
                if (existing === undefined) {
                    candidates += 1;
                    acc.set(key, {
                        u,
                        v,
                        cn: contribution.cn,
                        aa: contribution.aa,
                        ra: contribution.ra,
                        evidence: new Map([[bridge, contribution.aa]]),
                    });
                }
                else {
                    existing.cn += contribution.cn;
                    existing.aa += contribution.aa;
                    existing.ra += contribution.ra;
                    existing.evidence.set(bridge, contribution.aa);
                }
            }
        }
        if (budgetExhausted)
            break;
    }
    if (acc.size === 0) {
        return {
            ...empty,
            summary: '未检测到暗连接——共享邻居的实体对都已同场出现过，知识图谱连接饱满',
        };
    }
    // 融合分：AA / RA 各按全库最大值归一后对半融合（跨对可比的 0–1 分）。
    const entries = [...acc.values()];
    const maxAa = Math.max(...entries.map((e) => e.aa));
    const maxRa = Math.max(...entries.map((e) => e.ra));
    const links = entries
        .map((entry) => {
        const score = 0.5 * (entry.aa / maxAa) + 0.5 * (entry.ra / maxRa);
        const evidence = [...entry.evidence.entries()]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, 5)
            .map(([key]) => names.get(key) ?? key);
        return {
            u: names.get(entry.u) ?? entry.u,
            v: names.get(entry.v) ?? entry.v,
            uKey: entry.u,
            vKey: entry.v,
            commonNeighbors: entry.cn,
            adamicAdar: Number(entry.aa.toFixed(4)),
            resourceAllocation: Number(entry.ra.toFixed(4)),
            score: Number(score.toFixed(4)),
            evidence,
            interpretation: `${names.get(entry.u) ?? entry.u} 与 ${names.get(entry.v) ?? entry.v} 共享 ${entry.cn} 个邻居（${evidence.join('、')}）但从未同场出现——你的历史暗示它们相关`,
        };
    })
        .sort((a, b) => b.score - a.score || (a.uKey < b.uKey ? -1 : a.uKey > b.uKey ? 1 : 0))
        .slice(0, topK);
    return {
        graph: { nodes: graph.nodes.length, edges: graph.edgeCount },
        links,
        candidates,
        budgetExhausted,
        summary: summarize(links, candidates),
    };
}
/** 暗物质报告人话摘要。 */
function summarize(links, candidates) {
    if (links.length === 0) {
        return `${candidates} 个候选对经度数折扣后均无证据强度——暂无可点亮的暗区`;
    }
    const top = links[0];
    return `检测到 ${candidates} 个共享邻居的未连接对，最强暗连接：${top.u} ↔ ${top.v}（${top.commonNeighbors} 个共同邻居）——下一场对话值得把它们放到一起`;
}
