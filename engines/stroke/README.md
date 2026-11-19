# dsh-stroke v0.1

Smooth stroke executor for DSH（独立插件，**不依赖 dsh-click-matrix**）。

## 它是什么

把预先算好的点列（`{x,y,t}`，屏幕物理像素 + 相对毫秒时间戳）一次调用播放成真实鼠标输入：
按下 → 按时间戳移动 → 抬起；每点检查硬停止（Esc / F11 / STOP）。用于让"手部操作"更流畅（排线、等距点阵、曲线、批量点击），画布只是检验台。

## 工具

| 工具 | 作用 |
|---|---|
| `stroke_arm({seconds?, region?, maxPoints?})` | 开启会话（会话级授权；之后不再逐笔审批） |
| `stroke_draw({strokes, button?, dryRun?})` | 播放一批笔画；返回每笔实发点数/耗时/中断 |
| `stroke_stop()` | 停止 + 会话失效 |
| `stroke_status()` | 会话/helper 状态（只读） |

## 授权与安全（v0.1 口径）

- **会话级**：`stroke_arm` 一次开启（默认 120s），期间 `stroke_draw` 不逐笔审批；
- **画布范围内暂不做** deny/自身窗口/标题判定（用户明确授权）；
- 保留：**region 区域限制**（越界整笔拒绝）、点数/笔画数上限、**Esc/F11/STOP 硬停**、helper 侧 abort 标志。

## 架构

`index.js`（Node，工具/校验/上限） → 行协议 stdio → `runtime/stroke-helper.exe`（C#：`timeBeginPeriod(1)` + 播放线程 + 每点 abort 检查 + finally 释放按键）。
helper 由插件按需拉起 → 运行在 DSH 宿主进程的桌面/完整性级别（这是能注入真实输入的前提；沙箱里直接跑 exe 会被 UIPI 拦住）。

## 已知限制（v0.1）

- 只支持左/右键；无压感、无速度→笔宽；
- helper 单进程串行播放（多笔顺序执行，不并发）；
- 审计是**轻量**的：只有"每次调用一行"，没有 hash 链（见下节；pixel/control 的链更强）；
- helper 强杀时按键可能卡住（`finally` 不覆盖被强杀）——用 `stroke_stop` 或 Esc 正常停止。

## 审计（2026-11-08 起）

**每次工具调用**（`stroke_status` / `stroke_arm` / `stroke_draw` / `stroke_diag` / `stroke_stop`）追加一行 JSONL 到
`<数据目录>/audit/stroke.jsonl`（默认 `~/.dsh/dsh-desktop-hands/audit/stroke.jsonl`，`DSH_HANDS_DATA_DIR` 可重定向）：

```json
{"engine":"stroke","seq":3,"t":"2026-11-08T02:31:12.345Z","tool":"stroke_draw","decision":"ok","callId":"…"}
```

- `decision`：`ok` | `denied`（未授权/会话过期）| `error`（参数/执行错误）；
- `dryRun: true` 只出现在 `dryRun` 的 `stroke_draw` 上 —— 预演不注入，不能记成"执行过"；
- **写失败不崩工具**，但 `stroke_arm` / `stroke_stop` / 真发 `stroke_draw` / `stroke_diag` 会在返回值里明说
  「⚠️ 审计未留痕」（带失败路径）——宁可让你看到没留痕，也不会假装写成了；
- 没有 hash 链（pixel/control 的链更强，stroke 只承诺"每次调用有一行"）；`seq` 单进程内单调。
- 自测：`node engines/stroke/test/audit-smoke.mjs`（42 检查）；人工校验：逐行 `JSON.parse` 即可。

