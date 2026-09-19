/**
 * 核心原语冒烟测试（模块 A–D 依赖的底层工具，驱动 lib/ 编译产物）。
 * 覆盖：privacy（脱敏规则 + 分组归一化 + 顺序防误判）、crypto（AES-256-GCM
 * 往返 + 篡改检测）、zip（STORE 打包结构 + 文件名清理）、pdf（Latin-1 判定
 * + 文档结构）、time（北京时间键 + 峰谷边界 + 跨午夜窗口）、transcript
 * （日志派生 + 内容压平 + 格式化）、pricing（金额舍入 + 用量形状换算）。
 */
import assert from 'node:assert/strict'
import { redactText, hasRedactions } from '../lib/core/privacy.js'
import {
  encryptAes256Gcm,
  decryptAes256Gcm,
  generateMasterKey,
} from '../lib/core/crypto.js'
import { buildZip, sanitizeFileName } from '../lib/core/zip.js'
import { isLatin1Safe, buildSimplePdf } from '../lib/core/pdf.js'
import {
  beijingDayKey,
  beijingMonthKey,
  formatBeijingTime,
  isPeakTime,
  nextOffPeakStart,
} from '../lib/core/time.js'
import {
  transcriptFromLog,
  extractContentText,
  formatTranscript,
} from '../lib/core/transcript.js'
import { round4, tokenUsageToUsageLike } from '../lib/core/pricing.js'

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

console.log('privacy：隐私脱敏（手机 / 邮箱 / 身份证 / 银行卡）')

ok('手机号：11 位保留前 3 后 4', () => {
  const r = redactText('联系我 13812345678 谢谢')
  assert.equal(r.stats.phone, 1)
  assert.ok(r.text.includes('138****5678'))
})

ok('手机号：空格分组书写先归一化再打码', () => {
  const r = redactText('138 1234 5678')
  assert.equal(r.stats.phone, 1)
  assert.ok(r.text.includes('138****5678'))
})

ok('手机号：+86 前缀随号码保留', () => {
  const r = redactText('+8613812345678')
  assert.equal(r.stats.phone, 1)
  assert.ok(r.text.includes('+86138****5678'))
})

ok('邮箱：本地部分仅保留首字符', () => {
  const r = redactText('发到 alice.wu@example.com 吧')
  assert.equal(r.stats.email, 1)
  assert.ok(r.text.includes('a***@example.com'))
})

ok('身份证：18 位（生日段合法）保留前 6 后 4', () => {
  const r = redactText('110101199003078515')
  assert.equal(r.stats.idCard, 1)
  assert.ok(r.text.includes('110101********8515'))
})

ok('银行卡：16 位保留前 4 后 4 分组打码', () => {
  const r = redactText('卡号 6222020200001234')
  assert.equal(r.stats.bankCard, 1)
  assert.ok(r.text.includes('6222 **** **** 1234'))
})

ok('混合文本：一次调用全部命中且计数准确', () => {
  const r = redactText('13812345678 / bob@test.io / 110101199003078515')
  assert.deepEqual(r.stats, { phone: 1, email: 1, idCard: 1, bankCard: 0, ipv4: 0, secret: 0 })
  assert.ok(hasRedactions(r.stats))
  assert.ok(!r.text.includes('13812345678'))
  assert.ok(!r.text.includes('bob@test.io'))
  assert.ok(!r.text.includes('110101199003078515'))
})

ok('无误报：13 位订单号（位宽空窗区）不打码', () => {
  const r = redactText('订单号 2024010112345 已创建')
  assert.deepEqual(r.stats, { phone: 0, email: 0, idCard: 0, bankCard: 0, ipv4: 0, secret: 0 })
  assert.ok(!hasRedactions(r.stats))
  assert.ok(r.text.includes('2024010112345'))
})

console.log('crypto：AES-256-GCM 载荷与认证')

ok('加密往返：载荷 v1 前缀，解密还原明文', () => {
  const key = generateMasterKey()
  const payload = encryptAes256Gcm('sk-test-秘钥-123', key)
  assert.ok(payload.startsWith('v1.'))
  assert.equal(decryptAes256Gcm(payload, key), 'sk-test-秘钥-123')
})

