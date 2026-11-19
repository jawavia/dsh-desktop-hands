# CHANGELOG

## v0.2.6 (2026-11-08，I2-A：mergeReadSide 默认切 true)

用户拍板 I2-A：**默认态 = 合并态**，装完即兑现收益，回退路径保留。

- **默认值**：`engines/pixel/lib/config.js` `mergeReadSide: false → true`；`normalizeConfig({})` 实测 **true**，`{mergeReadSide:false}` 与 `'false'` 为 false，`'nonsense'` 回落 true。
- **工具面**：默认 **pixel 14 / 全包 25**（旧 7 读 + 3 窗口不再注册，`screen_view` 10 action）；显式 `mergeReadSide=false` 回退 **24 / 35**。
- **字节**：默认 25 工具 **35,201 B**（desc 7,992 + param 24,618 + output 2,591），对单插件基线 40,551 B **−13.2%**；回退态 35 工具 46,655 B（+15.1%）。
- **host-smoke 145 → 146 项**：三组覆盖 —— 默认组（14 工具、旧 10 不注册、`screen_view` 可用、doctor「14 个:」PASS）、回退组（显式 false=24、旧名不改写）、独立 runtime 组（同 base 下 false=24 / 不写=14，差集正好旧 10 个）。
- **check-bundle**：默认期望 25（14+6+5）、回退 35；静态核对改两档「源码声明 24 = 默认生效 14 + 旧 10」，旧 10 名单从 `doctor.js` 的 `READ_SIDE_LEGACY_TOOLS` + `WINDOW_SIDE_LEGACY_TOOLS` 解析（解析失败直接 FAIL）。
- **assert-surface**：`PIXEL_NAMES` 24→14（= doctor `EXPECTED_TOOLS` − 旧 10，并用运行时探针反核）、`EXPECTED_TOTAL=25`、P4 断言改 `mergeReadSide:\s*true`、F 段只剥离 `action:"…"` 值并加负向测试（追加 `window_list`/裸 `wait_window` → exit 1）、`--selftest` 的 `cpSync` 改逐文件复制（**Node 22.22.2 + 中文路径**下删工具 → exit 1 且点名，不再崩溃）。
- **`tools/baseline.json` 按运行时注册清单重录**（非手改数字）：engines 14/6/5、tools 25、totals 35,201、groups/tools 逐项一致、nameCheck ok、delta/metric/tree.sourceHashes 结构保留。
- **doctor**：默认态走合并态期望清单；`mergeReadSide=true` 时 v0.4 窗口工具检查 PASS（已并入 `screen_view`），显式 false 仍走 24 旧清单。
- **验证读数**：`assert-surface` PASS（41 条判据，Node 24 与 Node 22.22.2 中文路径各一轮）；`host-smoke` **146/146**；`check-bundle` PASS；`integration-smoke` **17/17**；`verify` **17/17（Node 24.20.0 与 22.22.2 各一轮）**。
- 版本 **0.2.6**；`复用说明.txt` / README / 一键脚本 echo 的「35 默认 / +13.4%」旧口径全部清理为「25 默认 / −13.2%，显式 false 回退 35」。
### 补充（16:0x，README 旧口径补丁）
- 修正 `README.md` 两处遗留旧口径：§1 更新段（「默认 false / 切 true 后 25」→「默认 true / 25；显式 false 回退 24/35」）与 §6「收益锁在灰度开关、默认态先保行为不变」（→「合并收益自 v0.2.6 起已兑现」）。
- 按 I3 刷新 `tools/BUILD-ID.json` 后重新打包；本轮最终 buildId 见 `tools/BUILD-ID.json` 与验收清单 `_merge/snap/live-tree-accepted10-20261108.sha256`（不写死数字以避免再次自引用漂移）。


## v0.2.5 (2026-11-08，第三方整改指令 I1–I6；runtime 未改)

按 `整改指令-DeepSeek-Harness-v0.2.5.md` 执行。**engines/src 与注入层零改动**（不改时序/延迟），本轮只动交付、配置默认值口径、文档与测试基建。

