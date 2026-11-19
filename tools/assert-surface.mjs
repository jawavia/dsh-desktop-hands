#!/usr/bin/env node
/**
 * tools/assert-surface.mjs — dsh-desktop-hands 工具面「fail-closed」断言（P1 门槛）
 *
 * 背景：现状是「少一个工具完全静默」——
 *   - engines/pixel/lib/doctor.js 的「工具清单」那行无条件 PASS；
 *   - tools/check-bundle.mjs 里 23/6/5 只是打印不判；
 *   - engines/pixel/index.js 的注册是逐个 try/catch + logWarn，缺工具没人知道。
 * 本脚本把「工具面」变成可判红的硬断言：缺一个工具 = exit 1，不是 WARN。
 *
 * 用法：
 *   node tools/assert-surface.mjs                 在活树里跑（默认 root = 本文件上一级）
 *   node tools/assert-surface.mjs --root <dir>    对另一棵树跑（--selftest 内部用）
 *   node tools/assert-surface.mjs --measure       附完整测量表（阈值调参/交接用）
 *   node tools/assert-surface.mjs --json          附机器可读指标（JSON 一行）
 *   node tools/assert-surface.mjs --allow-extra   允许出现名单外的新工具（只 INFO，不判红）
 *   node tools/assert-surface.mjs --no-baseline   跳过 H 快照 diff
 *   node tools/assert-surface.mjs --baseline <p>  指定 baseline.json 路径
 *   node tools/assert-surface.mjs --selftest      反向自检：临时副本里删掉 mouse_batch → 必须 exit 1
 *   node tools/assert-surface.mjs --help
 *
 * 断言语义（A–H）：
 *   A. per-engine allowlist：默认合并态 25 个**注册**真名一个不能少（源码仍声明 35 = 25 + pixel 旧 10）；
 *      出现未知名 FAIL（--allow-extra 时只 INFO）
 *   B. 注册工具总数 = 14 + 6 + 5 = 25（源码声明 24 + 6 + 5 = 35，pixel 旧 10 个默认不注册）
 *   C. description 字符上限：每工具 / 每引擎 / 全局（阈值见 THRESHOLDS 注释）。
 *      **合并工具豁免只作用于屏幕它自己**：非合并工具仍是 450 字符 / 引擎与全局合计仍是
 *      P1 旧上限（3400·1650·500 / 5500），合并工具（mergedToolExempt）单独一档 + 单独额度。
 *   D. top-level 参数个数上限（非合并工具 24；合并工具 28）
 *   E. schema 字节上限：单工具 ≤ 16,000 B（deep-ptc-mode 硬预算）+ 全局总预算
 *   F. 文档引用名一致性：SKILL.md 与常驻安全段里出现的工具名必须 ⊆ 25 个注册真名；
 *      旧 10 个若还被**当工具名**引用就判红 → 去改文档引用，不许改断言（screen_view 的
 *      action 值 `wait_window` 不是工具名，扫描前单独剥离，见 scanReferencedNames）
 *   G. 注册失败探测：三个引擎的注册点必须是「逐个 try/catch + logWarn」形态，
 *      并报出「源码里声明 N 个 / 期望 N 个」
 *   H. 可选 schema 快照 diff：baseline.json 存在则逐工具比字节/描述/参数个数，漂移超阈值 FAIL；
 *      **H2 逐工具基线钉死**：非合并工具的 descChars / topLevelParams 相对基线只许持平或下降
 *
 * 铁律：只读源码（自带的极简 JS 词法/字面量解析器），不 import 三个引擎、不加载插件、
 * 不调用任何工具、不写活树任何现有文件。--selftest 只在系统临时目录的副本里动手。
 *
 * 退出码：0 = 全部 PASS（SKIP 不算红）；1 = 有 FAIL。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const DEFAULT_ROOT = resolve(dirname(SCRIPT_FILE), '..')

// ---------------------------------------------------------------------------
// 0. 期望名单（默认合并态 mergeReadSide=true 的 25 个**注册**真名，必须完全一致）
// ---------------------------------------------------------------------------
//
// I2-A（2026-11-08，用户拍板 A）：默认态 = 合并态。
//   pixel 源码仍声明 24 个（14 个默认注册 + 10 个旧工具，显式 mergeReadSide:false 才注册），
//   所以这里拆成三张表：
//     PIXEL_NAMES        = 默认注册的 14 个（doctor.js 默认态期望也是这 14 个；
//                          运行时 __buildToolDefinitions(state) 的注册清单已反核，见 P4）
//     PIXEL_LEGACY_NAMES = 旧 10 个：源码必须继续声明（回退路径），默认不注册；
//                          与 engines/pixel/lib/doctor.js 的 READ_SIDE_LEGACY_TOOLS +
//                          WINDOW_SIDE_LEGACY_TOOLS 逐字一致（P4 段会再对一次）
//     PIXEL_SOURCE_NAMES = 24 个源码声明名（A/G 段按它对静态解析结果做 allowlist）
const PIXEL_NAMES = [
  'audit_tail', 'click_matrix_doctor', 'clipboard_get', 'clipboard_set', 'matrix_overlay',
  'mouse_abort', 'mouse_batch', 'mouse_click', 'mouse_drag', 'mouse_move', 'mouse_scroll',
  'press_keys', 'screen_view', 'type_text',
]

const PIXEL_LEGACY_NAMES = [
  // READ_SIDE_LEGACY_TOOLS（doctor.js）：旧 7 个读工具
  'screen_capture', 'screen_info', 'screen_locate', 'screen_read',
  'screen_text', 'screen_wait', 'screen_zoom',
  // WINDOW_SIDE_LEGACY_TOOLS（doctor.js）：旧 3 个窗口工具
  'wait_window', 'window_focus', 'window_list',
]

const PIXEL_SOURCE_NAMES = [...PIXEL_NAMES, ...PIXEL_LEGACY_NAMES] // 源码声明 24 个

const CONTROL_NAMES = [
  'screen_look', 'screen_uia', 'screen_act', 'screen_sequence', 'screen_focus', 'screen_windows',
]

const STROKE_NAMES = ['stroke_arm', 'stroke_draw', 'stroke_status', 'stroke_stop', 'stroke_diag']

const ENGINES = [
  {
    id: 'pixel',
    title: 'click-matrix',
    source: 'engines/pixel/index.js',
    names: PIXEL_NAMES, // 默认注册的 14 个
    sourceNames: PIXEL_SOURCE_NAMES, // 源码必须声明的 24 个（含回退用旧 10 个）
    legacyNames: PIXEL_LEGACY_NAMES, // 默认不注册、但源码必须还在的旧 10 个
    style: 'call-define', // define(name, desc, parameters, execute)
    builder: 'buildToolDefinitions',
    registration: {
      file: 'engines/pixel/index.js',
      iterable: 'toolDefs',
      shape: 'for (const def of toolDefs) { try { tools.register(...) } catch { logWarn(...) } }',
    },
  },
  {
    id: 'control',
    title: 'dsh-x2',
    source: 'engines/control/src/tools.js',
    names: CONTROL_NAMES,
    style: 'define-tool', // defineTool({ name, description, parameters, ... })
    builder: 'createTools',
    registration: {
      file: 'engines/control/src/index.js',
      iterable: 'createTools',
      shape: 'for (const tool of createTools(...)) { try { ctx.tools.register(tool) } catch { ctx.logger?.warn?.(...) } }',
    },
  },
  {
    id: 'stroke',
    title: 'dsh-stroke',
    source: 'engines/stroke/index.js',
    names: STROKE_NAMES,
    style: 'call-add', // add(name, desc, parameters, execute)
    builder: 'buildToolDefinitions',
    registration: {
      file: 'engines/stroke/index.js',
      iterable: 'defs',
      shape: 'for (const def of defs) { try { tools.register(def) } catch { log(...) } }',
    },
  },
]

const EXPECTED_TOTAL = PIXEL_NAMES.length + CONTROL_NAMES.length + STROKE_NAMES.length // 25（14 + 6 + 5；默认合并态）
const ALL_NAMES = [...PIXEL_NAMES, ...CONTROL_NAMES, ...STROKE_NAMES]
const ALL_NAME_SET = new Set(ALL_NAMES)

// F 用的「疑似旧名/文档里出现过但未注册的名字」——**只影响 FAIL 文案分类**，
// 不参与放行/拦截判定（真正的判定是 ⊆ 25 个注册真名，见 assertF）。
// 来源：本仓 engines/*/CHANGELOG.md 与 README 里出现、但当前 25 个注册真名里没有的 token；
// I2-A：默认合并态下 pixel 旧 10 个已退役（源码仍声明），一并归入这张「旧名」表。
const LEGACY_NAME_HINTS = new Set([
  ...PIXEL_LEGACY_NAMES,
  'double_click', 'right_click', 'mouse_event', 'process_tree', 'retry_hotkeys', 'stroke_dryrun',
])

// ---------------------------------------------------------------------------
// 1. 阈值（全部 fail-closed；每条阈值的来源写在注释里）
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  // 合并工具豁免名单（v0.9.5 / P4）：
  // 只有「把多个旧工具合并成一个」的工具允许更大的描述/参数面，且**逐个点名**，
  // 绝不靠抬高全局阈值 —— 否则其余 24 个非合并工具会跟着被放宽（Lead 2026-11-08 要求）。
  mergedToolExempt: new Set(['screen_view']),
  // C. 单工具 description 字符数（**非豁免工具**，与 P1 原始值一致，不放宽）：
  //   实测全局最长 378（control screen_sequence）；定 450 = 实测最长 + 约 19% 余量。
  descCharsPerTool: 450,
  // C. 合并工具的单工具 description 上限：screen_view 现在是「7 读 + 3 窗口 = 10 action」入口，
  //   实测 358 字符（2026-11-08 P6 后）；600 = 实测 + 约 68% 余量。**只对它生效**；
  //   再长就该拆工具/砍文案（7 条 action 对照表已经在 SKILL.md 里，描述只留索引）。
  descCharsPerMergedTool: 600,
  // C. 每引擎 description 合计：**非合并工具**仍然用 P1 的旧上限（不放宽）。
  //   合并工具的额度单独加（见 mergedDescCharsAllowance），所以这里不抬高。
  descCharsPerEngine: { pixel: 3400, control: 1650, stroke: 500 },
  // C. 全局 description 合计：**非合并工具**仍然用 P1 的旧上限 5500（不放宽）。
  descCharsTotal: 5500,
  // C. 合并工具在「合计」里允许额外占用的额度（按引擎给出，常量、不随实测漂移）。
  //   = screen_view 实测 descChars（358，2026-11-08 P6 后：7 读 + 3 窗口）。涨了就超额度 → FAIL。
  mergedDescCharsAllowance: { pixel: 358, control: 0, stroke: 0 },
  // D. 单工具 top-level 参数个数（**非豁免工具**，与 P1 原始值一致，不放宽）。
  //   依据：P1 实测最大 23（screen_act）；定 24 = 现最大 + 1。
  topParamsPerTool: 24,
  // D. 合并工具的 top-level 参数上限：screen_view = 7 个读工具 + 3 个窗口工具参数面的并集
  //   = 32 个（flat schema，按 action 取用；2026-11-08 P6 后实测 32）。**就定在 32，没有余量**：
  //   再加参数必须先拆工具或收进嵌套对象。
  topParamsPerMergedTool: 32,
  // E. 单工具 schema 字节数。deep-ptc-mode 的硬预算 16,000 B，不能放宽。
  schemaBytesPerTool: 16000,
  // E. 全局 schema 字节合计。依据：实测 26,418 B，定 40,000 ≈ +51% 余量（合并后仍要
  // 留得下新增工具，但任何单工具的 16,000 B 硬卡不放宽）。
  schemaBytesTotal: 40000,
  // H. baseline 漂移阈值：schema 字节 > max(400B, 15%) 判漂移。
  baselineSchemaDriftBytes: 400,
  baselineSchemaDriftRatio: 0.15,
  // H. description 字符漂移 > 60 判漂移（阈值改动的信号，不是描述越好越长的借口）。
  baselineDescDriftChars: 60,
}

