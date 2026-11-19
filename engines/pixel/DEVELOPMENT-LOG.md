# dsh-click-matrix 开发日志

> 记录这个插件从最初的点阵点击原型，到 v0.8.4 的迭代过程。
>
> **关于早期版本**：v0.1–v0.7 没有进 git（git 是到 v0.8.0 才初始化的），也没有留下完整源码副本；下面的内容根据 `CHANGELOG.md`、当时的试用/验收报告和 DSH 会话日志整理，**属于重建记录**。现存最早的完整代码是 **v0.8.0**，已作为代表版本保存在 `dist/`。

## 一、起点：为什么做这个插件

最初的诉求很直接：

1. 让 DSH 里的 Agent 能“看见屏幕、点鼠标”，而不是只能处理文本；
2. 截图和坐标不能靠猜，要有一套模型容易读的坐标系；
3. 桌面控制必须安全：人类不授权就不能动，任何时刻能停，出了事能追查；
4. 成本要可控：截图是图片 token 的大头，不能每次操作都整屏重截。

围绕这四点，整个项目的主线一直是：**点阵定位 + 平滑鼠标 + 人类在环 + 全程审计**。

## 二、版本迭代总览

| 版本 | 一句话主题 | 关键变化 |
|---|---|---|
| v0.1.0 | 原型可用 | 十字点阵截屏/缩放/定位 + 平滑鼠标；默认 ask、人工授权、拒绝名单、JSONL 审计、doctor、本地 C# helper |
| v0.2.0 | 从“能点”到“能办事” | batch、可选键盘/剪贴板、screen_wait、PrintWindow、Esc/人类活动暂停、授权胶囊、输入框芯片、状态路由 |
| v0.3.0 | 授权体验与人类让行 | `Ctrl+Alt+F12` 常开/关、时长可选、人类活动自动暂停与空闲恢复 |
| v0.3.1 | 修 UIA 与冷启动 | UIA `Add-Type` 数组 bug、`/click-matrix` 冷启动漏注册、doctor 增加 UIA 自检 |
| v0.4.0 | 更细的授权与操作语义 | 人类等待、batch 逐动作 partial、dryRun、窗口相对坐标、focus/wait_window、作用域 allowSelf |
| v0.4.1 | 稳定性修补 | UIA WinUI 元素 Infinity、越界 region 文案、helper 热键注册重试（helper v5） |
| v0.5.0 | 成本与屏幕边界 | 图片预算不足自动降清晰度、最小化窗口 UIA 幻影过滤、多显示器/DPI 加固 |
| v0.6.0 | 省 token 与安全续跑 | `screen_read` text-first、batch `expectAfter`/`resumeFrom` |
| v0.7.0 | 人类活动后继续 + 一键测试 | `resumeOnHumanIdle`、`npm test`/`test:helper` |
| v0.8.0 | 全局急停 + 仓库自检 | helper v6 `Ctrl+Alt+F11`、`npm run check`、23 个工具 |
| v0.8.1 | 外部验收反馈修复 | fixture 自动构建、PrintWindow 断言、clientOnly、clipboard requireText、status helper 信息、release 脚本 |
| v0.8.2 | clientOnly 回退 | Electron/Chromium 的 PW_CLIENTONLY 黑图自动回退整窗 |
| v0.8.3 | 发布包装 | `install.ps1`、SECURITY、Release Notes、对比/FAQ 文档 |
| v0.8.4 | 打包修复 + npm 发布 | 修复 `SHA256SUMS.txt` 的 `/pkg/` 路径 bug；发布到 npm |

## 三、逐版本记录

### v0.1.0：先证明“这条路能走”

**目标**：跑通“截屏 → 模型读点阵 → 换算坐标 → 注入鼠标”的闭环。

**做了**：
- 点阵截图：截图图上叠加十字点阵（不是网格线），模型用坐标纸的方式描述目标；
- `screen_zoom`：局部放大 + 6×6 子点阵，做二次精修；
- `screen_locate`：屏幕坐标 → 最近点阵点；
- 平滑鼠标：move/click/drag/scroll，通过本地编译的 C# helper + `SendInput`；
- 默认 `mode=ask`，人类授权窗口，拒绝名单，JSONL 审计；
- `click_matrix_doctor` 环境自检。

