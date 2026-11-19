// The tool surface: what the agent can call to see and drive the Windows desktop.
import { spawn } from 'node:child_process'
import { defineTool } from './runtime.js'
import {
  listWindows, foregroundWindow, focusWindow, windowHandleByTitle, closeWindow,
  click, drag, scroll, tryMoveCursor, cursorPosition, typeText, pressKey, hotkey,
  processNameOfPid, screenMetrics, isKeyDown, shellOpen, splitAppSpec,
  releaseAllInputs, listMonitors,
} from './win32.js'
import { grab, describeDesktop, settle } from './capture.js'
import { uia } from './uia.js'
import { gate } from './safety.js'
// 2026-11-08（Q7 审计统一）：审计写失败不再静默吞掉。safeAudit 只警告不抛（工具不崩），
// 失败经 index.js 接的 handler 进 ctx.logger.warn —— "没写成"必须能看见，绝不假装写过。
import { check as policyCheck, safeAudit as policyAuditSafe, readState as readPolicyState, WRITE_ACTIONS } from './policy.js'
import { readClipboard, writeClipboard, waitClipboardChange } from './clipboard.js'
import { pulseOverlay } from './overlay.js'
import { matchDeny } from './deny.js'
import { readStop, readControlScope } from './gate.js'

const text = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

/**
 * Tell the user, on their own screen, that the machine is being driven.
 * Without this they are looking at some other window and cannot tell a working agent
 * from one that has already finished (or hung).
 */
function showDriving(config, detail) {
  if (config.overlay === false) return
  const hint = config.cancelOnEsc ? '　·　按 Esc 取消' : ''
  pulseOverlay(`●  DSH 正在操作你的电脑${detail ? `　${detail}` : ''}${hint}`, config.overlayIdleMs ?? 1600)
}

/**
 * Esc as a brake, opt-in. Read from async key state so it works while the agent is busy
 * in another window. A synthetic Esc we sent ourselves must not trip it, so the caller
 * passes the time of its own last Esc.
 */
function escPressed(config, ignoreUntil = 0) {
  if (!config.cancelOnEsc) return false
  if (Date.now() < ignoreUntil) return false
  return isKeyDown('esc')
}

/**
 * Only one screenshot is "current" at a time; actions may reference its pixel space.
 * `lastLookAt` is about freshness of *knowledge*: a UI Automation read counts as a look
 * even though it produced no image at all.
 */
const state = { lastShot: null, lastLookAt: 0, ignoreEscUntil: 0 }

/** Control types that can be operated even when they advertise no UIA pattern. */
const OPERABLE_TYPES = new Set([
  'Button', 'Edit', 'ComboBox', 'ListItem', 'MenuItem', 'TabItem', 'CheckBox',
  'RadioButton', 'Slider', 'Hyperlink', 'SplitButton', 'TreeItem', 'DataItem',
  'Document', 'Spinner',
])

/** Which UIA pattern decides how this control should be driven, best first. */
function actionFor(node) {
  const patterns = Array.isArray(node.patterns) ? node.patterns : []
  const has = name => patterns.includes(name)
  if (has('invoke')) return 'invoke'
  if (has('value')) return 'fill'
  if (has('toggle')) return 'toggle'
  if (has('selectionitem')) return 'select'
  if (has('expandcollapse')) return 'expand'
  if (has('scroll')) return 'scroll'
  if (OPERABLE_TYPES.has(node.type)) return 'click'
  return null
}

function centerOf(rect) {
  if (!rect || !rect.width || !rect.height) return null
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

function metaNote(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const parts = []
  if (meta.toggle) parts.push(`toggle:${meta.toggle}`)
  if (meta.expand) parts.push(`state:${meta.expand}`)
  if (meta.password) parts.push('password')
  else if (meta.value !== undefined && meta.value !== '') parts.push(`value:${JSON.stringify(meta.value).slice(0, 40)}`)
  if (meta.readonly) parts.push('readonly')
  if (meta.min !== undefined && meta.max !== undefined) parts.push(`range:${meta.min}-${meta.max}`)
  return parts.length ? `  [${parts.join('] [')}]` : ''
}

/**
 * Read a window's controls through UI Automation and shape them for the model: one line
 * per operable control with its centre, its path (for `control:`), and how to drive it.
 */
async function uiaView(target, { maxDepth = 4, maxNodes = 160 } = {}) {
  const response = await uia({
    action: 'tree',
    ...(target?.handle ? { handle: target.handle } : {}),
    maxDepth,
    maxNodes,
    meta: true,
  }, { timeoutMs: 25000 })
  if (!response.ok) throw new Error(`UIA 读取失败：${response.error ?? '未知原因'}`)
  const bounds = desktopBounds()
  const nodes = (response.nodes ?? []).map(node => ({
    ...node,
    action: actionFor(node),
    center: centerOf(node.rect),
  }))
  const controls = nodes.filter(node => {
    if (!node.action || !node.center || node.offscreen) return false
    // A control can claim to be visible and still sit outside every monitor (scrolled-out
    // rows do this). Clicking there would send the mouse into nowhere.
    if (!bounds) return true
    const { x, y } = node.center
    return x >= bounds.x1 - 1 && y >= bounds.y1 - 1 && x <= bounds.x2 + 1 && y <= bounds.y2 + 1
  })
  return { nodes, controls, truncated: Boolean(response.truncated) }
}

/** Union of every visible window's rectangle — the area a click can actually land in. */
function desktopBounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const w of listWindows()) {
    if (!w.rect) continue
    x1 = Math.min(x1, w.rect.x)
    y1 = Math.min(y1, w.rect.y)
    x2 = Math.max(x2, w.rect.x + w.rect.width)
    y2 = Math.max(y2, w.rect.y + w.rect.height)
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null
}

/** The model-facing list of controls. */
function controlLines(view, { title, limit = 120 } = {}) {
  if (!view.controls.length) {
    return `窗口「${title}」里 UIA 没给出可操作的控件（只有 ${view.nodes.length} 个节点）。`
  }
  const lines = view.controls.slice(0, limit).map(node => {
    const name = node.name ? JSON.stringify(node.name.slice(0, 48)) : '""'
    const focused = node.focused ? '  [focused]' : ''
    return `  (${node.center.x},${node.center.y})  ${node.path.padEnd(10)}  ${node.type.padEnd(12)} ${name.padEnd(46)} [${node.action}]${focused}${metaNote(node.meta)}`
  })
  if (view.controls.length > limit) {
    lines.push(`  …还有 ${view.controls.length - limit} 个没列出来（把 maxNodes 调大，或先用 window 限定到一个窗口）`)
  }
  return lines.join('\n')
}

/**
 * Drive a control addressed by its UIA path instead of by a remembered pixel.
 * Two wins: the rectangle is measured at the moment of the action (nothing can drift
 * underneath it), and where a pattern allows it the control is operated directly —
 * so a filled field needs no keyboard and a button needs no mouse.
 * @returns {Promise<{handled:boolean, point?:{x:number,y:number}, notes:string[]}|null>}
 */
async function uiaStep(step, target) {
  // A rehearsal must never reach the UIA action layer: dryRun returns long before this,
  // so arriving here means a routing bug — refuse rather than write to the control.
  if (step?.dryRun === true) throw new Error('内部错误：dryRun 请求走到了 UIA 操作层，已拒绝（预演不得写入控件）')
  if (!step.control) return null
  const path = String(step.control).trim()
  const handle = target?.handle ?? foregroundWindow()?.handle
  if (!handle) throw new Error('control 要配一个窗口：前台没有窗口，用 window 指定一个')
  const read = await uia({ action: 'rect', handle, path }, { timeoutMs: 20000 })
  if (!read.ok) throw new Error(`窗口里找不到控件 ${path}：${read.error ?? '未知原因'}`)
  const element = read.element
  const label = `控件 ${path}${element.name ? `「${element.name}」` : ''}`
  const patterns = Array.isArray(element.patterns) ? element.patterns : []
  const point = centerOf(element.rect)

  if (step.action === 'type') {
    if (patterns.includes('value') && !element.meta?.readonly) {
      const filled = await uia({ action: 'setvalue', handle, path, value: String(step.text ?? '') }, { timeoutMs: 20000 })
      if (filled.ok) {
        return { handled: true, notes: [`直接给${label}喂了 ${String(step.text ?? '').length} 个字符（UIA 赋值，没碰键盘）`] }
      }
    }
    if (!point) throw new Error(`${label} 没有可点的矩形，没法聚焦后打字`)
    return { handled: false, point, notes: [] }
  }

  if (step.action === 'click' || step.action === 'double_click') {
    const how = step.how ?? (patterns.includes('invoke') ? 'invoke' : 'click')
    if (how === 'invoke') {
      const pressed = await uia({ action: 'invoke', handle, path }, { timeoutMs: 20000 })
      if (pressed.ok) {
        return { handled: true, notes: [`用 UIA 直接按了${label}（没动鼠标，前台是谁都行）`] }
      }
    }
    if (!point) throw new Error(`${label} 没有可点的矩形`)
    return { handled: false, point, notes: [`${label} 的中心是 (${point.x},${point.y})`] }
  }

  if (!point) return null
  return { handled: false, point, notes: [] }
}

