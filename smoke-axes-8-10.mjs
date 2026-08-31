/**
 * 轴线 8/9/10 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：retrieval/query（拼写纠错 + 共现扩展）、retrieval/quality
 * （四级判定 + 通道覆盖 + 建议）、engine（时序感知 + 增量统计/倒排
 * 一致性 + 过滤视图等价性）。
 */
import assert from 'node:assert/strict'
import {
  buildIndexedDoc,
  HybridRetrievalIndex,
} from './lib/core/retrieval/engine.js'
import { expandQuery } from './lib/core/retrieval/query.js'
import { diagnoseRetrieval } from './lib/core/retrieval/quality.js'

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
const corpusOf = (index) => ({
  docCount: index.size,
  termDf: index.termDfSnapshot(),
  docsWithTerm: (term) => index.docsWithTerm(term),
})

console.log('轴线 8：retrieval/query（拼写纠错 + 语料共现扩展）')

ok('拼写纠错：未知词按 trigram 最近邻纠正（perfomance → performance）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'performance tuning guide'))
  index.put(doc('s2', 'performance profiling tips'))
  const expanded = expandQuery('perfomance tuning', corpusOf(index))
  assert.deepEqual(
    expanded.notes.filter((n) => n.kind === 'correction'),
    [{ kind: 'correction', from: 'perfomance', to: 'performance' }],
  )
  assert.ok(expanded.queryText.includes('performance'))
})

ok('共现扩展：从语料学到术语关联（鉴权 → auth）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', '鉴权 auth'))
  index.put(doc('s2', '鉴权 auth'))
  index.put(doc('s3', '无关内容散步'))
  const expanded = expandQuery('鉴权', corpusOf(index))
  assert.deepEqual(
    expanded.notes.filter((n) => n.kind === 'cooccurrence'),
    [{ kind: 'cooccurrence', from: '鉴权', to: 'auth' }],
  )
})

ok('已在语料中的词不做纠错', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'performance tuning'))
  index.put(doc('s2', 'performance profiling'))
  const expanded = expandQuery('performance', corpusOf(index))
  assert.equal(expanded.notes.filter((n) => n.kind === 'correction').length, 0)
})

ok('孤例候选词不被建议为纠错（df < 2 剔除）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'performance tuning'))
  index.put(doc('s2', 'nothing relevant here'))
  const expanded = expandQuery('perfomance', corpusOf(index))
  assert.equal(expanded.notes.filter((n) => n.kind === 'correction').length, 0)
})

ok('扩展总量封顶（≤ 4），且不重复/不回添原词', () => {
  const index = new HybridRetrievalIndex()
  // 5 个查询词各自有一个强共现词 + 1 个可纠错词
  index.put(doc('s1', 'alpha one 鉴权 auth'))
  index.put(doc('s2', 'alpha one 鉴权 auth'))
  index.put(doc('s3', 'beta two 部署 deploy'))
  index.put(doc('s4', 'beta two 部署 deploy'))
  index.put(doc('s5', 'gamma three 调试 debug'))
  index.put(doc('s6', 'gamma three 调试 debug'))
  const expanded = expandQuery('alpha beta gamma perfomance', corpusOf(index))
  assert.ok(expanded.notes.length <= 4)
  const tos = expanded.notes.map((n) => n.to)
  assert.equal(new Set(tos).size, tos.length)
  assert.ok(!tos.includes('alpha') && !tos.includes('beta') && !tos.includes('gamma'))
})

ok('空查询 / 纯停用词不产生扩展', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'performance tuning'))
  for (const query of ['', '   ', '的 了 the']) {
    const expanded = expandQuery(query, corpusOf(index))
    assert.equal(expanded.notes.length, 0)
    assert.equal(expanded.queryText, query)
  }
})

