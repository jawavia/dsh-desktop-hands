# 内建拒绝清单（DENY-LIST）

> 适用版本：v0.9.3 起
> 实现位置：`lib/policy.js` 的 `DEFAULT_DENY_PROFILES` / `matchDefaultDeny()` / `evaluateWindowDeny()`
> **工具层强制执行**：不在 `config.json` 里，配置改不动，`allowSelf` 也放行不了。

## 为什么会有这份清单

不是所有误点都能靠"撤销"弥补。安全软件面板里点一下"关闭防护"、凭据管理器里点一下"显示密码"、磁盘管理里点一下"删除卷"——后果不可逆。所以默认把这三类窗口设为**不可操作**。

## 三组默认拒绝

| 组 ID | 名称 | 匹配方式 | 覆盖对象 |
|---|---|---|---|
| `security` | 安全软件面板 | 进程名 + 标题关键词 | 火绒（`HipsMain.exe` / `HipsTray.exe`）、360（`360Safe.exe` / `360Tray.exe`）、腾讯电脑管家（`QQPCTray.exe`）、Windows 安全中心（`SecurityHealthSystray.exe` / `SecurityHealthUI.exe`）；标题含「Windows 安全中心」「火绒安全软件」 |
| `credential` | 凭据管理器 | 进程名 | 1Password、Bitwarden、KeePass / KeePassXC、Dashlane、Enpass、Keeper |
| `system-config` | 系统配置工具 | 进程名 + 标题精确匹配 | 进程：`regedit.exe`、`taskmgr.exe`、`compmgmtlauncher.exe`；标题精确匹配：「注册表编辑器」「磁盘管理」「服务」「组策略编辑器」「本地安全策略」「事件查看器」「任务计划程序」「系统配置」「BitLocker 驱动器加密」 |

> 为什么 `system-config` 用标题精确匹配：这些工具常由同一个 `mmc.exe` 承载，按进程名会误伤所有 MMC 窗口，所以按窗口标题判断。

## 判定顺序

```
1. 目标点下没有顶层窗口            → 拒绝
2. helper 标记的拒绝窗口            → 拒绝
3. 管理员权限窗口 / 最小化 / 空尺寸 → 拒绝
4. 系统安全与登录类（UAC、锁屏等）  → 拒绝
5. 内建拒绝清单（本文件）           → 拒绝（不可放行）
6. config.denyProcesses            → 拒绝（人类可改）
7. config.denyTitleContains        → 拒绝（人类可改）
```

前 5 步属于工具层，**模型与配置都改不动**；6、7 步是给人用的扩展位。

## 命中后会发生什么

- 动作**不会执行**，返回结构化拒绝原因，例如：
  `命中内建拒绝清单 [system-config/系统配置工具] title:磁盘管理`；
- 拒绝原因写入本地审计 `audit.jsonl`，事后可查；
- 即使开了 `allowSelfWindow`，也不能放行这 5 步——`allowSelf` 只对"自身窗口"这一类原因生效。

## 怎么看当前生效的规则

让 Agent 调用：

```
click_matrix_doctor
```

输出里会有一行 `PASS 内建拒绝清单`，列出三组、各自覆盖的进程数与标题规则数。

## 它不覆盖什么（别当安全承诺用）

- **不判断用途**：它只看窗口，不看"你打算干什么"；
- **不覆盖未列出的应用**：比如某个小众网银客户端、某个自绘界面；
- **不防源码修改**：你能改代码就能改清单；
- **不替代授权模型**：人类授权仍然是第一道闸。

## 想扩展怎么办

用配置位（会叠加在内建清单之上，不是替换）：

```json
{
  "denyProcesses": ["somebank.exe"],
  "denyTitleContains": ["支付确认"]
}
```

改完重启插件生效；`click_matrix_doctor` 会显示配置项。

## 验证记录（v0.9.3 实测）

8 条样本、全部通过：

| 样本 | 期望 | 结果 |
|---|---|---|
| `HipsMain.exe` / 火绒安全软件 | 命中 security | ✅ |
| `1Password.exe` | 命中 credential | ✅ |
| `regedit.exe` / 注册表编辑器 | 命中 system-config | ✅ |
| `mmc.exe` / 磁盘管理 | 命中 system-config | ✅ |
| `notepad.exe` / 记事本 | 不命中 | ✅ |
| `QQ.exe` | 不命中 | ✅ |
| `mspaint.exe` / 画图 | 不命中 | ✅ |
| `Weixin.exe` / 微信 | 不命中 | ✅ |

`node tools/check-repo.mjs`：7 项检查全部通过。
