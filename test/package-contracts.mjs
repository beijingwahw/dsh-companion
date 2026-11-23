/**
 * 发布产物契约测试（驱动已构建的 lib/，需先执行 pnpm build）。
 * 覆盖：lib/client 下每个相对 .module.css import 对应的文件必须存在；
 * package.json 与 dsh.plugin.json files 必须包含 CSS glob，三处版本号一致；
 * npm pack --dry-run --json 的 tarball 清单必须包含全部 CSS 资产，且不含源码 / source map / 密钥
 * 等意外敏感文件。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')

assert.ok(
  existsSync(join(libDir, 'index.js')),
  '未找到已构建的 lib/，请先执行 pnpm build 再运行本测试',
)

let passed = 0
function ok(label, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${label}`)
}

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

console.log('lib/client：.module.css import 可解析')

// 编译产物形如：import styles from './X.module.css';
const cssImportPattern = /(?:from|import)\s*['"](\.[^'"]*\.module\.css)['"]/g
const clientJsFiles = [...walk(join(libDir, 'client'))].filter((p) => p.endsWith('.js'))
assert.ok(clientJsFiles.length > 0, 'lib/client 下未找到任何 JS 文件')

let importCount = 0
for (const jsFile of clientJsFiles) {
  const source = readFileSync(jsFile, 'utf8')
  for (const match of source.matchAll(cssImportPattern)) {
    importCount += 1
    const target = resolve(dirname(jsFile), match[1])
    ok(`存在：${target.slice(root.length + 1)}（被 ${jsFile.slice(root.length + 1)} 引用）`, () => {
      assert.ok(existsSync(target), `缺失 CSS 资产：${target}（被 ${jsFile} 引用）`)
    })
  }
}
assert.ok(importCount > 0, 'lib/client 下未找到任何 .module.css import')

console.log('package.json：files 覆盖 CSS 资产')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
ok('files 包含 lib/**/*.css', () => {
  assert.ok(
    pkg.files.some((pattern) => pattern.replace(/\\/g, '/').includes('.css')),
    `package.json files 缺少 CSS glob：${JSON.stringify(pkg.files)}`,
  )
})

const plugin = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
ok('dsh.plugin.json files 包含 lib/**/*.css', () => {
  assert.ok(
    plugin.files.some((pattern) => pattern.replace(/\\/g, '/').includes('.css')),
    `dsh.plugin.json files 缺少 CSS glob：${JSON.stringify(plugin.files)}`,
  )
})
ok('package / plugin / manifest 版本一致', () => {
  assert.equal(pkg.version, plugin.version)
  assert.equal(pkg.version, manifest.version)
})

console.log('npm pack --dry-run：tarball 内容契约')

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
assert.equal(pack.status, 0, `npm pack --dry-run 失败：${pack.stderr}`)
const packResult = JSON.parse(pack.stdout)
const tarballFiles = packResult[0].files.map((f) => f.path.split(sep).join('/'))

ok('tarball 包含全部已构建 CSS 资产', () => {
  const cssFiles = [...walk(libDir)]
    .filter((p) => p.endsWith('.css'))
    .map((p) => p.slice(root.length + 1).split(sep).join('/'))
  assert.ok(cssFiles.length > 0, 'lib/ 下未找到任何 CSS 资产')
  for (const css of cssFiles) {
    assert.ok(tarballFiles.includes(css), `tarball 缺失：${css}`)
  }
})

ok('tarball 不含源码目录', () => {
  assert.ok(!tarballFiles.some((p) => p.startsWith('src/')), 'tarball 不应包含 src/')
})

ok('tarball 不含 source map', () => {
  assert.ok(!tarballFiles.some((p) => p.endsWith('.map')), 'tarball 不应包含 *.map')
})

ok('tarball 不含密钥 / 环境文件等敏感内容', () => {
  const sensitive = /(^|\/)(\.env(\.|$)|.*\.(pem|key|p12|pfx)$|id_rsa|\.npmrc$|\.pnpmrc$)/i
  assert.ok(
    !tarballFiles.some((p) => sensitive.test(p)),
    `tarball 含敏感文件：${tarballFiles.filter((p) => sensitive.test(p)).join(', ')}`,
  )
})

console.log(`\n全部通过：${passed} 项断言`)
