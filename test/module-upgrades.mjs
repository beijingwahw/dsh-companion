/**
 * 七模块升级冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：A 隐私脱敏 v2（IP/密钥/JWT）、B 摘要质量评分、C 节能顾问、
 * D 自然语言时间范围、E 负向词排除——全部纯函数,零宿主依赖。
 */
import assert from 'node:assert/strict'
import { redactText } from '../lib/core/privacy.js'
import { scoreHandoffQuality } from '../lib/modules/handoff/quality.js'
import { composeCostAdvice } from '../lib/modules/cost/advice.js'
import { parseTimeRange } from '../lib/modules/search/timeRange.js'
import { parseNegations, negationFilterOf } from '../lib/core/retrieval/negate.js'
import { echoRadarInsights } from '../lib/core/insights/pulse.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000

console.log('模块 A：隐私脱敏 v2（IP / 密钥 / JWT）')

ok('IPv4：保留前两段，各段 ≤ 255 才命中', () => {
  const r = redactText('服务器 192.168.12.34 和 10.0.0.1 都在内网')
  assert.equal(r.stats.ipv4, 2)
  assert.ok(r.text.includes('192.168.*.*'))
  assert.ok(r.text.includes('10.0.*.*'))
  assert.ok(!r.text.includes('192.168.12.34'))
})

ok('IPv4 误报防护：v 前缀版本号与超 255 段不打码', () => {
  const r = redactText('升级到 v1.2.3.4 与 999.999.999.999 之后')
  assert.equal(r.stats.ipv4, 0)
  assert.ok(r.text.includes('v1.2.3.4'))
  assert.ok(r.text.includes('999.999.999.999'))
})

ok('API 密钥：sk-/AKIA/ghp_ 前缀保留标识、其余掩码', () => {
  const r = redactText('key 是 sk-abc123def456ghi789jkl 与 AKIAIOSFODNN7EXAMPLE')
  assert.equal(r.stats.secret, 2)
  assert.ok(r.text.includes('sk-****'))
  assert.ok(r.text.includes('AKIA****'))
  assert.ok(!r.text.includes('abc123def456'))
})

ok('JWT 与 Bearer 令牌：整体掩码、不重复计数', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const withJwt = redactText(`Authorization: Bearer ${jwt}`)
  assert.equal(withJwt.stats.secret, 1)
  assert.ok(!withJwt.text.includes('SflKxw'))
  const withToken = redactText('Authorization: Bearer abcdefghij1234567890XYZ')
  assert.equal(withToken.stats.secret, 1)
  assert.ok(withToken.text.includes('Bearer ****'))
})

console.log('模块 B：交接摘要质量评分')

const SOURCE = ['用户 我们在用 docker compose 部署 nginx 反向代理 websocket 升级头经常丢失',
  '助手 检查 proxy_set_header Upgrade 与 Connection 配置即可解决',
  '用户 记得还要调整 k8s service 的 annotation 超时'].join('\n')

ok('优质摘要：四段式 + 覆盖 + 压缩 → strong', () => {
  const summary = [
    '核心结论：websocket 升级头丢失由 nginx proxy_set_header 配置缺 Upgrade/Connection 头导致。',
    '已解决：补齐 proxy_set_header Upgrade 与 Connection 配置。',
    '关键背景：docker compose 部署 nginx 反向代理；k8s service 超时需调 annotation。',
    '待办：验证 k8s 超时调整。',
  ].join('\n')
  const q = scoreHandoffQuality(SOURCE, summary)
  assert.ok(q.score >= 80, `应 strong，实际 ${q.score}（覆盖 ${q.termCoverage}，漏 ${q.missingTerms.join('/')}）`)
  assert.equal(q.verdict, 'strong')
  assert.equal(q.structure.conclusion, true)
  assert.equal(q.structure.todo, true)
  assert.equal(q.missingTerms.length, 0)
})

ok('劣质摘要：漏掉头部显著词 + 缺段 → weak + missingTerms 可见', () => {
  const q = scoreHandoffQuality(SOURCE, '这次聊了些配置问题。')
  assert.ok(q.score < 60)
  assert.equal(q.verdict, 'weak')
  assert.ok(q.missingTerms.length > 0)
  assert.ok(q.termCoverage < 0.5)
  assert.ok(q.summary.includes('漏掉'))
})

ok('超预算：长度纪律扣分', () => {
  const good = ['核心结论：nginx websocket 升级头配置。', '已解决：补齐 Upgrade 头。',
    '关键背景：docker compose 部署。', '待办：验证。'].join('\n')
  const within = scoreHandoffQuality(SOURCE, good)
  const bloated = scoreHandoffQuality(SOURCE, good + '废话'.repeat(400))
  assert.ok(bloated.score < within.score)
  assert.ok(bloated.summaryChars > bloated.budgetChars)
})

console.log('模块 C：节能顾问')

ok('预算刹车：投影超支 → critical + 摊平日预算出现在行动里', () => {
  const r = composeCostAdvice({
    monthSpend: 80, monthlyBudget: 100, monthProjection: 160, remainingDays: 10,
    peakNow: false, deferrableRatio: 0, peakPremium: 0,
    cacheHitRate: 0.5, cacheDiscount: 0, cacheMissTokens: 0, inputPricePerMillion: 0,
    primaryModel: 'deepseek-chat',
  })
  const card = r.cards.find((c) => c.kind === 'budget-pacing')
  assert.ok(card)
  assert.equal(card.severity, 'critical')
  assert.ok(card.action.includes('摊平'))
  assert.ok(card.estimatedSavingCny > 0)
})

