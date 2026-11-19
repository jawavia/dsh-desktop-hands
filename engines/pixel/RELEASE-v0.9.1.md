# RELEASE v0.9.1（2026-11-03）

> 定位：**可安全分享的小版本**。无新工具、无新依赖（`dependencies` 为空），
> 重点是审计可验证、隐私收敛、失败语义更严，以及可直接打包分发。
>
> 本文件不进 npm 包（不在 `package.json` 的 `files` 白名单里），
> 因此 tarball 只含运行所需文件。**2026-11-03 覆盖修订后：45 个文件 / 301,933 B / sha256 `0144EC16…`**
> （旧附件 295,849 B / `2ca570df…` 已被同名覆盖，见下面 §0）。
>
> ### §0 覆盖修订（同一版本号 0.9.1，2026-11-03）
>
> - **P0**：`screen_capture` / `screen_wait` 的 `region` 原先只有 description、没有 `type`/`enum`，
>   模型偶发输出 `{"region": foreground}`（枚举值漏引号）→ 上游报 `tool input is invalid JSON` /
>   `MALFORMED_RESPONSE`，**整个 turn 直接终止**（实测一次 108 步会话在第 107 步报废）。
>   现在 `region` 为 `type:"string"+enum`，自定义像素区域用 `region_rect:{x,y,w,h}`，旧写法继续兼容。
> - `window_list` 每行补 `hwnd=0x…`；`window_focus` 提示 PID/handle 混淆；`press_keys` 补
>   `ctrl+n`/`ctrl+w`/`ctrl+tab`（helper 按键表同步，双修饰键未加）；图片预算默认 6/2000 → **12/6000**；
>   加载时写 `plugin-loaded` 审计（含 pid）；审计链区分「多实例并发写分叉」与「篡改」。
> - 回归：`npm test` 142/142 · `verify-dsh-plugin` PASS · 23 个工具 schema 结构校验 0 问题。

## 1. 本版改了什么

### 安全语义（会影响行为，升级必读）

| 编号 | 改动 | 行为变化 |
|---|---|---|
| D-08 | helper 未注册急停热键时**拒绝** arm/注入 | 没有"刹车"就不允许开车；env 降级只能降级、不能静默放行 |
| D-09 | helper 非预期重启后**冻结注入**，需人类 `ack` | 防"重启绕过授权" |
| D-10 | 审计不可写时**拒绝注入**（fail-closed） | 宁可不做，也不留无法追溯的操作 |
| D-07 | helper 来源事件标 `helper-event(unverified)` | 不再冒充 human 事件 |
| 自身窗口保护 | 进程名 + DSH 自身界面标题 + pid 树（**仅 self + 子孙**） | 防"自批准环"；不会误伤 Explorer |
| D-13 残余 | 只释放"插件自己注入的键"，不合成释放人类按住的键 | 拖拽不再被无端打断 |
| D-12 | 胶囊拆为"点击穿透文字层 + 独立 STOP 窗"，移到屏幕底边 | 不再压标题栏；`stopChannels` 只报实测可点通道 |
| 批量基线 | 审批前采基线，drag/无目标滚轮也有基线；容差随 DPI；`resumeFrom` 必须先同批 dryRun | 审批期间被挪动会被检出 |

### 审计

- **哈希链（tamper-evident）**：每条审计行新增 `seq` / `prev` / `h`（sha256 链式引用上一条）；
  `AuditLog.verify()` 跨所有保留代校验；doctor 新增「审计链」PASS/FAIL；
  编辑、插入、重排、截断会报 `hash-mismatch` / `chain-break`。
- **保留策略**：轮转保留 N 代（默认 5），取代只留 1 代。
- **隐私脱敏**：窗口标题截断到 80 字符（句柄/矩形保留），其余字段沿用既有 bound（字符串 ≤300）。

### 可分享 / 可分发

- 版本号改为合法 semver：`0.8.5.1`（4 段）→ `0.9.0` → **`0.9.1`**。
  4 段版本号会让声明了 `link:` 依赖的 profile 在 pnpm 安装/卸载任何插件时
  报 `ERR_PNPM_BAD_PACKAGE_JSON`；本版修复。
- `npm pack` 只含运行所需文件（**45 个，301,933 B**，覆盖修订后），无依赖、无测试残留、无 `*.bak-*`（备份已移出仓库）。
- README 新增「分享 / 在别的机器安装」一节。

### helper

- 版本 **9 → 11**：新增 `process_tree`、`retry_hotkeys`、`safeToArm` / `hotkeys`、
  `pointProbe`、`stopHitTestable`、`physicalButtonsDown` 等。
- 编译产物旁写 **sha256 sidecar**，缓存命中时校验；`DSH_CLICK_MATRIX_HELPER`
  覆盖需要第二把钥匙且标记 `unverified`。
- 崩溃循环保护（D-06）：`restarts` 计数 + `/click-matrix helper-reset` 复位。

### UI / 诊断

- client 芯片新增「需确认重启」「审计不可写」红色告警态，footer 显示链头前 6 位；
- 胶囊文字改为「点阵 · 就绪」；
- doctor 命令帮助补全 `ack` / `helper-reset` / `hotkeys-retry`；
- D-03：DPI 不感知窗口截图不再 2× 错位（按内容包围盒裁回 + `mismatch` / `targetDpi` 字段）。

## 2. 证据（本版实测）

| 项 | 值 |
|---|---|
| 回归 | `node tools/host-smoke.mjs` → **142/142 通过** |
| tarball | 45 files / 301,933 B / sha256 `0144EC1637DBD21A672CAEB0783B043B0B17209CE39C996E06BD9DBECBA7B7AE`（覆盖修订后） |
| helper v11 | `helper-11-f5b9b097dfccb5cc7d55551380441dd4c3468212af17714b0b7578f3cf6ecddc.exe`（87,040 B） |
| helper sha256 | `57c7785106dd1c855192d5a969b06329aa3a250ea91a37ceaa526d8c1dfa1a43`（与 sidecar 一致） |
| doctor | `helper: version=11 protocol=ok`、`急停热键 ✅ Ctrl+Alt+F11 已注册` |

复现命令：

```bash
node tools/check-repo.mjs
node tools/host-smoke.mjs
npm pack --pack-destination dist && sha256sum dist/dsh-click-matrix-0.9.1.tgz
```

## 3. 升级注意

1. profile 的 `dsh.profile.bundles` 必须含 `"dsh-click-matrix"`，否则不会加载；
2. 升级后**完全退出** DSH 再启动（helper 会按新源码重编译为 `helper-11-*`）；
3. helper 重启后第一次动作可能需要重新确认（D-09），属预期；
4. 旧 `helper-10-*` / `helper-9-*` 可保留，也可手动清理。

## 4. 已知限制（诚实边界）

- **审计链无密钥**：能发现"静默改动"，挡不住同用户"删除并重写整条链"——
  它是证据可读性，不是不可篡改存储。
- **与其它注入类插件互斥**：本插件安装低层鼠标钩子后，其它插件通过 `SendInput`
  的合成输入会被吞掉（本机实测）。同一时间只启用一个注入类插件。
- 仅 Windows；UAC 提权/安全窗口一律拒绝；`PrintWindow` 失败时需改用屏幕区域截图。
