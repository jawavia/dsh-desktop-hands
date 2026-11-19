# dsh-click-matrix v0.8.5 — Release Notes

**版本**：0.8.5　**日期**：2026-10-31　**基于**：v0.8.4

> 这版全部来自 2026-10-31 的真机实测反馈。修的核心是「假成功」：拿不到证据时不许报成功。
> Windows 自己不让做的事（前台锁、安全桌面）仍然做不到，但这版会把失败说清楚并给替代路径。

## 这版修了什么

| # | 问题 | 这版的行为 |
|---|---|---|
| 1 | **点击「假成功」**（P0） | `mouse_click` 点击后改用**真实前台窗口**判定，不再拿「点击前的目标窗口」自证清白；点击前新增预检：helper `status` 的 `physicalButtonsDown`（`GetAsyncKeyState` 真实按键）与 `buttonsDown`（helper 自跟踪）两个来源**合并（union）**后非空即**拒绝点击**（任一方卡键都会吞掉注入）并提示先 `mouse_abort`；点击后前台为「无窗口」时 outcome 明确写 `clicked-no-foreground` 并警告「点击可能未生效」。helper `click` 响应新增 `foregroundBefore/foregroundAfter/foregroundChanged/physicalButtonsAfter`。 |
| 2 | **`window_focus` 失败不说明**（P0） | helper `focus` 新增 `foregroundBefore/foregroundAfter/reason/setForegroundOk/attempts/lastError`，并补一轮 `BringWindowToTop + SetWindowPos(HWND_TOP) + SetForegroundWindow`；宿主在 `focused:false` 时不再只说「已请求聚焦（helper 未确认）」，而是明确报**聚焦失败（前台锁）**，并给可执行替代：`mouse_click` 点标题栏一次 = 激活 / 人类手动切换 / 先恢复最小化窗口。 |
| 3 | **`mouse_abort` 顺手清授权**（P1） | 新增 `disarm` 参数：**默认只释放按键、保留原授权**（含常开 latched），`disarm:true` 才是旧语义。返回文案必写授权是否保留。 |
| 4 | **`screen_read` 命中少就丢结果**（P1） | `query` 命中不足时**先返回命中的元素**（哪怕 1 个）并说明低于 `minElements`；**带 `query` 时默认不再自动退回截图**（要图必须显式 `allowImageFallback:true`；例外：UIA 本身失败时仍自动退图）；输出头统一加 `≈N tokens` 文本/图片估算。 |
| 5 | **滚动「打了空也算成功」**（P1） | `mouse_scroll` 与 `mouse_batch` 的 scroll 动作新增 `detectNoMove`（默认开）：滚动前后对光标附近 120×120 区域取 `captureHash` 对比，画面没变就标注「⚠️ 内容未变化（可能已到边界或该区域不可滚动）」，batch 汇总行追加 `noMove:N`。 |
| 6 | **覆盖层「看起来能点」**（P2） | `screen_info` / doctor / `/click-matrix status` 增加 `hitTestable`（按 `WS_EX_TRANSPARENT` 判定），明确 lattice 是点击穿透、只有 pill 可命中。 |
| 7 | **多行文本框坐标有误导**（P2） | `screen_read` 对多行 Text 元素标注 `多行≈N行`，并给出**首行中心**坐标（原来的「中心点」对折行框会指到两行之间）。 |

helper 版本 7 → 8；`npm test` 断言同步新增。

## 升级须知

- ⚠️ **行为变更**：`mouse_abort` 默认**不再清除授权**。旧语义是「中止 = 连授权一起没了」，现在「中止 = 只释放按键」，按键卡住时可以反复重试而不必重新授权。要旧语义就传 `disarm:true`。
- **host + client 半部都需要重启 DSH 才生效**：client 芯片按 Loader specifier 缓存，必须重启；host 工具重启后生效。
- ⚠️ **备份路线：升级后先“完全退出 DSH”再启动**：旧 helper 进程若还在，会与新 helper 抢 `Ctrl+Alt+F12`（授权）/`Ctrl+Alt+F11`（急停）。后启动者注册失败会**重试数十秒才 ready**，表现为「热键没反应、插件像卡住/启动很慢」。处置：完全退出 DSH（含托盘与后台进程）→ 再启动 → `/click-matrix doctor` 确认 `helper 版本 v8` 且两个热键 `registered`。若显示未注册，把 DSH 完整重启一次即可（**不要**用 Stop-Process/taskkill 杀 helper，它有自己的超时自杀重建）。
- **helper 由源码哈希自动重建，无需手动编译**：`runtime/bootstrap.mjs` 会按 `runtime/helper.cs` 的哈希重建 v8 helper，旧的会被替换；doctor 应显示 `helper v8`。
- 安装方式不变：`powershell -ExecutionPolicy Bypass -File .\install.ps1`（或按 `INSTALL-WINDOWS.md` 手动 junction），然后重启 DSH。

## 验证清单

```powershell
npm run check        # 仓库自检：JS 语法 / UTF-8 编码 / 版本一致性 / 必需文件
npm test             # mock 套件：access 134 / grid 163 / host 142 / client（无需真实桌面）
npm run test:helper  # 真实键鼠 smoke，需独占桌面 + full-access（会开全屏遮挡窗并注入键鼠）
#   注意：若 DSH 正在运行，它的 helper 已占用 Ctrl+Alt+F12 / Ctrl+Alt+F11，
#   本机实测会变成 54/59（热键 3 项 + PrintWindow 遮挡帧 1 项 + doctor 连带 1 项失败），
#   与 v0.8.4 基线完全一致（同一台机器跑旧版也是 54/59）。要拿 59/59 必须先完全退出 DSH。
```

手测 4 个场景（0.8.5 的重点修复，都能人工复现）：

1. **按键卡住时点击被拒**：按住右键不放，`mouse_click` 应被拒并提示先 `mouse_abort`；`mouse_abort` 后重试应成功，返回文案写明授权保留。
2. **前台锁**：对后台窗口调用 `window_focus`，被系统拒绝时应明确报「聚焦失败（前台锁）」并给替代方案，而不是「已请求聚焦」。
3. **`mouse_abort` 语义**：不传 `disarm` 时授权仍在（用 `/click-matrix status` 核对）；传 `disarm:true` 后授权清空。
4. **滚动空转**：滚到列表底部继续滚，`mouse_scroll` 应附「⚠️ 内容未变化」；同场景 `mouse_batch` 汇总行应有 `noMove:N`。

## 已知限制

- **按键卡住 / 前台锁 / 安全桌面**属 Windows 自身限制，插件只负责**说清楚失败**并给替代路径，不能绕过。
- **滚动检测只看光标附近 120×120 区域**：画面在这个小区域没变才判「未变化」；内容变化恰好不在光标附近时仍可能漏报（宁可保守，不要重复滚）。
- **`hitTestable` 依赖窗口扩展样式**：读不到 `GetWindowLong(GWL_EXSTYLE)` 的窗口会显示未知/降级值。
- **多显示器 / 混合 DPI / RDP**：设计上支持，仍未真机验证。

## License

MIT。
