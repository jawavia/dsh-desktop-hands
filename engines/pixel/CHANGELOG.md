# CHANGELOG

版本按"能独立验收"的节点记录；每个条目的证据见当次实测报告与 `npm test` / `npm run check`。

## v0.9.3 (2026-11-07)

- **内建拒绝清单**（工具层强制执行，不可由配置关闭，allowSelf 也不能放行）：安全软件面板 / 凭据管理器 / 系统配置工具三组；
- `click_matrix_doctor` 输出当前生效的内建拒绝规则；
- 文档合规化：使用边界改为中性表述，移除不必要的技术性枚举；
- 隐私：清除仓库内个人路径与账号标识；
- 新增 `DENY-LIST.md` 说明默认拒绝范围与判定方式。

## 公开分发状态（2026-11-04 起）

- 本项目已**暂停公开分发**，当前仅供个人自用与内部分享；
- 恢复公开发布前，需先完成合规版改造（功能边界、文档口径、默认拒绝清单）；
- 已发布到公共包管理器的版本均已标记弃用。

## ⚠️ v0.8.5 之前的版本已撤回（2026-11-03）

`v0.8.0` / `v0.8.2` / `v0.8.3` / `v0.8.4` 及其 GitHub Release 已**撤回**，原因：它们都缺少两个关键修复——

| 修复 | 首次出现在 | 说明 |
|---|---|---|
| 点击"假成功"（P0） | **v0.8.5** | 旧版用"点击前的目标窗口"自证清白；现改为点击后**真实前台窗口**判定 + 物理按键并集预检 |
| 触控板/物理按键卡住 | **v0.8.5.1**（现指向 `08da671`） | 旧版 `ReleaseAllButtons()` 只释放 helper 自己跟踪的键，OS 按键仍 down → 触控板点击/右键在操作结束后失效 |

证据：`git show v0.8.4:runtime/helper.cs` 中 `foregroundBefore` 与 `physicalButtonsDown` 均为 0 处；只有 `08da671` 起才有。

**请使用 `v0.8.5`（已含这两个修复）或当前的 `v0.9.1`。** 旧版即使回移修复，也补不齐 v0.9.0/0.9.1 的安全语义（D-07~D-10）与审计链。

## v0.9.2 (2026-11-03)

**npm 首发版本，内容与 GitHub 上的 v0.9.1 覆盖修订一致**（GitHub tag 仍为 `v0.9.1`；因 npm 侧 0.9.1 从未发布、且同版本号不宜重复使用，改用 0.9.2 首发）。

- 修复 P0：`screen_capture` / `screen_wait` 的 `region` 参数改为强类型 `string + enum`，新增强类型 `region_rect:{x,y,w,h}`；旧写法继续兼容。
  原因：原先只有 description、没有 type，模型偶发输出 `{"region": foreground}`（漏引号）→ 上游 `MALFORMED_RESPONSE` 直接终止整轮（实测一次 108 步会话在第 107 步报废）。
- `window_list` 每行补 `hwnd=0x…`（「window_focus 传 PID 报 handle 无效」的真根因）；`window_focus` 增加 PID/handle 混淆提示。
- `press_keys` 白名单补 `ctrl+n` / `ctrl+w` / `ctrl+tab`（helper 按键映射同步；双修饰键 `ctrl+shift+s` 未加）。
- 图片预算默认 6 张/2000 tokens → **12 张/6000 tokens**。
- 插件加载写 `plugin-loaded` 审计（含 pid）；审计链把「多实例并发写分叉」与「篡改」分开报（doctor 显示 WARN）。
- 回归：`npm test` 142/142 · `verify-dsh-plugin` PASS · 23 个工具 schema 结构校验 0 问题。
## v0.9.1 (2026-11-03)

可安全分享的小版本（无新工具、无新依赖；`dependencies` 为空）。**本版本已于 2026-11-03 覆盖修订（内容与版本号一起覆盖，不新增版本号）。**

