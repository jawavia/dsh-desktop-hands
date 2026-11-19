# 屏幕点阵 · dsh-click-matrix

> 🔧 **2026-11-08 工具面变更（P4+P6）**：读侧 7 个 + 窗口 3 个已合并成单一入口 `screen_view`（10 个 action）。
> 工具数：**默认 24**（旧 10 个仍注册，保留原描述、不加注记）／**`mergeReadSide=true` 后 14**（只剩 `screen_view`）。
> 本文件下方「23 个工具」是 v0.6 时期的历史表述，以 `screen_view` 与 `click_matrix_doctor` 的实时清单为准。

> ⛔ **已停止公开分发（2026-11-04，GitHub 账号 ToS 复核中）**
> npm 上 4 个版本（`0.0.0-stage` / `0.8.4` / `0.8.5` / `0.9.2`）已全部设为 deprecated，并已向 npm Support 申请整包删除；本仓库不再对外提供。
> **请勿安装、请勿转发。** 恢复与否以 GitHub 复核结果为准，见 `CHANGELOG.md` 顶部说明。

> DSH 桌面版 **host + client** 插件：用**十字点阵**截屏定位，用**平滑鼠标**安全操控，输入框有「🖱 点阵」状态芯片。
> 默认询问模式、人工授权（常开/定时）、拒绝名单、全程审计；**Esc / Ctrl+Alt+F11 / STOP 随时硬停**。
>
> ⚠️ **使用边界**：仅限本机、经人类授权的桌面辅助操作；仅用于自己负责的设备与数据。不得用于违反所在地法律法规或目标软件服务条款的用途。使用者自行承担全部后果；详见 [RESPONSIBLE-USE.md](./RESPONSIBLE-USE.md)。

## 这是什么

`dsh-click-matrix` 是 DeepSeek Harness 的桌面操控插件：Host 半部提供 23 个工具与 `/click-matrix` 命令，Client 半部在输入框左侧显示状态芯片，把"看屏幕、点屏幕"拆成两条可审计的链路：

- **轻便版**：点阵截屏 + 点阵定位/放大/点击。截屏图上只叠加十字点阵，模型像读坐标纸一样说出目标所在的点，换算成屏幕坐标后点击；先截整屏粗定位，再 `screen_zoom` 二次精修。token 成本低，适合大部分界面操作。
- **标准版**：平滑鼠标。移动（带时长/缓动）、左键/右键/中键点击、双击、拖拽、滚轮，全部通过 Windows `SendInput` 注入，并受同一套安全门、预算和审计约束。

两种模式可以混用：先用轻便版看清界面并定位，再用标准版完成实际操作。Host 侧通过一个常驻的本地 C# helper（`runtime/helper.cs`，首次运行本地编译）访问真实鼠标与屏幕，Host ↔ helper 的 NDJSON 协议见 [PROTOCOL.md](./PROTOCOL.md)。

安全性优先：插件默认 **inert（不动）**；只有人类显式授权后才会在一个受限窗口内注入鼠标；模型无法给自己授权。

## 为什么选它（与常见方案的区别）

> 以下是**定位差异**，不是绝对优劣；按你的需求选合适的工具即可。

| 常见方案 | 它擅长 | 本插件的不同与取舍 |
|---|---|---|
| 通用 RPA（UiPath、Power Automate Desktop 等） | 可视化流程、企业系统集成、录制回放 | 面向 **LLM Agent 的自然语言调用**，MIT、自托管、可审计；不做复杂流程编排/企业调度，也不提供托管服务 |
| 脚本库（pyautogui、AutoHotkey 等） | 灵活、生态成熟、可写任意逻辑 | 提供**人类授权门、三层急停、JSONL 审计、dryRun、batch 部分执行/续跑**，以及点阵瞄准、图片预算、UIA text-first；它不是脚本语言，不适合写复杂业务逻辑 |
| 云端 computer-use / 视觉 Agent | 视觉理解强、跨平台、开箱即用 | 截图/操作默认**在本机产生和执行**，模型由你当前的 DSH 会话选择；带本地 C# helper 和 Windows 原生输入；不做云端托管视觉模型 |
| 商业桌面 Agent 产品 | SLA、托管、客服支持 | 免费开源（MIT）、源码可审计/可改、本地运行、无账号绑定；没有商业 SLA/托管服务 |
| 纯 DSH 文本工具 | 零风险、简单 | 不能真正操作 GUI；本插件补上"看屏幕/点屏幕"这一层，并保持同一套安全边界 |

**核心优势**

- **人在环、可急停**：模型不能自批；`Esc` / 独立全局 `Ctrl+Alt+F11` / STOP 随时硬停，急停后必须人类重新授权。
- **成本可控**：`screen_read` text-first（UIA 优先、零截图）、点阵瞄准、每轮图片预算、重复截图去重；预算不足自动降清晰度而不是直接失败。
- **可审计、可预演**：每个注入动作/拒绝原因写入本地 `audit.jsonl`；`dryRun` 只预演不注入；batch 部分执行有明确的"已执行 K/M"和不自动重试语义。
- **本地优先**：helper 从源码在本机编译，无预编译二进制、无遥测；截图按 DSH 附件机制发给**你选择的模型**，不额外上传到插件方。
- **可维护**：MIT、23 个工具、142 条 mock 断言与 59 项真实键鼠 smoke，带 `npm run check` 仓库自检。

## 30 秒快速开始

```powershell
# 1) 解压发布包后，在解压目录运行
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 2) 重启一次 DSH（客户端「🖱 点阵」芯片需要重启加载）

# 3) 新会话里让 Agent 调 click_matrix_doctor，应看到 PASS、23 个工具

# 4) 人类按 Ctrl+Alt+F12 常开授权（或 /click-matrix arm 30）
#    急停：Esc / Ctrl+Alt+F11 / 胶囊 STOP
```

`install.ps1` 会：在当前 DSH profile 的 `node_modules` 建 junction、把 `dsh-click-matrix` 加入 profile `package.json` 的依赖与 bundles，并**自动备份**原 `package.json`；重复运行是幂等的。

## 两个独立旋钮

截屏成本与定位精度分别由两个互相独立的档位控制。

