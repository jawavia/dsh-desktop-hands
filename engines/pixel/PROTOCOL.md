# click-matrix native helper protocol (v1)

Long-lived Windows helper process. The DSH Host plugin spawns it once and talks
NDJSON over stdin/stdout: one JSON object per line, UTF-8, `\n` terminated.
stdout carries protocol only; diagnostics go to stderr.

- Request:  `{ "id": <number>, "cmd": "<name>", ...args }`
- Response: `{ "id": <number>, "ok": true, "data": {...} }`
  or `{ "id": <number>, "ok": false, "error": "<message>" }`
- Event (unsolicited): `{ "event": "<name>", "data": {...} }`

RPC requests are processed serially by one worker thread.
`abort` is the one exception: the stdin reader handles it immediately (sets the
abort flag and releases any pressed mouse button) so it can interrupt a running
move/drag. Mouse input is always available; keyboard injection exists only as the
optional v2 `type_text` / `press_keys` commands, which the host exposes only
behind `enableKeyboard` and the same human arm/approval window as mutating mouse
actions. The helper never records key content; the Esc/any-key watchdog only
reports that a key was pressed.

All coordinates are physical pixels in virtual-desktop space (multi-monitor
origin may be negative). The process is Per-Monitor-V2 DPI aware; it reports
monitor bounds and per-monitor scale so the host can convert DIP <-> physical.

## Startup

On start the helper emits `{"event":"ready","data":{...}}` with the same shape
as `hello` below. The host waits for it (timeout 20 s), then sends requests.

HELPER_VERSION 9 (plugin v0.8.5.1); the wire protocol version is still `protocol: 1`.

## Commands

### hello / status
`{cmd:"hello"}` and `{cmd:"status"}` data:
```
{
  protocol: 1,
  pid, helperVersion, osVersion,
  dpiAware: true,
  capabilities: { keyboard: true, clipboard: true, printWindow: true, escWatch: true, humanInputWatch: true, humanMouseWatch: true, focus: true, abortHotkey: true, physicalButtons: true, overlayHitTest: true, focusDetail: true },  // v8 新增后三项
  virtual: { x, y, w, h },
  monitors: [ { id, device, primary, x, y, w, h, scale } ],
  cursor: { x, y },
  foreground: <windowInfo>,
  hotkey: { registered, combo: "Ctrl+Alt+F12" },
  overlay: { available, visible, captureExcluded, hitTestable, latticeHitTestable, pillHitTestable },  // v8：WS_EX_TRANSPARENT 为 set 时可穿透、不可命中
  buttonsDown: { left, right, middle },          // helper 自己跟踪的压键状态
  physicalButtonsDown: { left, right, middle },  // v8：GetAsyncKeyState 读到的真实按键
  elevated: false
}
```

### set_esc_watch  (v2; v3 adds the physical-cursor watchdog)
`{cmd:"set_esc_watch", enabled: <bool>}` -> `{ enabled }`
- While enabled, the helper polls `GetAsyncKeyState(VK_ESCAPE)`, any other key and
  `GetCursorPos` at ~30 Hz on a watchdog. Pressing Esc or any physical key aborts
  the current mouse action, releases buttons and emits `{"event":"escape"}` or
  `{"event":"human-input","data":{"vk":<code>}}`. Physical cursor movement that is
  not the helper's own injection (outside a 300 ms injection grace) emits
  `{"event":"human-mouse","data":{"x","y","dx","dy"}}` (throttled to 250 ms).
  The host's v0.3 policy: `escape` = full stop/disarm; `human-input` and
  `human-mouse` = suspend injection and auto-resume after the configured idle
  window (default 20 s), keeping the same keep-on/timed authorization.

### type_text  (v2)
`{cmd:"type_text", text: "<utf-16 text>", intervalMs?: 10}` ->
`{ chars, aborted }`
- Injects characters with `SendInput` + `KEYEVENTF_UNICODE` (IME independent).
  `\n` => Enter, `\t` => Tab. Maximum 20000 UTF-16 code units per call.
- Host-only exposure: the keyboard tools are gated by `enableKeyboard` config
  and the same human arm/approval window as mouse mutations.

