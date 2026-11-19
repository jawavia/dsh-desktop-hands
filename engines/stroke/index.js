/**
 * dsh-stroke — 渐进式"笔势执行器"插件（v0.1，独立于 dsh-click-matrix）。
 *
 * 目标：把预先算好的点列（含时间戳）一次调用流畅地播放成真实鼠标输入。
 * 设计：会话级授权（stroke_arm 一次开启画布会话，之后不逐笔审批）；
 *       画布范围内暂不做 deny/自身窗口等安全判定；保留区域限制、点数上限与硬停止。
 *
 * 工具：
 *   stroke_status  — 会话/helper 状态（只读）
 *   stroke_arm     — 开启会话：{seconds?, region?, maxPoints?}
 *   stroke_draw    — 播放一笔或多笔：{strokes:[{points:[{x,y,t}]}], button?, dryRun?}
 *   stroke_stop    — 停止（helper 侧 abort 标志 + 会话失效）
 *
 * 运行时只用 Node 内建模块；helper 是 runtime/stroke-helper.exe（由本插件按需拉起，
 * 因此运行在 DSH 宿主进程的桌面/完整性级别上——这是能注入真实输入的前提）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
// 2026-11-08（Q7 审计统一）：stroke 以前一条审计都不写；现在每次工具调用写一行。
import { appendAudit } from './audit.js'

const PLUGIN_VERSION = '0.1.0'
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string' } },
})
const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), 'runtime')
const DEFAULT_HELPER = join(RUNTIME_DIR, 'stroke-helper.exe')
const PS_HELPER = join(RUNTIME_DIR, 'stroke-helper.ps1')

const DEFAULTS = Object.freeze({
  armSeconds: 120,
  maxPoints: 20000,
  maxStrokes: 500,
  maxStrokePoints: 5000,
  intervalMs: 8,
  helperPort: 0,
})

// ---------------------------------------------------------------------------
// helper client (line protocol, see runtime/stroke-helper.cs)
// ---------------------------------------------------------------------------
class StrokeHelper {
  constructor(exePath, log, port) {
    this.exePath = exePath
    this.log = log
    this.child = null
    this.ready = null
    this.lastError = ''
    this.pending = new Map()
    this.stopWaiter = null
    this.statusWaiter = null
    this.buffer = ''
  }

  get running() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed)
  }

  async ensure() {
    if (this.running) return this.ready
    if (!existsSync(PS_HELPER)) throw new Error(`helper 脚本不存在: ${PS_HELPER}`)
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_HELPER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.buffer = ''
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('helper 启动超时（未收到 READY）')), 8000)
      this._readyResolve = (v) => {
        clearTimeout(timer)
        resolve(v)
      }
      this._readyReject = (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.lastError = String(chunk).trim().slice(0, 300)
    })
    child.on('exit', (code) => {
      this.lastError = this.lastError || `helper 退出 code=${code}`
      for (const [, p] of this.pending) {
        p.resolve({ sent: 0, elapsed: 0, aborted: 1, reason: `helper-exit:${code}`, error: true })
      }
      this.pending.clear()
      this.ready = null
      if (this._readyReject) this._readyReject(new Error(`helper 退出 code=${code}`))
    })
    const info = await this.ready
    return info
  }

  async #ensureTcp() {
    if (this.socket && !this.socket.destroyed) return { tcp: true }
    await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port })
      const timer = setTimeout(() => { try { sock.destroy() } catch {} ; reject(new Error('helper TCP 连接超时: ' + this.port)) }, 4000)
      sock.setEncoding('utf8')
      sock.once('connect', () => { clearTimeout(timer); this.socket = sock; resolve() })
      sock.once('error', (e) => { clearTimeout(timer); reject(new Error('helper TCP 连接失败: ' + (e && e.message))) })
      sock.on('data', (chunk) => this.#onData(chunk))
      sock.on('close', () => { this.socket = null })
    })
    return { tcp: true }
  }

  #send(line) {
    if (this.socket && !this.socket.destroyed) { this.socket.write(line); return true }
    if (this.child && this.child.stdin) { this.child.stdin.write(line); return true }
    return false
  }

  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) this.#onLine(line)
    }
  }

  #onLine(line) {
    if (line.startsWith('READY')) {
      if (this._readyResolve) {
        this._readyResolve({ pid: quotePid(line), line })
        this._readyResolve = null
      }
      return
    }
    if (line.startsWith('DONE ')) {
      const m = line.match(/^DONE (\S+) sent=(\d+) elapsed=(\d+) aborted=(\d+) reason=(.*)$/)
      if (!m) return
      const entry = this.pending.get(m[1])
      if (!entry) return
      this.pending.delete(m[1])
      entry.resolve({
        id: m[1],
        sent: Number(m[2]),
        elapsed: Number(m[3]),
        aborted: m[4] === '1',
        reason: m[5] || 'ok',
      })
      return
    }
    if (line.startsWith('OK stop')) {
      if (this.stopWaiter) {
        this.stopWaiter.resolve(true)
        this.stopWaiter = null
      }
      return
    }
    if (line.startsWith('SELFTEST') || line.startsWith('SHOT')) {
      if (this.diagWaiter) {
        const waiter = this.diagWaiter
        this.diagWaiter = null
        waiter.resolve(line)
      }
      return
    }
    if (line.startsWith('STATUS ')) {
      if (this.statusWaiter) {
        this.statusWaiter.resolve(line)
        this.statusWaiter = null
      }
      return
    }
    if (line.startsWith('ERR ')) {
      this.lastError = line.slice(4)
    }
  }

  async draw(button, points) {
    await this.ensure()
    const id = randomUUID().slice(0, 8)
    const spec = points.map((p) => `${p.x},${p.y},${p.t}`).join(';')
    const lastT = points.length > 0 ? points[points.length - 1].t : 0
    const timeout = Math.max(10000, Number(lastT) + 15000)
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ sent: 0, elapsed: 0, aborted: 1, reason: 'timeout', error: true })
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject,
      })
    })
    this.child.stdin.write(`DRAW ${id} ${button === 'R' ? 'R' : 'L'} ${spec}\n`)
    return promise
  }

  async stop() {
    if (!this.running) return false
    const promise = new Promise((resolve) => {
      this.stopWaiter = { resolve }
      setTimeout(() => resolve(false), 3000)
    })
    try {
      this.child.stdin.write('STOP\n')
    } catch {
      return false
    }
    return promise
  }

  async selftest(x, y) {
    await this.ensure()
    return this.#diag('SELFTEST ' + Math.round(x) + ' ' + Math.round(y))
  }

  async shot(path, hwnd) {
    await this.ensure()
    return this.#diag('SHOT ' + path + (hwnd ? ' ' + Math.round(hwnd) : ''))
  }

  #diag(commandLine) {
    const promise = new Promise((resolve) => {
      this.diagWaiter = { resolve }
      setTimeout(() => resolve('DIAG timeout'), 8000)
    })
    this.#send(commandLine + String.fromCharCode(10))
    return promise
  }

  async status() {
    if (!this.running) return 'NOT-RUNNING'
    const promise = new Promise((resolve) => {
      this.statusWaiter = { resolve }
      setTimeout(() => resolve('STATUS timeout'), 3000)
    })
    try {
      this.child.stdin.write('STATUS\n')
    } catch {
      return 'STATUS write-failed'
    }
    return promise
  }

  dispose() {
    try {
      if (this.running) this.child.stdin.write('QUIT\n')
    } catch {
      /* ignore */
    }
    try {
      if (this.child) this.child.kill()
    } catch {
      /* ignore */
    }
    this.child = null
    this.ready = null
  }
}