// SKILL.md 与常驻安全段必须存在（F 的输入）
const PIXEL_SKILL_DOC = 'engines/pixel/skills/click-matrix/SKILL.md'

// baseline 默认候选路径（H）。按顺序取第一个存在的。
// 全部**相对树根**解析：包内 `tools/baseline.json` 随包分发是首位，换机器/换目录都能跑 H 段。
// （2026-11-08 清理：删掉写死 `D:/DEEPSEEKworkplace/...` 的绝对路径候选——换机后必然不存在，
//   只会让 --help/INFO 里出现一条误导性的死路径。）
const BASELINE_CANDIDATES = [
  'tools/baseline.json',
  '_merge/P0/baseline.json',
  '../_merge/P0/baseline.json',
  join(process.cwd(), '_merge/P0/baseline.json'),
]

// ---------------------------------------------------------------------------
// 2. 输出框架
// ---------------------------------------------------------------------------

const results = [] // { section, ok, msg, detail? }
const infoLines = []
let currentSection = ''

function section(letter, title) {
  currentSection = letter
  console.log('')
  console.log(`${letter}. ${title}`)
}

function pass(msg) {
  results.push({ section: currentSection, ok: true, msg })
  console.log(`  PASS  ${msg}`)
}

function fail(msg, detail) {
  results.push({ section: currentSection, ok: false, msg })
  console.log(`  FAIL  ${msg}`)
  if (detail) console.log(String(detail).split('\n').map((l) => `        ${l}`).join('\n'))
}

function info(msg) {
  infoLines.push(`[${currentSection}] ${msg}`)
  console.log(`  INFO  ${msg}`)
}

function skip(msg) {
  console.log(`  SKIP  ${msg}`)
  infoLines.push(`[SKIP] ${msg}`)
}

// ---------------------------------------------------------------------------
// 3. 极简 JS 词法分析器
//    只需要「结构」正确：字符串 / 模板串（含 ${} 嵌套）/ 正则 / 注释 / 括号。
//    不执行任何代码，也不 import 引擎。
// ---------------------------------------------------------------------------

class SurfaceParseError extends Error {}

function isPunct(tok, value) {
  return Boolean(tok && tok.type === 'punct' && tok.value === value)
}

const BRACKET_CLOSE = { '(': ')', '[': ']', '{': '}' }

/** 从 tokens[i]（必须是 ( [ {）找到配对的闭括号 token 下标。 */
function matchBracket(tokens, i) {
  const t = tokens[i]
  if (!t || t.type !== 'punct' || !BRACKET_CLOSE[t.value]) {
    throw new SurfaceParseError(`matchBracket 期望括号，实际是 ${t ? JSON.stringify(t.value) : 'EOF'}`)
  }
  const open = t.value
  const close = BRACKET_CLOSE[open]
  let depth = 0
  for (let j = i; j < tokens.length; j++) {
    const u = tokens[j]
    if (u.type !== 'punct') continue
    if (u.value === open) depth += 1
    else if (u.value === close) {
      depth -= 1
      if (depth === 0) return j
    }
  }
  throw new SurfaceParseError(`括号未配平（第 ${t.line} 行附近）`)
}

function readEscape(src, j) {
  const n = src[j + 1]
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', "'": "'", '"': '"', '`': '`', '\\': '\\' }
  if (n === '\n') return { value: '', end: j + 2 } // 续行
  if (n === 'u') {
    if (src[j + 2] === '{') {
      const end = src.indexOf('}', j + 3)
      if (end < 0) throw new SurfaceParseError('\\u{...} 未闭合')
      return { value: String.fromCodePoint(parseInt(src.slice(j + 3, end), 16)), end: end + 1 }
    }
    const hex = src.slice(j + 2, j + 6)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SurfaceParseError(`\\u 转义非法：${hex}`)
    return { value: String.fromCharCode(parseInt(hex, 16)), end: j + 6 }
  }
  if (n === 'x') {
    const hex = src.slice(j + 2, j + 4)
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new SurfaceParseError(`\\x 转义非法：${hex}`)
    return { value: String.fromCharCode(parseInt(hex, 16)), end: j + 4 }
  }
  return { value: Object.prototype.hasOwnProperty.call(simple, n) ? simple[n] : n, end: j + 2 }
}

/** 读 ' 或 " 字符串 */
function readQuote(src, i) {
  const q = src[i]
  let out = ''
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      const r = readEscape(src, j)
      out += r.value
      j = r.end
      continue
    }
    if (c === q) return { type: 'string', value: out, start: i, end: j + 1 }
    if (c === '\n') throw new SurfaceParseError('字符串未闭合（跨行）')
    out += c
    j += 1
  }
  throw new SurfaceParseError('字符串未闭合（到文件尾）')
}

/** 跳过 ${ ... } 表达式，返回配对的 } 之后的位置 */
function skipTemplateExpr(src, i) {
  let depth = 1
  let j = i
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (c === "'" || c === '"') { j = readQuote(src, j).end; continue }
    if (c === '`') { j = readTemplate(src, j).end; continue }
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j += 1; continue }
    if (c === '/' && src[j + 1] === '*') {
      const k = src.indexOf('*/', j + 2)
      j = k < 0 ? src.length : k + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  throw new SurfaceParseError('模板字符串 ${...} 未闭合')
}

function readTemplate(src, i) {
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') return { type: 'template', value: src.slice(i + 1, j), start: i, end: j + 1 }
    if (c === '$' && src[j + 1] === '{') { j = skipTemplateExpr(src, j + 2); continue }
    j += 1
  }
  throw new SurfaceParseError('模板字符串未闭合')
}

/** 上一个有意义 token 决定 / 是正则还是除号 */
function regexAllowedAfter(tok) {
  if (!tok) return true
  if (tok.type === 'punct') return ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^', '<', '>'].includes(tok.value)
  if (tok.type === 'ident') {
    return ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'new', 'do', 'else', 'yield', 'await', 'throw', 'instanceof'].includes(tok.value)
  }
  return false
}

function readRegex(src, i) {
  let j = i + 1
  let inClass = false
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (c === '\n') break
    if (inClass) {
      if (c === ']') inClass = false
      j += 1
      continue
    }
    if (c === '[') { inClass = true; j += 1; continue }
    if (c === '/') {
      j += 1
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1
      return { type: 'regex', value: src.slice(i, j), start: i, end: j }
    }
    j += 1
  }
  // 不是正则（可能只是除号），退回单字符 token
  return null
}

function lex(src) {
  const tokens = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const k = src.indexOf('*/', i + 2)
      i = k < 0 ? n : k + 2
      continue
    }
    if (c === "'" || c === '"') {
      const t = readQuote(src, i)
      tokens.push(t)
      i = t.end
      continue
    }
    if (c === '`') {
      const t = readTemplate(src, i)
      tokens.push(t)
      i = t.end
      continue
    }
    if (c === '/' && regexAllowedAfter(tokens[tokens.length - 1])) {
      const t = readRegex(src, i)
      if (t) { tokens.push(t); i = t.end; continue }
    }
    if (/[0-9]/.test(c)) {
      const m = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i))
      if (!m) throw new SurfaceParseError(`数字解析失败（偏移 ${i}）`)
      tokens.push({ type: 'number', value: m[0], start: i, end: i + m[0].length })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
      tokens.push({ type: 'ident', value: m[0], start: i, end: i + m[0].length })
      i += m[0].length
      continue
    }
    tokens.push({ type: 'punct', value: c, start: i, end: i + 1 })
    i += 1
  }
  // 补行号（用于报错定位）
  let line = 1
  let pos = 0
  for (const t of tokens) {
    for (let k = pos; k < t.start; k += 1) if (src[k] === '\n') line += 1
    t.line = line
    for (let k = t.start; k < t.end; k += 1) if (src[k] === '\n') line += 1
    pos = t.end
  }
  return tokens
}

// ---------------------------------------------------------------------------
// 4. 字面量求值（只支持：对象 / 数组 / 字符串 / 数字 / true / false / null / 正负号）
//    引擎里的 parameters、description 都是纯字面量，够用；遇到不支持的形态就报错（fail-closed）。
// ---------------------------------------------------------------------------

function parseValue(tokens, i) {
  const t = tokens[i]
  if (!t) throw new SurfaceParseError('字面量解析：意外的文件结尾')
  if (t.type === 'string') return { value: t.value, next: i + 1 }
  if (t.type === 'number') return { value: Number(t.value), next: i + 1 }
  if (t.type === 'template') {
    // 模板串里的 ${expr} 会在运行期才定值（例如 config 里的默认值）。
    // 这里保留原文（含 ${expr}）作为**保守上界**：表达式文本通常比它代入后的值长，
    // 所以量出来的字符/字节只会偏高，不会偏低（fail-closed 方向是对的）。
    return { value: t.value, next: i + 1 }
  }
  if (t.type === 'ident') {
    if (t.value === 'true') return { value: true, next: i + 1 }
    if (t.value === 'false') return { value: false, next: i + 1 }
    if (t.value === 'null') return { value: null, next: i + 1 }
    throw new SurfaceParseError(`不支持的标识符「${t.value}」（第 ${t.line} 行）：只支持字面量`)
  }
  if (isPunct(t, '{')) return parseObject(tokens, i)
  if (isPunct(t, '[')) return parseArray(tokens, i)
  if (isPunct(t, '-') || isPunct(t, '+')) {
    const inner = parseValue(tokens, i + 1)
    if (typeof inner.value !== 'number') throw new SurfaceParseError(`正负号后面不是数字（第 ${t.line} 行）`)
    return { value: t.value === '-' ? -inner.value : inner.value, next: inner.next }
  }
  throw new SurfaceParseError(`不支持的语法「${t.value}」（第 ${t.line} 行）`)
}