### press_keys  (v2)
`{cmd:"press_keys", keys: ["enter","tab","esc","backspace","delete","left","right","up","down","home","end","ctrl+a","ctrl+c","ctrl+v","ctrl+x","ctrl+z","ctrl+s","ctrl+f","f5"]}` ->
`{ sent: ["enter", ...] }`
- Whitelist only; unknown key combinations are an error.

### clipboard_get / clipboard_set  (v2)
`{cmd:"clipboard_get"}` -> `{ text, chars }`
`{cmd:"clipboard_set", text: "<text>"}` -> `{ chars }`
- Text only, via the UI thread (STA). Max 100000 chars per call.

### capture
```
{cmd:"capture",
 x?, y?, w?, h?,                  // region in virtual-desktop px; omitted = full virtual screen
 windowHandle?,                  // v2: PrintWindow capture of that top-level window (works when occluded)
 scale?, outW?, outH?, path,
 lattice?: { spacing, style, majorEvery? },
 marks?: [ { x, y, kind: "target"|"cursor" } ],
 includeCursor?, excludeOverlay?
}
```
- `windowHandle` uses `PrintWindow` + `PW_RENDERFULLCONTENT` so a background /
  occluded window can be captured without bringing it to the front. Minimized
  windows are rejected. Output origin/width/height follow the window rect.
- Other behavior is unchanged; response gains `windowHandle` when applicable.

### focus  (v4)
`{cmd:"focus", handle:<window handle>, restore?:true}` ->
`{ ok, focused, foregroundNow, wasMinimized, restored, minimized, restoreRequested, window:<windowInfo>,
   foregroundBefore, foregroundAfter, reason, setForegroundOk, attempts, lastError }`  // v8 新增后六项
- Brings an existing top-level window to the foreground without injecting input.
  Restores first when minimized (`restore` defaults true). Uses SetForegroundWindow
  with an AttachThreadInput fallback. Invalid/missing handles are a hard error;
  an OS-refused foreground change returns `ok:true, focused:false`
  (`foregroundNow:false`) for the host to decide. Does not resize/move windows.
- The helper refuses its own windows (same rule as capture); it does not consult
  the host deny list because it injects no input.
- v8 补充：`foregroundBefore` / `foregroundAfter`（聚焦前后的真实前台窗口对象）、
  `reason`（成功为空串，失败为 `foreground-lock`）、`setForegroundOk`（bool，`SetForegroundWindow`
  的返回值）、`attempts`（int，尝试轮次）、`lastError`（Win32 错误码 int）。失败前会再补一轮
  `BringWindowToTop` + `SetWindowPos(HWND_TOP)` + `SetForegroundWindow`。

### move / click / drag  (v2 result extension)
Results may add `externalAborted: true` when the helper detects that the real
cursor deviated from the injected trajectory (a human or another program moved
the mouse). The host v0.3 policy treats this as human activity: suspend injection
and auto-resume after the idle window.

### events (v2; v3 adds human-mouse; v6 adds abort)
- `{"event":"escape"}` — Esc pressed while the watch is enabled.
- `{"event":"human-input","data":{"vk":<code>}}` — any other key pressed while
  the watch is enabled (physical input; the host suspends and auto-resumes).
- `{"event":"human-mouse","data":{"x","y","dx","dy"}}` — the physical cursor
  moved outside the helper's own injection; the host suspends injection.
- `{"event":"abort","data":{"source":"hotkey"}}` — the independent global
  `Ctrl+Alt+F11` abort hotkey was pressed. It is registered for the helper's
  whole lifetime (no arming needed); it aborts in-flight actions and releases
  buttons, and the host must hard-stop and require a fresh human authorization.
  `status`/`doctor` additionally report `abortHotkey:{registered,combo}`.

### abort
`{cmd:"abort"}` -> `{ aborted: true, released: true }` (immediate; releases buttons).

### windows
`{cmd:"windows"}` ->
```
{ windows: [ <windowInfo> ] }   // visible, top-level, no tool windows
```

### probe_at
`{cmd:"probe_at", x, y}` -> `{ window: <windowInfo> }`
Top-level window under the point (climb from WindowFromPoint to root).

