/**
 * 隐私脱敏导出保真回归测试（驱动 lib/ 编译产物，ESM）。
 * 核心不变量：未命中任何隐私规则时，导出文本必须逐字符不变——
 * 数字分隔符归一化只允许在“合并结果确实会被打码”时改写文本。
 * 同时守卫：分组手机号/身份证/银行卡仍识别打码、+86 边界不回归、
 * 统计不重复计数。
 */
import assert from 'node:assert/strict'
import { redactText, hasRedactions } from '../lib/core/privacy.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

const ZERO_STATS = { phone: 0, email: 0, idCard: 0, bankCard: 0, ipv4: 0, secret: 0 }

console.log('privacy 保真：未命中时原文逐字符不变')

ok('11 位分组但非手机号（2024 0101 123）：归一化不得改写文本', () => {
  const input = '会议时间 2024 0101 123 待定'
  const r = redactText(input)
  // 旧 bug：位宽 11 命中 MERGEABLE_WIDTHS，文本被改成 '会议时间 20240101123 待定'
  assert.equal(r.text, input)
  assert.deepEqual(r.stats, ZERO_STATS)
  assert.ok(!hasRedactions(r.stats))
})

ok('11 位分组座机号段（010 1234 5678）：不属于任何规则，保持原样', () => {
  const input = '总机 010 1234 5678 转分机'
  const r = redactText(input)
  assert.equal(r.text, input)
  assert.deepEqual(r.stats, ZERO_STATS)
})

ok('日期与版本相关分组混合文本：逐字符不变', () => {
  const input = '日期 2024-01-01，版本分组 2024 0101 123，订单 2024-0101-1234'
  const r = redactText(input)
  assert.equal(r.text, input)
  assert.deepEqual(r.stats, ZERO_STATS)
})

ok('15 位空窗分组（生日段非法、非老身份证）：保持原样', () => {
  // 15 位落入 MERGEABLE_WIDTHS，但生日段 19 年 45 月不合法，不应被改写
  const input = '编号 11010 11945 07851 存档'
  const r = redactText(input)
  assert.equal(r.text, input)
  assert.deepEqual(r.stats, ZERO_STATS)
})

console.log('privacy 分组识别：命中规则仍须打码')

ok('分组手机号：空格与连字符两种写法都打码且计数各一次', () => {
  const spaced = redactText('电话 138 1234 5678 备用')
  assert.equal(spaced.stats.phone, 1)
  assert.ok(spaced.text.includes('138****5678'))
  const hyphened = redactText('电话 138-1234-5678 备用')
  assert.equal(hyphened.stats.phone, 1)
  assert.ok(hyphened.text.includes('138****5678'))
})

ok('分组 18 位身份证：归一化后按身份证打码', () => {
  const r = redactText('证件 110101 19900307 8515')
  assert.equal(r.stats.idCard, 1)
  assert.equal(r.stats.bankCard, 0)
  assert.ok(r.text.includes('110101********8515'))
})

ok('分组 16 位银行卡：归一化后按银行卡打码', () => {
  const r = redactText('卡号 6222 0202 0000 1234')
  assert.equal(r.stats.bankCard, 1)
  assert.ok(r.text.includes('6222 **** **** 1234'))
})

ok('分组 18 位银行卡（生日段非法 → 不误判身份证）：按银行卡打码', () => {
  const r = redactText('卡号 622202 020000 123456')
  assert.equal(r.stats.idCard, 0)
  assert.equal(r.stats.bankCard, 1)
  assert.ok(r.text.includes('6222 **** **** 3456'))
})

console.log('privacy 边界：+86 与统计')

ok('+86 边界：连写与单空格前缀都打码，前缀随号码保留', () => {
  const joined = redactText('+8613812345678')
  assert.equal(joined.stats.phone, 1)
  assert.ok(joined.text.includes('+86138****5678'))
  const spaced = redactText('+86 13812345678')
  assert.equal(spaced.stats.phone, 1)
  assert.ok(spaced.text.includes('+86 138****5678'))
})

ok('+86 加分组内部分隔（+86 138 1234 5678）：不粘合成 13 位长串泄露，保持原样', () => {
  // 设计边界：13 位落在位宽空窗区，归一化不得把它粘成不可匹配的长串
  const input = '+86 138 1234 5678'
  const r = redactText(input)
  assert.equal(r.text, input)
  assert.equal(r.stats.phone, 0)
})

ok('混合命中：分组手机 + 分组银行卡各计一次，未命中片段原样保留', () => {
  const r = redactText('日期 2024-01-01，电话 138 1234 5678，卡 6222 0202 0000 1234')
  assert.deepEqual(r.stats, { phone: 1, email: 0, idCard: 0, bankCard: 1, ipv4: 0, secret: 0 })
  assert.ok(r.text.includes('日期 2024-01-01，'))
  assert.ok(r.text.includes('138****5678'))
  assert.ok(r.text.includes('6222 **** **** 1234'))
  assert.ok(!r.text.includes('13812345678'))
  assert.ok(!r.text.includes('6222020200001234'))
})

ok('同一号码只计一次：打码后不被后续规则二次命中', () => {
  const r = redactText('138 1234 5678')
  assert.deepEqual(r.stats, { phone: 1, email: 0, idCard: 0, bankCard: 0, ipv4: 0, secret: 0 })
})

console.log(`\n全部通过：${passed} 项断言`)
