/**
 * 轴线 32/33 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/archaeology（知识考古：纪元切片 + 板块事件分类——
 * 新生/延续/分裂/合并/消亡 + 样本守卫 + 确定性）、cognition/radar
 * （回声雷达：会话级近重复聚类 + 复发周期 + 回声率 + 行动分层）。
 */
import assert from 'node:assert/strict'
import { excavateKnowledge } from '../lib/core/cognition/archaeology.js'
import { scanSessionEchoes } from '../lib/core/cognition/radar.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const DAY = 24 * 3600_000
const T0 = 1_800_000_000_000

/** 构造一段「纪元」：若干会话共享同一实体组（形成一块内聚大陆）。 */
function era(prefix, keys, count, startAt) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    at: startAt + i * DAY,
    entityKeys: keys,
  }))
}

console.log('轴线 32：cognition/archaeology（知识考古 / 板块构造学）')

ok('样本守卫：不足 4 个含实体会话时给出引导文案', () => {
  const report = excavateKnowledge(era('a', ['tech:docker'], 3, T0))
  assert.equal(report.windows.length, 0)
  assert.ok(report.summary.includes('样本不足'))
})

ok('板块事件：延续（docker 大陆跨纪元存活）+ 新生（rust 大陆形成）', () => {
  const sessions = [
    ...era('e1', ['tech:docker', 'tech:network', 'tech:bridge'], 4, T0),
    ...era('e2a', ['tech:docker', 'tech:network', 'tech:ipvlan'], 4, T0 + 100 * DAY),
    ...era('e2b', ['tech:rust', 'tech:ownership', 'tech:borrow'], 4, T0 + 200 * DAY),
  ]
  const report = excavateKnowledge(sessions, { windows: 2 })
  assert.equal(report.stats.windows, 2)
  const kinds = new Set(report.events.map((e) => e.kind))
  assert.ok(kinds.has('continuation'), `应有延续事件，实际：${[...kinds]}`)
  assert.ok(kinds.has('birth'), `应有新生事件，实际：${[...kinds]}`)
  const cont = report.events.find((e) => e.kind === 'continuation')
  assert.ok(cont.strength >= 0.3, '延续事件血脉强度应 ≥ 阈值')
  const birth = report.events.find((e) => e.kind === 'birth')
  assert.ok(birth.topEntities.includes('rust'), '新生大陆代表实体应为 rust')
  assert.ok(report.summary.includes('构造运动'))
})

ok('板块事件：分裂（一块大陆的关注点分化为两块）', () => {
  const sessions = [
    ...era('s1', ['tech:a', 'tech:b', 'tech:c', 'tech:d'], 4, T0),
    ...era('s2a', ['tech:a', 'tech:b'], 2, T0 + 100 * DAY),
    ...era('s2b', ['tech:c', 'tech:d'], 2, T0 + 100 * DAY),
  ]
  const report = excavateKnowledge(sessions, { windows: 2 })
  const split = report.events.find((e) => e.kind === 'split')
  assert.ok(split, `应有分裂事件，实际：${report.events.map((e) => e.kind)}`)
  assert.equal(split.fromWindow, 0)
  assert.equal(split.toWindow, 1)
  assert.ok(split.description.includes('分裂'))
  assert.equal(report.stats.splits, 1)
})

ok('板块事件：合并（两块分散主题收拢为一块大陆）', () => {
  const sessions = [
    ...era('m1a', ['tech:a', 'tech:b'], 2, T0),
    ...era('m1b', ['tech:c', 'tech:d'], 2, T0),
    ...era('m2', ['tech:a', 'tech:b', 'tech:c', 'tech:d'], 4, T0 + 100 * DAY),
  ]
  const report = excavateKnowledge(sessions, { windows: 2 })
  const merge = report.events.find((e) => e.kind === 'merge')
  assert.ok(merge, `应有合并事件，实际：${report.events.map((e) => e.kind)}`)
  assert.equal(report.stats.merges, 1)
  assert.ok(merge.description.includes('收拢'))
})

ok('板块事件：消亡（旧大陆沉没）与新大陆诞生成对出现', () => {
  const sessions = [
    ...era('d1', ['tech:legacy', 'tech:oldstack', 'tech:deprecated'], 4, T0),
    ...era('d2', ['tech:newera', 'tech:freshstart', 'tech:greenfield'], 4, T0 + 100 * DAY),
  ]
  const report = excavateKnowledge(sessions, { windows: 2 })
  assert.equal(report.stats.dissolves, 1)
  assert.equal(report.stats.births, 1)
  const dissolve = report.events.find((e) => e.kind === 'dissolve')
  assert.equal(dissolve.toWindow, -1)
  assert.ok(dissolve.description.includes('沉没'))
})

ok('纪元快照：时间升序、模块度与大陆成员键齐全', () => {
  const sessions = [
    ...era('w1', ['tech:x', 'tech:y'], 4, T0),
    ...era('w2', ['tech:x', 'tech:y'], 4, T0 + 100 * DAY),
  ]
  const report = excavateKnowledge(sessions, { windows: 2 })
  assert.deepEqual(
    report.windows.map((w) => w.index),
    [0, 1],
  )
  for (const w of report.windows) {
    assert.ok(w.sessions >= 2)
    assert.ok(w.entities >= 2)
    assert.ok(w.modularity >= -0.5 && w.modularity <= 1)
    for (const c of w.continents) {
      assert.ok(c.memberKeys.length === c.size)
      assert.ok(c.topEntities.length <= 5)
    }
  }
})

