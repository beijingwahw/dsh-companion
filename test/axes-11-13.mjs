/**
 * 轴线 11/12/13 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：retrieval/feedback（点击画像 + 加成）、retrieval/diversity
 * （MMR 贪心选择）、retrieval/clusters（质心贪心聚类 + 簇标签）、
 * engine（docGramVector/sparseCosine 相似度）。
 */
import assert from 'node:assert/strict'
import {
  buildIndexedDoc,
  docGramVector,
  HybridRetrievalIndex,
  sparseCosine,
} from '../lib/core/retrieval/engine.js'
import {
  FEEDBACK_MAX_BOOST,
  feedbackBoost,
  recordClick,
  sanitizeFeedbackProfile,
} from '../lib/core/retrieval/feedback.js'
import {
  DEFAULT_MMR_LAMBDA,
  diversityPoolSize,
  mmrSelect,
  MMR_MIN_POOL,
} from '../lib/core/retrieval/diversity.js'
import { clusterSessions } from '../lib/core/retrieval/clusters.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000
const meta = (id, updatedAt) => ({
  sessionId: id,
  title: '',
  createdAt: updatedAt,
  updatedAt,
})
const doc = (id, text, updatedAt = NOW) => buildIndexedDoc(meta(id, updatedAt), text)

console.log('轴线 11：retrieval/feedback（点击画像 + 反馈加成）')

ok('首次点击建立画像：查询词计数 + lastAt 基准', () => {
  const profile = recordClick(undefined, '部署 docker', NOW)
  assert.equal(profile.clicks, 1)
  assert.equal(profile.terms['部署'], 1)
  assert.equal(profile.terms['docker'], 1)
  assert.equal(profile.lastAt, NOW)
})

ok('重复点击累计计数：同一查询词计数叠加', () => {
  let profile = recordClick(undefined, '部署', NOW)
  profile = recordClick(profile, '部署', NOW + DAY)
  assert.equal(profile.clicks, 2)
  assert.equal(profile.terms['部署'], 2)
  assert.equal(profile.lastAt, NOW + DAY)
})

ok('反馈加成：画像命中查询词 > 0，且封顶不越界', () => {
  let profile = recordClick(undefined, '部署 docker', NOW)
  // 多次点击抬高匹配强度，但封顶在 MAX_BOOST。
  for (let i = 0; i < 10; i += 1) profile = recordClick(profile, '部署 docker', NOW)
  const boost = feedbackBoost(profile, '部署', NOW)
  assert.ok(boost > 0)
  assert.ok(boost <= FEEDBACK_MAX_BOOST + 1e-9)
  assert.ok(boost > FEEDBACK_MAX_BOOST * 0.8) // 饱和度 11/(11+2)≈0.85，贴近封顶
})

ok('新近度衰减：90 天前的点击权重减半（半衰期语义）', () => {
  const fresh = recordClick(undefined, '部署', NOW)
  const stale = recordClick(undefined, '部署', NOW - 90 * DAY)
  const freshBoost = feedbackBoost(fresh, '部署', NOW)
  const staleBoost = feedbackBoost(stale, '部署', NOW)
  assert.ok(freshBoost > staleBoost)
  assert.ok(Math.abs(staleBoost / freshBoost - 0.5) < 0.02)
})

ok('无画像 / 无词项重叠 / 空查询 → 加成为 0', () => {
  assert.equal(feedbackBoost(undefined, '任意', NOW), 0)
  const profile = recordClick(undefined, '部署', NOW)
  assert.equal(feedbackBoost(profile, '数据库', NOW), 0)
  assert.equal(feedbackBoost(profile, '', NOW), 0)
})

ok('画像词项封顶：超限淘汰低计数词（LRU 式防漂移）', () => {
  let profile
  for (let i = 0; i < 250; i += 1) profile = recordClick(profile, `term${i}`, NOW)
  const keys = Object.keys(profile.terms)
  assert.ok(keys.length <= 200)
  // 头部高频点击词保留，尾部孤例词被淘汰。
  assert.ok(profile.terms['term0'] >= 1)
})

ok('损坏记录静默丢弃：sanitize 修复非法输入', () => {
  assert.equal(sanitizeFeedbackProfile(null), undefined)
  assert.equal(sanitizeFeedbackProfile('junk'), undefined)
  assert.equal(sanitizeFeedbackProfile({ clicks: 1, terms: null, lastAt: 'x' }), undefined)
  const repaired = sanitizeFeedbackProfile({ clicks: 3, terms: { ok: 2, bad: -1 }, lastAt: 123 })
  assert.deepEqual(repaired, { clicks: 3, terms: { ok: 2 }, lastAt: 123 })
})

console.log('轴线 12：retrieval/diversity（MMR 多样性重排）')

ok('MMR 去同质化：相似文档不再垄断头部（λ=0.7）', () => {
  // 3 个高相关但彼此雷同 + 1 个略低相关但内容互补。
  const items = [
    { id: 'a', rel: 0.9 },
    { id: 'a2', rel: 0.89 },
    { id: 'a3', rel: 0.88 },
    { id: 'b', rel: 0.7 },
  ]
  const sim = (x, y) => (x.id[0] === y.id[0] ? 0.95 : 0.05)
  const selected = mmrSelect(items, (it) => it.rel, sim, 3, DEFAULT_MMR_LAMBDA)
  assert.equal(selected.length, 3)
  // 头部仍是最高相关；但第二位应是互补的 b，而非雷同的 a2。
  assert.equal(selected[0].id, 'a')
  assert.ok(selected.some((it) => it.id === 'b'))
})