### I1 Node 门槛（选方案 A：回 >=22）
- 根与三个 `engines/*/package.json` 的 `engines.node` **>=24 → >=22**；`一键部署.cmd` 预检阈值回 22；`复用说明.txt` 回到 Node.js 22+。
- 依据：本版在 **Node 22.22.2 与 24.20.0 双 Node 实测 verify 全绿**（见下方读数）；上版 13/15 的根因是 `node:test` 实验性 `mock.module`，**与 Node 版本无关**。DSH 插件的运行时是 Electron 自带 Node 24.x，`engines.node` 只约束自测/pnpm 环境。

### I2 mergeReadSide 默认值 —— **未改，等用户决策**
- A（切默认 true，兑现 −13.2%）｜B（保持 false，文档明示取舍）——指令要求不得替用户拍板，本轮保持 `false`。
- 现状口径：默认 35 工具 / 源码 schema 46,655 B（较基线 40,551 B **+15.1%**）；切 true 后 25 工具 / 35,201 B（**−13.2%**）。README §1/§4/§6 已按此写实。

### I3 单一源变机制（BUILD-ID）
- 新增 `tools/BUILD-ID.json` + `tools/build-id.mjs`（`--update` 刷新 / `--check` 校验；指纹 = 全树排除 node_modules/.git，按路径排序后逐文件 sha256 流式汇总）；**打包前必须 `--update`**。
- `check-bundle.mjs`：解析 profile 里 4 条 link 的**实际目标目录**，上溯到包根读 `BUILD-ID.json`，与包内 buildId 比对；不一致 **FAIL 并打印实际路径 + 两边 buildId**。
- 反例实测：把 `dsh-x2` 指向 `D:\LocalChat\dsh-desktop-hands\engines\control` → **exit 1**，两条 FAIL（引擎目标漂移 + 目标树无 BUILD-ID），正常态 exit 0。
- `verify.mjs` 新增第 **17** 项「BUILD-ID 自洽」；`integration-smoke.mjs` 删掉并行期的 `IN_FLIGHT` 排除列表，改为全量复算。

### I4 stroke-helper.exe 口径（选①保留）
- 包内唯一预编译件：`engines/stroke/runtime/stroke-helper.exe`（18,944 B，**NotSigned**；同目录 `.cs` 为唯一源；`engines/stroke/index.js:35` 的 `DEFAULT_HELPER` 指向它；`start-helper.cmd` 直接拉起）。`THIRD-PARTY-NOTICES` 删掉「不进任何分发包」等不实表述；接收方可用 `stroke-helper.ps1` 走全源码路径。

### I5 文档口径与回滚边界
- 三处（README / THIRD-PARTY ×3 / 复用说明）统一为「**本地自用是既定决策，不是许可限制**」（MIT 允许再分发，保留署名 + 去 private 即可）。
- `复用说明.txt` 版本 → 0.2.5、verify → 17 项；README 一键部署回滚描述改为「安装失败自动回滚；第 7 步 check-bundle 自检失败仅 WARN，需人工判断后手动回滚」；`一键部署.cmd` / `一键启用.cmd` 的 `[7/7] verify` → `check-bundle`。

### I6
- `integration-smoke.mjs` 用到的 `core/gate.mjs`、`core/abort.mjs` 处加注释「参考实现：生产路径以三引擎真实 gate 为准」，未扩大改动。

### 补充（同日 15:1x，交付前双 Node 自测发现并修复）
- **Node 22 + 中文解压路径**下 `dryrun-smoke` 崩溃（exit -1073740791、零输出）：根因是 Node 22.22.2 的 `fs.cpSync` 在**源路径含中文**时崩（本包解压目录带「复用包解压」）。改用逐文件 `readFileSync`/`writeFileSync` 复制沙箱 → Node 22.22.2 与 24.20.0 双 **17/17**。
- **`mergeReadSide=true` 时 doctor 误报 WARN**：窗口三件已并入 `screen_view`，`window_focus`/`wait_window` 合并态本来不注册，旧检查当成"注册失败"。改为合并态 PASS（校验 `screen_view` 在册），两种模式仍 fail-closed。