function resolveWindow(ref) {
  if (ref === undefined || ref === null || ref === '') return null
  if (typeof ref === 'number') return { handle: ref, title: '' }
  const raw = String(ref).trim()
  if (/^\d+$/.test(raw)) return { handle: Number(raw), title: '' }
  const found = windowHandleByTitle(raw)
  if (!found) {
    const titles = listWindows().map(w => w.title).filter(Boolean).slice(0, 12)
    throw new Error(`没有标题包含「${raw}」的窗口。当前窗口有：${titles.join(' / ') || '（无）'}`)
  }
  return { handle: found.handle, title: found.title }
}

function formatRect(rect) {
  return rect ? `${rect.width}x${rect.height} @ (${rect.x},${rect.y})` : '未知位置'
}

function windowLines(desk) {
  const lines = []
  const fg = desk.foreground
  if (fg) {
    lines.push(`前台窗口：${fg.title || '(无标题)'}  [${fg.class}${fg.process ? ` / ${fg.process}` : ''}] handle=${fg.handle} pid=${fg.pid} ${formatRect(fg.rect)}`)
  } else {
    lines.push('前台窗口：无')
  }
  lines.push(`屏幕：${desk.screen.width}x${desk.screen.height}，光标在 (${desk.cursor.x},${desk.cursor.y})，共 ${desk.windowCount} 个可见窗口`)
  for (const w of desk.windows) {
    lines.push(`  ${w.foreground ? '*' : ' '} handle=${w.handle}  ${w.title.slice(0, 48)}  [${w.class}${w.process ? ` / ${w.process}` : ''}]  ${formatRect(w.rect)}${w.minimized ? ' (最小化)' : ''}`)
  }
  return lines.join('\n')
}

function coordHint(shot) {
  return `图片是 ${shot.imageWidth}x${shot.imageHeight}（原画 ${shot.sourceWidth}x${shot.sourceHeight}），换算：屏幕x = ${shot.origin.x} + 图片x × ${shot.scaleX.toFixed(4)}，屏幕y = ${shot.origin.y} + 图片y × ${shot.scaleY.toFixed(4)}。screen_act 也可以直接传 imageX / imageY，本插件自己换算。`
}

function observe(config, { settleMs, force = false, note } = {}) {
  // Give the screen a moment to repaint: a frame grabbed in the same tick as the click
  // can still show the old state, which reads as "the click did nothing".
  settle(settleMs ?? config.settleMs ?? 180)
  const shot = grab({
    dir: config.shotDir,
    maxWidth: config.observeMaxWidth ?? 1280,
    maxHeight: config.observeMaxHeight ?? 900,
    name: 'after',
    forceImage: force,
  })
  state.lastShot = { ...shot, at: Date.now() }
  state.lastLookAt = Date.now()
  const desk = describeDesktop({ maxWindows: 6 })
  const head = shot.unchanged
    ? `画面和上一张逐像素一样（没重存文件，你手上那张图继续有效）：${shot.path}（${shot.imageWidth}x${shot.imageHeight}）`
    : `动作执行完，已经重新截了一张：${shot.path}（${shot.imageWidth}x${shot.imageHeight}）`
  return { shot, text: `${head}\n${windowLines(desk)}${note ? `\n${note}` : ''}` }
}

/**
 * Run one action and describe it. Shared by screen_act (one step) and screen_sequence
 * (a batch), so both behave identically — the only difference is how many frames come back.
 * @returns {string[]} notes to report
 */
function performAction(action, args, config, { point, target }) {
  // The injection layer. A dryRun must never get here: the rehearsal path returns earlier,
  // so arriving here means a routing bug — refuse instead of touching the desktop.
  if (args?.dryRun === true) throw new Error('内部错误：dryRun 请求走到了注入层，已拒绝（预演不得注入输入）')
  const notes = []
  // ③ 拒绝清单下沉：命中共享清单即拒（open 看进程名、close 看窗口标题；点/输入类由宿主 gate 兜底）。
  const denyTarget =
    action === 'open'
      ? (() => { const s = splitAppSpec(args.app); return s ? { process: s.file } : null })()
      : action === 'close' ? { title: target && target.title } : null
  if (denyTarget) {
    const hit = matchDeny(denyTarget)
    if (hit) throw new Error(`命中共享拒绝清单 [${hit.group}/${hit.label}] ${hit.rule}：拒绝执行 ${action}`)
  }
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      if (!point) throw new Error('click 需要 x/y 或 imageX/imageY')
      const button = args.button ?? (action === 'right_click' ? 'right' : 'left')
      const count = args.count ?? (action === 'double_click' ? 2 : 1)
      click(point.x, point.y, { button, count })
      notes.push(`在 (${Math.round(point.x)},${Math.round(point.y)}) 用 ${button} 键点了 ${count} 次`)
      break
    }
    case 'move': {
      if (!point) throw new Error('move 需要 x/y 或 imageX/imageY')
      const how = tryMoveCursor(point.x, point.y)
      notes.push(how
        ? `鼠标移到 (${Math.round(point.x)},${Math.round(point.y)})（${how}）`
        : `鼠标移动被系统或前台程序拒绝了：( ${Math.round(point.x)},${Math.round(point.y)} ) 没动成`)
      break
    }
    case 'drag': {
      if (!point || args.toX === undefined || args.toY === undefined) throw new Error('drag 需要起点 x/y 和终点 toX/toY')
      drag(point, { x: args.toX, y: args.toY }, { button: args.button ?? 'left' })
      notes.push(`从 (${Math.round(point.x)},${Math.round(point.y)}) 拖到 (${args.toX},${args.toY})`)
      break
    }
    case 'scroll': {
      const cursor = cursorPosition()
      const at = point ?? cursor
      scroll(at.x, at.y, { deltaY: args.deltaY ?? 0, deltaX: args.deltaX ?? 0 })
      notes.push(`在 (${Math.round(at.x)},${Math.round(at.y)}) 滚动 dx=${args.deltaX ?? 0} dy=${args.deltaY ?? 0}`)
      break
    }
    case 'type': {
      if (typeof args.text !== 'string') throw new Error('type 需要 text')
      const text = args.text
      const pasteAt = Number(config.typePasteThreshold ?? 0)
      const chunkChars = Number(config.typeChunkChars ?? 0)
      const verifyMin = Number(config.typeVerifyMinChars ?? 0)
      let method = 'unicode-typing'
      const prevClip = pasteAt > 0 && text.length >= pasteAt ? readClipboard() : null
      try {
        if (pasteAt > 0 && text.length >= pasteAt) {
          if (!writeClipboard(text)) throw new Error('写剪贴板失败，无法用粘贴方式输入')
          hotkey(['ctrl', 'v'])
          method = 'clipboard-paste'
        } else {
          typeText(text, {
            perCharDelayMs: config.typeDelayMs ?? 0,
            chunkChars,
            chunkDelayMs: config.typeChunkDelayMs ?? 0,
          })
        }
      } finally {
        // 粘贴方式借用了剪贴板，用完把主人原来的内容还回去。
        if (prevClip !== null && prevClip !== undefined) { try { writeClipboard(prevClip) } catch { /* best effort */ } }
      }
      notes.push(`输入了 ${text.length} 个字符（${method}）：${JSON.stringify(text.slice(0, 40))}${text.length > 40 ? '…' : ''}`)
      if (method === 'unicode-typing' && chunkChars > 0 && text.length > chunkChars) {
        notes.push(`分批输入：每 ${chunkChars} 字一批，批间停 ${config.typeChunkDelayMs ?? 0}ms`)
      }
      const wantVerify = args.verifyText === true || (verifyMin >= 0 && text.length >= verifyMin && verifyMin > 0)
      if (wantVerify) {
        const before = readClipboard()
        try {
          hotkey(['ctrl', 'a'])
          // 全选要时间：立刻按 Ctrl+C 会复制"上一次的选区"，读回来还是旧剪贴板。
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
          hotkey(['ctrl', 'c'])
          // 固定 sleep 挡不住"目标程序还在消化前面注入的按键"（长文本尤其明显）：
          // 改成轮询等剪贴板真换了内容再读，才不会把旧剪贴板当成读回结果。
          // 也正因为轮询要等它落地，剪贴板恢复必须放在轮询之后，否则恢复会先被迟到的复制盖掉。
          const got = waitClipboardChange(before, { timeoutMs: 2500 })
          const norm = (s) => String(s).replace(/\r\n/g, '\n').trim()
          if (got === null) notes.push('校验：读不到剪贴板，无法确认是否打全')
          else if (norm(got) === norm(text)) notes.push(`校验通过：读回 ${norm(got).length} 字，与原文一致`)
          else if (got === before) notes.push(`校验不一致：读回 ${norm(got).length} 字 / 期望 ${norm(text).length} 字（读回内容与校验前的剪贴板一样：Ctrl+A/Ctrl+C 可能没送进目标程序）`)
          else notes.push(`校验不一致：读回 ${norm(got).length} 字 / 期望 ${norm(text).length} 字（可能丢字或被输入框截断）`)
        } finally {
          if (before !== null && before !== undefined) { try { writeClipboard(before) } catch { /* best effort */ } }
        }
      }
      break
    }
    case 'key': {
      if (!args.key) throw new Error('key 需要 key 名')
      const count = args.count ?? 1
      pressKey(args.key, { count })
      notes.push(`按了 ${args.key}${count > 1 ? ` × ${count}` : ''}`)
      break
    }
    case 'hotkey': {
      if (!args.keys) throw new Error('hotkey 需要 keys')
      hotkey(args.keys)
      notes.push(`按了组合键 ${args.keys}`)
      break
    }
    case 'open': {
      if (!args.app) throw new Error('open 需要 app')
      // ShellExecute, not cmd: a URL must reach the default browser instead of being run
      // as a shell command (which silently fails and still reports a pid).
      const spec = splitAppSpec(args.app)
      if (!spec) throw new Error('open 需要 app')
      const launched = shellOpen(spec.file, spec.params)
      notes.push(launched.ok
        ? `打开了 ${spec.file}${spec.params ? ` ${spec.params}` : ''}（由系统默认程序处理）`
        : `打开失败：${spec.file}（ShellExecute 返回 ${launched.code}${launched.error ? `，${launched.error}` : ''}）`)
      break
    }
    case 'close': {
      if (!target) throw new Error('close 需要 window')
      const ok = closeWindow(target.handle)
      notes.push(`${ok ? '已请求关闭' : '关闭请求失败'}：${target.title || target.handle}`)
      break
    }
    default:
      throw new Error(`未知动作：${action}`)
  }
  return notes
}

