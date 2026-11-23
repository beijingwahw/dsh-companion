/**
 * 官方定价抓取的 fail-closed 完整性回归测试（驱动 lib/ 编译产物，ESM）。
 *
 * 全部网络交互由可控的 mock fetch 与可读流提供，不发起真实请求。覆盖：
 *
 * 1. fetchText 响应大小上限：content-length 超限即拒、流式累计超限即拒、
 *    部分数据绝不返回；无限流被超时截停；连接中途断开（截断）抛错；
 * 2. HTML 错误页 / 纯 JS 空页 / 截断页（模型数骤减）不会替换既有有效价格表；
 * 3. 缺字段（输出价行丢失）的条目整条丢弃，绝不按 0 元计价；
 * 4. NaN / Infinity / 负数 / 离谱偏大价格被 sanitizeLiveTable 与各解析器丢弃；
 * 5. 厂商表（refreshVendor）同样 fail-closed，失败沿用上一份实时表/内置目录；
 * 6. 日志不回带 URL、响应头或响应体内容（金丝雀串不外泄）。
 */
import assert from 'node:assert/strict'
import {
  BUILTIN_SHEET,
  MAX_PRICING_RESPONSE_BYTES,
  PriceService,
  fetchText,
} from '../lib/core/price/service.js'
import { MAX_PLAUSIBLE_PRICE, sanitizeLiveTable } from '../lib/core/price/scrapers.js'

// AbortSignal.timeout 的计时器在 Node 中是 unref 的：测试进程若无其他句柄，
// 事件循环会在 60ms 超时触发前枯竭退出。保活句柄在套件结束前清除。
const keepAlive = setInterval(() => {}, 60_000)

let passed = 0
async function ok(label, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 收集式日志，用于断言内容与失败语义。 */
function captureLog() {
  const messages = []
  const record = (level) => (...args) => messages.push(`${level}: ${args.map(String).join(' ')}`)
  return { messages, log: { warn: record('warn'), info: record('info'), error: record('error') } }
}

/** 以给定 URL → 响应映射替换全局 fetch（返回恢复函数）。 */
function mockFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
  return () => {
    globalThis.fetch = original
  }
}

function textResponse(text, init = {}) {
  return new Response(text, { status: 200, ...init })
}

/** 分块可控流响应：按计划投递 chunk，最后 close 或 error。 */
function streamResponse(chunks, { closeError = null, headers = {} } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      if (closeError !== null) controller.error(closeError)
      else controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

/** 永不结束的流（无限响应）：模拟 undici 行为，fetch 中止信号使体流出错。 */
function neverEndingResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<table>'))
      // 既不 close 也不 error：模拟无限/挂起响应，直到超时信号中止。
      signal?.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')))
    },
  })
  return new Response(stream, { status: 200 })
}

/** DeepSeek 风格列布局定价页：表头为模型 id，行为价格类型。 */
function deepseekPage(models, { omitOutputRow = false, outputPrice = 8 } = {}) {
  const header = models.map((m) => `<th>${m}</th>`).join('')
  const cells = (price) => models.map(() => `<td>${price}</td>`).join('')
  return `<html><body><table>
<tr><th>模型</th>${header}</tr>
<tr><td>输入价格（缓存命中）</td>${cells('0.5元')}</tr>
<tr><td>输入价格（缓存未命中）</td>${cells('2元')}</tr>
${omitOutputRow ? '' : `<tr><td>输出价格</td>${cells(`${outputPrice}元`)}</tr>`}
</table></body></html>`
}

/** 通用行布局厂商定价页（qwen 前缀）。 */
function qwenPage(models) {
  const rows = models
    .map((m) => `<tr><td>${m}</td><td>1元/百万tokens</td><td>4元/百万tokens</td></tr>`)
    .join('')
  return `<html><body><table>
<tr><th>模型</th><th>输入价格</th><th>输出价格</th></tr>
${rows}
</table></body></html>`
}

const CANARY = 'SECRET-CANARY-9f3a7c'

// ── 1. fetchText：大小上限 / 超时 / 截断 ──────────────────────────────

await ok('fetchText：正常响应返回完整文本', async () => {
  const restore = mockFetch(() => textResponse('<html>ok</html>'))
  try {
    assert.equal(await fetchText('https://example.invalid/pricing', 1000), '<html>ok</html>')
  } finally {
    restore()
  }
})

await ok('fetchText：content-length 超限即拒绝（不返回任何内容）', async () => {
  const restore = mockFetch(() =>
    // 体本身很小：拒绝依据必须是声明长度，而非实际读取量。
    textResponse('tiny', { headers: { 'content-length': String(MAX_PRICING_RESPONSE_BYTES + 1) } }),
  )
  try {
    await assert.rejects(fetchText('https://example.invalid/big', 1000), /exceeds \d+ bytes/)
  } finally {
    restore()
  }
})