- **审计防篡改（哈希链）**：每条审计行新增 `seq` / `prev` / `h`（sha256，链式提交上一条）。`AuditLog.verify()` 跨所有保留代校验；
  doctor 新增「审计链」PASS/FAIL；编辑、插入、重排、截断会报 `hash-mismatch` / `chain-break`。
  ⚠️ 诚实边界：链是**无密钥**的，能发现"静默改动"，但挡不住同用户"删除并重写整条链"——这是证据可读性，不是不可篡改存储。
- **隐私脱敏**：审计里的窗口标题截断到 80 字符（句柄/矩形保留）；其余字段沿用既有 bound（字符串 ≤300）。
- **UI 微调**：client 芯片新增「需确认重启」「审计不可写」红色告警态，footer 显示链头前 6 位；胶囊文字改为「点阵 · 就绪」；
  doctor 的命令帮助文本补全 `ack` / `helper-reset` / `hotkeys-retry`。
- **分享准备**：README 新增「分享 / 在别的机器安装」一节；`npm pack` 产物仅含运行所需文件（无依赖）。

### 覆盖修订 ①：P0 —— `region` 参数无类型，导致整个 turn 被上游判死

- 现象：模型偶发输出 `{"region": foreground}`（枚举值漏引号）→ DeepSeek 流式解析报 `tool input is invalid JSON` /
  `MALFORMED_RESPONSE`，**整个 turn 直接终止**（工具根本没执行）。
- 实测：session `891952de`（点阵键鼠控制插件测试）108 步 / 6 分 51 秒，第 107 步因这一行报废；40 次 `screen_capture` 中 38 次带引号正常，2 次裸写即致命（≈5%）。
- 根因：`screen_capture.region` 与 `screen_wait.region` 在 JSON Schema 里**只有 description、没有 type/enum**，模型只能按散文猜类型。
- 修法：`region` 改为 `type: 'string', enum: [...]`；新增强类型 `region_rect: {x,y,w,h}`；代码同时接受旧写法（对象直接放进 `region`），不影响既有调用。

### 覆盖修订 ②：评审后的 3 项行为改进（第 4 项按键只做单修饰键）

- **#1 重载会清空授权 → 只在「告知」上修**：插件 `apply` 时写一行 `plugin-loaded` 审计（带 pid）；README/SKILL 写明「改 profile 配置会重载插件并清空常开授权，需重新 arm」。**不做授权持久化**（安全倒退）。
- **#6 补齐 window_list 的 hwnd**（这是「window_focus 传 PID 报 handle 无效」的真正根因：列表原本只有 `[pid=…]`，工具却要 handle）：每行现在是 `[pid=N] hwnd=0x… 标题 — 进程 (x,y wxh) [flags]`；`window_focus` 解析失败且传入数字时提示「那可能是 PID，请用 window:{pid:N}」。
- **#4 press_keys 白名单**补 `ctrl+n` / `ctrl+w` / `ctrl+tab`（helper 按键映射同步）。**未加 `ctrl+shift+s`**：helper 按键表只支持单个修饰键（`KEY_CTRL_BIT`），双修饰键要改 C# 输入路径，本轮不动。
- **#2 图片预算默认值** 6 张/2000 tokens → **12 张/6000 tokens**（README/SKILL/host-smoke 断言同步）。调参：原默认对多步 GUI 任务偏紧，且已自动降清晰度兜底。

### 覆盖修订 ③：审计链把「并发写分叉」与「篡改」分开报

- 背景：两个 DSH 实例同时往同一个 `audit.jsonl` 追加时，会读到同一个链头 → 同 `seq` / 同 `prev` 的分叉，旧实现一律报 `chain-break` FAIL，看起来像被篡改。
- 修法：`AuditLog.verify()` 识别 `concurrent-writer`；doctor 对这种情况输出 **WARN**（附「把 audit.jsonl 改名归档后链会重建」），只有真正的 `chain-break` / `hash-mismatch` 才是 FAIL。
- 回归：`node --check` + `npm test` + `tools/host-smoke.mjs`（142/142 基线）+ `verify-dsh-plugin.mjs`。
## v0.9.0 (2026-11-03)