**为什么这么设计**：
- 直接把整屏截图交给视觉模型，坐标误差和 token 成本都不可控；点阵让模型“数格子”，比“猜像素”稳定；
- 鼠标注入不能放在 Node 里做，需要一个常驻的、可审计的原生 helper。

**当时的局限**：只能单步操作，没有 batch；键盘/剪贴板未开放；人类一操作就可能和注入打架。

### v0.2.0：从“能点”到“能办事”

**驱动**：单步点击太慢，真实任务经常需要“点开菜单 → 输入 → 再点确认”。

**做了**：
- `mouse_batch`：一次授权执行多步；
- 可选 `type_text` / `press_keys` / `clipboard_get` / `clipboard_set`（与鼠标共用授权门）；
- `screen_wait`：纯文本等画面稳定；
- `screen_capture` 支持 PrintWindow（被遮挡窗口也能抓）；
- Esc / 人类按键暂停注入；
- 授权胶囊 + 输入框「🖱 点阵」芯片 + 只读状态路由。

**修过的问题**：
- 热键 arm 自己触发“人类输入”暂停 → 加基线快照、忽略修饰键、300ms arm 宽限；
- bootstrap 缓存旧 helper → 每次重新计算源码哈希；
- `/click-matrix` 在冷启动时漏注册 → 命令注册加可重试逻辑。

### v0.3.0：授权不能打断人的正常使用

**问题**：每次操作都要授权、且默认 60 秒太短；人一动鼠标插件就暂停，恢复还要重新授权，体验割裂。

**做了**：
- `Ctrl+Alt+F12` 改为**常开/关切换**（常开不过期）；
- 芯片菜单时长 30 秒 / 2 分钟 / 10 分钟 / 常开；
- 人类鼠标/键盘活动 → 暂停注入；停止操作满 `humanIdleResumeMs`（默认 20 秒）→ 自动恢复同一授权；
- 配置新增 `armDefaultSeconds`、`autoResumeHumanActivity`、`humanIdleResumeMs`。

**安全取舍**：常开不是“永久免授权”，Esc / STOP / 急停仍然立即关闭；后来 v0.8.0 又加了独立的全局急停热键。

### v0.3.1：两个隐蔽的“看起来像功能坏了”的 bug

1. **UIA 全部失败**：`Add-Type -PassThru` 在含嵌套结构时返回数组，`$script:Win32` 变成 `Object[]`，`screen_text` 全挂。
   - 修复：去掉未使用的 `GetWindowRect`/`RECT`，按方法名显式选类型；doctor 增加 UIA 实时自检。
2. **`/click-matrix` 冷启动漏注册**：commands 服务晚到，Cordis 属性访问抛错。
   - 修复：可重试注册 + `ctx.inject(['commands'])` + 安全候选访问 + 状态字段。

### v0.4.0：把“什么时候能操作”讲清楚

**做了**：
- 工具内部遇到人类活动时**等待空闲**（默认最多 30 秒），而不是直接报错；
- batch 每个动作前做窗口检查，失败返回 partial「已执行 K/M」，不假装全部成功；
- `dryRun` 只预演、不注入；
- 窗口相对坐标 `window`+`fx/fy`；
- `window_focus` / `wait_window`；
- 作用域 `allowSelf`（仅人类命令、仅自身窗口矩形内单击，默认关闭）。

**原因**：真实任务里，模型经常在“人还在操作”时调用工具；直接失败会让它反复重试，既慢又危险。partial 语义则避免模型误以为 batch 全成功。

### v0.4.1：边界条件的补丁

- UIA 对 WinUI/计算器元素给出 `Infinity` 矩形 → 逐元素 NaN/Infinity 跳过；
- 越界 `region` 的报错改成明确的“区域超出虚拟屏幕”；
- helper v5：热键注册失败 10×500ms 重试，修复 kill 重启竞态（A/B 复现过）。

### v0.5.0：别让一张截图把预算打爆

**问题**：整屏截图 + 图片预算过紧时，模型会直接拿不到图，任务卡死。

