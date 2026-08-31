/**
 * 轴线 20/21/22 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/prospective（前瞻记忆）、cognition/episodes（片段
 * 提取）、cognition/spaced（间隔重复）、cognition/analogy（类比检索）、
 * insights/pulse 的认知信号提供者。
 */
import assert from 'node:assert/strict'
import {
  dueIntentions,
  extractIntentions,
  sanitizeIntentionRecord,
  upcomingIntentions,
} from './lib/core/cognition/prospective.js'
import {
  extractEpisodes,
  extractShape,
  mergeShape,
  sanitizeEpisodeRecord,
} from './lib/core/cognition/episodes.js'
import {
  dueReviews,
  gradeReview,
  initialDueAt,
  INTERVALS_DAYS,
  nextDueAt,
  reviewStrength,
  sanitizeReviewState,
} from './lib/core/cognition/spaced.js'
import { findAnalogies, shapeSimilarity } from './lib/core/cognition/analogy.js'
import {
  dueIntentionInsights,
  dueReviewInsights,
  episodeInsights,
} from './lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000
const NOW = 1_800_000_000_000

console.log('轴线 20：cognition/prospective（前瞻记忆引擎）')

ok('意图提取：时间标记 × 意图动词共现', () => {
  const intentions = extractIntentions(
    '今天聊得很开心。明天我试试这个方案。这不是意图。下周再优化性能。怎么修复这个错误？',
  )
  assert.equal(intentions.length, 2)
  assert.ok(intentions[0].text.includes('试试'))
  assert.equal(intentions[0].horizonDays, 1)
  assert.equal(intentions[0].explicit, true)
  assert.ok(intentions[1].text.includes('优化'))
  assert.equal(intentions[1].horizonDays, 7)
})

ok('问句排除：「怎么修复？」不是承诺', () => {
  const intentions = extractIntentions('怎么修复这个问题？明天怎么部署？')
  assert.equal(intentions.length, 0)
})

ok('模糊标记：回头/以后 取 7 天缺省视界', () => {
  const intentions = extractIntentions('回头我重构一下这块代码。以后有空再研究下这个库。')
  assert.equal(intentions.length, 2)
  assert.equal(intentions[0].horizonDays, 7)
  assert.equal(intentions[0].explicit, false)
})

ok('独立 TODO 标记无需动词共现', () => {
  const intentions = extractIntentions('TODO 检查这个迁移脚本。别忘了环境变量。')
  assert.equal(intentions.length, 2)
})

ok('英文意图：tomorrow/next week 识别', () => {
  const intentions = extractIntentions('Sounds good. tomorrow I will try this config. next week we refactor the module.')
  assert.equal(intentions.length, 2)
  assert.equal(intentions[0].horizonDays, 1)
  assert.equal(intentions[1].horizonDays, 7)
})

ok('到期计算：createdAt + horizonDays 已过即到期', () => {
  const records = new Map([
    ['s1', { createdAt: NOW - 10 * DAY, intentions: [{ text: '明天试试 A', marker: '明天', horizonDays: 1, explicit: true }] }],
    ['s2', { createdAt: NOW - 0.5 * DAY, intentions: [{ text: '明天试试 B', marker: '明天', horizonDays: 1, explicit: true }] }],
  ])
  const due = dueIntentions(records, NOW)
  assert.equal(due.length, 1)
  assert.equal(due[0].sessionId, 's1')
  assert.equal(due[0].overdueDays, 9)
})

ok('即将到期：未来 7 天内但未到期', () => {
  const records = new Map([
    ['s1', { createdAt: NOW - 6 * DAY, intentions: [{ text: '下周优化 C', marker: '下周', horizonDays: 7, explicit: true }] }],
  ])
  assert.equal(upcomingIntentions(records, NOW).length, 1)
  assert.equal(dueIntentions(records, NOW).length, 0)
})

ok('净化：非法意图记录丢弃', () => {
  assert.equal(sanitizeIntentionRecord(null), undefined)
  assert.equal(sanitizeIntentionRecord({ createdAt: 0, intentions: [] }), undefined)
  assert.equal(sanitizeIntentionRecord({ createdAt: 100, intentions: 'x' }), undefined)
  const valid = sanitizeIntentionRecord({
    createdAt: 100,
    intentions: [{ text: 'ok', marker: '明天', horizonDays: 1, explicit: true }],
  })
  assert.equal(valid.intentions.length, 1)
})

console.log('轴线 21/22 基座：cognition/episodes（问题→解决片段）')

ok('片段提取：问题行配对窗口内的解法行', () => {
  const text = [
    'docker 容器访问数据库一直超时，报错 connection refused',
    '中间排查了端口映射。',
    '原来是网络模式的问题，改成 host 网络就解决了',
  ].join('\n')
  const episodes = extractEpisodes(text)
  assert.equal(episodes.length, 1)
  assert.ok(episodes[0].problem.includes('超时'))
  assert.ok(episodes[0].solution.includes('host 网络'))
  assert.ok(episodes[0].shape.constraints.includes('network'))
  assert.ok(episodes[0].shape.resolutions.includes('config-fix'))
})

