# dsh-click-matrix v0.8.5.1 — Release Notes

**版本**：0.8.5.1　**日期**：2026-11-02　**基于**：v0.8.5

## 修复

**触控板点击/右键在插件操作结束后失效（疑似键状态未归还）**

现象：插件鼠标任务结束后，触控板仍可移动光标，但轻点、左键、右键无响应；用无线鼠标点一次后恢复。

根因：`ReleaseAllButtons()` 只释放 helper 自己跟踪的按键。若 helper 在 `SendButton(down)` 之后、`SetTrackedButton(true)` 之前被停止/重启/异常，跟踪状态为 false，但 OS 仍认为按键按下；旧逻辑不会补发 UP，导致 Windows/触控板点击状态卡住，直到真实鼠标点击重置。

修复：

- `ReleaseAllButtons()` 现在释放 **tracked 状态 ∪ 真实 OS 状态**（`GetAsyncKeyState`）；
- 覆盖 abort、helper 退出、进程退出等所有释放路径；
- 对已按下的键补发 UP，对已松开的键是无害的；
- helper 版本 8 → 9；新增真实鼠标中间键回归用例，验证“跟踪为 false 但物理按下”时 abort 也能释放。

## 升级须知

- 必须完全退出 DSH 后重新启动，让新 helper（v9）编译/接管；
- 旧 helper 进程可能短暂占用热键，重启后确认 `click_matrix_doctor` 显示 `helper v9`；
- 不改变授权、急停、审计等行为。

## 验证

- `npm run check` → PASS 6/6
- `npm test` → PASS 142/142（access 134、grid 163、host 142、client）
- 独立真实键鼠回归：外部注入中间键 down（helper tracking=false）→ `abort` → `physicalButtonsDown.middle=false`（PASS）
- `npm run test:helper` 完整 smoke 需要独占桌面；新增的回归用例已放在该套件中。

## License

MIT。