### 读数（Lead 实测，Node 24.20.0；详见交付报告）
- `verify` 17/17（Node 24.20.0 与 22.22.2 各一轮）· `check-bundle` PASS · `build-id --check` PASS · `integration-smoke` 17/17
- I3 反例 exit 1；正常态 exit 0；真实 `gate.json` / `audit.jsonl` 跑前跑后指纹不变

## v0.2.4 (2026-11-08，第三方评审整改；runtime 未变)

第三方对本包做了一次不留情面的评审，本轮按其中可立即执行的项整改（**未改 engines/src，运行时代码零改动**）：

- **README 新增「威胁模型（必读）」**：授权/急停/审计建立在明文 JSON + 本地 HTTP 上，目标是防误操作与可追溯，**不是**安全边界（同机同用户恶意进程可直接绕过；审计是 key-less 链，只防无意篡改）。
- **测试可移植**（原先只在本机 Node 24 通过、外部 Node 22 上 13/15）：`dryrun-smoke` 去掉 `node:test` 实验性 `mock.module`，改为临时沙箱 + 计数桩模块（24/24，连跑 3 次）；`host-smoke` 的 human-idle / resumeOnHumanIdle 组由墙钟改**事件驱动**（断言一条未放宽），连跑 5 次 145/145，另 4 并发 4/4。`engines.node` 统一 **>=24**（唯一实测环境 24.20.0）。
- **新增 `tools/integration-smoke.mjs`（17 项检查）**：跨三引擎 seam —— 一次 arm 让 pixel/control/stroke 三 scope 同时 armed、disarm 后全 false、StopBus 信号互通、共享 deny-list 三方同源；审计落点与清单工具可跑。接进 `verify`（15 → **16 项**）。
- **`profile-switch.mjs`**：修 `if (!existsSync(bakPath)) rmSync(...)` 反条件；`--rollback` 从「整份 package.json 覆盖」改为**字段级**（只还原 4 条 link 依赖 + bundles 里本包成员，其余字段保留当前值；写前留 `package.json.bak-rollback-*`）。
- **交付卫生**：包内未签名 exe 由 6 个减到 1 个（`experiments/` 与 `stroke-helper2/3.exe` 移出到工作区 `_merge/attic/`，未删除）；桌面 ZIP 改用 UTF-8 文件名标志重新打包；`THIRD-PARTY-NOTICES` 补 vendored 包版本表；`check-bundle` 旧注释/旧数字清理；`assert-surface` 去掉 `D:/DEEPSEEKworkplace` 绝对路径候选；README §4 日期与 §6 口径更正（默认 35 工具 +13.4% / 合并 25 工具 −13.2%）。
- **遗留（需用户决策）**：`mergeReadSide` **默认值仍是 false**（合并模式要靠配置+重启兑现）；要把它变成默认，需同步改 `assert-surface` 与 `host-smoke` 的默认态断言。

## v0.2.3 (2026-11-08)

**定源 + 止血（合并 P0 阶段）。**