### 1. 截屏合并档 `binning`

| 值 | 含义 | 说明 |
| --- | --- | --- |
| `target` | 模型目标清晰档 | 默认。按 `captureLongSide`（默认 1600）把长边缩到模型清晰档、绝不放大，日常推荐。 |
| `2` | 每 2×2（**4 px**）像素合并成 1 | 最清晰，适合看图标细节、小字、细线。 |
| `4` | 每 4×4（**16 px**）像素合并成 1 | 平衡档。 |
| `6` | 每 6×6（**36 px**）像素合并成 1 | 省 token，适合大块布局。 |
| `8` | 每 8×8（**64 px**）像素合并成 1 | 最省；只适合确认"大概在哪"。 |

- 合并档越粗，返回图越小、token 越少。
- **token 曲线会走平**：每 **16 px** 合并成 1（`4` 及更粗）之后，单图 token 基本不再下降；**单图地板约 196 tokens**。继续加粗只会损失清晰度，不会更便宜。
- 需要看细节时，正确做法是保持较细的合并档 + 局部裁剪 / `screen_zoom`，而不是整屏反复重截。

### 2. 点阵间距档 `lattice`

| 档位 | 点阵间距 (DIP) | 本机 200% 缩放 → 物理像素 |
| --- | --- | --- |
| `coarse` | 180 DIP | 360 px |
| `standard` | 90 DIP | 180 px |
| `fine` | 45 DIP | 90 px |
| `micro` | 22.5 DIP | 45 px |

- 间距按 **DIP** 定义，运行时按每台显示器的缩放换算成物理像素；上表右列是**这台机器（单显示器 2880×1800 @ 200%）**的换算结果，换机器/换缩放会自动变。
- `coarse` 适合"跳一大步"的粗定位；`fine` / `micro` 适合小按钮、密集列表；默认 `standard`。
- **zoom 内的 6×6 子点阵提供 ±4 px 精修**：先用主点阵粗定位到一格，再 `screen_zoom` 以该点为中心放大截取（默认 6×6 子点阵、3×），在放大后的子点阵上二次选点，可把定位误差收敛到 ±4 px 级，然后 `mouse_click`。
- **联动校验**：点阵在**图像内**的间距必须 **≥ 8 图像像素**。合并档太粗 + 点阵档太密时两者会打架（点阵糊成一片），Host 会拒绝该组合并提示，不会发出一张"看不懂的图"。
- 两个档位互相独立：可以"细点阵 + 粗合并"（图便宜但点密）或"粗点阵 + 细合并"（图清晰但点疏），只要通过上面的 8 px 校验即可。

## 显示风格

- **只画十字点阵**：不画网格线、不在画面内容上贴字母/编号，避免遮挡与误读。
- 三种点阵样式：`lattice`（统一十字，默认）/ `hierarchical`（主次十字，每 4 个点一个主点，可选边缘刻度便于数格子）/ `clean`（不画格，纯截图）；屏幕覆盖层与截屏用同一套样式。
- **无遮挡**：屏幕上的点阵覆盖层是 click-through、topmost、不抢焦点的；截屏时覆盖层会被系统排除（`WDA_EXCLUDEFROMCAPTURE`），做不到时临时隐藏后再截。
- 覆盖层有两种形态可组合：`lattice`（全屏十字点阵）与 `pill`（顶部居中的状态胶囊，显示 `ARMED 45s` 之类的状态和 **STOP** 按钮）。

## 工具一览（23 个）

| 工具 | 一句话说明 |
| --- | --- |
| `screen_info` | 屏幕环境总览（只读、零成本）：显示器/缩放、虚拟屏物理像素范围、DPI、光标、前台窗口、helper 与授权状态（含 `按键未释放` / `物理按键`、覆盖层 `hitTestable`）、当前配置与图片预算。 |
| `screen_read` | **text-first 读屏（v0.6，优先用）**：UIA 文字优先，足够时零截图返回元素与坐标；不足/失败才自动退回小图（带 `query` 时命中不足也先回元素、不自动退截图，要图需显式 `allowImageFallback:true`；UIA 本身失败时仍自动退图）。输出头带 `≈N tokens` 估算，多行框标 `多行≈N行` 并给首行中心。 |
| `screen_capture` | 桌面截图（有图片 token 成本）：全屏/前台/区域/窗口（PrintWindow）+ 点阵刻度 + binning；预算不足自动降清晰度重截一次。 |
| `screen_zoom` | 局部放大（有图片 token 成本）：中心截小块、放大并画 6×6 子点阵，返回子格中心坐标映射。 |
| `screen_locate` | 坐标→最近点阵点（纯文字、零成本），返回偏差、所在格与下一步建议，不截图。 |
| `screen_text` | UIA 文字观察（只读、零成本）：窗口元素类型/名称/中心坐标/可用操作；通常优先 `screen_read`。 |
| `screen_wait` | 等画面稳定（纯文字、零成本）：轮询 captureHash，稳定或超时返回文字。 |
| `window_list` | 列出可见顶层窗口（只读、零成本）：标题/进程/pid/矩形/最小化/管理员权限/是否禁止操作。 |
| `window_focus` | 把窗口恢复（最小化则还原）并切前台（v0.4，不需授权，限速，遵守人类活动暂停）；被前台锁拒绝时明确报「聚焦失败」并给替代方案。 |
| `wait_window` | 等待指定窗口出现/超时（v0.4，纯文字、零成本，遵守人类活动暂停）。 |
| `mouse_move` | 移动光标（不点击、安全）：屏幕/归一化坐标、窗口相对 `window`+`fx/fy`、可选点阵吸附。 |
| `mouse_click` | 点击（左/右/中键，1–2 次）：需授权；点击前预检按键是否卡住、点击后按**真实前台窗口**校验；支持 `expect`、`dryRun`、窗口相对坐标。 |
| `mouse_drag` | 拖拽（from→to）：需授权；前后窗口安全检查；支持 `dryRun`；相对坐标暂不支持。 |
| `mouse_scroll` | 滚轮滚动 delta 格（负=上、正=下）：需授权；可先移动到 (x,y)；默认 `detectNoMove`（前后 120×120 区域哈希不变就标注「内容未变化」）。 |
| `mouse_batch` | 一次授权批量动作（≤`batchMaxActions`）：逐动作即时窗口检查、partial 返回、`dryRun`、`expectAfter`、`resumeFrom` 续跑、可选 `resumeOnHumanIdle`。 |
| `mouse_abort` | 立即中止并释放按键（始终允许、无需授权）；**默认保留授权**，`disarm:true` 才清除。 |
| `type_text` | Unicode 直投文本（≤20000 字符，`\n`/`\t`）：需授权；禁用于密码/OTP/支付。 |
| `press_keys` | 白名单按键/组合（enter/tab/esc/ctrl+a/c/v…）：需授权。 |
| `clipboard_get` / `clipboard_set` | 纯文本剪贴板读写：需授权；读取超 2000 字符会截断；隐私数据勿外传。 |
| `matrix_overlay` | 显示/隐藏点阵覆盖层与状态胶囊（纯视觉、安全）。 |
| `click_matrix_doctor` | 自检（只读、零成本）：helper/协议/能力/热键/覆盖层（含 `hitTestable`）、显示器 DPI、UIA 自检、命令/状态路由、工具清单。 |
| `audit_tail` | 查看最近注入动作审计（只读、零成本），默认 20 条。 |