安全层与失败模式更新（不是功能新增：工具仍 23 个、无新 UI）。此前本地版本号 `0.8.5.1` 为 4 段、不是合法 semver，
会让声明了 `link:` 依赖的 profile 在 pnpm 安装/卸载任何插件时报 `ERR_PNPM_BAD_PACKAGE_JSON`；本版改为合法 semver **0.9.0**
（0.x 下 minor 可含破坏性收敛：拒绝语义变严、helper 协议 9 → 11）。

- **D-13 残余**：`TriggerAbortFromWatch(human-input)` 与 external-cursor 分支只释放"插件自己注入的键"，不再合成释放人类按住的键（拖拽不再被打断）。
- **D-12**：胶囊拆成"点击穿透文字层 + 独立 STOP 窗"并移到屏幕底边，不再压标题栏；`status.stopChannels` 改读实测 `stopHitTestable`（不谎报逃生通道）。
- **D-08**：缺 `Ctrl+Alt+F11` 时拒绝 arm/注入（env 降级只能降级、不能静默）；新增 `/click-matrix hotkeys-retry`。
- **D-09 / D-10**：helper 非预期重启后冻结注入，需人类 `/click-matrix ack`；审计不可写时拒绝注入；新增 `/click-matrix helper-reset`。
- **D-07**：helper 来源事件审计标 `helper-event(unverified)`，不再冒充 human。
- **自身窗口保护**：进程名 + DSH 自身界面标题 + pid 树（**仅 self + 子孙**，不含祖先进程）；防"自批准环"。
- **helper 完整性**：编译产物旁写 sha256 sidecar 并在缓存命中时校验；`DSH_CLICK_MATRIX_HELPER` 覆盖需第二把钥匙且标记 `unverified`。
- **批量窗口基线**：审批前采基线（审批期移动会被检出）；基线 probe 失败 fail-closed；drag 与无目标滚轮也有基线；容差随 DPI；`resumeFrom` 必须先对同批次 dryRun。
- **审计保留**：轮转保留 N 代（默认 5），取代只留 1 代。
- **D-03**：DPI 不感知窗口截图不再 2× 错位（按内容包围盒裁回 + mismatch/targetDpi 字段 + 插件端校验）。
- helper 版本 **9 → 11**（新增 `process_tree`、`retry_hotkeys`、`safeToArm`/`hotkeys`、`pointProbe`、`stopHitTestable` 等）。

## v0.8.5.1
- **修复：触控板点击/右键在插件操作结束后失效**。`ReleaseAllButtons()` 原来只释放 helper 自己跟踪的按键；若 helper 在 `SendButton(down)` 与 `SetTrackedButton(true)` 之间被停止/重启/异常，跟踪为 false 但 OS 按键仍 down，旧逻辑不再补发 UP。现在释放 **tracked ∪ 真实 OS 状态**，覆盖 abort/退出/进程退出路径。
- helper 版本 8 → 9；新增真实鼠标物理按键回归用例（跟踪为 false 时 abort 仍须释放）。

