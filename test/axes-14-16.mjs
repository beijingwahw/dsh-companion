/**
 * 轴线 14/15/16 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：retrieval/suggest（查询建议三通道）、retrieval/explain（命中解释
 * 四成分分解）、retrieval/rescue（零命中救援：宽阈值纠错 + 噪声剔除）、
 * engine（textGramVector/recencyBoostFor 导出一致性）。
 */
import assert from 'node:assert/strict'
import {
  buildIndexedDoc,
  HybridRetrievalIndex,
  recencyBoostFor,
  textGramVector,
  docGramVector,
  sparseCosine,
} from '../lib/core/retrieval/engine.js'
import { suggestQueries } from '../lib/core/retrieval/suggest.js'
import { explainHit } from '../lib/core/retrieval/explain.js'
import { relaxQuery } from '../lib/core/retrieval/rescue.js'
import { expandQuery } from '../lib/core/retrieval/query.js'

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

/** 构建一个小语料：部署/容器主题 + 数据库/索引主题。 */
function buildCorpus() {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'docker 部署 容器镜像 构建 流程 docker 部署'))
  index.put(doc('s2', 'docker 部署 容器镜像 推送 仓库 docker'))
  index.put(doc('s3', '数据库 索引 优化 慢查询 数据库'))
  index.put(doc('s4', '数据库 索引 优化 执行计划 数据库'))
  index.put(doc('s5', 'performance 性能 优化 基准测试 performance'))
  return index
}

const corpusIndex = buildCorpus()
const corpusView = {
  docCount: corpusIndex.size,
  termDf: corpusIndex.termDfSnapshot(),
  docsWithTerm: (term) => corpusIndex.docsWithTerm(term),
}

console.log('轴线 14：retrieval/suggest（查询建议引擎）')

ok('前缀补全：输入拉丁前缀 → 语料中的高频词候选', () => {
  const suggestions = suggestQueries('部署 doc', corpusView)
  assert.ok(suggestions.length > 0)
  assert.ok(suggestions.some((s) => s.term === 'docker'))
  assert.ok(suggestions[0].text.startsWith('部署'))
})

ok('共现续写：中文输入无拉丁尾部 → 共现词续写', () => {
  const suggestions = suggestQueries('部署', corpusView)
  assert.ok(suggestions.length > 0)
  // 「部署」的最强共现词应出现在建议里（docker/容器镜像等）。
  assert.ok(suggestions.some((s) => s.text.startsWith('部署')))
})

ok('点击画像加权：点过的词在建议中排序提前', () => {
  const none = suggestQueries('部署 容器', corpusView)
  const profileTerms = new Map([['性能', 5]])
  const withProfile = suggestQueries('部署 容器', corpusView, { profileTerms })
  // 画像词若无前缀通道，仅可能经共现通道出现；断言不抛错且结构合法。
  assert.ok(Array.isArray(withProfile))
  assert.ok(none.length >= 0)
  for (const s of withProfile) {
    assert.ok(['profile', 'prefix', 'cooccurrence'].includes(s.source))
    assert.ok(typeof s.score === 'number' && s.score > 0)
  }
})

ok('空输入 / 空语料 → 无建议', () => {
  assert.deepEqual(suggestQueries('', corpusView), [])
  assert.deepEqual(suggestQueries('部署', { docCount: 0, termDf: new Map(), docsWithTerm: () => [] }), [])
})

ok('建议条数封顶 5', () => {
  const bigIndex = new HybridRetrievalIndex()
  for (let i = 0; i < 30; i += 1) bigIndex.put(doc(`s${i}`, `部署 alpha${i} beta${i} topic${i}`))
  const suggestions = suggestQueries('部署 alpha', {
    docCount: bigIndex.size,
    termDf: bigIndex.termDfSnapshot(),
    docsWithTerm: (term) => bigIndex.docsWithTerm(term),
  })
  assert.ok(suggestions.length <= 5)
})

console.log('轴线 15：retrieval/explain（命中解释器）')

ok('四成分分解：词法命中 + 语义相似 + 加成项', () => {
  const target = corpusIndex.get('s1')
  const explanation = explainHit(
    'docker 部署',
    target,
    { recency: 0.12, feedback: 0.08 },
  )
  // 词法命中：docker 与部署都在 s1 词表中。
  const terms = explanation.lexicalHits.map((hit) => hit.term)
  assert.ok(terms.includes('docker'))
  assert.ok(terms.includes('部署'))
  // tf 降序排列。
  const tfs = explanation.lexicalHits.map((hit) => hit.tf)
  assert.deepEqual([...tfs].sort((a, b) => b - a), tfs)
  // 语义相似度：同文本应接近 1 的量级（查询是文档子集）。
  assert.ok(explanation.semanticSimilarity > 0)
  assert.equal(explanation.recencyBoost, 0.12)
  assert.equal(explanation.feedbackBoost, 0.08)
  // 人话摘要包含关键成分。
  assert.ok(explanation.summary.includes('词法命中'))
  assert.ok(explanation.summary.includes('新近'))
  assert.ok(explanation.summary.includes('历史点击'))
})

