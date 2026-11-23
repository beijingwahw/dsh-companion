/** 存储域发布契约：源码实际访问的字面量表必须全部在适配层声明。 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_TABLE_NAMES } from '../lib/core/storage-adapter.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

ok('六张认知、学习与主动状态表均已进入真实 DomainSpec 清单', () => {
  for (const name of [
    'knowledge-episodes',
    'knowledge-intentions',
    'knowledge-review',
    'knowledge-rhythm',
    'retrieval-ranker',
    'proactive-insights',
  ]) {
    assert.ok(ALL_TABLE_NAMES.includes(name), `缺少表声明：${name}`)
  }
})

ok('全部源码字面量 table 访问都有声明，禁止运行时 no table 回归', () => {
  const declared = new Set(ALL_TABLE_NAMES)
  const used = new Set()
  const pattern = /\.table(?:<[^()]*?>)?\(\s*['"]([a-z0-9-]+)['"]/g
  for (const file of sourceFiles(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) used.add(match[1])
  }
  assert.ok(used.size >= 15, `静态扫描异常，仅发现 ${used.size} 张表`)
  const missing = [...used].filter((name) => !declared.has(name)).sort()
  assert.deepEqual(missing, [], `未声明表：${missing.join(', ')}`)
})

ok('主动状态表不承担正文索引职责，表清单无重复项', () => {
  assert.equal(new Set(ALL_TABLE_NAMES).size, ALL_TABLE_NAMES.length)
  assert.ok(ALL_TABLE_NAMES.includes('proactive-insights'))
  assert.ok(ALL_TABLE_NAMES.includes('tags'))
})

console.log(`\n全部通过：${passed} 项断言`)
