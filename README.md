# dsh-desktop-hands

**一个包，三双手眼——像素对准、控件直取、笔画播放，共用一套授权、一个急停、一份审计、一份拒绝清单、一处设置。**

> 当前状态：**融合完成（①–⑥ 全部落地并验收）**。三个引擎已 vendor 进包内 `engines/`，共享授权（gate fan-out）、急停（StopBus hard/soft）、审计（schema v2）、拒绝清单（共享 deny-list）全部接线并在真机跑通。
> 融合只发生在外围（授权/急停/审计/规则/打包/命名/doctor），**三种注入实现不重写**（不重写＝不改时序、不改延迟）。

## 威胁模型（必读）

本包的授权 / 急停 / 审计都建立在**本机普通文件与本地 HTTP**上。目标是**防误操作 + 可追溯**，**不是**抵御本机的恶意进程或提权攻击者：

- **授权与急停状态是普通 JSON，无签名**：`~/.dsh/dsh-desktop-hands/gate.json`、`stop.signal`、`deny-list.json`，以及
  `~/.dsh/click-matrix/config-overrides.json`，都是**当前用户可写的明文文件**。任何能以该用户身份写盘的脚本
  都能改授权窗口、清掉急停、增删拒绝清单、放宽配置，而本包**察觉不到**（读到的永远只是「现在长这样」）。
- **审计是「防无意篡改」，不是防伪造**：审计链是 **key-less** 哈希链（`audit.jsonl` 逐行 `prev` 串联，无密钥、无远程锚点）。
  它能发现**事后手改 / 截断 / 乱序**这类无意或粗糙的篡改，但**不能**阻止知道算法的人把整条链重写一遍。
- **`sameOriginOk` 只防浏览器跨源**：pixel 的本地 HTTP 接口校验 `Origin` / `Host` 同源，作用域是**浏览器页面**
  （防别的网页偷偷 POST 配置或点鼠标）。**本机进程直接 POST 不受这条限制** —— 同用户下的任何程序都能调这些接口。
- **`DSH_HANDS_DATA_DIR` 可重定向数据目录**：设了它，`gate.json` / `stop.signal` / `deny-list.json` / 审计都搬去别处。
  测试隔离靠它；反过来也意味着**改一个环境变量**就能让某次会话读到另一套授权、另一份拒绝清单、另一处审计落点。
- **审批、`dryRun`、晶格预演、提示词里的红线，约束的都是「模型」**，不是恶意本地程序 —— 它们降低误触概率，不构成强制隔离。

**结论一句话：这是防误操作 / 可追溯装置，不是安全边界。** 同机同用户的恶意进程可以直接绕过它；
真正的边界是 Windows 账户隔离 + 别把不可信程序装进这个账户。

## 1. 装了什么（默认 25 工具 = 合并态；显式 `mergeReadSide=false` 回退 35 工具）

| 引擎 | 包 | 位置（包内） | 工具数 |
|---|---|---|---|
| 像素/晶格手 | `dsh-click-matrix` 0.9.5 | `engines/pixel` | 14（默认） / 24（`mergeReadSide=false` 回退） |
| 控件/截屏手 | `dsh-x2` | `engines/control` | 6 |
| 笔画手 | `dsh-stroke` | `engines/stroke` | 5 |
| | | | **25（14+6+5）默认 / 35（24+6+5）回退** |

> 2026-11-08 更新（I2-A 起）：pixel 读侧 7 个工具（`screen_info/capture/zoom/locate/text/read/wait`）与
> 窗口三件（`window_list/window_focus/wait_window`）已并入一个 `screen_view`（10 个 action）。
> `mergeReadSide` **默认 true（合并态）**：旧 10 个不注册 → pixel 14 / 全包 25 工具，描述字节 **−13.2%**（35,201 B vs 40,551 B）。
> 显式写 `mergeReadSide: false` 才回退到 24 / 35 工具（旧名保留原描述、不加 deprecated 注记；引导由常驻安全段承担）。
> 只改配置不改代码，**改完要重启 DSH**。

