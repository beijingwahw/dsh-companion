/**
 * 轴线 26/27/28/29/30/31 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：graph/graph + graph/louvain（知识大陆）、graph/ppr（星图导航）、
 * retrieval/ranker（FTRL-Proximal 学习排序）、synthesis/submodular（次模
 * 证据选择）、cognition/drift（BOCPD 主题漂移）、cognition/consolidation
 * （MinHash-LSH 记忆固化）、insights/pulse 的新信号提供者。
 */
import assert from 'node:assert/strict'
import { buildEntityGraph } from '../lib/core/graph/graph.js'
import { detectCommunities } from '../lib/core/graph/louvain.js'
import {
  personalizedPageRank,
  seedFromQuery,
} from '../lib/core/graph/ppr.js'
import {
  buildRankerFeatures,
  effectiveWeights,
  emptyRankerModel,
  learnedMultiplier,
  predictClickProbability,
  RANKER_NUDGE_CAP,
  RANKER_WARMUP_TARGET,
  RANKER_NEGATIVE_WEIGHT,
  rankerDiagnostics,
  rankerWarmup,
  sanitizeRankerModel,
  updateRanker,
} from '../lib/core/retrieval/ranker.js'
import { selectSubmodular } from '../lib/core/synthesis/submodular.js'
import { detectTopicDrift } from '../lib/core/cognition/drift.js'
import { consolidateMemories } from '../lib/core/cognition/consolidation.js'
import {
  consolidationInsights,
  driftInsights,
} from '../lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const MIN = 60_000

/**
 * 双大陆语料：基建大陆（docker/kubernetes/nginx/redis）与前端大陆
 * （react/webpack/vite/typescript），一座桥（ci-cd 同时出现在两侧）。
 */
function twoContinentRecords() {
  const entity = (name, sessions) => ({
    key: `tech:${name.toLowerCase()}`,
    name,
    type: 'tech',
    sessions,
  })
  return [
    entity('docker', { s1: 3, s2: 2, s3: 1 }),
    entity('kubernetes', { s1: 2, s2: 1, s4: 1 }),
    entity('nginx', { s2: 2, s4: 1 }),
    entity('redis', { s3: 1, s4: 1 }),
    entity('react', { s5: 3, s6: 2, s7: 1 }),
    entity('webpack', { s5: 1, s6: 2, s8: 1 }),
    entity('vite', { s6: 1, s7: 2 }),
    entity('typescript', { s7: 1, s8: 2 }),
    entity('ci-cd', { s4: 1, s8: 1 }),
  ]
}

console.log('轴线 26：graph/louvain（知识大陆：Louvain 社区发现）')

ok('双大陆语料：模块度显著为正，且拆出 ≥2 个社区', () => {
  const graph = buildEntityGraph(twoContinentRecords())
  assert.ok(graph.nodes.length === 9)
  assert.ok(graph.edgeCount >= 10)
  const report = detectCommunities(graph)
  assert.ok(report.modularity > 0.2, `模块度过低：${report.modularity}`)
  assert.ok(report.communities.length >= 2, `社区数不足：${report.communities.length}`)
  assert.ok(report.graph.nodes === 9)
  assert.ok(report.graph.edges === graph.edgeCount)
})

ok('社区核心实体归位：docker 与 kubernetes 同陆，react 与 vite 同陆', () => {
  const report = detectCommunities(buildEntityGraph(twoContinentRecords()))
  const homeOf = new Map()
  for (const community of report.communities) {
    for (const member of community.entities) homeOf.set(member.name, community.id)
  }
  assert.equal(homeOf.get('docker'), homeOf.get('kubernetes'))
  assert.equal(homeOf.get('react'), homeOf.get('vite'))
  assert.notEqual(homeOf.get('docker'), homeOf.get('react'))
  // 头部社区携带代表实体（大陆命名建议）。
  assert.ok(report.communities[0].topEntities.length > 0)
  assert.ok(report.communities[0].internalWeight > 0)
})