ok('纠错优先于共现（拼错的词先救回来）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', 'database indexing perfomance'))
  index.put(doc('s2', 'database indexing perfomance'))
  index.put(doc('s3', 'database notes'))
  // "perfomance" 本身是语料里的词（df=2）——构造一个真正的拼写错误场景：
  const index2 = new HybridRetrievalIndex()
  index2.put(doc('s1', 'database performance'))
  index2.put(doc('s2', 'database performance'))
  const expanded = expandQuery('perfomance', corpusOf(index2))
  assert.equal(expanded.notes[0].kind, 'correction')
})

console.log('轴线 9：engine 时序感知排序（recency 乘性加成）')

ok('强加成下最新文档反超（同等相关性）', () => {
  const index = new HybridRetrievalIndex()
  const text = '性能优化 数据库 索引 调优'
  index.put(doc('old', text, NOW - 90 * DAY))
  index.put(doc('new', text, NOW))
  const hits = index.search(text, 2, undefined, { now: NOW, boost: 1 })
  assert.equal(hits[0].sessionId, 'new')
})

ok('boost = 0 时与不开启时序完全等价', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('a', '性能优化 数据库', NOW - 60 * DAY))
  index.put(doc('b', '性能优化 缓存', NOW - 10 * DAY))
  index.put(doc('c', '性能优化 索引', NOW))
  const plain = index.search('性能优化', 3)
  const zero = index.search('性能优化', 3, undefined, { now: NOW, boost: 0 })
  assert.deepEqual(zero.map((h) => h.sessionId), plain.map((h) => h.sessionId))
  zero.forEach((h, i) => assert.ok(Math.abs(h.score - plain[i].score) < 1e-12))
})

ok('半衰期语义：30 天前的文档加成衰减一半', () => {
  const index = new HybridRetrievalIndex()
  // 单文档、单查询：融合分固定，可直接校验乘性因子
  index.put(doc('only', '独特关键词 xyzzy', NOW - 30 * DAY))
  const plain = index.search('独特关键词 xyzzy', 1)
  const boosted = index.search('独特关键词 xyzzy', 1, undefined, {
    now: NOW,
    boost: 1,
    halfLifeDays: 30,
  })
  // age = 30 天 = 1 个半衰期 → factor = 1 + 1 × 0.5 = 1.5
  assert.ok(Math.abs(boosted[0].score / plain[0].score - 1.5) < 1e-9)
})

ok('未来时间戳的文档不获得超额加成（年龄钳为 0）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('future', '独特关键词 xyzzy', NOW + 7 * DAY))
  const plain = index.search('独特关键词 xyzzy', 1)
  const boosted = index.search('独特关键词 xyzzy', 1, undefined, { now: NOW, boost: 1 })
  assert.ok(Math.abs(boosted[0].score / plain[0].score - 2) < 1e-9)
})

console.log('轴线 10：retrieval/quality（四级判定 + 通道覆盖 + 建议）')

ok('空结果 + 空索引：判定 empty 且提示索引未建立', () => {
  const d = diagnoseRetrieval([], 0)
  assert.equal(d.verdict, 'empty')
  assert.equal(d.suggestions.length, 1)
  assert.ok(d.suggestions[0].includes('索引'))
})

ok('空结果 + 有索引：判定 empty 且给出 3 条可执行建议', () => {
  const d = diagnoseRetrieval([], 42)
  assert.equal(d.verdict, 'empty')
  assert.equal(d.suggestions.length, 3)
  assert.ok(d.suggestions.some((s) => s.includes('关键词')))
})

ok('双通道皆第 1：判定 strong 且无建议', () => {
  const max = 2 / 61
  const d = diagnoseRetrieval(
    [{ sessionId: 'a', score: max, lexicalRank: 1, semanticRank: 1 }],
    10,
  )
  assert.equal(d.verdict, 'strong')
  assert.equal(d.suggestions.length, 0)
  assert.equal(d.lexicalCoverage, 1)
  assert.equal(d.semanticCoverage, 1)
})

ok('低相关度：判定 weak 且给出改进建议', () => {
  const d = diagnoseRetrieval(
    [
      { sessionId: 'a', score: 0.002, lexicalRank: 1, semanticRank: 1 },
      { sessionId: 'b', score: 0.001 },
    ],
    10,
  )
  assert.equal(d.verdict, 'weak')
  assert.ok(d.suggestions.length >= 1)
  assert.ok(d.scoreGap > 0)
})