**做了**：
- 图片预算不足 → **自动降 binning 重截一次**，宁可给低清图也不直接失败；
- UIA 过滤虚拟屏外 >200px 的幻影元素（最小化窗口会给出 ±30000 坐标）；
- 多显示器/混合 DPI 加固：0 尺寸幻影屏、非法 scale、primary 容错、镜像重叠优先主屏、lattice scale 上界；
- 新增 `tools/grid-smoke.mjs`（163 断言）。

**没做的事**：`allowSelf` 真机验证被人类决定跳过，保持默认关闭。

### v0.6.0：省 token，也允许安全续跑

- 新工具 `screen_read`：UIA 文本优先，元素足够就**零截图**返回；不足才退回小图；
- `mouse_batch` 支持动作级 `expectAfter`（执行后校验前台窗口）和 `resumeFrom:N`（前 N−1 个不重放，须先确认状态）。

**原则**：续跑不是“自动重试”，而是把“已经做了什么”诚实告诉模型和人类。

### v0.7.0：batch 遇到人也能体面处理

- `resumeOnHumanIdle:true`：动作前遇人类活动暂停时，等待空闲后继续同一批；
- Esc/STOP/超时仍然中止；动作执行中被中断**绝不自动重试**（状态不确定）；
- 测试一键化：`npm test`（mock 四套件）与 `npm run test:helper`。

### v0.8.0：最后一道安全阀

- 独立全局急停热键 **`Ctrl+Alt+F11`**（helper v6）：无需授权、任何时候可按下；中止在飞动作、释放按键、撤销常开/allowSelf、进入 paused、写审计；
- `npm run check`：语法、UTF-8 乱码/U+FFFD、版本一致性、必需文件、client loader id；
- doctor 增加急停热键状态；工具数达到 **23**。

### v0.8.1：外部验收反馈修复

第二台机器验收报告提出 7 条反馈，修复了其中的 P0/P1/P2：

- **发布包缺 `test/bin/fixture.exe`（P0）**：干净机器跑不了 helper-smoke；
  - 新增 `tools/build-fixture.mjs` + `pretest:helper`，helper-smoke 惰性解析并在缺失时自动构建；验证“删掉 test/bin 后自动编译再 59/59”；
- **PrintWindow 遮挡断言误报**：标题栏激活/非激活配色变化导致 captureHash 不可能全等；
  - 改为“遮挡后连续两次稳定 + 非黑帧 + 尺寸正确”；
- **clipboard_get 静默空串**：被其它程序抢剪贴板时返回 ok+0 字符；
  - helper 增加 `requireText`、`hasText`/`reason`、内部短重试；
- **capture clientOnly**：用 `PW_CLIENTONLY` 截客户区；
- **status 暴露 `helperPid/helperVersion/helperRestarts`**；
- **发布脚本**：`npm run release` 从 git HEAD 打包并用实际产物重算 `.sha256`。

### v0.8.2：clientOnly 的黑色真相

真机验证时发现：**Electron/Chromium 窗口的 `PW_CLIENTONLY` 会返回黑图**，而旧代码把错误误报成“原生 helper 不可用”。

- 修复：检测到 `PW_CLIENTONLY` 黑图 → 自动回退整窗截图，并在结果里说明“该窗口不支持客户区截图”；
- 截图操作失败不再冒充 helper 崩溃。

### v0.8.3：让第一次安装更体面

- `install.ps1`：junction + profile package.json，自动备份、幂等；
- `SECURITY.md`：安全模型、数据去向、已知边界、漏洞报告；
- `RELEASE-v0.8.3.md`、README 增加“与 RPA/脚本库/云端 computer-use 的定位对比”、30 秒快速开始、FAQ；
- 明确：GitHub 优先，npm 暂不发布（后来改变）。

### v0.8.4：打包的最后一个坑

- 发现 release zip 内的 `SHA256SUMS.txt` 路径多了 `/pkg/` 前缀（短路径 vs 长路径导致 substring 算错）；
- 修复 release 脚本，改为以 `(Get-Item $pkg).FullName` 为基准取相对路径；
- 重新打包验证：**44/44 个包内文件校验全部通过**；
- 随后发布到 npm：`dsh-click-matrix@0.8.4`（官方源与 npmmirror 均已同步）。

## 四、走过的弯路 / 事故记录

### 1. PowerShell 重写文件导致中文乱码

