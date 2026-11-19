// policy.js — 人类授权窗口 + 审计链（本地安全模型）
//
// 模型：
//   - 读操作（看/列窗口/UIA 读）不需要授权。
//   - 写操作（点/拖/滚/输入/按键/开/关/热键）默认**拒绝**，直到人类开一个授权窗口。
//   - 授权窗口由人类在本机执行 tools\arm-x2.cmd 开启（默认 20 分钟），或由未来的热键 watcher 开启。
//   - 敏感动作（开程序/关窗口/系统热键）在授权窗口内仍需 confirmed: true。
//   - 每个被允许/被拒绝的动作都写审计链（seq/prev/h，sha256 链式）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readControlScope } from './gate.js'

export const WRITE_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'open', 'close',
])

// 2026-11-08（Q7 审计统一）：
//   - **授权状态**（arm.json）仍留在 %TEMP%\dsh-x2 —— 它是 gate.json 缺失时的回退授权分支，
//     只为"审计美观"去搬它会把回退逻辑一起拖下水，不值得。
//   - **审计**搬到统一目录 <data>/audit/control.jsonl，
//     <data> = DSH_HANDS_DATA_DIR || ~/.dsh/dsh-desktop-hands（与 pixel lib/gate.js 同一套约定）。
//     测试靠这个环境变量隔离，绝不写真实 ~/.dsh。
const DEFAULT_DIR = path.join(os.tmpdir(), 'dsh-x2')

/** 统一数据目录（三引擎共识）。生产默认 ~/.dsh/dsh-desktop-hands；测试用 DSH_HANDS_DATA_DIR 重定向。 */
export function handsDataDir() {
  return process.env.DSH_HANDS_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-desktop-hands')
}

/** 授权状态目录（arm.json 的父目录）。默认 %TEMP%\dsh-x2；config.policyDir 可覆盖（测试用）。 */
function stateDir(config = {}) {
  const d = config.policyDir ? String(config.policyDir) : DEFAULT_DIR
  try { fs.mkdirSync(d, { recursive: true }) } catch { /* 写的时候会报真错误 */ }
  return d
}

export function statePath(config = {}) {
  return path.join(stateDir(config), 'arm.json')
}

/**
 * 统一审计目录：config.auditDir > DSH_HANDS_DATA_DIR > ~/.dsh/dsh-desktop-hands，再下挂 audit/。
 * 注意：本函数是**纯路径计算**（不建目录），便于测试断言"默认不落在 %TEMP%\dsh-x2"。
 */
export function auditDir(config = {}) {
  if (config.auditDir) return String(config.auditDir)
  return path.join(handsDataDir(), 'audit')
}

export function auditPath(config = {}) {
  return path.join(auditDir(config), 'control.jsonl')
}

export function readState(config = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(config), 'utf8'))
    return { armedUntil: Number(j.armedUntil) || 0, cancelAt: Number(j.cancelAt) || 0, note: j.note || '' }
  } catch {
    return { armedUntil: 0, cancelAt: 0, note: '' }
  }
}

export function arm(seconds = 1200, note = 'manual', config = {}) {
  const cur = readState(config)
  const st = { armedUntil: Date.now() + Math.max(1, seconds) * 1000, cancelAt: cur.cancelAt || 0, note }
  fs.writeFileSync(statePath(config), JSON.stringify(st), 'utf8')
  return st
}

export function disarm(config = {}) {
  const st = { armedUntil: 0, cancelAt: Date.now(), note: 'disarmed' }
  fs.writeFileSync(statePath(config), JSON.stringify(st), 'utf8')
  return st
}

export function cancel(config = {}) {
  const cur = readState(config)
  const st = { armedUntil: cur.armedUntil, cancelAt: Date.now(), note: 'cancelled' }
  fs.writeFileSync(statePath(config), JSON.stringify(st), 'utf8')
  return st
}

/**
 * 检查一次动作是否放行。
 * @returns {string|null} 拒绝原因；null 表示放行
 */
