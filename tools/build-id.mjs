#!/usr/bin/env node
// tools/build-id.mjs —— 「单一源」指纹（BUILD-ID）：生成 / 校验 / 打印。
//
// 目的：把「活树只有这一份」从文档宣告变成机制。随包分发 tools/BUILD-ID.json，
// profile 门禁（tools/check-bundle.mjs）与 verify 第 17 项都拿它当唯一真相。
// 它防的是「profile 指向分叉旧树 / 改错树」，不是防「文件被编辑」。
//
// 指纹规则（check-bundle / integration-smoke 共用本文件的同一实现，别各写一份）：
//   1) 递归全树；跳过任意层级的目录 node_modules / .git；
//   2) 跳过生成物自身 tools/BUILD-ID.json —— 它的内容里就写着树上所有文件的 hash，
//      把它算进去会形成自引用不动点（--update 后 --check 必红）；因此 fileCount 也不含它；
//   3) 相对路径统一用 '/' 分隔，按路径的 UTF-16 码元序排序（locale 无关，保证 Node 22/24
//      与不同 ICU 版本算出同一个指纹）；
//   4) 逐文件 sha256（小写 hex）；
//   5) 全树指纹 = 流式 sha256：按排序顺序依次 update( utf8(相对路径) + "\0" + sha256hex(文件) + "\n" )；
//   6) buildId = treeSha256 的前 16 位。
//
// 用法：
//   node tools/build-id.mjs           同 --check（verify 就是这么调；无参数时 fail-closed）
//   node tools/build-id.mjs --check   校验 tools/BUILD-ID.json 与当前活树一致；不一致 exit 1，并打印两边实际值
//   node tools/build-id.mjs --update  显式刷新 tools/BUILD-ID.json（generatedAt 会变）
//   node tools/build-id.mjs --print   只打印当前活树的 fileCount / treeSha256 / buildId（不读不写文件）
//
// 刷新流程（写死在脚本里，别靠记忆）：
//   · 日常编辑**不要求**刷新；--check 红了先看是不是活树自上次 --update 以来真的有改动。
//   · **打包前必须** `node tools/build-id.mjs --update`（在活树根跑），然后再跑
//     `node tools/build-id.mjs --check` + `node tools/verify.mjs`，最后才打 zip。
//   · 因为 --update 会改 generatedAt=BULD-ID.json 内容 → 活树指纹随之变化的外在表现是
//     「清单/对比」都要在 --update **之后**做，别先出清单再 update 再比（会假红）。
//   · 双 Node 验收：本文件只用 node:crypto / node:fs，排序与 JSON 输出与 Node 版本无关。
//
// 边界：--check 只证明「活树 vs 记录」一致，不证明「包 vs 活树」逐文件一致；
// 后者靠 verify + 打包后的 zip 对照（见 CHANGELOG 的验收读数）。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF_REL = 'tools/BUILD-ID.json'
const EXCLUDE_DIRS = new Set(['node_modules', '.git'])

const asPosix = (p) => String(p).split(sep).join('/')
/** 码元序比较（不依赖 locale / ICU），保证双 Node 结果一致。 */
const cmpCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function walk(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(root, full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
    // 符号链接/其它类型：不跟随（包内不应出现；出现也不参与指纹，保持确定性）
  }
}

/**
 * 计算活树指纹（规则见文件头）。
 * @param {string} root 树根（默认本包根）
 * @returns {{root:string,fileCount:number,treeSha256:string,buildId:string,files:{rel:string,sha256:string}[]}}
 */
