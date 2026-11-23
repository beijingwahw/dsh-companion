/**
 * 构建后资产复制：把 src/ 下所有非 TS 运行资产（至少全部 .module.css）
 * 按相对路径原样复制到 lib/，确保编译产物中的 `import './X.module.css'`
 * 在发布 tarball 中可解析。
 * 约定：纯 Node ESM，无平台专属命令；遍历顺序按名称排序，结果确定性；
 * 只读 src、只写 lib，绝不把 lib 自身递归复制进去。
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

// 防御：输出目录不得位于 src 之内（否则可能把已复制的资产二次复制）。
if (outDir === srcDir || outDir.startsWith(srcDir + sep)) {
  console.error(`copy-assets: 输出目录 ${outDir} 不能位于 ${srcDir} 之内`)
  process.exit(1)
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

const isTypeScript = (path) => path.endsWith('.ts') || path.endsWith('.tsx')

let copied = 0
for (const file of walk(srcDir)) {
  if (isTypeScript(file)) continue
  const rel = relative(srcDir, file)
  const dest = join(outDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(file, dest)
  copied += 1
  console.log(`  ${rel}`)
}
console.log(`copy-assets：${copied} 个资产文件已复制到 lib/`)