三个引擎已 **vendor 进包内**（含 x2 的 koffi + `@koromix/koffi-win32-x64` 原生库），不再依赖外部目录。
profile 用 4 条 link 指向本包（见 `复用说明.txt`）；三个引擎包内已去掉 `dsh.bundle`，所以**插件面板只显示 `dsh-desktop-hands` 一个**。

## 2. 停止语义（核心约定）

**一个通道、两种语义**：

| 键 | 语义 | 行为 |
|---|---|---|
| `Esc` / `Ctrl+Alt+F11` | **hard** | 立即停注入 + 归还鼠标按键；检测点下沉到 helper/worker（≤100ms） |
| `Ctrl+Shift+F11` | **soft** | 缓释到当前原子边界（不切断进行中的一步），报 `boundary`；继续需一次人类确认 |

原子块**不设时长上限**，用 hard 随时兜底切断。

## 3. 安装

**A. 必须写进 `dsh.profile.bundles`，只装依赖不算启用。**
**B. 先关旧 bundle 再开新 bundle**（同 id 两行 = 哪行 config 生效取决于顺序）。
**C. 改 profile 必须在 DSH 关闭时做**（desktop profile 被 Electron 独占）。

profile 的 `package.json` 写 4 条 link（全指向**本包所在目录**，路径以实际安装位置为准）：
```json
"dependencies": {
  "dsh-desktop-hands": "link:<本包绝对路径>",
  "dsh-click-matrix":  "link:<本包绝对路径>/engines/pixel",
  "dsh-x2":            "link:<本包绝对路径>/engines/control",
  "dsh-stroke":        "link:<本包绝对路径>/engines/stroke"
}
```
> ✅ **唯一源（2026-11-08 核定）**：本仓库。此前 `D:\LocalChat\dsh-desktop-hands` 等本地副本为旧归档（pixel/index.js 已分叉），不要再指向它们。
> ⚠️ `D:\LocalChat\dsh-desktop-hands` 是 2026-11-07 之前的**旧副本**（pixel/index.js 已分叉），只作归档，**不要再指向它**。
> 这 4 条 link 不要手写：`tools/profile-switch.mjs` 从脚本自身位置 (`%~dp0`) 推断绝对路径，换目录/换机器都不用改。
`dsh.profile.bundles` 用 `dsh-desktop-hands` 替换 `dsh-click-matrix`/`dsh-stroke`/`dsh-x2`。
然后 DSH 关闭状态下 `pnpm install --no-frozen-lockfile --prefer-offline` → 重启。

一键脚本（DSH 关闭时双击）：`一键部署.cmd`（封印审计+启用+install+校验）。边界要说清：**安装失败（第 5 步 pnpm install 出错 / 第 6 步包未落地）自动回滚**；**第 7 步 `check-bundle` 自检失败仅 WARN，需人工判断后手动回滚**——自检飘红可能只是 profile 门禁，自动回滚反而危险。另有 `一键回滚.cmd`。

> 前提：**Node.js 22+** 与 pnpm 在 PATH。预检会检查 Node 主版本、pnpm、.NET Framework 4.x `csc.exe`，缺哪项直接报错、不进入部署流程。本包在 **Node 22.22.2 与 24.20.0 双 Node 实测 verify 全绿**；DSH 宿主插件运行时是 **Electron 自带 Node 24.x**，`engines.node`（`>=22`）只约束自测 / pnpm 安装环境，不约束宿主运行时。

## 4. 验收结果（真机，2026-11-08）

| # | 验什么 | 结果 |
|---|---|---|
| 3 | 工具齐全 | **25 全在（默认合并态）**：doctor 14 + `screen_windows`(x2) + `stroke_status`(stroke)；显式 `mergeReadSide=false` 回退 35 |
| 5 | 延迟不劣化 | 改前基线 `mouse_click` dryRun p50 ≈ **6.5ms**（N=6）；合并后 ≈ 12ms，都在 20ms 噪声内，无劣化机制（注入层未重写） |
| 6 | token | **默认态 25 工具 −13.2%（35,201 B vs 单插件基线 40,551 B）**；显式 `mergeReadSide=false` 回退 35 工具 +15.1%（46,655 B） |
| 7 | 无重复芯片/热键 | `click_matrix_doctor` **PASS 44 / FAIL 0**；Ctrl+Alt+F11（hard）、Ctrl+Shift+F11（soft）都注册 |
| 8–12 | 真机热键 | hard 88ms/67ms 停、soft 边界停、继续需确认、helper 崩溃自动重启+热键重注册 —— 全过 |