- **定源（D1）**：活树 = 本仓库；`D:\LocalChat\dsh-desktop-hands` 标为**旧归档副本**（pixel/index.js 已分叉），README 里的 4 条 link 示例不再指向它；
- 修 `tools/seal-audit.mjs`：原来 `import ... from 'file:///D:/LocalChat/dsh-click-matrix/lib/audit.js'` 指到包外旧目录（换机必崩，而它是「一键部署.cmd」第 2 步）→ 改为包内 `../engines/pixel/lib/audit.js`；实测临时目录封印 + verifySealed 通过；
- **`screen_act` / `screen_sequence` 的 `dryRun` 变成真预演**（control 引擎 dsh-x2 0.6.0-local.1）：以前 `screen_act` 没有这个参数、传了被静默忽略然后真点；现在零注入/零移动/零截图/不消耗授权，并报告「正式执行会不会被拒」；注入层加了两道 `dryRun` 兜底守卫。自测 `engines/control/test/dryrun-smoke.mjs` 24/24；
- 新增 `tools/assert-surface.mjs`（fail-closed 工具面断言，21 条判据）并接进 `tools/verify.mjs`；`verify` 从 11 项变 **13 项，全 PASS**；
- **P4 读侧合并（灰度中）**：新增 `screen_view`（action 枚举收编 `screen_info/capture/zoom/locate/text/read/wait`）；灰度开关 **`mergeReadSide`（默认 false）**：
  - `false` = 加新不动旧：pixel 24 / 全包 **35** 工具，旧 10 个（7 读 + 3 窗口）**保留原描述、不再加 `[deprecated → screen_view]` 注记**（2026-11-08 09:14 定稿：引导改由常驻安全段承担，默认态每轮省约 1.7 KB），行为与今天一致；
  - `true` = 旧 10 个（7 读 + 3 窗口）不再注册：pixel **14** / 全包 **25** 工具，字节 −5,350 B（−13.2%，35,201 vs 40,551）；
  - 回滚 = 改配置 + 重启，不改代码。切法：`<DSH_HOME>/click-matrix/config-overrides.json` 写 `{"mergeReadSide": true}`，或 `POST /api/click-matrix/config`，或 profile patch。
  - `SKILL.md` 与常驻安全段已改为只教 `screen_view`（红线一字未动）；`doctor` 的「工具清单」按当前模式比 24/17。
- **描述瘦身（09:14 那笔未记录改动的收尾，2026-11-08）**：`screen_view` 描述 **1006 → 320 字符**（7 个 action 的完整对照表移入 `SKILL.md`，常驻段保留一行"不确定时先 screen_view"）；旧 7 个读工具**不再加 deprecated 注记**。同步补齐：`assert-surface` 判据改成「无注记 + 常驻段有引导」（三条同时成立才 PASS）、**漂移基线随包分发到 `tools/baseline.json`**（`screen_view` 行按新基线重录，其余 34 行未动；`assert-surface` 的候选路径把包内相对路径放第一位，换机也能跑 H 段）、README/CHANGELOG/进展文档口径对齐；版本 pixel **0.9.3 → 0.9.5**、umbrella **0.2.2 → 0.2.3**。默认态字节 48,290 → 45,976（−2,314）。
- **P6 窗口合并（2026-11-08）**：`window_list` / `window_focus` / `wait_window` 三件并入 `screen_view`（`action=list/focus/wait_window`），与读侧共用同一份 splice 表；`screen_view` 参数 28→32、描述 320→358 字符。默认仍 35 工具（旧名保留、无注记），`mergeReadSide=true` 时 pixel 14 / 全包 25。同步更新 `assert-surface`（10 action 断言 + 阈值 32/600）、`doctor` 双模式期望清单、`host-smoke` 两模式测试、`SKILL.md`、`tools/baseline.json`。
- **审计统一（Q7）**：control 的审计从 `%TEMP%\dsh-x2` 搬到 `~/.dsh/dsh-desktop-hands/audit/control.jsonl`（`arm.json` 不动）；**stroke 从"一条不写"补成每次调用留一行** `audit/stroke.jsonl`（写失败不崩，但安全动作会明说「未留痕」）；pixel 维持在 `~/.dsh/click-matrix/audit.jsonl` 作历史主链。三份都认 `DSH_HANDS_DATA_DIR`。新增只读体检 `tools/audit-report.mjs`。
- 修 CI 偶发红：`host-smoke` 的 `mouse_batch resumeOnHumanIdle` 用例原来固定 80ms 发「人类在动」，慢机上会抢在第一次点击前 → 误报；改为「等第一下点击真的发生后再发」，断言不放宽（改前 5 次红 3 次，改后 5/5 绿）。
- `verify` 再加 2 项（control 审计路径 24 检查 / stroke 审计 42 检查）→ **15 项**；
- README §5 补回滚警告：`.bak-hands-*` 是**整份 package.json 还原**，会连带抹掉备份时点之后新增的其它插件配置（11-07 同类事故）；
- 验证：`verify` 11/11。

## v0.2.2 (2026-11-07)

**分发适配（换机器/换目录可直接用）。**

