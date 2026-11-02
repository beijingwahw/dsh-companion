/**
 * 轴线 36 算法冒烟测试（驱动 lib/ 编译产物，ESM）。
 * 覆盖：cognition/brokerage（结构洞掮客：Burt 网络约束 + 有效规模 +
 * Gould-Fernandez 五角色分类 + 跨域占比融合分 + 度数/规模/预算守卫 +
 * 无分组退化 + 确定性）。
 */
import assert from 'node:assert/strict'
import { buildEntityGraph } from '../lib/core/graph/graph.js'
import { detectBrokerage } from '../lib/core/cognition/brokerage.js'

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

const e = (k) => [k, k]

console.log('轴线 36：cognition/brokerage（结构洞掮客 / 跨域翻译者识别）')

// --------------------------------------------------------------------
// 案例 1：哑铃图——两块大陆 + 一座桥：纯桥居首（约束最低、纯联络角色）
// a1,a2,a3 互为大陆 A；b1,b2,b3 互为大陆 B；t 横跨两岸。
// 手算锚点：constraint(t) = 4 × (0.25 + 0.125)² = 0.5625；
// t 的角色：consultant 4（岸内对）+ liaison 8（跨岸对）= 12 有序对。
// --------------------------------------------------------------------
const barbellSessions = [
  [e('a1'), e('a2'), e('a3')],
  [e('b1'), e('b2'), e('b3')],
  [e('t'), e('a1'), e('a2')],
  [e('t'), e('b1'), e('b2')],
]
const barbellGroups = new Map(
  ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 't'].map((k) => [
    k,
    k.startsWith('a') ? 1 : k.startsWith('b') ? 2 : 3,
  ]),
)
const barbell = detectBrokerage(graphOf(barbellSessions), { groups: barbellGroups })

ok('纯桥居首：跨结构洞的 t 掂客分满分', () => {
  assert.ok(barbell.brokers.length >= 3)
  assert.equal(barbell.brokers[0].name, 't')
  assert.equal(barbell.brokers[0].score, 1)
  // 排序不分层：分数单调不增。
  for (let i = 1; i < barbell.brokers.length; i += 1) {
    assert.ok(barbell.brokers[i - 1].score >= barbell.brokers[i].score)
  }
})
ok('网络约束手算锚点：constraint(t) = 0.5625（直接 + 间接冗余）', () => {
  const t = barbell.brokers[0]
  assert.ok(Math.abs(t.constraint - 0.5625) < 1e-6)
})
ok('桥的约束低于两岸成员（Burt 洞分方向性）', () => {
  const t = barbell.brokers[0]
  for (const broker of barbell.brokers) {
    if (broker.key !== 't') assert.ok(t.constraint < broker.constraint)
  }
})
ok('Gould-Fernandez 角色：t = 联络 8 / 顾问 4（有序对口径）', () => {
  const t = barbell.brokers[0]
  assert.equal(t.roles.liaison, 8)
  assert.equal(t.roles.consultant, 4)
  assert.equal(t.roles.coordinator, 0)
  assert.equal(t.roles.representative, 0)
  assert.equal(t.roles.gatekeeper, 0)
  assert.equal(t.totalPairs, 12)
  assert.equal(t.crossGroupPairs, 12)
  assert.equal(t.crossShare, 1)
})
ok('组内成员角色：大陆成员 = 协调 + 代表 + 守门、零联络', () => {
  const a1 = barbell.brokers.find((b) => b.key === 'a1')
  assert.ok(a1)
  assert.equal(a1.roles.coordinator, 2)
  assert.equal(a1.roles.representative, 2)
  assert.equal(a1.roles.gatekeeper, 2)
  assert.equal(a1.roles.liaison, 0)
  assert.ok(a1.crossShare > 0 && a1.crossShare < 1)
})
ok('解读文案指向跨域翻译', () => {
  assert.ok(barbell.brokers[0].interpretation.includes('跨域'))
  assert.ok(barbell.summary.includes('t'))
})
ok('数值有限且效率 ∈ [0,1]', () => {
  for (const broker of barbell.brokers) {
    for (const v of [broker.constraint, broker.effectiveSize, broker.efficiency, broker.score]) {
      assert.ok(Number.isFinite(v), `非有限值: ${v}`)
    }
    assert.ok(broker.efficiency >= 0 && broker.efficiency <= 1)
  }
})

