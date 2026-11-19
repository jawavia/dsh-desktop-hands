// audit.js — dsh-stroke 的最小审计（Q7 审计统一，2026-11-08）
//
// 为什么是"最小"：pixel 的 ~/.dsh/click-matrix/audit.jsonl 是**历史主链**（schema v2 + hash 链），
// control 有自己成熟的 seq/prev/h 链；stroke v0.1 **一条审计都不写**（全仓 grep 无 audit）。
// 这一层只承诺一件必须为真的事：**每一次工具调用，磁盘上多一行可解析的记录**。
//
// 行格式（JSONL，一行一条，追加写，不轮转）：
//   {"engine":"stroke","seq":1,"t":"2026-11-08T02:30:00.000Z","tool":"stroke_draw",
//    "decision":"ok","reason":"...","callId":"uuid","dryRun":true}
//   - decision: ok | denied | error
//   - reason: 拒绝原因 / 错误信息（可选）
//   - callId: 本次调用的随机 id；append 之后会**回读校验**它确实在盘上
//   - dryRun: 仅在 dryRun:true 的 stroke_draw 上出现 —— 预演不注入，不能记成"执行过"
//
// 位置：<DSH_HANDS_DATA_DIR || ~/.dsh/dsh-desktop-hands>/audit/stroke.jsonl
//   DSH_HANDS_DATA_DIR 与 pixel lib/gate.js、control policy.js 是同一个约定（测试隔离用）。
//
// 失败语义（重要）：写失败**不抛**，返回 {ok:false,error}。
//   调用方（index.js 的 add 包装器）决定要不要在工具返回值里明说"未留痕"；
//   arm / stop / draw(真发) / diag 必须明说 —— 宁可让用户看到"没留痕"，
//   也不能让它看起来像写成了（"看似有痕实际没写"是本项目明确禁止的失败模式）。
//
// 已知限制：没有 hash 链（改一行不会被发现）；seq 只保证**单进程内**单调递增，
//   同时开第二个 DSH 实例写同一个文件时可能撞号。这两条都写进 _merge/AUDIT/说明.md。
//
// 人工校验：逐行 JSON.parse 即可；自测：node engines/stroke/test/audit-smoke.mjs
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ENGINE = 'stroke'
const FILE_NAME = 'stroke.jsonl'
const TAIL_BYTES = 16 * 1024

/** 统一数据目录（三引擎共识）。生产默认 ~/.dsh/dsh-desktop-hands；测试用 DSH_HANDS_DATA_DIR 重定向。 */
export function handsDataDir() {
  return process.env.DSH_HANDS_DATA_DIR || join(homedir(), '.dsh', 'dsh-desktop-hands')
}

/** 审计文件路径。纯路径计算（不建目录），便于测试断言。 */
export function auditPath(dataDir) {
  return join(dataDir || handsDataDir(), 'audit', FILE_NAME)
}

/** 读文件尾部（用于取 seq / 回读校验，避免每次读整份日志）。 */
function readTail(file, bytes = TAIL_BYTES) {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** 从尾部找出最后一条可解析的 seq；尾部有半行/坏行就继续往前找。 */
function lastSeq(file) {
  const lines = readTail(file).split('\n').filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i])
      const n = Number(j && j.seq)
      if (Number.isFinite(n) && n >= 0) return n
    } catch { /* 坏行继续往前 */ }
  }
  return 0
}

// 进程内 seq 缓存。appendAudit 全程同步（没有 await 打断），
// 所以同一进程内并发工具调用不会交错；跨进程的撞号见文件头"已知限制"。
const seqCache = new Map()

/**
 * 追加一条审计。绝不抛异常。
 * @param {{tool:string,decision?:'ok'|'denied'|'error',reason?:string,callId?:string,dryRun?:boolean}} entry
 * @param {{path?:string,dataDir?:string}} [options]
 * @returns {{ok:boolean,seq?:number,path:string,error?:string}}
 */
export function appendAudit(entry, options = {}) {
  const file = options.path || auditPath(options.dataDir)
  const callId = entry && entry.callId ? String(entry.callId) : ''
  try {
    mkdirSync(dirname(file), { recursive: true })
    const cached = seqCache.get(file)
    const seq = (cached === undefined ? lastSeq(file) : cached) + 1
    const line = JSON.stringify({
      engine: ENGINE,
      seq,
      t: new Date().toISOString(),
      tool: entry && entry.tool ? String(entry.tool) : 'unknown',
      decision: entry && (entry.decision === 'denied' || entry.decision === 'error') ? entry.decision : 'ok',
      ...(entry && entry.reason ? { reason: String(entry.reason) } : {}),
      ...(callId ? { callId } : {}),
      ...(entry && entry.dryRun === true ? { dryRun: true } : {}),
    })
    appendFileSync(file, line + '\n', 'utf8')
    // 回读校验：确认这一行真的在盘上。缓存、只读层、被杀进程都可能让 append "看似成功"。
    if (callId && !readTail(file).includes(callId)) {
      seqCache.delete(file)
      return { ok: false, path: file, error: `写入后回读没找到本行（callId=${callId}），这一笔可能没落盘` }
    }
    seqCache.set(file, seq)
    return { ok: true, seq, path: file }
  } catch (error) {
    seqCache.delete(file)
    return { ok: false, path: file, error: error && error.message ? error.message : String(error) }
  }
}

/** 读全部行并逐行 parse（校验/自测用；返回 {rows, badLines}）。 */
export function readAudit(file) {
  const rows = []
  const badLines = []
  let txt = ''
  try {
    txt = readFileSync(file, 'utf8')
  } catch (error) {
    return { rows, badLines, error: error && error.message ? error.message : String(error) }
  }
  for (const [i, line] of txt.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      badLines.push(i + 1)
    }
  }
  return { rows, badLines }
}