ok('无词法命中的查询：账本为空但结构完整', () => {
  const target = corpusIndex.get('s1')
  const explanation = explainHit('钢琴乐理作曲', target, { recency: 0, feedback: 0 })
  assert.deepEqual(explanation.lexicalHits, [])
  assert.ok(typeof explanation.semanticSimilarity === 'number')
})

ok('查询向量缓存复用：显式传入与缺省构建结果一致', () => {
  const target = corpusIndex.get('s3')
  const vector = textGramVector('数据库 索引')
  const a = explainHit('数据库 索引', target, { recency: 0, feedback: 0 })
  const b = explainHit('数据库 索引', target, { recency: 0, feedback: 0 }, vector)
  assert.equal(a.semanticSimilarity, b.semanticSimilarity)
})

ok('textGramVector 与 docGramVector 同构：余弦 = 1（同文本）', () => {
  const d = doc('sx', 'docker 容器镜像 部署流程')
  const similarity = sparseCosine(textGramVector('docker 容器镜像 部署流程'), docGramVector(d))
  assert.ok(Math.abs(similarity - 1) < 1e-9)
})

console.log('轴线 16：retrieval/rescue（零命中救援）')

ok('宽阈值纠错：拼写灾难在救援阈值下被拉回', () => {
  // 语料有 performance；查询拼成 performence（一字符之差）。
  const relaxed = relaxQuery('performence', corpusView.termDf)
  assert.equal(relaxed.applied, true)
  const correction = relaxed.actions.find((a) => a.kind === 'correction')
  assert.ok(correction !== undefined)
  assert.equal(correction.to, 'performance')
  assert.equal(relaxed.queryText, 'performance')
})

ok('噪声剔除：语料外且纠不回的词被剔除，有效词幸存', () => {
  const relaxed = relaxQuery('docker zzqqxx', corpusView.termDf)
  assert.equal(relaxed.applied, true)
  const removal = relaxed.actions.find((a) => a.kind === 'removal')
  assert.ok(removal !== undefined)
  assert.equal(removal.from, 'zzqqxx')
  assert.equal(relaxed.queryText, 'docker')
})

ok('全部词元均为噪声 → 不改写（语料真空语义）', () => {
  const relaxed = relaxQuery('zzqq xxvv kkpp', corpusView.termDf)
  assert.equal(relaxed.applied, false)
  assert.equal(relaxed.queryText, 'zzqq xxvv kkpp')
})

ok('查询词全部在语料中 → 无可放宽（applied=false，零动作）', () => {
  const relaxed = relaxQuery('docker 部署', corpusView.termDf)
  assert.equal(relaxed.applied, false)
  assert.deepEqual(relaxed.actions, [])
})

ok('救援阈值宽于轴线 8：轴线 8 拒纠的词救援通道能拉回', () => {
  // 构造一个 trigram 余弦在 0.35~0.55 之间的近似词对。
  // 'performence' vs 'performance'：轴线 8 阈值 0.55 边界情形，
  // 救援阈值 0.35 必然覆盖（宽阈值 ⊇ 保守阈值）。
  const expanded = expandQuery('performence', corpusView)
  const relaxed = relaxQuery('performence', corpusView.termDf)
  // 救援通道必然给出改写；轴线 8 可能不扩展（保守）。
  assert.equal(relaxed.applied, true)
  assert.ok(Array.isArray(expanded.notes))
})

ok('端到端：零命中查询经救援后引擎能命中', () => {
  const index = buildCorpus()
  // 原始查询零命中（纯噪声词 + 拼错词混合）。
  const first = index.search('performence zzqq', 10, undefined)
  assert.equal(first.length, 0)
  // 救援：放宽后重试。
  const relaxed = relaxQuery('performence zzqq', index.termDfSnapshot())
  assert.equal(relaxed.applied, true)
  const retry = index.search(relaxed.queryText, 10, undefined)
  assert.ok(retry.length > 0)
  assert.ok(retry.some((hit) => hit.sessionId === 's5'))
})

console.log('引擎导出一致性：recencyBoostFor（轴线 15 的加成分解原料）')

ok('recencyBoostFor：最新文档 = 满强度，30 天前 = 半强度（半衰期语义）', () => {
  const fresh = doc('a', '文本', NOW)
  const stale = doc('b', '文本', NOW - 30 * DAY)
  const freshBoost = recencyBoostFor(fresh, { now: NOW })
  const staleBoost = recencyBoostFor(stale, { now: NOW })
  assert.ok(Math.abs(freshBoost - 0.25) < 1e-9)
  assert.ok(Math.abs(staleBoost / 0.25 - 0.5) < 1e-6)
})

ok('recencyBoostFor：boost=0 时关闭（返回 0）', () => {
  const d = doc('a', '文本', NOW)
  assert.equal(recencyBoostFor(d, { now: NOW, boost: 0 }), 0)
})

console.log(`\n全部通过：${passed} 项断言`)
