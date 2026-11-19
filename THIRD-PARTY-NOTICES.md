# THIRD-PARTY-NOTICES

本包不复制、不内联第三方源码：三个引擎作为**引擎子包** vendor 在 `engines/{pixel,control,stroke}`，各自保留自己的 LICENSE 与署名。
**七个运行时 npm 依赖**（pixel 3 个 / control 4 个：`koffi` 及 `@koromix/koffi-win32-x64`、`@deepseek-ai/*`、`@standard-schema/spec`）
以及 stroke 的 C# helper **一并 vendor 进包内**（见下），同样保留各自 LICENSE 与出处。
本文件列出它们的来源与许可，**不合并成单一 LICENSE**。

## dsh-x2（0.6.0-local.1）→ `engines/control`

- 来源：**ql0423/dsh-screen** 的本地衍生版
- 许可：**MIT**（原仓库许可，允许再分发，条件是保留版权与许可声明）——**本地自用是既定决策，不是许可限制**
- 本地改动：P0 授权闸门 / 热键 / 审计 / 晶格；P1 zoom、多显示器、失败回滚；P2 长文本分批等
- 原生依赖：koffi（MIT）→ 已 vendor 进 `engines/control/node_modules`
- 注意：`package.json` 标注 `private: true` 是**本机自用策略（D2 拍板）**，不是 MIT 的许可限制

**vendored npm 依赖**（均在 `engines/control/node_modules/`，各自保留 LICENSE）：

| 包 | 版本 | 许可 | 说明 |
|---|---|---|---|
| `koffi` | 3.3.6 | MIT | FFI（Win32 调用） |
| `@koromix/koffi-win32-x64` | 3.3.6 | MIT | koffi 的 win32-x64 原生二进制（`win32_x64/koffi.node`） |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.5 | MIT | 工具注册/执行管线（DSH 宿主） |
| `@deepseek-ai/schemastery` | 3.18.5 | MIT | 配置 schema |

## dsh-click-matrix（0.9.5）→ `engines/pixel`

- 许可：**MIT**
- 说明：本机自研（晶格点击 + helper 注入），含内建拒绝清单与哈希审计链
- 原生/运行时构件：`engines/pixel/runtime/helper.cs`（本机自研 C#，Win32 P/Invoke），由包内
  `runtime/bootstrap.mjs` 在首次调用时用**系统自带** .NET Framework `csc.exe`（v4.0.30319）**现场编译**，
  包内**不预置 pixel 的 .exe**（全包唯一的预编译件是 stroke 的 helper，见下）；编译产物落在 `%LOCALAPPDATA%\dsh-click-matrix\helpers`（按源码哈希缓存），不入交付树。

**vendored npm 依赖**（均在 `engines/pixel/node_modules/`，各自保留 LICENSE）：

| 包 | 版本 | 许可 | 说明 |
|---|---|---|---|
| `@deepseek-ai/cosmokit` | 1.8.6 | MIT | 工具函数 |
| `@deepseek-ai/schemastery` | 3.18.5 | MIT | 配置 schema |
| `@standard-schema/spec` | 1.1.0 | MIT | 校验器接口规范 |

## dsh-stroke（0.1.0）→ `engines/stroke`

- 许可：**MIT 兼容**（本地自用，未单独发布）
- 说明：笔画播放 + helper（C# 编译的 runtime），会话级授权

**C# helper**（本机自研，非第三方源码，唯一来源是 `engines/stroke/runtime/stroke-helper.cs`，约 18 KB）：

- `runtime/stroke-helper.exe` —— **包内唯一的预编译件**（18,944 B，**未签名 / NotSigned**），由同目录的
  `stroke-helper.cs`（唯一源）预编译而来，可直接对照 `.cs` 复核；`engines/stroke/index.js:35` 的
  `DEFAULT_HELPER` 指向它，`start-helper.cmd` 直接拉起它 —— **它是笔画引擎的默认路径，不是可移出件**；
- `runtime/stroke-helper.ps1` —— 同一 C# 核心用 `Add-Type` 在 `powershell.exe` **内存里编译**（本机安全软件
  拦截自研 exe 注入时的替代宿主）；**接收方若要全源码路径，可改用这个 ps1 内存编译，不依赖预编译 exe**；
- 两者只依赖 .NET Framework 4.x 随系统自带的程序集（`System.Drawing` / `System.Windows.Forms`），
  **不引入第三方运行时**。审计预置二进制时对照同目录 `.cs` 复核。

## 包内实验产物（已移出交付）

- 历史版本里 `engines/*/experiments/*.exe` 是**调试实验品**（探针/临时构建），不是功能组成、没有支持承诺，
  也不代表可分发许可。**当前活树已不含 `experiments/` 目录**（`engines/stroke/DESIGN.md` 里对
  `experiments/README.md` 的引用是历史遗留，非现行交付物）；
- 当前交付树 = 源码 + 文档 + 可核验的构建脚本（`runtime/*.cs` + `bootstrap.mjs` / `stroke-helper.ps1`），
  **唯一的预编译件就是上面列出的 `engines/stroke/runtime/stroke-helper.exe`**（未签名，同目录 `.cs` 可复核；
  它是 stroke 引擎默认路径，故保留，不再标注为「待移出」）。

---

## 再分发条件（如需对外发布时，逐条满足即可）

本包整体为 **MIT**（见本包 `LICENSE`），三个引擎均为 MIT/兼容许可。**技术上可再分发**——**本地自用是既定决策，不是许可限制**，只需：

1. 保留本文件 + 三个引擎各自的 `LICENSE` 原文与作者署名（ql0423/dsh-screen 的 MIT 署名在 `engines/control/LICENSE`）；
2. 保留上表里 vendored npm 包各自的 LICENSE（它们已随 `node_modules/` 落盘）；
3. 去掉 `private: true`（本包 + `engines/control`）；
4. 复核 koffi 及其平台原生包（`@koromix/koffi-win32-x64`）、`@deepseek-ai/*`、`@standard-schema/spec` 的许可（均为 MIT）；
5. 如实标注包内**唯一预编译件** `engines/stroke/runtime/stroke-helper.exe`（未签名，18,944 B，源码为同目录
   `stroke-helper.cs`，可复核）；接收方若要求全源码路径，改用 `runtime/*.cs` 现场编译（`bootstrap.mjs` /
   `stroke-helper.ps1` 已内置路径），或从分发包中移除该 exe 后切到 `stroke-helper.ps1` 内存编译；

> **本地自用是既定决策，不是许可限制**：当前不发布、不上传是 D2 的本地决策——这是「产品化但本地化」的定位，不是「不可分发」。