ok('无解法行的问题行被丢弃（单边信号不成知识）', () => {
  const episodes = extractEpisodes('构建一直失败，报错很奇怪\n这里还有些闲聊内容\n另外一句话')
  assert.equal(episodes.length, 0)
})

ok('窗口外解法不配对', () => {
  const lines = ['内存占用太高导致崩溃', ...Array(10).fill('闲聊填充'), '加上了内存限制解决了']
  assert.equal(extractEpisodes(lines.join('\n')).length, 0)
})

ok('稳定 id：同文本重提取得到同 id', () => {
  const text = '编译失败报错 ts2304\n原来是缺了类型声明文件，安装了 @types/node 解决'
  const a = extractEpisodes(text)
  const b = extractEpisodes(text)
  assert.equal(a[0].id, b[0].id)
})

ok('形状提取：多类别命中', () => {
  const shape = extractShape('升级后依赖不兼容，构建失败，并发场景还有竞态')
  assert.ok(shape.constraints.includes('version'))
  assert.ok(shape.constraints.includes('dependency'))
  assert.ok(shape.constraints.includes('build'))
  assert.ok(shape.constraints.includes('concurrency'))
})

ok('形状合并：并集去重', () => {
  const merged = mergeShape(
    { constraints: ['network'], resolutions: ['config-fix'] },
    { constraints: ['network', 'version'], resolutions: [] },
  )
  assert.deepEqual(merged.constraints, ['network', 'version'])
  assert.deepEqual(merged.resolutions, ['config-fix'])
})

ok('净化：非法片段记录丢弃，合法通过', () => {
  assert.equal(sanitizeEpisodeRecord(null), undefined)
  assert.equal(sanitizeEpisodeRecord({ createdAt: 100, episodes: [{ id: 'x' }] }), undefined)
  const valid = sanitizeEpisodeRecord({
    createdAt: 100,
    episodes: [
      { id: 'x', problem: 'p', solution: 's', shape: { constraints: ['network'], resolutions: [] } },
    ],
  })
  assert.equal(valid.episodes.length, 1)
})

console.log('轴线 21：cognition/spaced（间隔重复巩固）')

ok('首次到期：创建 1 天后', () => {
  assert.equal(initialDueAt(NOW), NOW + 1 * DAY)
})

ok('评分阶梯：记得升档封顶，忘了归零', () => {
  const s0 = { episodeId: 'e1', lastReviewedAt: null, stage: 0 }
  const g1 = gradeReview(s0, true, NOW)
  assert.equal(g1.state.stage, 1)
  assert.equal(g1.nextIntervalDays, 3)
  const g2 = gradeReview(g1.state, true, NOW)
  assert.equal(g2.state.stage, 2)
  assert.equal(g2.nextIntervalDays, 7)
  // 连续记得到顶。
  let state = g2.state
  for (let i = 0; i < 10; i += 1) state = gradeReview(state, true, NOW).state
  assert.equal(state.stage, INTERVALS_DAYS.length - 1)
  const top = gradeReview(state, true, NOW)
  assert.equal(top.state.stage, INTERVALS_DAYS.length - 1)
  // 忘了 → 归零。
  const forgot = gradeReview(state, false, NOW)
  assert.equal(forgot.state.stage, 0)
  assert.equal(forgot.nextIntervalDays, 1)
})

ok('nextDueAt：最近复习时间 + 档位间隔', () => {
  assert.equal(nextDueAt({ episodeId: 'e', lastReviewedAt: NOW, stage: 2 }), NOW + 7 * DAY)
})

ok('到期复习：无状态满 1 天 / 有状态过间隔', () => {
  const episodes = new Map([
    ['s1', { createdAt: NOW - 3 * DAY, episodes: [{ id: 'a', problem: 'p', solution: 's', shape: { constraints: [], resolutions: [] } }] }],
    ['s2', { createdAt: NOW - 20 * DAY, episodes: [{ id: 'b', problem: 'p', solution: 's', shape: { constraints: [], resolutions: [] } }] }],
  ])
  const states = new Map([
    ['s2:b', { episodeId: 's2:b', lastReviewedAt: NOW - 8 * DAY, stage: 1 }],
  ])
  const due = dueReviews(episodes, states, NOW)
  // s1:a 无状态满 1 天 → fresh 到期；s2:b 上次复习 8 天前 + 3 天间隔 → 到期。
  assert.equal(due.length, 2)
  const fresh = due.find((item) => item.episodeId === 's1:a')
  assert.equal(fresh.fresh, true)
  const lapsed = due.find((item) => item.episodeId === 's2:b')
  assert.equal(lapsed.fresh, false)
  assert.equal(lapsed.strength, 1 / (INTERVALS_DAYS.length - 1))
})

ok('巩固度：档位进度', () => {
  assert.equal(reviewStrength(undefined), 0)
  assert.equal(reviewStrength({ episodeId: 'e', lastReviewedAt: NOW, stage: 3 }), 3 / (INTERVALS_DAYS.length - 1))
})

