# dsh-click-matrix v0.8.0 — Windows 验收测试题目

适用：把桌面 zip 拷到另一台 Windows 10/11 x64 机器测试。
原则：**人类在场、只用测试账号/空白桌面、不输入密码/验证码/支付信息**；随时 `Esc` 或 `Ctrl+Alt+F11` 急停。
记录方式：每题记「通过/失败 + 证据」（工具返回原文、`audit_tail`、`click_matrix_doctor` 输出、截图）。

## 0. 前置条件

- Windows 10/11 x64；DSH desktop **0.2.1-rc.x**（插件 engines 要求）。
- .NET Framework 4.x（Win10/11 自带，用于首次本地编译 helper）。
- 可选 Node.js ≥22（只用于跑自动测试，不影响日常使用）。
- 单显示器即可；多显示器/混合 DPI 属“未真机验证项”，如有条件可加测。

## 第 1 关：安装（约 5 分钟）

| 编号 | 题目 | 通过标准 |
|---|---|---|
| A1 | 解压到 `D:\DSH-plugins\dsh-click-matrix`，在 DSH 会话让 Agent 用 `plugin_manager` 安装本地 bundle 并启用 | 安装成功、无报错 |
| A2 | 新开会话，让 Agent 调 `click_matrix_doctor` | **PASS 且 WARN=0 / FAIL=0**；显示 helper 版本 6、23 个工具、UIA 自检 PASS、「急停热键 Ctrl+Alt+F11 已注册」 |
| A3 | 看输入框左侧是否有「🖱 点阵」芯片（若无，重启一次 DSH） | 芯片可见；点开有 30 秒/2 分钟/10 分钟/常开/停止/浮层/自检 |
| A4 | 第一次调 `screen_info`（会触发 helper 编译） | 几秒~几十秒内返回；helper version=6、hotkey 已注册 |

## 第 2 关：只读观察（不需要授权）

| 编号 | 题目 | 通过标准 |
|---|---|---|
| B1 | `screen_info` | 返回显示器/虚拟屏/前台窗口/授权状态，无 FAIL |
| B2 | 对前台窗口 `screen_read` | **纯文字**返回（含“text-first：未截图”），不产生图片 |
| B3 | `screen_read`/`screen_text` 指定 `pid` 或 `handle` 读另一个窗口 | 元素列表正常；坐标在屏幕范围内；不崩溃 |
| B4 | `screen_capture` 截一个小区域（如 400×300，lattice standard） | 返回图片 + 映射；图片 token 合理（约几百） |
| B5 | `window_list` / `wait_window`（不存在的标题→超时；存在的→命中） | 超时文案清楚；命中返回窗口 rect |
| B6 | `window_focus` 一个最小化的资源管理器窗口 | 窗口恢复并前置；rect 不再是 -32000 |
| B7 | `screen_wait` 小区域 | 返回“画面已稳定”或明确超时 |

## 第 3 关：授权与安全（重点）

| 编号 | 题目 | 通过标准 |
|---|---|---|
| C1 | 按 `Ctrl+Alt+F12` 授权 | 状态 `armed:true, latched:true`；屏幕顶部出现胶囊（人眼确认；截图会排除） |
| C2 | 再按一次 `Ctrl+Alt+F12` | `armed:false, latched:false`，胶囊消失 |
| C3 | 授权后按 `Esc` | 立即 `paused`、`armed:false`、胶囊隐藏；审计有 escape/paused；重新授权可恢复 |
| C4 | 授权后按 `Ctrl+Alt+F11` | 立即 `paused`（reason 含“全局急停热键”）、`armed:false`、`latched:false`；审计有 `abort-hotkey stop`；重新授权可恢复 |
| C5 | 未授权时调 `mouse_click` 点桌面 | 被拒（需授权），不会实际点击 |
| C6 | 让 Agent 试试点 DSH 自己的窗口（未开 allowSelf） | 被拒（自身窗口禁止） |
| C7 | 授权后人类快速移动鼠标 | 约 1 秒内状态出现 `suspended`（人类操作中）；鼠标静止约 20 秒后 `suspended:null` 自动恢复 |
| C8 | 芯片菜单点「停止并解除授权」/ 输入 `/click-matrix stop` | 立即停止、`armed:false`、胶囊消失 |

## 第 4 关：操作功能（需授权）