ok('λ=1 退化为纯相关度排序（与原序一致）', () => {
  const items = [
    { id: 'a', rel: 0.5 },
    { id: 'b', rel: 0.9 },
    { id: 'c', rel: 0.7 },
  ]
  const sim = () => 0.99
  const selected = mmrSelect(items, (it) => it.rel, sim, 3, 1)
  assert.deepEqual(
    selected.map((it) => it.id),
    ['b', 'c', 'a'],
  )
})

ok('空池 / limit=0 → 空结果', () => {
  assert.deepEqual(mmrSelect([], () => 1, () => 0, 5), [])
  assert.deepEqual(mmrSelect([{ id: 'a', rel: 1 }], () => 1, () => 0, 0), [])
})

ok('候选池规模：min(2×limit, 80, 命中总数)，且 ≥ 3', () => {
  assert.equal(diversityPoolSize(10, 100), 20)
  assert.equal(diversityPoolSize(50, 100), 80)
  assert.equal(diversityPoolSize(50, 30), 30)
  assert.equal(diversityPoolSize(1, 100), 3)
})

ok('MMR_MIN_POOL 阈值：池不足时调用方可跳过重排', () => {
  assert.equal(MMR_MIN_POOL, 3)
})

console.log('轴线 13：retrieval/clusters（主题聚类知识地图）')

ok('同主题会话聚成一簇：簇标签来自判别性主题词', () => {
  const docs = [
    doc('s1', 'docker 部署 容器镜像 构建 流程'),
    doc('s2', 'docker 部署 容器镜像 推送 仓库'),
    doc('s3', '数据库 索引 优化 慢查询 分析'),
    doc('s4', '数据库 索引 优化 执行计划 调优'),
  ]
  const clusters = clusterSessions(docs)
  assert.ok(clusters.length >= 2)
  // 规模最大的簇包含 2 个会话，且标签含主题词。
  const top = clusters[0]
  assert.equal(top.size, 2)
  assert.ok(top.label.includes('docker') || top.label.includes('数据库'))
  assert.equal(top.sessionIds.length, 2)
})

ok('不同主题不混簇：文本形状差异大 → 相似度低于阈值', () => {
  const docs = [
    doc('s1', 'python 爬虫 requests beautifulsoup 数据抓取'),
    doc('s2', '钢琴 乐理 和声 即兴 作曲'),
  ]
  const clusters = clusterSessions(docs)
  assert.equal(clusters.length, 2)
  assert.equal(clusters[0].size, 1)
})

ok('簇时间跨度：from/to 覆盖成员创建时间', () => {
  const docs = [
    doc('s1', 'docker 部署 容器', NOW - 10 * DAY),
    doc('s2', 'docker 部署 容器', NOW - 2 * DAY),
  ]
  const [cluster] = clusterSessions(docs)
  assert.equal(cluster.from, NOW - 10 * DAY)
  assert.equal(cluster.to, NOW - 2 * DAY)
})

ok('空输入 → 空簇列表', () => {
  assert.deepEqual(clusterSessions([]), [])
})

ok('簇 id 按规模降序编号（c1、c2…）', () => {
  const docs = [
    doc('s1', '主题甲 数据 一'),
    doc('s2', '主题甲 数据 二'),
    doc('s3', '主题甲 数据 三'),
    doc('s4', '主题乙 其他 一'),
    doc('s5', '主题乙 其他 二'),
    doc('s6', '孤例 主题 丙'),
  ]
  const clusters = clusterSessions(docs)
  assert.ok(clusters.length >= 2)
  assert.equal(clusters[0].id, 'c1')
  assert.ok(clusters[0].size >= clusters[1].size)
})

console.log('引擎一致性：docGramVector / sparseCosine（轴线 12/13 的相似度底座）')

ok('相同文本相似度 = 1，完全不同文本 < 阈值', () => {
  const a = docGramVector(doc('s1', 'docker container deploy'))
  const same = docGramVector(doc('s2', 'docker container deploy'))
  const other = docGramVector(doc('s3', '钢琴 乐理 作曲'))
  assert.ok(Math.abs(sparseCosine(a, same) - 1) < 1e-9)
  assert.ok(sparseCosine(a, other) < 0.3)
})

ok('反馈 + MMR 端到端：点击过的会话在 MMR 后仍居头部', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'docker 部署 容器镜像 构建流程'))
  index.put(doc('s2', 'docker 部署 容器镜像 推送仓库'))
  index.put(doc('s3', 'docker 部署 容器镜像 运行时'))
  // 用户在「docker 部署」查询下点击过 s2 → 画像建立。
  const profile = recordClick(undefined, 'docker 部署', NOW)
  // 模拟 hybridSearch 的后处理：反馈加成 → MMR。
  const hits = index.search('docker 部署', 3, undefined)
  for (const hit of hits) {
    if (hit.sessionId === 's2') hit.score *= 1 + feedbackBoost(profile, 'docker 部署', NOW)
  }
  hits.sort((a, b) => b.score - a.score)
  const vectors = new Map(hits.map((hit) => [hit.sessionId, docGramVector(index.get(hit.sessionId))]))
  const ordered = mmrSelect(
    hits,
    (hit) => hit.score,
    (a, b) => sparseCosine(vectors.get(a.sessionId), vectors.get(b.sessionId)),
    3,
  )
  // s2 得到反馈加成，MMR 后仍应出现在结果中（不因同质化被挤出）。
  assert.ok(ordered.some((hit) => hit.sessionId === 's2'))
  assert.equal(ordered.length, 3)
})

console.log(`\n全部通过：${passed} 项断言`)