一次用 PowerShell 重写 `host-smoke.mjs` 时触发 UTF-8/ANSI 编码损坏，中文测试名被破坏。后来从会话日志回放 `write/edit` 事件重建文件，并加上了 `npm run check`（检测 U+FFFD 和常见乱码标记）。**教训**：改代码尽量用编辑工具，不要用 shell 重写含中文的源码。

### 2. 测试脚本“看起来像插件坏了”

`helper-smoke` 的 PrintWindow 遮挡测试会创建**全屏置顶遮挡窗口**；外部干扰测试会用 PowerShell 让光标在两点间高速甩约 1.5 秒（两次）。运行期间 DSH 被盖住、鼠标乱跑、点“新对话”会点到遮挡窗——这全是**测试设计**，不是插件故障。已在 `TEST-PLAN-WINDOWS.md` 写明。

### 3. git 仓库损坏

2026-10-31 10:23 左右，`.git` 只剩 `objects/` 和 `refs/`，`HEAD`、`config`、`index` 丢失，`git` 报 `not a git repository`。通过备份 + `git init` + `symbolic-ref` + `reset` + `fsck` 恢复。**教训**：尽早初始化 git、定期打 tag、重要节点备份 `.git`。

### 4. DSH 里 pnpm 安装 npm 包失败（EPERM）

本机 profile 里曾有一个指向本地开发目录的 **junction**；pnpm 在最后一步把新包 rename 进 `node_modules` 时被这个 junction/正在运行的 DSH 卡住：

```
ERR_PNPM_EPERM ... rename '...dsh-click-matrix_tmp_...' -> '...dsh-click-matrix'
```

同时 profile 里还有 GitHub 源依赖（`dsh-ego-browser`），每次安装都要访问 codeload.github.com，造成“转很久”的错觉。

**处理**：移除 junction，使用 npm 已下载的 tarball 手动部署到 profile 的 `node_modules`，补齐 dependencies/bundles；DSH 重启后 `doctor` 通过。**结论**：在 DSH 运行中让插件管理器接管 `node_modules` 容易撞锁；更新时先退出 DSH，或使用本地 `install.ps1`/离线包。

### 5. npm 发布的插曲

- 第一次用 scoped token 发布被 403：token 只覆盖 `@<account>`，不含无作用域的 `dsh-click-matrix`；
- 改用 all-packages + 2FA bypass 的临时 token 才成功；
- npm 对首次发布有处理延迟，刚发完 registry 只显示 `0.0.0-stage` 占位，几分钟后 `latest=0.8.4` 才出现；
- 发布完成后**立即撤销了 3 个临时 token**。

## 五、设计决策与经验

1. **先定安全模型，再加功能**：默认 inert、人类授权、三层急停、审计，是后面所有功能的前提。
2. **模型友好 ≠ 功能多**：点阵、text-first、partial 结果、明确的“下一步建议”，比多一个工具更重要。
3. **诚实地失败**：截图黑帧、窗口不支持 clientOnly、batch 只执行一半，都明确报告，不假装成功。
4. **测试要覆盖“干净机器”**：fixture 自动构建、release 脚本用实际产物算哈希，都是外部验收踩出来的。
5. **版本要尽早进 git**：v0.1–v0.7 只留在会话和记忆里，源码已经无法完整找回；v0.8.0 是现存最早完整存档。
6. **文档也是交付物**：安装方式、限制、FAQ、测试题、事故记录，能显著减少“看起来像 bug”的误报。

## 六、当前状态（v0.8.4）

- 工具：23 个；helper v7；Windows 10/11 x64；DSH desktop 0.2.1-rc.x；
- 自动化测试：host 130/130、access 134、grid 163、helper 59/59、client PASS；doctor PASS 40；
- 发行：GitHub Release + npm `dsh-click-matrix@0.8.4`；
- 已知未验证：真机多显示器/混合 DPI、allowSelf 真机、长跑/并发、OCR。

## 七、下一步（如果继续）

1. 真机多屏/混合 DPI 验证；
2. `index.js` 模块化拆分 + CI 扩展；
3. OCR/视觉兜底（UIA 覆盖不到的画面文字）；
4. 把 v0.8.0 之前的设计草图/关键提交说明补进文档（如果能从旧会话里找回）。
