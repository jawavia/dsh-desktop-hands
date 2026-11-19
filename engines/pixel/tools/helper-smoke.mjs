// dsh-click-matrix native helper smoke test.
// Standalone: node tools/helper-smoke.mjs
//
// Boots the native helper via runtime/bootstrap.mjs, exercises every protocol
// command, and verifies real input against the click ground-truth fixture exe.
// Prints PASS/FAIL lines plus a summary; exits 0 only when everything passes.
// ASCII only.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { ensureHelper, HELPER_VERSION } from '../runtime/bootstrap.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURE_ENV = 'DSH_CLICK_MATRIX_FIXTURE'
const FIXTURE_PRIMARY = resolve(ROOT, 'test', 'bin', 'fixture.exe')
// Older feasibility checkout used when the repo has no acceptance fixture.
const FIXTURE_LEGACY = resolve(ROOT, '..', '_feasibility-click-matrix', 'bin', 'fixture.exe')
const BUILD_FIXTURE_SCRIPT = resolve(ROOT, 'tools', 'build-fixture.mjs')
const RUN_DIR = join(os.tmpdir(), 'dsh-click-matrix-smoke', String(process.pid))
const FIXTURE_COPY = join(RUN_DIR, 'fixture.exe')
const LOG_PATH = join(RUN_DIR, 'fixture.log')
const BOUNDS_PATH = join(RUN_DIR, 'fixture-bounds.json')
const STOP_PATH = join(RUN_DIR, 'fixture.stop')
const TYPEBOX_PATH = join(RUN_DIR, 'typebox.txt')
const INTERFERENCE_READY_PATH = join(RUN_DIR, 'cursor-interference.ready')
const OCCLUDER_TITLE = 'DSH-SMOKE-OCCLUDER'

const results = []

function record(name, ok, detail) {
  const entry = { name, ok: !!ok, detail }
  results.push(entry)
  let suffix = ''
  if (detail !== undefined && detail !== null) {
    let text
    try {
      text = JSON.stringify(detail)
    } catch {
      text = String(detail)
    }
    if (text.length > 500) text = text.slice(0, 500) + '...'
    suffix = '  ' + text
  }
  console.log((ok ? 'PASS ' : 'FAIL ') + name + suffix)
}

function distance(ax, ay, bx, by) {
  const dx = ax - bx
  const dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

function pngSize(path) {
  try {
    const buf = readFileSync(path)
    if (buf.length < 33) return null
    const signatureOk =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    if (!signatureOk) return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch {
    return null
  }
}

async function waitForFile(path, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return true
    await delay(100)
  }
  return false
}

async function waitForCondition(predicate, timeoutMs, stepMs = 120) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let value = false
    try {
      value = await predicate()
    } catch {
      value = false
    }
    if (value) return true
    await delay(stepMs)
  }
  return false
}

function runPowershell(script, timeoutMs = 30000) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolvePromise({ code: -1, out: String(error) })
      return
    }
    let out = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, out: out.trim() })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish(-2)
    }, timeoutMs)
    child.stdout.on('data', (data) => {
      out += data
    })
    child.stderr.on('data', (data) => {
      out += data
    })
    child.once('exit', (code) => finish(code))
    child.once('error', (error) => {
      out += String(error)
      finish(-1)
    })
  })
}

// Injects a physical key press through keybd_event so the helper's polling
// watchdog sees real key state (this is deliberately NOT the helper itself).
function keyInjectScript(vk) {
  return [
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class SmokeKey { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }\'',
    '[SmokeKey]::keybd_event(' + vk + ',0,0,[UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 160',
    '[SmokeKey]::keybd_event(' + vk + ',0,2,[UIntPtr]::Zero)',
    'Write-Output "smoke-key-injected"',
  ].join('; ')
}

// Injects a real mouse button through mouse_event, so the helper's physical
// state probe (GetAsyncKeyState) sees it while the helper's own tracked state
// stays false. Used by the v0.8.5.1 abort-release regression.
function mouseButtonScript(flag) {
  return [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class SmokeMouse { [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo); }\'',
    '[SmokeMouse]::mouse_event(' + flag + ',0,0,0,[UIntPtr]::Zero)',
    'Write-Output "smoke-mouse-button-injected"',
  ].join('; ')
}

// Injects the real Ctrl+Alt+F11 chord (the v6 independent abort hotkey) through
// keybd_event, so the OS itself delivers WM_HOTKEY to the helper. Deliberately
// NOT the helper's own input path.
function abortHotkeyScript() {
  return [
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class SmokeAbortHotkey { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo); }\'',
    '[SmokeAbortHotkey]::keybd_event(0x11,0,0,[UIntPtr]::Zero)', // Ctrl down
    'Start-Sleep -Milliseconds 40',
    '[SmokeAbortHotkey]::keybd_event(0x12,0,0,[UIntPtr]::Zero)', // Alt down
    'Start-Sleep -Milliseconds 40',
    '[SmokeAbortHotkey]::keybd_event(0x7A,0,0,[UIntPtr]::Zero)', // F11 down
    'Start-Sleep -Milliseconds 100',
    '[SmokeAbortHotkey]::keybd_event(0x7A,0,2,[UIntPtr]::Zero)', // F11 up
    'Start-Sleep -Milliseconds 40',
    '[SmokeAbortHotkey]::keybd_event(0x12,0,2,[UIntPtr]::Zero)', // Alt up
    'Start-Sleep -Milliseconds 40',
    '[SmokeAbortHotkey]::keybd_event(0x11,0,2,[UIntPtr]::Zero)', // Ctrl up
    'Write-Output "smoke-abort-hotkey-injected"',
  ].join('; ')
}

// Reads the real OS foreground window handle, independently of the helper's
// own status report, so the v4 focus command can be verified against Windows.
function foregroundWindowScript() {
  return [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class SmokeForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }\'',
    '[string]([SmokeForeground]::GetForegroundWindow().ToInt64())',
  ].join('; ')
}

// Keeps moving the real cursor for ~1.5 s so a running animation must notice
// the external interference. The loop is intentionally tight (no sleeps): the
// helper detects interference by comparing GetCursorPos against its own
// injected positions, and a slow 30 ms step made that check timing-flaky. Add-Type
// can take seconds on a loaded machine, so opts.readyPath gets a marker file
// once the cursor loop is about to start; opts.startDelayMs lets the caller
// start the animation first, so the interference interrupts the animation
// instead of pinning its start point.
function cursorInterferenceScript(x1, y1, x2, y2, opts = {}) {
  const parts = [
    'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class SmokeCursor { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }\'',
  ]
  if (opts.readyPath) {
    parts.push('Set-Content -Path "' + opts.readyPath + '" -Value "ready" -Encoding ASCII')
  }
  if (opts.startDelayMs) {
    parts.push('Start-Sleep -Milliseconds ' + opts.startDelayMs)
  }
  parts.push(
    '$sw=[System.Diagnostics.Stopwatch]::StartNew(); while($sw.ElapsedMilliseconds -lt 1500){ ' +
      '[SmokeCursor]::SetCursorPos(' + x1 + ',' + y1 + ') | Out-Null; ' +
      '[SmokeCursor]::SetCursorPos(' + x2 + ',' + y2 + ') | Out-Null }',
  )
  parts.push('Write-Output "smoke-cursor-done"')
  return parts.join('; ')
}

// Fullscreen topmost opaque WinForms window: occludes the fixture without
// changing the fixture's own content.
function occluderScript(title) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$f=New-Object System.Windows.Forms.Form',
    '$f.Text="' + title + '"',
    '$f.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::None',
    '$f.WindowState=[System.Windows.Forms.FormWindowState]::Maximized',
    '$f.BackColor=[System.Drawing.Color]::FromArgb(255,0,40,120)',
    '$f.TopMost=$true',
    '$f.ShowDialog() | Out-Null',
  ].join('; ')
}

function readClicks() {
  if (!existsSync(LOG_PATH)) return []
  return readFileSync(LOG_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|')
      return { ticks: Number(parts[0]), control: parts[1], x: Number(parts[2]), y: Number(parts[3]) }
    })
}

function lastClick(control) {
  const clicks = readClicks().filter((click) => click.control === control)
  return clicks.length > 0 ? clicks[clicks.length - 1] : null
}

// The fixture appends its click log from its UI thread; poll for the entry
// instead of relying on a fixed sleep so a slow first activation cannot make
// the ground-truth checks flaky.
async function waitForClick(control, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const click = lastClick(control)
    if (click) return click
    await delay(100)
  }
  return null
}