function quotePid(line) {
  const m = line.match(/pid=(\d+)/)
  return m ? Number(m[1]) : 0
}

// ---------------------------------------------------------------------------
// session state + validation
// ---------------------------------------------------------------------------
function createState(config) {
  return {
    config,
    helper: new StrokeHelper(config.helperPath, (m) => log(config, m), config.helperPort),
    session: null, // { expiresAt, region, maxPoints, armedAt }
    disposed: false,
  }
}

function log(config, message) {
  try {
    if (config.logger && typeof config.logger.info === 'function') config.logger.info(`[dsh-stroke] ${message}`)
  } catch {
    /* ignore */
  }
}

function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
  const int = (v, min, max, d) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d
  }
  return {
    helperPath: typeof cfg.helperPath === 'string' && cfg.helperPath ? cfg.helperPath : DEFAULT_HELPER,
    armSeconds: int(cfg.armSeconds, 1, 3600, DEFAULTS.armSeconds),
    maxPoints: int(cfg.maxPoints, 1, 200000, DEFAULTS.maxPoints),
    maxStrokes: int(cfg.maxStrokes, 1, 5000, DEFAULTS.maxStrokes),
    maxStrokePoints: int(cfg.maxStrokePoints, 1, 50000, DEFAULTS.maxStrokePoints),
    intervalMs: int(cfg.intervalMs, 1, 1000, DEFAULTS.intervalMs),
    helperPort: int(cfg.helperPort, 0, 65535, DEFAULTS.helperPort),
    // 审计文件覆盖（测试/特殊部署用）；正常留空 → audit.js 按 DSH_HANDS_DATA_DIR 推路径。
    auditPath: typeof cfg.auditPath === 'string' && cfg.auditPath ? cfg.auditPath : '',
    logger: cfg.logger,
  }
}

