#!/usr/bin/env node
/**
 * tools/audit-report.mjs — 三引擎审计体检（**只读**，不改任何文件）
 *
 * 用途：把"审计统一"这件事变成一条可验证的命令 —— 落地后跑一次，
 * 三份审计在哪儿、有多少行、链有没有断，一眼看完。
 *
 * 三份审计（Q7 审计统一，2026-11-08）：
 *   pixel   ~/.dsh/click-matrix/audit.jsonl                    历史主链（hash 链 v2，最强，位置没动）
 *   control <数据目录>/audit/control.jsonl                     自己的 seq/prev/h 链（从 %TEMP% 搬来）
 *   stroke  <数据目录>/audit/stroke.jsonl                      最小审计：每次调用一行（新增）
 *   <数据目录> = DSH_HANDS_DATA_DIR || ~/.dsh/dsh-desktop-hands
 *
 * 校验方式：
 *   pixel   逐行 sha256(JSON.stringify(row 去掉 h)) 与 h 比对 + prev 链；
 *   control control/src/policy.js 的 verifyAudit()（就是它自己写链用的那份逻辑）；
 *   stroke  逐行 JSON.parse + 必需字段 + seq 单调（它本来就没有 hash 链）。
 *
 * 退出码：0 = 没有 FAIL（missing 只算 WARN，因为"还没调用过"不等于坏）；
 *         1 = 有文件存在但校验失败（断链/坏 JSON/字段缺失）。
 *
 * 用法：node tools/audit-report.mjs          人读表
 *       node tools/audit-report.mjs --json   机器读（一行 JSON）
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')

const DATA_DIR = process.env.DSH_HANDS_DATA_DIR || join(homedir(), '.dsh', 'dsh-desktop-hands')
const PIXEL_FILE = join(homedir(), '.dsh', 'click-matrix', 'audit.jsonl')
const CONTROL_FILE = join(DATA_DIR, 'audit', 'control.jsonl')
const STROKE_FILE = join(DATA_DIR, 'audit', 'stroke.jsonl')
const LEGACY_CONTROL_FILE = join(process.env.TEMP || process.env.TMP || join(homedir(), 'AppData', 'Local', 'Temp'), 'dsh-x2', 'audit.jsonl')

function hashRow(row) {
  const copy = { ...row }
  delete copy.h
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex')
}

/** pixel：hash 链校验（复刻 engines/pixel/lib/audit.js 的 hashRow/verifyChainText，只读） */
function verifyPixelChain(file) {
  const out = { ok: false, lines: 0, checked: 0, legacy: 0, broken: null, head: '' }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    out.broken = { line: 0, reason: 'unreadable', detail: String(error && error.message ? error.message : error) }
    return out
  }
  let head = ''
  let anchored = false
  let prevRow = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      return { ...out, lines: out.lines + 1, broken: { line: i + 1, reason: 'bad-json' } }
    }
    out.lines++
    if (typeof row.h !== 'string' || typeof row.prev !== 'string') {
      out.legacy++
      continue
    }
    if (!anchored) {
      anchored = true
      head = row.prev
    }
    if (row.prev !== head) {
      const forked = prevRow != null && (row.seq === prevRow.seq || row.prev === prevRow.prev)
      return { ...out, broken: { line: i + 1, reason: forked ? 'concurrent-writer' : 'chain-break' } }
    }
    if (hashRow(row) !== row.h) {
      return { ...out, broken: { line: i + 1, reason: 'hash-mismatch' } }
    }
    head = row.h
    prevRow = row
    out.checked++
    out.head = head
  }
  out.ok = true
  return out
}

/** control：直接用它自己的 verifyAudit()（同一份逻辑，不复制） */
async function verifyControl(file) {
  try {
    const pol = await import(pathToFileURL(join(ROOT, 'engines', 'control', 'src', 'policy.js')).href)
    if (pol.auditPath() !== file) {
      // 环境变量被改过：按实际路径对比没有意义，直接对文件内容走一遍逐行解析。
      return { ok: false, lines: countLines(file), broken: { reason: 'path-mismatch', detail: `policy.auditPath()=${pol.auditPath()}` } }
    }
    const broken = pol.verifyAudit()
    return { ok: broken === null, lines: countLines(file), broken }
  } catch (error) {
    return { ok: false, lines: 0, broken: { reason: 'verify-error', detail: String(error && error.message ? error.message : error) } }
  }
}