/** Resolve a step's target point: explicit screen pixels, or pixels of the current screenshot. */
function pointOf(args) {
  if (args.imageX !== undefined && args.imageY !== undefined) {
    const shot = state.lastShot
    if (!shot) throw new Error('还没有截图可以参照：先 screen_look 截一张，再用 imageX/imageY')
    return { x: shot.origin.x + args.imageX * shot.scaleX, y: shot.origin.y + args.imageY * shot.scaleY }
  }
  if (args.x !== undefined && args.y !== undefined) return { x: args.x, y: args.y }
  return null
}

/** How stale the last look may be before the hands are refused, in ms. */
function staleAfterMs(config) {
  const seconds = config.requireFreshLookSeconds ?? 120
  // 0 means 'no freshness check', not 'zero milliseconds'.
  return seconds > 0 ? seconds * 1000 : Infinity
}

/** One human-readable line for a planned step. */
function summarizeStep(step = {}) {
  const at = step.imageX !== undefined && step.imageY !== undefined
    ? `图内(${step.imageX},${step.imageY})`
    : step.x !== undefined && step.y !== undefined ? `(${step.x},${step.y})` : ''
  const where = step.window ? `${step.window} · ` : ''
  switch (step.action) {
    case 'click':
    case 'double_click':
    case 'right_click': return `${where}${step.action} @ ${at}${step.button ? ` ${step.button}` : ''}`
    case 'move': return `${where}move → ${at}`
    case 'drag': return `${where}drag ${at} → (${step.toX},${step.toY})`
    case 'scroll': return `${where}scroll ${at} dy=${step.deltaY ?? 0}`
    case 'type': return `${where}type ${JSON.stringify(String(step.text ?? '').slice(0, 40))}`
    case 'key': return `${where}key ${step.key}${step.count ? ` ×${step.count}` : ''}`
    case 'hotkey': return `${where}hotkey ${step.keys}`
    case 'open': return `open ${step.app}（敏感）`
    case 'close': return `${where}close（敏感）`
    default: return `${where}${step.action || '?'}`
  }
}

/** Collapse a multi-line refusal into one line so it fits inside a preview report. */
function oneLine(value) {
  return String(value ?? '').replace(/\s*\n+\s*/g, ' ').trim()
}

/**
 * Read-only: where the human authorisation stands right now. Mirrors policy.check for the
 * report, but never opens, renews or spends an authorisation window.
 */
function armDetail(config, action) {
  if (config.armRequired === false) return 'armRequired=false，不需要授权窗口'
  if (!WRITE_ACTIONS.has(String(action))) return '这个动作不受授权闸门管（纯移动/只读）'
  const scope = readControlScope()
  if (scope !== null) {
    const left = Math.max(0, Math.round((scope.armedUntil - Date.now()) / 1000))
    return scope.armed ? `core gate 已授权 control，剩 ${left}s` : 'core gate 当前没有 control 授权'
  }
  const st = readPolicyState(config)
  const left = Math.round((st.armedUntil - Date.now()) / 1000)
  return left > 0 ? `旧 arm.json 授权，剩 ${left}s` : '旧 arm.json 没有有效授权'
}

/**
 * The same guards the executor applies, as a verdict instead of an exception, so a preview
 * can report them. Keep it in step with performAction: a mismatch can only make the preview
 * less accurate, never less safe.
 * @returns {string|null} problem, or null when the arguments look usable
 */
function validateActionArgs(action, args, point) {
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
      return point ? null : `${action} 需要 x/y 或 imageX/imageY`
    case 'drag':
      return point && args.toX !== undefined && args.toY !== undefined ? null : 'drag 需要起点 x/y 和终点 toX/toY'
    case 'scroll':
      return null
    case 'type':
      return typeof args.text === 'string' ? null : 'type 需要 text'
    case 'key':
      return args.key ? null : 'key 需要 key 名'
    case 'hotkey':
      return args.keys ? null : 'hotkey 需要 keys'
    case 'open':
      return args.app ? null : 'open 需要 app'
    case 'close':
      return null
    default:
      return `未知动作：${action}`
  }
}

/** One line saying what the real step would do — describing it, never doing it. */
function plannedActionText(action, args, config, { point, target } = {}) {
  const at = point ? `(${Math.round(point.x)},${Math.round(point.y)})` : ''
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const button = args.button ?? (action === 'right_click' ? 'right' : 'left')
      const count = args.count ?? (action === 'double_click' ? 2 : 1)
      return `会在 ${at} 用 ${button} 键点 ${count} 次`
    }
    case 'move':
      return `会把鼠标移到 ${at}`
    case 'drag':
      return `会从 ${at} 拖到 (${args.toX},${args.toY})`
    case 'scroll':
      return `会在 ${at || '当前光标处'} 滚动 dx=${args.deltaX ?? 0} dy=${args.deltaY ?? 0}`
    case 'type': {
      const value = String(args.text ?? '')
      const pasteAt = Number(config.typePasteThreshold ?? 0)
      const method = pasteAt > 0 && value.length >= pasteAt ? '剪贴板粘贴（借用剪贴板后还原）' : 'Unicode 注入'
      const verify = args.verifyText === true ? '，打完读回校验（Ctrl+A/C 会临时占用剪贴板）' : ''
      return `会输入 ${value.length} 个字符（${method}${verify}）：${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`
    }
    case 'key':
      return `会按 ${args.key}${(args.count ?? 1) > 1 ? ` × ${args.count}` : ''}`
    case 'hotkey':
      return `会按组合键 ${args.keys}`
    case 'open':
      return `会启动 ${args.app}（敏感动作）`
    case 'close':
      return `会请求关闭「${target?.title || target?.handle || '?'}」（敏感动作）`
    default:
      return `${action}`
  }
}

/**
 * Read-only look at a control: measure it and say what the real step would do with it.
 * Unlike uiaStep this never invokes, assigns or focuses anything — a dry run must not write.
 * @returns {Promise<{lines:string[], blockers:string[], point?:object}>}
 */