function sessionInfo(state) {
  // ④ 授权 fan-out：core gate.json 存在时它是唯一授权依据；否则回退本会话（旧分支）。
  const gate = readStrokeScope()
  if (gate !== null) {
    const remaining = Math.max(0, Math.round((gate.armedUntil - Date.now()) / 1000))
    return { armed: gate.armed, remaining, region: null, maxPoints: 0, via: 'gate' }
  }
  const s = state.session
  if (!s) return { armed: false }
  const remaining = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000))
  return { armed: remaining > 0, remaining, region: s.region, maxPoints: s.maxPoints, via: 'session' }
}

/**
 * 统一数据目录。2026-11-08：也认 DSH_HANDS_DATA_DIR（与 pixel lib/gate.js、control gate.js 同一约定）。
 * 生产不设这个变量 → 行为与以前完全一致；测试设了它 → 连"读授权"一起隔离，
 * 不会在跑测试时读到真人的 gate.json / stop.signal。
 */
function dataDir() {
  return process.env.DSH_HANDS_DATA_DIR || join(homedir(), '.dsh', 'dsh-desktop-hands')
}

/** ④：读共享 gate.json 的 stroke scope；缺失/损坏返回 null（回退会话授权）。 */
function readStrokeScope() {
  try {
    const p = join(dataDir(), 'gate.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const armedUntil = Number(j.armedUntil) || 0
    const stroke = j && j.scopes && j.scopes.stroke
    const armed = armedUntil > Date.now() && !!(stroke && stroke.armed === true)
    return { armed, armedUntil }
  } catch {
    return null
  }
}

/** ⑤ StopBus：读 stop.signal token；缺失/损坏返回 null。 */
function readStopToken() {
  try {
    const p = join(dataDir(), 'stop.signal')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { level: j.level === 'soft' ? 'soft' : 'hard', at: Number(j.at) || 0, by: j.by || '', reason: j.reason || '' }
  } catch {
    return null
  }
}

function parseRegion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const w = Number(raw.w)
  const h = Number(raw.h)
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}