## 5. 回滚

`一键回滚.cmd`（挑最新的 `package.json.bak-hands-*`，交给 `tools/profile-switch.mjs --rollback`）+ 桌面三个原插件复用包（各带 `dsh.bundle` 原版）可单独退回单插件形态。

> ✅ **回滚是字段级的（2026-11-08 起，`一键回滚.cmd` 同步受益）**：`--rollback <bak>` 只还原
> `dependencies` 里这 4 条（`dsh-desktop-hands` + 三个引擎 link）与 `dsh.profile.bundles` 里这 4 个名字的成员关系，
> 其余字段（别的插件、别的 bundle、scripts、version…）**保留当前值**。
> 2026-11-07 那次「整份覆盖把备份时点之后加的东西一起丢」的事故根因已消除。
> 注意：**备份本身仍是整份快照**，但只用它来决定那 4 个字段该长什么样；备份里没有的 `dsh-desktop-hands`
> 会被撤销、它在 bundles 里的条目会被移除。
> 回滚前会把**当前** package.json 备份成 `package.json.bak-rollback-*`（回滚本身可再回滚；这个名字故意不带
> `bak-hands-` 前缀，避免被一键脚本当成「最新 hands 备份」而误选）。

## 6. 明确不做（一直如此）

- ❌ 重写注入实现（改时序/延迟）；
- ❌ 新增 UI / 悬浮球 / 语音 / 混合手势工具（涨 token）；
- ❌ 发布 npm（**源码公开，但不发 npm**；本包整体 MIT，`dsh-x2` 为 ql0423/dsh-screen 的本地 fork（MIT），保留署名 + 去掉 `private: true` 即可再分发）。

> ⚠️ 上一条「涨 token」**不是**说「现在不涨」——现状要看清：
> **默认 25 工具（合并态）比单插件基线 −13.2%**（35,201 B vs 40,551 B）；显式 `mergeReadSide=false` 回退 **35 工具 +15.1%**（46,655 B）。
> 「不新增 UI」的意思是**不再往上叠**这层增量；合并收益自 v0.2.6 起在默认态已兑现，只有显式 `mergeReadSide=false` 才回到 35 工具回退态。

## 7. 使用边界

**允许**：在自己负责的机器上做桌面自动化 / RPA——重复填表、驱动没有 API 的软件、界面测试、辅助功能、教学演示；所有写操作仍由人授权（`Ctrl+Alt+F12` 或命令），随时可 `Esc` / `Ctrl+Alt+F11` / STOP 中断。

**不允许**（不属于本工具范围）：

1. 操作不属于你的设备、账号或数据，且未取得所有者明确授权；
2. 绕过安全机制（UAC / 杀软 / EDR / 反作弊 / 访问控制）或规避平台风控；
3. 读取、输入、导出他人的凭据、验证码、支付信息或隐私数据；
4. 在对方不知情时把本工具部署到他人设备上运行；
5. 任何违反所在地法律法规、目标软件服务条款或组织安全政策的用途。

**它不是什么**：不是研究 / 红队工具，不以安全研究为分发目的；不是任意代码分发渠道；不提供远程控制、凭据采集或安全机制干预能力。

## 8. 分发与维护

- **只以源码分发**：本仓库是唯一源；不发 npm，不提供二进制资产。
- 三个引擎与七个运行时依赖按各自许可 vendor 在 `engines/`（清单与许可见 `THIRD-PARTY-NOTICES.md`）。
- 安装方式是本地路径安装（见 §3），不做"一键安装包"发布。