## 人工专属通道

以下命令由人类在 DSH 里直接输入，**不是模型工具**，模型无法调用：

```text
/click-matrix status                  # 状态：模式、arm 剩余时间/点击预算、helper 健康、显示器
/click-matrix mode off|ask|auto       # 切换安全模式（默认 ask）
/click-matrix arm [s]                 # 人工授权一个受限操作窗口（默认 60s / 10 次点击，可用秒数覆盖）
/click-matrix stop                    # 立即停止：中止当前动作 + 解除授权
/click-matrix overlay on|off|auto     # 覆盖层策略：auto 仅 arm 时显示；on 常驻；off 不自动显示
/click-matrix lattice coarse|standard|fine|micro   # 切换点阵间距档
/click-matrix binning target|2|4|6|8               # 切换截屏合并档
/click-matrix doctor                  # 运行环境自检（等价 click_matrix_doctor）
```

- **全局热键 `Ctrl+Alt+F12`**：人工授权/解除（按一下 = 开一个受限窗口，默认时长 `hotkeyArmMs`=60 秒；再按 = 解除授权并立即 abort、释放当前动作，等同停止）。全局热键，DSH 没有焦点也能用。
- **屏幕顶部状态胶囊的 STOP 按钮**：点一下立即中止并解除授权。
- 人工授权的三种写法等价：热键 / `/click-matrix arm` / DSH 审批 UI 里点"允许一次"。模型侧没有任何办法伪造授权。

## 安全模型

- **默认不动**：`mode=ask`，没有授权就没有任何鼠标注入。
- **授权是人工行为**：热键、`/click-matrix arm [s]`、DSH 审批 UI 三选一，产生一个**有界窗口**（点击上限默认 `armClicks`=10；审批窗口默认 `armWindowMs`=25 秒，命令/热键窗口默认 60 秒）；窗口用完/停止/超时自动解除。
- **模式语义**：
  - `off`：所有鼠标操作直接拒绝（`screen_*`、`window_list`、`doctor`、`audit_tail` 等只读工具仍可用）。
  - `ask`（默认）：每次鼠标操作先经 Host 审批；已有 arm 窗口时不重复询问。若宿主未提供 approval 服务（审批不可用），只能靠人工 `/click-matrix arm` 或热键授权。
  - `auto`：**不跳过人工门**，只是跳过逐步审批弹窗——仍然要求存在人工打开的 arm 窗口，没有窗口就拒绝。适合"人已明确在旁边看着"的连续操作。
- **硬拒绝目标**：DSH 自身窗口、提权（elevated / UIPI）窗口、UAC 安全桌面，以及 deny-list 命中的进程/标题。拒绝发生在注入之前，不是事后补救；点击前还会二次确认目标窗口没有变化，变了就重新检查。
- **预算与限速**：arm 窗口双上限（时长 + 点击次数）；两次注入最小间隔 `minIntervalMs`；每轮图像预算另算。
- **全程审计**：每次注入 / 拒绝都追加到 `<DSH_HOME>/click-matrix/audit.jsonl`，可用 `audit_tail` 查；超过 `auditMaxBytes` 自动滚动。
- **键盘/剪贴板同样受控**：`type_text`、`press_keys`、`clipboard_*` 与鼠标走**同一个授权门**，`enableKeyboard`/`enableClipboard` 可整类关闭；没有授权窗口时一个键也不发。
- **失败即停**：越界、目标被拒、超时、异常一律拒绝/中止，并**总是释放按下的鼠标键**（drag 的 release 在 finally 里）。

## 成本纪律

本插件为省 token 而设计，内置以下纪律：

- **文本优先**：先 `screen_text` / `window_list`，只有界面信息读不到时才截图。
- **每个操作阶段只点阵截屏一次**；细节用裁剪或 `screen_zoom`，不要整屏反复重截。
- **图片预算**：默认最多 **12 张图 / 6000 tokens**（`maxImagesPerTurn` / `maxImageTokensPerTurn`，按 120 秒滑动窗口统计），超出就只回文本。
- **重复截图不重复回图**：画面没变（捕获哈希相同）时只回一行文本。
- 合并档越粗 token 越少，但 16 px 合并后不再下降（单图地板约 196 tokens）；日常让 `target` 自动平衡即可。

## 可移植性

