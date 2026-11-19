# dsh-stroke · 设计草案 v0.1（2026-11-03）

> 新插件，**独立于 dsh-click-matrix**（不复用其名字、版本、授权模型、helper）。
> 目标：让桌面自动化操作**更流畅**（快、稳、可复现、人类负担小）；画布只是**检验台**，用来把"操作"可视化。
> 状态：设计 + 实验阶段，未写插件代码。

## 1. 定位与非目标

**定位**：一个"笔势执行器"——把一条预先算好的点列（含时间戳）在一次调用里流畅地播放成真实鼠标输入；可被上层（Agent/脚本）组合成排线、等距点阵、曲线、表格填充等"手部动作"。

**非目标**：
- 不做点阵截图/读屏/界面理解（那是 click-matrix 的事）；
- 不做绘画软件、不做审美判断；
- 不做逐动作审批（见 §4）；
- 不追求压感/力道（Windows 鼠标无压力通道）。

## 2. 名称

`dsh-stroke`（笔势）。备选：`dsh-flow`（更强调流畅）。仓库：`D:\LocalChat\dsh-stroke`。

## 3. 核心接口（草案）

```
stroke_dryrun({ strokes:[{points:[{x,y,t}], width?:const|{...}}], region? })  -> 统计/预览（不注入）
stroke_draw({ strokes, speed?='const'|'easeIn'|'easeOut', holdOnStop?='immediate', region? }) -> 实发点数/elapsed/中断原因
stroke_stop({ at?:'immediate'|'strokeEnd' })   -> 硬停/软停
stroke_status()                                 -> helper 状态、当前笔、剩余
```

- **一次调用 = 一批笔**（默认一次授权、一条审计、一个撤销单元）。
- 点列坐标：屏幕物理 px；`region` 为允许注入的矩形（画布），越界整笔拒绝（不裁剪）。
- 时间戳：相对首点毫秒整数，单调；缺失则按 `intervalMs` 匀速生成。
- 返回：`sent/elapsed/interrupted{at,reason}/buttonAfter`，直接作为验收数据。

## 4. 授权模型（与 click-matrix 不同）

- **会话级**：`stroke_arm({region, maxPoints, maxMs})` 一次性开启"画布模式"，期间**不逐笔审批**。
- 保留**硬停止通道**（不是审批）：F11 全局热键、helper 侧 `AbortRequested` 标志、STOP。
- 画布范围内**暂不考虑** deny/自身窗口/标题判定等安全设置（用户明确授权；等插件稳定后再评估是否接入 click-matrix 的 policy）。**但保留**：区域限制（不得离开 `region`）、点数/时长上限、审计（轻量：每笔一行）。

## 5. 架构

```
Agent/脚本 ──► 插件(Node, 本仓库) ──NDJSON/stdio──► stroke-helper.exe (C#)
                  校验/上限/审计(轻)                   timeBeginPeriod(1) + 播放线程
                                                       每点查 AbortRequested
                                                       finally 必释放按键
```
- **独立 helper**（`runtime/stroke-helper.cs`），自带协议 v1；不依赖 click-matrix 的 helper 版本。
- helper 关键点：播放放**工作线程**（读取线程仍能应答 abort/status）；`SendInput` 绝对坐标；每点前查停止标志；异常/退出必释放。
- 插件侧：参数校验、region 限制、笔数/点数/时长上限、dryRun、审计（轻）。

## 6. 实验（先做，再写插件）

| # | 实验 | 目的 | 通过标准 |
|---|---|---|---|
| E1 | 定时器粒度 / Sleep 精度 | 决定节拍下限 | 有/无 `timeBeginPeriod(1)` 的 Sleep(1) 均值与 p95 |
| E2 | 注入吞吐与合并 | 注入数≠到达数？ | 收到/注入比、间隔分布（100/200/500 点/秒） |
| E3 | 目标 app 插值（Paint） | 点距 2px vs 8px 的像素差 | 像素 diff 与断笔判定 |
| E4 | 中断延迟 | abort→抬起的延迟 | 硬停 <100ms、软停落笔边界 |
| E5 | 复现性 | 同点列两次运行的像素/hash | 点列 bit 一致；像素 diff 在容差内 |

## 7. 验收指标（"更流畅"的量化）

1. 每笔墙钟 ≤ 理论时长×1.2；2. 有效点/秒（收到/秒）；3. 节拍抖动 p95 ≤ 25ms；4. 硬停延迟 ≤100ms；5. 同点列两次运行点列 bit 一致；6. 每批授权次数 = 1。

