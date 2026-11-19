#!/usr/bin/env node
// 生成"活树清单"：逐文件 sha256，用于验收后防漂移。
// 用法：node tools/make-tree-manifest.mjs <树根> <输出文件> [--exclude=node_modules]
// 口径：递归全部普通文件，路径排序（稳定、可复现），输出 `<sha256> *./<相对路径>`，与 sha256sum -c 兼容。
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'

const [root, out, ...flags] = process.argv.slice(2)
if (!root || !out) {
  console.error('usage: node tools/make-tree-manifest.mjs <root> <out.sha256> [--exclude=node_modules]')
  process.exit(2)
}
const excludes = flags.filter((f) => f.startsWith('--exclude=')).map((f) => f.slice('--exclude='.length))
const skip = (p) => excludes.some((e) => p.split(sep).includes(e))

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (!skip(full)) walk(full)
    } else if (st.isFile()) {
      files.push(full)
    }
  }
}
walk(root)
files.sort((a, b) => relative(root, a).localeCompare(relative(root, b), 'en'))

const lines = []
for (const f of files) {
  const h = createHash('sha256').update(readFileSync(f)).digest('hex')
  lines.push(`${h} *./${relative(root, f).split(sep).join('/')}`)
}
writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(`写出 ${lines.length} 个文件 → ${out}`)