`<windowInfo>`:
```
{
  handle, title, className, pid, process,          // process = exe path ("" if unknown)
  rect: { x, y, w, h }, minimized, elevated, denied   // denied = own DSH/secure/deny class
}
```

### capture
```
{cmd:"capture",
 x?, y?, w?, h?,                  // region in virtual-desktop px; omitted = full virtual screen
 scale?,                         // output scale factor (default 1); host passes e.g. 0.5
 outW?, outH?,                   // optional exact output size (takes precedence over scale)
 path,                           // absolute PNG output path
 lattice?: { spacing, style, majorEvery? },   // spacing in SCREEN px (pre-scale); style: "cross"|"hierarchical"|"none"; majorEvery default 4
 marks?: [ { x, y, kind: "target"|"cursor" } ],  // screen px
 includeCursor?: true,
 excludeOverlay?: true           // hide click-through overlay during capture if it cannot be excluded by OS
}
```
- Captures the region with GDI, scales it to output size, draws lattice crosses
  (screen-px spacing mapped into image space; cross size auto-sized) and marks,
  then writes PNG.
- Returns:
```
{ path, width, height, source: { x, y, w, h },
  scale, lattice: { spacingScreen, spacingImage, originX, originY, style },
  captureHash: "<sha256 of raw pixels>",
  blackFrame: false }
```
`blackFrame` = true when the captured region is almost uniformly black (DRM /
protected content / failed capture); the host must report this instead of
claiming success.

### zoom
```
{cmd:"zoom", cx, cy, size?, scale?, subCols?, subRows?, path, mark?}
```
- Region: `size` screen px (default 270), centered on (cx, cy), clamped to the
  virtual screen; upscaled by `scale` (default 3, nearest-neighbor) and a
  sub-lattice (subCols x subRows, default 6x6) is drawn as crosses.
- Returns:
```
{ path, width, height, source: {x,y,w,h}, scale,
  subSpacingScreen: size/subCols.lattice..., captureHash }
```
- After saving, the host derives sub-point screen coords:
  `sx = source.x + (col + 0.5) * source.w / subCols`,
  `sy = source.y + (row + 0.5) * source.h / subRows`.

### move
`{cmd:"move", x, y, durationMs?, easing?}`  (easing: "easeInOutCubic"|"linear")
- Bounds-clamped; animates with SendInput absolute events; returns
  `{ x, y, cursorX, cursorY, aborted, startX, startY, elapsedMs }`.
- Out-of-bounds target is an error (never clamped silently for click targets).

### click
`{cmd:"click", x, y, button?, count?, durationMs?, moveFirst?, holdMs?}`
- button: "left"|"right"|"middle" (default left); count 1..2; moveFirst default true.
- Always releases the button, including on abort/exception; returns
  `{ x, y, cursorX, cursorY, button, count, aborted,
    foregroundBefore, foregroundAfter, foregroundChanged, physicalButtonsAfter }`  // v8 新增后四项

### drag
`{cmd:"drag", fromX, fromY, toX, toY, button?, durationMs?, moveFirst?}`
- Moves to origin, presses, animates to destination, releases in a finally block.
  Returns `{ fromX, fromY, toX, toY, cursorX, cursorY, aborted }`.

### scroll
`{cmd:"scroll", delta, x?, y?}`  (delta in wheel notches, negative = up)
- Optionally moves to (x,y) first. Returns `{ delta, cursorX, cursorY }`.

### overlay
`{cmd:"overlay", show, mode?, spacing?, opacity?, label?}`
- mode: "lattice"|"pill"|"both" (default "both").
- Lattice: full virtual screen, click-through, topmost, no-activate,
  cross-point-only lattice at `spacing` screen px (same style as capture),
  no labels over content. Pill: small topmost status window at top-center with
  label text and a STOP button; clicking STOP sets abort + emits
  `{"event":"stop"}`; it also emits `{"event":"pill-click"}`.
- Returns `{ visible, mode, captureExcluded }`.

### set_deny  (v1 extension)
`{cmd:"set_deny", processes?: [string], classes?: [string]}` ->
`{ deniedProcesses, deniedClasses }`
- Adds process basenames (case-insensitive) and window class names that
  `windowInfo.denied` must report. The secure-desktop classes
  (ConsentUI, LogonUI, LockApp, Windows Security, User Account Control) are
  always denied regardless of this list.