## v0.8.5
- **P0 点击「假成功」**：`mouse_click` 点击后验证原来拿「点击前的目标窗口」自证清白，现在改用**真实前台窗口**判定；新增点击前预检：helper `status` 新增 `physicalButtonsDown`（`GetAsyncKeyState` 真实按键）与 `buttonsDown`（helper 自己跟踪的按键）两个字段；两个来源**合并（union）**后非空即**拒绝点击**（任一方卡键都会吞掉注入）并提示先 `mouse_abort` 释放；点击后前台为「无窗口」时 outcome 明确写 `clicked-no-foreground` 并警告「点击可能未生效」。helper `click` 响应新增 `foregroundBefore/foregroundAfter/foregroundChanged/physicalButtonsAfter`。
- **P0 `window_focus` 失败语义化**：helper `focus` 新增 `foregroundBefore/foregroundAfter/reason/setForegroundOk/attempts/lastError`，并补一轮 `BringWindowToTop + SetWindowPos(HWND_TOP) + SetForegroundWindow`；宿主在 `focused:false` 时不再只说「已请求聚焦（helper 未确认）」，而是明确报**聚焦失败（前台锁）**并给可执行替代（`mouse_click` 点标题栏一次=激活 / 人类手动切换 / 先恢复最小化窗口）。
- **P1 `mouse_abort` 不再顺手清授权**：新增 `disarm` 参数，**默认只释放按键、保留原授权**（含常开 latched）；`disarm:true` 才是旧语义。返回文案必写授权是否保留。
- **P1 `screen_read`**：`query` 命中不足时**先返回命中的元素**（哪怕 1 个）并说明低于 `minElements`；**带 `query` 时默认不再自动退回截图**（要图必须显式 `allowImageFallback:true`；例外：UIA 本身观察失败时仍会自动退图，否则 query + UIA 故障会没有任何答案）；输出头统一加 `≈N tokens` 文本/图片估算。
- **P1 滚动「打了空也算成功」**：`mouse_scroll` 与 `mouse_batch` 的 scroll 动作新增 `detectNoMove`（默认开）：滚动前后对光标附近 120×120 区域取 `captureHash` 对比，画面没变就标注「⚠️ 内容未变化（可能已到边界或该区域不可滚动）」，batch 汇总行追加 `noMove:N`。
- **P2 覆盖层状态**：`screen_info` / doctor / `/click-matrix status` 增加 `hitTestable`（用 `WS_EX_TRANSPARENT` 判定），明确 lattice 是点击穿透、只有 pill 可命中。
- **P2 读屏多行框**：`screen_read` 对多行 Text 元素标注 `多行≈N行`，并给出**首行中心**坐标（原「中心点」对折行框有误导）。

### 测试
- helper 版本 7 → 8；`npm test` 断言同步新增。

### 文档对齐（与实现一致）
- 工具数统一为 **23**（目录结构注释里的旧「20」已改）。
- npm 状态更新：**已发布到 npm**（旧文「当前不在 npm 发布」已过时）。
- 键盘能力描述修正：`type_text` / `press_keys` / `clipboard_*` 自 v0.2 起可用，与鼠标**同一个授权门**（旧文「绝不注入键盘 / mouse injection only」已过时）；`cordis.patch.yml` 注释同步。
- 审计范围措辞修正：记录**注入动作 + 生命周期事件**（授权/暂停/恢复/急停/聚焦/命令）；`mouse_move` 与只读工具不写审计，`type_text`/`clipboard_set` 只记字符数。

## v0.8.4
- 修复 `tools/release.ps1` 生成 `SHA256SUMS.txt` 的路径：去掉多余的 `/pkg/` 前缀，包内逐文件校验可直接使用。
- 仅打包脚本/版本号变更，插件功能不变。

## v0.8.3
- 包装/发布版：新增一键安装脚本 `install.ps1`（junction + profile package.json，自动备份、幂等）、`RELEASE-v0.8.3.md`、`SECURITY.md`。
- README 增加“与常见方案的区别”、30 秒快速开始、安装方式 A/B、FAQ/可能遇到的问题；明确当前优先 GitHub Releases、npm 暂不发布。
- 仅文档/安装方式变更，插件行为与 v0.8.2 相同。

## v0.8.2
- `clientOnly` 在 PW_CLIENTONLY 出黑图的窗口（Electron/Chromium 常见）**自动回退整窗截图**并明确提示；截图操作失败不再误报"原生 helper 不可用"。
- 测试文档补充：`helper-smoke` 会创建全屏置顶遮挡窗口并注入键鼠，运行期间 DSH 被盖住/点击被拦截属测试设计，不是插件故障。

## v0.8.1
- 修复外部验收反馈：发布包缺 `test/bin/fixture.exe` → 新增 `tools/build-fixture.mjs` + `pretest:helper` 自动构建、helper-smoke 惰性解析 fixture，干净机器可直接 `npm run test:helper`。
- PrintWindow 遮挡断言改为“遮挡后连续两次截图稳定 + 非黑帧 + 尺寸正确”，不再与遮挡前哈希全等（标题栏激活/非激活配色会变）。
- `capture` 新增 `clientOnly`（PW_CLIENTONLY + GetClientRect），`screen_capture` window 模式可只截客户区。
- `clipboard_get` 增加 `requireText`、`hasText`/`reason`，无文本时内部短重试，Host 文案不再把“被抢走”显示成空成功。
- `/api/click-matrix/status` 增加 `helperPid` / `helperVersion` / `helperRestarts`。
- 新增 `npm run release`（tools/release.ps1）：从 git HEAD 打包并用实际产物重算 `.sha256`，修复外层哈希与随包 `.sha256` 不一致。
- 文档：安装改为 junction + profile（0.2.1-rc.2 无 `plugin_manager`）、路径通用化、测试数量更新。