ok('空图与全孤岛：零社区不崩溃', () => {
  const empty = detectCommunities(buildEntityGraph([]))
  assert.equal(empty.graph.nodes, 0)
  assert.equal(empty.communities.length, 0)
  // 每个实体只出现在各自独占的会话 → 无共现边 → 无社区。
  const isolated = detectCommunities(
    buildEntityGraph(
      ['a', 'b', 'c'].map((name, i) => ({
        key: `t:${name}`,
        name,
        type: 'term',
        sessions: { [`solo-${i}`]: 1 },
      })),
    ),
  )
  assert.equal(isolated.communities.length, 0)
})

console.log('轴线 27：graph/ppr（星图导航：个性化 PageRank）')

ok('种子查询：完整专名命中实体', () => {
  const graph = buildEntityGraph(twoContinentRecords())
  const seeds = seedFromQuery(graph, 'docker 部署最佳实践')
  assert.ok(seeds.size >= 1)
  assert.ok(seeds.has('tech:docker'))
  assert.equal(seedFromQuery(graph, '完全无关的查询 xyzzy').size, 0)
})

ok('PPR 稳态：分数归一、种子居首、邻域引力衰减', () => {
  const graph = buildEntityGraph(twoContinentRecords())
  const seeds = seedFromQuery(graph, 'docker')
  const ranked = personalizedPageRank(graph, seeds)
  assert.ok(ranked.length === 9)
  const total = ranked.reduce((sum, node) => sum + node.score, 0)
  assert.ok(Math.abs(total - 1) < 1e-6, `分数未归一：${total}`)
  assert.ok(ranked[0].seed, '榜首应为种子')
  assert.equal(ranked[0].key, 'tech:docker')
  // 同陆近邻（kubernetes/nginx）引力高于异陆实体（react/vite）。
  const scoreOf = (key) => ranked.find((node) => node.key === key).score
  assert.ok(scoreOf('tech:kubernetes') > scoreOf('tech:react'))
  // BFS 跳数：种子 0 跳，同陆邻居 1 跳。
  assert.equal(ranked.find((n) => n.key === 'tech:docker').hopDistance, 0)
  assert.ok(ranked.find((n) => n.key === 'tech:kubernetes').hopDistance === 1)
})

ok('多跳浮现：异陆桥接实体经 2 跳可达', () => {
  const graph = buildEntityGraph(twoContinentRecords())
  const seeds = seedFromQuery(graph, 'docker')
  const ranked = personalizedPageRank(graph, seeds)
  const bridge = ranked.find((node) => node.key === 'tech:ci-cd')
  assert.ok(bridge.hopDistance !== null && bridge.hopDistance > 0, '桥接实体应多跳可达')
})

ok('空种子：返回空数组', () => {
  const graph = buildEntityGraph(twoContinentRecords())
  assert.equal(personalizedPageRank(graph, new Map()).length, 0)
})

console.log('轴线 28：retrieval/ranker（FTRL-Proximal 学习排序）')

ok('冷启动：微调乘数恰为 1，暖机系数为 0', () => {
  const model = emptyRankerModel()
  const features = buildRankerFeatures({
    lexicalRank: 1,
    semanticRank: 2,
    recencyBoost: 0.25,
    feedbackBoost: 0.1,
    query: 'docker 部署',
    title: 'docker 部署实践',
  })
  assert.equal(learnedMultiplier(model, features), 1)
  assert.equal(rankerWarmup(model), 0)
  assert.equal(predictClickProbability(model, features), 0.5, '零权重时先验应为 0.5')
})

ok('特征构造：排名 RRF 变换、加成归一、标题命中', () => {
  const features = buildRankerFeatures({
    lexicalRank: 1,
    semanticRank: undefined,
    recencyBoost: 0.25,
    feedbackBoost: 0.35,
    query: 'docker nginx',
    title: 'docker 与 nginx 实战',
  })
  assert.ok(Math.abs(features.lexicalRank - 1 / 61) < 1e-9)
  assert.equal(features.semanticRank, 0)
  assert.equal(features.recency, 1)
  assert.equal(features.feedback, 1)
  assert.ok(features.titleMatch > 0.9)
  assert.equal(features.bias, 1)
})