| 编号 | 题目 | 通过标准 |
|---|---|---|
| D1 | 授权后点桌面空白处（如 `(0,900)`） | 返回“已点击”，目标窗口 Program Manager |
| D2 | 开始菜单→记事本：`type_text` 输入一段中文（含换行），`ctrl+a`/`ctrl+c` 后用 `clipboard_get` 读回 | 内容逐字一致；不写盘（关闭时选“不保存”） |
| D3 | `mouse_batch` 做 3 个动作（move/click/wait） | 3/3 完成；只消耗 1 次授权；文案无“-1 次” |
| D4 | `mouse_batch` 先点桌面、再点 DSH 自身窗口 | 返回**部分执行**「已执行 1/2，后续未执行…不会自动重试」 |
| D5 | `mouse_click {dryRun:true}` 点自身窗口 | 只预演：显示目标窗口/拒绝原因；**没有注入、不消耗授权** |
| D6 | 移动一个窗口后，用 `window:{titleContains}+fx/fy` 点它的中心 | 命中新位置（返回窗口相对坐标解析）；`fx=1.5` 此类非法值被拒 |
| D7 | 授权后跑 `mouse_batch {resumeOnHumanIdle:true}`，中途人类动鼠标 | 等待空闲后继续剩余动作（或按文档中止）；审计有 `humanIdleWaitedMs` |
| D8 | 任一 batch 失败后，人工确认状态，再用 `resumeFrom:N` 续跑剩余 | 前 N−1 个不重放；只执行剩余动作 |

## 第 5 关：异常与恢复

| 编号 | 题目 | 通过标准 |
|---|---|---|
| E1 | 任务管理器结束 helper 进程，再调 `screen_info` | helper 自动重启（新 pid）；doctor 热键仍 registered |
| E2 | 重启 DSH，再开会话 | 插件仍加载；状态 `armed:false`；芯片随重启加载 |
| E3 | 可选：目标机器有 Node，运行 `npm run check` 与 `npm test` | check 6 项 PASS；host 130/130、access 134、grid 163、client PASS |
| E4 | 可选（独占桌面）：`npm run test:helper`（首次会自动构建 `test/bin/fixture.exe`；也可先 `npm run build:fixture`） | **59/59 PASS**（会注入真实键鼠并短暂开全屏遮挡窗；v0.8.1 已去掉 PrintWindow 与遮挡前截图的哈希全等断言） |

> ⚠️ **E4 运行期间是"故意"会打扰你的**：`helper-smoke` 会启动靶场、创建**全屏置顶遮挡窗口**（PrintWindow 遮挡测试）、移动鼠标、点击 TARGET-A/B/C、注入热键。此时 DSH 会被盖住、鼠标自己移动、点"新对话"会点到遮挡窗——**都是测试设计，不是插件故障**。第一次跑约 1–2 分钟，等 `SUMMARY: 59/59` 出现、遮挡窗移除后再操作电脑。
>
> 其中"外部光标干扰"用例会用 PowerShell `SetCursorPos` 在两点之间**高速来回甩光标约 1.5 秒**（`cursorInterferenceScript`，流程里调用两次），用来验证 helper 检测外部输入并中止动画；录屏 30fps 还会产生拖影/回跳。看到这种"折返跑"属测试设计，不是点击抖动或插件 bug。

## 预期参考值（v0.8.4）

- 工具数 **23**；doctor **PASS 40 / WARN 0 / FAIL 0**（不同机器可能因服务差异略有变化，WARN 需看具体行）。
- 自动测试：`npm run check` 6 项；host **130/130**；access **134** 断言；grid **163** 断言；helper **59/59**；client PASS。

- 工具数 **23**；doctor **PASS 40 / WARN 0 / FAIL 0**（不同机器可能因服务差异略有变化，WARN 需看具体行）。
- 自动测试：`npm run check` 6 项；host **126/126**；access **134** 断言；grid **163** 断言；helper **57/57**；client PASS。
- 已知未验证：真机多显示器/混合 DPI；allowSelf 真机（默认关闭）；长时间/高并发。

## 失败时请收集

1. `click_matrix_doctor` 完整输出；
2. `audit_tail`（最近 20 条）；
3. 出错工具返回原文 + 当时前台窗口标题；
4. Windows 版本、DSH 版本、显示器数量/缩放；
5. 是否人工同时操作鼠标/键盘。

**安全红线**：不测试密码/验证码/支付/网银/系统安全框；不关闭杀软；不把 allowSelf 打开后随意乱点。