## v0.8.0
- 新增独立全局急停热键 **Ctrl+Alt+F11**（helper v6，无需授权，随时硬停；撤销授权/常开/allowSelf、进入 paused、审计）。
- 新增 `npm run check` 仓库自检：全部 JS 语法、UTF-8 乱码/U+FFFD、版本一致性、必需文件、client loader id；`npm test` 自动包含。
- doctor 新增「急停热键」行；README/PROTOCOL/SKILL 更新。

## v0.7.0
- `mouse_batch` 新增 `resumeOnHumanIdle:boolean`（默认 false）：动作前遇人类活动可等待空闲后继续；Esc/STOP/超时仍中止。
- `npm test`（access/grid/host/client mock 套件）与 `npm run test:helper` 一键化；README 工具表更新为 23 个。

## v0.6.0
- 新工具 `screen_read`：text-first（UIA 文字优先，零截图；不足自动退回小图）。
- `mouse_batch` 新增动作级 `expectAfter` 与 `resumeFrom:N` 安全续跑（前置动作不重放）。

## v0.5.0
- `screen_capture` 图片预算不足时自动降 binning 重截一次。
- UIA 过滤虚拟屏外 >200px 的幻影元素（修复最小化窗口 ±3 万坐标）。
- 多显示器/混合 DPI 加固（0 尺寸幻影屏、非法 scale、primary 容错、镜像重叠优先主屏、lattice scale 上界）+ `tools/grid-smoke.mjs` 163 断言。
- allowSelf 真机验证按人类决定跳过，默认保持关闭。

## v0.4.1
- 修复 UIA `Add-Type -PassThru` 返回数组导致 `screen_text` 全部失败（含计算器 WinUI 元素 Infinity 崩溃）。
- `screen_capture` 越界 region 明确报「区域超出虚拟屏幕」。
- helper v5：热键注册失败 10×500ms 重试，修复 kill 重启竞态。

## v0.4.0
- 人类活动工具内等待（`humanWaitMaxMs` 默认 30s）。
- `mouse_batch` 逐动作窗口检查 + partial 返回。
- `dryRun`、窗口相对坐标（`window`+`fx/fy`）、`window_focus`/`wait_window`。
- 作用域 `allowSelf`（默认关闭，仅人类命令 + 自身窗口矩形内单击）。
- 常开授权文案「常开授权（不计数）」。

## v0.3.1
- 修复 UIA `Add-Type` 数组 bug；doctor 新增 UIA 自检。
- 修复冷启动 `commands` 服务晚到导致 `/click-matrix` 命令漏注册（可重试注册）。

## v0.3.0
- `Ctrl+Alt+F12` 改为常开/关切换；芯片菜单 30s/2min/10min/常开。
- 人类鼠标/键盘活动自动暂停注入，空闲 `humanIdleResumeMs`（默认 20s）后自动恢复。

## v0.2.0
- `mouse_batch`（一次授权多动作）、`type_text`/`press_keys`/`clipboard_get/set`（可选、授权门控）、`screen_wait`、PrintWindow 后台窗口截图。
- Esc/人类按键暂停、常驻授权胶囊、输入框「🖱 点阵」状态芯片、只读状态路由。
- 修复热键 arm 自触发暂停、常开/定时状态错位、bootstrap 缓存旧 helper。

## v0.1.0
- 十字点阵截屏/缩放/定位 + 平滑鼠标移动/点击/拖拽/滚动。
- 默认 ask、人工授权窗口、拒绝名单、JSONL 审计、doctor 自检、本地编译 C# helper。