ok('净化：非法复习状态丢弃', () => {
  assert.equal(sanitizeReviewState(null), undefined)
  assert.equal(sanitizeReviewState({ episodeId: 'e', lastReviewedAt: null, stage: -1 }), undefined)
  assert.equal(sanitizeReviewState({ episodeId: 'e', lastReviewedAt: null, stage: 99 }), undefined)
  assert.deepEqual(sanitizeReviewState({ episodeId: 'e', lastReviewedAt: null, stage: 0 }), {
    episodeId: 'e',
    lastReviewedAt: null,
    stage: 0,
  })
})

console.log('轴线 22：cognition/analogy（类比检索）')

ok('形状相似度：约束主导 + 解法辅助', () => {
  const a = { constraints: ['network', 'config'], resolutions: ['config-fix'] }
  const b = { constraints: ['network', 'version'], resolutions: ['config-fix'] }
  const c = { constraints: ['performance'], resolutions: [] }
  const ab = shapeSimilarity(a, b)
  assert.ok(ab > 0.3 && ab < 0.8, `ab=${ab}`)
  assert.equal(shapeSimilarity(a, c), 0)
  assert.equal(shapeSimilarity({ constraints: [], resolutions: [] }, a), 0)
})

ok('跨域类比：主题不同而结构同构', () => {
  // 历史片段：docker 网络问题（与 k8s 查询无词元重叠，但结构同构）。
  const episodes = new Map([
    [
      's-docker',
      {
        createdAt: NOW - 90 * DAY,
        episodes: [
          {
            id: 'hash1',
            problem: 'docker 容器互相访问超时 connection refused',
            solution: '原来是 bridge 网络隔离，改成自定义 bridge 网络解决了',
            shape: { constraints: ['network'], resolutions: ['config-fix'] },
          },
        ],
      },
    ],
  ])
  const report = findAnalogies('k8s 集群里两个 service 互相调用一直超时', episodes)
  assert.equal(report.analogies.length, 1)
  const hit = report.analogies[0]
  assert.equal(hit.crossDomain, true)
  assert.ok(hit.score >= 0.5)
  assert.deepEqual(hit.sharedConstraints, ['network'])
})

ok('同域先例：主题重叠高时不标跨域', () => {
  const episodes = new Map([
    [
      's-k8s',
      {
        createdAt: NOW - 30 * DAY,
        episodes: [
          {
            id: 'hash2',
            problem: 'k8s 集群 service 调用超时 connection refused',
            solution: '加上了 coredns 配置解决了',
            shape: { constraints: ['network', 'api'], resolutions: ['config-fix'] },
          },
        ],
      },
    ],
  ])
  const report = findAnalogies('k8s 集群里 service 调用一直超时', episodes)
  assert.equal(report.analogies[0].crossDomain, false)
  assert.ok(report.summary.includes('同域先例'))
})

ok('无结构查询 → 空结果 + 提示', () => {
  const report = findAnalogies('你好', new Map())
  assert.equal(report.analogies.length, 0)
  assert.ok(report.summary.includes('问题类型关键词'))
})

ok('查询形状溯源：响应携带提取到的结构', () => {
  const report = findAnalogies('数据库迁移后查询变慢', new Map())
  assert.ok(report.queryShape.constraints.includes('performance'))
  assert.ok(report.queryShape.constraints.includes('data'))
})

console.log('轴线 18 扩展：认知信号提供者')

ok('到期意图 → critical/watch 卡片', () => {
  const cards = dueIntentionInsights([{ text: '明天试试 X', overdueDays: 20 }])
  assert.equal(cards[0].category, 'intention')
  assert.equal(cards[0].severity, 'critical')
  const mild = dueIntentionInsights([{ text: '回头优化 Y', overdueDays: 3 }])
  assert.equal(mild[0].severity, 'watch')
  assert.deepEqual(dueIntentionInsights([]), [])
})

ok('到期复习 → info 卡片带行动建议', () => {
  const cards = dueReviewInsights([{ fresh: true }, { fresh: false }])
  assert.equal(cards[0].category, 'review')
  assert.ok(cards[0].text.includes('2 条'))
  assert.ok(cards[0].text.includes('1 条首次'))
  assert.deepEqual(dueReviewInsights([]), [])
})

ok('片段资产：空库 / 跨域就绪 / 积累中 三态', () => {
  const empty = episodeInsights({ episodes: 0, sessionsWithEpisodes: 0, crossDomainReady: false })
  assert.ok(empty[0].text.includes('尚未'))
  const ready = episodeInsights({ episodes: 12, sessionsWithEpisodes: 6, crossDomainReady: true })
  assert.ok(ready[0].text.includes('跨域匹配'))
  const growing = episodeInsights({ episodes: 3, sessionsWithEpisodes: 2, crossDomainReady: false })
  assert.ok(growing[0].text.includes('积累更多'))
})

console.log(`\n全部通过：${passed} 项断言`)