await ok('fetchText：流式累计超限即拒绝，部分数据不返回', async () => {
  const chunk = 'x'.repeat(512)
  const restore = mockFetch(() => streamResponse([chunk, chunk, chunk]))
  try {
    await assert.rejects(fetchText('https://example.invalid/stream', 1000, {}, 1024), /exceeds 1024 bytes/)
  } finally {
    restore()
  }
})

await ok('fetchText：无限/挂起响应被超时截停', async () => {
  const restore = mockFetch((url, init) => neverEndingResponse(init?.signal))
  try {
    await assert.rejects(fetchText('https://example.invalid/hang', 60))
  } finally {
    restore()
  }
})

await ok('fetchText：连接中途断开（截断流）抛错而非返回半截文本', async () => {
  const restore = mockFetch(() => streamResponse(['<table><tr><td>deepseek-chat'], { closeError: new Error('boom') }))
  try {
    await assert.rejects(fetchText('https://example.invalid/cut', 1000))
  } finally {
    restore()
  }
})

await ok('fetchText：HTTP 错误状态拒绝且错误不含 URL', async () => {
  const restore = mockFetch(() => new Response('error page', { status: 500 }))
  try {
    await assert.rejects(fetchText('https://example.invalid/500?token=abc', 1000), (error) => {
      assert.match(String(error), /HTTP 500/)
      assert.ok(!String(error).includes('token=abc'), '错误信息不得回带 URL')
      return true
    })
  } finally {
    restore()
  }
})

// ── 2. 数值合理性：sanitizeLiveTable / 解析器 ─────────────────────────

await ok('sanitizeLiveTable：丢弃 NaN/Infinity/负数/离谱值/缺字段，保留合理与免费条目', async () => {
  const cleaned = sanitizeLiveTable({
    ok: { inputCacheHit: 0.5, inputMiss: 2, output: 8 },
    free: { inputCacheHit: 0, inputMiss: 0, output: 0 },
    nan: { inputCacheHit: 0, inputMiss: Number.NaN, output: 1 },
    inf: { inputCacheHit: 0, inputMiss: 1, output: Number.POSITIVE_INFINITY },
    neg: { inputCacheHit: 0, inputMiss: -1, output: 1 },
    absurd: { inputCacheHit: 0, inputMiss: MAX_PLAUSIBLE_PRICE + 1, output: 1 },
    missing: { inputCacheHit: 0, inputMiss: 1 },
  })
  assert.deepEqual(Object.keys(cleaned).sort(), ['free', 'ok'])
  assert.deepEqual(cleaned.ok, { inputCacheHit: 0.5, inputMiss: 2, output: 8 })
})

await ok('sanitizeLiveTable：非对象输入安全返回空表', async () => {
  assert.deepEqual(sanitizeLiveTable(null), {})
  assert.deepEqual(sanitizeLiveTable([]), {})
})

// ── 3. refresh()：错误页 / 截断页 / 离谱价 fail-closed ────────────────

await ok('refresh：HTML 错误页（200 但无价格表）保留内置表并告警', async () => {
  const { messages, log } = captureLog()
  const restore = mockFetch(() => textResponse(`<html><body><h1>502 Bad Gateway</h1><!-- ${CANARY} --></body></html>`))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    assert.equal(service.currentSheet.source, 'builtin')
    assert.equal(service.currentSheet, BUILTIN_SHEET)
    assert.ok(messages.some((m) => m.startsWith('warn:')), '应有失败告警')
    assert.ok(!messages.join('\n').includes(CANARY), '日志不得回带响应体内容')
  } finally {
    restore()
  }
})

await ok('refresh：有效页采纳实时价；随后截断页（模型数骤减）保留上一份实时表', async () => {
  const { log } = captureLog()
  const full = deepseekPage(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'])
  const truncated = deepseekPage(['deepseek-chat'])
  let page = full
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    assert.equal(service.currentSheet.source, 'live')
    assert.equal(service.resolve('deepseek-reasoner', Date.now()).inputMiss, 2)
    page = truncated
    await service.refresh()
    // 4 → 1 模型触发截断防线：上一份完整实时表原样保留。
    assert.equal(Object.keys(service.currentSheet.current).length, 4)
    assert.equal(service.resolve('deepseek-reasoner', Date.now()).inputMiss, 2)
  } finally {
    restore()
  }
})

await ok('refresh：唯一模型的输出价行缺失（截断）→ 整张表拒绝，保留内置', async () => {
  const { log } = captureLog()
  const restore = mockFetch(() => textResponse(deepseekPage(['deepseek-chat'], { omitOutputRow: true })))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    assert.equal(service.currentSheet.source, 'builtin')
  } finally {
    restore()
  }
})

