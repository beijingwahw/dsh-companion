/**
 * 统一测试入口：顺序执行 test/ 下全部套件（每个 *.mjs 一个子进程），
 * 汇总通过/失败并给出退出码，供 `pnpm test` 与 CI 使用。
 * 约定：套件文件自我报告断言数（stdout 末行「全部通过：N 项断言」），
 * 运行器只信任子进程退出码，并尽力提取断言数用于汇总。
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

const suites = readdirSync(dir)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs' && !f.startsWith('_'))
  .map((f) => join(dir, f))
  .sort()

if (suites.length === 0) {
  console.error('test: 未发现任何套件文件')
  process.exit(1)
}

const results = []
for (const suite of suites) {
  const name = suite.slice(dir.length + 1)
  process.stdout.write(`▶ ${name}\n`)
  const run = spawnSync(process.execPath, [suite], { encoding: 'utf8' })
  if (run.status === 0) {
    const asserted = /全部通过：(\d+) 项断言/.exec(run.stdout)
    results.push({ name, ok: true, assertions: asserted ? Number(asserted[1]) : null })
    process.stdout.write(run.stdout)
  } else {
    results.push({ name, ok: false, assertions: null })
    process.stdout.write(run.stdout ?? '')
    process.stderr.write(run.stderr ?? '')
    process.stderr.write(`✗ ${name} 退出码 ${run.status ?? 'signal ' + run.signal}\n`)
  }
}

const failed = results.filter((r) => !r.ok)
const totalAssertions = results.reduce((sum, r) => sum + (r.assertions ?? 0), 0)
console.log('—'.repeat(50))
for (const r of results) {
  const count = r.assertions === null ? '' : `（${r.assertions} 项断言）`
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${count}`)
}
console.log(
  `共 ${results.length} 套件：${results.length - failed.length} 通过 / ${failed.length} 失败` +
    (totalAssertions > 0 ? `，累计 ${totalAssertions} 项断言` : ''),
)
process.exit(failed.length > 0 ? 1 : 0)