// v0.2: function-based strokes. A stroke may be {curves:[...]} instead of a dense
// point list; the plugin samples the geometry with chord-height tolerance eps:
//   {line:[x1,y1,x2,y2]}
//   {arc:[cx,cy,rx,ry,a0deg,a1deg]}      (chord height <= eps -> step angle)
//   {circle:[cx,cy,r]}
//   {bezier:[[x0,y0],[x1,y1],[x2,y2],[x3,y3]]}   (recursive flattening)
function sampleCurves(curves, eps, intervalMs) {
  const pts = []
  const push = (x, y) => {
    const px = Math.round(x)
    const py = Math.round(y)
    const last = pts.length > 0 ? pts[pts.length - 1] : null
    if (last && last.x === px && last.y === py) return
    pts.push({ x: px, y: py })
  }
  const stepAngle = (r) => {
    const rr = Math.max(1, r)
    const t = Math.max(-1, Math.min(1, 1 - eps / rr))
    const dA = 2 * Math.acos(t)
    return Math.min(Math.PI / 6, Math.max(dA, Math.PI / 180))
  }
  const flattenBezier = (p0, p1, p2, p3, depth) => {
    const dx = p3[0] - p0[0]
    const dy = p3[1] - p0[1]
    const d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx)
    const d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx)
    const len = Math.hypot(dx, dy) || 1
    const flat = Math.max(d1, d2) / len
    if (flat <= eps || depth >= 12) {
      push(p3[0], p3[1])
      return
    }
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const p01 = mid(p0, p1)
    const p12 = mid(p1, p2)
    const p23 = mid(p2, p3)
    const p012 = mid(p01, p12)
    const p123 = mid(p12, p23)
    const p = mid(p012, p123)
    flattenBezier(p0, p01, p012, p, depth + 1)
    flattenBezier(p, p123, p23, p3, depth + 1)
  }
  for (const c of curves) {
    if (!c || typeof c !== 'object') continue
    if (Array.isArray(c.line) && c.line.length >= 4) {
      push(c.line[0], c.line[1])
      push(c.line[2], c.line[3])
    } else if (Array.isArray(c.arc) && c.arc.length >= 6) {
      const [cx, cy, rx, ry, a0, a1] = c.arc
      const r = Math.max(Math.abs(rx), Math.abs(ry))
      const da = stepAngle(r)
      const total = (a1 - a0) * Math.PI / 180
      const n = Math.max(2, Math.ceil(Math.abs(total) / da))
      for (let i = 0; i <= n; i++) {
        const a = (a0 * Math.PI / 180) + (total * i) / n
        push(cx + rx * Math.cos(a), cy + ry * Math.sin(a))
      }
    } else if (Array.isArray(c.circle) && c.circle.length >= 3) {
      const [cx, cy, r] = c.circle
      const da = stepAngle(r)
      const n = Math.max(8, Math.ceil((2 * Math.PI) / da))
      for (let i = 0; i <= n; i++) {
        const a = (2 * Math.PI * i) / n
        push(cx + r * Math.cos(a), cy + r * Math.sin(a))
      }
    } else if (Array.isArray(c.bezier) && c.bezier.length >= 4) {
      const [p0, p1, p2, p3] = c.bezier
      push(p0[0], p0[1])
      flattenBezier(p0, p1, p2, p3, 0)
    }
  }
  return pts.map((p, i) => ({ x: p.x, y: p.y, t: i * intervalMs }))
}