ok('在线学习：「总点标题命中的结果」→ titleMatch 权重学为正', () => {
  let model = emptyRankerModel()
  const clicked = buildRankerFeatures({
    lexicalRank: 3,
    semanticRank: 3,
    recencyBoost: 0,
    feedbackBoost: 0,
    query: 'docker compose 网络',
    title: 'docker compose 网络配置',
  })
  const skipped = buildRankerFeatures({
    lexicalRank: 1,
    semanticRank: 1,
    recencyBoost: 0,
    feedbackBoost: 0,
    query: 'docker compose 网络',
    title: '周报与杂谈',
  })
  for (let round = 0; round < 40; round += 1) {
    model = updateRanker(model, clicked, 1)
    model = updateRanker(model, skipped, 0, RANKER_NEGATIVE_WEIGHT)
  }
  const weights = effectiveWeights(model)
  assert.ok(weights.titleMatch > 0.1, `titleMatch 权重未学到：${weights.titleMatch}`)
  // 学到的偏好：命中特征的预测点击概率高于未命中的。
  assert.ok(predictClickProbability(model, clicked) > 0.5)
  assert.ok(predictClickProbability(model, clicked) > predictClickProbability(model, skipped))
  // 统计口径：40 点击 + 40 skip-above 负例。
  assert.equal(model.clicks, 40)
  assert.equal(model.examples, 80)
  assert.equal(model.updates, 80)
  // 暖机后微调生效且封顶在 ±30%；对正例特征模式的乘数优于负例模式
  // （skip-above 负例降权 0.25，先验整体偏正属预期——比的是相对序）。
  const warm = rankerWarmup(model)
  assert.ok(warm > 0 && warm <= 1)
  const multiplier = learnedMultiplier(model, clicked)
  assert.ok(multiplier > 1 && multiplier <= 1 + RANKER_NUDGE_CAP + 1e-9)
  assert.ok(learnedMultiplier(model, clicked) > learnedMultiplier(model, skipped))
})

ok('暖机曲线：50 次更新达全幅', () => {
  let model = emptyRankerModel()
  for (let i = 0; i < RANKER_WARMUP_TARGET; i += 1) {
    model = updateRanker(model, buildRankerFeatures({
      lexicalRank: 1,
      recencyBoost: 0,
      feedbackBoost: 0,
      query: 'q',
      title: 't',
    }), 1)
  }
  assert.ok(Math.abs(rankerWarmup(model) - 1) < 1e-9)
})

ok('模型持久化：sanitize 往返恢复，损坏记录被拒', () => {
  let model = emptyRankerModel()
  model = updateRanker(model, buildRankerFeatures({
    lexicalRank: 1,
    recencyBoost: 0,
    feedbackBoost: 0,
    query: 'q',
    title: 't',
  }), 1)
  const restored = sanitizeRankerModel(JSON.parse(JSON.stringify(model)))
  assert.ok(restored)
  assert.equal(restored.updates, model.updates)
  assert.equal(restored.z.lexicalRank, model.z.lexicalRank)
  assert.equal(sanitizeRankerModel(null), undefined)
  assert.equal(sanitizeRankerModel({ z: 'bad' }), undefined)
  assert.equal(sanitizeRankerModel({ z: {}, n: {}, updates: -1 }), undefined)
})

ok('诊断视图：六维特征权重齐全', () => {
  const diagnostics = rankerDiagnostics(emptyRankerModel())
  assert.equal(diagnostics.features.length, 6)
  assert.equal(diagnostics.updates, 0)
  assert.equal(diagnostics.warmup, 0)
})

console.log('轴线 29：synthesis/submodular（次模证据选择）')