ok('随机 IV：同明文两次加密产生不同密文', () => {
  const key = generateMasterKey()
  assert.notEqual(encryptAes256Gcm('same', key), encryptAes256Gcm('same', key))
})

ok('篡改检测：改动密文后认证失败', () => {
  const key = generateMasterKey()
  const payload = encryptAes256Gcm('secret', key)
  const [version, iv, tag, cipherText] = payload.split('.')
  const flipped = cipherText.endsWith('A') ? cipherText.slice(0, -1) + 'B' : cipherText.slice(0, -1) + 'A'
  assert.throws(() => decryptAes256Gcm([version, iv, tag, flipped].join('.'), key))
})

ok('错误密钥：认证标签校验失败', () => {
  const payload = encryptAes256Gcm('secret', generateMasterKey())
  assert.throws(() => decryptAes256Gcm(payload, generateMasterKey()))
})

ok('格式与密钥长度守卫：非载荷与 16 字节密钥均抛错', () => {
  assert.throws(() => decryptAes256Gcm('garbage', generateMasterKey()))
  assert.throws(() => encryptAes256Gcm('x', new Uint8Array(16)))
})

console.log('zip：零依赖 STORE 打包')

ok('单条目结构：PK 头 + EOCD 尾 + 计数', () => {
  const bytes = buildZip([{ name: 'a.md', data: new TextEncoder().encode('# hi') }])
  assert.equal(bytes[0], 0x50)
  assert.equal(bytes[1], 0x4b)
  assert.equal(bytes[2], 0x03)
  // EOCD 签名 PK\x05\x06 位于尾部 22 字节
  const eocd = bytes.length - 22
  assert.equal(bytes[eocd], 0x50)
  assert.equal(bytes[eocd + 1], 0x4b)
  assert.equal(bytes[eocd + 2], 0x05)
  assert.equal(bytes[eocd + 3], 0x06)
  // 本卷/全卷条目数（EOCD 偏移 +8/+10，16 位 LE）
  assert.equal(bytes[eocd + 10] | (bytes[eocd + 11] << 8), 1)
})

ok('多条目：EOCD 计数随条目数增长', () => {
  const bytes = buildZip([
    { name: 'a.md', data: new Uint8Array(1) },
    { name: 'b.md', data: new Uint8Array(2) },
    { name: 'c.md', data: new Uint8Array(3) },
  ])
  const eocd = bytes.length - 22
  assert.equal(bytes[eocd + 10] | (bytes[eocd + 11] << 8), 3)
})

ok('文件名清理：目录穿越被中和，空名兜底，中文名保留', () => {
  const cleaned = sanitizeFileName('../../etc/passwd')
  assert.ok(!cleaned.includes('/'))
  assert.ok(!/^[.]/.test(cleaned))
  assert.equal(sanitizeFileName(''), 'untitled')
  assert.equal(sanitizeFileName('会话-导出.md'), '会话-导出.md')
})

console.log('pdf：Latin-1 判定与文档结构')

ok('isLatin1Safe：ASCII 安全，CJK 与 C1 控制区不安全', () => {
  assert.ok(isLatin1Safe('plain text 123'))
  assert.ok(!isLatin1Safe('包含中文'))
  assert.ok(!isLatin1Safe('control\u0085char'))
})

ok('buildSimplePdf：PDF 头 + Helvetica 字体 + EOF 尾', () => {
  const bytes = buildSimplePdf('Report', ['line one', 'line two'])
  const text = new TextDecoder().decode(bytes)
  assert.ok(text.startsWith('%PDF-1.4'))
  assert.ok(text.includes('/Helvetica'))
  assert.ok(text.includes('(line one) Tj'))
  assert.ok(text.trimEnd().endsWith('%%EOF'))
})

console.log('time：北京时间与峰谷窗口')

ok('北京时间分量与键：UTC 0 点 = 北京 8 点', () => {
  assert.equal(formatBeijingTime(0), '1970-01-01 08:00:00')
  assert.equal(beijingDayKey(0), '1970-01-01')
  assert.equal(beijingMonthKey(0), '1970-01')
})