export function check(action, args, config = {}) {
  if (config.armRequired === false) return null
  if (!WRITE_ACTIONS.has(String(action))) return null // 读操作/纯移动不拦

  // ④ 授权 fan-out：core gate.json 存在时它是唯一授权依据；arm.json 不再作数（手写无效）。
  const gate = readControlScope()
  if (gate !== null) {
    if (gate.armed) return null
    return [
      `这一步需要人类授权：${action} 属于会动这台电脑的操作（core gate 未开 control 授权）。`,
      '请主人在本机开一次授权窗口（fan-out 会同时开三引擎）；',
      '旧的 tools\\arm-x2.cmd 写出的 arm.json 已不再作为授权依据。',
    ].join('')
  }

  // 回滚分支：gate.json 缺失 → 沿用旧 arm.json。
  const st = readState(config)
  const now = Date.now()
  if (st.cancelAt && st.cancelAt > now - 1000) {
    return '刚刚被停止（disarm/cancel）。要动手请让主人在本机运行 tools\\arm-x2.cmd 重新开一个授权窗口。'
  }
  if (!(st.armedUntil > now)) {
    const keep = st.armedUntil ? Math.round((now - st.armedUntil) / 1000) : null
    const tail = keep !== null ? `（上一次授权已于 ${keep} 秒前过期）` : ''
    return [
      `这一步需要人类授权：${action} 属于会动这台电脑的操作${tail}。`,
      '请主人本机执行 tools\\arm-x2.cmd（默认开 20 分钟），或执行 tools\\arm-x2.cmd 60 开 60 分钟；',
      '授权窗口内才能点击/输入/开关窗口。',
    ].join('')
  }
  return null
}

/** 敏感动作在授权窗口内仍需逐次 confirmed */
export function needsConfirm(action, args) {
  if (action === 'close' || action === 'open') return true
  if (action === 'hotkey') return true
  return false
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function lastLine(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trimEnd()
    if (!txt) return null
    const lines = txt.split('\n')
    return JSON.parse(lines[lines.length - 1])
  } catch { return null }
}

// 审计写失败的统一出口：默认 console.warn，index.js apply 时改接 ctx.logger.warn。
// 语义：**只警告、不隐瞒**——工具继续工作，但这一笔确实没有留痕，日志里必须能看见。
let auditErrorHandler = null

export function setAuditErrorHandler(fn) {
  auditErrorHandler = typeof fn === 'function' ? fn : null
}

function reportAuditError(error) {
  const detail = error && error.message ? error.message : String(error)
  if (auditErrorHandler) {
    try {
      auditErrorHandler(error)
      return
    } catch { /* 处理器自己坏了也不能影响工具 */ }
  }
  try {
    console.warn(`[dsh-x2] 审计写入失败（这一笔没有留痕）: ${detail}`)
  } catch { /* ignore */ }
}

/** 追加一条审计（hash 链：seq/prev/h；b 保存规范化后的正文，便于独立校验） */
export function audit(entry, config = {}) {
  const file = auditPath(config)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch { /* 目录建不出来时由 append 报出真实错误 */ }
  try {
    const prev = lastLine(file)
    const seq = prev ? prev.seq + 1 : 1
    const prevH = prev ? prev.h : '0'.repeat(64)
    const b = JSON.stringify({ seq, t: new Date().toISOString(), ...entry })
    const h = sha(b + prevH)
    fs.appendFileSync(file, JSON.stringify({ seq, b, prev: prevH, h }) + '\n', 'utf8')
    return { seq, h }
  } catch (error) {
    reportAuditError(error)
    throw error // 保持旧契约：想 fail-soft 的调用方用 safeAudit()
  }
}

/**
 * fail-soft 版本：审计失败**不抛**（工具不崩），返回 {ok:false,error}。
 * 调用方据此知道"这一笔没写成"——绝不假装写过。
 */
export function safeAudit(entry, config = {}) {
  try {
    const r = audit(entry, config)
    return { ok: true, seq: r.seq, h: r.h }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/** 校验整条链，返回第一个断点（无断点返回 null） */
export function verifyAudit(config = {}) {
  let txt = ''
  try { txt = fs.readFileSync(auditPath(config), 'utf8') } catch { return null }
  const lines = txt.split('\n').filter(Boolean)
  let prevH = '0'.repeat(64)
  for (let i = 0; i < lines.length; i++) {
    let row
    try { row = JSON.parse(lines[i]) } catch { return { seq: i + 1, reason: 'parse' } }
    if (row.seq !== i + 1) return { seq: row.seq, reason: 'seq' }
    if (row.prev !== prevH) return { seq: row.seq, reason: 'prev' }
    if (row.h !== sha(String(row.b) + prevH)) return { seq: row.seq, reason: 'hash' }
    prevH = row.h
  }
  return null
}