export function computeTreeFingerprint(root = ROOT) {
  const abs = resolve(root)
  const collected = []
  walk(abs, abs, collected)
  const files = collected
    .map((full) => ({ rel: asPosix(relative(abs, full)), full }))
    .filter((e) => e.rel !== SELF_REL)
    .sort((a, b) => cmpCodeUnit(a.rel, b.rel))
    .map((e) => ({ rel: e.rel, sha256: createHash('sha256').update(readFileSync(e.full)).digest('hex') }))

  const stream = createHash('sha256')
  for (const f of files) stream.update(`${f.rel}\0${f.sha256}\n`)
  const treeSha256 = stream.digest('hex')
  return { root: abs, fileCount: files.length, treeSha256, buildId: treeSha256.slice(0, 16), files }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 校验 tools/BUILD-ID.json 与当前树自洽（版本 / fileCount / treeSha256 / buildId / generatedAt）。
 * 不抛异常，返回结构化结果，便于 verify 与 check-bundle 复用。
 */
export function verifyBuildId(root = ROOT) {
  const abs = resolve(root)
  const recordPath = join(abs, 'tools', 'BUILD-ID.json')
  const pkg = readJsonFile(join(abs, 'package.json'))
  const actual = computeTreeFingerprint(abs)
  const problems = []
  let record = null
  if (!existsSync(recordPath)) {
    problems.push(`缺少 ${recordPath}（运行 node tools/build-id.mjs --update 生成）`)
  } else {
    record = readJsonFile(recordPath)
    if (!record) {
      problems.push(`${recordPath} 不是合法 JSON`)
    } else {
      if (record.buildId !== actual.buildId) {
        problems.push(`buildId 不一致：记录 ${record.buildId}（${recordPath}），实际 ${actual.buildId}（${actual.fileCount} 个文件）`)
      }
      if (record.treeSha256 !== actual.treeSha256) {
        problems.push(`treeSha256 不一致：记录 ${record.treeSha256}，实际 ${actual.treeSha256}`)
      }
      if (record.fileCount !== actual.fileCount) {
        problems.push(`fileCount 不一致：记录 ${record.fileCount}，实际 ${actual.fileCount}`)
      }
      if (pkg && record.version !== pkg.version) {
        problems.push(`version 不一致：记录 ${record.version}，package.json ${pkg.version}`)
      }
      if (record.buildId !== String(record.treeSha256).slice(0, 16)) {
        problems.push('BUILD-ID.json 自身不自洽：buildId 必须等于 treeSha256 的前 16 位')
      }
      if (!record.generatedAt || Number.isNaN(Date.parse(record.generatedAt))) {
        problems.push(`generatedAt 不合法：${JSON.stringify(record.generatedAt)}`)
      }
    }
  }
  return { ok: problems.length === 0, problems, record, actual, recordPath, pkg }
}

/** 生成记录并写盘（--update）。返回写盘前后的记录。 */
export function writeBuildId(root = ROOT) {
  const abs = resolve(root)
  const recordPath = join(abs, 'tools', 'BUILD-ID.json')
  const pkg = readJsonFile(join(abs, 'package.json'))
  const prev = existsSync(recordPath) ? readJsonFile(recordPath) : null
  const fp = computeTreeFingerprint(abs)
  const record = {
    version: pkg && pkg.version ? String(pkg.version) : '0.0.0',
    buildId: fp.buildId,
    generatedAt: new Date().toISOString(),
    fileCount: fp.fileCount,
    treeSha256: fp.treeSha256,
  }
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return { prev, record, fileCount: fp.fileCount }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isMain) {
  const args = process.argv.slice(2)
  const known = new Set(['--check', '--update', '--print'])
  const picked = args.filter((a) => known.has(a))
  if (args.some((a) => !known.has(a)) || picked.length > 1) {
    console.error('usage: node tools/build-id.mjs [--check | --update | --print]')
    process.exit(2)
  }
  const mode = picked.length ? picked[0] : '--check'

  if (mode === '--print') {
    const fp = computeTreeFingerprint(ROOT)
    console.log('BUILD-ID 指纹（只打印，不读不写 tools/BUILD-ID.json）')
    console.log(`  root       : ${ROOT}`)
    console.log(`  fileCount  : ${fp.fileCount}`)
    console.log(`  treeSha256 : ${fp.treeSha256}`)
    console.log(`  buildId    : ${fp.buildId}`)
  } else if (mode === '--update') {
    const { prev, record, fileCount } = writeBuildId(ROOT)
    console.log('BUILD-ID 已刷新（--update）')
    console.log(`  root       : ${ROOT}`)
    console.log(`  version    : ${record.version}（来自 package.json）`)
    console.log(`  fileCount  : ${fileCount}（不含 node_modules / .git / tools/BUILD-ID.json 自身）`)
    console.log(`  treeSha256 : ${record.treeSha256}`)
    console.log(`  buildId    : ${record.buildId}`)
    console.log(`  generatedAt: ${record.generatedAt}`)
    if (prev && prev.buildId !== record.buildId) {
      console.log(`  buildId 变化 : ${prev.buildId} → ${record.buildId}（活树内容确有改动）`)
    } else if (prev) {
      console.log(`  buildId 未变 : ${prev.buildId}（只有 generatedAt 变了）`)
    }
  } else {
    const r = verifyBuildId(ROOT)
    console.log('BUILD-ID 校验（tools/BUILD-ID.json ↔ 活树全量指纹）')
    console.log(`  root       : ${ROOT}`)
    console.log('  排除项     : 目录 node_modules / .git（任意层级）· 生成物 tools/BUILD-ID.json 自身（防自引用）')
    console.log('  排序/规则  : 相对路径码元序 · path\\0sha256(file)\\n 流式 sha256 · buildId = treeSha256[:16]')
    if (r.record) {
      console.log(`  记录       : version ${r.record.version} · buildId ${r.record.buildId} · fileCount ${r.record.fileCount} · generatedAt ${r.record.generatedAt}`)
      console.log(`  记录 treeSha256 : ${r.record.treeSha256}`)
    } else {
      console.log('  记录       : （无）')
    }
    console.log(`  实际       : version ${r.pkg ? r.pkg.version : '?'} · buildId ${r.actual.buildId} · fileCount ${r.actual.fileCount}`)
    console.log(`  实际 treeSha256 : ${r.actual.treeSha256}`)
    if (r.ok) {
      console.log('PASS  BUILD-ID 与活树一致（单一源自洽）')
    } else {
      for (const p of r.problems) console.log(`FAIL  ${p}`)
      console.log('提示：若改动是预期的，在活树根跑 node tools/build-id.mjs --update 刷新（打包前必须）。')
    }
    process.exit(r.ok ? 0 : 1)
  }
}