function parseObject(tokens, i) {
  const open = tokens[i]
  const value = {}
  const entries = []
  let j = i + 1
  for (;;) {
    while (isPunct(tokens[j], ',')) j += 1
    const t = tokens[j]
    if (!t) throw new SurfaceParseError('对象字面量未闭合（到文件尾）')
    if (isPunct(t, '}')) { j += 1; break }
    if (isPunct(t, '.')) throw new SurfaceParseError(`对象字面量里出现展开运算符（第 ${t.line} 行），无法静态求值`)
    let key
    if (t.type === 'string' || t.type === 'ident') key = String(t.value)
    else if (t.type === 'number') key = String(t.value)
    else throw new SurfaceParseError(`对象 key 不支持（第 ${t.line} 行：${t.type}）`)
    const keyIndex = j
    j += 1
    if (!isPunct(tokens[j], ':')) throw new SurfaceParseError(`对象 key「${key}」后缺冒号（第 ${t.line} 行）`)
    const val = parseValue(tokens, j + 1)
    value[key] = val.value
    entries.push({ key, value: val.value, keyIndex, endIndex: val.next })
    j = val.next
  }
  return { value, next: j, entries, openIndex: i }
}

function parseArray(tokens, i) {
  const open = tokens[i]
  const value = []
  let j = i + 1
  for (;;) {
    while (isPunct(tokens[j], ',')) j += 1
    const t = tokens[j]
    if (!t) throw new SurfaceParseError('数组字面量未闭合（到文件尾）')
    if (isPunct(t, ']')) { j += 1; break }
    const val = parseValue(tokens, j)
    value.push(val.value)
    j = val.next
  }
  return { value, next: j, openIndex: i }
}

// ---------------------------------------------------------------------------
// 5. 源码定位辅助
// ---------------------------------------------------------------------------

function lineStartOf(src, offset) {
  const k = src.lastIndexOf('\n', offset - 1)
  return k < 0 ? 0 : k + 1
}

function lineEndAfter(src, offset) {
  const k = src.indexOf('\n', offset)
  return k < 0 ? src.length : k + 1
}

/** 找到 `function name(...) { ... }`（也接受 `export function name(...)`）的 body token 范围 */
function findFunctionBody(tokens, name) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'ident' || t.value !== name) continue
    const paren = i + 1
    if (!isPunct(tokens[paren], '(')) continue
    const closeParen = matchBracket(tokens, paren)
    if (!isPunct(tokens[closeParen + 1], '{')) continue
    const openBrace = closeParen + 1
    const closeBrace = matchBracket(tokens, openBrace)
    return { nameToken: i, openBrace, closeBrace, bodyStart: openBrace + 1, bodyEnd: closeBrace }
  }
  throw new SurfaceParseError(`找不到函数 ${name}(...) { ... }`)
}

// ---------------------------------------------------------------------------
// 6. 引擎解析：工具定义（名字 / 描述 / 参数 / 源码 span）
// ---------------------------------------------------------------------------

function descriptionText(value, style) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map((v) => {
      if (typeof v !== 'string') throw new SurfaceParseError('description 数组里出现非字符串片段')
      return v
    })
    // control 侧源码是 [...].join('')；pixel 侧若有数组会走 sanitizeToolDefinition 的 join('\n')
    return style === 'define-tool' ? parts.join('') : parts.join('\n')
  }
  if (value === undefined) throw new SurfaceParseError('缺少 description')
  throw new SurfaceParseError(`description 不是字符串（${typeof value}）`)
}

function paramStats(parameters) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new SurfaceParseError('parameters 不是对象字面量')
  }
  const props = parameters.properties
  if (parameters.type === 'object' && props && typeof props === 'object' && !Array.isArray(props)) {
    return { count: Object.keys(props).length, wrapped: true }
  }
  return { count: Object.keys(parameters).length, wrapped: false }
}

function schemaBytesOf(parameters) {
  return Buffer.byteLength(JSON.stringify(parameters), 'utf8')
}

/**
 * 把对象字面量按「顶层逗号」切成条目，但**不求值**每个 value。
 * 这样 defineTool({ output: { render: (_args, value) => ... } }) 这种含箭头函数的值也不会让解析失败：
 * 我们只需要 name / description / parameters 三个条目，其它条目跳过即可。
 */
function objectEntrySpans(tokens, openBrace) {
  const close = matchBracket(tokens, openBrace)
  const entries = []
  let start = openBrace + 1
  let depth = 0
  for (let j = start; j < close; j++) {
    const t = tokens[j]
    if (t.type !== 'punct') continue
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth += 1; continue }
    if (t.value === ')' || t.value === ']' || t.value === '}') { depth -= 1; continue }
    if (depth === 0 && t.value === ',') {
      if (j > start) {
        const entry = parseObjectEntry(tokens, start, j)
        if (entry) entries.push(entry)
      }
      start = j + 1
    }
  }
  if (close > start) {
    const entry = parseObjectEntry(tokens, start, close)
    if (entry) entries.push(entry)
  }
  return entries
}

function parseObjectEntry(tokens, start, end) {
  let depth = 0
  for (let j = start; j < end; j++) {
    const t = tokens[j]
    if (t.type !== 'punct') continue
    if (t.value === '(' || t.value === '[' || t.value === '{') { depth += 1; continue }
    if (t.value === ')' || t.value === ']' || t.value === '}') { depth -= 1; continue }
    if (depth === 0 && t.value === ':') {
      const keyTok = tokens[start]
      if (!keyTok || (keyTok.type !== 'string' && keyTok.type !== 'ident' && keyTok.type !== 'number')) return null
      return { key: String(keyTok.value), valueStart: j + 1, valueEnd: end }
    }
  }
  return null // 方法简写 / 展开 / 计算属性：忽略
}

/** 从 definition 调用里解析 name/desc/parameters，并给出可删除的源码 span */
function parseCallStyleDef(src, tokens, callIndex) {
  const t = tokens[callIndex]
  const open = callIndex + 1
  if (!isPunct(tokens[open], '(')) return null
  try {
    const nameVal = parseValue(tokens, open + 1)
    if (typeof nameVal.value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(nameVal.value)) return null
    if (!isPunct(tokens[nameVal.next], ',')) return null
    const descVal = parseValue(tokens, nameVal.next + 1)
    const desc = evalJoinedArray(descVal, tokens)
    if (!desc) return null
    if (!isPunct(tokens[desc.next], ',')) return null
    const paramsVal = parseValue(tokens, desc.next + 1)
    if (!isPunct(tokens[paramsVal.next], ',')) return null
    const callEnd = matchBracket(tokens, open)
    return {
      name: nameVal.value,
      description: desc.value,
      parameters: paramsVal.value,
      span: { start: lineStartOf(src, t.start), end: lineEndAfter(src, tokens[callEnd].end) },
      callToken: callIndex,
    }
  } catch (error) {
    if (error instanceof SurfaceParseError) return null
    throw error
  }
}

function parseDefineToolStyleDef(src, tokens, callIndex) {
  const t = tokens[callIndex]
  const open = callIndex + 1
  if (!isPunct(tokens[open], '(')) return null
  if (!isPunct(tokens[open + 1], '{')) return null
  try {
    const byKey = new Map(objectEntrySpans(tokens, open + 1).map((e) => [e.key, e]))
    const nameEntry = byKey.get('name')
    const descEntry = byKey.get('description')
    const paramsEntry = byKey.get('parameters')
    if (!nameEntry || !descEntry || !paramsEntry) return null
    const name = parseValue(tokens, nameEntry.valueStart).value
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) return null
    const description = parseValue(tokens, descEntry.valueStart).value
    const parameters = parseValue(tokens, paramsEntry.valueStart).value
    const callEnd = matchBracket(tokens, open)
    return {
      name,
      description,
      parameters,
      span: { start: lineStartOf(src, t.start), end: lineEndAfter(src, tokens[callEnd].end) },
      callToken: callIndex,
    }
  } catch (error) {
    if (error instanceof SurfaceParseError) return null
    throw error
  }
}

/**
 * description 的常见写法兼容：`[...].join('\n')`（pixel 的合并工具 screen_view
 * 用它拼多行描述）。以前这种写法会让整个 define(...) 被静默跳过 —— 工具不在
 * 名单里就等于「源码里没有它」，assert-surface 的 fail-closed 会漏掉一个**真实存在**
 * 的工具。所以这里做静态求值：数组字面量 + 常量分隔符的 .join()。
 * 只支持这一个形态；其它计算式仍然返回 null（并被上层当成「解析不到」而判红）。
 */
function evalJoinedArray(parsed, tokens) {
  if (!isPunct(tokens[parsed.next], '.')) return { value: parsed.value, next: parsed.next }
  const joinTok = tokens[parsed.next + 1]
  const openTok = tokens[parsed.next + 2]
  const sepTok = tokens[parsed.next + 3]
  const closeTok = tokens[parsed.next + 4]
  const ok = joinTok && joinTok.type === 'ident' && joinTok.value === 'join'
    && isPunct(openTok, '(') && sepTok && sepTok.type === 'string' && isPunct(closeTok, ')')
  if (!ok || !Array.isArray(parsed.value)) return null
  const parts = parsed.value.map((v) => String(v))
  return { value: parts.join(sepTok.value), next: parsed.next + 5 }
}

