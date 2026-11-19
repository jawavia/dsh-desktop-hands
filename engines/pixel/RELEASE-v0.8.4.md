# dsh-click-matrix v0.8.4 — Release Notes

**A local-first desktop-control plugin for DeepSeek Harness (DSH).**
Cross-point lattice screenshots + smooth mouse, with human-in-the-loop
authorization, hard stops and an audit trail.

> Version 0.8.4 fixes the zip-internal SHA256SUMS paths (a `/pkg/` prefix bug) over 0.8.3 (no functional
> regressions intended). It adds a one-command Windows installer, a comparison
> and troubleshooting guide, this release note, and a security policy.

## Highlights

- **23 DSH tools**: capture / zoom / locate / text-first read, smooth mouse,
  batch, keyboard & clipboard (opt-in), window focus/wait, overlay, doctor, audit.
- **Cross-point lattice aiming**: screenshots carry a coordinate-paper lattice,
  so the model can aim by counting points instead of pixel guessing; combined
  with `screen_zoom` for fine correction.
- **Text-first**: `screen_read` prefers UIA text (zero screenshots); images are a
  fallback. Image budget auto-degrades resolution instead of failing.
- **Safety by default**: `mode=ask`, no self-approval, protected windows,
  human-activity suspension, `Esc` / **`Ctrl+Alt+F11`** / STOP hard stops,
  JSONL audit, `dryRun`, partial batch results and safe `resumeFrom`.
- **Local native helper**: compiled on first use from `runtime/helper.cs` with the
  in-box .NET Framework `csc.exe`; no prebuilt binary, no telemetry service.
- **Windows-only**, DSH desktop 0.2.1-rc.x, 23 tools, MIT.

## Install (Windows)

```powershell
# from the unzipped folder
powershell -ExecutionPolicy Bypass -File .\install.ps1
# optional: -ProfileDir "C:\Users\you\.dsh\profiles\desktop"
```

Then restart DSH once, open a new session and call `click_matrix_doctor`.
Authorize with `Ctrl+Alt+F12` or `/click-matrix arm 30`; emergency stop is
`Esc` / `Ctrl+Alt+F11` / the overlay STOP button.

Requirements: Windows 10/11 x64; DSH desktop **0.2.1-rc.x**; .NET Framework 4.x
(bundled with Windows); Node ≥22 only if you want to run the test suites.

## Verification (v0.8.2/0.8.4 lineage)

- `npm test`: repo check + access 134 + grid 163 + host **130/130** + client PASS.
- `npm run test:helper`: **59/59** real-input smoke on Windows 11 (clean machine
  auto-builds `test/bin/fixture.exe`).
- `click_matrix_doctor`: PASS 40 / WARN 0 / FAIL 0 (helper v7, 23 tools,
  `Ctrl+Alt+F11` registered).
- External acceptance run on a second machine: 29/31 pass; the two flags were a
  test-assertion false positive (PrintWindow title-bar colors) and one
  not-covered interaction case. Both are documented; the assertion was fixed.

## Known limitations / things that may go wrong

- **Multi-monitor / mixed DPI / RDP**: supported in code and simulated tests, but
  not yet validated on real multi-monitor hardware.
- **`allowSelf`** (clicking DSH's own UI) is off by default and not validated on a
  real machine; enabling it is a deliberate risk.
- **Elevated windows / UAC secure desktop / DRM / exclusive fullscreen**: Windows
  blocks or blackens these by design; the plugin fails honestly instead of
  pretending success.
- **First run compiles a helper**; security software may prompt once. Allow it
  only if you trust the source; `click_matrix_doctor` shows the helper path.
- **Electron/Chromium `clientOnly` capture** may return a black frame
  (`PW_CLIENTONLY` unsupported); v0.8.2+ falls back to a full-window capture and
  says so.
- **Global hotkeys** `Ctrl+Alt+F12` (authorize) / `Ctrl+Alt+F11` (emergency stop)
  can conflict with another program; if registration fails, doctor warns and
  authorization/stop can still be done via `/click-matrix` and the chip.
- **`helper-smoke` is intentionally disruptive**: it opens a full-screen topmost
  occluder, clicks TARGET-A/B/C, injects keys and jerks the cursor between two
  points for ~1.5 s (twice). DSH being covered and clicks being blocked during
  that run is test design, not a bug. Wait for `SUMMARY: 59/59`.
- **No OCR**: text in canvas/games/images is not recognized; UIA text-first only.
- **No warranty** (MIT): test on disposable content; use `dryRun`.

## Integrity

Use the attached `.sha256` next to the zip:

```powershell
$expect = (Get-Content .\dsh-click-matrix-0.8.4-win64.zip.sha256).Split()[0]
$actual = (Get-FileHash .\dsh-click-matrix-0.8.4-win64.zip -Algorithm SHA256).Hash.ToLower()
if ($expect -ne $actual) { throw 'sha256 mismatch' } else { 'OK' }
```

The zip also contains `SHA256SUMS.txt` for every file inside it.

## License

MIT. Original implementation; see `LICENSE`. Issues and pull requests are
welcome, but desktop automation is risky: keep the safe defaults.