async function previewUiaStep(step, target) {
  const path = String(step.control).trim()
  const handle = target?.handle ?? foregroundWindow()?.handle
  if (!handle) return { lines: [], blockers: ['UIA 控件：前台没有窗口，也没指定 window（正式执行会报同样的错）'] }
  let read
  try {
    read = await uia({ action: 'rect', handle, path }, { timeoutMs: 20000 })
  } catch (error) {
    return { lines: [], blockers: [`UIA 控件：读不到 ${path}（${oneLine(error?.message)}）`] }
  }
  if (!read.ok) return { lines: [], blockers: [`UIA 控件：窗口里找不到控件 ${path}（${read.error ?? '未知原因'}）`] }
  const element = read.element ?? {}
  const patterns = Array.isArray(element.patterns) ? element.patterns : []
  const point = centerOf(element.rect)
  const label = `控件 ${path}${element.name ? `「${element.name}」` : ''}`
  const lines = [`UIA 控件：${label} ${formatRect(element.rect)} · 模式 ${patterns.join(',') || '无'}（预演只量位置，不动它）`]
  if (step.action === 'type') {
    if (patterns.includes('value') && !element.meta?.readonly) {
      lines.push(`UIA 控件：正式执行会直接给${label}赋值（setvalue，不碰键盘）`)
    } else if (point) {
      lines.push(`UIA 控件：${label} 不能赋值，正式执行会先点中心 (${point.x},${point.y}) 聚焦，再注入文字`)
    } else {
      return { lines, blockers: [`UIA 控件：${label} 既不能赋值也没有可点的矩形，正式执行会报错`] }
    }
    return { lines, blockers: [], point: point ?? undefined }
  }
  if (step.action === 'click' || step.action === 'double_click') {
    const how = step.how ?? (patterns.includes('invoke') ? 'invoke' : 'click')
    if (how === 'invoke' && patterns.includes('invoke')) {
      lines.push(`UIA 控件：正式执行会用 UIA 直接按${label}（invoke，不动鼠标）`)
    } else if (point) {
      lines.push(`UIA 控件：正式执行会点${label}的中心 (${point.x},${point.y})`)
    } else {
      return { lines, blockers: [`UIA 控件：${label} 没有可点的矩形，正式执行会报错`] }
    }
  }
  return { lines, blockers: [], point: point ?? undefined }
}

/**
 * The read-only rehearsal shared by screen_act (one step) and screen_sequence (a batch).
 *
 * It runs every pre-check the real call would run and reports the outcome instead of
 * throwing. It must stay on read-only helpers: no injection, no cursor move, no focus,
 * no screenshot, no authorisation spent. The two injection entry points (uiaStep and
 * performAction) also refuse a step carrying dryRun, so a future routing mistake cannot
 * turn a rehearsal into a real click.
 *
 * @returns {Promise<{lines:string[], blockers:string[], point?:object, target?:object}>}
 */
async function previewOneStep(step, { config, target: batchTarget = null, confirmed = undefined } = {}) {
  const args = step ?? {}
  const action = args.action
  const effective = confirmed === undefined ? args : { ...args, confirmed: args.confirmed ?? confirmed }
  const lines = []
  const blockers = []

  // ① 人类授权闸门（只读：读 gate.json / arm.json，不开窗口、不消耗）
  const armRefusal = policyCheck(action, effective, config)
  if (armRefusal) blockers.push(`人类授权闸门：会被拒绝 — ${oneLine(armRefusal)}`)
  else lines.push(`人类授权闸门：通过（${armDetail(config, action)}）`)

  // ② 安全闸：敏感动作要 confirmed
  const refusal = gate(action, effective, config)
  if (refusal) blockers.push(`安全闸：会被拒绝 — ${oneLine(refusal)}`)
  else lines.push('安全闸：通过（不需要 confirmed，或已经给了 confirmed: true）')

  // ③ 目标窗口：只解析标题/handle，不切前台
  let target = batchTarget
  if (args.window) {
    try {
      target = resolveWindow(args.window)
      lines.push(`目标窗口：${target.title || `handle=${target.handle}`} handle=${target.handle}（正式执行会先切前台，预演不切）`)
    } catch (error) {
      blockers.push(`目标窗口：找不到 — ${oneLine(error?.message)}`)
    }
  }
  if (action === 'close' && !target) blockers.push('参数：close 需要 window（或者整批给 window）')

  // ④ 拒绝清单
  const denyTarget = action === 'open'
    ? (() => { const spec = splitAppSpec(args.app); return spec ? { process: spec.file } : null })()
    : action === 'close' ? { title: target?.title } : null
  if (denyTarget) {
    const hit = matchDeny(denyTarget)
    if (hit) blockers.push(`拒绝清单：命中共享名单 [${hit.group}/${hit.label}] ${hit.rule}，正式执行会拒绝`)
    else lines.push('拒绝清单：未命中共享名单')
  } else if (action === 'click' || action === 'double_click' || action === 'right_click') {
    lines.push('拒绝清单：点击落点窗口由宿主 gate 在执行时校验，预演不预判')
  } else {
    lines.push(`拒绝清单：${action} 不走共享名单机检`)
  }

  // ⑤ 坐标解析（imageX/imageY 需要上一张截图，纯读）
  let point = null
  try {
    point = pointOf(args)
    if (point) lines.push(`坐标：(${Math.round(point.x)},${Math.round(point.y)})${args.imageX !== undefined ? '（按上一张截图换算）' : ''}`)
  } catch (error) {
    blockers.push(`坐标：${oneLine(error?.message)}`)
  }

  // ⑥ 参数合法性（与 performAction 的守卫对齐）
  const bad = validateActionArgs(action, args, point)
  if (bad) blockers.push(`参数：${bad}`)
  else lines.push('参数：合法')

  // ⑦ UIA 控件只读探测（不 invoke、不 setvalue、不聚焦）
  if (args.control) {
    const probed = await previewUiaStep(args, target)
    lines.push(...(probed.lines ?? []))
    blockers.push(...(probed.blockers ?? []))
    if (probed.point) point = probed.point
  }

  return { lines, blockers, point: point ?? undefined, target }
}

/**
 * @param {{get(name:string):any}} ctx plugin context
 * @param {object} config resolved plugin config
 * @returns {Array} tools ready for ctx.tools.register
 */
