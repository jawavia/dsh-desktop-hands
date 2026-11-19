// dsh-click-matrix host smoke harness.
//
//   node tools/host-smoke.mjs
//
// Runs WITHOUT touching the real desktop: a JS mock helper (this same file with
// --mock-helper) speaks the PROTOCOL.md NDJSON subset to the real host code in
// index.js/lib/*, and a fake DSH ctx provides tools/commands/services. Covers
// grid math, config clamping, image budget/dedupe, the access gate decisions,
// tool registration + argument validation + capture/click/drag/scroll flows,
// commands, audit, doctor, and dispose/process cleanup. v0.4 adds: human-idle
// internal wait, per-action mouse_batch window checks + partial reports, dryRun
// previews, window-relative coordinates (window_fx/fy, capture fw/fh),
// window_focus / wait_window, keep-on latch wording and scoped allowSelf.
//
// Test-only env overrides understood by the host code:
//   DSH_CLICK_MATRIX_MOCK_HELPER   this file, run as `node <file> --mock-helper`
//   DSH_CLICK_MATRIX_MOCK_SCENARIO scenario JSON for the mock helper
//   DSH_CLICK_MATRIX_MOCK_UIA      mock UIA payload (file path or inline JSON)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), '..')
const IS_MOCK = process.argv.includes('--mock-helper')

// 2026-11-08：本 harness 里有 e2e 会真的走一次 `/click-matrix arm` 命令，而 fan-out 会写
// `~/.dsh/dsh-desktop-hands/gate.json`（真人授权文件）。原来没有隔离，于是**每跑一次
// 回归就会用一次 60 秒 fan-out 覆盖掉现有的常开/授权窗口**（2026-11-08 01:57 实测发生过）。
// 这里默认把 shared gate/stop 文件指到临时目录；要恢复旧行为可显式设 DSH_HANDS_DATA_DIR。
if (IS_MOCK) {
  // mock helper 子进程不需要（也不应该）碰这个变量。
} else if (!process.env.DSH_HANDS_DATA_DIR) {
  process.env.DSH_HANDS_DATA_DIR = join(tmpdir(), `dsh-hands-smoke-${process.pid}-${Date.now()}`)
}
// 2026-11-08 13:5x：pixel 自己的数据目录（audit/config/captures）只认 DSH_HOME，
// 不认 DSH_HANDS_DATA_DIR。不隔离的话，本 harness 的 e2e（arm/人类输入/Esc）会写进
// **真实审计链**（实测多出 6 行）。单跑 `node host-smoke.mjs` 时也必须指到临时 home。
if (!IS_MOCK && !process.env.DSH_HOME) {
  process.env.DSH_HOME = join(tmpdir(), `dsh-hands-smoke-home-${process.pid}-${Date.now()}`)
}

// ===========================================================================
// mock helper (child process): NDJSON over stdin/stdout, writes real PNGs
// ===========================================================================

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/** Encode a w*h RGB PNG (uniform color blocked in 16px tiles so it is not all flat). */
function encodePng(width, height) {
  const w = Math.max(1, Math.min(4096, Math.round(width)))
  const h = Math.max(1, Math.min(4096, Math.round(height)))
  const stride = 1 + w * 3
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const tile = ((x >> 4) + (y >> 4)) & 1
      const px = row + 1 + x * 3
      raw[px] = tile ? 40 : 80
      raw[px + 1] = tile ? 60 : 90
      raw[px + 2] = tile ? 90 : 120
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))])
}

// Test-harness diagnostics: a truncated/partial JSON file (child writing while
// the parent reads) used to surface as "counter went backwards" flakiness.
// JSON files are shared between this harness and the mock-helper child process,
// so every read/write must survive a concurrent counterpart. Without this the
// mock occasionally reads an empty scenario.json (=> scenario defaults, e.g.
// externalAbort silently off) or the parent reads a half-written counters.json
// (=> a counter appears to go backwards). Both showed up as rare, unrelated-
// looking test failures.
const jsonReadFailures = []
const jsonWriteFallbacks = []
function readJsonFile(path, fallback) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      jsonReadFailures.push(`${path}: ${error && error.message}`)
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    }
  }
  return fallback
}

function writeJsonFile(path, value) {
  const text = JSON.stringify(value)
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    writeFileSync(tmp, text)
  } catch {
    /* fall through to the direct write below */
  }
  if (existsSync(tmp)) {
    // Windows refuses to rename over a file another process has open; retry a
    // few times, then fall back to an in-place write (readers retry on partial
    // JSON, so neither path can silently drop the update).
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        renameSync(tmp, path)
        return
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      }
    }
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    jsonWriteFallbacks.push(path)
  }
  try {
    writeFileSync(path, text)
  } catch {
    /* ignore */
  }
}

function runMockHelper() {
  const scenarioPath = process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO || ''
  const scenario = () => readJsonFile(scenarioPath, {})
  const countersPath = () => {
    const sc = scenario()
    return typeof sc.countersPath === 'string' ? sc.countersPath : ''
  }
  const readCounters = () => readJsonFile(countersPath(), {})
  const bump = (field) => {
    const c = readCounters()
    c[field] = Math.round(Number(c[field]) || 0) + 1
    c.startPid = c.startPid || process.pid
    writeJsonFile(countersPath(), c)
    return c
  }
  const setField = (field, value) => {
    const c = readCounters()
    c[field] = value
    c.startPid = c.startPid || process.pid
    writeJsonFile(countersPath(), c)
    return c
  }
  const write = (obj) => {
    try {
      process.stdout.write(JSON.stringify(obj) + '\n')
    } catch {
      /* ignore */
    }
  }
  const respond = (id, ok, data, error) => {
    const msg = { id, ok }
    if (ok) msg.data = data || {}
    else msg.error = error || 'mock error'
    write(msg)
  }
  const virtual = () => {
    const sc = scenario()
    return sc.virtual && typeof sc.virtual === 'object' ? sc.virtual : { x: 0, y: 0, w: 2880, h: 1800 }
  }
  const monitors = () => {
    const sc = scenario()
    return Array.isArray(sc.monitors) && sc.monitors.length > 0 ? sc.monitors : [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }]
  }
  const foreground = () => {
    const sc = scenario()
    if (sc.foreground && typeof sc.foreground === 'object') return sc.foreground
    return { handle: 111, title: 'Mock Notepad', className: 'Notepad', pid: 4242, process: 'C:\\Windows\\notepad.exe', rect: { x: 0, y: 0, w: 900, h: 700 }, minimized: false, elevated: false, denied: false }
  }
  const status = () => {
    const vs = virtual()
    const sc = scenario()
    const phys = sc.physicalButtonsDown && typeof sc.physicalButtonsDown === 'object'
      ? { left: sc.physicalButtonsDown.left === true, right: sc.physicalButtonsDown.right === true, middle: sc.physicalButtonsDown.middle === true }
      : { left: false, right: false, middle: false }
    const tracked = sc.buttonsDown && typeof sc.buttonsDown === 'object'
      ? { left: sc.buttonsDown.left === true, right: sc.buttonsDown.right === true, middle: sc.buttonsDown.middle === true }
      : { left: false, right: false, middle: false }
    return {
      protocol: 1,
      pid: process.pid,
      helperVersion: 'mock-1.0.0',
      osVersion: 'mock-windows',
      dpiAware: true,
      capabilities: { keyboard: true, clipboard: true, printWindow: true, escWatch: true, humanInputWatch: true },
      virtual: vs,
      monitors: monitors(),
      cursor: sc.cursor || { x: 100, y: 100 },
      foreground: sc.foregroundNull === true ? null : foreground(),
      hotkey: { registered: true, combo: 'Ctrl+Alt+F12' },
      // v0.9.1 QC: D-08 requires the helper to report the hard-stop ("abort")
      // hotkey explicitly; the mock only reported the arm hotkey, so every e2e
      // injection test was (correctly) refused as "旧版 helper". Test fixture fix.
      abortHotkey: { registered: true, combo: 'Ctrl+Alt+F11' },
      overlay: {
        available: true,
        visible: sc.overlayVisible === true,
        captureExcluded: true,
        ...(sc.overlayHitTestable === undefined
          ? {}
          : { hitTestable: sc.overlayHitTestable === true, latticeHitTestable: false, pillHitTestable: sc.overlayHitTestable === true }),
      },
      buttonsDown: tracked,
      physicalButtonsDown: phys,
      elevated: false,
    }
  }
  const windowByHandle = (handle) => {
    const sc = scenario()
    const list = [...(Array.isArray(sc.windows) ? sc.windows : []), foreground()]
    return list.find((w) => w && w.handle === handle) || null
  }
  const windowAtPoint = (x, y) => {
    const sc = scenario()
    const c = bump('probe')
    if (sc.probeFlip === true && c.probe > 1 && sc.flipWindow) return sc.flipWindow
    const denyAfter = Number(sc.probeDenyAfter)
    if (Number.isFinite(denyAfter) && c.probe > denyAfter) {
      return sc.denyWindow || { ...foreground(), denied: true }
    }
    if (sc.probeWindow) return sc.probeWindow
    const fg = foreground()
    void x
    void y
    return fg
  }
  const capture = (req) => {
    const sc = scenario()
    const vs = virtual()
    const win = Number.isFinite(Number(req.windowHandle)) && Number(req.windowHandle) > 0 ? windowByHandle(Number(req.windowHandle)) : null
    const base = win && win.rect ? win.rect : null
    const x = Number.isFinite(Number(req.x)) ? Math.round(Number(req.x)) : base ? Math.round(Number(base.x) || 0) : vs.x
    const y = Number.isFinite(Number(req.y)) ? Math.round(Number(req.y)) : base ? Math.round(Number(base.y) || 0) : vs.y
    const w = Number.isFinite(Number(req.w))
      ? Math.max(1, Math.round(Number(req.w)))
      : base
        ? Math.max(1, Math.round(Number(base.w ?? base.width) || 1))
        : vs.w
    const h = Number.isFinite(Number(req.h))
      ? Math.max(1, Math.round(Number(req.h)))
      : base
        ? Math.max(1, Math.round(Number(base.h ?? base.height) || 1))
        : vs.h
    const scale = Number.isFinite(Number(req.scale)) && Number(req.scale) > 0 ? Number(req.scale) : 1
    const outW = Number.isFinite(Number(req.outW)) ? Math.max(1, Math.round(Number(req.outW))) : Math.max(1, Math.round(w * scale))
    const outH = Number.isFinite(Number(req.outH)) ? Math.max(1, Math.round(Number(req.outH))) : Math.max(1, Math.round(h * scale))
    const path = String(req.path || '')
    writeJsonFile(path, null) // placeholder overwritten below
    const png = encodePng(outW, outH)
    try {
      writeFileSync(path, png)
    } catch (error) {
      throw new Error('mock cannot write capture: ' + error.message)
    }
    const counters = bump('capture')
    setField('lastCaptureWindowHandle', win ? Number(req.windowHandle) : 0)
    setField('lastCaptureSource', { x, y, w, h })
    setField('lastCaptureClientOnly', req.clientOnly === true)
    const salt = sc.hashPerCall === true ? String(counters.capture) : String(sc.hashSalt ?? 'stable')
    const latIn = req.lattice && typeof req.lattice === 'object' ? req.lattice : null
    const spacingScreen = latIn ? Number(latIn.spacing) || 0 : 0
    const data = {
      path,
      width: outW,
      height: outH,
      source: { x, y, w, h },
      scale,
      lattice: latIn
        ? { spacingScreen, spacingImage: spacingScreen * scale, originX: x, originY: y, style: String(latIn.style || 'cross') }
        : { spacingScreen: 0, spacingImage: 0, originX: x, originY: y, style: 'none' },
      captureHash: createHash('sha256').update(`${x},${y},${w},${h},${outW},${outH}:${salt}`).digest('hex'),
      blackFrame: sc.blackFrame === true,
      clientOnly: req.clientOnly === true,
    }
    if (win) data.windowHandle = Number(req.windowHandle)
    return data
  }
  const zoom = (req) => {
    const vs = virtual()
    const cx = Math.round(Number(req.cx) || 0)
    const cy = Math.round(Number(req.cy) || 0)
    const size = Math.max(32, Math.min(1200, Math.round(Number(req.size) || 270)))
    const scale = Math.max(1, Math.min(8, Math.round(Number(req.scale) || 3)))
    const subCols = Math.max(2, Math.min(12, Math.round(Number(req.subCols) || 6)))
    const x = Math.max(vs.x, Math.min(cx - Math.round(size / 2), vs.x + vs.w - size))
    const y = Math.max(vs.y, Math.min(cy - Math.round(size / 2), vs.y + vs.h - size))
    const source = { x, y, w: size, h: size }
    const outW = size * scale
    const outH = size * scale
    const path = String(req.path || '')
    try {
      writeFileSync(path, encodePng(outW, outH))
    } catch (error) {
      throw new Error('mock cannot write zoom: ' + error.message)
    }
    return {
      path,
      width: outW,
      height: outH,
      source,
      scale,
      subSpacingScreen: Math.round((size / subCols) * 100) / 100,
      captureHash: createHash('sha256').update(`zoom:${x},${y},${size},${scale}`).digest('hex'),
    }
  }
  const emitReady = () => {
    const c = readCounters()
    c.startPid = process.pid
    writeJsonFile(countersPath(), c)
    write({ event: 'ready', data: status() })
  }
  const handle = (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      write({ ok: false, error: 'mock bad json' })
      return
    }
    const id = msg.id
    try {
      switch (msg.cmd) {
        case 'hello':
        case 'status':
          respond(id, true, status())
          return
        case 'windows':
          respond(id, true, { windows: Array.isArray(scenario().windows) ? scenario().windows : [] })
          return
        case 'probe_at':
          respond(id, true, { window: windowAtPoint(Number(msg.x), Number(msg.y)) })
          return
        case 'capture':
          respond(id, true, capture(msg))
          return
        case 'zoom':
          respond(id, true, zoom(msg))
          return
        case 'move':
          setField('lastMove', { x: msg.x, y: msg.y, durationMs: Number(msg.durationMs) || 0 })
          respond(id, true, {
            x: msg.x,
            y: msg.y,
            cursorX: msg.x,
            cursorY: msg.y,
            aborted: false,
            startX: 100,
            startY: 100,
            elapsedMs: Number(msg.durationMs) || 0,
            ...(scenario().externalAbort === true ? { externalAborted: true } : {}),
          })
          return
        case 'click': {
          const c = bump('click')
          setField('lastClick', { x: msg.x, y: msg.y, button: msg.button || 'left', count: msg.count || 1 })
          const fgAfter = scenario().foregroundNull === true ? null : foreground()
          respond(id, true, {
            x: msg.x,
            y: msg.y,
            cursorX: msg.x,
            cursorY: msg.y,
            button: msg.button || 'left',
            count: msg.count || 1,
            aborted: false,
            foregroundBefore: foreground(),
            foregroundAfter: fgAfter,
            foregroundChanged: false,
            physicalButtonsAfter: { left: false, right: false, middle: false },
            seq: c.click,
            ...(scenario().externalAbort === true ? { externalAborted: true } : {}),
          })
          return
        }
        case 'drag':
          bump('drag')
          setField('lastDrag', { fromX: msg.fromX, fromY: msg.fromY, toX: msg.toX, toY: msg.toY })
          respond(id, true, {
            fromX: msg.fromX,
            fromY: msg.fromY,
            toX: msg.toX,
            toY: msg.toY,
            cursorX: msg.toX,
            cursorY: msg.toY,
            aborted: false,
            ...(scenario().externalAbort === true ? { externalAborted: true } : {}),
          })
          return
        case 'focus': {
          if (scenario().focusUnsupported === true) {
            respond(id, false, null, 'mock unknown command: focus')
            return
          }
          bump('focus')
          setField('lastFocusHandle', Number(msg.handle) || 0)
          const target = windowByHandle(Number(msg.handle)) || foreground()
          if (scenario().focusDenied === true) {
            // v0.8.5: a refused foreground switch (foreground lock).
            respond(id, true, {
              focused: false,
              foregroundNow: false,
              window: target,
              foregroundBefore: foreground(),
              foregroundAfter: foreground(),
              reason: 'foreground-lock',
              attempts: 3,
              setForegroundOk: false,
              lastError: 5,
            })
            return
          }
          respond(id, true, { focused: true, window: target })
          return
        }
        case 'scroll':
          bump('scroll')
          respond(id, true, { delta: msg.delta, cursorX: msg.x || 100, cursorY: msg.y || 100 })
          return
        case 'overlay': {
          const show = msg.show === true
          bump(show ? 'overlayShow' : 'overlayHide')
          setField('lastOverlayMode', typeof msg.mode === 'string' ? msg.mode : '')
          setField('lastOverlayLabel', typeof msg.label === 'string' ? msg.label : '')
          respond(id, true, { visible: show, mode: msg.mode || 'both', captureExcluded: true })
          return
        }
        case 'set_esc_watch':
          bump('escWatchCalls')
          setField('escWatchEnabled', msg.enabled === true)
          respond(id, true, { enabled: msg.enabled === true })
          return
        case 'type_text': {
          const text = typeof msg.text === 'string' ? msg.text : ''
          bump('typeText')
          setField('lastTypeChars', text.length)
          respond(id, true, { chars: text.length, aborted: false })
          return
        }
        case 'press_keys': {
          bump('pressKeys')
          setField('lastKeys', Array.isArray(msg.keys) ? msg.keys : [])
          respond(id, true, { sent: Array.isArray(msg.keys) ? msg.keys : [] })
          return
        }
        case 'clipboard_get': {
          bump('clipboardGet')
          const sc = scenario()
          setField('lastClipboardRequireText', msg.requireText === true)
          if (sc.clipboardRequireFail === true) {
            respond(id, false, null, 'clipboard has no text (requireText)')
            return
          }
          if (sc.clipboardEmpty === true) {
            respond(id, true, { text: '', chars: 0, hasText: false, reason: 'no-text' })
            return
          }
          const text = typeof sc.clipboard === 'string' ? sc.clipboard : 'mock clipboard text'
          respond(id, true, { text, chars: text.length, hasText: text.length > 0 })
          return
        }
        case 'clipboard_set': {
          const text = typeof msg.text === 'string' ? msg.text : ''
          bump('clipboardSet')
          setField('clipboardChars', text.length)
          respond(id, true, { chars: text.length })
          return
        }
        case 'set_deny':
          respond(id, true, { deniedProcesses: Array.isArray(msg.processes) ? msg.processes : [], deniedClasses: Array.isArray(msg.classes) ? msg.classes : [] })
          return
        case 'abort':
          bump('abort')
          respond(id, true, { aborted: true, released: true })
          return
        case 'doctor':
          respond(id, true, {
            osVersion: 'mock-windows',
            build: '26100',
            processElevated: false,
            dpiAware: true,
            monitors: monitors(),
            capture: { ok: true, black: false },
            hotkeyRegistered: true,
            overlayAvailable: true,
            captureExcluded: true,
            uipiProbe: { ok: true, note: 'mock' },
            helperVersion: 'mock-1.0.0',
            protocol: 1,
          })
          return
        case 'quit':
          respond(id, true, { bye: true })
          setTimeout(() => process.exit(0), 20)
          return
        default:
          respond(id, false, null, 'mock unknown command: ' + msg.cmd)
      }
    } catch (error) {
      respond(id, false, null, 'mock error: ' + (error && error.message ? error.message : error))
    }
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line !== '') handle(line)
    }
  })
  process.stdin.on('end', () => setTimeout(() => process.exit(0), 10))
  // Unsolicited events (escape / abort / human-input / stop) are injected by the test
  // writing an events JSON file; the mock polls it and emits once, then clears.
  const eventsPath = () => {
    const sc = scenario()
    return typeof sc.eventsPath === 'string' ? sc.eventsPath : ''
  }
  if (eventsPath() !== '') {
    const timer = setInterval(() => {
      const p = eventsPath()
      if (p === '') return
      const payload = readJsonFile(p, null)
      if (!payload || typeof payload !== 'object') return
      const list = Array.isArray(payload.events)
        ? payload.events
        : typeof payload.event === 'string'
          ? [{ event: payload.event, data: payload.data }]
          : []
      if (list.length === 0) return
      writeJsonFile(p, {})
      for (const item of list) {
        if (!item || typeof item.event !== 'string') continue
        const msg = { event: item.event }
        if (item.data && typeof item.data === 'object') msg.data = item.data
        write(msg)
      }
    }, 50)
    if (typeof timer.unref === 'function') timer.unref()
  }
  emitReady()
}

// ===========================================================================
// tiny test framework
// ===========================================================================

