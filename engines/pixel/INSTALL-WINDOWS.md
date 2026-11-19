# dsh-click-matrix v0.8.0 — Windows 离线安装说明

这是 `dsh-click-matrix` DSH 桌面操控插件的离线移植包。目标机器要求：

- **Windows 10/11（x64）**，仅支持 Windows；
- **DSH（DeepSeek Harness）desktop 0.2.1-rc.x**（`engines.dsh: >=0.2.1-rc.2 <0.3.0`）；
- .NET Framework 4.x（Win10/11 自带；helper 首次运行用系统 `csc.exe` 本地编译，无需另外安装）；
- 可选：Node.js ≥22（只有跑测试才需要；日常使用不需要）。

## 一、解压

把 zip 解压到任意目录，建议：

```text
D:\DSH-plugins\dsh-click-matrix
```

路径可以含中文，但建议短、无空格，避免后续命令麻烦。

## 二、安装到 DSH

> 注意：DSH desktop 0.2.1-rc.2 的会话工具集**没有** `plugin_manager`（较新版本才有）。下面两条路任选其一，**方法 B 已在 0.2.1-rc.2 实测通过**。

**方法 A：有 `plugin_manager` 的新版 DSH**

在目标机器 DSH 会话里让 Agent 执行 `plugin_manager install_bundle`，指向解压目录并启用（写入 profile，对所有会话生效）。

**方法 B：junction + profile（0.2.1-rc.2 实测）**

```powershell
# 1) 在 profile 的 node_modules 里建 junction（路径按实际改）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-click-matrix" "D:\DSH-plugins\dsh-click-matrix"

# 2) 编辑 %USERPROFILE%\.dsh\profiles\desktop\package.json：
#    dependencies 增加  "dsh-click-matrix": "link:D:/DSH-plugins/dsh-click-matrix"
#    dsh.profile.bundles 末尾追加 "dsh-click-matrix"
```

保存后**无需重启**即可热挂载 Host 工具（23 个）；**客户端「🖱 点阵」芯片需要重启一次 DSH** 才加载。
若有新版 CLI，也可用 `dsh plugin --profile desktop add link:D:/DSH-plugins/dsh-click-matrix`。

装好后新开会话，确认工具列表出现 `screen_*` / `mouse_*` 等 23 个工具。

## 三、首次检查

1. 新开一个会话（让工具列表刷新）；
2. 让 Agent 调 `click_matrix_doctor`，应看到 **PASS（WARN/FAIL 为 0）**；
3. 第一次调用截图/点击工具时，会在 `%LOCALAPPDATA%\dsh-click-matrix\helpers\` 本地编译 helper（第一次约几秒到几十秒，属正常）。

## 四、使用与安全

- 模型**不能给自己授权**；需要人类操作：
  - `Ctrl+Alt+F12`：常开/关闭授权切换；
  - 或输入 `/click-matrix arm <秒|on>`；
  - 或点输入框左侧「🖱 点阵」芯片选 30 秒 / 2 分钟 / 10 分钟 / 常开。
- **急停**：`Esc`、`Ctrl+Alt+F11`（全局急停热键，随时可用）、胶囊 STOP、`/click-matrix stop`。
- 人类动鼠标/打字时插件会自动暂停注入，空闲约 20 秒后自动恢复同一授权。
- 默认 `allowSelfWindow=false`：不允许点击 DSH 自身界面；默认 `mode=ask`。
- 不要用于密码、验证码、支付、网银、系统安全对话框。

## 五、可选：在目标机器跑测试

如果目标机器装了 Node.js ≥22：

```powershell
cd D:\DSH-plugins\dsh-click-matrix
npm run check     # 语法/乱码/版本一致性/文件检查
npm test          # mock 测试，不需要真实桌面
npm run test:helper  # 真实键鼠 smoke：需独占桌面、先关掉插件 helper
```

没有 Node 也可以跳过测试，不影响正常使用。

## 六、卸载

先移除加载项，再删目录：

1. 从 profile `package.json` 的 `dependencies` 移除 `"dsh-click-matrix"`，从 `dsh.profile.bundles` 移除 `"dsh-click-matrix"`；
2. 删除 profile `node_modules\dsh-click-matrix`（junction 本身，不会删源目录）；
3. 删除解压目录，以及：
   - `<DSH_HOME>\click-matrix\`（审计/截图缓存）
   - `%LOCALAPPDATA%\dsh-click-matrix\`（编译出的 helper）

若你的 DSH 版本提供 `plugin_manager`，也可以用它 remove_bundle。

## 七、已知限制

- 仅 Windows；多显示器/混合 DPI 未真机验证（有单元模拟测试）；
- `allowSelf`（点 DSH 自身窗口）默认关闭，真机未验证；
- 管理员权限窗口、UAC 安全桌面、DRM 内容无法自动化（Windows 安全设计）；
- 安全软件可能首次拦截本地编译的 helper，请人工放行；
- 客户端芯片在插件首次安装后需要**重启一次 DSH** 才会加载。

## 八、版本与校验

- 版本：**0.8.4**
- 工具数：23
- 包内 `SHA256SUMS.txt` 是 zip 内文件的校验清单；同名 `.sha256` 文件是 **zip 本身**的校验值，由 `npm run release` 用实际产物重新计算（不再复用旧值）。
- 校验命令：

```powershell
$expect = (Get-Content .\dsh-click-matrix-0.8.4-win64.zip.sha256).Split()[0]
$actual = (Get-FileHash .\dsh-click-matrix-0.8.4-win64.zip -Algorithm SHA256).Hash.ToLower()
if ($expect -ne $actual) { throw "sha256 mismatch" } else { "OK" }
```

- 源码历史见发布者仓库的 `CHANGELOG.md`；本离线包不含 `.git`。