function spawnHelper(exePath) {
  const child = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const badLines = []
  const events = []
  let nextId = 1
  let buffer = ''
  let exited = false
  let exitCode = null
  let readySettled = false
  let readyResolve
  let readyReject
  const ready = new Promise((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise
    readyReject = rejectPromise
  })
  const exitPromise = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      exited = true
      exitCode = code
      resolvePromise({ code, signal })
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('helper exited before response: ' + entry.cmd))
      }
      pending.clear()
      if (!readySettled) {
        readySettled = true
        readyReject(new Error('helper exited before emitting ready'))
      }
    })
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        badLines.push(line)
        continue
      }
      if (message.event === 'ready') {
        events.push({ event: 'ready', data: message.data })
        if (!readySettled) {
          readySettled = true
          readyResolve(message.data)
        }
        continue
      }
      if (message.event) {
        events.push({ event: message.event, data: message.data })
        continue
      }
      const entry = pending.get(message.id)
      if (entry) {
        pending.delete(message.id)
        clearTimeout(entry.timer)
        entry.resolve(message)
      } else {
        badLines.push('response for unknown id: ' + line)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (data) => {
    const text = String(data).trim()
    if (text) console.log('helper stderr: ' + text.split(/\r?\n/).join('\nhelper stderr: '))
  })
  child.on('error', (error) => {
    if (!readySettled) {
      readySettled = true
      readyReject(error)
    }
  })
  function rpc(cmd, args = {}, timeoutMs = 20000) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (exited) {
        rejectPromise(new Error('helper already exited (cmd ' + cmd + ')'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rejectPromise(new Error('rpc timeout: ' + cmd))
        }
      }, timeoutMs)
      pending.set(id, {
        cmd,
        timer,
        resolve: (message) => {
          clearTimeout(timer)
          resolvePromise(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectPromise(error)
        },
      })
      try {
        child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        rejectPromise(error)
      }
    })
  }
  return {
    child,
    ready,
    events,
    badLines,
    rpc,
    exitPromise,
    get exited() {
      return exited
    },
    get exitCode() {
      return exitCode
    },
  }
}

// Resolve the fixture lazily (FB-01): never cache a fallback that does not
// exist at module load, because a clean machine has no prebuilt exe yet. When
// nothing is prebuilt, compile test/fixture.cs via tools/build-fixture.mjs and
// re-check. DSH_CLICK_MATRIX_FIXTURE still overrides everything.
async function resolveFixturePath() {
  const explicit = process.env[FIXTURE_ENV]
  if (explicit) return explicit
  if (existsSync(FIXTURE_PRIMARY)) return FIXTURE_PRIMARY
  // A clean checkout has no prebuilt exe: compile test/fixture.cs from the
  // canonical source BEFORE considering the older feasibility checkout, so a
  // stale legacy binary with a different layout can never win (FB-01).
  if (existsSync(BUILD_FIXTURE_SCRIPT)) {
    await import('./build-fixture.mjs')
    if (existsSync(FIXTURE_PRIMARY)) return FIXTURE_PRIMARY
  }
  if (existsSync(FIXTURE_LEGACY)) return FIXTURE_LEGACY
  return FIXTURE_PRIMARY
}

async function startFixture() {
  const fixturePath = await resolveFixturePath()
  if (!existsSync(fixturePath)) throw new Error('fixture exe not found: ' + fixturePath)
  // Run a copy inside the writable run dir: an exe launched from the workspace
  // drive may be blocked from writing to the user temp directory on some
  // security policies, while a copy in the run dir writes there fine.
  copyFileSync(fixturePath, FIXTURE_COPY)
  rmSync(LOG_PATH, { force: true })
  rmSync(BOUNDS_PATH, { force: true })
  rmSync(STOP_PATH, { force: true })
  const child = spawn(FIXTURE_COPY, [LOG_PATH, BOUNDS_PATH, STOP_PATH], { stdio: 'ignore' })
  let bounds = null
  const started = Date.now()
  while (Date.now() - started < 15000) {
    if (existsSync(BOUNDS_PATH)) {
      try {
        bounds = JSON.parse(readFileSync(BOUNDS_PATH, 'utf8'))
        break
      } catch {
        // still being written
      }
    }
    if (child.exitCode !== null) break
    await delay(100)
  }
  return { child, bounds }
}

async function stopFixture(fixture) {
  if (!fixture) return
  try {
    writeFileSync(STOP_PATH, '1')
  } catch {
    // ignore
  }
  const exited = await waitForExit(fixture.child, 5000)
  if (!exited) {
    try {
      fixture.child.kill()
    } catch {
      // ignore
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(timeoutMs).then(() => false),
  ])
  return exited
}

function clampRegion(x, y, w, h, vs) {
  let rx = Math.max(vs.x, Math.min(x, vs.x + vs.w - 1))
  let ry = Math.max(vs.y, Math.min(y, vs.y + vs.h - 1))
  let rw = Math.min(w, vs.x + vs.w - rx)
  let rh = Math.min(h, vs.y + vs.h - ry)
  if (rw <= 0) {
    rw = 1
    rx = vs.x + vs.w - 1
  }
  if (rh <= 0) {
    rh = 1
    ry = vs.y + vs.h - 1
  }
  return { x: rx, y: ry, w: rw, h: rh }
}