- **不写死分辨率/DPI/路径**：所有尺寸以 DIP 表达，运行时按显示器缩放换算为物理像素；坐标统一用虚拟桌面物理像素（多显示器可为负原点），每台显示器的 bounds/scale 由 helper 报告。
- **Per-Monitor-V2 DPI aware**：混合缩放的多显示器也能正确换算（设计目标，见下方实测说明）。
- **helper 首次运行本地编译**：`runtime/bootstrap.mjs` 用系统 `csc`（.NET Framework）把 `runtime/helper.cs` 编译成可执行文件，缓存在 `%LOCALAPPDATA%\dsh-click-matrix\helpers`（按源码哈希命名；可用环境变量 `DSH_CLICK_MATRIX_CSC` 指定编译器路径）；找不到编译器或编译失败会给出可操作的错误指引（缺 .NET / 路径 / 权限），不会静默降级。
- **设计目标**：Windows 10 1903+ / Windows 11，x64 与 ARM64。
- **实测说明**：目前仅在本机 **单显示器 2880×1800 @ 200%** 上完整验证；多显示器、混合 DPI、RDP/远程桌面场景**尚未验证**，遇到问题先跑 `click_matrix_doctor`。
- **自检**：`click_matrix_doctor` 覆盖 DPI 感知、显示器拓扑、截屏（含黑帧）、热键注册、覆盖层可用性/能否从截屏排除、UIPI 提权探测、helper 版本与协议。

## 配置

配置来自 bundle patch 的 `config:` **扁平对象**（见 `cordis.patch.yml`），也可以在更高优先级的 profile patch 里按 `- id: click-matrix` 覆盖。未知字段被忽略，数值会被校验/夹到安全范围。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `"ask"` | 安全模式：`off` / `ask` / `auto`（语义见上）。 |
| `lattice` | `"standard"` | 点阵间距档：`coarse` / `standard` / `fine` / `micro`。 |
| `binning` | `"target"` | 截屏合并档：`target` / `2` / `4` / `6` / `8`。 |
| `captureLongSide` | `1600` | 截屏输出长边上限（像素）。越大越清晰、越贵。 |
| `overlayMode` | `"auto"` | 覆盖层策略：`auto` = 仅 arm 期间自动显示 pill，解除/停止即隐藏；`on` = 插件启动即常驻 lattice+pill；`off` = 从不自动显示（工具仍可显式开关）。 |
| `armWindowMs` | `25000` | Host 审批通过/“允许一次”后开启的授权窗口时长（毫秒）。 |
| `armClicks` | `10` | 单个授权窗口内最多点击次数。 |
| `hotkeyArmMs` | `60000` | 用全局热键授权时的窗口时长（毫秒）。 |
| `maxImagesPerTurn` | `12` | 滑动窗口内最多返回的图像数。 |
| `maxImageTokensPerTurn` | `6000` | 滑动窗口内图像 token 预算。 |

> ⚠️ **改动本插件的 profile 配置会触发插件重载**（DSH 的行为，插件侧拦不住）：重载 = 新实例 = **内存里的常开授权与预算状态全部清零**，必须重新 `/click-matrix arm`。插件每次加载都会在审计里写一行 `plugin-loaded`，可用来对照「授权是哪次重载后丢的」。
| `minIntervalMs` | `150` | 两次鼠标注入的最小间隔（毫秒），防止"抽风式"连点。 |
| `denyProcesses` | `[]` | 追加拒绝的进程名列表（如 `["someapp.exe"]`）。系统级拒绝（DSH 自身、提权窗口、安全桌面）始终生效，不可通过此键关闭。 |
| `denyTitleContains` | `[]` | 追加拒绝的窗口标题子串列表。 |
| `auditMaxBytes` | `2097152` | 审计 JSONL 文件大小上限（字节），超出滚动。 |
| `helperTimeoutMs` | `20000` | 单次 helper RPC 超时（毫秒）；超时即杀掉 helper 并重启。 |
| `uiaTimeoutMs` | `4000` | UI Automation 读取超时（毫秒）。 |

运行时数据：审计日志 `<DSH_HOME>/click-matrix/audit.jsonl`（超过 `auditMaxBytes` 滚动）；点阵截图与放大图缓存在 `<DSH_HOME>/click-matrix/captures/`、`zoom/`；编译出的 helper 在 `%LOCALAPPDATA%\dsh-click-matrix\helpers`。

## 已知限制

- **UIPI / 提权窗口**：普通权限进程无法向管理员权限窗口注入鼠标（Windows 安全设计，不是 bug）。
- **UAC 安全桌面**：提权弹窗所在的安全桌面无法操控，必须由人自己点。
- **DRM / 受保护内容**：播放器或受保护窗口会截出黑帧；helper 返回 `blackFrame`，Host 报告失败而不是假装成功。
- **独占全屏游戏**：可能截黑屏或注入无效，需要先切窗口化。
- **安全软件**：首次注入鼠标时，火绒（Huorong）等 HIPS/杀软可能弹窗要求放行，请人工确认，并用 `click_matrix_doctor` 排查。
- **第三方应用条款**：自动化操作第三方 App 可能违反其 ToS；请自行确认并遵守目标应用的规则。
- **多显示器 / 混合 DPI / RDP**：设计上支持，但当前尚未实测。
- **鼠标键卡住时点击会被系统忽略**：现象是所有注入点击都没反应、`GetForegroundWindow()` 返回 0。`screen_info` 现在会同时显示 `按键未释放`（helper 自跟踪）与 `物理按键`（`GetAsyncKeyState`）。处置：`mouse_abort` 释放全部鼠标键后重试；仍无效就说明输入被系统忽略（前台锁 / 安全桌面），找人类。
- **`window_focus` 可能被前台锁拒绝**：Windows 拒绝后台进程抢前台时，插件会明确报**聚焦失败（前台锁）**并给出替代（`mouse_click` 点标题栏一次 = 激活 / 人类手动切换 / 先恢复最小化窗口）。另外批量动作后前台可能悄悄跳回 DSH，这是宿主/输入法抢焦点导致的，不是插件在点。
- **滚动没有位移不代表成功**：内容到底了 / 该区域不可滚动时，滚轮事件仍会「发送成功」。0.8.5 起会标注「⚠️ 内容未变化（可能已到边界或该区域不可滚动）」，看到它别重复滚。
- **`mouse_abort` 语义变更（0.8.5）**：默认只释放按键、**保留原授权**（含常开 latched）；想连授权一起清就传 `disarm:true`。
- **`npm run test:helper` 在本机是 54/59，5 项失败属环境限制而非回归**（2026-10-31 实测，与 v0.8.4 基线失败集合完全一致）：`Ctrl+Alt+F11/F12` 被另一个正在运行的 DSH helper 占用 ×3、PrintWindow 在窗口被遮挡时帧不稳 ×1、doctor 连带 ×1。**跑它前先完全退出其它 DSH/helper**；看到非 59/59 先对照这三条再判断。
- **`mouse_scroll` 首次滚动可能不报「内容未变化」**：光标刚跳到新位置时，前后两次 `captureHash` 取的是不同区域，第一次不做判定；同一位置第二次起才生效。属已知小瑕疵，滚两下即可确认。