/** 解析一个引擎的 source 文件，返回 { defs, tokens, src, unparsed } */
function parseEngineSource(root, engine) {
  const file = join(root, engine.source)
  if (!existsSync(file)) {
    throw new SurfaceParseError(`缺少引擎源码：${engine.source}`)
  }
  const src = readFileSync(file, 'utf8')
  const tokens = lex(src)
  const body = findFunctionBody(tokens, engine.builder)
  const defs = []
  // fail-closed：是真调用点（define(/add(/defineTool(）却解析不出 name/描述/参数时，
  // 以前是**静默跳过**——等于少一个工具也不会判红。现在记下来，主流程判 FAIL。
  const unparsed = []
  for (let i = body.bodyStart; i < body.bodyEnd; i++) {
    const t = tokens[i]
    if (t.type !== 'ident') continue
    let def = null
    let callSite = false
    if (engine.style === 'define-tool') {
      if (t.value !== 'defineTool') continue
      callSite = isPunct(tokens[i + 1], '(')
      def = parseDefineToolStyleDef(src, tokens, i)
    } else {
      const callName = engine.style === 'call-add' ? 'add' : 'define'
      if (t.value !== callName) continue
      callSite = isPunct(tokens[i + 1], '(')
      def = parseCallStyleDef(src, tokens, i)
    }
    if (!def) {
      if (callSite) unparsed.push({ call: t.value, line: t.line })
      continue
    }
    const descChars = descriptionText(def.description, engine.style).length
    const stats = paramStats(def.parameters)
    defs.push({
      engine: engine.id,
      engineTitle: engine.title,
      name: def.name,
      descriptionChars: descChars,
      schemaBytes: schemaBytesOf(def.parameters),
      topLevelParams: stats.count,
      paramsWrapped: stats.wrapped,
      parameters: def.parameters,
      description: descriptionText(def.description, engine.style),
      span: def.span,
      file: engine.source,
    })
  }
  return { defs, tokens, src, unparsed }
}

// ---------------------------------------------------------------------------
// 7. 注册点静态分析（G）
// ---------------------------------------------------------------------------

function isRegisterCall(tokens, a, b) {
  for (let i = a; i < b; i++) {
    const t = tokens[i]
    if (t.type !== 'ident') continue
    let j = i + 1
    while (isPunct(tokens[j], '?') || isPunct(tokens[j], '.')) j += 1
    if (/register$/.test(t.value) && isPunct(tokens[j], '(')) return true
  }
  return false
}

function isLogCall(tokens, a, b) {
  for (let i = a; i < b; i++) {
    const t = tokens[i]
    if (t.type !== 'ident') continue
    if (!/^(logWarn|log|warn|info|error)$/.test(t.value)) continue
    let j = i + 1
    while (isPunct(tokens[j], '?') || isPunct(tokens[j], '.')) j += 1
    if (isPunct(tokens[j], '(')) return t.value
  }
  return null
}

function analyzeRegistration(root, engine) {
  const file = join(root, engine.registration.file)
  const result = {
    file: engine.registration.file,
    found: false,
    loopHeader: null,
    tryCatchPairs: 0,
    goodPairs: 0,
    registerCalls: 0,
    catchLogNames: [],
    error: null,
  }
  if (!existsSync(file)) {
    result.error = `缺少注册源码：${engine.registration.file}`
    return result
  }
  const src = readFileSync(file, 'utf8')
  const tokens = lex(src)
  let loop = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'ident' || t.value !== 'for') continue
    if (!isPunct(tokens[i + 1], '(')) continue
    const closeParen = matchBracket(tokens, i + 1)
    const header = src.slice(tokens[i].start, tokens[closeParen].end)
    if (!header.includes(engine.registration.iterable)) continue
    if (!isPunct(tokens[closeParen + 1], '{')) continue
    const closeBrace = matchBracket(tokens, closeParen + 1)
    loop = { header, bodyStart: closeParen + 2, bodyEnd: closeBrace }
    break
  }
  if (!loop) {
    result.error = `找不到注册循环（for...of ${engine.registration.iterable}）`
    return result
  }
  result.found = true
  result.loopHeader = loop.header.replace(/\s+/g, ' ').trim()
  for (let i = loop.bodyStart; i < loop.bodyEnd; i++) {
    const t = tokens[i]
    if (t.type !== 'ident' || t.value !== 'try') continue
    if (!isPunct(tokens[i + 1], '{')) continue
    const tryClose = matchBracket(tokens, i + 1)
    let j = tryClose + 1
    if (!tokens[j] || tokens[j].type !== 'ident' || tokens[j].value !== 'catch') continue
    j += 1
    if (isPunct(tokens[j], '(')) j = matchBracket(tokens, j) + 1
    if (!isPunct(tokens[j], '{')) continue
    const catchClose = matchBracket(tokens, j)
    result.tryCatchPairs += 1
    const tryBody = [i + 2, tryClose]
    const catchBody = [j + 1, catchClose]
    const hasRegister = isRegisterCall(tokens, tryBody[0], tryBody[1])
    const logName = isLogCall(tokens, catchBody[0], catchBody[1])
    if (hasRegister) result.registerCalls += 1
    if (hasRegister && logName) {
      result.goodPairs += 1
      if (!result.catchLogNames.includes(logName)) result.catchLogNames.push(logName)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 8. 常驻安全段（pixel/index.js 的 SAFETY_PROMPT_SECTION）解析
// ---------------------------------------------------------------------------

function extractSafetySection(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'ident' || t.value !== 'SAFETY_PROMPT_SECTION') continue
    if (!isPunct(tokens[i + 1], '=')) continue
    try {
      const v = parseValue(tokens, i + 2)
      if (Array.isArray(v.value)) return v.value.join('\n')
      if (typeof v.value === 'string') return v.value
      return null
    } catch {
      return null
    }
  }
  return null
}

/**
 * 从源码里抽一个「纯字符串数组常量」（P4 用来读 doctor.js 的单一源表）：
 *   const NAME = ['a', 'b', ...]
 * 只认单引号/双引号字符串字面量；找不到或形态不符返回 null（调用方判红）。
 */
function extractConstArray(src, name) {
  if (typeof src !== 'string' || src.length === 0) return null
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`)
  const m = re.exec(src)
  if (!m) return null
  const items = [...m[1].matchAll(/'([a-z][a-z0-9_]*)'|"([a-z][a-z0-9_]*)"/g)].map((x) => x[1] || x[2])
  return items.length > 0 ? items : null
}

// ---------------------------------------------------------------------------
// 9. 文档引用名扫描（F）
// ---------------------------------------------------------------------------

// 只认 snake_case 形态（工具名都是 snake_case）；纯单词不当工具名。
const TOOL_TOKEN_RE = /(?<![A-Za-z0-9_$])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_$])/g

// F 的扫描器把所有 snake_case token 都当「疑似工具名」。下面这些是**参数名**：
// 它们在文档里必须出现（否则说不清 screen_view 怎么传矩形），但不是工具名。
// fail-closed 纪律：只许加「源码里真实存在的参数名」，绝不许把疑似旧工具名塞进来。
const NON_TOOL_PARAM_TOKENS = new Set([
  'region_rect', // screen_view / screen_capture / screen_wait 的矩形参数
])

function scanReferencedNames(text, label) {
  // screen_view 的 action 值不是工具名：唯一与旧工具同名的 action 是 wait_window
  //（文档里写成 {action:"wait_window"} 或 action:"wait_window"）。扫描前先把 action 值剥离，
  // 免得把 action 名误判成「引用旧工具名」；不带 action 前缀的旧工具名仍然照抓。
  const withoutActionValues = text.replace(/action\s*[:=]\s*["'`]?[a-z_][a-z0-9_]*/g, (m) => ' '.repeat(m.length))
  const found = new Map() // name -> 次数
  for (const m of withoutActionValues.matchAll(TOOL_TOKEN_RE)) {
    found.set(m[0], (found.get(m[0]) || 0) + 1)
  }
  const unknown = []
  for (const [name, count] of found) {
    if (ALL_NAME_SET.has(name)) continue
    if (NON_TOOL_PARAM_TOKENS.has(name)) continue
    unknown.push({ name, count, label })
  }
  return { total: found.size, unknown }
}

// ---------------------------------------------------------------------------
// 10. baseline 读取（H，容错多种格式）
// ---------------------------------------------------------------------------

function metricsOfBaselineEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const out = {}
  const pickNumber = (keys) => {
    for (const k of keys) if (typeof entry[k] === 'number' && Number.isFinite(entry[k])) return entry[k]
    return undefined
  }
  const schemaBytes = pickNumber(['schemaBytes', 'schema_bytes', 'schemaSize', 'schema_size', 'bytes', 'paramSchemaBytes', 'param_schema_bytes'])
  if (schemaBytes !== undefined) out.schemaBytes = schemaBytes
  // 也接受 { schema: { bytes } } 这类嵌套形态
  if (entry.schema && typeof entry.schema === 'object') {
    for (const k of ['bytes', 'schemaBytes', 'jsonBytes', 'json_bytes']) {
      if (typeof entry.schema[k] === 'number') { out.schemaBytes = entry.schema[k]; break }
    }
  }
  const descriptionChars = pickNumber(['descriptionChars', 'descChars', 'description_chars', 'desc_chars', 'descriptionLength', 'description_length'])
  if (descriptionChars !== undefined) out.descriptionChars = descriptionChars
  const topLevelParams = pickNumber(['topLevelParams', 'top_level_params', 'paramCount', 'param_count', 'topParams', 'paramsCount'])
  if (topLevelParams !== undefined) out.topLevelParams = topLevelParams
  if (Object.keys(out).length === 0) return null
  return out
}

function loadBaselineMap(path) {
  const raw = readFileSync(path, 'utf8')
  let json
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { error: `baseline 不是合法 JSON：${error.message}`, map: new Map() }
  }
  const map = new Map()
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string') {
      const m = metricsOfBaselineEntry(node)
      if (m && !map.has(node.name)) map.set(node.name, m)
    }
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue
      if (key === 'tools' && !Array.isArray(value)) {
        for (const [name, entry] of Object.entries(value)) {
          const m = metricsOfBaselineEntry(entry)
          if (m && !map.has(name)) map.set(name, m)
        }
      }
      visit(value)
    }
  }
  visit(json)
  return { error: null, map }
}

// ---------------------------------------------------------------------------
// 11. 断言主流程
// ---------------------------------------------------------------------------