function normalizeStrokes(state, args) {
  const eps = Number.isFinite(Number(args.epsilon)) ? Math.max(0.05, Math.min(5, Number(args.epsilon))) : 0.25
  const list = Array.isArray(args.strokes) ? args.strokes : []
  if (list.length === 0) throw new Error('strokes 需要非空数组：每项 {points:[{x,y,t}]}')
  if (list.length > state.config.maxStrokes) throw new Error(`笔画数 ${list.length} 超过上限 ${state.config.maxStrokes}`)
  const button = args.button === 'R' ? 'R' : 'L'
  let total = 0
  const out = []
  for (let i = 0; i < list.length; i++) {
    const strokeIn = list[i] && typeof list[i] === 'object' ? list[i] : null
    if (!strokeIn) throw new Error(`第 ${i + 1} 笔无效`)
    let ptsRaw = null
    if (Array.isArray(strokeIn.curves) && strokeIn.curves.length > 0) {
      ptsRaw = sampleCurves(strokeIn.curves, eps, state.config.intervalMs)
    } else if (Array.isArray(strokeIn.points)) {
      ptsRaw = strokeIn.points
    }
    if (!ptsRaw || ptsRaw.length === 0) throw new Error(`第 ${i + 1} 笔缺少 points`)
    if (ptsRaw.length > state.config.maxStrokePoints) throw new Error(`第 ${i + 1} 笔点数 ${ptsRaw.length} 超过上限 ${state.config.maxStrokePoints}`)
    let t = 0
    const pts = ptsRaw.map((p, j) => {
      const x = Number(p && p.x)
      const y = Number(p && p.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`第 ${i + 1} 笔第 ${j + 1} 个点坐标无效`)
      const tt = Number(p && p.t)
      t = Number.isFinite(tt) ? Math.max(0, Math.round(tt)) : j * state.config.intervalMs
      return { x: Math.round(x), y: Math.round(y), t }
    })
    for (let j = 1; j < pts.length; j++) {
      if (pts[j].t < pts[j - 1].t) pts[j].t = pts[j - 1].t
    }
    total += pts.length
    out.push({ points: pts })
  }
  if (total > state.config.maxPoints) throw new Error(`总点数 ${total} 超过上限 ${state.config.maxPoints}`)
  const region = state.session && state.session.region ? state.session.region : null
  if (region) {
    for (const stroke of out) {
      for (const p of stroke.points) {
        if (p.x < region.x || p.y < region.y || p.x > region.x + region.w || p.y > region.y + region.h) {
          throw new Error(`点 (${p.x},${p.y}) 超出会话区域 (${region.x},${region.y} ${region.w}x${region.h})`)
        }
      }
    }
  }
  return { button, strokes: out, total }
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------
// 2026-11-08（Q7 审计统一）：这一层包装器是**唯一**的审计写入点——
// 每个工具调用 → 写一行 <data>/audit/stroke.jsonl（seq/t/tool/decision/reason/callId）。
// 这么做的原因：审计写在包装层，就不可能"某个工具忘了写"；而且 denied/error 也走同一条路
// （工具用返回值 {text, decision, reason} 表达"拒绝了/失败了"，包装器照实记，不猜）。
const AUDIT_MUST_SURFACE = new Set(['stroke_arm', 'stroke_diag', 'stroke_stop'])

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function buildToolDefinitions(state) {
  const defs = []
  const add = (name, description, parameters, execute) => {
    defs.push({
      name,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : '' }],
      },
      execute: async (args) => {
        const input = args && typeof args === 'object' ? args : {}
        const callId = randomUUID()
        // 预演不注入输入：审计里必须能区分"预演"和"真发"，不能都记成 ok 执行。
        const dryRun = name === 'stroke_draw' && input.dryRun === true
        let text = ''
        let decision = 'ok'
        let reason = ''
        try {
          const result = await execute(input)
          if (result && typeof result === 'object') {
            text = typeof result.text === 'string' ? result.text : ''
            if (result.decision === 'denied' || result.decision === 'error') decision = result.decision
            if (result.reason) reason = String(result.reason)
          } else {
            text = result == null ? '' : String(result)
          }
        } catch (error) {
          decision = 'error'
          reason = messageOf(error)
          text = `dsh-stroke 错误: ${reason}`
        }
        const record = { tool: name, decision, callId }
        if (reason) record.reason = reason
        if (dryRun) record.dryRun = true
        const write = appendAudit(record, state.config.auditPath ? { path: state.config.auditPath } : {})
        if (!write.ok) {
          // 会改授权 / 会注入输入的动作：审计没写成必须在返回值里明说，不能只留日志。
          const mustSurface = AUDIT_MUST_SURFACE.has(name) || (name === 'stroke_draw' && !dryRun)
          if (mustSurface) {
            text += `${text ? '\n' : ''}⚠️ 审计未留痕：这一笔没有写进 ${write.path}（${write.error}）。`
              + '本次动作已生效/已执行，但没有审计记录——请把这条消息本身当证据。'
          } else {
            log(state.config, `审计写入失败（${name}）: ${write.error}`)
          }
        }
        return { text }
      },
    })
  }

  add(
    'stroke_status',
    'dsh-stroke 状态（只读）：helper 进程/会话剩余时间/区域/上限，以及 helper 的 playing 状态。',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const info = sessionInfo(state)
      const helperLine = await state.helper.status().catch(() => 'STATUS error')
      const lines = [
        `dsh-stroke ${PLUGIN_VERSION}`,
        `会话: ${info.armed ? `已授权 · 剩余 ${info.remaining}s` : '未授权（先 stroke_arm）'}`,
        info.region ? `区域: (${info.region.x},${info.region.y} ${info.region.w}x${info.region.h})` : '区域: 未限制',
        `上限: points=${info.maxPoints || state.config.maxPoints} strokes=${state.config.maxStrokes}`,
        `helper: ${state.helper.running ? 'running' : 'stopped'}${state.helper.lastError ? ` · ${state.helper.lastError}` : ''}`,
        `helper 状态: ${helperLine}`,
      ]
      return lines.join('\n')
    },
  )

  add(
    'stroke_arm',
    '开启一笔会话（会话级授权，之后不再逐笔审批）：{seconds?, region?, maxPoints?}。画布范围内暂不做 deny/自身窗口判定；保留区域限制、点数上限与硬停止（Esc/F11/STOP）。',
    {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '授权秒数（默认 120）' },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          description: '允许注入的屏幕物理矩形（建议=画布区域）',
        },
        maxPoints: { type: 'number', description: '本次会话总点数上限（默认 20000）' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const seconds = Number.isFinite(Number(args.seconds)) ? Math.max(1, Math.min(3600, Math.round(Number(args.seconds)))) : state.config.armSeconds
      const region = parseRegion(args.region)
      const maxPoints = Number.isFinite(Number(args.maxPoints)) ? Math.max(1, Math.min(200000, Math.round(Number(args.maxPoints)))) : state.config.maxPoints
      await state.helper.ensure()
      state.session = { armedAt: Date.now(), expiresAt: Date.now() + seconds * 1000, region, maxPoints }
      return [
        `已开启笔势会话：${seconds}s，region=${region ? `(${region.x},${region.y} ${region.w}x${region.h})` : '未限制'}，maxPoints=${maxPoints}`,
        '期间 stroke_draw 不再逐笔申请授权；Esc/F11/STOP 可随时硬停。',
      ].join('\n')
    },
  )

  add(
    'stroke_draw',
    '播放一笔或多笔平滑鼠标笔画：{strokes:[{points:[{x,y,t}]}], button?, dryRun?}。一次调用=一批笔；返回每笔实发点数/耗时/是否中断。',
    {
      type: 'object',
      properties: {
        strokes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              points: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' }, t: { type: 'number' } },
                  required: ['x', 'y'],
                  additionalProperties: false,
                },
              },
            },
            required: ['points'],
            additionalProperties: false,
          },
        },
        epsilon: { type: 'number', description: '弦高容差 ε（px，默认 0.25）' },
        button: { type: 'string', enum: ['L', 'R'], description: '鼠标键，默认 L' },
        dryRun: { type: 'boolean', description: 'true=只校验并回报统计，不注入' },
      },
      required: ['strokes'],
      additionalProperties: false,
    },
    async (args) => {
      const info = sessionInfo(state)
      if (!info.armed) {
        // 拒绝也要留痕：包装器会照 decision:'denied' 写一行（不是 error，也不是假装执行过）。
        return { text: '未开启会话：先调用 stroke_arm({region, seconds})。', decision: 'denied', reason: 'not-armed-or-session-expired' }
      }
      const plan = normalizeStrokes(state, args)
      const stats = { strokes: plan.strokes.length, points: plan.total, elapsed: 0, sent: 0, aborted: false, perStroke: [] }
      if (args.dryRun === true) {
        return `dryRun：${plan.strokes.length} 笔 / ${plan.total} 点，预计约 ${Math.round((plan.strokes[plan.total - 1] ? 0 : 0) || 0)}ms；region 校验通过。`
      }
      await state.helper.ensure()
      for (let i = 0; i < plan.strokes.length; i++) {
        // ⑤ StopBus：hard 在笔画间立即断；soft 到本笔画边界（本笔画完成后停）。
        const stopToken = readStopToken()
        if (stopToken && stopToken.level === 'hard') {
          stats.aborted = true
          stats.perStroke.push({ index: i + 1, points: 0, sent: 0, elapsed: 0, aborted: true, reason: `hard stop (${stopToken.by})` })
          break
        }
        const stroke = plan.strokes[i]
        const res = await state.helper.draw(plan.button, stroke.points)
        stats.sent += res.sent
        stats.elapsed += res.elapsed
        if (res.aborted) stats.aborted = true
        stats.perStroke.push({ index: i + 1, points: stroke.points.length, sent: res.sent, elapsed: res.elapsed, aborted: res.aborted, reason: res.reason })
        if (res.aborted) break
        if (stopToken && stopToken.level === 'soft') break // 本笔画完成，soft 停
      }
      const lines = [
        `笔势结果：${stats.perStroke.length}/${plan.strokes.length} 笔 · 实发 ${stats.sent}/${plan.total} 点 · 合计 ${stats.elapsed}ms${stats.aborted ? ' · 已中断' : ''}`,
        ...stats.perStroke.map((s) => `  ${s.index}. ${s.sent}/${s.points} 点 ${s.elapsed}ms${s.aborted ? ` 中断(${s.reason})` : ''}`),
      ]
      if (!stats.aborted && state.session) state.session.pointsUsed = (state.session.pointsUsed || 0) + stats.sent
      return lines.join('\n')
    },
  )

  add(
    'stroke_diag',
    '诊断（会真的移动一次光标）：让 helper 做 SetCursorPos 自检并报告 before/after；可选把前台窗口 PrintWindow 截到 shotPath。',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: '自检目标 x（默认 1000）' },
        y: { type: 'number', description: '自检目标 y（默认 600）' },
        shotPath: { type: 'string', description: '可选：截图保存路径（PNG）' },
        hwnd: { type: 'number', description: '可选：要截图的目标窗口句柄（默认前台窗口）' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const x = Number.isFinite(Number(args.x)) ? Math.round(Number(args.x)) : 1000
      const y = Number.isFinite(Number(args.y)) ? Math.round(Number(args.y)) : 600
      const lines = ['dsh-stroke 诊断']
      const helperState = await state.helper.status().catch(() => 'STATUS error')
      lines.push('helper: ' + helperState)
      const st = await state.helper.selftest(x, y)
      lines.push('自检: ' + st)
      if (typeof args.shotPath === 'string' && args.shotPath) {
        const sh = await state.helper.shot(args.shotPath, args.hwnd)
        lines.push('截图: ' + sh)
      }
      return lines.join(String.fromCharCode(10))
    },
  )
  add(
    'stroke_stop',
    '停止笔势播放（helper abort 标志）并让当前会话失效。',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const ok = await state.helper.stop().catch(() => false)
      state.session = null
      return `已停止：abort=${ok ? '已发送' : 'helper 未运行'}；会话已失效。`
    },
  )

  return defs
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  // 审计写失败的 logger.warn 需要宿主 logger；config 里没给就借 ctx.logger。
  if (!cfg.logger && ctx && ctx.logger) cfg.logger = ctx.logger
  const state = createState(cfg)
  const disposers = []
  let installed = false
  let retryTimer = null
  let installRetries = 0

  const cleanup = () => {
    if (state.disposed) return
    state.disposed = true
    if (retryTimer) clearTimeout(retryTimer)
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
    try {
      state.helper.dispose()
    } catch {
      /* ignore */
    }
  }

  const install = (scope) => {
    if (state.disposed) return true
    if (installed) return true
    const tools = (scope && scope.tools) || (typeof (scope && scope.get) === 'function' ? scope.get('tools') : null) || ctx.tools
    if (!tools || typeof tools.register !== 'function') return false
    let defs = []
    try {
      defs = buildToolDefinitions(state)
    } catch (error) {
      log(cfg, `构建工具定义失败: ${error && error.message ? error.message : error}`)
    }
    for (const def of defs) {
      try {
        const dispose = tools.register(def)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        log(cfg, `工具 ${def.name} 注册失败: ${error && error.message ? error.message : error}`)
      }
    }
    installed = true
    return true
  }

  const runInstall = () => {
    const attempt = (scope) => {
      if (state.disposed) return
      try {
        install(scope)
      } catch (error) {
        log(cfg, `安装失败: ${error && error.message ? error.message : error}`)
      }
    }
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], (toolCtx) => attempt(toolCtx))
      } catch {
        /* sync path below */
      }
    }
    attempt(ctx)
    const scheduleRetry = () => {
      if (installed || state.disposed || installRetries >= 40) return
      installRetries += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        attempt(ctx)
        if (!installed) scheduleRetry()
      }, 500)
      if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
    }
    scheduleRetry()
  }

  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(
        () => {
          runInstall()
          return cleanup
        },
        'dsh-stroke: install',
      )
    } catch (error) {
      log(cfg, `ctx.effect 注册失败: ${error && error.message ? error.message : error}`)
      runInstall()
    }
  } else {
    runInstall()
  }
  return cleanup
}

export { buildToolDefinitions as __buildToolDefinitions, createState as __createState, PLUGIN_VERSION }