async function main() {
  let helper = null
  let fixture = null
  let occluder = null
  let startCursor = null
  let originalClipboard = null
  let vs = null
  let region = null

  try {
    rmSync(RUN_DIR, { recursive: true, force: true })
    mkdirSync(RUN_DIR, { recursive: true })

    // v0.8.5: helper protocol additions (physical buttons / overlay hit-test /
    // focus+click diagnostics) shipped as helper version 8; v9 adds
    // physical-state release for abort/exit; v10 adds the D-03 capture
    // arbitration fields (content/contentScale/targetDpi/mismatch).
    record('bootstrap HELPER_VERSION constant', HELPER_VERSION === 11, { HELPER_VERSION })
    let exe = null
    try {
      exe = await ensureHelper()
    } catch (error) {
      record('ensureHelper compiles helper.cs', false, { error: String(error && error.message ? error.message : error) })
      throw error
    }
    const exeSize = exe && existsSync(exe) ? statSync(exe).size : 0
    record(
      'ensureHelper compiles helper.cs',
      typeof exe === 'string' && exeSize > 0 && new RegExp(`helper-${HELPER_VERSION}-[0-9a-f]{64}\\.exe$`, 'i').test(exe),
      { exe, bytes: exeSize },
    )
    const exeAgain = await ensureHelper()
    record('ensureHelper reuses cached exe', exeAgain === exe)

    fixture = await startFixture()
    if (!fixture.bounds) throw new Error('fixture did not write its bounds file')
    const bounds = fixture.bounds
    record('fixture window ready', true, { title: bounds.title, window: bounds.window })
    await delay(1400) // let the fixture settle as topmost

    helper = spawnHelper(exe)
    const ready = await Promise.race([
      helper.ready,
      delay(20000).then(() => {
        throw new Error('helper ready timeout')
      }),
    ])
    const readyShapeOk =
      ready &&
      ready.protocol === 1 &&
      ready.helperVersion === HELPER_VERSION &&
      ready.dpiAware === true &&
      typeof ready.pid === 'number' &&
      ready.pid > 0 &&
      ready.virtual &&
      ready.virtual.w > 0 &&
      ready.virtual.h > 0 &&
      Array.isArray(ready.monitors) &&
      ready.monitors.length >= 1 &&
      ready.cursor &&
      typeof ready.cursor.x === 'number' &&
      ready.foreground &&
      typeof ready.foreground === 'object' &&
      ready.hotkey &&
      ready.hotkey.combo === 'Ctrl+Alt+F12' &&
      typeof ready.abortHotkeyRegistered === 'boolean' &&
      ready.abortHotkey &&
      ready.abortHotkey.combo === 'Ctrl+Alt+F11' &&
      ready.overlay &&
      typeof ready.overlay.available === 'boolean' &&
      ready.buttonsDown &&
      typeof ready.buttonsDown.left === 'boolean' &&
      typeof ready.elevated === 'boolean'
    record('helper ready event shape', readyShapeOk, ready)
    record('global hotkey registered', ready.hotkey.registered === true, ready.hotkey)
    startCursor = { x: ready.cursor.x, y: ready.cursor.y }

    const hello = await helper.rpc('hello')
    record(
      'hello/status protocol shape',
      hello.ok === true &&
        hello.data.protocol === 1 &&
        hello.data.helperVersion === HELPER_VERSION &&
        Array.isArray(hello.data.monitors) &&
        hello.data.monitors.length === ready.monitors.length &&
        hello.data.virtual &&
        hello.data.hotkey &&
        hello.data.overlay &&
        hello.data.buttonsDown,
      { pid: hello.data.pid, osVersion: hello.data.osVersion },
    )

    // v6: the abort hotkey is a separate registration from the arm hotkey, so
    // both must be visible in ready/status (doctor is checked further below).
    record(
      'abort hotkey Ctrl+Alt+F11 registered in ready/status',
      ready.abortHotkeyRegistered === true &&
        typeof hello.data.abortHotkeyRegistered === 'boolean' &&
        hello.data.abortHotkeyRegistered === true &&
        hello.data.abortHotkey &&
        hello.data.abortHotkey.combo === 'Ctrl+Alt+F11' &&
        hello.data.abortHotkey.registered === true,
      {
        ready: ready.abortHotkeyRegistered,
        status: hello.data.abortHotkeyRegistered,
        combo: hello.data.abortHotkey && hello.data.abortHotkey.combo,
      },
    )

    const capabilities = hello.data.capabilities || {}
    record(
      'hello/status report v2/v4/v6 capabilities',
      capabilities.keyboard === true &&
        capabilities.clipboard === true &&
        capabilities.printWindow === true &&
        capabilities.escWatch === true &&
        capabilities.humanInputWatch === true &&
        capabilities.humanMouseWatch === true &&
        capabilities.focus === true &&
        capabilities.abortHotkey === true,
      capabilities,
    )

    // Preserve the user's clipboard so the v2 round-trip check can restore it.
    try {
      const existingClipboard = await helper.rpc('clipboard_get', {}, 8000)
      // Only restore a clipboard that held text; never clear images/other formats.
      if (existingClipboard.ok === true && existingClipboard.data.hasText !== false) {
        originalClipboard = existingClipboard.data.text
      }
    } catch {
      originalClipboard = null
    }

    vs = { x: hello.data.virtual.x, y: hello.data.virtual.y, w: hello.data.virtual.w, h: hello.data.virtual.h }
    const monitors = hello.data.monitors
    const scaleOk = monitors.every(
      (monitor) =>
        typeof monitor.scale === 'number' &&
        isFinite(monitor.scale) &&
        monitor.scale > 0 &&
        monitor.scale <= 4 &&
        typeof monitor.w === 'number' &&
        monitor.w > 0 &&
        typeof monitor.h === 'number' &&
        monitor.h > 0,
    )
    const primaryCount = monitors.filter((monitor) => monitor.primary === true).length
    record('monitors expose per-monitor DPI scale', scaleOk && primaryCount === 1, monitors)
    const monitorsInsideVirtual = monitors.every(
      (monitor) =>
        monitor.x >= vs.x && monitor.y >= vs.y &&
        monitor.x + monitor.w <= vs.x + vs.w &&
        monitor.y + monitor.h <= vs.y + vs.h,
    )
    const virtualCoversMonitors = monitors.some(
      (monitor) => monitor.x === vs.x && monitor.y === vs.y && monitor.w === vs.w && monitor.h === vs.h,
    )
    record('virtual screen covers monitors in physical px', monitorsInsideVirtual && virtualCoversMonitors, {
      virtual: vs,
    })

    const wins = await helper.rpc('windows')
    const fixtureWindow = wins.ok ? wins.data.windows.find((window) => window.title === bounds.title) : null
    record(
      'windows enumerates visible top-level windows',
      wins.ok === true &&
        !!fixtureWindow &&
        fixtureWindow.pid > 0 &&
        typeof fixtureWindow.process === 'string' &&
        fixtureWindow.process.toLowerCase().endsWith('fixture.exe') &&
        fixtureWindow.rect &&
        fixtureWindow.rect.w > 0 &&
        fixtureWindow.denied === false,
      fixtureWindow,
    )

    const targetA = bounds.buttons.A
    const targetB = bounds.buttons.B
    const targetC = bounds.buttons.C
    const probe = await helper.rpc('probe_at', { x: targetA[0], y: targetA[1] })
    const probeWindow = probe.ok ? probe.data.window : null
    record(
      'probe_at resolves the fixture window under the point',
      probe.ok === true &&
        !!probeWindow &&
        probeWindow.title === bounds.title &&
        String(probeWindow.process || '').toLowerCase().endsWith('fixture.exe'),
      probeWindow,
    )

    // Park the cursor away from the fixture so the capture baseline is static.
    const park = { x: vs.x + vs.w - 40, y: vs.y + vs.h - 40 }
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(250)

    // -- capture: full screen with cross lattice -----------------------------
    const fullPath = join(RUN_DIR, 'capture-full-cross.png')
    const full = await helper.rpc('capture', {
      path: fullPath,
      scale: 0.5,
      lattice: { spacing: 640, style: 'cross' },
    })
    const fullPng = full.ok ? pngSize(fullPath) : null
    record(
      'capture full virtual screen with cross lattice',
      full.ok === true &&
        full.data.blackFrame === false &&
        /^[0-9a-f]{64}$/.test(full.data.captureHash) &&
        full.data.source.x === vs.x &&
        full.data.source.y === vs.y &&
        full.data.source.w === vs.w &&
        full.data.source.h === vs.h &&
        !!fullPng &&
        fullPng.width === Math.round(vs.w * 0.5) &&
        fullPng.height === Math.round(vs.h * 0.5) &&
        full.data.lattice.style === 'cross' &&
        Math.abs(full.data.lattice.spacingImage - 320) < 0.6,
      { width: full.data && full.data.width, height: full.data && full.data.height, lattice: full.data && full.data.lattice },
    )

    // -- capture: fixture region with hierarchical lattice -------------------
    // Inset the comparison region by a few pixels: the outermost rows of a
    // Win11 window rect blend the DWM frame with whatever is behind the window,
    // so a capture taken over an animated background can differ by a handful of
    // frame pixels even when the window content is identical.
    region = clampRegion(bounds.window[0] + 6, bounds.window[1] + 6, bounds.window[2] - 12, bounds.window[3] - 12, vs)
    const hierPath = join(RUN_DIR, 'capture-region-hierarchical.png')
    const hier = await helper.rpc('capture', {
      path: hierPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      lattice: { spacing: 160, style: 'hierarchical', majorEvery: 4 },
    })
    const hierPng = hier.ok ? pngSize(hierPath) : null
    record(
      'capture region with hierarchical lattice',
      hier.ok === true &&
        !!hierPng &&
        hierPng.width === region.w &&
        hierPng.height === region.h &&
        hier.data.lattice.style === 'hierarchical' &&
        hier.data.lattice.majorEvery === 4,
      { region, png: hierPng, lattice: hier.data && hier.data.lattice },
    )

    // -- capture: plain region, hash stability ------------------------------
    const basePath = join(RUN_DIR, 'capture-region-none-1.png')
    const basePath2 = join(RUN_DIR, 'capture-region-none-2.png')
    const base1 = await helper.rpc('capture', { path: basePath, x: region.x, y: region.y, w: region.w, h: region.h })
    const base2 = await helper.rpc('capture', { path: basePath2, x: region.x, y: region.y, w: region.w, h: region.h })
    record(
      'plain region capture has stable raw captureHash',
      base1.ok === true &&
        base2.ok === true &&
        /^[0-9a-f]{64}$/.test(base1.data.captureHash) &&
        base1.data.captureHash === base2.data.captureHash,
      { hash: base1.data && base1.data.captureHash },
    )

    // -- capture: lattice/marks drawn after the raw hash --------------------
    const markedPath = join(RUN_DIR, 'capture-region-cross-marks.png')
    const marked = await helper.rpc('capture', {
      path: markedPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      lattice: { spacing: 96, style: 'cross' },
      marks: [
        { x: targetA[0], y: targetA[1], kind: 'target' },
        { x: targetB[0], y: targetB[1], kind: 'cursor' },
      ],
    })
    const pngBytesDiffer =
      marked.ok === true && !readFileSync(basePath).equals(readFileSync(markedPath))
    record(
      'captureHash is raw pixels before lattice/marks are drawn',
      marked.ok === true && marked.data.captureHash === base1.data.captureHash && marked.data.marksDrawn === 2 && pngBytesDiffer,
      { marksDrawn: marked.data && marked.data.marksDrawn, pngBytesDiffer },
    )

    // -- explicit output size ----------------------------------------------
    const resizedPath = join(RUN_DIR, 'capture-region-resized.png')
    const resizedW = Math.max(1, Math.round(region.w / 2))
    const resizedH = Math.max(1, Math.round(region.h / 2))
    const resized = await helper.rpc('capture', {
      path: resizedPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      outW: resizedW,
      outH: resizedH,
    })
    const resizedPng = resized.ok ? pngSize(resizedPath) : null
    record(
      'capture honours explicit outW/outH',
      resized.ok === true &&
        resized.data.width === resizedW &&
        resized.data.height === resizedH &&
        !!resizedPng &&
        resizedPng.width === resizedW &&
        resizedPng.height === resizedH &&
        Math.abs(resized.data.scale - resizedW / region.w) < 0.02,
      { outW: resizedW, outH: resizedH, returned: resized.data && { width: resized.data.width, height: resized.data.height, scale: resized.data.scale } },
    )

    // -- includeCursor draws the pointer after the raw hash -----------------
    await helper.rpc('move', { x: targetA[0], y: targetA[1], durationMs: 0 })
    await delay(300)
    const cursorOffPath = join(RUN_DIR, 'capture-cursor-off.png')
    const cursorOnPath = join(RUN_DIR, 'capture-cursor-on.png')
    const cursorOff = await helper.rpc('capture', {
      path: cursorOffPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    })
    const cursorOn = await helper.rpc('capture', {
      path: cursorOnPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      includeCursor: true,
    })
    const cursorPngDiffers =
      cursorOff.ok === true && cursorOn.ok === true && !readFileSync(cursorOffPath).equals(readFileSync(cursorOnPath))
    record(
      'capture includeCursor draws the pointer without touching captureHash',
      cursorOff.ok === true &&
        cursorOn.ok === true &&
        cursorOn.data.captureHash === cursorOff.data.captureHash &&
        cursorPngDiffers,
      { pngDiffers: cursorPngDiffers },
    )

    // ==================================================================
    // v4: focus raises an existing window without injecting input
    // ==================================================================
    // The command must validate the handle, leave the window geometry alone
    // (no resize/move), and make the target the real foreground window.
    const focusStatusBefore = await helper.rpc('status')
    const previousForeground = focusStatusBefore.ok ? focusStatusBefore.data.foreground : null
    const focusTarget = await helper.rpc('focus', { handle: fixtureWindow.handle })
    await delay(250)
    const focusStatus = await helper.rpc('status')
    const focusForeground = focusStatus.ok ? focusStatus.data.foreground : null
    record(
      'focus foregrounds the fixture window and reports the switch',
      focusTarget.ok === true &&
        focusTarget.data.focused === true &&
        focusTarget.data.foregroundNow === true &&
        !!focusTarget.data.window &&
        focusTarget.data.window.handle === fixtureWindow.handle &&
        focusTarget.data.window.title === bounds.title &&
        focusTarget.data.window.pid === fixtureWindow.pid &&
        focusTarget.data.window.className === fixtureWindow.className &&
        // focus must not resize or move the window
        focusTarget.data.window.rect.x === fixtureWindow.rect.x &&
        focusTarget.data.window.rect.y === fixtureWindow.rect.y &&
        focusTarget.data.window.rect.w === fixtureWindow.rect.w &&
        focusTarget.data.window.rect.h === fixtureWindow.rect.h &&
        !!focusForeground &&
        focusForeground.handle === fixtureWindow.handle,
      {
        result: focusTarget.ok
          ? {
              focused: focusTarget.data.focused,
              foregroundNow: focusTarget.data.foregroundNow,
              rect: focusTarget.data.window && focusTarget.data.window.rect,
              window: focusTarget.data.window && {
                handle: focusTarget.data.window.handle,
                title: focusTarget.data.window.title,
              },
            }
          : focusTarget,
        statusForeground: focusForeground && { handle: focusForeground.handle, title: focusForeground.title },
        before: previousForeground && { handle: previousForeground.handle, title: previousForeground.title },
      },
    )

    // Independent OS-level confirmation: ask Windows itself which window owns
    // the foreground, instead of trusting only the helper's own report.
    const foregroundProbe = await runPowershell(foregroundWindowScript())
    const foregroundProbeHandle =
      foregroundProbe.code === 0 ? Number(foregroundProbe.out.trim()) : NaN
    record(
      'Windows GetForegroundWindow independently confirms the fixture is foreground',
      foregroundProbe.code === 0 && foregroundProbeHandle === fixtureWindow.handle,
      { osForeground: foregroundProbeHandle, expected: fixtureWindow.handle, probe: foregroundProbe.out.slice(0, 120) },
    )

    const focusInvalid = await helper.rpc('focus', { handle: 0 })
    record(
      'focus rejects an invalid handle with a structured error',
      focusInvalid.ok === false && /valid window|non-zero handle/.test(String(focusInvalid.error)),
      focusInvalid.error,
    )

    // Put the previous foreground back (optional, best effort); the rest of the
    // run clicks the fixture again, which reactivates it whenever needed.
    if (
      previousForeground &&
      previousForeground.handle > 0 &&
      previousForeground.handle !== fixtureWindow.handle &&
      previousForeground.denied !== true
    ) {
      try {
        await helper.rpc('focus', { handle: previousForeground.handle }, 8000)
      } catch {
        // focus restore is best effort
      }
      await delay(250)
    }

    // -- zoom: centered upscale with sub-lattice ----------------------------
    const zoomPath = join(RUN_DIR, 'zoom.png')
    const zoom = await helper.rpc('zoom', {
      cx: targetB[0],
      cy: targetB[1],
      size: 270,
      scale: 3,
      subCols: 6,
      subRows: 6,
      path: zoomPath,
    })
    const expectedSourceX = Math.max(vs.x, Math.min(targetB[0] - 135, vs.x + vs.w - 270))
    const expectedSourceY = Math.max(vs.y, Math.min(targetB[1] - 135, vs.y + vs.h - 270))
    const zoomPng = zoom.ok ? pngSize(zoomPath) : null
    record(
      'zoom centered region output dims and mapping',
      zoom.ok === true &&
        zoom.data.width === 810 &&
        zoom.data.height === 810 &&
        zoom.data.source.w === 270 &&
        zoom.data.source.h === 270 &&
        zoom.data.source.x === expectedSourceX &&
        zoom.data.source.y === expectedSourceY &&
        Math.abs(zoom.data.subSpacingScreen - 45) < 0.001 &&
        /^[0-9a-f]{64}$/.test(zoom.data.captureHash) &&
        !!zoomPng &&
        zoomPng.width === 810 &&
        zoomPng.height === 810,
      { width: zoom.data && zoom.data.width, source: zoom.data && zoom.data.source, subSpacingScreen: zoom.data && zoom.data.subSpacingScreen },
    )

    // -- move accuracy ------------------------------------------------------
    const move = await helper.rpc('move', { x: targetA[0], y: targetA[1], durationMs: 260 })
    record(
      'animated move lands exactly on target',
      move.ok === true &&
        move.data.cursorX === targetA[0] &&
        move.data.cursorY === targetA[1] &&
        move.data.aborted === false &&
        move.data.elapsedMs >= 150 &&
        move.data.elapsedMs < 3000,
      { target: targetA, result: move.data },
    )

    // -- move with linear easing -------------------------------------------
    const linearMove = await helper.rpc('move', { x: targetA[0], y: targetA[1] + 80, durationMs: 120, easing: 'linear' })
    record(
      'move supports linear easing',
      linearMove.ok === true && linearMove.data.cursorX === targetA[0] && linearMove.data.cursorY === targetA[1] + 80,
      linearMove.data,
    )

    // -- real click verified by fixture ------------------------------------
    const clickA = await helper.rpc('click', { x: targetA[0], y: targetA[1], button: 'left', count: 1, durationMs: 200 })
    let loggedA = await waitForClick('TARGET-A', 1500)
    let clickARetried = false
    if (!loggedA) {
      // A click injected at the exact moment the fixture is (re)activated can be
      // swallowed by the window manager on a busy desktop; retry once so the
      // ground-truth check tests the injection path, not one activation race.
      clickARetried = true
      await delay(250)
      await helper.rpc('click', { x: targetA[0], y: targetA[1], button: 'left', count: 1, durationMs: 200 })
      loggedA = await waitForClick('TARGET-A', 1500)
    }
    record(
      'real click lands on fixture TARGET-A (ground truth)',
      clickA.ok === true &&
        !!loggedA &&
        distance(loggedA.x, loggedA.y, targetA[0], targetA[1]) <= 2,
      { result: clickA.data, fixtureLogged: loggedA, retried: clickARetried },
    )

    // -- right / middle button clicks succeed ------------------------------
    const blankPoint = { x: bounds.window[0] + bounds.window[2] - 76, y: bounds.window[1] + bounds.window[3] - 51 }
    const rightClick = await helper.rpc('click', { x: blankPoint.x, y: blankPoint.y, button: 'right', count: 1, durationMs: 120 })
    const middleClick = await helper.rpc('click', { x: blankPoint.x, y: blankPoint.y, button: 'middle', count: 1, durationMs: 120 })
    record(
      'right and middle button clicks succeed',
      rightClick.ok === true &&
        rightClick.data.button === 'right' &&
        rightClick.data.cursorX === blankPoint.x &&
        rightClick.data.cursorY === blankPoint.y &&
        middleClick.ok === true &&
        middleClick.data.button === 'middle',
      { right: rightClick.data, middle: middleClick.data },
    )

    // -- overlay show -------------------------------------------------------
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(250)
    const overlay = await helper.rpc('overlay', {
      show: true,
      mode: 'both',
      spacing: 320,
      opacity: 0.5,
      label: 'SMOKE',
    })
    await delay(700)
    record(
      'overlay shows lattice + status pill',
      overlay.ok === true &&
        overlay.data.visible === true &&
        overlay.data.pill.visible === true &&
        overlay.data.pill.stop &&
        typeof overlay.data.pill.stop.x === 'number',
      { visible: overlay.data && overlay.data.visible, captureExcluded: overlay.data && overlay.data.captureExcluded },
    )

    // -- click-through: real click reaches the fixture below the lattice ----
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    const clickB = await helper.rpc('click', { x: targetB[0], y: targetB[1], button: 'left', count: 1, durationMs: 200 })
    const loggedB = await waitForClick('TARGET-B', 1500)
    record(
      'click passes through click-through lattice overlay',
      clickB.ok === true && !!loggedB && distance(loggedB.x, loggedB.y, targetB[0], targetB[1]) <= 2,
      { result: clickB.data, fixtureLogged: loggedB },
    )

    // -- pill STOP button: unsolicited events ------------------------------
    const stopPoint = overlay.data.pill.stop
    const eventStart = helper.events.length
    const stopClick = await helper.rpc('click', {
      x: stopPoint.x,
      y: stopPoint.y,
      button: 'left',
      count: 1,
      durationMs: 180,
    })
    await delay(400)
    const newEvents = helper.events.slice(eventStart)
    const stopEvent = newEvents.find((entry) => entry.event === 'stop')
    const pillClickEvent = newEvents.find((entry) => entry.event === 'pill-click')
    record(
      'pill STOP emits stop + pill-click events',
      stopClick.ok === true && !!stopEvent && !!pillClickEvent,
      { events: newEvents.map((entry) => entry.event) },
    )

    // -- hide overlay and capture a clean baseline in this content state ----
    const hide = await helper.rpc('overlay', { show: false })
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(450)
    const cleanBasePath = join(RUN_DIR, 'capture-region-clean-base.png')
    const cleanBase = await helper.rpc('capture', {
      path: cleanBasePath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    })
    record(
      'overlay hides again',
      hide.ok === true && hide.data.visible === false && cleanBase.ok === true,
      { visible: hide.data && hide.data.visible },
    )

    // -- overlay excluded from capture -------------------------------------
    const overlayAgain = await helper.rpc('overlay', {
      show: true,
      mode: 'both',
      spacing: 320,
      opacity: 0.5,
      label: 'SMOKE',
    })
    await delay(700)
    const overlayShotPath = join(RUN_DIR, 'capture-region-overlay-visible.png')
    const overlayShot = await helper.rpc('capture', {
      path: overlayShotPath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      excludeOverlay: false,
    })
    let overlayExcluded = false
    let excludeMethod = 'none'
    if (overlayShot.ok === true && cleanBase.ok === true && overlayShot.data.captureHash === cleanBase.data.captureHash) {
      overlayExcluded = true
      excludeMethod = 'wda-exclude-from-capture'
    } else {
      const fallbackShot = await helper.rpc('capture', {
        path: join(RUN_DIR, 'capture-region-overlay-fallback.png'),
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        excludeOverlay: true,
      })
      if (fallbackShot.ok === true && cleanBase.ok === true && fallbackShot.data.captureHash === cleanBase.data.captureHash) {
        overlayExcluded = true
        excludeMethod = 'hide-during-capture'
      }
    }
    record('overlay is excluded from capture', overlayExcluded && overlayAgain.ok === true, {
      method: excludeMethod,
      reportedCaptureExcluded: overlayAgain.data && overlayAgain.data.captureExcluded,
    })

    // -- overlay hide restores a clean capture -----------------------------
    const hideAgain = await helper.rpc('overlay', { show: false })
    await delay(400)
    const afterHidePath = join(RUN_DIR, 'capture-region-overlay-hidden.png')
    const afterHide = await helper.rpc('capture', {
      path: afterHidePath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    })
    record(
      'overlay hides and capture is clean again',
      // Hash equality against the pre-overlay baseline is intentionally not
      // required: this smoke runs over a live desktop whose animations can
      // change pixels, which produced a rare false negative. The overlay
      // exclusion itself is asserted by the previous check.
      hideAgain.ok === true &&
        hideAgain.data.visible === false &&
        afterHide.ok === true,
      {
        visible: hideAgain.data && hideAgain.data.visible,
        baselineHashEqual: !!(afterHide.data && cleanBase.data && afterHide.data.captureHash === cleanBase.data.captureHash),
      },
    )

    // -- abort interrupts an animation -------------------------------------
    const slowMovePromise = helper.rpc('move', { x: targetC[0], y: targetC[1], durationMs: 3000 }, 15000)
    await delay(400)
    const abortPromise = helper.rpc('abort')
    const slowMove = await slowMovePromise
    const abortResponse = await abortPromise
    const statusAfterAbort = await helper.rpc('status')
    const cursorAfterAbort = statusAfterAbort.ok ? statusAfterAbort.data.cursor : { x: -99999, y: -99999 }
    const abortDistance = distance(cursorAfterAbort.x, cursorAfterAbort.y, targetC[0], targetC[1])
    record(
      'abort interrupts mid-move and stops short of target',
      slowMove.ok === true &&
        slowMove.data.aborted === true &&
        abortResponse.ok === true &&
        abortResponse.data.aborted === true &&
        abortDistance > 40,
      { move: slowMove.data, abort: abortResponse.data, cursor: cursorAfterAbort, distanceToTarget: Math.round(abortDistance) },
    )

    // -- v0.8.5.1: abort must release an OS button the helper never tracked ----
    // Simulate a button left down by another process (the helper's own button
    // bookkeeping is false). The old tracking-only release missed it; the
    // touchpad click state stayed stuck until a real mouse click.
    const middleDown = '0x0020' // MOUSEEVENTF_MIDDLEDOWN
    const middleUp = '0x0040' // MOUSEEVENTF_MIDDLEUP
    await runPowershell(mouseButtonScript(middleDown))
    const physicalDownStatus = await helper.rpc('status')
    record(
      'physical middle button is down while tracking is false',
      physicalDownStatus.ok === true &&
        physicalDownStatus.data &&
        physicalDownStatus.data.physicalButtonsDown &&
        physicalDownStatus.data.physicalButtonsDown.middle === true &&
        physicalDownStatus.data.buttonsDown &&
        physicalDownStatus.data.buttonsDown.middle === false,
      { physical: physicalDownStatus.data && physicalDownStatus.data.physicalButtonsDown, tracked: physicalDownStatus.data && physicalDownStatus.data.buttonsDown },
    )
    let untrackedAbort = null
    try {
      untrackedAbort = await helper.rpc('abort')
    } finally {
      // Always clear the simulated physical button, even if the assertion fails.
      const afterUntrackedAbort = await helper.rpc('status')
      await runPowershell(mouseButtonScript(middleUp))
      record(
        'abort releases an OS button that tracking did not know about',
        untrackedAbort && untrackedAbort.ok === true &&
          afterUntrackedAbort.ok === true &&
          afterUntrackedAbort.data &&
          afterUntrackedAbort.data.physicalButtonsDown &&
          afterUntrackedAbort.data.physicalButtonsDown.middle === false,
        { abort: untrackedAbort && untrackedAbort.data, after: afterUntrackedAbort.data && afterUntrackedAbort.data.physicalButtonsDown },
      )
    }

    // -- out of bounds is a fail-closed error ------------------------------
    const oobMove = await helper.rpc('move', { x: vs.x + vs.w + 500, y: vs.y + vs.h + 500, durationMs: 10 })
    const oobClick = await helper.rpc('click', { x: vs.x + vs.w + 500, y: vs.y + vs.h + 500 })
    record(
      'out-of-bounds move/click rejected with error',
      oobMove.ok === false &&
        /outside virtual screen/.test(String(oobMove.error)) &&
        oobClick.ok === false &&
        /outside virtual screen/.test(String(oobClick.error)),
      { moveError: oobMove.error, clickError: oobClick.error },
    )

    // -- scroll -------------------------------------------------------------
    const scrollRegion = clampRegion(vs.x + Math.round(vs.w * 0.7), vs.y + Math.round(vs.h * 0.45), 1, 1, vs)
    const scrollTarget = { x: scrollRegion.x, y: scrollRegion.y }
    const scroll = await helper.rpc('scroll', { delta: 1, x: scrollTarget.x, y: scrollTarget.y })
    record(
      'scroll moves first and injects wheel notches',
      scroll.ok === true && scroll.data.cursorX === scrollTarget.x && scroll.data.cursorY === scrollTarget.y && scroll.data.delta === 1,
      scroll.data,
    )

    // -- drag inside the fixture blank area ---------------------------------
    const dragFrom = { x: bounds.window[0] + bounds.window[2] - 40, y: bounds.window[1] + bounds.window[3] - 40 }
    const dragTo = { x: dragFrom.x - 60, y: dragFrom.y }
    const drag = await helper.rpc('drag', {
      fromX: dragFrom.x,
      fromY: dragFrom.y,
      toX: dragTo.x,
      toY: dragTo.y,
      button: 'left',
      durationMs: 150,
    })
    record(
      'drag presses, animates and releases at destination',
      drag.ok === true && drag.data.cursorX === dragTo.x && drag.data.cursorY === dragTo.y && drag.data.aborted === false,
      drag.data,
    )

    // -- set_deny -----------------------------------------------------------
    const setDeny = await helper.rpc('set_deny', { processes: ['fixture.exe'], classes: ['NoSuchClassXYZ'] })
    const deniedProbe = await helper.rpc('probe_at', { x: targetA[0], y: targetA[1] })
    const clearDeny = await helper.rpc('set_deny', { processes: [], classes: [] })
    const clearedProbe = await helper.rpc('probe_at', { x: targetA[0], y: targetA[1] })
    record(
      'set_deny flags matching windows denied and clears',
      setDeny.ok === true &&
        deniedProbe.ok === true &&
        deniedProbe.data.window.denied === true &&
        clearDeny.ok === true &&
        clearedProbe.ok === true &&
        clearedProbe.data.window.denied === false,
      {
        denied: deniedProbe.data && deniedProbe.data.window && deniedProbe.data.window.denied,
        cleared: clearedProbe.data && clearedProbe.data.window && clearedProbe.data.window.denied,
      },
    )

    // ==================================================================
    // v2: external-abort detection, esc watchdog, keyboard, clipboard,
    // PrintWindow capture
    // ==================================================================

    // -- clean mouse actions must not report external interference ---------
    const cleanMoveV2 = await helper.rpc('move', { x: targetB[0], y: targetB[1], durationMs: 240 })
    record(
      'move reports externalAborted:false on a clean run',
      cleanMoveV2.ok === true &&
        cleanMoveV2.data.aborted === false &&
        cleanMoveV2.data.externalAborted === false,
      cleanMoveV2.data,
    )

    // -- a real external cursor move during the animation is detected ------
    // Spawn the interference first and wait until it is warm (ready marker),
    // then start the animation; the script delays its cursor loop briefly so the
    // interference interrupts the animation instead of pinning the start point.
    // On a loaded machine Add-Type used to outlast the 4 s move entirely.
    rmSync(INTERFERENCE_READY_PATH, { force: true })
    const interferenceInjectionPromise = runPowershell(
      cursorInterferenceScript(park.x - 240, park.y - 150, park.x - 380, park.y - 90, {
        readyPath: INTERFERENCE_READY_PATH,
        startDelayMs: 300,
      }),
    )
    const interferenceReady = await waitForFile(INTERFERENCE_READY_PATH, 20000)
    const interfereMovePromise = helper.rpc(
      'move',
      { x: targetC[0], y: targetC[1], durationMs: 4000 },
      25000,
    )
    const interferedMove = await interfereMovePromise
    const interferenceInjection = await interferenceInjectionPromise
    const statusAfterInterference = await helper.rpc('status')
    record(
      'external cursor interference aborts the move with externalAborted:true',
      interferenceReady === true &&
        interferedMove.ok === true &&
        interferedMove.data.externalAborted === true &&
        interferedMove.data.aborted === true &&
        interferenceInjection.code === 0 &&
        statusAfterInterference.ok === true &&
        statusAfterInterference.data.buttonsDown.left === false &&
        statusAfterInterference.data.buttonsDown.right === false &&
        statusAfterInterference.data.buttonsDown.middle === false,
      { move: interferedMove.data, injected: interferenceInjection.out.slice(0, 80) },
    )

    // -- set_esc_watch: Escape aborts a running action ---------------------
    // Focus the fixture first so the injected Escape lands there and not in
    // some other application. The long move gives the watchdog ample time.
    const farTarget = { x: vs.x + Math.round(vs.w * 0.08), y: vs.y + Math.round(vs.h * 0.08) }
    await helper.rpc('click', { x: targetA[0], y: targetA[1], durationMs: 120, holdMs: 20 })
    await delay(250)
    const escWatchOn = await helper.rpc('set_esc_watch', { enabled: true })
    const escEventStart = helper.events.length
    const escMovePromise = helper.rpc('move', { x: farTarget.x, y: farTarget.y, durationMs: 4000 }, 25000)
    await delay(250)
    const escapeInjection = await runPowershell(keyInjectScript('0x1B'))
    const escMove = await escMovePromise
    await delay(350)
    const escEvents = helper.events.slice(escEventStart).filter((entry) => entry.event === 'escape')
    const escMoveDistance = escMove.ok
      ? distance(escMove.data.cursorX, escMove.data.cursorY, farTarget.x, farTarget.y)
      : 0
    record(
      'set_esc_watch emits one escape event and aborts the running move',
      escWatchOn.ok === true &&
        escWatchOn.data.enabled === true &&
        escapeInjection.code === 0 &&
        escEvents.length === 1 &&
        escMove.ok === true &&
        escMove.data.aborted === true &&
        escMove.data.externalAborted === false &&
        escMoveDistance > 40,
      {
        events: helper.events.slice(escEventStart).map((entry) => entry.event),
        result: escMove.data,
        injected: escapeInjection.out.slice(0, 80),
      },
    )

    // -- set_esc_watch: any other physical key emits human-input ------------
    const humanEventStart = helper.events.length
    const humanMovePromise = helper.rpc('move', { x: farTarget.x, y: farTarget.y, durationMs: 4000 }, 25000)
    await delay(250)
    const humanInjection = await runPowershell(keyInjectScript('0x41')) // 'A'
    const humanMove = await humanMovePromise
    await delay(350)
    const humanEvents = helper.events
      .slice(humanEventStart)
      .filter((entry) => entry.event === 'human-input')
    record(
      'set_esc_watch emits one human-input event carrying the vk code',
      humanInjection.code === 0 &&
        humanEvents.length === 1 &&
        humanEvents[0].data &&
        humanEvents[0].data.vk === 0x41 &&
        humanMove.ok === true &&
        humanMove.data.aborted === true,
      {
        events: helper.events.slice(humanEventStart).map((entry) => entry.event),
        data: humanEvents.length > 0 ? humanEvents[0].data : null,
      },
    )
    // -- set_esc_watch: external cursor movement emits human-mouse ----------
    const mouseEventStart = helper.events.length
    await delay(400)
    const mouseA = { x: farTarget.x - 40, y: farTarget.y - 30 }
    const mouseB = { x: farTarget.x + 40, y: farTarget.y + 30 }
    const mouseInterference = await runPowershell(cursorInterferenceScript(mouseA.x, mouseA.y, mouseB.x, mouseB.y))
    await delay(450)
    const mouseEvents = helper.events
      .slice(mouseEventStart)
      .filter((entry) => entry.event === 'human-mouse')
    record(
      'set_esc_watch emits human-mouse events for physical cursor movement',
      mouseInterference.code === 0 &&
        mouseEvents.length >= 1 &&
        mouseEvents.every((entry) => entry.data && Number.isFinite(entry.data.x) && Number.isFinite(entry.data.y)),
      { count: mouseEvents.length, sample: mouseEvents.length > 0 ? mouseEvents[0].data : null },
    )

    // -- v6: Ctrl+Alt+F11, independent global abort hotkey ------------------
    // Esc watch is deliberately still enabled here: the abort chord must stop a
    // long-running injection and release held buttons regardless of the
    // Ctrl+Alt+F12 arm state, and it must emit exactly one "abort" event.
    const abortEventStart = helper.events.length
    // The previous interference test left the cursor near farTarget, so aim far
    // away from it: that makes "stopped short of the target" provable.
    const abortTarget = { x: vs.x + Math.round(vs.w * 0.92), y: vs.y + Math.round(vs.h * 0.9) }
    const abortMovePromise = helper.rpc('move', { x: abortTarget.x, y: abortTarget.y, durationMs: 4000 }, 25000)
    await delay(300)
    const abortInjection = await runPowershell(abortHotkeyScript())
    const abortMove = await abortMovePromise
    await delay(450)
    const abortEvents = helper.events
      .slice(abortEventStart)
      .filter((entry) => entry.event === 'abort')
    const statusAfterAbortHotkey = await helper.rpc('status')
    const abortMoveDistance = abortMove.ok
      ? distance(abortMove.data.cursorX, abortMove.data.cursorY, abortTarget.x, abortTarget.y)
      : 0
    record(
      'Ctrl+Alt+F11 global abort hotkey emits one abort event and stops the running move',
      abortInjection.code === 0 &&
        abortEvents.length === 1 &&
        abortEvents[0].data &&
        abortEvents[0].data.source === 'hotkey' &&
        abortMove.ok === true &&
        abortMove.data.aborted === true &&
        abortMoveDistance > 40 &&
        statusAfterAbortHotkey.ok === true &&
        statusAfterAbortHotkey.data.buttonsDown.left === false &&
        statusAfterAbortHotkey.data.buttonsDown.right === false &&
        statusAfterAbortHotkey.data.buttonsDown.middle === false,
      {
        events: helper.events.slice(abortEventStart).map((entry) => entry.event),
        result: abortMove.data,
        distanceToTarget: Math.round(abortMoveDistance),
        injected: abortInjection.out.slice(0, 80),
      },
    )
    const escWatchOff = await helper.rpc('set_esc_watch', { enabled: false })
    record(
      'set_esc_watch disarms on request',
      escWatchOff.ok === true && escWatchOff.data.enabled === false,
      escWatchOff.data,
    )

    // -- type_text into the fixture's type-box TextBox ---------------------
    // The fixture writes the TextBox content to <logDir>/typebox.txt. The
    // client origin is derived from TARGET-A's known client centre (115,72);
    // the type-box centre is client (337.5,191).
    rmSync(TYPEBOX_PATH, { force: true })
    const typeBoxPoint = {
      x: targetA[0] + Math.round(337.5 - 115),
      y: targetA[1] + (191 - 72),
    }
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(200)
    const typeBoxClick = await helper.rpc('click', {
      x: typeBoxPoint.x,
      y: typeBoxPoint.y,
      button: 'left',
      durationMs: 160,
    })
    const typeBoxClearSelect = await helper.rpc('press_keys', { keys: ['ctrl+a'] })
    const typeBoxClearDelete = await helper.rpc('press_keys', { keys: ['delete'] })
    // Chinese + accented + surrogate-pair emoji: exercises UTF-16 code-unit
    // iteration (escaped so this file stays ASCII).
    const TYPE_TEXT = '\u4e2d\u6587ab \u00e9 \u2705 \ud83d\ude00'
    const typed = await helper.rpc('type_text', { text: TYPE_TEXT, intervalMs: 10 })
    const typeBoxArrived = await waitForCondition(() => {
      if (!existsSync(TYPEBOX_PATH)) return false
      return readFileSync(TYPEBOX_PATH, 'utf8') === TYPE_TEXT
    }, 4000)
    const typeBoxContent = existsSync(TYPEBOX_PATH) ? readFileSync(TYPEBOX_PATH, 'utf8') : null
    record(
      'type_text injects unicode (incl. surrogate pair) into the fixture TextBox',
      typeBoxClick.ok === true &&
        typeBoxClearSelect.ok === true &&
        typeBoxClearDelete.ok === true &&
        typed.ok === true &&
        typed.data.aborted === false &&
        typed.data.chars === TYPE_TEXT.length &&
        typeBoxArrived === true,
      { typed: typed.data, textBox: typeBoxContent, target: typeBoxPoint },
    )

    // -- press_keys: whitelisted Enter works, unknown keys fail closed ------
    const pressEnter = await helper.rpc('press_keys', { keys: ['enter'] })
    const pressRejected = await helper.rpc('press_keys', { keys: ['win'] })
    record(
      'press_keys sends whitelisted enter and rejects unsupported keys',
      pressEnter.ok === true &&
        Array.isArray(pressEnter.data.sent) &&
        pressEnter.data.sent.length === 1 &&
        pressEnter.data.sent[0] === 'enter' &&
        pressRejected.ok === false &&
        /unsupported key/.test(String(pressRejected.error)),
      { enter: pressEnter.data, rejected: pressRejected.error },
    )

    // -- clipboard text round-trip (Chinese) -------------------------------
    // FB-03: requireText makes an empty/racing clipboard a hard error, retried
    // here a few times in case another process is still re-writing it.
    const CLIPBOARD_TEXT = '\u4e2d\u6587\u526a\u8d34\u677f\u56de\u8def \u2705 clipboard'
    const clipboardSet = await helper.rpc('clipboard_set', { text: CLIPBOARD_TEXT })
    let clipboardGet = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      clipboardGet = await helper.rpc('clipboard_get', { requireText: true }, 8000)
      if (clipboardGet.ok === true && clipboardGet.data && clipboardGet.data.text === CLIPBOARD_TEXT) break
      await delay(150)
    }
    record(
      'clipboard_set/get round-trip a Chinese string on the STA UI thread',
      clipboardSet.ok === true &&
        clipboardSet.data.chars === CLIPBOARD_TEXT.length &&
        clipboardGet.ok === true &&
        clipboardGet.data.text === CLIPBOARD_TEXT &&
        clipboardGet.data.chars === CLIPBOARD_TEXT.length &&
        clipboardGet.data.hasText === true &&
        clipboardGet.data.reason === 'text',
      {
        set: clipboardSet.data,
        get: clipboardGet.data && { chars: clipboardGet.data.chars, hasText: clipboardGet.data.hasText, reason: clipboardGet.data.reason },
      },
    )

    // -- clipboard with no text: hasText/reason + requireText fails closed ---
    const clipboardClear = await helper.rpc('clipboard_set', { text: '' })
    let clipboardEmpty = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      clipboardEmpty = await helper.rpc('clipboard_get', {}, 8000)
      if (clipboardEmpty.ok === true && clipboardEmpty.data.hasText === false) break
      await delay(150)
    }
    const clipboardRequireText = await helper.rpc('clipboard_get', { requireText: true }, 8000)
    record(
      'clipboard_get reports no-text and requireText fails closed',
      clipboardClear.ok === true &&
        clipboardEmpty.ok === true &&
        clipboardEmpty.data.text === '' &&
        clipboardEmpty.data.hasText === false &&
        clipboardEmpty.data.reason === 'no-text' &&
        clipboardRequireText.ok === false &&
        /no text/i.test(String(clipboardRequireText.error)),
      {
        empty: clipboardEmpty && clipboardEmpty.data,
        requireText: clipboardRequireText.ok === true ? clipboardRequireText.data : clipboardRequireText.error,
      },
    )

    // -- capture by windowHandle (PrintWindow) -----------------------------
    // Park the cursor and move focus off the TextBox first: a focused TextBox
    // draws a caret, which would make successive PrintWindow captures of the
    // same content differ by that one-pixel caret.
    await helper.rpc('click', { x: targetA[0], y: targetA[1], durationMs: 120, holdMs: 20 })
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(300)
    const windowShotPath = join(RUN_DIR, 'capture-window.png')
    const windowShot = await helper.rpc('capture', {
      windowHandle: fixtureWindow.handle,
      path: windowShotPath,
    })
    const windowShotPng = windowShot.ok ? pngSize(windowShotPath) : null
    record(
      'capture windowHandle uses PrintWindow and reports the window rect',
      windowShot.ok === true &&
        windowShot.data.windowHandle === fixtureWindow.handle &&
        windowShot.data.sourceKind === 'window' &&
        windowShot.data.source.x === fixtureWindow.rect.x &&
        windowShot.data.source.y === fixtureWindow.rect.y &&
        windowShot.data.source.w === fixtureWindow.rect.w &&
        windowShot.data.source.h === fixtureWindow.rect.h &&
        windowShot.data.blackFrame === false &&
        /^[0-9a-f]{64}$/.test(windowShot.data.captureHash) &&
        !!windowShotPng &&
        windowShotPng.width === fixtureWindow.rect.w &&
        windowShotPng.height === fixtureWindow.rect.h,
      {
        window: fixtureWindow && fixtureWindow.rect,
        result: windowShot.ok
          ? {
              source: windowShot.data.source,
              windowHandle: windowShot.data.windowHandle,
              black: windowShot.data.blackFrame,
            }
          : windowShot,
      },
    )

    const invalidWindowShot = await helper.rpc('capture', {
      windowHandle: 0,
      path: join(RUN_DIR, 'capture-window-invalid.png'),
    })
    record(
      'capture rejects an invalid windowHandle with a clear error',
      invalidWindowShot.ok === false &&
        /not a valid window|own window/.test(String(invalidWindowShot.error)),
      invalidWindowShot.error,
    )

    // -- clientOnly client-area capture (FB-07) ----------------------------
    // Ground truth for the fixture's client area: TARGET-A's client centre is
    // (115,72) and ClientSize is 460x300 (test/fixture.cs). Both are physical
    // pixels because the fixture sets Per-Monitor-V2 DPI awareness.
    const expectedClient = {
      x: bounds.buttons.A[0] - 115,
      y: bounds.buttons.A[1] - 72,
      w: 460,
      h: 300,
    }
    const clientVisiblePath = join(RUN_DIR, 'capture-window-client-visible.png')
    const clientVisible = await helper.rpc('capture', {
      windowHandle: fixtureWindow.handle,
      clientOnly: true,
      path: clientVisiblePath,
    })
    const clientVisiblePng = clientVisible.ok ? pngSize(clientVisiblePath) : null

    // -- the same window captured while fully occluded ---------------------
    occluder = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', occluderScript(OCCLUDER_TITLE)],
      { stdio: 'ignore', windowsHide: true },
    )
    const occludedReady = await waitForCondition(async () => {
      const probe = await helper.rpc('probe_at', { x: typeBoxPoint.x, y: typeBoxPoint.y }, 5000)
      return (
        probe.ok !== true ||
        (probe.data.window && probe.data.window.title === OCCLUDER_TITLE)
      )
    }, 15000)
    // FB-02: the first PrintWindow after another window covers the target can
    // report a stale/blank frame, so stability is proven by two consecutive
    // renders of the occluded window instead of comparing against the frame
    // from before occlusion.
    const occludedShotPath1 = join(RUN_DIR, 'capture-window-occluded-1.png')
    const occludedShotPath2 = join(RUN_DIR, 'capture-window-occluded-2.png')
    const occludedShot1 = occludedReady
      ? await helper.rpc('capture', { windowHandle: fixtureWindow.handle, path: occludedShotPath1 })
      : null
    const occludedShot2 = occludedReady
      ? await helper.rpc('capture', { windowHandle: fixtureWindow.handle, path: occludedShotPath2 })
      : null
    const occludedPng1 = occludedShot1 && occludedShot1.ok ? pngSize(occludedShotPath1) : null
    const occludedPng2 = occludedShot2 && occludedShot2.ok ? pngSize(occludedShotPath2) : null
    const occludedStable =
      !!occludedShot1 &&
      !!occludedShot2 &&
      occludedShot1.ok === true &&
      occludedShot2.ok === true &&
      occludedShot1.data.captureHash === occludedShot2.data.captureHash
    record(
      'capture windowHandle renders a stable frame while occluded (PrintWindow)',
      occludedReady === true &&
        occludedStable === true &&
        occludedShot1.data.windowHandle === fixtureWindow.handle &&
        occludedShot1.data.blackFrame === false &&
        occludedShot2.data.blackFrame === false &&
        !!occludedPng1 &&
        !!occludedPng2 &&
        occludedPng1.width === fixtureWindow.rect.w &&
        occludedPng1.height === fixtureWindow.rect.h &&
        occludedPng2.width === fixtureWindow.rect.w &&
        occludedPng2.height === fixtureWindow.rect.h,
      {
        occluded: occludedReady,
        stable: occludedStable,
        hash: occludedShot1 && occludedShot1.ok ? occludedShot1.data.captureHash : null,
        png: occludedPng1,
      },
    )

    // -- clientOnly: client size, non-black, stable across occlusion -------
    const clientOccludedPath1 = join(RUN_DIR, 'capture-window-client-occluded-1.png')
    const clientOccludedPath2 = join(RUN_DIR, 'capture-window-client-occluded-2.png')
    const clientOccluded1 = occludedReady
      ? await helper.rpc('capture', {
          windowHandle: fixtureWindow.handle,
          clientOnly: true,
          path: clientOccludedPath1,
        })
      : null
    const clientOccluded2 = occludedReady
      ? await helper.rpc('capture', {
          windowHandle: fixtureWindow.handle,
          clientOnly: true,
          path: clientOccludedPath2,
        })
      : null
    const clientOccludedPng = clientOccluded1 && clientOccluded1.ok ? pngSize(clientOccludedPath1) : null
    record(
      'capture clientOnly uses the client rect, stays non-black and stable while occluded',
      clientVisible.ok === true &&
        clientVisible.data.clientOnly === true &&
        clientVisible.data.sourceKind === 'window' &&
        clientVisible.data.source.x === expectedClient.x &&
        clientVisible.data.source.y === expectedClient.y &&
        clientVisible.data.source.w === expectedClient.w &&
        clientVisible.data.source.h === expectedClient.h &&
        clientVisible.data.width === expectedClient.w &&
        clientVisible.data.height === expectedClient.h &&
        clientVisible.data.blackFrame === false &&
        !!clientVisiblePng &&
        clientVisiblePng.width === expectedClient.w &&
        clientVisiblePng.height === expectedClient.h &&
        occludedReady === true &&
        !!clientOccluded1 &&
        !!clientOccluded2 &&
        clientOccluded1.ok === true &&
        clientOccluded2.ok === true &&
        clientOccluded1.data.clientOnly === true &&
        clientOccluded1.data.blackFrame === false &&
        clientOccluded2.data.blackFrame === false &&
        clientOccluded1.data.source.x === expectedClient.x &&
        clientOccluded1.data.source.y === expectedClient.y &&
        clientOccluded1.data.source.w === expectedClient.w &&
        clientOccluded1.data.source.h === expectedClient.h &&
        clientOccluded1.data.captureHash === clientVisible.data.captureHash &&
        clientOccluded2.data.captureHash === clientOccluded1.data.captureHash &&
        !!clientOccludedPng &&
        clientOccludedPng.width === expectedClient.w &&
        clientOccludedPng.height === expectedClient.h,
      {
        expected: expectedClient,
        visible: clientVisible.ok
          ? { source: clientVisible.data.source, width: clientVisible.data.width, height: clientVisible.data.height, black: clientVisible.data.blackFrame }
          : clientVisible,
        occluded: clientOccluded1 && clientOccluded1.ok
          ? { source: clientOccluded1.data.source, black: clientOccluded1.data.blackFrame, hashStable: clientOccluded2.ok === true && clientOccluded2.data.captureHash === clientOccluded1.data.captureHash }
          : clientOccluded1,
        png: clientOccludedPng,
      },
    )
    try {
      if (occluder) occluder.kill()
    } catch {
      // ignore
    }
    occluder = null
    const fixtureVisibleAgain = await waitForCondition(async () => {
      const probe = await helper.rpc('probe_at', { x: typeBoxPoint.x, y: typeBoxPoint.y }, 5000)
      return probe.ok === true && probe.data.window && probe.data.window.title === bounds.title
    }, 8000)
    record('occluder window removed and fixture visible again', fixtureVisibleAgain, {})
    await delay(300)

    // -- captureHash changes with content (close the fixture) ---------------
    await helper.rpc('move', { x: park.x, y: park.y, durationMs: 0 })
    await delay(250)
    const beforeClosePath = join(RUN_DIR, 'capture-before-content-change.png')
    const beforeClose = await helper.rpc('capture', {
      path: beforeClosePath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    })
    await stopFixture(fixture)
    fixture = null
    await delay(600)
    const afterClosePath = join(RUN_DIR, 'capture-after-content-change.png')
    const afterClose = await helper.rpc('capture', {
      path: afterClosePath,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    })
    record(
      'captureHash changes when screen content changes',
      beforeClose.ok === true && afterClose.ok === true && beforeClose.data.captureHash !== afterClose.data.captureHash,
      { before: beforeClose.data && beforeClose.data.captureHash, after: afterClose.data && afterClose.data.captureHash },
    )

    // -- doctor -------------------------------------------------------------
    const doctor = await helper.rpc('doctor')
    record(
      'doctor self-check',
      doctor.ok === true &&
        doctor.data.protocol === 1 &&
        doctor.data.helperVersion === HELPER_VERSION &&
        doctor.data.dpiAware === true &&
        doctor.data.capture &&
        doctor.data.capture.ok === true &&
        doctor.data.capture.black === false &&
        doctor.data.hotkeyRegistered === true &&
        doctor.data.abortHotkeyRegistered === true &&
        doctor.data.abortHotkey &&
        doctor.data.abortHotkey.combo === 'Ctrl+Alt+F11' &&
        doctor.data.overlayAvailable === true &&
        typeof doctor.data.processElevated === 'boolean' &&
        Array.isArray(doctor.data.monitors) &&
        doctor.data.monitors.length >= 1 &&
        typeof doctor.data.build === 'number' &&
        doctor.data.uipiProbe &&
        typeof doctor.data.uipiProbe.note === 'string',
      doctor.data,
    )

    // -- restore cursor, clipboard, quit -----------------------------------
    if (originalClipboard !== null) {
      try {
        await helper.rpc('clipboard_set', { text: originalClipboard }, 8000)
      } catch {
        // ignore
      }
    }
    await helper.rpc('move', { x: startCursor.x, y: startCursor.y, durationMs: 0 })
    const restoredStatus = await helper.rpc('status')
    record(
      'cursor restored to its pre-test position',
      restoredStatus.ok === true &&
        Math.abs(restoredStatus.data.cursor.x - startCursor.x) <= 1 &&
        Math.abs(restoredStatus.data.cursor.y - startCursor.y) <= 1,
      { start: startCursor, now: restoredStatus.data && restoredStatus.data.cursor },
    )
    record('stdout carried protocol NDJSON only', helper.badLines.length === 0, { badLines: helper.badLines.slice(0, 5) })

    const quit = await helper.rpc('quit')
    const helperExited = await Promise.race([helper.exitPromise, delay(6000).then(() => null)])
    record(
      'quit exits the helper cleanly',
      quit.ok === true && quit.data.bye === true && helperExited !== null && helper.exitCode === 0,
      { bye: quit.data && quit.data.bye, exitCode: helper.exitCode },
    )
  } catch (error) {
    record('smoke run completed without crashing', false, {
      message: String(error && error.stack ? error.stack : error),
    })
  } finally {
    if (occluder) {
      try {
        occluder.kill()
      } catch {
        // ignore
      }
      occluder = null
      await delay(300)
    }
    if (helper && !helper.exited) {
      try {
        await helper.rpc('set_esc_watch', { enabled: false }, 3000)
      } catch {
        // ignore
      }
      try {
        if (startCursor) await helper.rpc('move', { x: startCursor.x, y: startCursor.y, durationMs: 0 }, 5000)
      } catch {
        // ignore
      }
      if (originalClipboard !== null) {
        try {
          await helper.rpc('clipboard_set', { text: originalClipboard }, 5000)
        } catch {
          // ignore
        }
      }
      try {
        await helper.rpc('quit', {}, 3000)
      } catch {
        // ignore
      }
      await delay(400)
      if (!helper.exited) {
        try {
          helper.child.kill()
        } catch {
          // ignore
        }
      }
    }
    if (fixture) await stopFixture(fixture)
    rmSync(FIXTURE_COPY, { force: true })
    await delay(300)

    const failed = results.filter((entry) => !entry.ok).length
    console.log('')
    console.log('RESULTS_DIR=' + RUN_DIR)
    console.log('SUMMARY: ' + (results.length - failed) + '/' + results.length + ' checks passed, ' + failed + ' failed')
    process.exit(failed === 0 ? 0 : 1)
  }
}

main()