function main(argv) {
  const args = parseArgs(argv)
  const root = args.root
  console.log('assert-surface · 工具面 fail-closed 断言（P1）')
  console.log(`root: ${root}`)
  console.log(`期望：${EXPECTED_TOTAL} 个真名 = pixel ${PIXEL_NAMES.length} + control ${CONTROL_NAMES.length} + stroke ${STROKE_NAMES.length}`)

  // ---- 解析三个引擎 ----
  const parsed = []
  const parseErrors = []
  for (const engine of ENGINES) {
    try {
      const { defs, tokens, src, unparsed } = parseEngineSource(root, engine)
      parsed.push({ engine, defs, tokens, src, unparsed })
      console.log(`  [解析] ${engine.id.padEnd(8)} 声明 ${String(defs.length).padStart(2)} 个 / 源码应声明 ${(engine.sourceNames || engine.names).length} 个（默认注册 ${engine.names.length} 个）`)
    } catch (error) {
      parseErrors.push({ engine, message: error.message })
      console.log(`  [解析] ${engine.id.padEnd(8)} 解析失败：${error.message}`)
    }
  }

  // ---- A. per-engine allowlist ----
  section('A', `per-engine allowlist（默认合并态 ${EXPECTED_TOTAL} 个注册真名，一个不能少）`)
  for (const p of parsed) {
    const { engine, defs } = p
    const declared = new Map(defs.map((d) => [d.name, d]))
    const sourceNames = engine.sourceNames || engine.names
    const legacyNames = engine.legacyNames || []
    const missing = engine.names.filter((n) => !declared.has(n))
    const extra = defs.map((d) => d.name).filter((n) => !sourceNames.includes(n))
    if (missing.length === 0) pass(`${engine.id}: ${engine.names.length}/${engine.names.length} 个注册真名齐全（源码声明 ${defs.length} 个）`)
    else fail(`${engine.id}: 缺少注册工具 ${missing.join(', ')}`, `源码 ${engine.source} 里应有 ${sourceNames.length} 个 define（含回退用旧工具），实际 ${defs.length} 个`)
    // pixel 的旧 10 个：默认不注册，但源码必须继续声明 —— 删了就等于毁掉 mergeReadSide:false 回退路径。
    if (legacyNames.length > 0) {
      const missingLegacy = legacyNames.filter((n) => !declared.has(n))
      if (missingLegacy.length === 0) pass(`${engine.id}: ${legacyNames.length}/${legacyNames.length} 个旧工具声明仍在（mergeReadSide:false 回退路径）`)
      else fail(`${engine.id}: 旧工具声明缺 ${missingLegacy.join(', ')}`, '默认合并态不注册它们，但源码必须保留——否则显式 mergeReadSide:false 回不去')
    }
    if (extra.length === 0) pass(`${engine.id}: 无名单外工具`)
    else if (args.allowExtra) info(`${engine.id}: 名单外工具（--allow-extra 放行）：${extra.join(', ')}`)
    else fail(`${engine.id}: 出现未知名（不在源码 allowlist ${sourceNames.length} 个内）：${extra.join(', ')}`, '新增工具必须先更新本脚本的期望名单（fail-closed，防静默漂移）')
  }
  for (const e of parseErrors) fail(`${e.engine.id}: 源码解析失败（无法确认工具面）`, e.message)
  for (const p of parsed) {
    if (!p.unparsed || p.unparsed.length === 0) continue
    fail(
      `${p.engine.id}: ${p.unparsed.length} 个工具定义调用点无法静态解析（fail-closed）`,
      p.unparsed.map((u) => `第 ${u.line} 行 ${u.call}(...)：name/description/parameters 不是可静态求值的字面量`).join('\n')
        + '\n（工具面断言看不见它 = 它可能已在运行期注册但逃过所有检查；改成字面量，或给解析器加支持）',
    )
  }

  // ---- B. 总数 ----
  section('B', `注册工具总数 = ${PIXEL_NAMES.length} + ${CONTROL_NAMES.length} + ${STROKE_NAMES.length} = ${EXPECTED_TOTAL}（源码声明 24 + 6 + 5 = 35）`)
  const totalDeclared = parsed.reduce((n, p) => n + p.defs.length, 0)
  const sourceExpectedTotal = parsed.reduce((n, p) => n + (p.engine.sourceNames || p.engine.names).length, 0)
  const legacyDeclaredCount = parsed.reduce((n, p) => n + (p.engine.legacyNames || []).filter((name) => p.defs.some((d) => d.name === name)).length, 0)
  const registeredTotal = totalDeclared - legacyDeclaredCount
  if (parseErrors.length === 0 && totalDeclared === sourceExpectedTotal && registeredTotal === EXPECTED_TOTAL) {
    pass(`默认合并态注册 ${registeredTotal} = ${EXPECTED_TOTAL}（各引擎 ${parsed.map((p) => `${p.engine.id}:${p.defs.length - (p.engine.legacyNames || []).length}`).join(' / ')}；源码声明 ${totalDeclared} = ${sourceExpectedTotal}）`)
  } else {
    fail(`注册工具总数 ${registeredTotal} ≠ ${EXPECTED_TOTAL}`,
      `源码声明 ${totalDeclared} / 应声明 ${sourceExpectedTotal}；` + parsed.map((p) => `${p.engine.id}: 声明 ${p.defs.length - (p.engine.legacyNames || []).length} 个注册（源码 ${p.defs.length} / 应 ${(p.engine.sourceNames || p.engine.names).length}）`).join('\n'))
  }

  // 汇总 metrics
  const allDefs = parsed.flatMap((p) => p.defs)
  const exemptSet = THRESHOLDS.mergedToolExempt
  const exemptDefs = allDefs.filter((d) => exemptSet.has(d.name))
  const normalDefs = allDefs.filter((d) => !exemptSet.has(d.name))

  // ---- C. description 字符上限 ----
  // v0.9.5（P4）：合并工具（screen_view）单独一档，**其余工具的上限一个都没放宽**
  // （Lead 2026-11-08：豁免只作用于合并工具自己，不许外溢成全局放松）。
  section('C', `description 字符上限（非合并工具单条 ≤ ${THRESHOLDS.descCharsPerTool}；合并工具 ${[...exemptSet].join('/')} ≤ ${THRESHOLDS.descCharsPerMergedTool}）`)
  const overTool = normalDefs.filter((d) => d.descriptionChars > THRESHOLDS.descCharsPerTool)
  if (allDefs.length === 0) fail('没有任何工具定义，无法评估 description')
  else if (overTool.length === 0) {
    const worst = normalDefs.slice().sort((a, b) => b.descriptionChars - a.descriptionChars)[0]
    pass(`非合并工具单条全部 ≤ ${THRESHOLDS.descCharsPerTool}（最长 ${worst ? worst.descriptionChars : 0}: ${worst ? worst.name : '(无)'}；共 ${normalDefs.length} 个）`)
  } else {
    fail(`description 超单工具上限 ${THRESHOLDS.descCharsPerTool}：${overTool.map((d) => `${d.name}=${d.descriptionChars}`).join(', ')}`, '非合并工具不许变贵；合并工具请进 mergedToolExempt 并说明理由')
  }
  const overMerged = exemptDefs.filter((d) => d.descriptionChars > THRESHOLDS.descCharsPerMergedTool)
  for (const d of exemptDefs) {
    if (d.descriptionChars <= THRESHOLDS.descCharsPerMergedTool) {
      pass(`合并工具 ${d.name} 描述 ${d.descriptionChars} ≤ ${THRESHOLDS.descCharsPerMergedTool}（豁免项：只有它吃这个上限）`)
    }
  }
  if (overMerged.length > 0) fail(`合并工具描述超上限 ${THRESHOLDS.descCharsPerMergedTool}：${overMerged.map((d) => `${d.name}=${d.descriptionChars}`).join(', ')}`, '合并工具的描述也要有上界；再长就拆工具/砍文案')
  for (const p of parsed) {
    const sumNormal = p.defs.filter((d) => !exemptSet.has(d.name)).reduce((n, d) => n + d.descriptionChars, 0)
    const allowance = THRESHOLDS.mergedDescCharsAllowance[p.engine.id] || 0
    const sumAll = p.defs.reduce((n, d) => n + d.descriptionChars, 0)
    const limitNormal = THRESHOLDS.descCharsPerEngine[p.engine.id]
    if (sumNormal <= limitNormal) pass(`${p.engine.id} 非合并工具合计 ${sumNormal} ≤ ${limitNormal}（P1 原始上限，未放宽）`)
    else fail(`${p.engine.id} 非合并工具合计 ${sumNormal} > ${limitNormal}（P1 原始上限）`, '豁免只给合并工具，不许把旧工具的合计额度一起抬高')
    const limitAll = limitNormal + allowance
    if (sumAll <= limitAll) pass(`${p.engine.id} 引擎合计 ${sumAll} ≤ ${limitAll}（= P1 上限 ${limitNormal} + 合并工具额度 ${allowance}）`)
    else fail(`${p.engine.id} 引擎合计 ${sumAll} > ${limitAll}（P1 上限 + 合并工具额度）`)
  }
  const totalDesc = allDefs.reduce((n, d) => n + d.descriptionChars, 0)
  const totalDescNormal = normalDefs.reduce((n, d) => n + d.descriptionChars, 0)
  const totalAllowance = Object.values(THRESHOLDS.mergedDescCharsAllowance).reduce((a, b) => a + b, 0)
  if (totalDescNormal <= THRESHOLDS.descCharsTotal) pass(`全局非合并工具合计 ${totalDescNormal} ≤ ${THRESHOLDS.descCharsTotal}（P1 原始上限，未放宽）`)
  else fail(`全局非合并工具合计 ${totalDescNormal} > ${THRESHOLDS.descCharsTotal}（P1 原始上限）`)
  if (totalDesc <= THRESHOLDS.descCharsTotal + totalAllowance) pass(`全局合计 ${totalDesc} ≤ ${THRESHOLDS.descCharsTotal + totalAllowance}（= P1 上限 + 合并工具额度 ${totalAllowance}）`)
  else fail(`全局合计 ${totalDesc} > ${THRESHOLDS.descCharsTotal + totalAllowance}（P1 上限 + 合并工具额度）`)

  // ---- D. top-level 参数个数 ----
  section('D', `top-level 参数个数（非合并工具 ≤ ${THRESHOLDS.topParamsPerTool}；合并工具 ≤ ${THRESHOLDS.topParamsPerMergedTool}）`)
  const overParams = normalDefs.filter((d) => d.topLevelParams > THRESHOLDS.topParamsPerTool)
  if (normalDefs.length > 0 && overParams.length === 0) {
    const worst = normalDefs.slice().sort((a, b) => b.topLevelParams - a.topLevelParams)[0]
    pass(`非合并工具 top-level 参数全部 ≤ ${THRESHOLDS.topParamsPerTool}（最多 ${worst.topLevelParams}: ${worst.name}）`)
  } else if (overParams.length > 0) {
    fail(`top-level 参数超上限：${overParams.map((d) => `${d.name}=${d.topLevelParams}`).join(', ')}`, `非合并工具上限仍是 ${THRESHOLDS.topParamsPerTool}`)
  }
  const overMergedParams = exemptDefs.filter((d) => d.topLevelParams > THRESHOLDS.topParamsPerMergedTool)
  for (const d of exemptDefs) {
    if (d.topLevelParams <= THRESHOLDS.topParamsPerMergedTool) {
      pass(`合并工具 ${d.name} top-level 参数 ${d.topLevelParams} ≤ ${THRESHOLDS.topParamsPerMergedTool}（豁免项）`)
    }
  }
  if (overMergedParams.length > 0) fail(`合并工具 top-level 参数超上限 ${THRESHOLDS.topParamsPerMergedTool}：${overMergedParams.map((d) => `${d.name}=${d.topLevelParams}`).join(', ')}`, '再给合并工具加参数必须先拆工具或收进嵌套对象')
  const emptyParams = allDefs.filter((d) => d.topLevelParams === 0).length
  info(`0 参数工具 ${emptyParams} 个（这些工具在 schema 里没有 properties，属正常）`)

  // ---- E. schema 字节 ----
  section('E', `schema 字节上限（单工具 ≤ ${THRESHOLDS.schemaBytesPerTool} B，全局 ≤ ${THRESHOLDS.schemaBytesTotal} B）`)
  const overBytes = allDefs.filter((d) => d.schemaBytes > THRESHOLDS.schemaBytesPerTool)
  if (allDefs.length > 0 && overBytes.length === 0) {
    const worst = allDefs.slice().sort((a, b) => b.schemaBytes - a.schemaBytes)[0]
    pass(`单工具 schema 全部 ≤ ${THRESHOLDS.schemaBytesPerTool} B（最大 ${worst.schemaBytes} B: ${worst.name}）`)
  } else if (overBytes.length > 0) {
    fail(`schema 超单工具上限：${overBytes.map((d) => `${d.name}=${d.schemaBytes}B`).join(', ')}`, `deep-ptc-mode 硬预算 ${THRESHOLDS.schemaBytesPerTool} B，不能放宽`)
  }
  const totalBytes = allDefs.reduce((n, d) => n + d.schemaBytes, 0)
  if (totalBytes <= THRESHOLDS.schemaBytesTotal) pass(`全局 schema 合计 ${totalBytes} B ≤ ${THRESHOLDS.schemaBytesTotal} B`)
  else fail(`全局 schema 合计 ${totalBytes} B > ${THRESHOLDS.schemaBytesTotal} B`)

  // ---- F. 文档引用名一致性 ----
  section('F', `SKILL.md 与常驻安全段引用的工具名 ⊆ ${EXPECTED_TOTAL} 真名`)
  const skillPath = join(root, PIXEL_SKILL_DOC)
  if (!existsSync(skillPath)) {
    fail(`缺少常驻技能文档 ${PIXEL_SKILL_DOC}`)
  } else {
    const doc = readFileSync(skillPath, 'utf8')
    const scanned = scanReferencedNames(doc, 'SKILL.md')
    if (scanned.unknown.length === 0) pass(`SKILL.md: ${scanned.total} 个工具名全部在 ${EXPECTED_TOTAL} 真名内`)
    else reportUnknownRefs(scanned.unknown, 'SKILL.md')
  }
  const pixelParsed = parsed.find((p) => p.engine.id === 'pixel')
  if (!pixelParsed) {
    fail('pixel 源码未解析成功，无法读取常驻安全段')
  } else {
    const safety = extractSafetySection(pixelParsed.tokens)
    if (!safety) fail('pixel/index.js 里找不到 SAFETY_PROMPT_SECTION 字符串数组（常驻安全段）')
    else {
      const scanned = scanReferencedNames(safety, 'SAFETY_PROMPT_SECTION')
      if (scanned.unknown.length === 0) pass(`常驻安全段: ${scanned.total} 个工具名全部在 ${EXPECTED_TOTAL} 真名内`)
      else reportUnknownRefs(scanned.unknown, 'SAFETY_PROMPT_SECTION')
    }
  }

  function reportUnknownRefs(unknown, where) {
    const legacy = unknown.filter((u) => LEGACY_NAME_HINTS.has(u.name))
    const other = unknown.filter((u) => !LEGACY_NAME_HINTS.has(u.name))
    if (legacy.length > 0) fail(`${where}: 出现旧名/未注册名 ${legacy.map((u) => `${u.name}×${u.count}`).join(', ')}`, `文档里写了不存在的工具名 → 模型会照着调用然后失败；改成 ${EXPECTED_TOTAL} 真名之一`)
    if (other.length > 0) fail(`${where}: 出现不存在的工具名 ${other.map((u) => `${u.name}×${u.count}`).join(', ')}`, `只允许引用实际注册的 ${EXPECTED_TOTAL} 个工具名`)
  }

  // ---- G. 注册失败探测 ----
  section('G', '注册点形态：逐个 try/catch + logWarn，且源码声明数 = 源码应声明数')
  for (const p of parsed) {
    const { engine, defs } = p
    const reg = analyzeRegistration(root, engine)
    if (!reg.found) {
      fail(`${engine.id}: 找不到注册循环（期望 ${engine.registration.shape}）`, reg.error || '')
      continue
    }
    // 静态源码声明数对照的是 sourceNames（pixel 24，含回退用旧 10 个）；
    // 默认注册数由 A/B 段单独判（25 个 = 14 + 6 + 5）。
    const sourceNames = engine.sourceNames || engine.names
    const countOk = defs.length === sourceNames.length
    const shapeOk = reg.tryCatchPairs >= 1 && reg.goodPairs >= 1 && reg.registerCalls >= 1
    const detail = `${engine.id}: 源码声明 ${defs.length} 个 / 源码应声明 ${sourceNames.length} 个（默认注册 ${engine.names.length} 个）；循环「${reg.loopHeader}」；try/catch ${reg.tryCatchPairs} 对，其中 register+log ${reg.goodPairs} 对（日志: ${reg.catchLogNames.join('/') || '无'}）`
    if (shapeOk && countOk) pass(detail)
    else {
      const problems = []
      if (!shapeOk) problems.push('注册点不是「逐个 try/catch + 日志告警」形态（registration failure 会被静默吞掉）')
      if (!countOk) problems.push(`源码声明数 ${defs.length} ≠ 源码应声明 ${sourceNames.length}`)
      fail(detail, problems.join('\n'))
    }
  }

  // ---- H. baseline 快照 diff ----
  section('H', '可选 schema 快照 diff（baseline.json）')
  const baselinePath = resolveBaselinePath(root, args)
  if (args.noBaseline) {
    skip('--no-baseline：按参数跳过快照 diff')
  } else if (!baselinePath) {
    skip(`baseline.json 不存在（候选：${BASELINE_CANDIDATES.join(' , ')}）→ 无法做逐工具字节漂移对比`)
  } else {
    const loaded = loadBaselineMap(baselinePath)
    if (loaded.error) {
      skip(`baseline 存在但不可用：${loaded.error}（路径 ${baselinePath}）`)
    } else if (loaded.map.size === 0) {
      skip(`baseline 存在但识别不出任何工具指标：${baselinePath}（支持 tools 数组/对象、engines.<id>.tools[] 等形态）`)
    } else {
      info(`baseline: ${baselinePath}（识别 ${loaded.map.size} 个工具）`)
      const drifts = []
      const shown = []
      for (const d of allDefs) {
        const base = loaded.map.get(d.name)
        if (!base) continue
        shown.push(d.name)
        if (typeof base.schemaBytes === 'number') {
          const limit = Math.max(THRESHOLDS.baselineSchemaDriftBytes, Math.round(base.schemaBytes * THRESHOLDS.baselineSchemaDriftRatio))
          if (Math.abs(d.schemaBytes - base.schemaBytes) > limit) {
            drifts.push(`${d.name}: schema ${base.schemaBytes}B → ${d.schemaBytes}B（漂移 ${d.schemaBytes - base.schemaBytes}B > ${limit}B）`)
          }
        }
        if (typeof base.descriptionChars === 'number' && Math.abs(d.descriptionChars - base.descriptionChars) > THRESHOLDS.baselineDescDriftChars) {
          drifts.push(`${d.name}: description ${base.descriptionChars} → ${d.descriptionChars} 字符（阈值 ${THRESHOLDS.baselineDescDriftChars}）`)
        }
        if (typeof base.topLevelParams === 'number' && d.topLevelParams !== base.topLevelParams) {
          drifts.push(`${d.name}: top-level 参数 ${base.topLevelParams} → ${d.topLevelParams}`)
        }
      }
      const onlyInBaseline = [...loaded.map.keys()].filter((n) => !ALL_NAME_SET.has(n))
      if (onlyInBaseline.length > 0) drifts.push(`baseline 里有当前不存在的工具：${onlyInBaseline.join(', ')}`)
      if (drifts.length === 0) pass(`对比 ${shown.length} 个工具，无超阈值漂移`)
      else fail(`快照漂移 ${drifts.length} 项`, drifts.join('\n'))

      // ---- H2. 逐工具基线钉死（Lead 2026-11-08 要求）----
      // 上面的漂移阈值是「容差」（±400 B / ±60 字符），合并工具豁免后仍然会有空间让
      // 某个旧工具**悄悄变贵**。这里再钉一条死线：**非合并工具**的 description 字符数
      // 与 top-level 参数个数，相对 baseline **只许持平或下降**，涨了就 FAIL 并点名。
      // 合并工具（mergedToolExempt）不受这条约束（它本来就不在旧基线里，且有自己的上限）。
      const pinned = []
      let pinnedCount = 0
      for (const d of allDefs) {
        if (THRESHOLDS.mergedToolExempt.has(d.name)) continue
        const base = loaded.map.get(d.name)
        if (!base) continue
        pinnedCount += 1
        if (typeof base.descriptionChars === 'number' && d.descriptionChars > base.descriptionChars) {
          pinned.push(`${d.name}: description ${base.descriptionChars} → ${d.descriptionChars} 字符（非合并工具只许持平或下降）`)
        }
        if (typeof base.topLevelParams === 'number' && d.topLevelParams > base.topLevelParams) {
          pinned.push(`${d.name}: top-level 参数 ${base.topLevelParams} → ${d.topLevelParams}（非合并工具只许持平或下降）`)
        }
      }
      if (pinnedCount === 0) {
        info('逐工具基线钉死：baseline 里没有可比对的非合并工具（跳过）')
      } else if (pinned.length === 0) {
        pass(`逐工具基线钉死：${pinnedCount} 个非合并工具的描述/参数面均未上涨（只许持平或下降）`)
      } else {
        fail(`逐工具基线钉死：${pinned.length} 处上涨（非合并工具不许变贵）`, pinned.join('\n'))
      }
    }
  }

  // ---- P4. screen_view 读侧合并 + mergeReadSide 灰度开关 ----
  // 背景：pixel 读侧 7 个工具（screen_info/capture/zoom/locate/text/read/wait）+ 3 个窗口工具
  //（window_list/window_focus/wait_window）合并成一个 screen_view。
  // I2-A（2026-11-08，用户拍板 A）：**默认 true = 默认合并态**；显式 false 才是回退路径。
  //   true（默认）→ 跳过注册旧 10 个 → pixel 14 / 全包 25（装完即兑现，不写 config-overrides）；
  //   false（显式）→ 旧 10 个仍注册（保留原描述、不加 deprecated 注记）→ pixel 24 / 全包 35。
  // 2026-11-08 09:14 定稿（用户确认由另一会话落地，本轮按 A 路线收尾）：
  //   注记从工具描述里撤掉，引导改由**常驻安全段**（SAFETY_PROMPT_SECTION）承担，
  //   默认态每轮省约 1.7 KB。所以这里断言的是「无注记 + 常驻段确实把模型引向 screen_view」
  //   —— 只删注记却没给引导 = 模型在 8 条读路径里瞎选，必须判红。
  // 这一节把「合并入口真的在」「7 个能力都在枚举里」「引导不丢」「flag 默认就是 true」
  // 变成硬断言 —— 否则 flag=true 后读侧会静默缺能力。
  section('P4', 'screen_view 读侧合并 / mergeReadSide 默认合并态（显式 false 回退）')
  {
    const px = parsed.find((p) => p.engine.id === 'pixel')
    const pxDefs = px ? px.defs : []
    const pxSrc = px ? px.src : ''
    const READ_ACTIONS = ['info', 'capture', 'zoom', 'locate', 'text', 'read', 'wait']
    // P6（2026-11-08）：窗口三件也进 screen_view → 枚举 10 个 action。
    const WINDOW_ACTIONS = ['list', 'focus', 'wait_window']
    const ALL_ACTIONS = [...READ_ACTIONS, ...WINDOW_ACTIONS]
    const LEGACY_READ_TOOLS = [
      'screen_info', 'screen_capture', 'screen_zoom', 'screen_locate',
      'screen_text', 'screen_read', 'screen_wait',
    ]
    const LEGACY_WINDOW_TOOLS = ['window_list', 'window_focus', 'wait_window']
    let configSrc = ''
    try { configSrc = readFileSync(join(root, 'engines/pixel/lib/config.js'), 'utf8') } catch { /* 下面判红 */ }

    const view = pxDefs.find((d) => d.name === 'screen_view')
    if (!view) {
      fail('pixel: 缺少 screen_view（读侧合并入口）', '默认合并态下不注册旧 10 个，缺了它模型将完全没有读屏/截图/窗口能力')
    } else {
      const params = view.parameters && typeof view.parameters === 'object' ? view.parameters : {}
      const props = params.properties && typeof params.properties === 'object' ? params.properties : {}
      const action = props.action && typeof props.action === 'object' ? props.action : null
      const gotEnum = action && Array.isArray(action.enum) ? action.enum : []
      const enumOk = action !== null && gotEnum.length === ALL_ACTIONS.length && ALL_ACTIONS.every((a) => gotEnum.includes(a))
      if (enumOk) pass(`screen_view: action 枚举恰好覆盖 7 个读能力 + 3 个窗口能力（${ALL_ACTIONS.join('/')}）`)
      else fail('screen_view: action 枚举没覆盖全部 10 个能力', `期望 ${ALL_ACTIONS.join('|')}；实际 ${JSON.stringify(gotEnum)}`)
      if (Array.isArray(params.required) && params.required.includes('action')) pass('screen_view: required 含 action（不传 action 不会静默落到某个读工具）')
      else fail('screen_view: required 缺少 action', '缺 required 时模型可能空参数调用，行为不可预测')

      // 同包直调 def.execute —— 这是 Lead 拍板的路线：壳转发（ctx.tools.get(name).execute）
      // 会绕过本引擎的 guard/审批/审计包装。判定前先剥掉注释：源码注释里写着
      // 「刻意不用 ctx.tools.get(name).execute()」，不剥会把说明当成实现。
      const pxCode = pxSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
      if (/return\s+await\s+target\.execute\s*\(/.test(pxCode) && !/ctx\.tools\.get\([^)]*\)\.execute/.test(pxCode)) {
        pass('screen_view: 分发是同包直调 target.execute（不经 ctx.tools.get(...).execute 壳，guard/审批不被绕过）')
      } else {
        fail('screen_view: 分发实现不是「同包直调 target.execute」', '壳转发会绕过 guard/审批；这是 P4 的红线')
      }
    }

    // action → 旧工具名的映射必须**恰好**是那 7 个读工具（多一个/少一个都算读侧缺能力）。
    const mapMatch = /const VIEW_ACTION_TO_TOOL\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(pxSrc)
    if (!mapMatch) {
      fail('pixel: 找不到 VIEW_ACTION_TO_TOOL（action → 旧工具名映射）')
    } else {
      const pairs = [...mapMatch[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([a-z][a-z0-9_]*)'/g)].map((m) => [m[1], m[2]])
      const mappedActions = pairs.map((p) => p[0]).sort()
      const mappedTools = pairs.map((p) => p[1]).sort()
      const actionsOk = mappedActions.join(',') === ALL_ACTIONS.slice().sort().join(',')
      const toolsOk = mappedTools.join(',') === [...LEGACY_READ_TOOLS, ...LEGACY_WINDOW_TOOLS].slice().sort().join(',')
      if (actionsOk && toolsOk) {
        pass(`screen_view: action→工具映射 ${pairs.length} 条，恰好覆盖 7 个读工具 + 3 个窗口工具（${mappedTools.join(' ')}）`)
      } else {
        fail('screen_view: action→工具映射不是「10 action ↔ 10 工具」一一对应', `actions=${JSON.stringify(mappedActions)} tools=${JSON.stringify(mappedTools)}`)
      }
    }

    // 旧 10 个（7 读 + 3 窗口）在源码里仍然声明（flag=false 才注册；flag=true 由运行期 splice 摘掉）。
    // 声明数必须仍是 10 —— 少一个就说明有人把旧工具直接删了（那就不是灰度，是破坏性变更）。
    const legacyDeclared = [...LEGACY_READ_TOOLS, ...LEGACY_WINDOW_TOOLS].filter((n) => pxDefs.some((d) => d.name === n))
    const ALL_LEGACY = [...LEGACY_READ_TOOLS, ...LEGACY_WINDOW_TOOLS]
    if (legacyDeclared.length === ALL_LEGACY.length) pass('pixel: 旧 10 个（7 读 + 3 窗口）仍全部在源码里声明（灰度期可回滚）')
    else fail(`pixel: 旧工具在源码里只剩 ${legacyDeclared.length}/10 个`, `缺 ${ALL_LEGACY.filter((n) => !legacyDeclared.includes(n)).join(', ')}；灰度期必须保留`)

    // 单一源：doctor.js 是「旧 10 个」与「默认态期望」的另一张表，两张表必须逐字一致，
    // 否则两个门禁互相打架（assert-surface 说 14、doctor 说 24 之类）。
    // 这里既反核 PIXEL_LEGACY_NAMES，也用它反核 PIXEL_NAMES = doctor EXPECTED_TOOLS − 旧 10 个。
    let doctorSrc = ''
    try { doctorSrc = readFileSync(join(root, 'engines/pixel/lib/doctor.js'), 'utf8') } catch { /* 下面判红 */ }
    const doctorLegacyRead = extractConstArray(doctorSrc, 'READ_SIDE_LEGACY_TOOLS')
    const doctorLegacyWindow = extractConstArray(doctorSrc, 'WINDOW_SIDE_LEGACY_TOOLS')
    const doctorExpected = extractConstArray(doctorSrc, 'EXPECTED_TOOLS')
    if (!doctorLegacyRead || !doctorLegacyWindow || !doctorExpected) {
      fail('doctor.js: 找不到 READ_SIDE_LEGACY_TOOLS / WINDOW_SIDE_LEGACY_TOOLS / EXPECTED_TOOLS（单一源表缺了，无法反核）')
    } else {
      const doctorLegacy = [...doctorLegacyRead, ...doctorLegacyWindow].sort()
      if (doctorLegacy.join(',') === ALL_LEGACY.slice().sort().join(',') && doctorLegacy.join(',') === PIXEL_LEGACY_NAMES.slice().sort().join(',')) {
        pass('doctor.js: READ_SIDE_LEGACY_TOOLS + WINDOW_SIDE_LEGACY_TOOLS 与本脚本旧 10 个逐字一致（单一源）')
      } else {
        fail('doctor.js: 旧工具清单与本脚本不一致', `doctor=${doctorLegacy.join(',')}；本脚本=${ALL_LEGACY.slice().sort().join(',')}`)
      }
      const doctorMerged = doctorExpected.filter((n) => !doctorLegacy.includes(n)).sort()
      if (doctorMerged.join(',') === PIXEL_NAMES.slice().sort().join(',')) {
        pass(`doctor.js: EXPECTED_TOOLS(${doctorExpected.length}) − 旧 10 个 = 默认注册 ${doctorMerged.length} 个，与 PIXEL_NAMES 逐字一致（反核 24−10=14）`)
      } else {
        fail('doctor.js: EXPECTED_TOOLS − 旧 10 个 ≠ PIXEL_NAMES（默认合并态名单漂移）', `doctor=${doctorMerged.join(',')}\n本脚本=${PIXEL_NAMES.slice().sort().join(',')}`)
      }
    }

    // 2026-11-08 09:14 定稿：旧 7 个在 flag=false 下保留原描述，**不再加
    // [deprecated → screen_view] 注记**；引导由常驻安全段 SAFETY_PROMPT_SECTION 承担。
    // 判据（三条同时成立才算过，缺一条都红）：
    //   ① 源码里已经没有注记；② P4 灰度分支里没有改写 description 的代码；
    //   ③ 常驻安全段确实出现 screen_view（否则模型没有任何「该用哪条」的提示）。
    //  ① 源码（**剥掉注释后**）里已经没有注记 —— 注释里会提到这个词，不能算数；
    const p4CodeNoComments = pxSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    const hasDeprecatedMarker = p4CodeNoComments.includes('[deprecated → screen_view]')
    const p4Anchor = pxSrc.indexOf('const VIEW_TOOL_NAMES')
    const p4Region = p4Anchor >= 0 ? pxSrc.slice(Math.max(0, p4Anchor - 900), p4Anchor + 2500) : ''
    const rewritesDescriptionInFlagBranch = /def\.description\s*=/.test(p4Region)
    const residentGuidesToView = /SAFETY_PROMPT_SECTION[\s\S]{0,2500}screen_view/.test(pxSrc)
    if (!hasDeprecatedMarker && !rewritesDescriptionInFlagBranch && residentGuidesToView) {
      pass('pixel: 旧 10 个保留原描述（无 deprecated 注记），引导由常驻安全段承担 screen_view')
    } else {
      fail('pixel: 「旧 10 个不加注记 + 常驻段引导 screen_view」这组条件不成立',
        `注记:${hasDeprecatedMarker ? '仍存在' : '无'}；flag 分支改写描述:${rewritesDescriptionInFlagBranch ? '有' : '无'}；常驻段引导:${residentGuidesToView ? '有' : '无'}`)
    }

    // flag=true 的「跳过注册」必须真的把 defs 里的旧 10 个摘掉（不是只打日志/只改描述）。
    if (/VIEW_TOOL_NAMES\.has\(defs\[i\]\.name\)[\s\S]{0,120}defs\.splice\(i,\s*1\)/.test(pxSrc)) {
      pass('pixel: mergeReadSide=true 时会把旧 10 个从 defs 里 splice 掉（不是仅打日志）')
    } else {
      fail('pixel: 找不到「flag=true 摘掉旧 10 个」的实现', '只打日志/只改描述的话 flag=true 仍会注册 24 个，工具数不会变 14')
    }

    // 配置项：默认 **true**（默认态 = 合并态 = 25 工具；I2-A 用户拍板 A）；
    // 显式 false 是回退路径（一个配置项，不改代码）。clamp 走 boolIn；允许设置页改。
    if (/mergeReadSide:\s*true\b/.test(configSrc)) pass('config.js: mergeReadSide 默认 true（默认合并态：pixel 14 / 全包 25；显式 false 回退 35）')
    else fail('config.js: 找不到 mergeReadSide 的默认值 true', 'I2-A 已拍板默认 true（默认=合并态）；显式 false 才是回退，别把默认值改回 false')
    if (/mergeReadSide:\s*boolIn\(c\.mergeReadSide,\s*d\.mergeReadSide\)/.test(configSrc)) pass('config.js: mergeReadSide 走 normalizeConfig/boolIn（配置写错不会变成"真"）')
    else fail('config.js: normalizeConfig 里没有 mergeReadSide 的 clamp')
    if (/'mergeReadSide'/.test(pxSrc)) pass('index.js: mergeReadSide 在 EDITABLE_CONFIG_KEYS 里（设置页可改、无需改代码）')
    else fail('index.js: mergeReadSide 不在 EDITABLE_CONFIG_KEYS 里', '那样"回滚=改配置"就做不到，只能改文件')
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (args.measure) {
    console.log('— 测量表（--measure）—')
    console.log('engine   tool                 descChars  schemaBytes  topParams')
    for (const d of allDefs.slice().sort((a, b) => a.engine.localeCompare(b.engine) || a.name.localeCompare(b.name))) {
      console.log(`${d.engine.padEnd(8)} ${d.name.padEnd(20)} ${String(d.descriptionChars).padStart(9)} ${String(d.schemaBytes).padStart(12)} ${String(d.topLevelParams).padStart(10)}`)
    }
    console.log('')
    console.log('— 阈值（--measure）—')
    // Set 在 JSON 里会被序列化成 {}，这里转成数组便于人读/机读。
    console.log(JSON.stringify({ ...THRESHOLDS, mergedToolExempt: [...THRESHOLDS.mergedToolExempt] }, null, 2))
    console.log('')
  }
  if (args.json) {
    console.log('SURFACE_JSON ' + JSON.stringify({
      root,
      expectedTotal: EXPECTED_TOTAL,
      totals: {
        tools: allDefs.length,
        descriptionChars: totalDesc,
        schemaBytes: totalBytes,
      },
      engines: parsed.map((p) => ({ id: p.engine.id, declared: p.defs.length, expected: p.engine.names.length })),
      tools: allDefs.map((d) => ({
        engine: d.engine,
        name: d.name,
        descriptionChars: d.descriptionChars,
        schemaBytes: d.schemaBytes,
        topLevelParams: d.topLevelParams,
        paramsWrapped: d.paramsWrapped,
      })),
      fail: failed.length,
    }))
  }
  console.log(failed.length === 0
    ? `RESULT: PASS（A–H 全部通过；共 ${results.length} 条断言判据）`
    : `RESULT: FAIL（${failed.length} 条判据红）`)
  return failed.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// 12. 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
    allowExtra: false,
    measure: false,
    json: false,
    noBaseline: false,
    baseline: null,
    selftest: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = resolve(argv[++i] || args.root)
    else if (a === '--allow-extra') args.allowExtra = true
    else if (a === '--measure') args.measure = true
    else if (a === '--json') args.json = true
    else if (a === '--no-baseline') args.noBaseline = true
    else if (a === '--baseline') args.baseline = resolve(argv[++i] || '')
    else if (a === '--selftest') args.selftest = true
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`未知参数：${a}（--help 看用法）`)
  }
  return args
}

function resolveBaselinePath(root, args) {
  if (args.baseline) return existsSync(args.baseline) ? args.baseline : null
  const envPath = process.env.ASSERT_SURFACE_BASELINE
  if (envPath && existsSync(envPath)) return envPath
  for (const candidate of BASELINE_CANDIDATES) {
    const p = isAbsolute(candidate) ? candidate : resolve(root, candidate)
    if (existsSync(p)) return p
  }
  return null
}

function printHelp() {
  console.log(`用法：node tools/assert-surface.mjs [选项]

  --root <dir>        要断言的树根（默认：本脚本上一级）
  --allow-extra       A 段允许出现名单外的新工具（只 INFO）
  --measure           打印完整测量表 + 阈值
  --json              打印 SURFACE_JSON（机器可读指标）
  --no-baseline       跳过 H 快照 diff
  --baseline <path>   指定 baseline.json
  --selftest          反向自检：复制 engines/ 到临时目录，删掉 mouse_batch 定义 → 必须 exit 1；
                      恢复后 → 必须 exit 0。只在临时副本里动手，绝不改活树。
  --help              本帮助

退出码：0 = 全部 PASS；1 = 有 FAIL。
`)
}

// ---------------------------------------------------------------------------
// 13. --selftest：反向自检（证明「删工具 → 红」）
// ---------------------------------------------------------------------------

/**
 * 逐文件拷贝目录树（保留相对结构；文件按 Buffer 读写，二进制也安全）。
 *
 * 为什么不用 fs.cpSync：I1 在 dryrun-smoke 实测 Node 22 的 fs.cpSync 在**含中文的源路径**
 *（活树目录带「复用包解压」）上会崩；本脚本的 --selftest 原来正是 cpSync(engines) → 同样的坑。
 * verify 不带 --selftest 所以没暴露。这里改成逐文件 readFileSync/writeFileSync，Node 22/24 都稳。
 * 不跟随/不复制符号链接（selftest 只需要真实文件）；遇到非常规文件直接跳过。
 */
function copyDirTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = join(fromDir, entry.name)
    const to = join(toDir, entry.name)
    if (entry.isDirectory()) {
      copyDirTree(from, to)
      continue
    }
    let isFile = entry.isFile()
    if (!isFile && entry.isSymbolicLink()) {
      try { isFile = statSync(from).isFile() } catch { isFile = false }
    }
    if (!isFile) continue
    writeFileSync(to, readFileSync(from))
  }
}