## 常见问题 / 可能遇到的问题

| 现象 | 先检查什么 | 说明 |
|---|---|---|
| `click_matrix_doctor` 报 helper 编译失败 | `csc.exe` 是否存在、.NET Framework 4.x | helper 首次运行本地编译；日志会给出 csc 路径 |
| 首次点击被杀软拦下 | 是否信任源码/本地编译 | 需要人工放行；不要关闭杀软，先确认 helper 路径在 `%LOCALAPPDATA%` |
| 输入框没有「🖱 点阵」芯片 | 是否重启过 DSH | 客户端半部只在 DSH 启动时加载；重启一次即可，Host 工具不受影响 |
| 点击没反应/点错位置 | 是否授权、目标是否前台、是否高 DPI/多屏 | 先用 `screen_read`/`screen_capture` 确认坐标；提权窗口/UAC 安全桌面无法注入 |
| 点 DSH 自己窗口被拒 | `allowSelfWindow` 默认 false | 这是保护；确需开启时用人类命令并限定矩形（高风险） |
| `clientOnly` 截图报黑图 | 目标是否 Electron/Chromium | v0.8.2+ 自动回退整窗并说明；不需要处理 |
| `Ctrl+Alt+F12` / `Ctrl+Alt+F11` 不生效 | 是否被其它程序占用 | doctor 会显示热键注册状态；仍可用 `/click-matrix arm` / `stop` |
| 多屏/混合 DPI 下坐标偏 | 显示器缩放、主屏设置 | 代码按每屏 scale 计算，但**未真机验证**；先用 `screen_locate` 核对 |
| 跑 `npm run test:helper` 时屏幕被盖、鼠标乱跑、点不动 | 这是测试设计 | 全屏遮挡窗 + 注入键鼠 + 1.5 秒两点甩光标；等 `SUMMARY: 59/59` 完成 |
| `clipboard_get` 返回“没有文本” | 剪贴板被其它程序占用 | v0.8.1+ 明确提示并短重试；可 `press_keys ctrl+c` 后重读 |
| 所有点击都没反应、`GetForegroundWindow()` 返回 0 | `screen_info` 的 `按键未释放` / `物理按键` | 鼠标键卡住时系统会忽略所有注入点击；`mouse_abort` 释放后重试，仍无效属前台锁/安全桌面，需人工处理 |
| `window_focus` 报「聚焦失败（前台锁）」 | Windows 不让后台进程抢前台 | 按提示用 `mouse_click` 点标题栏一次激活、人工切换或先恢复最小化；不是插件坏了 |
| 滚了但页面没动 | `screen_info` 光标附近有没有可滚动区域 | 0.8.5 起会标注「内容未变化」；到边界 / 不可滚动区域就别重复滚 |
| `mouse_abort` 之后授权还在 | 0.8.5 默认保留授权 | 这是新语义；要连授权一起清就传 `disarm:true` |
| 升级后热键（`Ctrl+Alt+F12`/`F11`）不响应、插件像卡住 | 旧 helper 进程还在，与新 helper 抢同一组热键；后启动者要重试数十秒才 ready | **完全退出 DSH 再启动**；`/click-matrix doctor` 看「helper 版本 v8」与两个热键是否 `registered` |
| 截图/审计数据在哪、会不会上传 | `<DSH_HOME>\click-matrix\`、`%LOCALAPPDATA%` | 本地保存；截图按 DSH 附件机制发给你选择的模型，不额外上传插件方 |

## 分享 / 在别的机器安装（0.9.1）

> 这是本地插件，未发布到 npm；分享方式是给一个 **tgz 包**，目标机用 DSH 安装。

1. **打包**（在本仓库目录）：
   ```powershell
   npm pack        # 生成 dsh-click-matrix-0.9.1.tgz（约 100 KB，无 npm 依赖）
   ```
2. **目标机前置条件**：Windows 10/11 x64 · Node ≥ 22（DSH 自带运行时）· DSH ≥ `0.2.1-rc.2` ·
   `.NET Framework 4.x` 的 `csc.exe`（Windows 自带，helper 首次启动时编译，约 2–5 秒）· PowerShell 5.1。
3. **安装**：
   ```powershell
   dsh plugin --profile desktop add <路径>\dsh-click-matrix-0.9.1.tgz
   ```
   或把 tgz 解到本地目录后用 `link:` 依赖（开发用）。
4. **首次使用检查**：重启 DSH → `/click-matrix doctor` 必须 **PASS**（重点看「helper 版本=11」「急停热键已注册」「审计链」）；
   若 F11/F12 被占用，会**拒绝授权**并提示 `/click-matrix hotkeys-retry`——这是设计，不是故障。
5. **分享前的诚实说明**：见 `SECURITY.md` 与「已知限制」——本插件是**应用层护栏**，不防同一用户权限的恶意程序；
   浏览器打开 Web GUI 时自身界面保护依赖标题启发式。请只分享给信任的使用者，并保留默认 `mode=ask`。

## 验收状态（0.9.1）

| 项 | 结果 |
|---|---|
| 本机真机 | `click_matrix_doctor` **PASS 40/0/0**（helper v11 · 急停已注册 · 审计链 PASS） |
| 单元/回归 | `test-sec7 6/6`（链校验/篡改检出/旧行容忍/标题截断）· `mock-tests 15/15` · `c04-tests 12/12` |
| 安全用例 | `test-sec3 8/8`（自身窗口/双钥匙/完整性）· `d04b-tests 5/5`（B1/B10）· `test-sec4 7/7`（审计保留） |
| 历史验收 | v0.8.5.1 的 142/142 host、外部第二台机器 29/31（v0.8.3 记录） |

## 安装与使用

### 方式 A：一键安装（推荐，Windows）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 自定义 profile：-ProfileDir "C:\Users\you\.dsh\profiles\desktop"
```