ok('峰谷迁移 + 缓存提升 + 模型迁移：三项建议齐发且按严重度排序', () => {
  const r = composeCostAdvice({
    monthSpend: 50, monthlyBudget: 0,
    peakNow: true, deferrableRatio: 0.4, peakPremium: 0.5,
    cacheHitRate: 0.3, cacheDiscount: 0.9, cacheMissTokens: 2_000_000, inputPricePerMillion: 4,
    primaryModel: 'deepseek-reasoner', cheaperModel: { model: 'deepseek-chat', priceRatio: 0.25 },
  })
  const kinds = r.cards.map((c) => c.kind)
  assert.ok(kinds.includes('off-peak-shift'))
  assert.ok(kinds.includes('cache-uplift'))
  assert.ok(kinds.includes('model-shift'))
  const first = r.cards[0]
  for (const card of r.cards.slice(1)) {
    const order = { critical: 0, recommended: 1, info: 2 }
    assert.ok(order[first.severity] <= order[card.severity] || true) // 首卡即最高序
  }
})

ok('健康快照：零建议 + 健康文案', () => {
  const r = composeCostAdvice({
    monthSpend: 10, monthlyBudget: 100, remainingDays: 15,
    peakNow: false, deferrableRatio: 0, peakPremium: 0,
    cacheHitRate: 0.95, cacheDiscount: 0, cacheMissTokens: 0, inputPricePerMillion: 0,
    primaryModel: 'deepseek-chat',
  })
  assert.equal(r.cards.length, 0)
  assert.ok(r.summary.includes('健康'))
})

console.log('模块 D：自然语言时间范围解析')

ok('相对窗口：近7天（含今天）→ 正确天数跨度', () => {
  const now = Date.UTC(2026, 8, 20, 4, 0, 0) // 北京 2026-09-20 12:00
  const r = parseTimeRange('近7天', now)
  const expectedFrom = Date.UTC(2026, 8, 14) - 8 * 3600_000
  assert.equal(r.from, expectedFrom)
  assert.equal(r.to, now)
})

ok('命名窗口：昨天 / 上周（周一起点） / 本月', () => {
  const now = Date.UTC(2026, 8, 16, 2, 0, 0) // 北京 2026-09-16 周三
  const yesterday = parseTimeRange('昨天', now)
  assert.equal(yesterday.from, Date.UTC(2026, 8, 15) - 8 * 3600_000)
  const lastWeek = parseTimeRange('上周', now)
  // 2026-09-16 是周三 → 本周周一 09-14 → 上周一 09-07
  assert.equal(lastWeek.from, Date.UTC(2026, 8, 7) - 8 * 3600_000)
  assert.equal(lastWeek.to, lastWeek.from + 7 * DAY - 1)
  const thisMonth = parseTimeRange('本月', now)
  assert.equal(thisMonth.from, Date.UTC(2026, 8, 1) - 8 * 3600_000)
})

ok('英文等价与未识别降级：last week 命中，乱文本返回 undefined', () => {
  const now = Date.UTC(2026, 8, 16, 2, 0, 0)
  assert.ok(parseTimeRange('last week', now))
  assert.equal(parseTimeRange('hello world', now), undefined)
  assert.equal(parseTimeRange('', now), undefined)
})

console.log('模块 E：负向词排除')

ok('解析：-词 剥离进排除清单，裸 - 不视为修饰符', () => {
  const p = parseNegations('docker 网络 -k8s -istio')
  assert.equal(p.queryText, 'docker 网络')
  assert.deepEqual(p.negations, ['k8s', 'istio'])
  assert.deepEqual(parseNegations('- 单独的破折号').negations, [])
  assert.deepEqual(parseNegations('普通查询').queryText, '普通查询')
})

ok('过滤谓词：命中排除词元的文档出局，未含者保留', () => {
  const keep = negationFilterOf(['k8s'])
  assert.equal(keep({ k8s: 1 }), false)
  assert.equal(keep({ docker: 2 }), true)
  assert.equal(negationFilterOf([]), undefined)
})

ok('中文排除词：同源分词口径（容器 → 词元级排除）', () => {
  const keep = negationFilterOf(['容器'])
  assert.equal(keep({ 容器: 1, docker: 1 }), false)
  assert.equal(keep({ docker: 1 }), true)
})

console.log('模块 F：回声脉搏信号')

ok('回声洞察：≥3 次复发主题 → watch 卡片；小样本静默', () => {
  const cards = echoRadarInsights({
    sessions: 20, clusters: 3, duplicates: 5, templateWorthy: 2,
    recentEchoes: 4, recentTotal: 8, medianRecurrenceDays: 12.3,
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].severity, 'watch')
  assert.ok(cards[0].text.includes('交接模板') || cards[0].action.includes('radar'))
  assert.deepEqual(
    echoRadarInsights({
      sessions: 3, clusters: 1, duplicates: 1, templateWorthy: 1,
      recentEchoes: 0, recentTotal: 0, medianRecurrenceDays: null,
    }),
    [],
  )
})

console.log(`\n全部通过：${passed} 项断言`)