function runSelftest(baseArgs) {
  console.log('assert-surface · --selftest 反向自检')
  console.log('（只把 engines/ 逐文件拷到系统临时目录，在副本里删工具；活树源码不碰）')
  const tmp = mkdtempSync(join(tmpdir(), 'assert-surface-selftest-'))
  let ok = false
  try {
    // 逐文件拷贝，不用 fs.cpSync：Node 22 在含中文的源/目标路径上 cpSync 会崩（I1 已验证）。
    copyDirTree(join(baseArgs.root, 'engines'), join(tmp, 'engines'))
    const pixelIndex = join(tmp, 'engines', 'pixel', 'index.js')
    if (!existsSync(pixelIndex)) throw new Error(`副本缺少 ${pixelIndex}`)
    const original = readFileSync(pixelIndex, 'utf8')

    // 用正式解析器定位 mouse_batch 的 define 块（不靠字符串硬匹配）
    const engine = ENGINES.find((e) => e.id === 'pixel')
    const { defs } = parseEngineSource(tmp, engine)
    const target = defs.find((d) => d.name === SELFTEST_TOOL)
    if (!target) throw new Error(`副本里找不到要删的工具 ${SELFTEST_TOOL}`)

    const broken = original.slice(0, target.span.start) + original.slice(target.span.end)
    writeFileSync(pixelIndex, broken)
    console.log(``)
    console.log(`[1/2] 已从副本删掉 ${SELFTEST_TOOL} 的定义（${target.file} 偏移 ${target.span.start}..${target.span.end}）→ 期望 exit 1`)
    const red = spawnSync(process.execPath, [SCRIPT_FILE, '--root', tmp, '--no-baseline'], { encoding: 'utf8', timeout: 120000 })
    printChildOutput(red)
    const redOk = red.status === 1 && /FAIL/.test(red.stdout || '') && new RegExp(`工具 ${SELFTEST_TOOL}|${SELFTEST_TOOL}`).test(red.stdout || '')
    console.log(`      退出码 ${red.status}（期望 1）· 输出点名 ${SELFTEST_TOOL}：${redOk ? '是' : '否'}`)
    console.log(`      → ${redOk ? 'PASS（删工具会红，且点名缺失工具）' : 'FAIL（删工具后没有按预期变红 / 没点名）'}`)

    writeFileSync(pixelIndex, original)
    console.log(``)
    console.log(`[2/2] 已把副本恢复成原样 → 期望 exit 0`)
    const green = spawnSync(process.execPath, [SCRIPT_FILE, '--root', tmp, '--no-baseline'], { encoding: 'utf8', timeout: 120000 })
    printChildOutput(green)
    const greenOk = green.status === 0 && /RESULT: PASS/.test(green.stdout || '')
    console.log(`      退出码 ${green.status}（期望 0）`)
    console.log(`      → ${greenOk ? 'PASS（恢复后全绿）' : 'FAIL（恢复后仍然不绿，说明自检环境本身有问题）'}`)

    ok = redOk && greenOk
  } catch (error) {
    console.log(`selftest 出错：${error && error.stack ? error.stack : error}`)
    ok = false
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('')
  console.log(ok ? 'SELFTEST: PASS（删工具 → exit 1 且点名；恢复 → exit 0）' : 'SELFTEST: FAIL')
  return ok ? 0 : 1
}

const SELFTEST_TOOL = 'mouse_batch'

function printChildOutput(result) {
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (!text) {
    console.log('      （子进程没有输出）')
    return
  }
  for (const line of text.split('\n')) console.log(`      | ${line}`)
}

// ---------------------------------------------------------------------------
// 14. 入口
// ---------------------------------------------------------------------------

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(String(error.message || error))
  process.exit(1)
}

if (args.help) {
  printHelp()
  process.exit(0)
}

if (args.selftest) {
  process.exit(runSelftest(args))
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  console.error('')
  console.error(`assert-surface 内部错误：${error && error.stack ? error.stack : error}`)
  process.exit(1)
}
