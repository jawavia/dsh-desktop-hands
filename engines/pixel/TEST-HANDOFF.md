# TEST-HANDOFF — dsh-click-matrix v0.8.4

给"新会话继续测试/使用"的一页纸提示。先读 `README.md`、`PROTOCOL.md`、`skills/click-matrix/SKILL.md`。

## 当前状态

- 插件目录：见当前 profile 的 bundles 条目（常见为 `D:\DSH-plugins\dsh-click-matrix`，junction 安装进 DSH desktop profile）。
- 版本：**v0.8.1**；helper **v7**；工具 **23 个**；状态接口 `http://127.0.0.1:<当前DSH端口>/api/click-matrix/status`（端口看 runtime context，别硬编码；该接口现包含 helperPid/helperVersion/helperRestarts）。
- 安全默认：`mode=ask`、`allowSelfWindow=false`；模型不能自批，必须人类授权。
- 授权：`Ctrl+Alt+F12` 常开/关切换，或 `/click-matrix arm <秒|on>`，或输入框「🖱 点阵」芯片（30s/2min/10min/常开）。
- 硬停：**Esc**、**Ctrl+Alt+F11（全局急停，无需授权）**、胶囊 STOP、`/click-matrix stop`。
- 人类动鼠标/打字 → 注入自动暂停，空闲 20s 后自动恢复同一授权（`humanIdleResumeMs`）。

## 一键测试

```bash
cd D:\LocalChat\dsh-click-matrix
npm run check        # 语法/乱码/版本一致性/文件/loader id
npm test             # check + access/grid/host/client mock 套件（无需真实桌面）
npm run test:helper  # 真实键鼠 helper smoke：先 kill 插件 helper、独占桌面、full-access
```

真机建议顺序：`npm run check` → `npm test` → `npm run test:helper` → `click_matrix_doctor` → 实际任务。

## 已验证（不必重复）

- host-smoke 126/126、access 134 断言、grid 163 断言、helper 57/57、client PASS、doctor PASS 40。
- 真机：UIA 三模式（含计算器 WinUI）、人类等待（18s 成功/30s 超时/Esc 打断）、batch partial 与 resumeFrom、dryRun、窗口相对坐标、focus/wait_window、图片预算自动降级、Ctrl+Alt+F11 急停、输入中文/emoji/剪贴板长文、PrintWindow 遮挡截图。
- 未验证/遗留：真机多显示器与混合 DPI；allowSelf 真机（默认关闭）；长跑/并发；OCR（未实现）。

## 测试纪律

- 长任务先**开新会话**（省 token）；任务中不要 reload/disable 插件（prompt 缓存失效）。
- 截图优先 `screen_read`（text-first）/小 region；批量用 `mouse_batch`。
- helper-smoke 会注入真实键鼠并短暂开全屏遮挡窗口，跑前确认没人用电脑。
- 危险动作（删除/支付/发送）先问人类；急停用 Esc / Ctrl+Alt+F11。
- 汇报时附工具返回原文/审计计数/测试 SUMMARY，不要只写"通过"。