ok('词法覆盖 ≤ 30% 触发词法通道建议', () => {
  const max = 2 / 61
  const d = diagnoseRetrieval(
    [
      { sessionId: 'a', score: 0.9 * max, lexicalRank: 1, semanticRank: 1 },
      { sessionId: 'b', score: 0.6 * max, semanticRank: 2 },
      { sessionId: 'c', score: 0.5 * max, semanticRank: 3 },
      { sessionId: 'd', score: 0.4 * max, semanticRank: 4 },
    ],
    10,
  )
  assert.equal(d.lexicalCoverage, 0.25)
  assert.ok(d.suggestions.some((s) => s.includes('词法通道')))
})

console.log('引擎一致性：增量统计 / 倒排表 / 过滤视图等价（性能优化正确性）')

ok('put/delete 保持 termDf 与倒排一致', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', '性能优化 数据库'))
  index.put(doc('s2', '性能优化 缓存'))
  assert.equal(index.termDfSnapshot().get('性能'), 2)
  index.delete('s1')
  assert.equal(index.termDfSnapshot().get('性能'), 1)
  assert.equal(index.termDfSnapshot().get('数据库'), undefined)
  assert.deepEqual(
    [...index.docsWithTerm('性能')].map((d) => d.sessionId),
    ['s2'],
  )
})

ok('覆盖 put 同一文档不重复计数（统计回滚正确）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('s1', '性能优化 数据库'))
  index.put(doc('s1', '性能优化 数据库 索引'))
  assert.equal(index.termDfSnapshot().get('性能'), 1)
  assert.equal(index.termDfSnapshot().get('索引'), 1)
  assert.equal(index.size, 1)
})

ok('load 全量重建后统计与检索一致', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('stale', '旧内容', NOW - 999 * DAY))
  index.load([doc('a', '性能优化 数据库', NOW - DAY), doc('b', '性能优化 缓存', NOW)])
  assert.equal(index.size, 2)
  assert.equal(index.termDfSnapshot().get('性能'), 2)
  assert.equal(index.termDfSnapshot().get('旧内'), undefined)
  const hits = index.search('性能优化', 2)
  assert.equal(hits.length, 2)
})

ok('无过滤与全通过滤视图的检索结果数值等价', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('a', '性能优化 数据库 索引', NOW - 5 * DAY))
  index.put(doc('b', '性能优化 缓存 页面', NOW - 30 * DAY))
  index.put(doc('c', '性能优化 网络 请求', NOW - 200 * DAY))
  const unfiltered = index.search('性能优化 数据库', 3)
  const filtered = index.search('性能优化 数据库', 3, () => true)
  assert.deepEqual(
    filtered.map((h) => h.sessionId),
    unfiltered.map((h) => h.sessionId),
  )
  filtered.forEach((h, i) => {
    assert.equal(h.lexicalRank, unfiltered[i].lexicalRank)
    assert.equal(h.semanticRank, unfiltered[i].semanticRank)
    assert.ok(Math.abs(h.score - unfiltered[i].score) < 1e-12)
  })
})

ok('过滤视图排除文档后 IDF 重算（排名可与全量视图不同）', () => {
  const index = new HybridRetrievalIndex()
  index.put(doc('a', '性能优化 数据库', NOW))
  index.put(doc('b', '性能优化 数据库', NOW))
  index.put(doc('c', '性能优化 缓存', NOW))
  // 全量视图：a/b 同分并列；视图只剩 a、c 后 a 仍应命中且无异常
  const filtered = index.search('数据库', 3, (d) => d.sessionId !== 'b')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].sessionId, 'a')
})

ok('空查询 / 空索引返回空数组', () => {
  const index = new HybridRetrievalIndex()
  assert.equal(index.search('任何词', 5).length, 0)
  index.put(doc('a', '内容', NOW))
  assert.equal(index.search('   ', 5).length, 0)
})

console.log(`\n全部通过：${passed} 项断言`)