/** stroke：逐行 JSON.parse + 必需字段 + seq 单调 */
async function verifyStroke(file) {
  try {
    const sa = await import(pathToFileURL(join(ROOT, 'engines', 'stroke', 'audit.js')).href)
    const { rows, badLines } = sa.readAudit(file)
    if (badLines.length) return { ok: false, lines: rows.length + badLines.length, broken: { reason: 'bad-json', line: badLines[0] } }
    let prev = 0
    for (const [i, row] of rows.entries()) {
      if (row.engine !== 'stroke') return { ok: false, lines: rows.length, broken: { reason: 'bad-engine', line: i + 1 } }
      if (!['ok', 'denied', 'error'].includes(row.decision)) return { ok: false, lines: rows.length, broken: { reason: 'bad-decision', line: i + 1 } }
      if (!Number.isFinite(row.seq) || row.seq <= prev) return { ok: false, lines: rows.length, broken: { reason: 'seq', line: i + 1 } }
      prev = row.seq
    }
    return { ok: true, lines: rows.length, broken: null }
  } catch (error) {
    return { ok: false, lines: 0, broken: { reason: 'verify-error', detail: String(error && error.message ? error.message : error) } }
  }
}

function countLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

function info(file) {
  if (!existsSync(file)) return { exists: false, bytes: 0, mtime: '' }
  const st = statSync(file)
  return { exists: true, bytes: st.size, mtime: st.mtime.toISOString() }
}

const rows = []
let failed = 0

function detailOf(exists, v, okText) {
  if (!exists) return '还没写过（工具没被调用过）'
  return v.broken ? JSON.stringify(v.broken) : okText
}

// pixel
{
  const i = info(PIXEL_FILE)
  let v = { ok: false, lines: 0, broken: null }
  if (i.exists) v = verifyPixelChain(PIXEL_FILE)
  if (i.exists && !v.ok) failed++
  rows.push({ engine: 'pixel', role: '历史主链（hash 链 v2）', file: PIXEL_FILE, ...i, lines: v.lines, ok: v.ok, detail: detailOf(i.exists, v, `chain ok${v.legacy ? `（legacy ${v.legacy} 行）` : ''} 链头 ${String(v.head || '').slice(0, 12)}…`) })
}

// control
{
  const i = info(CONTROL_FILE)
  let v = { ok: false, lines: 0, broken: null }
  if (i.exists) v = await verifyControl(CONTROL_FILE)
  if (i.exists && !v.ok) failed++
  rows.push({ engine: 'control', role: 'seq/prev/h 链（从 %TEMP% 搬来）', file: CONTROL_FILE, ...i, lines: v.lines, ok: v.ok, detail: detailOf(i.exists, v, 'verifyAudit() = null（无断点）') })
}

// stroke
{
  const i = info(STROKE_FILE)
  let v = { ok: false, lines: 0, broken: null }
  if (i.exists) v = await verifyStroke(STROKE_FILE)
  if (i.exists && !v.ok) failed++
  rows.push({ engine: 'stroke', role: '最小审计（每次调用一行）', file: STROKE_FILE, ...i, lines: v.lines, ok: v.ok, detail: detailOf(i.exists, v, 'JSONL ok / seq 单调 / 字段完整') })
}

const legacy = info(LEGACY_CONTROL_FILE)
const summary = {
  dataDir: DATA_DIR,
  checkedAt: new Date().toISOString(),
  failed,
  engines: rows.map((r) => ({ engine: r.engine, file: r.file, exists: r.exists, lines: r.lines, ok: r.ok, detail: r.detail })),
  legacy: { file: LEGACY_CONTROL_FILE, exists: legacy.exists, bytes: legacy.bytes, note: '旧位置：只读保留，不删不迁移（新审计已写到统一目录）' },
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary))
} else {
  console.log(`三引擎审计体检（数据目录: ${DATA_DIR}）`)
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`${pad('引擎', 8)}${pad('行数', 6)}${pad('状态', 6)}文件`)
  for (const r of rows) {
    const state = !r.exists ? 'WARN' : r.ok ? 'OK' : 'FAIL'
    console.log(`${pad(r.engine, 8)}${pad(r.exists ? r.lines : '-', 6)}${pad(state, 6)}${r.file}`)
    console.log(`${' '.repeat(20)}· ${r.role}；${r.detail}`)
  }
  console.log('')
  console.log(`旧位置 %TEMP%\\dsh-x2\\audit.jsonl：${legacy.exists ? `存在（${legacy.bytes} B），只读保留，不删` : '不存在'}`)
  console.log(failed ? `\n结论：${failed} 份审计校验失败（见上）` : '\n结论：没有 FAIL（WARN = 对应引擎还没被调用过）')
}
process.exit(failed === 0 ? 0 : 1)