const results = []
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  const suffix = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`)
}
async function check(name, fn) {
  try {
    const result = await fn()
    record(name, result !== false, typeof result === 'string' ? result : undefined)
  } catch (error) {
    record(name, false, error && error.message ? error.message : String(error))
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed')
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message || 'not equal'}: expected ${e}, got ${a}`)
}
function assertIncludes(haystack, needle, message) {
  const text = String(haystack || '')
  if (!text.includes(needle)) throw new Error(`${message || 'missing substring'} ${JSON.stringify(needle)} in: ${text.slice(0, 500)}`)
}

// ===========================================================================
// main test run
// ===========================================================================

async function runMain() {
  const grid = await import('../lib/grid.js')
  const configLib = await import('../lib/config.js')
  const budgetLib = await import('../lib/budget.js')
  const accessLib = await import('../lib/access.js')
  const helperLib = await import('../lib/helper.js')
  const policyLib = await import('../lib/policy.js')

  const tmpRoot = join(tmpdir(), `dsh-click-matrix-smoke-${process.pid}-${Date.now()}`)
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(tmpRoot, { recursive: true })
  const scenarioPath = join(tmpRoot, 'scenario.json')
  const countersPath = join(tmpRoot, 'counters.json')
  const uiaPath = join(tmpRoot, 'uia.json')
  const eventsPath = join(tmpRoot, 'events.json')
  const homeDir = join(tmpRoot, 'dsh-home')
  mkdirSync(homeDir, { recursive: true })
  process.env.DSH_HOME = homeDir
  process.env.DSH_CLICK_MATRIX_MOCK_HELPER = SELF
  process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = scenarioPath

  let mockPid = 0
  // Last audit entry for a tool (used by the v0.8.5 outcome assertions: text can
  // be read by the model, but `outcome` is what the audit trail promises).
  const lastAuditEntry = (tool) => {
    try {
      const rows = readFileSync(join(homeDir, 'click-matrix', 'audit.jsonl'), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      for (let i = rows.length - 1; i >= 0; i--) {
        // 0.9: mutating tools write an intent row + a phase=effect row; callers
        // assert on the decision row, so skip the effect duplicates.
        if (rows[i] && rows[i].tool === tool && rows[i].phase !== 'effect') return rows[i]
      }
    } catch {
      /* no audit yet */
    }
    return null
  }
  const readCounters = () => readJsonFile(countersPath, {})
  const syncMockPid = () => {
    const c = readCounters()
    if (c.startPid) mockPid = c.startPid
    return c
  }
  const writeScenario = (scenario) => {
    const c = readCounters()
    writeJsonFile(scenarioPath, { countersPath, eventsPath, ...scenario })
    writeJsonFile(countersPath, {
      startPid: c.startPid || 0,
      probe: 0,
      click: 0,
      drag: 0,
      scroll: 0,
      abort: 0,
      capture: 0,
      overlayShow: 0,
      overlayHide: 0,
      typeText: 0,
      pressKeys: 0,
      clipboardGet: 0,
      clipboardSet: 0,
      escWatchCalls: 0,
      focus: 0,
    })
  }
  const emitEvents = (events) => {
    writeJsonFile(eventsPath, { events })
  }
  const defaultForeground = {
    handle: 111,
    title: 'Mock Notepad',
    className: 'Notepad',
    pid: 4242,
    process: 'C:\\Windows\\notepad.exe',
    rect: { x: 0, y: 0, w: 900, h: 700 },
    minimized: false,
    elevated: false,
    denied: false,
  }
  const baseScenario = (overrides = {}) => ({
    virtual: { x: 0, y: 0, w: 2880, h: 1800 },
    monitors: [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }],
    cursor: { x: 100, y: 100 },
    foreground: defaultForeground,
    windows: [
      defaultForeground,
      { handle: 222, title: 'Mock Explorer', className: 'CabinetWClass', pid: 5353, process: 'C:\\Windows\\explorer.exe', rect: { x: 100, y: 100, w: 1200, h: 800 }, minimized: false, elevated: false, denied: false },
    ],
    ...overrides,
  })
  writeScenario(baseScenario())

  // -------------------------------------------------------------------------
  // 1. pure grid math
  // -------------------------------------------------------------------------
  await check('grid: lattice DIP tiers', () => {
    assertEqual(grid.LATTICE_TIERS, { coarse: 180, standard: 90, fine: 45, micro: 22.5 })
  })
  await check('grid: spacingScreen = round(dip*scale)', () => {
    assertEqual(grid.latticeSpacingScreen('standard', 2), 180)
    assertEqual(grid.latticeSpacingScreen('micro', 2), 45)
    assertEqual(grid.latticeSpacingScreen('coarse', 1.5), 270)
    assertEqual(grid.latticeSpacingScreen('fine', 1), 45)
    assertEqual(grid.latticeSpacingScreen(null, 2), 0)
  })
  await check('grid: binning target never upscales', () => {
    assertEqual(grid.round2(grid.binningScale('target', 2880, 1800, 1600)), 0.56)
    assertEqual(grid.round2(grid.binningScale('target', 800, 600, 1600)), 1)
    assertEqual(grid.binningScale('2', 800, 600, 1600), 0.5)
    assertEqual(grid.binningScale('8', 800, 600, 1600), 0.125)
    assertEqual(grid.captureOutputSize(2880, 1800, 1600 / 2880), { w: 1600, h: 1000 })
  })
  await check('grid: lattice-in-image validation >=8px', () => {
    const ok = grid.validateLatticeInImage(180, 1 / 8)
    assert(ok.ok === true && ok.spacingImage >= 8, 'standard@8 should be ok: ' + JSON.stringify(ok))
    const bad = grid.validateLatticeInImage(45, 1 / 8)
    assert(bad.ok === false && /≥ 8px/.test(bad.error), 'micro@8 must fail')
    assertEqual(grid.suggestLatticeTier(1 / 8, 2), 'coarse')
  })
  await check('grid: normalized <-> screen mapping', () => {
    const region = { x: 100, y: 50, w: 800, h: 600 }
    assertEqual(grid.normToScreen(0.5, 0.5, region), { x: 500, y: 350 })
    assertEqual(grid.normToScreen(1, 1, region), { x: 899, y: 649 })
    assertEqual(grid.round2(grid.screenToNorm(500, 350, region).fx), 0.5)
    const capture = { source: { x: 100, y: 50, w: 800, h: 600 }, width: 1600, height: 1200 }
    assertEqual(grid.imageToScreen(800, 600, capture), { x: 500, y: 350 })
    assertEqual(grid.screenToImage(500, 350, capture), { ix: 800, iy: 600 })
  })
  await check('grid: lattice snapping + cell math', () => {
    const origin = { originX: 0, originY: 0, spacing: 180 }
    const far = grid.snapToLattice(500, 500, origin)
    assertEqual({ x: far.x, y: far.y }, { x: 540, y: 540 })
    assert(Math.abs(far.distance - 56.57) < 0.02, 'distance ' + far.distance)
    assert(far.onLattice === true, '56.57px <= tolerance 60px = on lattice')
    const outside = grid.snapToLattice(90, 90, origin)
    assertEqual({ x: outside.x, y: outside.y }, { x: 180, y: 180 })
    assert(outside.onLattice === false, '127px away must not be on lattice: ' + JSON.stringify(outside))
    const near = grid.snapToLattice(530, 545, origin)
    assertEqual({ x: near.x, y: near.y }, { x: 540, y: 540 })
    assert(near.onLattice === true, 'near should be on lattice')
    assertEqual(grid.cellOfPoint(500, 500, origin), { col: 2, row: 2 })
    assertEqual(grid.cellCenter(2, 2, origin), { x: 450, y: 450 })
  })
  await check('grid: zoom source + sub-point mapping', () => {
    const virtual = { x: 0, y: 0, w: 2880, h: 1800 }
    const source = grid.zoomSourceRect(500, 500, 270, virtual)
    assertEqual(source, { x: 365, y: 365, w: 270, h: 270 })
    const p = grid.zoomSubPoint(source, 0, 0, 6, 6)
    assertEqual({ x: p.x, y: p.y }, { x: 388, y: 388 })
    assertEqual(grid.zoomSubSpacing(source, 6, 6), { x: 45, y: 45 })
    const sub = grid.validateZoomSubSpacing(source, 6, 6, 3)
    assert(sub.ok === true, 'sub spacing ok')
    assert(grid.validateZoomSubSpacing({ x: 0, y: 0, w: 60, h: 60 }, 12, 12, 1).ok === false, '5px sub-spacing must fail')
  })
  await check('grid: token estimate + monitor geometry', () => {
    assertEqual(grid.estimateVisualTokens(1600, 1000), 1000)
    assertEqual(grid.estimateVisualTokens(84, 84), 9)
    assert(grid.estimateImageTokens(800, 600) > 300)
    const monitors = grid.normalizeMonitors([
      { x: 0, y: 0, w: 2880, h: 1800, scale: 2, primary: true },
      { x: 2880, y: 0, w: 1920, h: 1080, scale: 1 },
    ])
    assertEqual(grid.virtualScreen(monitors), { x: 0, y: 0, w: 4800, h: 1800 })
    assertEqual(grid.screenScaleAt(monitors, 3000, 500), 1)
    assertEqual(grid.screenScaleAt(monitors, 100, 100), 2)
  })

  // -------------------------------------------------------------------------
  // 2. config validation/clamping
  // -------------------------------------------------------------------------
  await check('config: defaults', () => {
    const cfg = configLib.normalizeConfig(undefined)
    assertEqual(cfg.mode, 'ask')
    assertEqual(cfg.lattice, 'standard')
    assertEqual(cfg.binning, 'target')
    assertEqual(cfg.captureLongSide, 1600)
    assertEqual(cfg.overlayMode, 'auto')
    assertEqual(cfg.armWindowMs, 25000)
    assertEqual(cfg.armClicks, 10)
    assertEqual(cfg.hotkeyArmMs, 60000)
    assertEqual(cfg.maxImagesPerTurn, 12)
    assertEqual(cfg.maxImageTokensPerTurn, 6000)
    assertEqual(cfg.minIntervalMs, 150)
    assertEqual(cfg.auditMaxBytes, 2097152)
    assertEqual(cfg.helperTimeoutMs, 20000)
    assertEqual(cfg.uiaTimeoutMs, 4000)
    assertEqual(cfg.denyProcesses, [])
    // v0.2 additions (old defaults unchanged)
    assertEqual(cfg.enableKeyboard, true)
    assertEqual(cfg.enableClipboard, true)
    assertEqual(cfg.batchMaxActions, 20)
    assertEqual(cfg.pauseOnHumanInput, true)
    assertEqual(cfg.pillOnArm, true)
    assertEqual(cfg.waitDefaultTimeoutMs, 5000)
    assertEqual(cfg.waitStableMs, 400)
  })
  await check('config: clamps invalid values, ignores unknown keys', () => {
    const cfg = configLib.normalizeConfig({
      mode: 'bogus',
      lattice: 'xx',
      binning: '3',
      overlayMode: 'sometimes',
      captureLongSide: 999999,
      armWindowMs: 1,
      armClicks: 0,
      hotkeyArmMs: 1,
      maxImagesPerTurn: 999,
      maxImageTokensPerTurn: -5,
      minIntervalMs: -10,
      auditMaxBytes: 1,
      helperTimeoutMs: 1,
      uiaTimeoutMs: 999999,
      denyProcesses: ['Game.exe', 'game.EXE', '', 7, '  Bank.exe '],
      denyTitleContains: [' 密码 ', 'Passwords'],
      unknownField: 'ignored',
      enableKeyboard: 'false',
      enableClipboard: 0,
      batchMaxActions: 999,
      pauseOnHumanInput: 'garbage',
      pillOnArm: false,
      waitDefaultTimeoutMs: 1,
      waitStableMs: 99999,
    })
    assertEqual(cfg.mode, 'ask')
    assertEqual(cfg.lattice, 'standard')
    assertEqual(cfg.binning, 'target')
    assertEqual(cfg.overlayMode, 'auto')
    assertEqual(cfg.captureLongSide, 4096)
    assertEqual(cfg.armWindowMs, 1000)
    assertEqual(cfg.armClicks, 1)
    assertEqual(cfg.hotkeyArmMs, 5000)
    assertEqual(cfg.maxImagesPerTurn, 60)
    assertEqual(cfg.maxImageTokensPerTurn, 0)
    assertEqual(cfg.minIntervalMs, 0)
    assertEqual(cfg.auditMaxBytes, 65536)
    assertEqual(cfg.helperTimeoutMs, 1000)
    assertEqual(cfg.uiaTimeoutMs, 30000)
    assertEqual(cfg.denyProcesses, ['Game.exe', 'Bank.exe'])
    assertEqual(cfg.denyTitleContains, ['密码', 'Passwords'])
    assertEqual(cfg.unknownField, undefined)
    // v0.2 bool/int clamping
    assertEqual(cfg.enableKeyboard, false)
    assertEqual(cfg.enableClipboard, false)
    assertEqual(cfg.batchMaxActions, 50)
    assertEqual(cfg.pauseOnHumanInput, true)
    assertEqual(cfg.pillOnArm, false)
    assertEqual(cfg.waitDefaultTimeoutMs, 200)
    assertEqual(cfg.waitStableMs, 5000)
  })
  await check('config: numeric strings accepted', () => {
    const cfg = configLib.normalizeConfig({ captureLongSide: '2000', armClicks: '5' })
    assertEqual(cfg.captureLongSide, 2000)
    assertEqual(cfg.armClicks, 5)
  })

  // -------------------------------------------------------------------------
  // 3. image budget + dedupe
  // -------------------------------------------------------------------------
  await check('budget: image count limit', () => {
    const b = new budgetLib.ImageBudget({ maxImages: 2, maxTokens: 100000 })
    assert(b.check('a', 10).allowed)
    b.record('a', { tokens: 10, hash: 'h1' })
    assert(b.check('a', 10).allowed)
    b.record('a', { tokens: 10, hash: 'h2' })
    const denied = b.check('a', 10)
    assert(denied.allowed === false && /预算已用完/.test(denied.reason), denied.reason)
    assert(b.check('other-agent', 10).allowed, 'per-agent counters')
  })
  await check('budget: token limit', () => {
    const b = new budgetLib.ImageBudget({ maxImages: 10, maxTokens: 500 })
    assert(b.check('a', 400).allowed)
    b.record('a', { tokens: 400, hash: 'x' })
    const denied = b.check('a', 200)
    assert(denied.allowed === false && /token 预算不足/.test(denied.reason), denied.reason)
  })
  await check('budget: consecutive hash dedupe + window reset', () => {
    let now = 1000
    const b = new budgetLib.ImageBudget({ maxImages: 5, maxTokens: 5000, now: () => now })
    assert(b.isDuplicate('a', 'h1') === false)
    b.record('a', { tokens: 10, hash: 'h1' })
    assert(b.isDuplicate('a', 'h1') === true)
    assert(b.isDuplicate('a', 'h2') === false)
    now += 130000
    assert(b.isDuplicate('a', 'h1') === false, 'window reset clears dedupe')
    assertEqual(b.snapshot('a').images, 0)
  })

  // -------------------------------------------------------------------------
  // 4. access gate decisions (fake clock, no helper)
  // -------------------------------------------------------------------------
  function makeGate(options = {}) {
    const clock = { t: 1000 }
    const cfg = configLib.normalizeConfig({
      mode: options.mode || 'auto',
      armClicks: options.armClicks ?? 2,
      armWindowMs: options.armWindowMs ?? 5000,
      minIntervalMs: options.minIntervalMs ?? 0,
      hotkeyArmMs: 60000,
    })
    const approvalCalls = []
    const approval =
      options.approval === 'none'
        ? undefined
        : {
            request: async (req) => {
              approvalCalls.push(req)
              return options.approvalResult ?? 'allowed-once'
            },
          }
    const aborts = []
    const ctx = {
      get(name) {
        if (name === 'approval') return approval
        return undefined
      },
    }
    const gate = new accessLib.AccessGate({
      ctx,
      config: cfg,
      now: () => clock.t,
      onAbortRequested: (reason) => aborts.push(reason),
    })
    return { gate, clock, cfg, approvalCalls, aborts }
  }
  const execAgent = (id = 'agent-a') => ({ agent: { session: { id } }, callId: 'call-1' })

  await check('gate: mode=off denies mutations', async () => {
    const { gate } = makeGate({ mode: 'off' })
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === false && d.code === 'mode-off', JSON.stringify(d))
  })
  await check('gate: auto without arm denies with human-arm advice', async () => {
    const { gate } = makeGate({ mode: 'auto' })
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === false && d.code === 'arm-required', JSON.stringify(d))
    assertIncludes(d.message, '/click-matrix arm')
    assertIncludes(d.message, 'Ctrl+Alt+F12')
  })
  await check('gate: human arm grants, click limit consumes then disarms', async () => {
    const { gate } = makeGate({ mode: 'auto', armClicks: 2 })
    gate.humanArm(60)
    const d1 = await gate.check({ toolName: 'mouse_click', exec: execAgent('x') })
    assert(d1.allowed === true && d1.clicksLeft === 1, JSON.stringify(d1))
    const d2 = await gate.check({ toolName: 'mouse_click', exec: execAgent('x') })
    assert(d2.allowed === true && d2.clicksLeft === 0, JSON.stringify(d2))
    const d3 = await gate.check({ toolName: 'mouse_click', exec: execAgent('x') })
    assert(d3.allowed === false && d3.code === 'arm-required', 'limit must disarm: ' + JSON.stringify(d3))
  })
  await check('gate: arm is scoped to the agent (human arm is global)', async () => {
    const { gate } = makeGate({ mode: 'auto' })
    gate.openArm({ owner: 'agent-a', ms: 5000, clicks: 3, source: 'approval' })
    const other = await gate.check({ toolName: 'mouse_click', exec: execAgent('agent-b') })
    assert(other.allowed === false && other.code === 'arm-required', 'other agent must be denied')
    const same = await gate.check({ toolName: 'mouse_click', exec: execAgent('agent-a') })
    assert(same.allowed === true, 'same agent allowed')
    gate.humanArm(60)
    const otherAfterHuman = await gate.check({ toolName: 'mouse_click', exec: execAgent('agent-b') })
    assert(otherAfterHuman.allowed === true, 'human arm is global')
  })
  await check('gate: arm expiry', async () => {
    const { gate, clock } = makeGate({ mode: 'auto', armWindowMs: 5000 })
    gate.humanArm(5)
    clock.t += 5001
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === false, JSON.stringify(d))
    assert(gate.snapshot().armed === false)
  })
  await check('gate: min interval rate limit', async () => {
    const { gate } = makeGate({ mode: 'auto', minIntervalMs: 150 })
    gate.humanArm(60)
    const d1 = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d1.allowed === true)
    const d2 = await gate.check({ toolName: 'mouse_scroll', exec: execAgent() })
    assert(d2.allowed === false && d2.code === 'rate-limited', JSON.stringify(d2))
    assert(grid.isNum(d2.retryAfterMs) === true, 'retryAfterMs present')
  })
  await check('gate: ask mode approval allowed-once opens bounded arm', async () => {
    const { gate, approvalCalls } = makeGate({ mode: 'ask' })
    const d1 = await gate.check({ toolName: 'mouse_click', exec: execAgent(), action: 'click (10,20)' })
    assert(d1.allowed === true && d1.source === 'approval', JSON.stringify(d1))
    assertEqual(approvalCalls.length, 1)
    assertIncludes(approvalCalls[0].displayReason.zh, '鼠标操作')
    assertEqual(approvalCalls[0].toolName, 'mouse_click')
    const d2 = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d2.allowed === true, 'arm window means no second prompt')
    assertEqual(approvalCalls.length, 1)
  })
  await check('gate: ask mode rejection / cancellation deny', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
      const { gate } = makeGate({ mode: 'ask', approvalResult: outcome })
      const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
      assert(d.allowed === false && d.code === 'denied', `${outcome}: ${JSON.stringify(d)}`)
      assertIncludes(d.message, '未执行')
    }
  })
  await check('gate: approval service missing -> fail closed with human alternatives', async () => {
    const { gate } = makeGate({ mode: 'ask', approval: 'none' })
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === false && d.code === 'approval-unavailable', JSON.stringify(d))
    assertIncludes(d.message, 'Ctrl+Alt+F12')
  })
  await check('gate: hotkey toggles keep-on latch on/off + safetyAbort', async () => {
    const { gate, aborts } = makeGate({ mode: 'auto' })
    const on = gate.hotkeyChanged(true, 'Ctrl+Alt+F12')
    assert(on.armed === true && gate.snapshot().armed === true)
    assert(gate.snapshot().latched === true, 'hotkey must latch keep-on')
    assert(gate.snapshot().source === 'hotkey')
    assertEqual(gate.snapshot().remainingMs, -1, 'latched has no countdown')
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === true)
    gate.hotkeyChanged(undefined)
    assert(gate.snapshot().armed === false)
    gate.humanArm(60)
    gate.safetyAbort('unit-test-stop')
    assertEqual(aborts, ['unit-test-stop'])
    assert(gate.snapshot().armed === false)
  })
  await check('gate: human activity suspends injection (auto-resume state)', async () => {
    const { gate } = makeGate({ mode: 'auto' })
    gate.humanLatch('unit-test')
    gate.setSuspended({ reason: '真人鼠标移动', idleResumeMs: 20000 })
    const d = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(d.allowed === false && d.code === 'suspended', JSON.stringify(d))
    assertIncludes(d.message, '人类正在操作')
    const move = gate.checkMove('mouse_move')
    assert(move.allowed === false && move.code === 'suspended')
    gate.clearSuspended()
    const again = await gate.check({ toolName: 'mouse_click', exec: execAgent() })
    assert(again.allowed === true, 'same authorization becomes usable after suspension ends')
  })
  await check('gate: mode command switch validates + disarms on off', async () => {
    const { gate } = makeGate({ mode: 'ask' })
    gate.humanArm(60)
    const bad = gate.setMode('turbo')
    assert(bad.ok === false)
    const off = gate.setMode('off')
    assert(off.ok === true && off.mode === 'off')
    assert(gate.snapshot().armed === false)
  })

  // -------------------------------------------------------------------------
  // 5. policy helpers
  // -------------------------------------------------------------------------
  await check('policy: window deny rules', () => {
    const cfg = configLib.normalizeConfig({ denyProcesses: ['bank.exe'], denyTitleContains: ['密码'] })
    const own = policyLib.ownProcessNames(cfg)
    assert(own.includes('DeepSeek Harness.exe'), 'own process in list')
    const base = { handle: 1, title: 'OK', className: 'Notepad', pid: 1, process: 'C:\\Windows\\notepad.exe', rect: { x: 0, y: 0, w: 100, h: 100 } }
    assert(policyLib.evaluateWindowDeny(base, cfg, own).denied === false)
    assert(policyLib.evaluateWindowDeny({ ...base, denied: true }, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny({ ...base, elevated: true }, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny({ ...base, process: 'C:\\x\\BANK.exe' }, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny({ ...base, title: '输入密码' }, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny({ ...base, className: 'LogonUI' }, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny(null, cfg, own).denied === true)
    assert(policyLib.evaluateWindowDeny({ ...base, process: 'C:\\DeepSeek Harness.exe' }, cfg, own).denied === true)
  })
  await check('policy: point target resolution + snapping + bounds', () => {
    const virtual = { x: 0, y: 0, w: 2880, h: 1800 }
    const monitors = grid.normalizeMonitors([{ x: 0, y: 0, w: 2880, h: 1800, scale: 2 }])
    const xy = policyLib.resolvePointTarget({ x: 500, y: 500, snap: true }, { virtual, monitors, lattice: 'standard' })
    assert(xy.ok === true && xy.x === 540 && xy.y === 540 && xy.snapped === true, JSON.stringify(xy))
    const norm = policyLib.resolvePointTarget({ fx: 0.5, fy: 0.5 }, { virtual, monitors, lattice: 'standard' })
    assert(norm.ok === true && norm.x === 1440 && norm.y === 900, JSON.stringify(norm))
    const missing = policyLib.resolvePointTarget({}, { virtual, monitors, lattice: 'standard' })
    assert(missing.ok === false && /x,y/.test(missing.error), JSON.stringify(missing))
    const outside = policyLib.resolvePointTarget({ x: 5000, y: 5000 }, { virtual, monitors })
    assert(outside.ok === false && /不在虚拟屏幕/.test(outside.error), JSON.stringify(outside))
  })
  await check('policy: expect matching', () => {
    const win = { handle: 1, title: 'Mock Notepad - 文档', process: 'C:\\Windows\\notepad.exe' }
    assert(policyLib.checkExpect(win, { process: 'notepad' }).ok === true)
    assert(policyLib.checkExpect(win, { titleContains: '文档' }).ok === true)
    const bad = policyLib.checkExpect(win, { titleContains: 'Excel' })
    assert(bad.ok === false && bad.failed.length === 1)
    assert(policyLib.checkExpect(win, undefined).ok === true)
  })

  // -------------------------------------------------------------------------
  // 6. helper client against the mock helper (direct)
  // -------------------------------------------------------------------------
  writeScenario(baseScenario())
  await check('helper: ready + status + abort + stop', async () => {
    const cfg = configLib.normalizeConfig({ helperTimeoutMs: 8000 })
    const client = new helperLib.HelperClient({
      config: cfg,
      deny: { processes: ['DeepSeek Harness.exe'], classes: [] },
      resolveCommand: async () => ({ command: process.execPath, args: [SELF, '--mock-helper'], source: 'smoke', bootstrapVersion: 'mock', exePath: SELF }),
    })
    try {
      const ready = await client.ensureStarted()
      assert(ready.protocol === 1 && ready.pid > 0, 'ready payload')
      const st = await client.rpc('status')
      assertEqual(st.virtual.w, 2880)
      assertEqual(st.monitors[0].scale, 2)
      assert(client.abort('smoke-abort') === true)
      const ping = await client.rpc('doctor')
      assert(ping.capture.ok === true)
    } finally {
      await client.stop()
    }
  })
  await check('helper: ready timeout is a clear error', async () => {
    const cfg = configLib.normalizeConfig({ helperTimeoutMs: 1000 })
    const client = new helperLib.HelperClient({
      config: cfg,
      resolveCommand: async () => ({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], source: 'smoke-hang', exePath: 'node' }),
    })
    try {
      let message = ''
      try {
        await client.ensureStarted()
      } catch (error) {
        message = error && error.message ? error.message : String(error)
      }
      assertIncludes(message, '启动超时')
      assert(client.state().started === false)
    } finally {
      await client.stop()
    }
  })

  // -------------------------------------------------------------------------
  // 7. end-to-end: apply() with fake DSH ctx + mock helper
  // -------------------------------------------------------------------------
  const { apply } = await import('../index.js')

  const fakeServices = {
    attachments: {
      saved: [],
      async saveImage({ data, mediaType, name }) {
        const ref = { id: `att_${fakeServices.attachments.saved.length + 1}`, mediaType, name, bytes: data ? data.length : 0 }
        fakeServices.attachments.saved.push(ref)
        return ref
      },
    },
    llm: {
      imageRequestPricing(provider, model) {
        return {
          priceImages(parts) {
            return parts.map(() => ({ visualTokens: 300, text: 20, provider, model }))
          },
        }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-vision' }) },
    skills: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    webServer: {
      routes: new Map(),
      register(def) {
        fakeServices.webServer.routes.set(def.path, def)
        return () => fakeServices.webServer.routes.delete(def.path)
      },
    },
    commands: {
      handlers: new Map(),
      register(def) {
        fakeServices.commands.handlers.set(def.name, def)
        return () => fakeServices.commands.handlers.delete(def.name)
      },
    },
  }
  let approvalCalls = 0
  fakeServices.approval = {
    async request(req) {
      approvalCalls++
      lastApproval = req
      return 'allowed-once'
    },
  }
  let lastApproval = null
  const fakeCtx = {
    services: fakeServices,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get(name) {
      return fakeServices[name]
    },
    effect(cb) {
      const dispose = cb()
      fakeCtx.__cleanup = dispose
      return dispose
    },
    tools: {
      defs: new Map(),
      register(def) {
        fakeCtx.tools.defs.set(def.name, def)
        return () => fakeCtx.tools.defs.delete(def.name)
      },
    },
    commands: fakeServices.commands,
  }

  const e2eConfig = {
    mode: 'ask',
    armClicks: 2,
    armWindowMs: 8000,
    minIntervalMs: 0,
    maxImagesPerTurn: 12,
    maxImageTokensPerTurn: 200000,
    helperTimeoutMs: 8000,
    // v0.4: keep the human-idle wait short inside the suite so a suspended click
    // fails fast instead of blocking for 20 s; long-wait success is covered by a
    // dedicated runtime below.
    // v0.6: long enough for resumeOnHumanIdle wait tests; short enough that a
    // suspended tool call without resumeOnHumanIdle fails fast.
    humanWaitMaxMs: 1500,
    allowSelfWindow: true,
    allowSelfMaxMs: 120000,
    // I2（2026-11-08）：主套件显式走**回退态**（mergeReadSide=false）——下面大量 e2e 直接
    // 用 screen_info / screen_capture / window_focus 等旧 10 个工具，默认合并态不注册它们。
    // 默认态（不写配置 = 合并态 14 工具 / 全包 25）由 P4 段的独立 runtime 用例覆盖。
    mergeReadSide: false,
  }
  apply(fakeCtx, e2eConfig)
  const toolNames = [...fakeCtx.tools.defs.keys()].sort()
  const expectedTools = [
    'audit_tail',
    'click_matrix_doctor',
    'clipboard_get',
    'clipboard_set',
    'matrix_overlay',
    'mouse_abort',
    'mouse_batch',
    'mouse_click',
    'mouse_drag',
    'mouse_move',
    'mouse_scroll',
    'press_keys',
    'screen_capture',
    'screen_info',
    'screen_locate',
    'screen_read',
    'screen_text',
    'screen_view',
    'screen_wait',
    'screen_zoom',
    'type_text',
    'wait_window',
    'window_focus',
    'window_list',
  ]
  const callTool = async (name, args = {}, exec = { agent: { session: { id: 'agent-smoke' } }, callId: `call-${++toolCallSeq}` }) => {
    const def = fakeCtx.tools.defs.get(name)
    if (!def) throw new Error(`tool ${name} not registered`)
    return await def.execute(args, exec)
  }
  let toolCallSeq = 0
  const runCommand = async (rawInput) => {
    const def = fakeServices.commands.handlers.get('click-matrix')
    if (!def) throw new Error('/click-matrix not registered')
    return await def.handler({ agent: null, rawInput, signal: null })
  }
  // Test-harness determinism barrier: wait until the host has no helper RPC in
  // flight before snapshotting counters. `screen_info` performs a `status` RPC
  // and the helper processes commands FIFO, so awaiting it drains the queue of
  // anything a previous test left behind (late clicks/arm calls inflating
  // counters were the main source of the ~1/15 flake).
  const drain = async () => {
    try { await callTool('screen_info', {}) } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const latestText = (value) => (value && typeof value.text === 'string' ? value.text : '')
  const getStatusRoute = () => {
    const def = fakeServices.webServer.routes.get('/api/click-matrix/status')
    if (!def) throw new Error('GET /api/click-matrix/status not registered')
    return def
  }
  const callStatusRoute = (headers = {}, method = 'GET') => new Promise((resolve) => {
    const def = getStatusRoute()
    let statusCode = 200
    const res = {
      setHeader() {},
      writeHead(code) {
        statusCode = code
      },
      end(body) {
        resolve({ status: statusCode, body: String(body || '') })
      },
    }
    def.handler({ method, headers }, res)
  })
  const parseJsonBody = (result) => {
    try {
      return JSON.parse(result.body)
    } catch {
      throw new Error('status route did not return JSON: ' + result.body.slice(0, 200))
    }
  }
  const getConfigRoute = () => {
    const def = fakeServices.webServer.routes.get('/api/click-matrix/config')
    if (!def) throw new Error('GET/POST /api/click-matrix/config not registered')
    return def
  }
  // POST helper: the handler reads the body through req.on('data'/'end').
  const callConfigRoute = (payload, headers = {}, method = 'POST') => new Promise((resolve) => {
    const def = getConfigRoute()
    let statusCode = 200
    const res = {
      setHeader() {},
      writeHead(code) { statusCode = code },
      end(body) { resolve({ status: statusCode, body: String(body || '') }) },
    }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const req = {
      method,
      headers,
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(text))
        else if (event === 'end') cb()
        return req
      },
      destroy() {},
    }
    try { def.handler(req, res) } catch (e) { resolve({ status: 500, body: String((e && e.message) || e) }) }
  })
  const waitFor = async (predicate, timeoutMs = 3000, stepMs = 50) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await predicate()) return true
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, stepMs))
    }
    return false
  }
  // 2026-11-08 时序加固（human-idle 用例组）：把「人类开始操作」改成**事件驱动**——
  // 等第一下点击真的进了 mock helper 的计数器，再写 human-mouse 事件文件。
  // 原来这些用例用固定 `setTimeout(..., 80~120ms)` 发信号，机器有负载时会抢在
  // **第一下点击之前**发生：批量一步都没执行，而断言要求「已执行 1/3」→ 直接红
  // （未改动的树上同样复现，属用例时序过严，不是产品缺陷）。
  // 这里等的是真实事件（点击计数增长），断言一条没放宽：仍是「第 1 个动作执行完、
  // 后续动作被人类活动打断」。
  const emitHumanActivityAfterFirstClick = async (before, timeoutMs = 5000) => {
    const seen = await waitFor(() => (readCounters().click || 0) > before, timeoutMs, 10)
    if (!seen) throw new Error(`第一下点击在 ${timeoutMs}ms 内没有进计数器，无法注入人类活动事件`)
    emitEvents([{ event: 'human-mouse', data: { x: 5, y: 5 } }])
  }

  await check('e2e (回退态): 显式 mergeReadSide=false 注册 24 个工具（旧 10 + screen_view）', () => {
    // I2：默认已切 true（合并态 14）；显式 false 必须真的回到 24，否则回退路径是假的。
    assertEqual(configLib.normalizeConfig({ mergeReadSide: false }).mergeReadSide, false, '显式 false 必须覆盖默认 true')
    assertEqual(configLib.normalizeConfig({ mergeReadSide: 'false' }).mergeReadSide, false, '字符串 "false" 也必须生效')
    assertEqual(toolNames, expectedTools)
    for (const name of expectedTools) {
      const def = fakeCtx.tools.defs.get(name)
      assert(def && typeof def.execute === 'function', 'missing execute ' + name)
      assert(def.output && typeof def.output.render === 'function', 'missing render ' + name)
      assert(def.output.schema && def.output.schema.type === 'object', 'output schema ' + name)
      assert(def.parameters && def.parameters.type === 'object', 'parameters schema ' + name)
    }
  })
  // -------------------------------------------------------------------------
  // P4（v0.9.5）/ I2: screen_view 读侧合并入口 + mergeReadSide 两种工具面
  //   默认（不写配置；I2 起 true）→ **合并态**：pixel 14 个工具（旧 10 个不注册，只留 screen_view）
  //   显式 false               → **回退态**：pixel 24 个工具（旧 7 读 + 3 窗口 + screen_view）
  //   本套件主 runtime 显式 false（下面大量旧工具用例需要），默认态用独立 runtime 验。
  // -------------------------------------------------------------------------
  await check('e2e (P4, 显式 false 回退态): screen_view dispatches to the 7 read tools', async () => {
    writeScenario(baseScenario())
    const info = await callTool('screen_view', { action: 'info' })
    const infoText = latestText(info)
    assertIncludes(infoText, '2880x1800@2x')
    // describeConfig 里带了 flag，模型/人类都能从 screen_info 看出当前读侧模式。
    assertIncludes(infoText, 'mergeReadSide=false')
    const locate = await callTool('screen_view', { action: 'locate', x: 400, y: 300 })
    assertIncludes(latestText(locate), '晶格')
    const cap = await callTool('screen_view', { action: 'capture', region_rect: { x: 0, y: 0, w: 400, h: 300 } })
    const capText = latestText(cap)
    assert(cap.imageRef, 'screen_view(action=capture) 必须透传 imageRef: ' + capText)
    // 显式 false（回退态）时旧工具仍然注册 → 输出里的旧名不改写（回滚态行为与今天一致）。
    assertIncludes(capText, 'screen_locate')
    const bad = await callTool('screen_view', { action: 'nope' })
    assertIncludes(latestText(bad), '需要有效的 action')
    assertIncludes(latestText(bad), 'info|capture')
    // 显式 false：doctor 的工具清单期望 24 个（含旧 10 个 + screen_view）且必须 PASS。
    const doc = await callTool('click_matrix_doctor')
    const docText = latestText(doc)
    assert(docText.includes('24 个:'), '显式 false 下 doctor 应看到 24 个工具（实际工具清单行: ' + docText.split('\n').filter((l) => l.includes('工具清单')).join(' | ') + '）')
    assert(!/FAIL[^\n]*工具清单/.test(docText), '显式 false 下工具清单不该 FAIL: ' + docText.split('\n').filter((l) => l.includes('工具清单')).join(' | '))
    assertIncludes(docText, 'mergeReadSide=false')
    // 本 check 拍了两张图（screen_view 的 capture 通路）；后面的断言按绝对张数计数，
    // 这里把这几次附件记录收回，保持原有测试的假设。
    fakeServices.attachments.saved.length = 0
  })
  await check('e2e (P4/P6, 默认态): 不写配置即合并态（14 工具），screen_view 仍可用', async () => {
    const scenario4Path = join(tmpRoot, 'scenario4.json')
    const counters4Path = join(tmpRoot, 'counters4.json')
    const events4Path = join(tmpRoot, 'events4.json')
    writeJsonFile(scenario4Path, {
      countersPath: counters4Path,
      eventsPath: events4Path,
      virtual: { x: 0, y: 0, w: 2880, h: 1800 },
      monitors: [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }],
      foreground: defaultForeground,
      windows: [defaultForeground],
    })
    const prevScenario = process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO
    process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = scenario4Path
    let mergedState = null
    const savedBeforeFlag = fakeServices.attachments.saved.length
    try {
      const indexModule = await import('../index.js')
      // I2：默认态 = **不写** mergeReadSide（新默认 true）。主套件为跑旧工具用例显式写了
      // false，这里先把它摘掉，验证「装完即合并态、不需要写 config-overrides 重启」。
      const { mergeReadSide: _mainSuiteRollbackFlag, ...defaultBase } = e2eConfig
      void _mainSuiteRollbackFlag
      const cfg4 = configLib.normalizeConfig(defaultBase)
      // 同一份 config 走 boolIn clamp：字符串不会把开关偷偷打开/关掉；非法值回落默认。
      assertEqual(cfg4.mergeReadSide, true, '不写配置时 mergeReadSide 默认必须是 true')
      assertEqual(configLib.normalizeConfig({ mergeReadSide: 'true' }).mergeReadSide, true)
      assertEqual(configLib.normalizeConfig({ mergeReadSide: 'nonsense' }).mergeReadSide, true, '非法值应回落默认 true')
      assertEqual(configLib.normalizeConfig({}).mergeReadSide, true, 'flag 默认必须是 true（I2 起）')
      mergedState = indexModule.__createRuntime(fakeCtx, cfg4)
      const defs4 = indexModule.__buildToolDefinitions(mergedState)
      const names4 = defs4.map((d) => d.name).sort()
      // install() 会把工具名快照塞进 state（doctor 的「工具清单」用它）；这里手动补上。
      mergedState.toolNames = names4
      mergedState.toolDefs = defs4.map((def) => ({ name: def.name, description: def.description }))
      const legacyReadTools = ['screen_capture', 'screen_info', 'screen_locate', 'screen_read', 'screen_text', 'screen_wait', 'screen_zoom']
      const legacyWindowTools = ['wait_window', 'window_focus', 'window_list']
      assertEqual(names4.length, 14, '默认合并态 pixel 必须只剩 14 个工具，实际: ' + names4.join(' '))
      for (const name of [...legacyReadTools, ...legacyWindowTools]) {
        assert(!names4.includes(name), `默认合并态下 ${name} 必须不注册`)
      }
      assert(names4.includes('screen_view'), '默认合并态下 screen_view 必须仍然注册')
      for (const must of ['mouse_click', 'mouse_batch', 'type_text', 'click_matrix_doctor']) {
        assert(names4.includes(must), `非读侧工具 ${must} 不能受 flag 影响`)
      }
      const viewDef = defs4.find((d) => d.name === 'screen_view')
      assertEqual(viewDef.parameters.properties.action.enum.join('/'), 'info/capture/zoom/locate/text/read/wait/list/focus/wait_window')
      const exec4 = { agent: { session: { id: 'agent-merged' } }, callId: 'call-merged' }
      const info4 = await viewDef.execute({ action: 'info' }, exec4)
      assertIncludes(latestText(info4), 'mergeReadSide=true')
      const cap4 = await viewDef.execute({ action: 'capture', region_rect: { x: 0, y: 0, w: 400, h: 300 } }, exec4)
      const cap4Text = latestText(cap4)
      assert(cap4.imageRef, '默认态下 screen_view(action=capture) 仍须返回 imageRef: ' + cap4Text)
      // 默认合并态下旧工具已不注册 → 返回文本里的旧名必须被改写成 screen_view(action=…)。
      assertIncludes(cap4Text, 'screen_view(action=locate)')
      assert(!cap4Text.includes('screen_locate'), '默认合并态下不许在输出里出现已不注册的 screen_locate')
      const c4 = readJsonFile(counters4Path, {})
      assert((c4.capture || 0) >= 1, '默认态的 mock helper 确实被调用过（capture>=1）')
      // doctor 的工具清单必须随默认合并态收窄，否则默认态机器上 doctor 会误报「缺 10 个」。
      const doctorDef4 = defs4.find((d) => d.name === 'click_matrix_doctor')
      const doc4Text = latestText(await doctorDef4.execute({}, exec4))
      const doc4Line = doc4Text.split('\n').filter((l) => l.includes('工具清单')).join(' | ')
      assertIncludes(doc4Text, 'mergeReadSide=true')
      assert(doc4Text.includes('14 个:'), '默认态下 doctor 应看到 14 个工具（工具清单行: ' + doc4Line + '）')
      assert(!/FAIL[^\n]*工具清单/.test(doc4Text), '默认态下工具清单不该 FAIL: ' + doc4Line)
    } finally {
      // 本 check 也走了一次 capture 通路，收回附件记录（后面的断言按绝对张数计数）。
      fakeServices.attachments.saved.length = savedBeforeFlag
      if (mergedState) await mergedState.helper.stop()
      process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = prevScenario
    }
  })
  await check('e2e (P4, 独立 runtime): 显式 false 才回退到 24 工具，默认不写配置是 14', async () => {
    // I2 回退路径的独立取证：同一份 base（不含 flag）下，显式 false 必须回 24 个；
    // 不写 flag（默认 true）必须只有 14 个——两个模式互斥，不能靠"主套件碰巧写了 false"。
    const indexModule = await import('../index.js')
    const { mergeReadSide: _baseFlag, ...baseNoFlag } = e2eConfig
    void _baseFlag
    const { mergeReadSide: _defaultsFlag, ...defaultBase } = e2eConfig
    void _defaultsFlag
    const rollbackCfg = configLib.normalizeConfig({ ...baseNoFlag, mergeReadSide: false })
    assertEqual(rollbackCfg.mergeReadSide, false, '显式 false 的归一化结果')
    const defaultCfg = configLib.normalizeConfig(defaultBase)
    assertEqual(defaultCfg.mergeReadSide, true, '不写 flag 的归一化结果（默认 true）')
    const legacyTools = [
      'screen_capture', 'screen_info', 'screen_locate', 'screen_read', 'screen_text', 'screen_wait', 'screen_zoom',
      'wait_window', 'window_focus', 'window_list',
    ]
    const rollbackState = indexModule.__createRuntime(fakeCtx, rollbackCfg)
    const defaultState = indexModule.__createRuntime(fakeCtx, defaultCfg)
    try {
      const rollbackNames = indexModule.__buildToolDefinitions(rollbackState).map((d) => d.name).sort()
      const defaultNames = indexModule.__buildToolDefinitions(defaultState).map((d) => d.name).sort()
      assertEqual(rollbackNames.length, 24, '显式 false 必须回到 24 个 pixel 工具（全包 35），实际: ' + rollbackNames.join(' '))
      assertEqual(defaultNames.length, 14, '默认态必须只有 14 个 pixel 工具（全包 25），实际: ' + defaultNames.join(' '))
      for (const name of legacyTools) {
        assert(rollbackNames.includes(name), `显式 false 下旧工具 ${name} 必须注册（回退路径不能是假的）`)
        assert(!defaultNames.includes(name), `默认态下旧工具 ${name} 必须不注册`)
      }
      assert(rollbackNames.includes('screen_view') && defaultNames.includes('screen_view'), '两种模式都必须有 screen_view')
      // 24 = 14 + 旧 10，两个集合的差集必须正好是旧 10 个（防"多注册/少注册"被数量巧合掩盖）。
      const onlyInRollback = rollbackNames.filter((n) => !defaultNames.includes(n)).sort()
      assertEqual(onlyInRollback, legacyTools.slice().sort(), '回退态比默认态多出来的必须正好是旧 10 个')
    } finally {
      await rollbackState.helper.stop()
      await defaultState.helper.stop()
    }
  })
  await check('e2e: /click-matrix command registered', () => {
    const def = fakeServices.commands.handlers.get('click-matrix')
    assert(def && def.name === 'click-matrix' && typeof def.handler === 'function')
    assert(fakeServices.skills !== null)
  })

  await check('e2e: screen_info reports monitors/scale/virtual screen/access', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_info')
    const text = latestText(value)
    assertIncludes(text, '2880x1800@2x')
    assertIncludes(text, '虚拟屏(物理px): (0,0) 2880x1800')
    assertIncludes(text, 'mode=ask')
    assertIncludes(text, 'Mock Notepad')
    assertIncludes(text, '当前晶格: standard · 屏幕间距 180px')
    syncMockPid()
    assert(mockPid > 0, 'mock helper started')
  })
  await check('e2e: screen_capture returns image + mapping metadata', async () => {
    writeScenario(baseScenario())
    const args = { region: { x: 0, y: 0, w: 800, h: 600 } }
    const value = await callTool('screen_capture', args)
    const text = latestText(value)
    assertIncludes(text, '截图: 区域 (0,0) 800x600')
    assertIncludes(text, '映射: 屏幕x = 0 + fx*800')
    assertIncludes(text, '晶格: standard · 屏幕间距 180px · 图像间距 180px')
    const blocks = fakeCtx.tools.defs.get('screen_capture').output.render(args, value)
    assertEqual(blocks.length, 2)
    assertEqual(blocks[0].type, 'text')
    assertEqual(blocks[1].type, 'image')
    assert(blocks[1].attachment && blocks[1].attachment.id, 'attachment ref')
    assertEqual(fakeServices.attachments.saved.length, 1)
    assertIncludes(text, '约')
    assertIncludes(text, 'tokens')
  })
  await check('e2e: duplicate capture is deduped (no image)', async () => {
    const args = { region: { x: 0, y: 0, w: 800, h: 600 } }
    const value = await callTool('screen_capture', args)
    const text = latestText(value)
    assertIncludes(text, '画面未变化')
    assert(!value.imageRef, 'must not return imageId')
    const blocks = fakeCtx.tools.defs.get('screen_capture').output.render(args, value)
    assertEqual(blocks.length, 1)
  })
  await check('e2e: lattice too fine for binning is rejected with advice', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_capture', { region: 'full', lattice: 'micro', binning: '8' })
    const text = latestText(value)
    assertIncludes(text, '截图参数冲突')
    assertIncludes(text, '≥ 8px')
    assert(!value.imageRef, 'no image on parameter error')
  })
  await check('e2e: binning 2 capture works with valid lattice', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_capture', { region: { x: 0, y: 0, w: 800, h: 600 }, binning: 2, lattice: 'standard' })
    assert(value.imageRef, 'image expected: ' + latestText(value))
    assertIncludes(latestText(value), '图像间距 90px')
  })
  await check('e2e: invalid view/binning arguments produce clear errors', async () => {
    const v1 = await callTool('screen_capture', { binning: '9' })
    assertIncludes(latestText(v1), 'binning 参数无效')
    const v2 = await callTool('screen_capture', { lattice: 'ultra' })
    assertIncludes(latestText(v2), 'lattice 参数无效')
  })
  await check('e2e: out-of-bounds region is rejected with a clear boundary error', async () => {
    writeScenario(baseScenario())
    const outOfBounds = await callTool('screen_capture', { region: { x: 1304, y: 0, w: 1592, h: 1652 } })
    const text = latestText(outOfBounds)
    assertIncludes(text, '区域超出虚拟屏幕 (0,0 2880x1800)')
    assertIncludes(text, '请求 (1304,0 1592x1652)')
    assertIncludes(text, '请夹取到屏幕内，或改用 region:"foreground"/"full"')
    assert(!outOfBounds.imageRef, 'out-of-bounds region must not capture an image')
    // The same region only 92px narrower fits and must still capture normally.
    const inside = await callTool('screen_capture', { region: { x: 1304, y: 0, w: 1500, h: 1652 }, binning: 8, lattice: 'standard' })
    assert(inside.imageRef, 'in-bounds region should capture: ' + latestText(inside))
    assertIncludes(latestText(inside), '截图: 区域 (1304,0) 1500x1652')
  })
  await check('e2e: region argument shape errors stay explicit', async () => {
    const badNumbers = await callTool('screen_capture', { region: { x: 'left', y: 0, w: 100, h: 100 } })
    assertIncludes(latestText(badNumbers), 'region 需要数字 x,y,w,h')
    const zero = await callTool('screen_capture', { region: { x: 0, y: 0, w: 0, h: 100 } })
    assertIncludes(latestText(zero), 'region 宽高必须 ≥1')
    const notObject = await callTool('screen_capture', { region: 'nonsense' })
    assertIncludes(latestText(notObject), 'region 只能是')
  })
  await check('e2e: screen_locate finds nearest lattice point', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_locate', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '最近晶格点: (540,540)')
    assertIncludes(text, 'onLattice=true')
    assertIncludes(text, '所在格: col=2 row=2')
    assert(!value.imageRef, 'locate is text-only')
    const norm = await callTool('screen_locate', { fx: 0.5, fy: 0.5 })
    assertIncludes(latestText(norm), '(1440,900)')
  })
  await check('e2e: screen_zoom returns sub-lattice image + formulas', async () => {
    writeScenario(baseScenario())
    const args = { x: 500, y: 500, size: 120, scale: 3, subCols: 6, subRows: 6 }
    const value = await callTool('screen_zoom', args)
    assert(value.imageRef, 'zoom image: ' + latestText(value))
    const text = latestText(value)
    assertIncludes(text, '子格: 6x6')
    assertIncludes(text, '子格中心公式')
    assertIncludes(text, 'sx =')
    assertIncludes(text, '放大 3x')
  })
  await check('e2e: screen_zoom rejects impossible sub-lattice', async () => {
    const value = await callTool('screen_zoom', { x: 500, y: 500, size: 60, scale: 1, subCols: 12, subRows: 12 })
    assertIncludes(latestText(value), 'zoom 参数冲突')
    assert(!value.imageRef)
  })
  await check('e2e: screen_text lists UIA elements with clickable centers', async () => {
    const uiaPayload = {
      ok: true,
      dpiAware: true,
      window: { title: 'Mock Notepad', pid: 4242, process: 'C:\\Windows\\notepad.exe' },
      scanned: 12,
      truncated: false,
      elements: [
        { type: 'Button', name: '保存', automationId: 'saveBtn', rect: { x: 100, y: 200, width: 80, height: 30 }, center: { x: 140, y: 215 }, patterns: ['Invoke'], isEnabled: true },
        { type: 'Edit', name: '文件名', automationId: 'fileName', rect: { x: 100, y: 250, width: 300, height: 24 }, center: { x: 250, y: 262 }, patterns: ['Value'], isEnabled: true },
      ],
    }
    writeJsonFile(uiaPath, uiaPayload)
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const value = await callTool('screen_text', {})
      const text = latestText(value)
      assertIncludes(text, '元素 2 个')
      assertIncludes(text, '"保存"')
      assertIncludes(text, '中心=(140,215)')
      assertIncludes(text, '[Invoke]')
      assert(!value.imageRef, 'text-only')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
    }
  })
  await check('e2e: window_list lists windows with process/flags', async () => {
    writeScenario(baseScenario())
    const value = await callTool('window_list', {})
    const text = latestText(value)
    assertIncludes(text, '可见窗口 2 个')
    assertIncludes(text, 'Mock Notepad')
    assertIncludes(text, 'notepad.exe')
    assertIncludes(text, 'Mock Explorer')
  })
  await check('e2e: mouse_move reports landing window', async () => {
    writeScenario(baseScenario())
    const value = await callTool('mouse_move', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '光标已移动到 (500,500)')
    assertIncludes(text, '落点窗口: "Mock Notepad"')
    assert(!value.imageRef)
  })
  await check('e2e: mouse_click (ask approval -> allowed) clicks once + verifies', async () => {
    writeScenario(baseScenario())
    approvalCalls = 0
    const value = await callTool('mouse_click', { x: 500, y: 500, verify: 'text' })
    const text = latestText(value)
    assertIncludes(text, '已点击 (500,500) left')
    assertIncludes(text, '点击后前台: "Mock Notepad"')
    assertEqual(readCounters().click, 1)
    assertEqual(approvalCalls, 1)
    assertIncludes(lastApproval.displayReason.zh, '鼠标操作')
    assertIncludes(String(lastApproval.reason), 'mouse_click')
  })
  await check('e2e: second click consumes arm window without new approval', async () => {
    writeScenario(baseScenario())
    const before = approvalCalls
    const value = await callTool('mouse_click', { x: 500, y: 500, verify: 'crop' })
    const text = latestText(value)
    assertIncludes(text, '已点击 (500,500)')
    assertIncludes(text, '验证截图')
    assert(value.imageRef, 'verify crop image expected')
    assertEqual(readCounters().click, 1)
    assertEqual(approvalCalls, before, 'no additional approval inside arm window')
  })
  await check('e2e: /click-matrix status + mode + stop', async () => {
    const status = await runCommand('status')
    assertEqual(status.kind, 'success')
    assertIncludes(status.text, 'click-matrix 状态')
    assertIncludes(status.text, '虚拟屏')
    const mode = await runCommand('mode auto')
    assertIncludes(mode.text, 'mode: ask → auto')
    const stop = await runCommand('stop')
    assertIncludes(stop.text, '已停止')
  })
  await check('e2e: auto mode without arm denies (no approval prompt)', async () => {
    await new Promise((r) => setTimeout(r, 150))
    writeScenario(baseScenario())
    approvalCalls = 0
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '必须有人类授权窗口')
    assertIncludes(text, '/click-matrix arm')
    assertEqual(readCounters().click || 0, 0)
    assertEqual(approvalCalls, 0)
  })
  await check('e2e: /click-matrix arm grants armClicks then auto-denies again', async () => {
    writeScenario(baseScenario())
    const arm = await runCommand('arm 60')
    assertIncludes(arm.text, '已授权鼠标操作')
    const c1 = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(c1), '已点击')
    const c2 = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(c2), '已点击')
    const c3 = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(c3), '必须有人类授权窗口')
    assertEqual(readCounters().click, 2)
  })
  await check('e2e: denied target window blocks click before any mouse action', async () => {
    writeScenario(baseScenario({ foreground: { ...defaultForeground, denied: true } }))
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '已拒绝点击：目标窗口不安全')
    assertIncludes(text, 'helper 将该窗口标记为禁止')
    assertEqual(readCounters().click || 0, 0)
  })
  await check('e2e: elevated target window is denied', async () => {
    writeScenario(baseScenario({ foreground: { ...defaultForeground, elevated: true } }))
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(value), '管理员权限')
    assertEqual(readCounters().click || 0, 0)
  })
  await check('e2e: expect mismatch blocks click', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { x: 500, y: 500, expect: { titleContains: 'Excel' } })
    const text = latestText(value)
    assertIncludes(text, '与 expect 不符')
    assertEqual(readCounters().click || 0, 0)
  })
  await check('e2e: window changing between pre-check and click aborts + aborts helper', async () => {
    writeScenario(
      baseScenario({
        probeFlip: true,
        flipWindow: { ...defaultForeground, handle: 999, title: 'Other Window', pid: 7777 },
      }),
    )
    const abortBefore = readCounters().abort || 0
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '点击已中止')
    assertIncludes(text, '窗口发生变化')
    await new Promise((r) => setTimeout(r, 120))
    assertEqual(readCounters().click || 0, 0)
    assert((readCounters().abort || 0) > abortBefore, 'abort sent')
    const after = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(after), '必须有人类授权窗口', 'safety abort clears arm')
  })
  await check('e2e: mode off denies mouse tools', async () => {
    writeScenario(baseScenario())
    await runCommand('mode off')
    const click = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(click), '鼠标控制已关闭')
    const move = await callTool('mouse_move', { x: 500, y: 500 })
    assertIncludes(latestText(move), '鼠标控制已关闭')
    await runCommand('mode auto')
  })
  await check('e2e: mouse_drag runs with arm and reports windows', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const value = await callTool('mouse_drag', { from: { x: 400, y: 400 }, to: { x: 700, y: 500 }, durationMs: 200 })
    const text = latestText(value)
    assertIncludes(text, '已拖拽 (400,400) → (700,500)')
    assertIncludes(text, '起点窗口: "Mock Notepad"')
    assertEqual(readCounters().drag, 1)
  })
  await check('e2e: mouse_drag rejects invalid duration/from', async () => {
    const bad = await callTool('mouse_drag', { from: {}, to: { x: 700, y: 500 } })
    assertIncludes(latestText(bad), '拖拽起点需要')
    const virtual = await callTool('mouse_drag', { from: { x: 400, y: 400 }, to: { x: 99999, y: 500 } })
    assertIncludes(latestText(virtual), '不在虚拟屏幕')
  })
  await check('e2e: mouse_scroll runs with arm', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const value = await callTool('mouse_scroll', { delta: 2, x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '已滚动 +2 格（向下）')
    assertEqual(readCounters().scroll, 1)
    const bad = await callTool('mouse_scroll', { delta: 0 })
    assertIncludes(latestText(bad), 'delta 无效')
  })
  await check('e2e: mouse_abort attaches nothing but releases keys; keeps authorization by default (v0.8.5)', async () => {
    const abortBefore = readCounters().abort || 0
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_abort')
    const text = latestText(value)
    assertIncludes(text, '已发送 abort')
    assertIncludes(text, '授权: 已保留')
    await new Promise((r) => setTimeout(r, 120))
    assert((readCounters().abort || 0) > abortBefore, 'abort counted')
    // The old semantics (always disarm) only survive as an explicit opt-in.
    const armedNow = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(armedNow.armed, true, 'mouse_abort must NOT disarm by default: ' + JSON.stringify(armedNow))
    const cleared = await callTool('mouse_abort', { disarm: true })
    assertIncludes(latestText(cleared), '已按 disarm:true 清除')
    const armedAfter = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(armedAfter.armed, false, 'disarm:true must clear the arm')
  })
  await check('e2e: matrix_overlay show/hide', async () => {
    const show = await callTool('matrix_overlay', { show: true, mode: 'both', label: 'smoke' })
    assertIncludes(latestText(show), '覆盖层已显示')
    assertIncludes(latestText(show), 'label="smoke"')
    const hide = await callTool('matrix_overlay', { show: false })
    assertIncludes(latestText(hide), '覆盖层已隐藏')
  })
  await check('e2e: /click-matrix lattice + binning + overlay commands', async () => {
    const lat = await runCommand('lattice fine')
    assertIncludes(lat.text, 'lattice=fine')
    const bin = await runCommand('binning 4')
    assertIncludes(bin.text, 'binning=4')
    const overlay = await runCommand('overlay off')
    assertIncludes(overlay.text, 'overlayMode=off')
    const bad = await runCommand('lattice nope')
    assertIncludes(bad.text, '用法: /click-matrix lattice')
    await runCommand('lattice standard')
    await runCommand('binning target')
    await runCommand('overlay auto')
  })
  await check('e2e: click_matrix_doctor runs helper + host checks', async () => {
    writeScenario(baseScenario())
    const value = await callTool('click_matrix_doctor')
    const text = latestText(value)
    assertIncludes(text, 'click-matrix doctor:')
    assertIncludes(text, 'helper 进程:')
    assertIncludes(text, 'helper doctor')
    assertIncludes(text, 'PASS')
    assert(!value.imageRef)
  })
  await check('v0.8.5: doctor surfaces overlay hitTestable + physical buttons', async () => {
    writeScenario(baseScenario({
      overlayVisible: true,
      overlayHitTestable: true,
      physicalButtonsDown: { left: true, right: false, middle: false },
    }))
    const value = await callTool('click_matrix_doctor')
    const text = latestText(value)
    assertIncludes(text, 'overlayHitTestable=true')
    assertIncludes(text, 'physicalButtons=left')
    writeScenario(baseScenario())
  })
  await check('e2e: audit_tail shows mutating attempts', async () => {
    const value = await callTool('audit_tail', { n: 60 })
    const text = latestText(value)
    assertIncludes(text, '审计日志')
    assertIncludes(text, 'mouse_click')
    assert(/mouse_click (allowed|denied)/.test(text), 'has click decision: ' + text.slice(0, 400))
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    assert(existsSync(auditFile), 'audit file exists: ' + auditFile)
    const lines = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean)
    assert(lines.length >= 5, 'audit lines ' + lines.length)
    const parsed = lines.map((l) => JSON.parse(l))
    assert(parsed.some((e) => e.tool === 'mouse_click' && e.decision === 'denied'), 'denied entry recorded')
    assert(parsed.some((e) => e.tool === 'mouse_click' && e.decision === 'allowed'), 'allowed entry recorded')
  })
  await check('e2e: argument validation returns text errors, never throws', async () => {
    const a = await callTool('mouse_click', {})
    assertIncludes(latestText(a), '点击目标需要')
    const b = await callTool('screen_locate', {})
    assertIncludes(latestText(b), '定位点需要')
    writeJsonFile(uiaPath, { ok: true, dpiAware: true, window: { title: 'Mock', pid: 1 }, elements: [] })
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const c = await callTool('screen_text', { maxElements: 999 })
      assertIncludes(latestText(c), '没有可交互元素')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
    }
  })

  // -------------------------------------------------------------------------
  // 8. v0.2: gated keyboard / clipboard tools
  // -------------------------------------------------------------------------
  await check('e2e: type_text/press_keys/clipboard blocked without arm', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    const t = await callTool('type_text', { text: 'hello' })
    assertIncludes(latestText(t), '未执行')
    assertIncludes(latestText(t), '/click-matrix arm')
    const k = await callTool('press_keys', { keys: ['enter'] })
    assertIncludes(latestText(k), '未执行')
    const g = await callTool('clipboard_get', {})
    assertIncludes(latestText(g), '未执行')
    assertEqual(readCounters().typeText || 0, 0)
    assertEqual(readCounters().pressKeys || 0, 0)
    assertEqual(readCounters().clipboardGet || 0, 0)
  })
  await check('e2e: type_text/press_keys/clipboard allowed after arm', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const t = await callTool('type_text', { text: 'hello world' })
    assertIncludes(latestText(t), '已发送 11 个字符')
    assertIncludes(latestText(t), '内容不回显')
    assertEqual(readCounters().typeText, 1)
    assertEqual(readCounters().lastTypeChars, 11)
    await runCommand('arm 60')
    const k = await callTool('press_keys', { keys: ['ctrl', 'c'] })
    assertIncludes(latestText(k), '已发送按键: ctrl+c')
    assertEqual(readCounters().pressKeys, 1)
    await runCommand('arm 60')
    const g = await callTool('clipboard_get', {})
    assertIncludes(latestText(g), 'mock clipboard text')
    await runCommand('arm 60')
    const s = await callTool('clipboard_set', { text: 'abc123' })
    assertIncludes(latestText(s), '已写入剪贴板 6 字符')
    assertEqual(readCounters().clipboardSet, 1)
    // unknown keys are rejected before the helper is touched
    const bad = await callTool('press_keys', { keys: ['ctrl', 'q'] })
    assertIncludes(latestText(bad), '不支持的按键')
    const noKeys = await callTool('press_keys', {})
    assertIncludes(latestText(noKeys), 'keys 需要非空数组')
    await runCommand('stop')
  })
  await check('e2e: clipboard_get truncates long text to 2000 chars', async () => {
    writeScenario(baseScenario({ clipboard: 'x'.repeat(2500) }))
    await runCommand('arm 60')
    const value = await callTool('clipboard_get', {})
    const text = latestText(value)
    assertIncludes(text, '2500 字符')
    assertIncludes(text, '已截断')
    assertIncludes(text, '仅显示前 2000 字符')
    assert(!value.imageRef, 'clipboard is text only')
  })
  await check('e2e: clipboard_get empty read reports no text instead of empty string', async () => {
    writeScenario(baseScenario({ clipboardEmpty: true }))
    await runCommand('arm 60')
    const value = await callTool('clipboard_get', {})
    const text = latestText(value)
    assertIncludes(text, '剪贴板当前没有文本')
    assertIncludes(text, 'press_keys ctrl+c')
    assertIncludes(text, 'helper: no-text')
    assert(!text.includes('(空)'), 'must not render an empty-string placeholder')
    assert(!value.imageRef)
    await runCommand('stop')
  })
  await check('e2e: clipboard_get requireText helper failure returns a friendly error', async () => {
    writeScenario(baseScenario({ clipboardRequireFail: true }))
    await runCommand('arm 60')
    const value = await callTool('clipboard_get', { requireText: true })
    const text = latestText(value)
    assertIncludes(text, '读取剪贴板失败')
    assertIncludes(text, 'requireText=true')
    assertIncludes(text, 'press_keys')
    assertEqual(readCounters().lastClipboardRequireText, true, 'requireText passed through to helper')
    await runCommand('stop')
  })
  await check('e2e: clipboard_get normal text still reads normally', async () => {
    writeScenario(baseScenario({ clipboard: 'hello 点阵' }))
    await runCommand('arm 60')
    const value = await callTool('clipboard_get', { requireText: true })
    const text = latestText(value)
    assertIncludes(text, '剪贴板文本')
    assertIncludes(text, 'hello 点阵')
    assert(!text.includes('没有文本'))
    await runCommand('stop')
  })
  await check('e2e: screen_capture window clientOnly is passed through and reported', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_capture', { region: 'window', window: { handle: 222 }, clientOnly: true, binning: '8' })
    const text = latestText(value)
    assertIncludes(text, '客户区截图')
    assertIncludes(text, 'PrintWindow')
    assertEqual(readCounters().lastCaptureClientOnly, true, 'clientOnly passed to helper capture')
    assert(value.imageRef, 'window client-area capture should return an image: ' + text)
  })
  await check('e2e: enableKeyboard/enableClipboard=false reject with clear message', async () => {
    const scenario2Path = join(tmpRoot, 'scenario2.json')
    const counters2Path = join(tmpRoot, 'counters2.json')
    const events2Path = join(tmpRoot, 'events2.json')
    writeJsonFile(scenario2Path, {
      countersPath: counters2Path,
      eventsPath: events2Path,
      virtual: { x: 0, y: 0, w: 2880, h: 1800 },
      monitors: [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }],
      foreground: defaultForeground,
      windows: [defaultForeground],
    })
    const prevScenario = process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO
    process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = scenario2Path
    let disabledState = null
    try {
      const indexModule = await import('../index.js')
      const cfg2 = configLib.normalizeConfig({ mode: 'auto', enableKeyboard: false, enableClipboard: false, helperTimeoutMs: 8000 })
      disabledState = indexModule.__createRuntime(fakeCtx, cfg2)
      const defs2 = indexModule.__buildToolDefinitions(disabledState)
      const names2 = defs2.map((d) => d.name)
      assert(names2.includes('type_text') && names2.includes('press_keys') && names2.includes('clipboard_get'), 'tools stay registered')
      const find2 = (name) => defs2.find((d) => d.name === name)
      const exec = { agent: { session: { id: 'agent-disabled' } }, callId: 'call-disabled' }
      await disabledState.gate.humanArm(60, 'command')
      const t = await find2('type_text').execute({ text: 'nope' }, exec)
      assertIncludes(latestText(t), 'keyboard 已在配置中禁用')
      const p = await find2('press_keys').execute({ keys: ['enter'] }, exec)
      assertIncludes(latestText(p), 'keyboard 已在配置中禁用')
      const g = await find2('clipboard_get').execute({}, exec)
      assertIncludes(latestText(g), 'clipboard 已在配置中禁用')
      const s = await find2('clipboard_set').execute({ text: 'x' }, exec)
      assertIncludes(latestText(s), 'clipboard 已在配置中禁用')
      const counters2 = readJsonFile(counters2Path, {})
      assertEqual(counters2.typeText || 0, 0)
      assertEqual(counters2.clipboardGet || 0, 0)
    } finally {
      if (disabledState) await disabledState.helper.stop()
      process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = prevScenario
    }
  })

  // -------------------------------------------------------------------------
  // 9. v0.2: screen_wait (stable / timeout), window capture, mouse_batch
  // -------------------------------------------------------------------------
  await check('e2e: screen_wait detects a stable screen without images', async () => {
    writeScenario(baseScenario())
    const before = readCounters().capture || 0
    const value = await callTool('screen_wait', { timeoutMs: 3000, stableMs: 120 })
    const text = latestText(value)
    assertIncludes(text, '画面已稳定')
    assertIncludes(text, '用时')
    assert(!value.imageRef, 'screen_wait must never return an image')
    assert((readCounters().capture || 0) > before, 'polled at least once')
  })
  await check('e2e: screen_wait reports timeout while the screen keeps changing', async () => {
    writeScenario(baseScenario({ hashPerCall: true }))
    const value = await callTool('screen_wait', { timeoutMs: 600, stableMs: 200 })
    const text = latestText(value)
    assertIncludes(text, '超时（仍在变化）')
    assert(!value.imageRef, 'no image on timeout either')
  })
  await check('e2e: screen_capture window mode uses PrintWindow windowHandle', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_capture', { region: 'window', window: { handle: 222 }, binning: 'target' })
    const text = latestText(value)
    assertIncludes(text, 'PrintWindow')
    assertIncludes(text, 'hwnd=222')
    assert(value.imageRef, 'window capture returns an image: ' + text)
    await waitFor(() => readCounters().lastCaptureWindowHandle === 222, 1500)
    assertEqual(readCounters().lastCaptureWindowHandle, 222)
    const source = readCounters().lastCaptureSource
    assert(source && source.w === 1200 && source.h === 800, 'window rect is the capture source: ' + JSON.stringify(source))
  })
  await check('e2e: screen_capture window mode resolves by titleContains and rejects unknown/minimized', async () => {
    writeScenario(baseScenario({
      windows: [
        defaultForeground,
        { handle: 222, title: 'Mock Explorer', className: 'CabinetWClass', pid: 5353, process: 'C:\\Windows\\explorer.exe', rect: { x: 100, y: 100, w: 1200, h: 800 }, minimized: false, elevated: false, denied: false },
        { handle: 333, title: 'Mock Minimized', className: 'Notepad', pid: 6666, process: 'C:\\Windows\\notepad.exe', rect: { x: 0, y: 0, w: 400, h: 300 }, minimized: true, elevated: false, denied: false },
      ],
    }))
    const byTitle = await callTool('screen_capture', { region: 'window', window: { titleContains: 'explorer' } })
    assertIncludes(latestText(byTitle), 'hwnd=222')
    const missing = await callTool('screen_capture', { region: 'window', window: { titleContains: 'nope' } })
    assertIncludes(latestText(missing), '未找到匹配窗口')
    const minimized = await callTool('screen_capture', { region: 'window', window: { handle: 333 } })
    assertIncludes(latestText(minimized), '已最小化')
  })
  await check('e2e: mouse_batch executes N actions under ONE approval', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('mode ask')
    approvalCalls = 0
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'move', x: 500, y: 500 },
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 620, y: 560 },
        { type: 'scroll', delta: 1, x: 500, y: 500 },
        { type: 'wait', ms: 5 },
      ],
      verify: 'text',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, '批量完成: 5/5')
    assertIncludes(text, '本次只消耗 1 次授权')
    assertIncludes(text, '1. move (500,500) ')
    assertIncludes(text, '2. click (500,500) left')
    assertIncludes(text, '4. scroll +1')
    assertEqual(readCounters().click, 2)
    assertEqual(readCounters().scroll, 1)
    assertEqual(approvalCalls, 1, 'exactly one approval prompt')
    assertEqual(lastApproval.toolName, 'mouse_batch')
    await runCommand('mode auto')
  })
  await check('e2e: mouse_batch partially executes then fails fast with the index', async () => {
    // v0.4 checks the window IMMEDIATELY before each mutation (no up-front batch
    // pre-check). Probe #1 is the best-effort approval context probe; #2 lets
    // action 1 run; #3 (probeDenyAfter=2) turns denied for action 2.
    writeScenario(baseScenario({ probeDenyAfter: 5 }))
    await runCommand('arm 60')
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 620, y: 560 },
        { type: 'click', x: 700, y: 600 },
      ],
      verify: 'none',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, '批量部分执行')
    assertIncludes(text, '第 2 个动作（click）被拒绝（目标窗口不安全）')
    assertIncludes(text, '已执行 1/3')
    assertIncludes(text, '不会自动重试')
    assertEqual(readCounters().click, 1, 'first action ran, second was denied')
    assertEqual(readCounters().probe, 6, 'three plan-baseline probes + one approval-context probe + one probe per attempted mutation')
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const batchDenied = rows.filter((r) => r.tool === 'mouse_batch' && r.decision === 'denied')
    assert(batchDenied.length >= 1, 'batch denial audited')
    const lastRow = batchDenied[batchDenied.length - 1]
    assertIncludes(lastRow.reason, 'action-2')
    assertIncludes(String(lastRow.outcome), 'executed=1/3')
    assertIncludes(String(lastRow.outcome), 'failedIndex=2')
  })
  await check('e2e: mouse_batch argument validation', async () => {
    const empty = await callTool('mouse_batch', { actions: [] })
    assertIncludes(latestText(empty), 'actions 需要非空数组')
    const tooMany = await callTool('mouse_batch', { actions: Array.from({ length: 21 }, (_, i) => ({ type: 'wait', ms: 1, x: i })) })
    assertIncludes(latestText(tooMany), '一次最多 20 个动作')
    const badType = await callTool('mouse_batch', { actions: [{ type: 'fly' }] })
    assertIncludes(latestText(badType), 'type 无效')
    const badCoord = await callTool('mouse_batch', { actions: [{ type: 'click' }] })
    assertIncludes(latestText(badCoord), '点击目标需要')
    const dragBad = await callTool('mouse_batch', { actions: [{ type: 'drag', x: 10, y: 20 }] })
    assertIncludes(latestText(dragBad), '拖拽终点需要')
  })
  await check('e2e: mouse_batch paused before any execution when paused', async () => {
    // pause the plugin via the human takeover path, then confirm batch refuses
    writeScenario(baseScenario())
    await runCommand('arm 60')
    emitEvents([{ event: 'escape' }])
    const paused = await waitFor(async () => latestText(await callTool('screen_info')).includes('已暂停'), 3000)
    assert(paused, 'escape event should pause the plugin')
    writeScenario(baseScenario())
    emitEvents([])
    const value = await callTool('mouse_batch', { actions: [{ type: 'click', x: 500, y: 500 }], verify: 'none' })
    assertIncludes(latestText(value), '已暂停')
    assertEqual(readCounters().click || 0, 0)
    await runCommand('arm 60')
  })

  // -------------------------------------------------------------------------
  // 9b. v0.5: mouse_batch resumeFrom + expectAfter
  // -------------------------------------------------------------------------
  await check('e2e: mouse_batch resumeFrom skips earlier actions and says so', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const actions = [500, 520, 540, 560, 580].map((x) => ({ type: 'click', x, y: 500 }))
    // 0.9 D-04/B7: resuming requires a dryRun of the same plan first.
    const dry = await callTool('mouse_batch', { actions, verify: 'none', dryRun: true })
    assertIncludes(latestText(dry), 'dryRun')
    const value = await callTool('mouse_batch', { actions, resumeFrom: 3, verify: 'none' })
    const text = latestText(value)
    assertIncludes(text, '从第 3 个动作继续（前 2 个未重放，请确认已完成）')
    assertIncludes(text, '3. click (540,500)')
    assertIncludes(text, '5. click (580,500)')
    assert(!text.includes('1. click (500,500)'), 'skipped action must not be replayed')
    assert(!text.includes('2. click (520,500)'), 'skipped action must not be replayed')
    assertEqual((readCounters().click || 0) - before, 3, 'only the last 3 of 5 actions inject input')
    await new Promise((r) => setTimeout(r, 150))
  })
  await check('e2e: mouse_batch expectAfter success continues the batch', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const actions = [
      { type: 'click', x: 500, y: 500, expectAfter: { titleContains: 'Mock Notepad', timeoutMs: 300 } },
      { type: 'click', x: 520, y: 500, expectAfter: { process: 'notepad', timeoutMs: 300 } },
    ]
    const value = await callTool('mouse_batch', { actions, verify: 'none' })
    const text = latestText(value)
    assertIncludes(text, '批量完成: 2/2')
    assertIncludes(text, '1. expectAfter ✓ titleContains=Mock Notepad')
    assertIncludes(text, '2. expectAfter ✓ process=notepad')
    assertEqual((readCounters().click || 0) - before, 2)
    await new Promise((r) => setTimeout(r, 150))
  })
  await check('e2e: mouse_batch expectAfter mismatch stops partial and audits it', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const actions = [
      { type: 'click', x: 500, y: 500, expectAfter: { titleContains: 'Excel - Never Matching', timeoutMs: 200 } },
      { type: 'click', x: 520, y: 500 },
      { type: 'click', x: 540, y: 500 },
    ]
    const value = await callTool('mouse_batch', { actions, verify: 'none' })
    const text = latestText(value)
    assertIncludes(text, '第 1 个动作后状态不符')
    assertIncludes(text, '已执行 1/3，后续未执行')
    assertEqual((readCounters().click || 0) - before, 1, 'mismatch stops the remaining actions')
    const auditRows = readFileSync(join(homeDir, 'click-matrix', 'audit.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const batchRows = auditRows.filter((r) => r.tool === 'mouse_batch')
    // 0.9: intent/effect rows interleave; find the row carrying the outcome.
    const failedRows = batchRows.filter((r) => r && typeof r.outcome === 'string' && r.outcome.includes('expectAfterFailed'))
    assert(failedRows.length >= 1, 'audited expectAfterFailed:1: ' + JSON.stringify(batchRows.slice(-3)))
    await new Promise((r) => setTimeout(r, 150))
  })
  await check('e2e: mouse_batch resumeFrom validates range', async () => {
    writeScenario(baseScenario())
    const before = readCounters().click || 0
    const tooBig = await callTool('mouse_batch', { actions: [{ type: 'click', x: 500, y: 500 }], resumeFrom: 2 })
    assertIncludes(latestText(tooBig), '超出动作数量 1')
    const zero = await callTool('mouse_batch', { actions: [{ type: 'wait', ms: 10 }], resumeFrom: 0 })
    assertIncludes(latestText(zero), '必须是 ≥1 的整数')
    assertEqual((readCounters().click || 0) - before, 0)
  })

  // -------------------------------------------------------------------------
  // 9c. v0.5: screen_read text-first with image fallback
  // -------------------------------------------------------------------------
  const uiaElements4 = [
    { type: 'Button', name: '保存', automationId: 'saveBtn', rect: { x: 100, y: 200, width: 80, height: 30 }, center: { x: 140, y: 215 }, patterns: ['Invoke'], isEnabled: true },
    { type: 'Button', name: '取消', automationId: 'cancelBtn', rect: { x: 200, y: 200, width: 80, height: 30 }, center: { x: 240, y: 215 }, patterns: ['Invoke'], isEnabled: true },
    { type: 'Edit', name: '文件名', automationId: 'fileName', rect: { x: 100, y: 250, width: 300, height: 24 }, center: { x: 250, y: 262 }, patterns: ['Value'], isEnabled: true },
    { type: 'Text', name: '提示', automationId: 'hint', rect: { x: 100, y: 300, width: 120, height: 20 }, center: { x: 160, y: 310 }, patterns: [], isEnabled: true },
  ]
  const uiaPayloadFor = (elements) => ({ ok: true, dpiAware: true, window: { title: 'Mock Notepad', pid: 4242, process: 'C:\\Windows\\notepad.exe' }, scanned: elements.length + 1, truncated: false, elements })
  await check('e2e: screen_read returns text-first elements without capturing', async () => {
    writeScenario(baseScenario())
    writeJsonFile(uiaPath, uiaPayloadFor(uiaElements4))
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const before = readCounters().capture || 0
      const value = await callTool('screen_read', { maxElements: 3, minElements: 3 })
      const text = latestText(value)
      assertIncludes(text, 'screen_read: 窗口 "Mock Notepad"')
      assertIncludes(text, 'text-first')
      assertIncludes(text, '"保存"')
      assertIncludes(text, '…还有 1 个元素未列出')
      assert(!value.imageRef, 'text-first must not return an image')
      assertEqual((readCounters().capture || 0) - before, 0, 'no capture on the text-first path')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
    }
  })
  await check('e2e: screen_read query filters and minElements decides', async () => {
    writeScenario(baseScenario())
    writeJsonFile(uiaPath, uiaPayloadFor(uiaElements4))
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const filtered = await callTool('screen_read', { query: '取消', minElements: 1, maxElements: 5 })
      const text = latestText(filtered)
      assertIncludes(text, '元素 1（query="取消"）')
      assertIncludes(text, '"取消"')
      assert(!text.includes('"保存"'), 'query must drop non-matching elements')
      assert(!filtered.imageRef)
      // v0.8.5: with a query the matched elements ARE the answer. They are
      // returned even below minElements, and no screenshot is taken unless the
      // caller explicitly asks for one (old behavior silently downgraded to an
      // image and dropped the matches).
      const sparse = await callTool('screen_read', { query: '取消' })
      const sparseText = latestText(sparse)
      assertIncludes(sparseText, '命中 1 个，低于 minElements=3')
      assertIncludes(sparseText, '"取消"')
      assert(!sparse.imageRef, 'query below minElements must not fall back to a capture by default')
      // Explicit opt-in still falls back. A unique region keeps the image
      // dedupe (same captureHash as an earlier test) from hiding the fallback.
      const forced = await callTool('screen_read', { query: '取消', allowImageFallback: true, region: { x: 12, y: 14, w: 320, h: 240 } })
      assert(forced.imageRef, 'allowImageFallback:true must still fall back to a capture: ' + latestText(forced).slice(0, 300))
      const noHit = await callTool('screen_read', { query: '不存在的元素' })
      assertIncludes(latestText(noHit), '未命中任何元素')
      assert(!noHit.imageRef, 'zero-hit query must not fall back to a capture')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
    }
  })
  await check('e2e: screen_read falls back to a small capture when UIA is empty', async () => {
    writeScenario(baseScenario({ foreground: { ...defaultForeground, handle: 121, rect: { x: 40, y: 30, w: 860, h: 660 } } }))
    writeJsonFile(uiaPath, uiaPayloadFor([]))
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const before = readCounters().capture || 0
      const value = await callTool('screen_read', {})
      const text = latestText(value)
      assertIncludes(text, 'UIA 元素不足（0 < minElements=3）')
      assertIncludes(text, '已退回截图')
      assertIncludes(text, '映射: 屏幕x =')
      assert(value.imageRef, 'empty UIA should return the fallback image: ' + text)
      assertEqual((readCounters().capture || 0) - before, 1, 'exactly one fallback capture')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
    }
  })

  // -------------------------------------------------------------------------
  // 10. v0.2: status route (loopback + same-origin, read-only)
  // -------------------------------------------------------------------------
  await check('e2e: status route returns JSON for loopback and rejects non-loopback/cross-origin', async () => {
    await drain()
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('mode auto')
    await runCommand('arm 60')
    const ok = await callStatusRoute({ host: '127.0.0.1:54004' })
    assertEqual(ok.status, 200)
    const body = parseJsonBody(ok)
    assertEqual(body.ok, true)
    // PLUGIN_VERSION mirrors package.json version (the Lead bumps package.json).
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    assertEqual(body.version, pkgVersion)
    assertEqual(body.commandsRegistered, true)
    assertEqual(body.mode, 'auto')
    assertEqual(body.armed, true, 'armed reflects the open arm window')
    assert(body.clicksLeft >= 1 && body.remainingMs > 0, 'arm numbers present: ' + JSON.stringify(body))
    assertEqual(body.lattice, 'standard')
    assertEqual(body.binning, 'target')
    assertEqual(body.keyboardEnabled, true)
    assertEqual(body.clipboardEnabled, true)
    assertEqual(body.helperReady, true)
    assert(Number.isFinite(body.helperPid) && body.helperPid >= 0, 'helperPid numeric: ' + JSON.stringify(body.helperPid))
    assert(typeof body.helperVersion === 'string', 'helperVersion string: ' + JSON.stringify(body.helperVersion))
    assert(Number.isFinite(body.helperRestarts) && body.helperRestarts >= 0, 'helperRestarts numeric: ' + JSON.stringify(body.helperRestarts))
    assertEqual(body.paused, null)
    assertEqual(body.allowSelfWindow, true)
    assertEqual(body.selfAllow.enabled, true)
    assertEqual(body.selfAllow.active, false)
    assert(typeof body.overlayVisible === 'boolean', 'overlayVisible is boolean')
    // security: non-loopback Host / cross-origin / missing Host / wrong method
    assertEqual((await callStatusRoute({ host: 'evil.example:54004' })).status, 403)
    assertEqual((await callStatusRoute({})).status, 403)
    assertEqual((await callStatusRoute({ host: '127.0.0.1:54004', origin: 'http://evil.example' })).status, 403)
    assertEqual((await callStatusRoute({ host: '127.0.0.1:54004', referer: 'http://evil.example/page' })).status, 403)
    assertEqual((await callStatusRoute({ host: '127.0.0.1:54004', origin: 'http://127.0.0.1:54004' })).status, 200)
    assertEqual((await callStatusRoute({ host: 'localhost:54004' })).status, 200)
    assertEqual((await callStatusRoute({ host: '[::1]:54004' })).status, 200)
    assertEqual((await callStatusRoute({ host: '127.0.0.1:54004' }, 'POST')).status, 405)
    // read-only: the route never mutates arm/helper state
    await drain()
    const pickCounters = (c) => {
      const keys = ['click', 'drag', 'scroll', 'focus', 'capture', 'probe', 'typeText', 'pressKeys', 'clipboardGet', 'clipboardSet', 'abort', 'escWatchCalls']
      const out = {}
      for (const k of keys) out[k] = c[k] || 0
      return out
    }
    const countersBefore = pickCounters(readCounters())
    const again = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(again.armed, true)
    await drain()
    assertEqual(pickCounters(readCounters()), countersBefore, 'status route must not call the helper')
  })

  // -------------------------------------------------------------------------
  // 10b. v0.2.x: config route — GET config, POST only safe keys, persist
  // -------------------------------------------------------------------------
  await check('e2e: config route GET/POST — safety keys rejected, safe key clamped+persisted', async () => {
    const getRes = await new Promise((resolve) => {
      const def = getConfigRoute()
      let statusCode = 200
      const res = { setHeader() {}, writeHead(c) { statusCode = c }, end(body) { resolve({ status: statusCode, body: String(body || '') }) } }
      def.handler({ method: 'GET', headers: { host: '127.0.0.1:54004' } }, res)
    })
    assertEqual(getRes.status, 200)
    const cfgBody = parseJsonBody(getRes)
    assertEqual(cfgBody.ok, true)
    assert(cfgBody.config && typeof cfgBody.config.maxImagesPerTurn === 'number', 'config payload present')
    assert(Array.isArray(cfgBody.builtinDeny) && cfgBody.builtinDeny.length >= 1, 'builtinDeny exposed (read-only)')
    assert(Array.isArray(cfgBody.builtinOwnProcesses) && cfgBody.builtinOwnProcesses.length >= 1, 'builtinOwnProcesses exposed')

    const rejectMode = parseJsonBody(await callConfigRoute({ key: 'mode', value: 'auto' }, { host: '127.0.0.1:54004' }))
    assertEqual(rejectMode.ok, false, 'mode must not be editable from the settings route')
    const rejectHotkey = parseJsonBody(await callConfigRoute({ key: 'requireAbortHotkey', value: false }, { host: '127.0.0.1:54004' }))
    assertEqual(rejectHotkey.ok, false, 'requireAbortHotkey must not be editable')

    const okBody = parseJsonBody(await callConfigRoute({ key: 'maxImagesPerTurn', value: 9999 }, { host: '127.0.0.1:54004' }))
    assertEqual(okBody.ok, true)
    assertEqual(okBody.value, 60, 'value clamped to the schema max')

    const cross = await callConfigRoute({ key: 'maxImagesPerTurn', value: 12 }, { host: '127.0.0.1:54004', origin: 'http://evil.example' })
    assertEqual(cross.status, 403, 'cross-origin POST rejected')

    const overridesFile = join(homeDir, 'click-matrix', 'config-overrides.json')
    const saved = JSON.parse(readFileSync(overridesFile, 'utf8'))
    assertEqual(saved.maxImagesPerTurn, 60, 'override persisted to disk')
    // Clean up: later tests build their own runtime from an explicit config, and a
    // leftover override would silently win over it (apply() merges overrides last).
    try { rmSync(overridesFile, { force: true }) } catch { /* ignore */ }
  })

  // -------------------------------------------------------------------------
  // 11. v0.2: escape / human-input / externalAborted -> pause + pill + esc watch
  // -------------------------------------------------------------------------
  await check('e2e: arm shows the pill and enables the esc watchdog', async () => {
    // Force a clean disarmed state first: an already-open arm window does not
    // re-fire the arm callback, so re-arming right after another test's arm would
    // otherwise depend on cross-test ordering.
    await runCommand('stop')
    await new Promise((r) => setTimeout(r, 100))
    writeScenario(baseScenario())
    await runCommand('arm 60')
    const ok = await waitFor(
      () => readCounters().escWatchEnabled === true && readCounters().lastOverlayMode === 'pill',
      3000,
    )
    assert(ok, 'expected set_esc_watch(true) + pill overlay: ' + JSON.stringify(readCounters()))
    assertIncludes(String(readCounters().lastOverlayLabel), 'Esc/STOP 停止')
    assertIncludes(String(readCounters().lastOverlayLabel), '点阵已授权')
  })
  await check('e2e: escape event pauses, disarms, hides pill and audits', async () => {
    const overlayHidesBefore = readCounters().overlayHide || 0
    emitEvents([{ event: 'escape' }])
    const paused = await waitFor(async () => latestText(await callTool('screen_info')).includes('已暂停'), 3000)
    assert(paused, 'escape should pause the plugin')
    const text = latestText(await callTool('screen_info'))
    assertIncludes(text, 'Esc 被按下')
    assertIncludes(text, '/click-matrix arm')
    const click = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(click), '已暂停')
    assertEqual(readCounters().click || 0, 0)
    const state = await waitFor(() => readCounters().escWatchEnabled === false, 2000)
    assert(state, 'esc watchdog must be disabled on disarm: ' + JSON.stringify(readCounters()))
    assert((readCounters().overlayHide || 0) > overlayHidesBefore, 'pill hidden on pause')
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    assert(rows.some((r) => r.tool === 'escape' && r.decision === 'paused'), 'escape pause audited')
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assert(status.paused && /Esc/.test(status.paused.reason), 'status route exposes paused: ' + JSON.stringify(status.paused))
  })
  await check('e2e: human arm resumes after a pause (pause clears)', async () => {
    const arm = await runCommand('arm 60')
    assertIncludes(arm.text, '已授权鼠标操作')
    const text = latestText(await callTool('screen_info'))
    assert(!text.includes('已暂停'), 'pause must clear on arm: ' + text.slice(0, 400))
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(status.paused, null)
    const click = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(click), '已点击')
  })
  await check('e2e: human-input suspends injection (auto-resume state)', async () => {
    writeScenario(baseScenario())
    await runCommand('arm 60')
    emitEvents([{ event: 'human-input', data: { vk: 65 } }])
    const suspended = await waitFor(async () => {
      const s = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
      return s.suspended && /human-input|真人键盘/.test(s.suspended.reason || '')
    }, 3000)
    assert(suspended, 'human-input should suspend: ' + JSON.stringify(parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))))
    const denied = await callTool('mouse_click', { x: 500, y: 500 })
    const deniedText = latestText(denied)
    // v0.4: mutating tools pass waitForHumanIdleMs (here 300 ms via e2eConfig),
    // so the gate waits a little instead of denying instantly and then times out.
    assertIncludes(deniedText, '等待人类空闲超时')
    assertIncludes(deniedText, '已等待人类空闲约')
    assertEqual(readCounters().click || 0, 0, 'no click while human is active')
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    assert(rows.some((r) => r.tool === 'human-input' && r.decision === 'suspended'), 'human-input suspension audited')
    await runCommand('arm 60')
    const after = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(after.suspended, null, 'human arm clears suspension')
  })
  await check('e2e: human-mouse suspends injection under keep-on latch', async () => {
    writeScenario(baseScenario())
    await runCommand('arm on')
    const latched = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(latched.latched, true)
    assertEqual(latched.remainingMs, -1)
    emitEvents([{ event: 'human-mouse', data: { x: 10, y: 10 } }])
    const suspended = await waitFor(async () => {
      const s = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
      return s.suspended && /human-mouse|真人鼠标/.test(s.suspended.reason || '')
    }, 3000)
    assert(suspended, 'human-mouse should suspend: ' + JSON.stringify(parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))))
    await runCommand('stop')
    const after = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(after.armed, false, 'stop clears latch')
    assertEqual(after.suspended, null, 'stop clears suspension')
  })
  await check('e2e: externalAborted result suspends and blocks further input', async () => {
    writeScenario(baseScenario({ externalAbort: true }))
    await runCommand('arm 60')
    const click = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(click)
    assertIncludes(text, 'externalAborted')
    assertIncludes(text, '已暂停注入')
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assert(status.suspended && /external/.test(status.suspended.tool || ''), 'external suspension exposed: ' + JSON.stringify(status.suspended))
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    assert(rows.some((r) => r.tool === 'external' && r.decision === 'suspended'), 'external abort suspension audited')
    // clear for the dispose test
    await runCommand('arm 60')
  })
  await check('e2e: global abort event (Ctrl+Alt+F11) hard-stops armed/latched/allowSelf', async () => {
    await runCommand('stop')
    await new Promise((r) => setTimeout(r, 120))
    writeScenario(baseScenario())
    await runCommand('arm on') // keep-on latch
    await runCommand('allow-self 0,0,600,400 30')
    const beforeAbort = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(beforeAbort.latched, true, 'precondition: latched arm')
    assertEqual(beforeAbort.selfAllow.active, true, 'precondition: allowSelf active')
    emitEvents([{ event: 'abort', data: { source: 'hotkey' } }])
    const paused = await waitFor(async () => {
      const s = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
      return s.paused && /Ctrl\+Alt\+F11|全局急停/.test(s.paused.reason || '')
    }, 3000)
    assert(paused, 'abort event should pause the plugin: ' + JSON.stringify(parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))))
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(status.armed, false, 'abort clears the arm/latch')
    assertEqual(status.latched, false, 'abort clears the keep-on latch')
    assertEqual(status.selfAllow.active, false, 'abort closes allowSelf')
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const abortRows = rows.filter((r) => r.tool === 'abort-hotkey')
    assert(abortRows.some((r) => r.decision === 'stop' && r.reason === 'Ctrl+Alt+F11'), 'abort-hotkey stop audited: ' + JSON.stringify(abortRows.slice(-2)))
    const denied = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(denied), '已暂停')
    assertEqual(readCounters().click || 0, 0, 'no click while hard-stopped')
    // Human re-arm is the only way back.
    await runCommand('arm 60')
    const recovered = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(recovered.paused, null, 'human arm clears the abort pause')
    const click = await callTool('mouse_click', { x: 500, y: 500 })
    assertIncludes(latestText(click), '已点击')
    await runCommand('stop')
    writeScenario(baseScenario())
  })
  await check('e2e: abort event without authorization does not crash or corrupt state', async () => {
    await runCommand('stop')
    await new Promise((r) => setTimeout(r, 120))
    writeScenario(baseScenario())
    const before = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(before.armed, false, 'precondition: not armed')
    emitEvents([{ event: 'abort', data: { source: 'hotkey' } }])
    const paused = await waitFor(async () => {
      const s = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
      return s.paused && /Ctrl\+Alt\+F11|全局急停/.test(s.paused.reason || '')
    }, 3000)
    assert(paused, 'unarmed abort still enters the hard-stop pause')
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(status.helperReady, true, 'helper stays ready after an unarmed abort event')
    assertEqual(status.armed, false)
    assertEqual(typeof status.mode, 'string', 'mode state remains readable: ' + JSON.stringify(status.mode))
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    assert(rows.some((r) => r.tool === 'abort-hotkey' && r.decision === 'stop' && r.reason === 'Ctrl+Alt+F11'), 'unarmed abort also audited')
    // Recover and reset for later tests.
    await runCommand('arm 60')
    const recovered = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(recovered.paused, null)
    await runCommand('stop')
    writeScenario(baseScenario())
  })

  // -------------------------------------------------------------------------
  // 12. v0.4: human-idle internal wait
  // -------------------------------------------------------------------------
  const indexModule = await import('../index.js')

  await check('v0.4: gate wait adapter succeeds once human activity clears', async () => {
    // 2026-11-08 时序加固（human-idle 组）：不再用「150ms 墙钟」清挂起 —— 机器有负载时
    // 这个定时器可能抢在适配器第一次轮询之前（甚至赶在 __gateCheck 进入等待之前）就清了，
    // 结果是 waitedMs 很小 / 根本没等待。现在改成**事件驱动**：适配器每轮询一次
    // isSuspended 就算一次，轮询到第 3 次才清；waitedMs 因此必然 >= 2 个轮询周期
    // （HUMAN_WAIT_POLL_MS=120 → >=240ms）。断言（>=100ms、必须成功、必须带等待说明）
    // 一条没放宽。
    let suspended = true
    let idlePolls = 0
    const gate = {
      isSuspended: () => {
        if (suspended && ++idlePolls >= 3) suspended = false
        return suspended
      },
      check: async () => (suspended
        ? { allowed: false, code: 'suspended', message: '人类正在操作' }
        : { allowed: true, code: 'allowed', clicksLeft: 2 }),
    }
    const state = {
      config: configLib.normalizeConfig({ humanWaitMaxMs: 600 }),
      gate,
      // 0.9 D-08: the gate path asks the helper for the hard-stop hotkey.
      helper: { ensureStarted: async () => {}, state: () => ({ readyInfo: { abortHotkey: { registered: true, combo: 'Ctrl+Alt+F11' } } }) },
      // 0.9 D-10: the gate also refuses when the audit trail is not writable.
      audit: { writable: () => true, append: () => true },
    }
    const decision = await indexModule.__gateCheck(state, { toolName: 'mouse_click' })
    assert(decision.allowed === true, 'should succeed after suspension cleared: ' + JSON.stringify(decision))
    assert(decision.waitedMs >= 100, 'waitedMs recorded: ' + decision.waitedMs)
    assertIncludes(indexModule.__waitedSuffix(decision), '已等待人类空闲约')
  })
  await check('v0.4: gate wait adapter times out and reports the wait budget', async () => {
    const gate = {
      isSuspended: () => true,
      check: async () => ({ allowed: false, code: 'suspended', message: '人类正在操作' }),
    }
    const state = {
      config: configLib.normalizeConfig({ humanWaitMaxMs: 220 }),
      gate,
      helper: { ensureStarted: async () => {}, state: () => ({ readyInfo: { abortHotkey: { registered: true, combo: 'Ctrl+Alt+F11' } } }) },
      // 0.9 D-10: the gate also refuses when the audit trail is not writable.
      audit: { writable: () => true, append: () => true },
    }
    const startedAt = Date.now()
    const decision = await indexModule.__gateCheck(state, { toolName: 'mouse_click' })
    const elapsed = Date.now() - startedAt
    assert(decision.allowed === false, 'should stay denied while the human is active')
    assert(decision.waitedMs >= 100, 'waitedMs recorded on timeout: ' + decision.waitedMs)
    assert(elapsed >= 150 && elapsed < 2000, 'bounded wait: ' + elapsed)
    assertIncludes(indexModule.__waitedDenySuffix(decision), '仍未恢复')
  })
  await check('v0.4: mutating tool waits for human idle and says so', async () => {
    await drain()
    const scenario3Path = join(tmpRoot, 'scenario3.json')
    const counters3Path = join(tmpRoot, 'counters3.json')
    const events3Path = join(tmpRoot, 'events3.json')
    writeJsonFile(scenario3Path, {
      countersPath: counters3Path,
      eventsPath: events3Path,
      virtual: { x: 0, y: 0, w: 2880, h: 1800 },
      monitors: [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }],
      foreground: defaultForeground,
      windows: [defaultForeground],
    })
    const prevScenario = process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO
    process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = scenario3Path
    let waitState = null
    try {
      const cfg3 = configLib.normalizeConfig({ mode: 'auto', humanWaitMaxMs: 3000, humanIdleResumeMs: 60000, minIntervalMs: 0, helperTimeoutMs: 8000, mergeReadSide: false })
      waitState = indexModule.__createRuntime(fakeCtx, cfg3)
      const defs3 = indexModule.__buildToolDefinitions(waitState)
      const clickDef = defs3.find((d) => d.name === 'mouse_click')
      const infoDef = defs3.find((d) => d.name === 'screen_info')
      const exec3 = { agent: { session: { id: 'agent-wait' } }, callId: 'call-wait' }
      // Warm the helper up first, so the suspension below is not cleared by the
      // spawn latency before gate.check runs.
      await infoDef.execute({}, exec3)
      waitState.gate.humanLatch('smoke')
      waitState.gate.setSuspended({ reason: 'smoke-human-activity', idleResumeMs: 60000 })
      // 2026-11-08 时序加固（human-idle 组）：原来 `setTimeout(clearSuspended, 200)` 从
      // **测试侧**起算，机器慢时鼠标工具还没走到授权检查，挂起就被清了 → 工具根本没等待，
      // 断言「已等待人类空闲约」直接红。现在把「人类恢复空闲」绑到**工具真的进入
      // gate.check 且要求内部等待**这个事件上再等 300ms（gate 内部轮询周期 250ms，
      // 保证至少完整等过一个周期），断言未放宽。
      const waitGate = waitState.gate
      const realGateCheck = waitGate.check.bind(waitGate)
      let idleClearingArmed = false
      waitGate.check = async (input) => {
        if (!idleClearingArmed && input && Number(input.waitForHumanIdleMs) > 0) {
          idleClearingArmed = true
          setTimeout(() => {
            try { waitGate.clearSuspended() } catch { /* ignore */ }
          }, 300)
        }
        return realGateCheck(input)
      }
      const value = await clickDef.execute({ x: 500, y: 500 }, exec3)
      const text = latestText(value)
      assertIncludes(text, '已点击 (500,500)')
      assertIncludes(text, '已等待人类空闲约')
      const c3 = readJsonFile(counters3Path, {})
      assertEqual(c3.click, 1, 'click executed after the wait')
    } finally {
      if (waitState) await waitState.helper.stop()
      process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = prevScenario
    }
  })

  // -------------------------------------------------------------------------
  // 13. v0.4: dryRun previews (no injection, no authorization consumption)
  // -------------------------------------------------------------------------
  await check('v0.4: mouse_click dryRun reports without injecting or consuming arm', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const before = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    const value = await callTool('mouse_click', { x: 500, y: 500, dryRun: true })
    const text = latestText(value)
    assertIncludes(text, 'dryRun')
    assertIncludes(text, '不消耗授权')
    assertIncludes(text, '目标窗口: "Mock Notepad"')
    assertIncludes(text, '窗口安全: 通过')
    assertIncludes(text, 'allowSelf')
    assertEqual(readCounters().click || 0, 0, 'dryRun must not click')
    const after = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(after.clicksLeft, before.clicksLeft, 'dryRun must not consume arm clicks')
    assertEqual(after.armed, true, 'arm stays open')
    const rel = await callTool('mouse_click', { window: { handle: 222 }, fx: 0.5, fy: 0.5, dryRun: true })
    assertIncludes(latestText(rel), 'dryRun')
    assertIncludes(latestText(rel), '(700,500)')
    assertIncludes(latestText(rel), '窗口相对坐标')
    assertEqual(readCounters().click || 0, 0, 'relative dryRun must not click')
  })
  await check('v0.4: mouse_drag dryRun reports both windows without dragging', async () => {
    writeScenario(baseScenario())
    const value = await callTool('mouse_drag', { from: { x: 400, y: 400 }, to: { x: 700, y: 500 }, dryRun: true })
    const text = latestText(value)
    assertIncludes(text, 'dryRun')
    assertIncludes(text, '起点窗口')
    assertIncludes(text, '终点窗口')
    assertEqual(readCounters().drag || 0, 0)
  })
  await check('v0.4: mouse_batch dryRun lists per-action windows without injecting', async () => {
    writeScenario(baseScenario())
    const value = await callTool('mouse_batch', {
      dryRun: true,
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'scroll', delta: 2, x: 600, y: 500 },
        { type: 'wait', ms: 5 },
      ],
    })
    const text = latestText(value)
    assertIncludes(text, 'dryRun')
    assertIncludes(text, '1. click (500,500)')
    assertIncludes(text, '2. scroll +2 @(600,500)')
    assertIncludes(text, '3. wait 5ms')
    assertIncludes(text, '预演结论')
    assertIncludes(text, '不消耗授权')
    assertEqual(readCounters().click || 0, 0)
    assertEqual(readCounters().scroll || 0, 0)
  })

  // -------------------------------------------------------------------------
  // 14. v0.4: window-relative coordinates
  // -------------------------------------------------------------------------
  await check('v0.4: mouse_click window-relative coordinates resolve to rect + fx/fy', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { window: { handle: 222 }, fx: 0.5, fy: 0.5 })
    const text = latestText(value)
    assertIncludes(text, '已点击 (700,500)')
    assertIncludes(text, '窗口相对坐标')
    const c = readCounters()
    assertEqual(c.lastClick, { x: 700, y: 500, button: 'left', count: 1 })
  })
  await check('v0.4: mouse_move window-relative coordinates + clear errors', async () => {
    writeScenario(baseScenario())
    const move = await callTool('mouse_move', { window: { titleContains: 'explorer' }, fx: 0.25, fy: 0.75 })
    assertIncludes(latestText(move), '光标已移动到 (400,700)')
    const c = readCounters()
    assertEqual(c.lastMove, { x: 400, y: 700, durationMs: 160 })
    const missing = await callTool('mouse_move', { window: { titleContains: 'nope' }, fx: 0.1, fy: 0.1 })
    assertIncludes(latestText(missing), '未找到匹配窗口')
    const noFrac = await callTool('mouse_move', { window: { handle: 222 } })
    assertIncludes(latestText(noFrac), '需要同时提供 fx、fy')
    writeScenario(baseScenario({
      windows: [
        defaultForeground,
        { handle: 333, title: 'Mock Minimized', className: 'Notepad', pid: 6666, process: 'C:\\Windows\\notepad.exe', rect: { x: 0, y: 0, w: 400, h: 300 }, minimized: true, elevated: false, denied: false },
      ],
    }))
    const minimized = await callTool('mouse_move', { window: { handle: 333 }, fx: 0.5, fy: 0.5 })
    assertIncludes(latestText(minimized), '已最小化')
  })
  await check('v0.4: mouse_drag rejects window-relative coordinates (documented)', async () => {
    const value = await callTool('mouse_drag', { window: { handle: 222 }, fx: 0.5, fy: 0.5, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })
    assertIncludes(latestText(value), '暂不支持窗口相对坐标')
  })
  await check('v0.4: screen_capture window sub-region uses fx/fy/fw/fh fractions', async () => {
    writeScenario(baseScenario())
    const value = await callTool('screen_capture', { window: { handle: 222 }, fx: 0.25, fy: 0.25, fw: 0.5, fh: 0.5 })
    const text = latestText(value)
    assertIncludes(text, '窗口子区域')
    assertIncludes(text, 'fx=0.25 fy=0.25 fw=0.5 fh=0.5')
    assert(value.imageRef, 'sub-region capture returns an image')
    await waitFor(() => readJsonFile(countersPath, {}).lastCaptureSource, 1000)
    const source = readCounters().lastCaptureSource
    assertEqual(source, { x: 400, y: 300, w: 600, h: 400 })
    const bad = await callTool('screen_capture', { fx: 0.5, fy: 0.5 })
    assertIncludes(latestText(bad), '需要同时提供 window')
    const badFrac = await callTool('screen_capture', { window: { handle: 222 }, fx: 1.5, fy: 0 })
    assertIncludes(latestText(badFrac), 'fx/fy 必须在 [0,1]')
  })
  await check('v0.4: mouse_batch move/click support window-relative coordinates', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'move', window: { handle: 222 }, fx: 0.5, fy: 0.5 },
        { type: 'click', window: { handle: 222 }, fx: 0.5, fy: 0.5 },
      ],
      verify: 'none',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, '1. move (700,500) [窗口相对]')
    assertIncludes(text, '2. click (700,500)')
    const c = readCounters()
    assertEqual(c.lastClick, { x: 700, y: 500, button: 'left', count: 1 })
    const dragBad = await callTool('mouse_batch', { actions: [{ type: 'drag', window: { handle: 222 }, fx: 0.5, fy: 0.5, to: { x: 1, y: 1 } }] })
    assertIncludes(latestText(dragBad), '暂不支持窗口相对坐标')
  })

  await check('v0.4: mouse_batch runs the first two of three, denies the third, no retry', async () => {
    // context probe #1, then one probe per action: #2 ok, #3 ok, #4 denied
    writeScenario(baseScenario({ probeDenyAfter: 6 }))
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 520, y: 520 },
        { type: 'click', x: 620, y: 560 },
      ],
      verify: 'none',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, '批量部分执行')
    assertIncludes(text, '第 3 个动作（click）被拒绝（目标窗口不安全）')
    assertIncludes(text, '已执行 2/3')
    assertIncludes(text, '不会自动重试')
    assertEqual(readCounters().click, 2, 'first two actions ran before the denial')
    await runCommand('stop')
    writeScenario(baseScenario())
  })
  await check('v0.4: mouse_batch aborts the rest when human activity starts mid-batch', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const pending = callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'wait', ms: 500 },
        { type: 'click', x: 620, y: 560 },
      ],
      verify: 'none',
      intervalMs: 0,
    })
    await emitHumanActivityAfterFirstClick(before)
    const value = await pending
    const text = latestText(value)
    assertIncludes(text, '批量已暂停（人类操作中）')
    assertIncludes(text, '已执行 1/3')
    assertIncludes(text, '不会自动重试')
    assertIncludes(text, '已执行的动作不会回滚')
    assertEqual(readCounters().click, 1, 'only the first click ran')
    await runCommand('arm 60') // human arm clears the suspension
    writeScenario(baseScenario())
  })
  await check('v0.6: mouse_batch resumeOnHumanIdle waits for idle then continues', async () => {
    await drain()
    // 2026-11-08 时序加固（human-idle 组）：这条原来靠两个墙钟——「100ms 后发人类事件」
    // 和「900ms 后 /click-matrix arm 清挂起」。机器有负载时：① 事件可能抢在第一下点击之前，
    // 等待就发生在「动作 1 前」而不是「动作 2 前」；② arm 可能在批量真正进入等待之前/之后
    // 才到，要么没等待、要么等到超时。现在改成完全事件驱动：
    //   - 用独立 runtime（能拿到 state.gate），等第一下点击真的进计数器后再 setSuspended；
    //   - 把 state.gate.snapshot 包一层：批量的等待循环每轮询一次 snapshot 就记一次，
    //     第 2 次仍看到 suspended 时清掉 —— 等价于「人类恰好在这时恢复空闲」，
    //     waitedMs 必然 >= 一个 120ms 轮询周期。断言（动作 2 前等待 / 继续 / 3/3）未放宽。
    const scenarioResume = join(tmpRoot, 'scenario-resume.json')
    const countersResume = join(tmpRoot, 'counters-resume.json')
    const eventsResume = join(tmpRoot, 'events-resume.json')
    writeJsonFile(scenarioResume, {
      countersPath: countersResume,
      eventsPath: eventsResume,
      virtual: { x: 0, y: 0, w: 2880, h: 1800 },
      monitors: [{ id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 }],
      foreground: defaultForeground,
      windows: [defaultForeground],
    })
    const prevScenario = process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO
    process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = scenarioResume
    let resumeState = null
    try {
      const cfgResume = configLib.normalizeConfig({ mode: 'auto', humanWaitMaxMs: 5000, humanIdleResumeMs: 60000, minIntervalMs: 0, helperTimeoutMs: 8000, mergeReadSide: false })
      resumeState = indexModule.__createRuntime(fakeCtx, cfgResume)
      const defsResume = indexModule.__buildToolDefinitions(resumeState)
      const batchDef = defsResume.find((d) => d.name === 'mouse_batch')
      const infoDef = defsResume.find((d) => d.name === 'screen_info')
      assert(batchDef && infoDef, 'resume runtime is missing mouse_batch/screen_info')
      const execResume = { agent: { session: { id: 'agent-resume' } }, callId: 'call-resume' }
      await infoDef.execute({}, execResume) // 预热 helper，让后面的点击不被 spawn 延迟影响
      resumeState.gate.humanArm(60)
      // 事件驱动的人为恢复空闲：等待循环每轮询一次 snapshot 记一次，第 2 次仍 suspended 就清。
      let suspendPolls = 0
      const waitGate = resumeState.gate
      const realSnapshot = waitGate.snapshot.bind(waitGate)
      waitGate.snapshot = () => {
        const snap = realSnapshot()
        if (snap && snap.suspended && ++suspendPolls >= 2) waitGate.clearSuspended()
        return snap
      }
      const before = readJsonFile(countersResume, {}).click || 0
      const pending = batchDef.execute({
        actions: [
          { type: 'click', x: 500, y: 500 },
          { type: 'click', x: 520, y: 500 },
          { type: 'click', x: 540, y: 500 },
        ],
        verify: 'none',
        intervalMs: 600,
        resumeOnHumanIdle: true,
      }, execResume)
      const firstClickRan = await waitFor(() => (readJsonFile(countersResume, {}).click || 0) > before, 5000, 10)
      assert(firstClickRan, '第一下点击没有在超时前进计数器，时序前置条件不成立')
      waitGate.setSuspended({ reason: 'human-mouse', idleResumeMs: 60000 })
      const value = await pending
      const text = latestText(value)
      assertIncludes(text, '动作 2 前等待人类空闲约')
      assertIncludes(text, 'resumeOnHumanIdle：已等待人类空闲后继续')
      assertIncludes(text, '批量完成: 3/3')
      const countersResumeNow = readJsonFile(countersResume, {})
      assertEqual((countersResumeNow.click || 0) - before, 3, 'all three actions run after the wait')
    } finally {
      if (resumeState) await resumeState.helper.stop()
      process.env.DSH_CLICK_MATRIX_MOCK_SCENARIO = prevScenario
    }
  })
  await check('v0.6: mouse_batch without resumeOnHumanIdle still stops on human activity', async () => {
    await drain()
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const pending = callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 520, y: 500 },
        { type: 'click', x: 540, y: 500 },
      ],
      verify: 'none',
      intervalMs: 600,
    })
    await emitHumanActivityAfterFirstClick(before)
    const value = await pending
    const text = latestText(value)
    assertIncludes(text, '批量已暂停（人类操作中）')
    assertIncludes(text, '已执行 1/3')
    assert(!text.includes('resumeOnHumanIdle：'), 'default mode must not wait')
    assertEqual((readCounters().click || 0) - before, 1, 'default mode stops at the suspension')
    await runCommand('arm 60') // clears the suspension
    writeScenario(baseScenario())
  })
  await check('v0.6: mouse_batch resumeOnHumanIdle times out and reports partial', async () => {
    await drain()
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const pending = callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 520, y: 500 },
      ],
      verify: 'none',
      intervalMs: 500,
      resumeOnHumanIdle: true,
    })
    // 稳定性修复（2026-11-08）：原来固定 `setTimeout(..., 80)` 发「人类在动」，
    // 机器有负载时 80ms 会抢在**第一下点击之前**发生 → 批量一步都没执行、报「本次鼠标操作未执行」，
    // 而本用例断言「已执行 1/2」→ 实测 3 次里红 2 次（**未改动的树上同样复现**，属用例时序过严，不是产品缺陷）。
    // 现在改成「等第一下点击真的进计数器之后」再发人类事件（4s 兜底），断言一条没放宽。
    const startedHumanWaitAt = Date.now()
    const humanTimer = setInterval(() => {
      if ((readCounters().click || 0) > before || Date.now() - startedHumanWaitAt > 4000) {
        clearInterval(humanTimer)
        emitEvents([{ event: 'human-mouse', data: { x: 5, y: 5 } }])
      }
    }, 10)
    const value = await pending
    const text = latestText(value)
    assertIncludes(text, '等待人类空闲超时')
    assertIncludes(text, '已执行 1/2')
    assert(!text.includes('批量完成'), 'timeout must not complete the batch')
    assertEqual((readCounters().click || 0) - before, 1, 'no action after the timeout')
    await runCommand('arm 60') // clears the suspension
    writeScenario(baseScenario())
  })
  await check('v0.6: mouse_batch does not retry an action interrupted by human activity', async () => {
    await drain()
    writeScenario(baseScenario({ externalAbort: true }))
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'click', x: 500, y: 500 },
        { type: 'click', x: 520, y: 500 },
      ],
      verify: 'none',
      intervalMs: 0,
      resumeOnHumanIdle: true,
    })
    const text = latestText(value)
    assertIncludes(text, '执行中被中断')
    assertIncludes(text, '不会自动重试')
    assertIncludes(text, 'resumeFrom:1')
    const __dbg = 'before=' + before + ' after=' + readCounters().click + ' text=' + JSON.stringify(text.slice(0, 200))
    assertEqual((readCounters().click || 0) - before, 1, 'interrupted action is attempted exactly once, never retried | ' + __dbg)
    await runCommand('arm 60') // clears the suspension
    writeScenario(baseScenario())
  })

  // -------------------------------------------------------------------------
  // 15. v0.4: window_focus / wait_window
  // -------------------------------------------------------------------------
  await check('v0.4: window_focus focuses via helper (no arm needed)', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    const before = readCounters().focus || 0
    const value = await callTool('window_focus', { window: { handle: 222 } })
    const text = latestText(value)
    assertIncludes(text, '已聚焦')
    assertIncludes(text, 'Mock Explorer')
    assert((readCounters().focus || 0) === before + 1, 'helper focus called')
    assertEqual(readCounters().lastFocusHandle, 222)
    const missing = await callTool('window_focus', {})
    assertIncludes(latestText(missing), '需要 window:{handle|titleContains|pid}')
    const notFound = await callTool('window_focus', { window: { titleContains: 'nope' } })
    assertIncludes(latestText(notFound), '未找到匹配窗口')
  })
  await check('v0.4: window_focus reports a clear error when the helper lacks focus', async () => {
    writeScenario(baseScenario({ focusUnsupported: true }))
    const value = await callTool('window_focus', { window: { handle: 222 } })
    const text = latestText(value)
    assertIncludes(text, '暂不可用')
    assertIncludes(text, 'helper 不支持 focus')
    writeScenario(baseScenario())
  })
  await check('v0.4: wait_window returns an existing window and times out cleanly', async () => {
    writeScenario(baseScenario())
    const found = await callTool('wait_window', { titleContains: 'explorer', timeoutMs: 1000 })
    const foundText = latestText(found)
    assertIncludes(foundText, '窗口已出现')
    assertIncludes(foundText, 'Mock Explorer')
    assertIncludes(foundText, '采样')
    const start = Date.now()
    const timeout = await callTool('wait_window', { titleContains: 'never-appears', timeoutMs: 300, intervalMs: 50 })
    assertIncludes(latestText(timeout), '等待窗口超时')
    assert(Date.now() - start >= 250, 'waited for the timeout budget')
    const invalid = await callTool('wait_window', {})
    assertIncludes(latestText(invalid), '至少一个条件')
    assert(!found.imageRef && !timeout.imageRef, 'wait_window is text only')
  })
  await check('v0.4: wait_window polls until the window appears', async () => {
    writeScenario(baseScenario({ windows: [defaultForeground] }))
    const pending = callTool('wait_window', { titleContains: 'Explorer', timeoutMs: 3000, intervalMs: 100 })
    setTimeout(() => {
      writeScenario(baseScenario())
    }, 250)
    const value = await pending
    const text = latestText(value)
    assertIncludes(text, '窗口已出现')
    assertIncludes(text, 'Mock Explorer')
    const samples = Number((text.match(/采样 (\d+) 次/) || [])[1] || 0)
    assert(samples >= 2, 'polled more than once: ' + samples)
  })

  // -------------------------------------------------------------------------
  // 16. v0.4: keep-on latch wording (no "剩 -1 次")
  // -------------------------------------------------------------------------
  await check('v0.4: latched arm shows "常开授权（不计数）" instead of -1', async () => {
    writeScenario(baseScenario())
    await runCommand('arm on')
    const t = await callTool('type_text', { text: 'hello' })
    assertIncludes(latestText(t), '常开授权（不计数）')
    const k = await callTool('press_keys', { keys: ['enter'] })
    assertIncludes(latestText(k), '常开授权（不计数）')
    const b = await callTool('mouse_batch', { actions: [{ type: 'wait', ms: 1 }], verify: 'none' })
    assertIncludes(latestText(b), '常开授权（不计数）')
    for (const text of [latestText(t), latestText(k), latestText(b)]) {
      assert(!/剩\s*-1|剩余\s*-1/.test(text), 'no -1 clicks text: ' + text)
    }
    await runCommand('stop')
  })

  // -------------------------------------------------------------------------
  // 17. v0.4: scoped allowSelf (own-window exception, mouse_click only)
  // -------------------------------------------------------------------------
  const selfWindow = {
    handle: 111,
    title: 'DeepSeek Harness',
    className: 'Chrome_WidgetWin_1',
    pid: 4242,
    process: 'C:\\Program Files\\DeepSeek Harness.exe',
    rect: { x: 0, y: 0, w: 600, h: 400 },
    minimized: false,
    elevated: false,
    denied: true,
  }
  const selfScenario = (overrides = {}) => baseScenario({ foreground: selfWindow, windows: [selfWindow], ...overrides })
  await check('v0.4: allowSelf command requires config and enables a scoped rect', async () => {
    writeScenario(selfScenario())
    await runCommand('stop')
    await runCommand('arm on')
    const denied = await callTool('mouse_click', { x: 100, y: 100 })
    const deniedText = latestText(denied)
    assertIncludes(deniedText, '已拒绝点击：目标窗口不安全')
    assertIncludes(deniedText, 'allow-self')
    const armed = await runCommand('allow-self 0,0,600,400 30')
    assertIncludes(armed.text, '已开启 allowSelf')
    assertIncludes(armed.text, '自身窗口')
    assertIncludes(armed.text, '仍需 arm/审批')
    const status = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(status.selfAllow.active, true)
    assertEqual(status.selfAllow.rect, { x: 0, y: 0, w: 600, h: 400 })
    const statusCmd = await runCommand('status')
    assertIncludes(statusCmd.text, 'allowSelf: 已授权 rect=(0,0 600x400)')
    // dryRun reports whether the point is inside the allowSelf rect, no injection
    const dryInside = await callTool('mouse_click', { x: 100, y: 100, dryRun: true })
    assertIncludes(latestText(dryInside), '点在范围内')
    assertIncludes(latestText(dryInside), 'allowSelf 放行自身窗口')
    const dryOutside = await callTool('mouse_click', { x: 700, y: 500, dryRun: true })
    assertIncludes(latestText(dryOutside), '**不在**')
    assertEqual(readCounters().click || 0, 0, 'allowSelf dryRuns never clicked')
  })
  await check('v0.4: allowSelf lets mouse_click through inside the rect only', async () => {
    writeScenario(selfScenario())
    await runCommand('stop')
    await runCommand('arm on')
    await runCommand('allow-self 0,0,600,400 60')
    const value = await callTool('mouse_click', { x: 100, y: 100 })
    const text = latestText(value)
    assertIncludes(text, '已点击 (100,100)')
    assertIncludes(text, 'allowSelf')
    assertIncludes(text, 'allowed-self')
    assertEqual(readCounters().click, 1)
    const auditFile = join(homeDir, 'click-matrix', 'audit.jsonl')
    const rows = readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const selfRows = rows.filter((r) => r.tool === 'mouse_click' && r.decision === 'allowed-self')
    assert(selfRows.length >= 1, 'allowed-self audited')
    assertIncludes(String(selfRows[selfRows.length - 1].note), 'allowSelf rect=(0,0 600x400)')
    // outside the rect: own window is denied again
    const outside = await callTool('mouse_click', { x: 700, y: 500 })
    assertIncludes(latestText(outside), '已拒绝点击：目标窗口不安全')
    assertEqual(readCounters().click, 1, 'outside click never ran')
  })
  await check('v0.4: allowSelf never unlocks other tools (type_text/drag still deny own window)', async () => {
    writeScenario(selfScenario())
    await runCommand('stop')
    await runCommand('arm on')
    await runCommand('allow-self 0,0,600,400 60')
    const typed = await callTool('type_text', { text: 'hello' })
    assertIncludes(latestText(typed), '已拒绝输入：前台窗口不安全')
    const drag = await callTool('mouse_drag', { from: { x: 100, y: 100 }, to: { x: 200, y: 200 } })
    assertIncludes(latestText(drag), '已拒绝拖拽：目标窗口不安全')
    // batch clicks also stay denied (allowSelf is mouse_click only)
    const batch = await callTool('mouse_batch', { actions: [{ type: 'click', x: 100, y: 100 }], verify: 'none' })
    assertIncludes(latestText(batch), '未执行任何动作')
    assertIncludes(latestText(batch), '被拒绝')
    await runCommand('allow-self off')
    const afterOff = await callTool('mouse_click', { x: 100, y: 100 })
    assertIncludes(latestText(afterOff), '已拒绝点击：目标窗口不安全')
  })
  await check('v0.4: allowSelf arg validation + seconds clamp', async () => {
    writeScenario(selfScenario())
    await runCommand('allow-self off')
    const usage = await runCommand('allow-self')
    assertIncludes(usage.text, '用法: /click-matrix allow-self')
    const badRect = await runCommand('allow-self 0,0,0,100 10')
    assertIncludes(badRect.text, 'allowSelf 未开启')
    const clamped = await runCommand('allow-self 0,0,100,100 999999')
    assertIncludes(clamped.text, '已开启 allowSelf')
    assertIncludes(clamped.text, '120 秒')
    const stopped = await runCommand('stop')
    assertIncludes(stopped.text, 'allowSelf 已关闭')
    writeScenario(baseScenario())
  })
  await check('v0.4: allowSelf disabled in config refuses the command', async () => {
    const services2 = {
      webServer: { routes: new Map(), register(d) { this.routes.set(d.path, d); return () => this.routes.delete(d.path) } },
      commands: { handlers: new Map(), register(d) { this.handlers.set(d.name, d); return () => this.handlers.delete(d.name) } },
      skills: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    }
    const ctx2 = {
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      get: (name) => services2[name],
      effect(cb) { this.__cleanup = cb(); return this.__cleanup },
      tools: { defs: new Map(), register(d) { this.defs.set(d.name, d); return () => this.defs.delete(d.name) } },
      commands: services2.commands,
    }
    indexModule.apply(ctx2, { allowSelfWindow: false })
    try {
      const handler = services2.commands.handlers.get('click-matrix')
      assert(handler, 'command registered in second ctx')
      const res = await handler.handler({ agent: null, rawInput: 'allow-self 0,0,100,100 30', signal: null })
      assertIncludes(res.text, 'allowSelf 未启用')
      assertIncludes(res.text, 'allowSelfWindow: true')
    } finally {
      if (typeof ctx2.__cleanup === 'function') ctx2.__cleanup()
    }
    writeScenario(baseScenario())
  })

  // -------------------------------------------------------------------------
  // 12a. v0.8.5 regression tests (2026-10-31 field report, FIXES doc §1-§7)
  // -------------------------------------------------------------------------
  await check('v0.8.5: mouse_click refuses while a physical mouse button is stuck', async () => {
    writeScenario(baseScenario({ physicalButtonsDown: { left: false, right: true, middle: false } }))
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '疑似鼠标键卡住')
    assertIncludes(text, 'right')
    assertIncludes(text, 'mouse_abort')
    assertEqual((readCounters().click || 0) - before, 0, 'no click may be injected while a button is stuck')
    assert(!text.includes('验证: expect 匹配'), 'a swallowed click must never be reported as verified')
    const stuckAudit = lastAuditEntry('mouse_click')
    assertEqual(stuckAudit && stuckAudit.decision, 'denied')
    assertEqual(stuckAudit && stuckAudit.reason, 'buttons-stuck')
    assertEqual(stuckAudit && stuckAudit.outcome, 'not-executed')
    // The refusal happens BEFORE the human gate, so the authorization survives.
    const armedNow = parseJsonBody(await callStatusRoute({ host: '127.0.0.1:54004' }))
    assertEqual(armedNow.armed, true, 'refusing a stuck-button click must not consume the arm')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_click also refuses on helper-tracked stuck buttons (physical clear)', async () => {
    // A button the helper still believes it holds (e.g. an aborted drag) is just
    // as fatal as a physical stuck button, so both sources are unioned.
    writeScenario(baseScenario({
      physicalButtonsDown: { left: false, right: false, middle: false },
      buttonsDown: { left: false, right: true, middle: false },
    }))
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const value = await callTool('mouse_click', { x: 500, y: 500 })
    const text = latestText(value)
    assertIncludes(text, '疑似鼠标键卡住')
    assertIncludes(text, 'helper 自跟踪')
    assertEqual((readCounters().click || 0) - before, 0, 'tracked stuck button must also block the click')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_click reports clicked-no-foreground instead of faking success', async () => {
    writeScenario(baseScenario({ foregroundNull: true }))
    await runCommand('stop')
    await runCommand('arm 60')
    const before = readCounters().click || 0
    const value = await callTool('mouse_click', { x: 500, y: 500, expect: { titleContains: 'Mock Notepad' } })
    const text = latestText(value)
    assertEqual((readCounters().click || 0) - before, 1, 'the click is still attempted')
    assertIncludes(text, '点击可能未生效')
    assertIncludes(text, '点击后前台: (无窗口)')
    assert(!text.includes('验证: expect 匹配 ✓'), 'no foreground window means the click cannot be verified')
    const fgAudit = lastAuditEntry('mouse_click')
    assertEqual(fgAudit && fgAudit.outcome, 'clicked-no-foreground', 'outcome must record the swallowed click: ' + JSON.stringify(fgAudit))
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_click verify:"none" still warns when the click left no foreground', async () => {
    // verify:none must not turn into "silence about an obvious failure".
    writeScenario(baseScenario({ foregroundNull: true }))
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_click', { x: 500, y: 500, verify: 'none' })
    const text = latestText(value)
    assertIncludes(text, '点击后系统没有前台窗口')
    const audit = lastAuditEntry('mouse_click')
    assertEqual(audit && audit.outcome, 'clicked-no-foreground')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_batch flags clicks that left no foreground window', async () => {
    writeScenario(baseScenario({ foregroundNull: true }))
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_batch', {
      actions: [{ type: 'click', x: 500, y: 500 }],
      verify: 'none',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, '点击后无前台窗口')
    assertIncludes(text, '很可能被系统忽略')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: window_focus failure is explicit, with reasons and alternatives', async () => {
    writeScenario(baseScenario({ focusDenied: true }))
    await runCommand('stop')
    const value = await callTool('window_focus', { window: { handle: 222 } })
    const text = latestText(value)
    assertIncludes(text, '聚焦失败（前台锁）')
    assertIncludes(text, 'foreground-lock')
    assertIncludes(text, '标题栏')
    assert(!text.includes('已请求聚焦（helper 未确认）'), 'vague wording must be gone')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: screen_read with a query still falls back when UIA itself fails', async () => {
    // "No screenshot when a query is given" must not turn into "no answer at
    // all" when UIA is unavailable — a failed observation always needs pixels.
    writeScenario(baseScenario())
    writeJsonFile(uiaPath, { ok: false, error: 'mock uia failure' })
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const value = await callTool('screen_read', { query: '取消', region: { x: 21, y: 22, w: 280, h: 200 } })
      const text = latestText(value)
      assertIncludes(text, 'UIA 观察失败')
      assert(value.imageRef, 'a failed UIA observation must still yield a screenshot: ' + text.slice(0, 200))
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
      writeScenario(baseScenario())
    }
  })
  await check('v0.8.5: screen_info always prints physical buttons + overlay hitTestable', async () => {
    writeScenario(baseScenario({
      physicalButtonsDown: { left: true, right: false, middle: false },
      overlayVisible: true,
      overlayHitTestable: true,
    }))
    const value = await callTool('screen_info')
    const text = latestText(value)
    assertIncludes(text, '物理按键: left')
    assertIncludes(text, '有按键未释放')
    assertIncludes(text, 'hitTestable=true')
    assertIncludes(text, 'pill 可命中')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_scroll warns when the content did not move', async () => {
    // The mock hashes a stable region identically unless hashPerCall is set.
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const still = await callTool('mouse_scroll', { delta: 3, x: 500, y: 500 })
    assertIncludes(latestText(still), '内容未变化')
    writeScenario(baseScenario({ hashPerCall: true }))
    await runCommand('stop')
    await runCommand('arm 60')
    const moved = await callTool('mouse_scroll', { delta: 3, x: 500, y: 500 })
    assert(!latestText(moved).includes('内容未变化'), 'changed pixels must not warn: ' + latestText(moved))
    const before = readCounters().capture || 0
    await runCommand('arm 60')
    const off = await callTool('mouse_scroll', { delta: 3, x: 500, y: 500, detectNoMove: false })
    assertEqual((readCounters().capture || 0) - before, 0, 'detectNoMove:false must not capture')
    assert(!latestText(off).includes('内容未变化'))
    writeScenario(baseScenario())
  })
  await check('v0.8.5: mouse_batch reports noMove for scrolls that changed nothing', async () => {
    writeScenario(baseScenario())
    await runCommand('stop')
    await runCommand('arm 60')
    const value = await callTool('mouse_batch', {
      actions: [
        { type: 'scroll', delta: 2, x: 500, y: 500 },
        { type: 'scroll', delta: 2, x: 500, y: 500 },
      ],
      verify: 'none',
      intervalMs: 0,
    })
    const text = latestText(value)
    assertIncludes(text, 'noMove:2')
    assertIncludes(text, '内容未变化')
    writeScenario(baseScenario())
  })
  await check('v0.8.5: screen_read marks multi-line text and gives the first-line centre', async () => {
    const wrapped = [
      { type: 'Text', name: '标题', rect: { x: 100, y: 100, width: 120, height: 20 }, center: { x: 160, y: 110 } },
      { type: 'Text', name: '正文', rect: { x: 100, y: 130, width: 400, height: 20 }, center: { x: 300, y: 140 } },
      { type: 'Text', name: '说明', rect: { x: 100, y: 160, width: 400, height: 20 }, center: { x: 300, y: 170 } },
      { type: 'Text', name: '面包屑被折行', rect: { x: 100, y: 200, width: 160, height: 128 }, center: { x: 180, y: 264 } },
    ]
    writeScenario(baseScenario())
    writeJsonFile(uiaPath, uiaPayloadFor(wrapped))
    process.env.DSH_CLICK_MATRIX_MOCK_UIA = uiaPath
    try {
      const value = await callTool('screen_read', { minElements: 1 })
      const text = latestText(value)
      assertIncludes(text, '多行≈')
      assertIncludes(text, '首行中心=')
      assert(!value.imageRef, 'text-first path must not capture')
    } finally {
      delete process.env.DSH_CLICK_MATRIX_MOCK_UIA
      writeScenario(baseScenario())
    }
  })

  // -------------------------------------------------------------------------
  // 12b. dispose: unregisters tools + status route + stops the helper process
  // -------------------------------------------------------------------------
  await check('e2e: dispose unregisters tools + status/config routes and stops helper process', async () => {
    assert(mockPid > 0, 'have helper pid')
    assert(fakeServices.webServer.routes.size === 2, 'status + config routes registered')
    if (typeof fakeCtx.__cleanup === 'function') fakeCtx.__cleanup()
    assertEqual(fakeCtx.tools.defs.size, 0)
    assertEqual(fakeServices.webServer.routes.size, 0, 'status + config routes removed on cleanup')
    let exited = false
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(mockPid, 0)
      } catch {
        exited = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    assert(exited, `helper pid ${mockPid} still alive after dispose`)
  })

  // -------------------------------------------------------------------------
  // 12c. P0: screen_capture auto-degrades binning when image tokens are short
  // -------------------------------------------------------------------------
  const makeBudgetCtx = (saved) => {
    const services = {
      attachments: {
        saved,
        async saveImage({ data, mediaType, name }) {
          const ref = { id: `att_b${saved.length + 1}`, mediaType, name, bytes: data ? data.length : 0 }
          saved.push(ref)
          return ref
        },
      },
    }
    const ctx = {
      logger: { warn: () => {}, error: () => {}, info: () => {} },
      get: (name) => services[name],
      effect(cb) {
        ctx.__cleanup = cb()
        return ctx.__cleanup
      },
      tools: {
        defs: new Map(),
        register(def) {
          ctx.tools.defs.set(def.name, def)
          return () => ctx.tools.defs.delete(def.name)
        },
      },
    }
    return ctx
  }
  const runBudgetCtx = async (toolConfig, fn) => {
    const saved = []
    const ctx = makeBudgetCtx(saved)
    indexModule.apply(ctx, { mode: 'ask', helperTimeoutMs: 8000, mergeReadSide: false, ...toolConfig })
    try {
      await fn(ctx, saved)
    } finally {
      if (typeof ctx.__cleanup === 'function') ctx.__cleanup()
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  const callBudgetTool = async (ctx, name, args) => {
    const def = ctx.tools.defs.get(name)
    if (!def) throw new Error(`tool ${name} missing in budget ctx`)
    return await def.execute(args, { agent: { session: { id: 'agent-budget' } }, callId: `budget-${++toolCallSeq}` })
  }

  await check('e2e: capture auto-degrades binning when image token budget is short', async () => {
    writeScenario(baseScenario())
    await runBudgetCtx({ maxImageTokensPerTurn: 100, maxImagesPerTurn: 5 }, async (ctx, saved) => {
      const before = readCounters().capture || 0
      const value = await callBudgetTool(ctx, 'screen_capture', { region: { x: 0, y: 0, w: 400, h: 300 } })
      const text = latestText(value)
      assertIncludes(text, '已自动降清晰度：binning 4，原 target')
      assertIncludes(text, '预算不足时自动降级，可传 region 获取更高清图')
      assertIncludes(text, '图像 100x75')
      assert(value.imageRef, 'degraded capture should still return an image: ' + text)
      assertEqual((readCounters().capture || 0) - before, 2, 'one first attempt + one degraded retry')
      assertEqual(saved.length, 1, 'exactly one image attached')
    })
  })
  await check('e2e: capture returns the budget error when no binning can fit', async () => {
    writeScenario(baseScenario())
    await runBudgetCtx({ maxImageTokensPerTurn: 1, maxImagesPerTurn: 5 }, async (ctx, saved) => {
      const before = readCounters().capture || 0
      const value = await callBudgetTool(ctx, 'screen_capture', { region: { x: 0, y: 0, w: 400, h: 300 } })
      const text = latestText(value)
      assertIncludes(text, 'token 预算不足')
      assertIncludes(text, '更小的 region')
      assert(!value.imageRef, 'no image when nothing fits')
      assertEqual((readCounters().capture || 0) - before, 1, 'no degraded retry capture when nothing fits')
      assertEqual(saved.length, 0)
    })
  })
  await check('e2e: capture does not retry when the image-count budget is exhausted', async () => {
    writeScenario(baseScenario())
    await runBudgetCtx({ maxImageTokensPerTurn: 2000, maxImagesPerTurn: 1 }, async (ctx, saved) => {
      const first = await callBudgetTool(ctx, 'screen_capture', { region: { x: 0, y: 0, w: 200, h: 150 } })
      assert(first.imageRef, 'first capture should use the single image slot: ' + latestText(first))
      const before = readCounters().capture || 0
      const second = await callBudgetTool(ctx, 'screen_capture', { region: { x: 300, y: 0, w: 200, h: 150 } })
      const text = latestText(second)
      assertIncludes(text, '图片预算已用完')
      assert(!second.imageRef, 'no image when the count budget is exhausted')
      assertEqual((readCounters().capture || 0) - before, 1, 'image-count exhaustion must not trigger a retry capture')
      assertEqual(saved.length, 1, 'only the first image attached')
    })
  })

  // -------------------------------------------------------------------------
  // 9. UIA script is present and PowerShell-parseable (read-only check)
  // -------------------------------------------------------------------------
  await check('uia.ps1 ships and parses under PowerShell', () => {
    const scriptPath = join(ROOT, 'lib', 'uia.ps1')
    assert(existsSync(scriptPath), 'uia.ps1 exists')
    const cmd = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}',[ref]$t,[ref]$e); if($e.Count -gt 0){ $e | ForEach-Object { Write-Output ('ERR ' + $_.Message) }; exit 1 } else { Write-Output 'PARSE_OK' }`,
    ]
    const result = spawnSync('powershell.exe', cmd, { encoding: 'utf8', timeout: 20000, windowsHide: true })
    if (result.error) {
      record('uia.ps1 ships and parses under PowerShell', true, 'powershell unavailable, skipped: ' + result.error.message)
      return
    }
    assertIncludes(String(result.stdout || ''), 'PARSE_OK')
    assertEqual(result.status, 0)
  })

  // -------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} checks passed, ${failed} failed`)
  if (failed > 0) {
    console.log('FAILED: ' + results.filter((r) => !r.ok).map((r) => r.name).join(' | '))
    process.exitCode = 1
  }
}

if (IS_MOCK) runMockHelper()
else await runMain()