ok('覆盖最大化：互补证据优于同义高分证据', () => {
  const question = '如何优化 docker 镜像体积和构建速度'
  const candidates = [
    // 三块同义：都只讲镜像体积（分数高）。
    { sessionId: 'a', text: 'docker 镜像体积优化：多阶段构建可以显著减小镜像体积', score: 0.95 },
    { sessionId: 'a', text: '减小 docker 镜像体积的另一种思路是 slim 基础镜像', score: 0.93 },
    { sessionId: 'a', text: '镜像体积还能通过 squash 层进一步压缩', score: 0.91 },
    // 两块互补：讲构建速度（分数略低但覆盖另一面）。
    { sessionId: 'b', text: 'docker 构建速度优化：buildkit 缓存让构建快数倍', score: 0.88 },
    { sessionId: 'b', text: '并行构建与依赖缓存加快 docker 构建速度', score: 0.86 },
  ]
  const result = selectSubmodular(candidates, question, {
    maxChunks: 4,
    perSessionCap: 4,
    charBudget: 10_000,
  })
  assert.ok(result.selected.length > 0)
  // 覆盖率：问题两个方面（体积 + 速度）都应被选中证据覆盖。
  assert.ok(result.coverage > 0.9, `覆盖不足：${result.coverage}`)
  assert.ok(result.aspects >= 3, '问题方面数过少')
  const chosenText = result.selected.map((item) => candidates[item.index].text).join(' ')
  assert.ok(chosenText.includes('体积'))
  assert.ok(chosenText.includes('速度'))
  // 惰性贪婪效率：评估次数应远小于朴素贪婪的 k×n（4×5=20 上限内收缩）。
  assert.ok(result.evaluations <= 20)
})

ok('次模性：冗余的同义证据被目标函数惩罚', () => {
  const question = 'k8s 滚动更新策略'
  const candidates = [
    { sessionId: 'a', text: 'k8s 滚动更新 maxSurge 参数详解', score: 0.9 },
    { sessionId: 'a', text: 'k8s 滚动更新 maxUnavailable 参数详解', score: 0.89 },
    { sessionId: 'a', text: 'k8s 滚动更新 maxSurge 与 maxUnavailable 参数详解', score: 0.88 },
  ]
  const result = selectSubmodular(candidates, question, {
    maxChunks: 2,
    perSessionCap: 3,
    charBudget: 5_000,
  })
  // 第三块是前两块的并集（纯冗余）：预算允许的情况下，次模目标
  // 应保证选中的两块覆盖不劣于任意两块组合。
  assert.ok(result.coverage > 0.5)
  assert.equal(result.selected.length, 2)
})

ok('字符预算：超预算尾部截断而非整块丢弃', () => {
  const long = 'docker 优化 '.repeat(60)
  const result = selectSubmodular(
    [
      { sessionId: 'a', text: long, score: 0.9 },
      { sessionId: 'b', text: '构建速度优化实践 ' + long, score: 0.8 },
    ],
    'docker 构建优化',
    { maxChunks: 3, perSessionCap: 3, charBudget: 300 },
  )
  const totalChars = result.selected.reduce((sum, item) => sum + item.text.length, 0)
  assert.ok(totalChars <= 300, `预算超限：${totalChars}`)
  assert.ok(result.selected.length >= 1)
})

ok('空候选与空文本：安全返回', () => {
  const empty = selectSubmodular([], 'q', { maxChunks: 3, perSessionCap: 3, charBudget: 100 })
  assert.equal(empty.selected.length, 0)
  assert.equal(empty.coverage, 0)
  const blank = selectSubmodular(
    [{ sessionId: 'a', text: '   ', score: 0.9 }],
    'q',
    { maxChunks: 3, perSessionCap: 3, charBudget: 100 },
  )
  assert.equal(blank.selected.length, 0)
})

console.log('轴线 30：cognition/drift（BOCPD 主题漂移）')