// --------------------------------------------------------------------
// 案例 2：三组星形枢纽——角色分类精确计数 + 有效规模无冗余
// t(组1) 连 x(组1)/y(组2)/z(组3)：6 个有序对 = 代表 2 + 守门 2 + 联络 2。
// 接触互不相连 → 有效规模 = 度数（效率 1）、约束 = 3 × (1/3)² = 1/3。
// --------------------------------------------------------------------
const star = detectBrokerage(graphOf([[e('t'), e('x')], [e('t'), e('y')], [e('t'), e('z')]]), {
  groups: new Map([
    ['t', 1],
    ['x', 1],
    ['y', 2],
    ['z', 3],
  ]),
})
ok('三组星形：五角色精确分类（代表 2 / 守门 2 / 联络 2）', () => {
  assert.equal(star.candidates, 1)
  const t = star.brokers[0]
  assert.equal(t.name, 't')
  assert.deepEqual(t.roles, { coordinator: 0, consultant: 0, representative: 2, gatekeeper: 2, liaison: 2 })
  assert.equal(t.totalPairs, 6)
  assert.equal(t.crossGroupPairs, 6)
})
ok('开放星形无冗余：有效规模 = 度数、效率 1、约束 = 1/3', () => {
  const t = star.brokers[0]
  assert.ok(Math.abs(t.effectiveSize - 3) < 1e-6)
  assert.equal(t.efficiency, 1)
  assert.ok(Math.abs(t.constraint - 1 / 3) < 1e-4)
})

// --------------------------------------------------------------------
// 案例 3：闭合三角（单组）——结构洞坍缩：全协调角色、全冗余
// 单会话三角：约束 = 2 × (1/3 + 1/6)² = 0.5；有效规模 = 2 × (1 − 1/3) = 4/3。
// --------------------------------------------------------------------
const triangle = detectBrokerage(graphOf([[e('a'), e('b'), e('c')]]))
ok('闭合单组三角：中介对全部协调、跨域占比为零', () => {
  assert.equal(triangle.groupCount, 1)
  for (const broker of triangle.brokers) {
    assert.equal(broker.roles.coordinator, 2)
    assert.equal(broker.roles.liaison, 0)
    assert.equal(broker.crossShare, 0)
  }
})
ok('闭合三角手算锚点：约束 2×(1/2+1/4)² = 1.125、效率 1/2（接触互连折损有效规模）', () => {
  const a = triangle.brokers.find((b) => b.key === 'a')
  assert.ok(a)
  assert.ok(Math.abs(a.constraint - 1.125) < 1e-6)
  assert.ok(Math.abs(a.efficiency - 0.5) < 1e-4)
  assert.ok(a.interpretation.includes('组内'))
})

// --------------------------------------------------------------------
// 案例 4：度数守卫——叶节点与孤立点不参与掮客排名
// --------------------------------------------------------------------
const leafy = detectBrokerage(graphOf([[e('a1'), e('b1')], [e('l'), e('a1')]]))
ok('度数 < 2 的实体不入选（单接触无从中介）', () => {
  assert.equal(leafy.candidates, 1)
  assert.equal(leafy.brokers.length, 1)
  assert.equal(leafy.brokers[0].key, 'a1')
  assert.ok(!leafy.brokers.some((b) => b.key === 'l' || b.key === 'b1'))
})

// --------------------------------------------------------------------
// 案例 5：预算熔断——中介对展开触达预算即停（结果为下界）
// --------------------------------------------------------------------
// 8 实体全共现：每个候选 7×6 = 42 组有序对；预算 100（引擎下限）
// 在第 3 个候选（84 + 42 > 100）触发熔断截断。
const clique = graphOf([Array.from({ length: 8 }, (_, i) => e(`n${i + 1}`))])
const fused = detectBrokerage(clique, { pairBudget: 100 })
ok('预算熔断：候选集被截断且显式标注', () => {
  assert.equal(fused.budgetExhausted, true)
  assert.equal(fused.candidates, 2)
  assert.ok(fused.brokers.length > 0)
})

// --------------------------------------------------------------------
// 案例 6：规模守卫——< 3 节点或无边图返回引导文案
// --------------------------------------------------------------------
ok('规模守卫：小图/无边图零掮客 + 引导文案', () => {
  const tiny = detectBrokerage(graphOf([[['a', 'a']]]))
  assert.equal(tiny.brokers.length, 0)
  assert.ok(tiny.summary.includes('规模不足'))
  const edgeless = detectBrokerage(graphOf([[['a', 'a']], [['b', 'b']], [['c', 'c']]]))
  assert.equal(edgeless.brokers.length, 0)
  assert.ok(edgeless.summary.includes('规模不足'))
})

// --------------------------------------------------------------------
// 确定性：同图两次扫描产出一致报告
// --------------------------------------------------------------------
ok('确定性：同输入两次运行 deepEqual', () => {
  assert.deepEqual(
    detectBrokerage(graphOf(barbellSessions), { groups: barbellGroups }),
    detectBrokerage(graphOf(barbellSessions), { groups: barbellGroups }),
  )
})

console.log(`\n全部通过：${passed} 项断言`)