ok('确定性：同输入两次考古产出逐字节一致的事件序列', () => {
  const sessions = [
    ...era('e1', ['tech:docker', 'tech:network'], 4, T0),
    ...era('e2', ['tech:docker', 'tech:k8s'], 4, T0 + 100 * DAY),
  ]
  const a = excavateKnowledge(sessions, { windows: 2 })
  const b = excavateKnowledge(sessions, { windows: 2 })
  assert.deepEqual(a, b)
})

console.log('轴线 33：cognition/radar（回声雷达 / 会话级复发检测）')

ok('样本守卫：不足 2 场会话时雷达待启动', () => {
  const r = scanSessionEchoes([{ id: 's1', at: T0, text: 'docker 网络' }])
  assert.equal(r.clusters.length, 0)
  assert.ok(r.summary.includes('不足'))
})

ok('回声簇：同主题三场会话归为一簇，复发 ≥3 次建议固化模板', () => {
  const echo = 'docker 容器网络 bridge 配置互访'
  const sessions = [
    { id: 's1', at: T0, text: echo },
    { id: 's2', at: T0 + 10 * DAY, text: echo },
    { id: 's3', at: T0 + 20 * DAY, text: echo },
    { id: 'u1', at: T0 + 21 * DAY, text: 'rust ownership borrow checker 完全不同的主题' },
    { id: 'u2', at: T0 + 22 * DAY, text: 'pdf 字体嵌入子集化 unrelated' },
  ]
  const r = scanSessionEchoes(sessions)
  assert.equal(r.clusters.length, 1)
  const cluster = r.clusters[0]
  assert.equal(cluster.occurrences, 3)
  assert.equal(cluster.action, 'template')
  assert.equal(cluster.recurrenceDays, 10)
  assert.equal(r.medianRecurrenceDays, 10)
  assert.equal(r.duplicates, 2)
  assert.ok(r.summary.includes('交接模板'))
})

ok('回声率：近窗新会话中命中历史回声的占比（2/5 = 40%）', () => {
  const echo = 'docker 容器网络 bridge 配置互访'
  const sessions = [
    { id: 's1', at: T0, text: echo },
    { id: 's2', at: T0 + 10 * DAY, text: echo },
    { id: 's3', at: T0 + 20 * DAY, text: echo },
    { id: 'u1', at: T0 + 21 * DAY, text: 'rust ownership borrow checker 完全不同的主题' },
    { id: 'u2', at: T0 + 22 * DAY, text: 'pdf 字体嵌入子集化 unrelated' },
  ]
  const r = scanSessionEchoes(sessions, { days: 30 })
  assert.equal(r.recentTotal, 5)
  assert.equal(r.recentEchoes, 2)
  assert.equal(r.echoRate, 0.4)
})

ok('行动分层：恰好 2 次复发为关注级，周期不可估（null）', () => {
  const echo = 'webpack 构建缓存损坏清理 rebuild'
  const sessions = [
    { id: 's1', at: T0, text: echo },
    { id: 's2', at: T0 + 5 * DAY, text: echo },
    { id: 'u1', at: T0 + 6 * DAY, text: '完全无关的单场会话主题' },
  ]
  const r = scanSessionEchoes(sessions)
  assert.equal(r.clusters.length, 1)
  assert.equal(r.clusters[0].occurrences, 2)
  assert.equal(r.clusters[0].action, 'watch')
  assert.equal(r.clusters[0].recurrenceDays, null)
  assert.equal(r.medianRecurrenceDays, null)
})

ok('近重复容差：同主题改写措辞（非逐字重复）仍可聚簇', () => {
  const sessions = [
    { id: 's1', at: T0, text: 'docker 容器之间怎么互相访问 network bridge' },
    { id: 's2', at: T0 + 9 * DAY, text: 'docker 容器 之间 怎么 互相 访问 network bridge 通' },
    { id: 'u1', at: T0 + 10 * DAY, text: 'k8s service mesh istio sidecar 注入' },
  ]
  const r = scanSessionEchoes(sessions, { jaccardThreshold: 0.55 })
  assert.equal(r.clusters.length, 1)
  assert.equal(r.clusters[0].occurrences, 2)
})

ok('无回声：每场会话独立新主题时报告零簇', () => {
  const sessions = [
    { id: 'a', at: T0, text: 'docker 容器网络配置' },
    { id: 'b', at: T0 + DAY, text: 'rust 所有权检查器' },
    { id: 'c', at: T0 + 2 * DAY, text: 'pdf 字体子集化嵌入' },
    { id: 'd', at: T0 + 3 * DAY, text: 'react server components 流式渲染' },
  ]
  const r = scanSessionEchoes(sessions)
  assert.equal(r.clusters.length, 0)
  assert.equal(r.echoRate, 0)
  assert.ok(r.summary.includes('未检测到'))
})

ok('确定性：同输入两次扫描产出一致报告', () => {
  const echo = 'nginx 反向代理 websocket 升级头配置'
  const sessions = [
    { id: 's1', at: T0, text: echo },
    { id: 's2', at: T0 + 7 * DAY, text: echo },
    { id: 's3', at: T0 + 14 * DAY, text: echo },
    { id: 'u1', at: T0 + 15 * DAY, text: '无关主题 postgres 索引膨胀清理' },
  ]
  assert.deepEqual(scanSessionEchoes(sessions), scanSessionEchoes(sessions))
})

console.log(`\n全部通过：${passed} 项断言`)
