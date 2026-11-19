# Security & data handling — dsh-click-matrix

## What this software does

dsh-click-matrix lets a DSH agent observe the Windows desktop and inject mouse
(optionally keyboard/clipboard) input. That is powerful by nature, so the plugin
is built around explicit human authorization, a hard-stop path, and an audit log.

## Acceptable use (read this first)

This is a **general-purpose desktop automation tool for a local machine with
human authorization**. It is **not** a remote-control, intrusion, cheating or
security-bypass tool. Prohibited uses include: controlling someone else's device
without consent, bypassing UAC/AV/EDR/anti-cheat, stealing credentials or personal
data, game cheating, bulk registration/spam/scalping, or any use that violates
applicable law or a target application's terms. The user is responsible for
their own actions. Full policy: [RESPONSIBLE-USE.md](./RESPONSIBLE-USE.md).

## Safety model (short)

- **Default is inert.** `mode=ask`; the model cannot authorize itself.
- **Human authorization** is required for every mutating action: `Ctrl+Alt+F12`
  (keep-on toggle), `/click-matrix arm <seconds|on>`, or the composer chip.
- **Three hard stops**: `Esc`, the independent global **`Ctrl+Alt+F11`** hotkey,
  the overlay STOP button, or `/click-matrix stop`. They abort in-flight input,
  release held buttons, revoke authorization/latch, hide the overlay and pause.
- **Human activity yields.** Physical mouse/keyboard activity suspends injection;
  it resumes after `humanIdleResumeMs` (default 20 s) only while the same
  authorization is still valid.
- **Protected targets**: DSH's own window (unless the human enables a tightly
  scoped `allowSelf` rectangle), elevated windows, secure desktop, and deny-listed
  processes/titles are refused.
- **Audit**: every injected action (and refusals) is appended to
  `<DSH_HOME>\click-matrix\audit.jsonl` with tool, decision, reason and target.
- **No self-update, no network service**: the helper is compiled locally from
  `runtime/helper.cs`; there is no telemetry endpoint and no remote shell.

## Data handling

- Screenshots and UIA text are produced locally and then passed to the model as
  DSH attachments; **they are sent to whatever model provider your DSH session
  uses**, not to a separate cloud service owned by this plugin.
- Captures are cached under `<DSH_HOME>\click-matrix\captures\`; audit is under
  `<DSH_HOME>\click-matrix\audit.jsonl`. Both stay on the local machine and can
  be deleted at any time.
- The clipboard tools only read/write plain text when a human has authorized them.
  Do not use them for passwords, OTPs, payment data or other secrets.
- The helper binary cache lives in `%LOCALAPPDATA%\dsh-click-matrix\helpers\`.

## Known security limits

- Windows UIPI blocks input to elevated windows; UAC secure desktop cannot be
  automated by design. Administrator/elevated windows are not supported targets.
- `allowSelf` (clicking DSH's own UI in a human-specified rectangle) is off by
  default and should stay off unless you specifically need it.
- If you grant keep-on authorization and leave the machine, a human must press
  `Esc`/`Ctrl+Alt+F11` or STOP. Do not leave it armed unattended.
- MIT license: no warranty. Automation can cause data loss or unintended clicks;
  use dry runs and test on disposable content.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** (private advisory) on the
repository. Please include the plugin version, helper version, Windows build and
a minimal reproduction. Do not open a public issue for an unpatched
input-injection or privilege-boundary problem.