ok('主题切换：两个话题流 → 恰在边界处检出变点', () => {
  const units = []
  for (let i = 0; i < 10; i += 1) {
    units.push({
      id: `infra-${i}`,
      at: 1_700_000_000_000 + i * 30 * MIN,
      text: 'docker 容器部署 kubernetes 集群 nginx 反向代理配置',
    })
  }
  for (let i = 0; i < 10; i += 1) {
    units.push({
      id: `front-${i}`,
      at: 1_700_000_000_000 + (10 + i) * 30 * MIN,
      text: 'react 组件 hooks 状态管理 webpack 打包优化',
    })
  }
  const report = detectTopicDrift(units, { hazardLambda: 16 })
  assert.equal(report.unitCount, 20)
  assert.ok(report.changepoints.length >= 1, '未检出变点')
  const boundary = report.changepoints.find(
    (cp) => cp.index >= 7 && cp.index <= 13,
  )
  assert.ok(boundary, `变点不在边界附近：${report.changepoints.map((c) => c.index).join(',')}`)
  // 切换两侧特征词归位：前段含基建词、后段含前端词。
  assert.ok(boundary.afterTerms.some((t) => ['react', 'hooks', 'webpack', '组件'].includes(t)))
  assert.equal(report.segments.length, report.changepoints.length + 1)
  // 变点概率与切换强度在合法区间。
  for (const cp of report.changepoints) {
    assert.ok(cp.probability > 0 && cp.probability <= 1)
    assert.ok(cp.jump >= 0 && cp.jump <= 1)
  }
})

ok('单主题长流：无变点，当前段特征词正确', () => {
  const units = Array.from({ length: 15 }, (_, i) => ({
    id: `s-${i}`,
    at: 1_700_000_000_000 + i * 30 * MIN,
    text: 'rust 所有权借用检查器生命周期',
  }))
  const report = detectTopicDrift(units, { hazardLambda: 24 })
  assert.equal(report.changepoints.length, 0)
  assert.equal(report.segments.length, 1)
  assert.equal(report.currentRunLength, 15)
  assert.ok(report.lastUnitSurprise < 8, `稳态内意外度过高：${report.lastUnitSurprise}`)
})

ok('空输入与短输入：安全返回', () => {
  const empty = detectTopicDrift([])
  assert.equal(empty.unitCount, 0)
  assert.equal(empty.changepoints.length, 0)
  assert.equal(empty.segments.length, 0)
  const short = detectTopicDrift([
    { id: 'a', at: 1, text: 'hello world' },
    { id: 'b', at: 2, text: 'hello world' },
  ])
  assert.equal(short.unitCount, 2)
  assert.equal(short.changepoints.length, 0)
})

console.log('轴线 31：cognition/consolidation（MinHash-LSH 记忆固化）')

ok('近重复聚类：三组同义问题聚簇，重复计数即强化度', () => {
  const base = 1_700_000_000_000
  // 近重复的构造口径：同一基底 + 局部词替换（文件名/一个词）或尾缀
  // 差异——「换了文件名又问一遍」式的字面近重复（bigram 分词下组内
  // Jaccard 0.55–0.86；B-C 对可能低于阈值但经 A 传递连通——并查集
  // 的传递闭包正是要验证的点）。
  const items = [
    { id: 'p1', text: 'npm ERR missing script dev in app/package.json', at: base },
    { id: 'p2', text: 'npm ERR missing script dev in admin/package.json', at: base + 10 * MIN },
    { id: 'p3', text: 'npm ERR missing script build in app/package.json', at: base + 40 * MIN },
    { id: 'q1', text: 'react useEffect 依赖数组没生效', at: base + 80 * MIN },
    { id: 'q2', text: 'react useEffect 依赖数组没生效，怎么办', at: base + 90 * MIN },
    { id: 'q3', text: 'react useEffect 依赖数组没生效，求助', at: base + 120 * MIN },
    { id: 'r1', text: 'nginx 报 502 网关错误怎么排查', at: base + 150 * MIN },
    { id: 'r2', text: 'nginx 又报 502 网关错误怎么排查', at: base + 160 * MIN },
    { id: 'r3', text: 'nginx 老是报 502 网关错误怎么排查', at: base + 200 * MIN },
    { id: 'u1', text: '如何阅读 jvm 垃圾回收日志', at: base + 240 * MIN },
    { id: 'u2', text: 'postgres 索引失效的场景', at: base + 280 * MIN },
    { id: 'u3', text: 'typescript 泛型约束的写法', at: base + 320 * MIN },
  ]
  const plan = consolidateMemories(items)
  assert.equal(plan.items, 12)
  assert.ok(plan.clusters.length >= 3, `簇数不足：${plan.clusters.length}`)
  assert.ok(plan.duplicates >= 6, `冗余折叠不足：${plan.duplicates}`)
  assert.equal(plan.duplicates + plan.unique + plan.clusters.length, plan.items)
  // 传递闭包：B-C 对低于阈值，但同经基底 A 连通——并查集应归并整组。
  const clusterOf = new Map()
  for (const cluster of plan.clusters) {
    for (const member of cluster.memberIds) clusterOf.set(member, cluster)
  }
  assert.equal(clusterOf.get('q1'), clusterOf.get('q2'))
  assert.equal(clusterOf.get('q1'), clusterOf.get('q3'))
  assert.equal(clusterOf.get('p1'), clusterOf.get('p3'))
  // 每簇 ≥2 成员、代表存在、紧致度为真 Jaccard。
  for (const cluster of plan.clusters) {
    assert.ok(cluster.memberIds.length >= 2)
    assert.ok(cluster.reinforcement === cluster.memberIds.length)
    assert.ok(cluster.cohesion > 0.3)
    assert.ok(items.some((item) => item.id === cluster.representativeId))
  }
  // 簇按强化度降序。
  for (let i = 1; i < plan.clusters.length; i += 1) {
    assert.ok(plan.clusters[i - 1].reinforcement >= plan.clusters[i].reinforcement)
  }
})