export function createTools(ctx, config) {
  const look = defineTool({
    name: 'screen_look',
    description: [
      '看主人的 Windows 桌面。默认 mode=auto：先去读这个窗口的 UI Automation 控件清单——',
      '控件够用就只回一张文字清单（每个控件的中心坐标、路径、该怎么操作），**完全不截图**，省下读图的时间和 token；',
      '控件太少（游戏、自绘界面、Chromium 页面这类不暴露 UIA 的）才乖乖截图。',
      'mode=pixels 强制截图；mode=uia 强制只看控件清单。',
      '截图本身要用 read_image 打开返回的 path 才能看见内容。',
      '动手之前先 look 一眼，这是本插件的规矩。',
    ].join(''),
    parameters: {
      window: { type: 'string', description: '窗口标题片段或 handle；省略就是前台窗口。' },
      gridCols: { type: 'number', description: 'grid 模式的列数（默认 8，2..12）。' },
      gridRows: { type: 'number', description: 'grid 模式的行数（默认 5，2..8）。' },
      zoom: { type: 'number', description: '局部放大倍数（1..6）：配合 region 先截一小块再放大，看小字用。' },
      monitor: { type: 'number', description: '只截第几块显示器（1 起，多屏用）。省略=整个虚拟桌面。' },
      mode: {
        type: 'string',
        enum: ['auto', 'uia', 'pixels', 'grid'],
        description: 'auto（默认）有 UIA 就走文字清单，没有才截图；uia 只读控件；pixels 只截图；grid 截图并叠加晶格，返回 A1..H5 编号供 screen_act 的 grid 参数直接用。',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description: '只截一块区域，物理像素坐标（仅 pixels 模式）。',
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
      },
      maxNodes: { type: 'number', description: 'UIA 最多读多少个节点（默认 160）。' },
      maxWidth: { type: 'number', description: '图片最大宽度（默认 1600，越小越省 token）。' },
      maxHeight: { type: 'number', description: '图片最大高度（默认 1200）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, description: 'uia 或 pixels：这次走的是哪条路' },
          path: { type: 'string', description: '截图路径（只有 pixels 模式才有）' },
          imageWidth: { type: 'number' },
          imageHeight: { type: 'number' },
          sourceWidth: { type: 'number' },
          sourceHeight: { type: 'number' },
          originX: { type: 'number' },
          originY: { type: 'number' },
          scaleX: { type: 'number' },
          scaleY: { type: 'number' },
          controls: { type: 'number', description: 'UIA 给出多少个可操作控件' },
          foreground: { type: 'string' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.path ? `${value.summary}\n\n用 read_image 打开这张图：${value.path}` : value.summary,
      }],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const target = resolveWindow(args.window)
      const mode = args.mode ?? 'auto'
      const desk = describeDesktop({ maxWindows: args.window ? 3 : 12 })
      const handle = target?.handle ?? desk.foreground?.handle
      const winTitle = target?.title
        || desk.windows.find(w => w.handle === handle)?.title
        || listWindows().find(w => w.handle === handle)?.title
        || (handle ? `handle=${handle}` : '前台窗口')
      let fallbackReason = ''
      let seenControls = 0

      const gridSpec = mode === 'grid' ? { cols: Math.min(12, Math.max(2, args.gridCols ?? 8)), rows: Math.min(8, Math.max(2, args.gridRows ?? 5)) } : null
      if (mode !== 'pixels' && !gridSpec && handle) {
        let view = null
        try {
          view = await uiaView({ handle }, { maxNodes: args.maxNodes ?? 160 })
        } catch (error) {
          fallbackReason = `UIA 读不了这个窗口：${error.message}`
        }
        const count = view?.controls.length ?? 0
        seenControls = count
        if (view && count >= (config.uiaMinControls ?? 3)) {
          // Knowledge is fresh, but there is no image to anchor imageX/imageY against.
          state.lastLookAt = Date.now()
          state.lastShot = null
          const head = `没截图——「${winTitle}」的 UIA 够用：${count} 个可操作控件，照这张清单直接干活`
          return {
            mode: 'uia',
            controls: count,
            foreground: desk.foreground?.title ?? '',
            summary: [
              head,
              controlLines(view, { title: winTitle }),
              view.truncated ? '（树被截断了，只列了前一部分）' : '',
              '坐标是屏幕物理像素，可以直接喂 screen_act 的 x/y；也可以把第二列的 path 当 control 传给 screen_act / screen_sequence，本鱼动手时会重新量它的位置。',
            ].filter(Boolean).join('\n'),
          }
        }
        if (mode === 'uia') {
          return {
            mode: 'uia',
            controls: count,
            foreground: desk.foreground?.title ?? '',
            summary: `「${winTitle}」没有可用的 UIA 控件（${count} 个）。这个程序大概得靠截图——用 screen_look mode=pixels。`,
          }
        }
        fallbackReason = fallbackReason || `UIA 只给出 ${count} 个可操作控件`
        if (view && count === 0 && view.nodes.length > 1) {
          // Nodes exist but none is usable: usually they are behind another window, which
          // is worth saying out loud — the fix is to raise the window, not to squint at a picture.
          fallbackReason += `（读到 ${view.nodes.length} 个节点，但都被挡住或不可操作——把窗口切前台再看会更准）`
        }
      }

      let region = args.region
      let monitorInfo = ''
      if (args.monitor) {
        const monitors = listMonitors()
        const pick = monitors[Math.max(1, Math.round(args.monitor)) - 1]
        if (!pick) return `⛔ 没有第 ${args.monitor} 块显示器（共 ${monitors.length} 块）。`
        region = { x: pick.x, y: pick.y, width: pick.width, height: pick.height }
        monitorInfo = `显示器 ${args.monitor}/${monitors.length}（${pick.width}x${pick.height} @ ${pick.x},${pick.y}）`
      }
      const shot = grab({
        dir: config.shotDir,
        window: target?.handle,
        region,
        maxWidth: args.maxWidth ?? 1600,
        maxHeight: args.maxHeight ?? 1200,
        grid: gridSpec || undefined,
        zoom: args.zoom,
        name: 'look',
      })
      state.lastShot = { ...shot, at: Date.now() }
      state.lastLookAt = Date.now()
      state.imageCount = (state.imageCount ?? 0) + 1
      const imageBudget = Number(config.imageBudget ?? 0)
      const budgetNote = imageBudget > 0 ? `本轮第 ${state.imageCount} 张（软预算 ${imageBudget}，只提示不拦截）` : ''
      let gridText = ''
      if (gridSpec) {
        state.lastGrid = {
          cols: gridSpec.cols, rows: gridSpec.rows,
          originX: shot.origin.x, originY: shot.origin.y,
          sourceWidth: shot.sourceWidth, sourceHeight: shot.sourceHeight,
          at: Date.now(),
        }
        const colsLabels = Array.from({ length: gridSpec.cols }, (_, i) => String.fromCharCode(65 + i))
        const rows2 = Array.from({ length: gridSpec.rows }, (_, i) => i + 1)
        const cw = shot.sourceWidth / gridSpec.cols
        const ch = shot.sourceHeight / gridSpec.rows
        const cells = []
        for (const r of rows2) {
          for (let ci = 0; ci < colsLabels.length; ci++) {
            const x = Math.round(shot.origin.x + (ci + 0.5) * cw)
            const y = Math.round(shot.origin.y + (r - 0.5) * ch)
            cells.push(`${colsLabels[ci]}${r}:(${x},${y})`)
          }
        }
        gridText = [
          `晶格 ${gridSpec.cols}x${gridSpec.rows}（列 ${colsLabels.join('')}，行 1-${gridSpec.rows}），每格中心坐标：`,
          cells.join('  '),
          '点格子用 screen_act {action:"click", grid:"C3"}；格子坐标是屏幕物理像素，行/列从左上数。',
        ].join('\n')
      }
      return {
        mode: 'pixels',
        path: shot.path,
        controls: seenControls,
        imageWidth: shot.imageWidth,
        imageHeight: shot.imageHeight,
        sourceWidth: shot.sourceWidth,
        sourceHeight: shot.sourceHeight,
        originX: shot.origin.x,
        originY: shot.origin.y,
        scaleX: shot.scaleX,
        scaleY: shot.scaleY,
        foreground: desk.foreground?.title ?? '',
        summary: [
          `${shot.label} 已截取（${Math.round(shot.bytes / 1024)} KB）`,
          fallbackReason ? `为什么走截图：${fallbackReason}` : '',
          windowLines(desk),
          coordHint(shot),
          monitorInfo,
          budgetNote,
          Number(args.zoom) > 1 ? `已放大 x${Math.round(Number(args.zoom))}（小字靠它看清）` : '',
          gridText,
        ].filter(Boolean).join('\n'),
      }
    },
  })

  const windows = defineTool({
    name: 'screen_windows',
    description: '列出当前所有可见窗口：标题、窗口类、handle、位置大小、是否最小化、是否在前台。想找某个窗口的 handle 就用它。',
    parameters: {},
    output: text,
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute() {
      const desk = describeDesktop({ maxWindows: 60 })
      return windowLines(desk)
    },
  })

  const focus = defineTool({
    name: 'screen_focus',
    description: '把某个窗口切到前台（最小化的会先还原）。键盘输入只会送到前台窗口，所以要先 focus 再打字。',
    parameters: { window: { type: 'string', required: true, description: '窗口标题片段或 handle。' } },
    output: text,
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = resolveWindow(args.window)
      if (!target) throw new Error('screen_focus 需要一个窗口')
      const ok = focusWindow(target.handle)
      const fg = foregroundWindow()
      if (!ok) {
        return `切前台失败：handle=${target.handle}「${target.title || '未命名'}」没能上前台。\n`
          + `当前前台：${fg ? `${fg.title || '(无标题)'} handle=${fg.handle}` : '无'}\n`
          + '系统的前台锁挡住了这次切换（常见于刚启动的程序或别的程序正抢焦点）。重试一次通常就好了；'
          + '还是不行的话，手动点一下那个窗口也可以。'
      }
      return `已切到前台：handle=${target.handle}「${target.title || '未命名'}」\n当前前台：${fg ? `${fg.title} handle=${fg.handle}` : '无'}（已核实是它本人）`
    },
  })

  const uiaTool = defineTool({
    name: 'screen_uia',
    description: [
      '读一个窗口的 UI 自动化（UIA）控件树，或者按控件操作——比盲点鼠标稳得多，而且不需要窗口在前台。',
      'action=tree 拿控件树（每个节点有 path、类型、名字、坐标、可用模式）；action=find 按名字/类型/id 找控件；',
      'action=rect 按 path 取单个控件当下的位置和状态（最轻，点它之前用它量一次）；',
      'action=invoke 点按钮、setvalue 填输入框、getvalue 读输入框、select 选中列表项、focus 聚焦。',
      'path 用 tree 返回的路径字符串（如 0/2/1/1），只在这个窗口内有效。',
    ].join(''),
    parameters: {
      window: { type: 'string', description: '窗口标题片段或 handle；省略就是当前前台窗口。' },
      action: { type: 'string', enum: ['window', 'tree', 'rect', 'find', 'invoke', 'setvalue', 'getvalue', 'select', 'focus'], required: true },
      path: { type: 'string', description: 'tree 返回的控件路径，如 0/3/1/1/1。' },
      name: { type: 'string', description: '按控件名字找（find/invoke/setvalue 等）。' },
      automationId: { type: 'string', description: 'find：按 AutomationId 找。' },
      className: { type: 'string', description: 'find：按窗口类名找。' },
      controlType: { type: 'string', description: 'find：按控件类型找，如 Button、Edit、MenuItem。' },
      value: { type: 'string', description: 'setvalue 要写入的文本。' },
      maxDepth: { type: 'number', description: 'tree 最大深度，默认 6。' },
      maxNodes: { type: 'number', description: 'tree 最大节点数，默认 400。' },
      onlyNamed: { type: 'boolean', description: 'tree 只返回有名字或有可用模式的节点（推荐 true，省 token）。' },
    },
    output: text,
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const target = args.window ? resolveWindow(args.window) : null
      const request = {
        action: args.action,
        ...(target ? { handle: target.handle } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.automationId !== undefined ? { automationId: args.automationId } : {}),
        ...(args.className !== undefined ? { className: args.className } : {}),
        ...(args.controlType !== undefined ? { controlType: args.controlType } : {}),
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        ...(args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {}),
        ...(args.onlyNamed !== undefined ? { onlyNamed: args.onlyNamed } : {}),
      }
      const result = await uia(request, { timeoutMs: 55000 })
      if (!result.ok) throw new Error(`UIA ${args.action} 失败：${result.error}`)

      if (args.action === 'tree') {
        const lines = [`UIA 控件树：${result.count} 个节点${result.truncated ? '（已截断）' : ''}`]
        for (const n of result.nodes ?? []) {
          const patterns = Array.isArray(n.patterns) ? n.patterns.join(',') : ''
          const rect = n.rect ? `@${n.rect.x},${n.rect.y} ${n.rect.width}x${n.rect.height}` : ''
          lines.push(`${String(n.path).padEnd(12)} ${String(n.type).padEnd(16)} ${JSON.stringify(n.name ?? '')} ${patterns ? `[${patterns}]` : ''} ${rect}`)
        }
        return lines.join('\n')
      }
      if (args.action === 'find') {
        const lines = [`找到 ${result.count} 个匹配控件`]
        for (const n of result.matches ?? []) {
          const rect = n.rect ? `@${n.rect.x},${n.rect.y} ${n.rect.width}x${n.rect.height}` : ''
          lines.push(`${String(n.type).padEnd(16)} ${JSON.stringify(n.name ?? '')} id=${n.automationId || '-'} ${rect}`)
        }
        return lines.join('\n')
      }
      if (args.action === 'window') {
        const r = result.root
        return `窗口：${JSON.stringify(r.name)} 类型=${r.type} 位置=${r.rect ? `${r.rect.width}x${r.rect.height}@${r.rect.x},${r.rect.y}` : '未知'} 可用模式=${(r.patterns ?? []).join(',') || '无'}`
      }
      return `UIA ${args.action} 完成${result.value !== undefined ? `，当前值：${JSON.stringify(result.value)}` : ''}${result.invoked ? `，控件：${JSON.stringify(result.invoked.name ?? '')}` : ''}`
    },
  })

  const act = defineTool({
    name: 'screen_act',
    description: [
      '在 Windows 桌面上动手：点鼠标、拖拽、滚轮、打字、按快捷键、启动或关闭程序。',
      '坐标是物理屏幕像素；也可以传 imageX/imageY，按上一张 screen_look 截图里的像素来点，插件自己换算。',
      '动手前先 screen_look 看一眼；能点控件就优先用 screen_uia 的 invoke/setvalue，比坐标点击稳。',
      '敏感动作（启动程序、关闭窗口、Alt+F4、Win 键组合）会被安全闸拦下，需要先问主人、再带 confirmed: true 重调。',
      '执行完默认自动再截一张图，省得你再 look 一次（observe: false 可以关掉）。',
      '不确定会打到哪儿、会不会被拦时带 dryRun: true —— 只预演，解析目标窗口/控件/坐标并报告放行还是拒绝，不注入、不移动、不按键、不截图、不消耗授权。',
    ].join(''),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'hotkey', 'open', 'close'],
        description: '要做的动作。',
      },
      window: { type: 'string', description: '动作前先把这个窗口切到前台（标题片段或 handle）。' },
      x: { type: 'number', description: '物理屏幕 x 坐标（click/move/drag/scroll）。' },
      y: { type: 'number', description: '物理屏幕 y 坐标。' },
      imageX: { type: 'number', description: '按上一张截图的像素 x 来定位。' },
      imageY: { type: 'number', description: '按上一张截图的像素 y 来定位。' },
      control: { type: 'string', description: '按 UIA 控件路径定位（screen_look / screen_uia 给的 path，如 0/2/1）。给了它 x/y 就忽略；动作时会重新量控件的位置，支持 Invoke 的按钮直接用 UIA 按下去，不点鼠标。' },
      how: { type: 'string', enum: ['click', 'invoke'], description: 'control 怎么驱动：invoke 用 UIA 直接触发（默认，控件支持的话），click 走鼠标点它的中心。' },
      toX: { type: 'number', description: 'drag 终点 x。' },
      toY: { type: 'number', description: 'drag 终点 y。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
      count: { type: 'number', description: '点击次数，默认 1。' },
      deltaY: { type: 'number', description: '滚轮纵向滚动量（正数向下，120 为一格）。' },
      deltaX: { type: 'number', description: '滚轮横向滚动量。' },
      text: { type: 'string', description: 'type 要输入的文本（支持中文，走 Unicode 注入，不依赖输入法）。' },
      key: { type: 'string', description: 'key 要按的键名，如 enter、tab、esc、f5、ctrl 等。' },
      keys: { type: 'string', description: 'hotkey 组合键，如 "ctrl+s"、"alt+tab"。' },
      app: { type: 'string', description: 'open 要启动的程序路径或命令。' },
      grid: { type: 'string', description: '晶格编号（如 C3）：配合 screen_look mode=grid，优先于 x/y，直接点该格中心。' },
      confirmed: { type: 'boolean', description: '敏感动作：主人已经点头了，才传 true。' },
      observe: { type: 'boolean', description: '动作后是否自动截图，默认 true（move 默认不截）。' },
      verifyText: { type: 'boolean', description: 'type 专用：打完读回校验（Ctrl+A/C 复制比对，会短暂占用剪贴板）。' },
      settleMs: { type: 'number', description: '截图前等画面重绘的毫秒数，默认取配置 settleMs。' },
      dryRun: { type: 'boolean', description: '只预演：解析目标窗口/控件/坐标、报告是否会放行/拒绝，不注入、不移动、不按键、不截图、不消耗授权（也不要求 arm）' },
    },
    output: text,
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const args = { ...rawArgs }
      const dryRun = args.dryRun === true
      const requestedGrid = args.grid ? String(args.grid).trim().toUpperCase() : ''
      if (args.grid) {
        const g = state.lastGrid
        if (!g) return '⛔ 先用 screen_look mode=grid 拿一张带晶格的图，再用 grid 编号点击。'
        const m2 = String(args.grid).trim().toUpperCase().match(/^([A-L])([1-8])$/)
        if (!m2) return '⛔ 晶格编号无效：形如 C3（列 A..L + 行 1..8）。'
        const ci = m2[1].charCodeAt(0) - 65
        const ri = Number(m2[2]) - 1
        if (ci >= g.cols || ri >= g.rows) return `⛔ 晶格编号越界：当前是 ${g.cols}x${g.rows}。`
        args.x = Math.round(g.originX + (ci + 0.5) * (g.sourceWidth / g.cols))
        args.y = Math.round(g.originY + (ri + 0.5) * (g.sourceHeight / g.rows))
        delete args.grid
      }
      // dryRun: rehearse every check and report, but never inject, move the cursor, swap the
      // foreground window, screenshot or spend an authorisation window. Deliberately placed
      // before the arm/safety/focus/overlay steps so a rehearsal asks for nothing.
      if (dryRun) {
        const pre = await previewOneStep(args, { config })
        const lines = [...pre.lines]
        const blockers = [...pre.blockers]

        // "Look before you touch" — report the same precondition the real call enforces.
        if (args.action !== 'move' && !args.control) {
          const age = state.lastLookAt ? Date.now() - state.lastLookAt : Infinity
          if (age > staleAfterMs(config)) {
            blockers.push(`观察新鲜度：会被拒绝 — ${state.lastLookAt ? `上一次观察是 ${Math.round(age / 1000)} 秒前` : '还没看过屏幕'}，正式执行要求 ${config.requireFreshLookSeconds ?? 120} 秒内看过`)
          } else {
            lines.push(`观察新鲜度：通过（${age < 1000 ? '刚看过屏幕' : `${Math.round(age / 1000)} 秒前看过屏幕`}）`)
          }
        } else {
          lines.push('观察新鲜度：不检查（move 或带 control 的动作不受这条限制）')
        }
        if (escPressed(config, state.ignoreEscUntil)) blockers.push('Esc 停止：主人正按着 Esc，正式执行会被取消')
        else lines.push('Esc 停止：未按下')
        const stop = readStop()
        if (stop && stop.level === 'hard') blockers.push(`停止信号：hard（${stop.by || '未知'}）正在，正式执行会立即断`)
        else if (stop && stop.level === 'soft') lines.push(`停止信号：soft（${stop.by || '未知'}），正式执行会在步边界停`)
        else lines.push('停止信号：无')

        const wantsObserve = args.observe ?? (args.action !== 'move')
        // A rehearsal is recorded as a rehearsal: never as an "allow" (no execution happened).
        policyAuditSafe({
          kind: 'dry-run',
          tool: 'screen_act',
          action: args.action,
          control: args.control ?? null,
          x: args.x ?? null,
          y: args.y ?? null,
          grid: requestedGrid || null,
          reason: blockers.length ? 'would-refuse' : 'ok',
          outcome: 'not-executed',
        }, config)

        const plan = plannedActionText(args.action, args, config, { point: pre.point, target: pre.target })
        const head = [
          `dryRun（预演：未执行任何输入、未移动鼠标、未按键、未截图、不消耗授权）: screen_act ${args.action}${requestedGrid ? `（晶格 ${requestedGrid} → (${args.x},${args.y})）` : ''}`,
          `计划：${plan}`,
          `动作后截图：${wantsObserve === false ? '正式执行也不截（observe=false）' : '正式执行会截一张（预演不截）'}`,
        ]
        const verdict = blockers.length
          ? [`预演结论：正式执行会被拒绝（${blockers.length} 处），本次什么都没动：`, ...blockers.map((b, i) => `  ${i + 1}. ⛔ ${b}`)]
          : ['预演结论：预计可以执行（正式执行仍会请求人类授权，并真的注入输入）。']
        return [
          head.join('\n'),
          '预检：',
          ...lines.map(line => `  ✓ ${line}`),
          ...verdict,
          '说明：这是预演——一个输入都没发；要真动手就别带 dryRun 重发。',
        ].join('\n')
      }
      const armRefusal = policyCheck(args.action, args, config)
      if (armRefusal) {
        policyAuditSafe({ kind: 'deny', tool: 'screen_act', action: args.action, reason: 'not-armed' }, config)
        return `⛔ 人类授权闸门拦下：${armRefusal}`
      }
      const refusal = gate(args.action, args, config)
      if (refusal) return `⛔ 安全闸拦下：${refusal}`
      policyAuditSafe({ kind: 'allow', tool: 'screen_act', action: args.action, control: args.control ?? null, x: args.x ?? null, y: args.y ?? null, grid: args.grid ?? null }, config)

      const action = args.action
      // "Look before you touch": a stale or missing look means the agent is guessing.
      // A control path is exempt — it gets re-measured at action time, so it cannot drift.
      if (action !== 'move' && !args.control) {
        const age = state.lastLookAt ? Date.now() - state.lastLookAt : Infinity
        if (age > staleAfterMs(config)) {
          return `⛔ 先看一眼再动手：${state.lastLookAt ? `上一次观察已经是 ${Math.round(age / 1000)} 秒前的了` : '还没看过屏幕'}。`
            + '调用 screen_look（有 UIA 就回控件清单，没有才截图），然后再动手。'
        }
      }

      const point = pointOf(args)

      let target = null
      if (args.window) {
        target = resolveWindow(args.window)
        const focused = focusWindow(target.handle)
        if (!focused) {
          // Never click into whatever happens to be in front: that is how a stray click
          // lands in the wrong app. Refuse and say what the foreground actually is.
          const fg = foregroundWindow()
          return `⛔ 切不到前台，这一下没发出去：想让「${target.title || target.handle}」上前台，但前台还留在「${fg?.title || '(未知窗口)'}」`
            + `（handle=${fg?.handle ?? '无'}）。系统拒绝了这次前台切换，所以本鱼一个点击、一个按键都没发——`
            + '宁可不动，也不能点到别的窗口上去。可以手动把它点上前台，或者让主人再试一次。'
        }
      }

      // Light up the "I am driving" pill, and honour the brake before anything is sent.
      if (escPressed(config, state.ignoreEscUntil)) {
        return '⛔ 主人按了 Esc，这一下没发出去（Esc 取消是配置里开着的）。'
      }
      showDriving(config)

      const driven = await uiaStep(args, target)
      let notes
      if (driven?.handled) {
        notes = [...driven.notes]
      } else {
        notes = performAction(action, args, config, { point: driven?.point ?? point, target })
        if (driven?.notes?.length) notes.unshift(...driven.notes)
      }
      const fg = foregroundWindow()
      notes.push(`当前前台：${fg ? `${fg.title} handle=${fg.handle}` : '无'}`)
      // Our own Esc must not look like the user's brake on the next step.
      if (action === 'key' && String(args.key ?? '').toLowerCase() === 'esc') {
        state.ignoreEscUntil = Date.now() + 600
      }

      // A move changes nothing anyone can see, so it does not pay for a frame by default.
      const wantsObserve = args.observe ?? (action !== 'move')
      if (wantsObserve === false) return notes.join('\n')
      const observed = observe(config, { settleMs: args.settleMs })
      return `${notes.join('\n')}\n\n${observed.text}`
    },
  })

  const sequence = defineTool({
    name: 'screen_sequence',
    description: [
      '一次调用跑完一整串动作（切窗口 → 点输入框 → 打字 → 回车 → 看结果），只回一次、只截一张图。',
      '省的不是点击速度，是「你和电脑来回说多少次话」：五步任务从五次往返变成一次。',
      'steps 每一步的字段和 screen_act 一样（action 必填），但不用写 observe。',
      '每步也可以只给 control（UIA 控件路径）：本鱼会在动作那一刻重新量它的位置——',
      'type 直接给输入框赋值（不碰键盘）、按钮直接 Invoke（不动鼠标），位置漂了也不怕。',
      '整批会先过安全闸：任何一步含敏感动作（启动程序、关窗口、Alt+F4、Win 组合键），整批一步都不动，除非 confirmed: true。',
      '任何一步失败默认立刻停下（stopOnError: false 可继续），并报出是第几步、为什么。',
      'dryRun: true 只预演：逐 step 解析目标/控件/坐标并报告放行还是拒绝，整批不注入、不移动、不截图、不消耗授权。',
    ].join(''),
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: '按顺序执行的动作，每步 {action, x, y, imageX, imageY, text, key, keys, toX, toY, button, count, deltaX, deltaY, app, window, confirmed}。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              required: true,
              enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'hotkey', 'open', 'close'],
            },
            x: { type: 'number', description: '屏幕物理像素 x。' },
            y: { type: 'number', description: '屏幕物理像素 y。' },
            imageX: { type: 'number', description: '按当前截图里的像素 x 定位。' },
            imageY: { type: 'number', description: '按当前截图里的像素 y 定位。' },
            control: { type: 'string', description: '按 UIA 控件路径定位（如 0/2/1）：动作时重新量位置，type 直接赋值、按钮直接 Invoke。给了它就不用写 x/y。' },
            how: { type: 'string', enum: ['click', 'invoke'], description: 'control 怎么驱动：invoke 用 UIA 直接触发（默认），click 走鼠标点中心。' },
            toX: { type: 'number', description: 'drag 终点 x。' },
            toY: { type: 'number', description: 'drag 终点 y。' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
            count: { type: 'number', description: '点击/按键次数。' },
            deltaX: { type: 'number', description: '滚轮横向滚动量。' },
            deltaY: { type: 'number', description: '滚轮纵向滚动量，正数向下，120 一格。' },
            text: { type: 'string', description: 'type 要输入的文本。' },
            key: { type: 'string', description: 'key 要按的键名，如 enter、tab、esc、f5。' },
            keys: { type: 'string', description: 'hotkey 组合键，如 ctrl+s。' },
            app: { type: 'string', description: 'open 要启动的程序。' },
            window: { type: 'string', description: '这一步之前先把这个窗口切到前台。' },
            confirmed: { type: 'boolean', description: '这一步的敏感动作已获同意。' },
          },
        },
      },
      window: { type: 'string', description: '整批开始前先切到这个窗口（标题片段或 handle），切不到就整批不动。' },
      capture: { type: 'string', enum: ['end', 'none'], description: '批次结束截一张（默认 end）还是完全不截（none）。失败时总是补一张。' },
      settleMs: { type: 'number', description: '收尾截图前等画面重绘的毫秒数。' },
      stopOnError: { type: 'boolean', description: '某步失败就停，默认 true。' },
      dryRun: { type: 'boolean', description: '只预演：逐 step 解析目标窗口/控件/坐标、报告是否会放行/拒绝，整批不注入、不移动、不按键、不截图、不消耗授权（也不要求 arm）' },
      confirmed: { type: 'boolean', description: '整批的敏感动作已获同意。' },
    },
    output: text,
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (!steps.length) throw new Error('screen_sequence 需要至少一步')
      const max = config.maxSequenceSteps ?? 24
      if (steps.length > max) {
        return `⛔ 一批最多 ${max} 步（收到 ${steps.length} 步）。拆成两批发，或者把插件配置 maxSequenceSteps 调大。`
      }

      // dryRun: rehearse the whole batch and report every step's plan + pre-checks.
      // Placed before the arm/safety/focus/overlay steps on purpose: a rehearsal must ask
      // for nothing and send nothing, and it reports blockers instead of refusing outright.
      if (args.dryRun === true) {
        const lines = [`dryRun（预演：整批只预演，未执行任何输入、未移动鼠标、未按键、未截图、不消耗授权）: screen_sequence 共 ${steps.length} 步（上限 ${max}）`]
        let batchTarget = null
        if (args.window) {
          try {
            batchTarget = resolveWindow(args.window)
            lines.push(`整批窗口：${batchTarget.title || `handle=${batchTarget.handle}`} handle=${batchTarget.handle}（正式执行会先切前台，预演不切）`)
          } catch (error) {
            lines.push(`整批窗口：找不到 — ${oneLine(error?.message)}（正式执行会整批一步都不发）`)
          }
        }
        const age = state.lastLookAt ? Date.now() - state.lastLookAt : Infinity
        if (age > staleAfterMs(config)) {
          lines.push(`观察新鲜度：⚠️ 正式执行会拒绝 — ${state.lastLookAt ? `上一次观察是 ${Math.round(age / 1000)} 秒前` : '还没看过屏幕'}（要求 ${config.requireFreshLookSeconds ?? 120} 秒内看过；这一步每步带 control 也免不了）`)
        } else {
          lines.push(`观察新鲜度：通过（${age < 1000 ? '刚看过屏幕' : `${Math.round(age / 1000)} 秒前看过屏幕`}）`)
        }
        if (escPressed(config, state.ignoreEscUntil)) lines.push('Esc 停止：⚠️ 主人正按着 Esc，正式执行会在第一步之前取消')
        else lines.push('Esc 停止：未按下')
        const stopToken = readStop()
        lines.push(stopToken
          ? `停止信号：${stopToken.level}（${stopToken.by || '未知'}）—— 正式执行会${stopToken.level === 'hard' ? '在本步之前立即断' : '在步边界停'}`
          : '停止信号：无')

        const blockedSteps = []
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] ?? {}
          const pre = await previewOneStep(step, { config, target: batchTarget, confirmed: args.confirmed })
          if (pre.blockers.length) blockedSteps.push(i + 1)
          lines.push(`  ${i + 1}. ${summarizeStep(step)} — ${pre.blockers.length ? '⛔ 预计会被拒绝' : '✓ 预计可执行'}`)
          for (const line of pre.lines) lines.push(`      ✓ ${line}`)
          for (const blocker of pre.blockers) lines.push(`      ⛔ ${blocker}`)
        }

        // Recorded as a rehearsal, never as a batch that ran.
        policyAuditSafe({
          kind: 'dry-run',
          tool: 'screen_sequence',
          steps: steps.length,
          blocked: blockedSteps,
          outcome: 'not-executed',
        }, config)

        lines.push(blockedSteps.length
          ? `预演结论：第 ${blockedSteps.join('、')} 步预计会被拒绝；正式执行会整批一步都不动（整批先验安全闸），本次也什么都没动。`
          : `预演结论：${steps.length} 步全部预计可执行（正式执行仍会请求人类授权，并真的注入输入）。`)
        lines.push('说明：这是预演——一个输入都没发；要真动手就别带 dryRun 重发。')
        return lines.join('\n')
      }

      // 整批先验安全闸：只要有一处该问人，就一步都不动
      const blocked = []
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] ?? {}
        const armRefusal = policyCheck(step.action, step, config)
        if (armRefusal) { blocked.push(`第 ${i + 1} 步（${step.action || '?'}）：${armRefusal}`); continue }
        const refusal = gate(step.action, { ...step, confirmed: step.confirmed ?? args.confirmed }, config)
        if (refusal) blocked.push(`第 ${i + 1} 步（${step.action || '?'}）：${refusal}`)
      }
      if (blocked.length) {
        return `⛔ 这一批一步都没动，先看拦在哪儿：\n${blocked.join('\n')}\n`
          + '含敏感动作的批次要主人点头后带 confirmed: true 重发；想先看计划用 dryRun: true。'
      }

      const age = state.lastLookAt ? Date.now() - state.lastLookAt : Infinity
      if (age > staleAfterMs(config)) {
        return `⛔ 先看一眼再动手：${state.lastLookAt ? `上一次观察已经是 ${Math.round(age / 1000)} 秒前的了` : '还没看过屏幕'}。`
          + '调用 screen_look 看一眼，再发这一批（每步都带 control 的话可以免这一步）。'
      }

      let target = null
      if (args.window) {
        target = resolveWindow(args.window)
        if (!focusWindow(target.handle)) {
          const fg = foregroundWindow()
          return `⛔ 切不到前台，整批一步都没发：想让「${target.title || target.handle}」上前台，`
            + `前台还留在「${fg?.title || '(未知窗口)'}」。`
        }
      }

      const rows = []
      let failed = null
      const startedAt = Date.now()
      try {
        for (let i = 0; i < steps.length; i++) {
        const step = { ...steps[i] }
        const t0 = Date.now()
        // The brake works between steps, which is where a batch can still be stopped cleanly.
        // ⑤ StopBus：hard 立即断（本步前），soft 到本步边界（本步后）。
        const stopToken = readStop()
        if (escPressed(config, state.ignoreEscUntil) || (stopToken && stopToken.level === 'hard')) {
          failed = { index: i, message: stopToken ? `主人按下停止（${stopToken.by}），取消` : '主人按了 Esc，取消了' }
          rows.push(`  ${i + 1}. ⛔         step — ${failed.message}，剩下 ${steps.length - i} 步一步没发`)
          break
        }
        showDriving(config, `第 ${i + 1}/${steps.length} 步`)
        try {
          let stepTarget = target
          if (step.window) {
            stepTarget = resolveWindow(step.window)
            if (!focusWindow(stepTarget.handle)) throw new Error(`切不到前台「${stepTarget.title || stepTarget.handle}」`)
          }
          const driven = await uiaStep(step, stepTarget)
          let notes
          if (driven?.handled) {
            notes = [...driven.notes]
          } else {
            notes = performAction(step.action, step, config, { point: driven?.point ?? pointOf(step), target: stepTarget })
            if (driven?.notes?.length) notes.unshift(...driven.notes)
          }
          rows.push(`  ${i + 1}. ✓ ${String(Date.now() - t0).padStart(4)}ms  ${step.action} — ${notes.join('；')}`)
        } catch (err) {
          failed = { index: i, message: err.message }
          rows.push(`  ${i + 1}. ✗ ${String(Date.now() - t0).padStart(4)}ms  ${step.action} — ${err.message}`)
          if (args.stopOnError !== false) break
        }
        if (step.action === 'key' && String(step.key ?? '').toLowerCase() === 'esc') {
          state.ignoreEscUntil = Date.now() + 600
        }
        // ⑤ StopBus：soft 在本步边界停（不打断本步，报告 boundary）。
        if (stopToken && stopToken.level === 'soft' && !failed) {
          failed = { index: i, message: `软停（${stopToken.by}）`, boundary: `step ${i + 1}/${steps.length}` }
          rows.push(`  ⏸ soft 停在 step ${i + 1}/${steps.length} 后（${stopToken.by}）`)
          break
        }
        }
      } finally {
        // 中途失败 / 被取消时，绝不能把主人的鼠标键或修饰键卡在按下状态。
        try { releaseAllInputs(Boolean(failed)) } catch { /* best effort */ }
      }

      const okCount = rows.filter(row => row.includes('✓')).length
      const elapsed = Date.now() - startedAt
      const header = failed
        ? `批次停在第 ${failed.index + 1} 步：共 ${steps.length} 步，完成 ${okCount} 步，整批 ${elapsed}ms`
        : `批次完成：${steps.length} 步全过，整批 ${elapsed}ms（一次调用，一次截图）`

      if (args.capture === 'none') return `${header}\n${rows.join('\n')}`
      const observed = observe(config, {
        settleMs: args.settleMs,
        note: failed ? `停下的原因：${failed.message}` : undefined,
      })
      return `${header}\n${rows.join('\n')}\n\n${observed.text}`
    },
  })

  return [look, windows, focus, uiaTool, act, sequence]
}