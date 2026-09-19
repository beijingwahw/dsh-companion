/**
 * 轴线 34 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/darkmatter（知识暗物质：未连接实体对的链路预测——
 * CN/Adamic-Adar/Resource Allocation 三指数 + 度数折扣 + 已连对排除 +
 * 规模守卫 + 确定性）。
 */
import assert from 'node:assert/strict'
import { buildEntityGraph } from '../lib/core/graph/graph.js'
import { detectDarkMatter } from '../lib/core/cognition/darkmatter.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 会话实体组（[key, name] 列表）→ 共现图。 */
function graphOf(sessions) {
  const acc = new Map()
  let n = 0
  for (const list of sessions) {
    n += 1
    const sid = `s${n}`
    for (const [key, name] of list) {
      const existing = acc.get(key)
      if (existing === undefined) {
        acc.set(key, { key, name, type: 'tech', sessions: { [sid]: 1 } })
      } else {
        existing.sessions[sid] = 1
      }
    }
  }
  return buildEntityGraph([...acc.values()])
}

console.log('轴线 34：cognition/darkmatter（知识暗物质 / 缺失连接预测）')

ok('最强暗连接：共享 5 个专业邻居的未连接对居首（满分归一）', () => {
  const e = (k) => [k, k]
  const sessions = []
  for (let i = 1; i <= 5; i += 1) {
    sessions.push([e('docker'), e(`bridge${i}`)])
    sessions.push([e('systemd'), e(`bridge${i}`)])
  }
  sessions.push([e('x'), e('weakbridge')])
  sessions.push([e('only'), e('weakbridge')]) // 弱对照：仅 1 个共同邻居的未连接对
  const report = detectDarkMatter(graphOf(sessions))
  assert.ok(report.links.length >= 2)
  const top = report.links[0]
  assert.equal(top.u, 'docker')
  assert.equal(top.v, 'systemd')
  assert.equal(top.commonNeighbors, 5)
  assert.equal(top.score, 1)
  assert.ok(top.evidence.length <= 5)
  assert.ok(top.interpretation.includes('从未同场出现'))
  assert.ok(report.summary.includes('docker') && report.summary.includes('systemd'))
  // 弱对照排在后面。
  const weak = report.links.find((l) => l.u === 'x' || l.v === 'x')
  assert.ok(weak)
  assert.ok(weak.score < top.score)
})

ok('已连接对不是暗物质：三角形中的实边被排除', () => {
  const e = (k) => [k, k]
  const report = detectDarkMatter(
    graphOf([
      [e('a'), e('b'), e('c')], // a-b-c 三角
      [e('a'), e('d')],
      [e('b'), e('d')], // d 连 a、b → c-d 为暗连接，a-b/d-a/d-b 均已连
    ]),
  )
  const pairs = report.links.map((l) => [l.u, l.v].sort().join('|'))
  assert.ok(!pairs.includes('a|b'), `已连接对不应出现：${pairs}`)
  assert.ok(pairs.includes('c|d'), `应含暗连接 c-d：${pairs}`)
  const cd = report.links.find((l) => (l.u === 'c' && l.v === 'd') || (l.u === 'd' && l.v === 'c'))
  assert.equal(cd.commonNeighbors, 2)
})

ok('度数折扣：专业桥（低度）证据强于泛化桥（高度）', () => {
  const e = (k) => [k, k]
  const sessions = []
  // P1：p1a-p1b 的 3 个桥各仅连这两个实体（度 2）。
  for (let i = 1; i <= 3; i += 1) {
    sessions.push([e('p1a'), e(`m${i}`)])
    sessions.push([e('p1b'), e(`m${i}`)])
  }
  // P2：p2a-p2b 的 3 个桥各连 8 个填充实体（度 10；p2a 与 p2b 从不同场）。
  for (let i = 1; i <= 3; i += 1) {
    const rowA = [e('p2a'), e(`n${i}`)]
    for (let f = 1; f <= 8; f += 1) rowA.push(e(`f${i}-${f}`))
    sessions.push(rowA)
    sessions.push([e('p2b'), e(`n${i}`)])
  }
  const report = detectDarkMatter(graphOf(sessions))
  const find = (u, v) =>
    report.links.find((l) => (l.u === u && l.v === v) || (l.u === v && l.v === u))
  const p1 = find('p1a', 'p1b')
  const p2 = find('p2a', 'p2b')
  assert.ok(p1 && p2)
  assert.equal(p1.commonNeighbors, 3)
  assert.equal(p2.commonNeighbors, 3)
  assert.ok(
    p1.score > p2.score,
    `同为 3 桥，专业桥应更强：p1=${p1.score} p2=${p2.score}（RA: ${p1.resourceAllocation} vs ${p2.resourceAllocation}）`,
  )
})

ok('规模守卫：< 3 节点或无边图返回引导文案', () => {
  const tiny = detectDarkMatter(graphOf([[['a', 'a']]]))
  assert.equal(tiny.links.length, 0)
  assert.ok(tiny.summary.includes('规模不足'))
  const edgeless = detectDarkMatter(
    graphOf([
      [['a', 'a']],
      [['b', 'b']],
      [['c', 'c']],
    ]),
  )
  assert.equal(edgeless.links.length, 0)
  assert.ok(edgeless.summary.includes('规模不足'))
})

ok('连接饱满：共享邻居的实体对都已同场出现时零暗连接', () => {
  const report = detectDarkMatter(graphOf([[['a', 'a'], ['b', 'b'], ['c', 'c']]]))
  assert.equal(report.links.length, 0)
  assert.ok(report.summary.includes('连接饱满'))
})

ok('确定性：同图两次扫描产出一致报告', () => {
  const e = (k) => [k, k]
  const sessions = []
  for (let i = 1; i <= 4; i += 1) {
    sessions.push([e('docker'), e(`b${i}`)])
    sessions.push([e('k8s'), e(`b${i}`)])
  }
  const graph = graphOf(sessions)
  assert.deepEqual(detectDarkMatter(graph), detectDarkMatter(graph))
})

console.log(`\n全部通过：${passed} 项断言`)