ok('峰谷边界：9:00 含 / 12:00 不含 / 13:00 空闲 / 10:00 高峰', () => {
  const at = (beijingHour, beijingMinute = 0) => (beijingHour * 60 + beijingMinute) * 60_000 - 8 * 3600_000
  assert.ok(isPeakTime(at(10)))
  assert.ok(isPeakTime(at(9)))
  assert.ok(!isPeakTime(at(12)))
  assert.ok(!isPeakTime(at(13)))
  assert.ok(isPeakTime(at(14)))
  assert.ok(!isPeakTime(at(18)))
})

ok('跨午夜窗口：22:00-06:00 环绕判定', () => {
  const night = [{ startHour: 22, startMinute: 0, endHour: 6, endMinute: 0 }]
  const at = (h, m = 0) => (h * 60 + m) * 60_000 - 8 * 3600_000
  assert.ok(isPeakTime(at(23), night))
  assert.ok(isPeakTime(at(5, 59), night))
  assert.ok(!isPeakTime(at(6), night))
  assert.ok(!isPeakTime(at(12), night))
})

ok('nextOffPeakStart：从 10:00 出发恰好在 12:00 落入空闲', () => {
  const ts = 10 * 3600_000 - 8 * 3600_000
  const next = nextOffPeakStart(ts)
  assert.equal(formatBeijingTime(next), '1970-01-01 12:00:00')
  assert.ok(!isPeakTime(next))
})

console.log('transcript：日志派生与格式化')

ok('transcriptFromLog：提取双角色事件并按 seq 稳定排序', () => {
  const turns = transcriptFromLog({
    events: [
      { type: 'assistant/message', data: { message: { content: 'hello' } }, time: 2, seq: 2 },
      { type: 'user/message', data: { content: 'hi' }, time: 1, seq: 1 },
      { type: 'other/event', data: {}, time: 3, seq: 3 },
    ],
  })
  assert.deepEqual(
    turns.map((t) => [t.role, t.text]),
    [
      ['user', 'hi'],
      ['assistant', 'hello'],
    ],
  )
})

ok('extractContentText：字符串直通 / 内容块压平 / 工具占位', () => {
  assert.equal(extractContentText('plain'), 'plain')
  assert.equal(
    extractContentText([
      { type: 'text', text: 'a' },
      { type: 'tool_use', name: 'bash' },
      { type: 'tool_result' },
      { type: 'unknown' },
    ]),
    'a\n[工具调用：bash]\n[工具结果]',
  )
  assert.equal(extractContentText(42), '')
})

ok('formatTranscript：说话人标签 + 时间戳开关', () => {
  const turns = [
    { role: 'user', text: 'q', time: 0, seq: 1 },
    { role: 'assistant', text: 'a', time: 0, seq: 2 },
  ]
  const withStamps = formatTranscript(turns, { timestamps: true })
  assert.ok(withStamps.includes('### 用户（1970-01-01 08:00:00）'))
  assert.ok(withStamps.includes('### 助手'))
  const bare = formatTranscript(turns, { timestamps: false })
  assert.ok(!bare.includes('（'))
})

console.log('pricing：金额舍入与用量形状')

ok('round4：四位小数舍入', () => {
  assert.equal(round4(2 / 3), 0.6667)
  assert.equal(round4(0.123449), 0.1234)
  assert.equal(round4(1), 1)
})

ok('tokenUsageToUsageLike：命中部分拆为折扣价通道', () => {
  assert.deepEqual(
    tokenUsageToUsageLike({ promptTokens: 100, completionTokens: 50, promptCacheHitTokens: 30 }),
    { inputTokens: 70, outputTokens: 50, cacheReadTokens: 30 },
  )
})

ok('tokenUsageToUsageLike：命中数超过输入时钳制到 0', () => {
  assert.deepEqual(
    tokenUsageToUsageLike({ promptTokens: 100, completionTokens: 10, promptCacheHitTokens: 120 }),
    { inputTokens: 0, outputTokens: 10, cacheReadTokens: 100 },
  )
})

console.log(`\n全部通过：${passed} 项断言`)