- `一键部署.cmd` / `一键回滚.cmd` / `一键启用.cmd`：不再写死 `D:\safebox...` / `D:\LocalChat...`，改为 `PKG=%~dp0`（脚本自己所在目录）+ `node`/`pnpm` 走 PATH（缺失时报错提示安装）；
- `一键部署.cmd` 开头新增**预检**：Node 22+（读 `process.versions.node` 判主版本）/ pnpm 在 PATH / .NET Framework 4.x `csc.exe`，缺哪项直接报错并给安装提示，不进入部署流程；
- `tools/profile-switch.mjs`：三个引擎的 link 依赖（`engines/pixel|control|stroke`）也由脚本从本包根目录推算并写入，不再依赖手改；
- 复用说明补充「换机器/换目录」安装流程与前提（Node 22+ / pnpm / .NET Framework 4.x）；
- 验证：`profile-switch.mjs` 预演确认 4 条依赖全部纳入管理；`verify` 11/11。

## v0.2.1 (2026-11-07)

**设置界面 + 三层 ACL。**

- 设置页新增「屏幕控制」分栏（`settings.section`）：显示并可编辑运行时配置（数字/开关/名单），改动即时保存、重启生效；
- 名单四块（拒绝/放行/申请/内置只读）**折叠式**（点标题展开），数值项常展开；内置安全清单只读展示，不可修改；
- 新增 `schemastery Config`（`lib/schema.js`）：31+ 字段声明类型/范围/步进/默认值，与 `lib/config.js` 运行时夹取 1:1 对齐；
- 新增 `GET/POST /api/click-matrix/config`：GET 返回运行时配置，POST 只接受安全可调项（`mode`/`requireAbortHotkey`/`allowSelf*` 一律拒绝），值经 `normalizeConfig` 夹取后原子持久化到 `config-overrides.json`；
- 新增**三层 ACL**（放行 / 拒绝 / 申请；优先级 拒绝 > 放行 > 申请 > 默认）：
  - 拒绝 = 拦；放行 = 豁免「申请」（盖不过拒绝和内置安全清单）；申请 = 命中后工具返回「需人类确认」；
  - 配置字段 `allowProcesses / allowTitleContains / askProcesses / askTitleContains`；
- 测试：access-smoke 140 项（含三层 ACL 优先级断言）、host-smoke 143（含 config 路由写入/夹取/跨站拒绝）、verify 11/11。

## v0.2.0 (2026-11-07)

**融合完成 + 本地产品化。** 从「骨架」到「自包含融合包」。

- 三引擎 **vendor 进包内** `engines/{pixel,control,stroke}`（含 x2 的 koffi + 原生库），不再依赖外部目录；
- 共享层全部接线并真机验收：授权 fan-out（gate.json）、急停 StopBus（hard/soft）、审计 schema v2（engine/approver + 旧链封印）、拒绝清单共享（deny-list.json）；
- 热键定稿：Esc / Ctrl+Alt+F11 = hard，Ctrl+Shift+F11 = soft，删 x2 F8/F9/F10；
- 三引擎去掉 `dsh.bundle` → 插件面板只显 `dsh-desktop-hands` 一个；
- 新增 `tools/verify.mjs` 本地验证流水线（一条命令跑全量检查 + 测试 + 语法，等价本地 CI）：**11/11 通过**；
- 清理仓库杂物（.tgz/.bak/截图/dist/.test-*）；
- 基线：`mouse_click` dryRun p50 ≈ 6.5ms；工具 schema 未变 → token 零增。

## v0.1.0 (2026-11-07)

- 骨架：一个 bundle 挂三行 insert（`click-matrix` / `dsh-x2` / `dsh-stroke`），id 与原插件一致；
- 工具 34 个（23 + 6 + 5）名字与行为不变；三家 `config` 默认值不变；
- 新增 `tools/check-bundle.mjs`、`tools/profile-switch.mjs`、`一键部署.cmd`、`一键回滚.cmd`。

> 许可与再分发说明见 `THIRD-PARTY-NOTICES.md`。