### abort
`{cmd:"abort"}` -> `{ aborted: true, released: true }` (immediate; releases buttons).

### doctor
`{cmd:"doctor"}` -> environment self-check data:
```
{ osVersion, build, processElevated, dpiAware, monitors, capture: { ok, black },
  hotkeyRegistered, overlayAvailable, captureExcluded, uipiProbe: { ok, note },
  helperVersion, protocol: 1 }
```

### quit
`{cmd:"quit"}` -> `{ bye: true }` (process exits; host may also kill it).

## Unsolicited events
- `{"event":"hotkey","data":{"combo":"Ctrl+Alt+F12","armed":<bool>}}`
  Global hotkey toggles local armed state; host treats it as a human arm/disarm.
- `{"event":"stop"}` — user pressed the pill STOP button (host must disarm + abort).
- `{"event":"pill-click"}` — informational.

## helper v9（插件 0.8.5.1）修复
- `abort` / 进程退出 / 生命周期释放按键时，不再只信 `Button*Down` 跟踪状态，而是同时检查 `GetAsyncKeyState` 的真实按键状态；两者任一为 down 就补发 UP。
- 解决“helper 在 down 后、tracked 前被停止/重启，物理按键残留，触控板点击失效”的边界问题。

## helper v8（插件 0.8.5）运行注意

- 两个热键（`Ctrl+Alt+F12` 授权 / `Ctrl+Alt+F11` 急停）是**进程独占**的：同一时刻存在两个 helper 时，后启动那个注册失败并按 `HOTKEY_REGISTER_ATTEMPTS` 重试，`ready` 会延迟数十秒（表现为插件启动慢、热键暂时无效）。宿主侧正常情况下只会有一个 helper；升级 DSH 后要让它完全退出再启动。

## helper v8（插件 0.8.5）新增字段

协议版本仍是 `protocol: 1`；`HELPER_VERSION` 8。下面只列新增/变更字段的含义。

- `status.physicalButtonsDown`：`{ left, right, middle }`，由 `GetAsyncKeyState` 读取的**真实**按键状态；`status.buttonsDown` 仍是 helper 自身压键跟踪。
- `status.overlay`：新增 `hitTestable` / `latticeHitTestable` / `pillHitTestable`（布尔）。`WS_EX_TRANSPARENT` 为 set 时窗口可穿透、不可命中——lattice 恒穿透，只有 pill 可命中。
- `status.capabilities`：新增 `physicalButtons` / `overlayHitTest` / `focusDetail` 能力标记。
- `focus` 响应新增：`foregroundBefore` / `foregroundAfter`（窗口对象）、`reason`（成功为空串，失败为 `foreground-lock`）、`setForegroundOk`（bool）、`attempts`（int）、`lastError`（Win32 错误码 int）。
- `click` 响应新增：`foregroundBefore` / `foregroundAfter` / `foregroundChanged`（bool）/ `physicalButtonsAfter`。


## Host-side rules that the helper assumes
- Mouse injection via SendInput is the default; keyboard injection exists only
  through the optional v2 `type_text`/`press_keys` commands, exposed by the host
  only when `enableKeyboard` is true and inside a human arm/approval window.
  The Esc/any-key watchdog never records key content.
- Always releases pressed buttons on abort/exception/timeout.
- v8 起宿主在点击前先看 `status.physicalButtonsDown` / `status.buttonsDown`：两个来源
  **合并（union）**后非空就拒绝点击并提示先 `mouse_abort`，不发送注定被系统忽略的注入
  （物理卡键与 helper 自跟踪卡键是独立来源，任一命中即视为无效输入通道）。
- Capture excludes the overlay window when possible (`WDA_EXCLUDEFROMCAPTURE`);
  otherwise temporarily hides it for the capture.
- Errors are fail-closed: unknown command, out-of-bounds target, missing file
  path, unsupported capture => `ok:false` with a stable message.
- Host kills/restarts the process after an RPC timeout; a fresh process must
  re-register its hotkey and report `ready` again.