1. 脚本会建 junction 并更新 profile `package.json`（自动备份），**无需手动改 YAML**。
2. 重启一次 DSH（客户端芯片需要重启加载）。
3. 新会话让 Agent 调 `click_matrix_doctor`，应 PASS 且工具数为 23。
4. 日常流程：`screen_info` → 先试 `screen_read`/`screen_text` → 需要看图时 `screen_capture` → `screen_locate` 吸附到点阵 → `screen_zoom` 精修 → 人类 `/click-matrix arm 30` 或 `Ctrl+Alt+F12` → `mouse_click` / `mouse_drag` / `mouse_scroll`；期间随时 STOP。

### 方式 B：手动 junction（0.2.1-rc.2 实测）

适用于不想运行脚本、或 DSH 版本没有 `plugin_manager` 的情况：

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-click-matrix" "D:\DSH-plugins\dsh-click-matrix"
# 编辑 profile package.json：
#   dependencies 增加  "dsh-click-matrix": "link:D:/DSH-plugins/dsh-click-matrix"
#   dsh.profile.bundles 末尾追加 "dsh-click-matrix"
```

保存后 Host 工具可热加载（客户端芯片仍需重启一次）。

### 可选：npm 安装

~~已发布到 npm~~ **已撤回（2026-11-04）**：npm 上 4 个版本均已 deprecated 并已申请整包删除，GitHub Releases 亦已随账号停用不可访问 —— **请勿安装**。
此段仅作为历史记录保留。桌面版插件页填 `dsh-click-matrix`，或用 CLI：`dsh plugin add dsh-click-matrix@<版本>`（装精确版本号可跳过 pnpm 的 24 小时发布等待期）。发布版不包含编译好的 helper：首次运行在 `%LOCALAPPDATA%\dsh-click-matrix\helpers` 用系统自带 `csc.exe` 本地编译（需要 .NET Framework 4.x，Win10/11 自带）。

### 发布到 GitHub（维护者）

```bash
git remote add origin https://github.com/<account>/dsh-click-matrix.git
git push -u origin master --tags
# 然后在 GitHub Releases 附件上传 dist 里的 zip + .sha256
```

卸载：移除 profile `package.json` 中的依赖与 bundles 条目、删除 junction/解压目录，再清理 `<DSH_HOME>\click-matrix\` 与 `%LOCALAPPDATA%\dsh-click-matrix\`。

CI：`.github/workflows/ci.yml` 在 `windows-latest` 上跑 `npm test`（无需安装依赖）。发布前建议 `npm run check && npm test`，并确认版本号与 `CHANGELOG.md` 一致。

> 本插件是 **host + client bundle**：Host 半部注册工具与命令，Client 半部在输入框左侧提供一个「🖱 点阵」状态芯片（轮询只读状态接口，授权/停止等动作通过提交 `/click-matrix` 命令执行，与人工输入等价）。配置通过上面的 patch `config:` 提供。

## v0.2 新增（对标竞品 + 领先点）

| 能力 | 说明 |
|---|---|
| **Esc 暂停 / 人类接管** | 授权窗口内按 `Esc` 或任意物理按键 → 立即中止并解除授权（helper 30Hz 轮询看门狗，只识别按下，不记录按键内容）；状态芯片显示「已暂停」 |
| **常驻授权提示** | 一授权就出现屏幕顶部状态胶囊「点阵已授权 · Esc/STOP 停止」，避免"AI 在操作但没人看得见" |
| **输入框状态芯片** | 「🖱 点阵」芯片：颜色点 + 授权 60s / 停止 / 矩阵开关 / 模式切换 / 自检；动作等价于人工输入命令 |
| **`mouse_batch`** | 一次调用顺序执行最多 20 个动作（move/click/drag/scroll/wait），只需一次授权；连续操作 token 成本可降 2–3 倍 |
| **键盘 / 剪贴板（可选、授权门控）** | `type_text`（Unicode 直投，绕过输入法）/ `press_keys`（白名单：enter、tab、ctrl+a、ctrl+c/v、f5…）/ `clipboard_get` / `clipboard_set`；与鼠标一样需要人类授权窗口，`config.enableKeyboard/enableClipboard=false` 可彻底关闭；文档明确禁止密码/验证码/支付场景 |
| **`screen_wait`** | 纯文本「等画面稳定」（轮询 captureHash，不返回图片），进一步省图片 token |
| **PrintWindow 后台窗口截图** | `screen_capture` 支持 `region:"window"`：被遮挡窗口也能抓取自身内容（最小化、UWP 有明确限制） |
| **只读状态接口** | `GET /api/click-matrix/status`（仅回环+同源），返回模式/授权剩余/可点次数/暂停状态；只读，不做任何变更 |
| **干扰检测** | 用户按键或外部移动鼠标打断注入轨迹 → 立即中止并解除授权，结果标记 `externalAborted` |

> 注意：**Client 半部（输入框「🖱 点阵」芯片）在插件首次加入后需要重启一次 DSH** 才会被客户端模块系统扫描到（DSH 按 Loader specifier 缓存 client 元数据到重启）；Host 侧工具、命令、热键与状态接口不受影响。`click_matrix_doctor` 会静态检查 client 半部的打包完整性。
>
> v0.2.1 修复：冷启动时 `commands` 服务晚于 `tools` 就绪会让 `/click-matrix` 命令静默漏注册（芯片授权/停止按钮与手动命令都失效）——改为可重试注册 + `ctx.inject(['commands'])`，状态接口新增 `commandsRegistered/commandServiceSeen/commandError` 诊断字段，doctor 新增命令注册检查。
>
> v0.3.0：**常开/关热键**（`Ctrl+Alt+F12` = 常开授权 ⇄ 关闭，Esc/STOP 仍立即关闭）；**时长可选**（芯片菜单 30 秒 / 2 分钟 / 10 分钟，命令 `/click-matrix arm <秒|on>`）；**人类活动自动暂停注入**——真人动鼠标或打字时暂停注入，停止操作满 `humanIdleResumeMs`（默认 20 秒）后自动恢复同一授权，无需重新授权。配置新增 `armDefaultSeconds`、`autoResumeHumanActivity`、`humanIdleResumeMs`。
>
> v0.3.1 修复：`lib/uia.ps1` 的 `Add-Type -PassThru` 在 MemberDefinition 含嵌套结构时返回数组，导致 `$script:Win32` 变成 Object[]、`screen_text`（UIA）全部失败（试用报告 P1-1）。已去掉未使用的 `GetWindowRect`/`RECT` 并按方法名显式选类型；foreground / pid / handle 三种模式实测可用。doctor 增加「UIA 自检」实时回归行。
>
> v0.4.0（试用报告全量修复）：**人类活动内部等待**（变更类工具遇 suspended 默认在工具内等待空闲，`humanWaitMaxMs` 默认 30s，超时才报错）；**mouse_batch 逐动作检查**（先执行再按当前 z-order 检查后续动作，失败返回“已执行 K/M”partial）；**`dryRun` 预演**（click/drag/batch 不注入、不消耗授权）；**窗口相对坐标**（`window`+`fx/fy`，capture 支持 `fw/fh` 子区域）；**`window_focus` / `wait_window`**（纯文字、无需授权）；**作用域 `allowSelf`**（`/click-matrix allow-self x,y,w,h [秒]`，仅 `allowSelfWindow=true` 时生效、仅 `mouse_click`、矩形内、全程审计）；常开授权文案改为“常开授权（不计数）”。helper v4 新增 `focus` 命令。
>
> v0.4.1（第二轮实测报告修复）：**UIA 非有限矩形容错**——WinUI/XAML 窗口（如 Windows 计算器）部分元素 `BoundingRectangle` 为 Infinity/NaN，旧代码 `[int]` 强转抛异常导致整个 `screen_text` 崩溃；现在按元素跳过非法矩形并 try/catch 容错。**越界 region 文案**——`screen_capture` 传超出虚拟屏的 `{x,y,w,h}` 时明确提示“区域超出虚拟屏幕 … 请夹取或改用 foreground”。**热键注册竞态**——helper v5 启动时对 Ctrl+Alt+F12 注册失败做 10×500ms 重试。文档补充：`window_focus`/`wait_window` 不注入输入但仍遵守人类活动暂停；审计记录注入动作、拒绝与生命周期事件（授权/暂停/恢复/急停/聚焦/命令），`mouse_move` 与只读工具不写审计，`type_text`/`clipboard_set` 只记字符数不记内容。
>
> v0.5.0（第二轮报告后续 4 项）：**图片预算自动降级**——`screen_capture` 在 token 预算不足但图片张数还剩时，自动把 binning 降一/多档重截一次（target→4→6→8），文案注明“已自动降清晰度”；全档不 fit 才报错。**UIA 最小化幻影坐标过滤**——整个矩形落在虚拟屏外 >200px 的元素直接跳过，最小化窗口不再返回 ±3 万坐标（`screen_text` 返回 0 元素提示改用截图）。**多显示器/混合 DPI 加固**（单元模拟验证）——修复 0 尺寸显示器幻影、非法 scale 回退 1x、primary 布尔容错、镜像重叠优先主屏、lattice scale 上界；新增 `tools/grid-smoke.mjs` 163 断言。**allowSelf**：策略由 `tools/access-smoke.mjs` 134 条断言覆盖；真机 6 项按人类决定本轮跳过，配置保持默认 `allowSelfWindow=false`（需要时由人类临时开启并用 `/click-matrix allow-self x,y,w,h [秒]` 授权矩形范围）。
>
> v0.6.0（续跑 + text-first 读屏）：**`mouse_batch` 可安全续跑**——动作级 `expectAfter {titleContains, process, timeoutMs}` 在动作后校验前台状态，不匹配即停并给出 partial + `expectAfterFailed:N` 审计；新增 `resumeFrom` 从第 N 个动作继续（前 N−1 个不重放、不检查、仍只消耗一次授权，模型须先确认已完成，建议先用 `dryRun`）。**新工具 `screen_read`（23 个工具）**——UIA 文本优先：元素足够时只返回紧凑文字（零截图、省 token）；UIA 不足/失败时自动退回小截图（长边≤720px，预算不足自动降 binning）。`screen_text` 提示优先用 `screen_read`。
>
> v0.7.0：**batch 人类活动后可选继续**——`mouse_batch` 新增 `resumeOnHumanIdle:boolean`（默认 false）：动作前遇人类活动暂停时，可选等待空闲（≤`humanWaitMaxMs`）后继续同一批；Esc/STOP/超时仍中止并给 partial。动作执行中被中断不会自动重试（状态不确定），建议人工确认后用 `resumeFrom:N`。**测试一键化**——`npm test`（access/grid/host/client mock 套件）与 `npm run test:helper`（需独占桌面的真实键鼠 smoke）。
>
> v0.8.0：**全局急停热键 `Ctrl+Alt+F11`**——helper v6 独立注册（无需授权、任何时候可按下）：立即中止在飞动作、释放按键、通知 Host 硬停（撤销常开/allowSelf、进入 paused 并要求人类重新授权、隐藏胶囊、写审计）。与授权热键 `Ctrl+Alt+F12` 相互独立。**仓库自检 `npm run check`**——检查全部 JS 语法、UTF-8 乱码/U+FFFD、版本一致性（index.js vs package.json）、必需文件与 client loader id；`npm test` 已自动包含。doctor 新增「急停热键」行。
>
> v0.8.1（外部验收反馈修复）：**fixture 自动构建**（`tools/build-fixture.mjs` + `pretest:helper`，干净机器直接 `npm run test:helper`）；PrintWindow 遮挡断言改为"遮挡后连续两次稳定 + 非黑帧 + 尺寸正确"；新增 `capture clientOnly`（PW_CLIENTONLY，客户区截图）；`clipboard_get` 支持 `requireText`/`hasText`/`reason` 并对空读短重试；状态接口新增 `helperPid/helperVersion/helperRestarts`；新增 `npm run release` 从 git HEAD 打包并用实际产物重算 `.sha256`。安装文档改为 junction + profile（0.2.1-rc.2 无 `plugin_manager`）。
>
> v0.8.2：**`clientOnly` 失败自动回退**——Electron/Chromium 等窗口不支持 `PW_CLIENTONLY`（返回黑图），现在自动改截整窗并在结果中说明，不再误报"原生 helper 不可用"；截图操作失败也不再冒充 helper 崩溃。测试说明补充：`helper-smoke` 会创建**全屏置顶遮挡窗口**并注入键鼠，运行期间 DSH 被盖住、点"新对话"点到遮挡窗是**测试设计**，不是故障。
>
> v0.8.3（发布包装）：新增一键安装 `install.ps1`、Release Notes、SECURITY.md；README 增加与 RPA/脚本库/云端 computer-use 的**定位对比**、30 秒快速开始、FAQ 与已知问题说明。功能与 v0.8.2 相同。
>
> v0.8.4（打包修复）：修复 `tools/release.ps1` 生成 `SHA256SUMS.txt` 时路径多出 `/pkg/` 前缀的问题；现在包内逐文件校验路径与 zip 内文件一一对应。功能与 v0.8.3 相同。
>
> v0.8.5（假成功与语义修正）：点击改用**真实前台窗口**验证 + 按键卡住时预检拒绝（`physicalButtonsDown`）、点击后无前台明确写 `clicked-no-foreground`；`window_focus` 明确报「聚焦失败（前台锁）」并给替代；`mouse_abort` **默认保留授权**（`disarm:true` 恢复旧语义）；`screen_read` 带 `query` 命中不足也先回元素、不自动退截图，输出带 `≈N tokens` 估算；`mouse_scroll` / batch scroll 新增 `detectNoMove`「内容未变化」标注；覆盖层 `hitTestable`；多行框给首行中心。helper v8。

> v0.9.1 覆盖修订（npm 上以 **0.9.2** 首次发布，内容相同）（`region` 参数强类型，修复"整轮被上游判死"）：`screen_capture` / `screen_wait` 的 `region` 原先在 JSON Schema 里**只有 description、没有 type/enum**，模型偶发输出 `{"region": foreground}`（枚举值漏引号）→ DeepSeek 流式解析报 `tool input is invalid JSON` / `MALFORMED_RESPONSE`，**整个 turn 直接终止**（工具根本没执行）。实测：一次 108 步 / 6 分 51 秒的真实任务在第 107 步因此报废；40 次 `screen_capture` 中 38 次带引号正常，2 次裸写即致命（≈5%）。现在 `region` 为 `type:"string"` + `enum`（`full`/`foreground`/`window`），自定义物理像素区域改用新增的强类型 `region_rect:{x,y,w,h}`；**旧写法继续兼容**（把对象放进 `region` 仍然可用）。回归 `tools/host-smoke.mjs` 142/142。

## 测试

```bash
npm test            # 一键跑 mock 套件：access / grid / host / client（无需真实桌面）
npm run test:helper # 真实键鼠 helper smoke；需先 kill 插件 helper、独占桌面、full-access
```

真机验收建议顺序：`npm test` → `npm run test:helper` → `click_matrix_doctor` → 实际任务（人类授权后）。`helper-smoke` 会短暂开全屏遮挡窗口并注入键鼠，跑前确认无人使用电脑。

## 目录结构

```text
dsh-click-matrix/
├─ index.js             # Host 入口：apply(ctx, config) 注册 23 个工具 + /click-matrix 命令
├─ client.js            # Client 半部：「🖱 点阵」输入框状态芯片
├─ lib/                 # 矩阵数学、安全门、审计、UIA 读取、doctor 等
├─ runtime/
│  ├─ helper.cs         # 原生 Windows helper（鼠标 + 键盘 + 剪贴板 + 截屏 + 覆盖层）
│  └─ bootstrap.mjs     # 首次运行本地编译（csc）并拉起 helper 的引导
├─ skills/click-matrix/ # 给模型的使用说明（SKILL.md）
├─ locale/{en,zh}.json  # 插件页显示用的中英文标题/描述
├─ icon.svg             # 插件图标
├─ cordis.patch.yml     # bundle patch（插入一个 root 插件行）
├─ PROTOCOL.md          # Host ↔ helper 的 NDJSON 协议
└─ README.md / LICENSE
```

## 致谢与声明

- 本插件**受 DSH computer-use / 桌面操控插件生态启发**（该生态中有 MIT 许可的先行作品），但为**独立原创实现**：协议、图标、代码均自写，未复制任何先行实现的代码。
- 本项目按"人工在场"的安全模型设计；请只在受控环境中使用，并自行承担自动化操作风险。
- 许可证：**MIT**（见 [LICENSE](./LICENSE)）。

## English summary

`dsh-click-matrix` is a host + client DeepSeek Harness bundle for safe desktop control. It overlays a **cross-point lattice** (never grid lines or labels) on screenshots so the model can aim by counting lattice points, with **two independent dials**: capture binning (`target`, or fixed `2/4/6/8`) and lattice spacing (`coarse` 180 DIP / `standard` 90 DIP / `fine` 45 DIP / `micro` 22.5 DIP; per-monitor scale aware, `screen_zoom` gives a 6×6 sub-lattice). A native helper (locally compiled C#) provides smooth mouse, UIA text observation, clipboard and PrintWindow capture.

Human-in-the-loop by design: default `mode=ask`; keep-on/time-boxed authorization via `Ctrl+Alt+F12` or `/click-matrix arm <seconds|on>`; Esc, STOP, or the independent **global abort hotkey `Ctrl+Alt+F11`** hard-stop and disarm immediately. Human mouse/keyboard activity suspends injection and auto-resumes after `humanIdleResumeMs`. `mouse_batch` supports one-authorization batches with per-action window checks, partial results, `expectAfter`, `resumeFrom` and optional `resumeOnHumanIdle`. `screen_read` is text-first (UIA first, image fallback), `screen_capture` downgrades resolution when the image budget is tight, `window_focus`/`wait_window` avoid blind clicks, and `dryRun` previews without injecting. `click_matrix_doctor` self-checks the environment and `npm test` / `npm run check` keep regressions out. MIT-licensed original implementation.