ok('唯一记忆：无簇无折叠', () => {
  const plan = consolidateMemories([
    { id: 'a', text: '完全不同的第一个问题', at: 1 },
    { id: 'b', text: '毫不相干的第二个问题', at: 2 },
    { id: 'c', text: '毫无交集的第三个问题', at: 3 },
  ])
  assert.equal(plan.clusters.length, 0)
  assert.equal(plan.duplicates, 0)
  assert.equal(plan.unique, 3)
  assert.equal(plan.compression, 0)
})

ok('空输入与单调输入：安全返回', () => {
  assert.equal(consolidateMemories([]).items, 0)
  const single = consolidateMemories([{ id: 'only', text: '唯一一条', at: 1 }])
  assert.equal(single.items, 1)
  assert.equal(single.clusters.length, 0)
})

console.log('轴线 30/31：insights/pulse（新信号提供者）')

ok('漂移信号：高意外度 → watch 卡片；短样本静默', () => {
  assert.equal(
    driftInsights({
      unitCount: 3,
      changepoints: 0,
      currentRunLength: 3,
      lastUnitSurprise: 20,
      currentRunTopTerms: [],
    }).length,
    0,
  )
  const card = driftInsights({
    unitCount: 20,
    changepoints: 3,
    currentRunLength: 1,
    lastUnitSurprise: 9.5,
    currentRunTopTerms: ['docker'],
  })[0]
  assert.equal(card.severity, 'watch')
  assert.ok(card.text.includes('9.5'))
  assert.ok(card.action.includes('drift'))
  // 稳态长流 → 深度工作 info 卡。
  const steady = driftInsights({
    unitCount: 18,
    changepoints: 0,
    currentRunLength: 18,
    lastUnitSurprise: 2,
    currentRunTopTerms: ['rust', '所有权'],
  })[0]
  assert.equal(steady.severity, 'info')
  assert.ok(steady.text.includes('深度工作'))
})

ok('固化信号：样本充足且有簇 → info 卡片；否则静默', () => {
  assert.equal(
    consolidationInsights({ items: 5, clusters: 2, duplicates: 2, topReinforcement: 2 }).length,
    0,
  )
  assert.equal(
    consolidationInsights({ items: 12, clusters: 0, duplicates: 0, topReinforcement: 0 }).length,
    0,
  )
  const card = consolidationInsights({
    items: 12,
    clusters: 3,
    duplicates: 6,
    topReinforcement: 3,
  })[0]
  assert.equal(card.severity, 'info')
  assert.ok(card.text.includes('3 组近重复'))
  assert.ok(card.text.includes('已出现 3 次'))
  assert.ok(card.action.includes('consolidate'))
})

console.log(`\n全部通过：${passed} 项断言`)