## 8. 里程碑

- **M0**：E1/E2（本机实测）——现在做；
- M1：`stroke-helper.exe` + `stroke_draw` + 测试窗（先用我们自己的 WinForms 窗当靶）；
- M2：Paint 上画一条直线/圆弧/一只熊（检验台）；
- M3：第二检验场：表格填充 + 重复点击（顺带打 B4/W-09）。

## 9. 明确不做 / 暂缓

逐动作审批、自身窗口 deny、审美、压感、L0/L1/L2 候选图择优、速度→笔宽、椭圆 A 段、模板枚举拟合（等 E3 结果再定是否需要）。

## 10. E1/E2 实验结果（2026-11-03，已做）

详见 `experiments/README.md`。要点：

- **E1**：默认定时器下 `Sleep(1)` 实测 mean 8.8ms / p95 16.6ms；`timeBeginPeriod(1)` 后 **mean 1.88ms / p95 2.70ms** ⇒ 8ms 节拍可行，**helper 必须调 timeBeginPeriod(1)**。
- **E2**（300 点绝对坐标 SendInput，靶窗自建 700×500）：
  - 8ms 间隔 → **111.3 点/s**，收到 300/300，延迟 mean 0.78ms；
  - 16ms → 58.8 点/s；33ms → 29.3 点/s；
  - **没有观察到合并丢点**（简单窗口下 1.0 收到比）⇒ 之前"2px 一事件"的担心在系统层不成立，真正的限制在目标 app 自身处理速度（待 E3 在 Paint 上验）。

## 11. 三条实践口径（按用户"实践中自己把握"）

1. **目标软件**：Paint 只当检验台；不依赖"速度→笔宽"，速度函数降级为节拍/缓动（easeIn/easeOut 两档足够）。
2. **验收线**（基于 E2 实测）：有效点 ≥100 点/s；单笔 200 点 ≤2.2s；节拍抖动 p95 ≤10ms；注入→到达延迟 ≤2ms；每批授权 = 1 次；硬停 ≤100ms（E4 验）；同点列两次运行**点列 bit 一致** + 像素 diff 容差（E5 验）。
3. **第二检验场**：M3 做"表格填充 + 窗口漂移 + 重复点击"（顺带打 click-matrix 已知的 B4/W-09），画图只验"手"不验"眼"。

## 12. 真机注入阻塞记录（2026-11-03，重要）

**目标未达成**：本机无法通过 dsh-stroke helper 向用户桌面注入真实输入。证据如下：

| 事实 | 证据 |
|---|---|
| helper（插件 spawn 或用户桌面双击启动服务）均为 **Medium 完整性** | 进程令牌 S-1-16-8192 |
| helper 所在桌面 = 输入桌面 | `desk=Default wsta=WinSta0 input=Default` |
| helper DPI 正确 | `screen=2880x1800`（物理像素） |
| `SetCursorPos` 失败 | `SELFTEST setOk=False`、`setErr=0`、`before==after` |
| `SendInput` 无效 | 光标不动、`fails=0`（返回成功但无效果） |
| `mouse_event` 也无效 | 同上（已切换为主通道） |
| 对照：PowerShell（agent 侧）`mouse_event` 有效 | 光标 716,493 → 1342,789 |
| helper 截图有效 | PrintWindow + CopyFromScreen 截到了用户桌面/DSH 窗口 |

**结论**：本机对"用户桌面进程"的输入注入存在进程级/策略级过滤（疑似安全软件或作业对象 UI 限制）；
agent 侧 PowerShell 的"有效"很可能发生在隔离桌面，不能作为用户桌面可注入的证据。
**在拿到系统侧证据（火绒日志 / 进程 UI 限制 / DESKTOP 权限）之前，不再往 dsh-stroke 里加注入代码。**

## 13. 环境问题解决后的接续步骤

1. 用户桌面双击 `start-helper.cmd`（medium 服务）→ 插件自动中继；
2. `stroke_diag` 自检应显示 `setOk=True`（或 `mouse_event` 生效后 `after` 变化）；
3. 通过后直接 `stroke_draw` 画熊（笔势数据在会话记录中，15 笔/237 点/1.8s），`stroke_diag` 的 `shotPath` 截图验收；
4. 若仍失败：检查火绒"程序执行控制/HIPS"日志、DSH 是否以受限作业对象启动、以及 `WinSta0` 的 DESKTOP 访问权限。