await ok('refresh：部分模型缺输出价 → 该模型条目丢弃而非按 0 元计价', async () => {
  const { log } = captureLog()
  // 三模型页：reasoner 的输出单元格为 "-"（缺字段），chat 与 v4-flash 完整。
  const page = `<html><body><table>
<tr><th>模型</th><th>deepseek-chat</th><th>deepseek-reasoner</th><th>deepseek-v4-flash</th></tr>
<tr><td>输入价格（缓存命中）</td><td>0.5元</td><td>0.5元</td><td>0.5元</td></tr>
<tr><td>输入价格（缓存未命中）</td><td>2元</td><td>4元</td><td>1元</td></tr>
<tr><td>输出价格</td><td>8元</td><td>-</td><td>2元</td></tr>
</table></body></html>`
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    assert.equal(service.currentSheet.source, 'live')
    assert.equal(service.currentSheet.current['deepseek-reasoner'], undefined)
    // reasoner 回落到内置目录价，而不是被计成输出 0 元。
    const resolved = service.resolve('deepseek-reasoner', Date.now())
    assert.ok(resolved === undefined || resolved.output > 0)
    // chat 完整条目正常生效。
    assert.equal(service.currentSheet.current['deepseek-chat'].output, 8)
  } finally {
    restore()
  }
})

await ok('refresh：离谱价格（¥999999/百万）条目被丢弃，合法兄弟条目保留', async () => {
  const { log } = captureLog()
  const page = `<html><body><table>
<tr><th>模型</th><th>deepseek-chat</th><th>deepseek-reasoner</th></tr>
<tr><td>输入价格（缓存命中）</td><td>0.5元</td><td>0.5元</td></tr>
<tr><td>输入价格（缓存未命中）</td><td>2元</td><td>999999元</td></tr>
<tr><td>输出价格</td><td>8元</td><td>12元</td></tr>
</table></body></html>`
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    assert.equal(service.currentSheet.current['deepseek-chat'].inputMiss, 2)
    assert.equal(service.currentSheet.current['deepseek-reasoner'], undefined)
  } finally {
    restore()
  }
})

await ok('refresh：溢出为 Infinity 的超大数字价格不生效', async () => {
  const { log } = captureLog()
  const huge = '9'.repeat(400)
  const page = `<html><body><table>
<tr><th>模型</th><th>deepseek-chat</th></tr>
<tr><td>输入价格（缓存命中）</td><td>0.5元</td></tr>
<tr><td>输入价格（缓存未命中）</td><td>${huge}元</td></tr>
<tr><td>输出价格</td><td>8元</td></tr>
</table></body></html>`
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refresh()
    // 输入价非法 → 唯一条目残缺 → 整表拒绝，保留内置。
    assert.equal(service.currentSheet.source, 'builtin')
  } finally {
    restore()
  }
})

// ── 4. refreshVendor：错误页与截断页沿用既有实时表 ────────────────────

await ok('refreshVendor：有效页导入新模型；截断页沿用上一份实时表', async () => {
  const { log } = captureLog()
  const models = ['qwen-alpha', 'qwen-beta', 'qwen-gamma', 'qwen-delta']
  let page = qwenPage(models)
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refreshVendor('qwen')
    assert.equal(service.resolve('qwen-gamma', Date.now()).output, 4)
    page = qwenPage(['qwen-alpha'])
    await service.refreshVendor('qwen')
    // 4 → 1 模型触发截断防线：上一份完整厂商表保留。
    assert.equal(service.resolve('qwen-gamma', Date.now()).output, 4)
  } finally {
    restore()
  }
})

await ok('refreshVendor：HTML 错误页 → 空表告警并回落内置目录', async () => {
  const { messages, log } = captureLog()
  const restore = mockFetch(() => textResponse(`<html><body><h1>503</h1><!-- ${CANARY} --></body></html>`))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refreshVendor('qwen')
    assert.ok(messages.some((m) => m.includes('未解析出价格表')))
    assert.ok(!messages.join('\n').includes(CANARY), '日志不得回带响应体内容')
    // 无实时表时回落内置目录价（qwen3 系列在目录中）。
    const vendor = service.vendorPricing(Date.now()).find((v) => v.id === 'qwen')
    assert.equal(vendor.source, 'builtin')
  } finally {
    restore()
  }
})

await ok('refreshVendor：离谱价格条目被清洗后再比较，空结果沿用现有价格', async () => {
  const { log } = captureLog()
  const page = `<html><body><table>
<tr><th>模型</th><th>输入价格</th><th>输出价格</th></tr>
<tr><td>qwen-evil</td><td>1元/百万tokens</td><td>9999999元/百万tokens</td></tr>
</table></body></html>`
  const restore = mockFetch(() => textResponse(page))
  const service = new PriceService('https://example.invalid/pricing', 1000, log)
  try {
    await service.refreshVendor('qwen')
    const vendor = service.vendorPricing(Date.now()).find((v) => v.id === 'qwen')
    assert.equal(vendor.source, 'builtin')
    assert.equal(vendor.models['qwen-evil'], undefined)
  } finally {
    restore()
  }
})

clearInterval(keepAlive)
console.log(`全部通过：${passed} 项断言`)
