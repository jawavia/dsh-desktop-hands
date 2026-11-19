#!/usr/bin/env node
// audit-smoke.mjs — dsh-stroke 审计自测（Q7 审计统一，2026-11-08）
//
// 断言：
//   1) 每次工具调用真的在盘上多一行 JSONL（引擎/字段/时序都可解析）
//   2) denied 记成 denied（不是 ok，也不是 error）
//   3) dryRun 单独标 dryRun:true（预演不注入，不能记成"执行过"）
//   4) 写失败：工具不崩；arm / stop 的返回值里必须明说"审计未留痕"
//   5) appendAudit 的回读校验真的生效（返回值 ok ⇔ 盘上能读到本行 callId）
//
// 隔离：全程 DSH_HANDS_DATA_DIR = 临时目录；不写真实 ~/.dsh，也不碰真实 %TEMP%\dsh-x2。
// 运行：node engines/stroke/test/audit-smoke.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'dsh-stroke-audit-'))
process.env.DSH_HANDS_DATA_DIR = DATA

const { __buildToolDefinitions, __createState } = await import('../index.js')
const audit = await import('../audit.js')

let checks = 0
function ok(cond, label) {
  checks++
  assert.ok(cond, `断言失败: ${label}`)
  console.log(`  ✓ ${label}`)
}
function eq(actual, expected, label) {
  checks++
  assert.deepEqual(actual, expected, `断言失败: ${label}（实际 ${JSON.stringify(actual)}）`)
  console.log(`  ✓ ${label} = ${JSON.stringify(actual)}`)
}

function makeState(config = {}) {
  const state = __createState({
    armSeconds: 120,
    maxPoints: 20000,
    maxStrokes: 500,
    maxStrokePoints: 5000,
    intervalMs: 8,
    ...config,
  })
  const calls = { draw: [], stop: 0 }
  // helper 全用桩：自测绝不拉起真实注入进程（stroke-helper.ps1 会真的动鼠标）
  state.helper = {
    running: false,
    lastError: '',
    dispose() {},
    async ensure() { return true },
    async status() { return 'STUB-STATUS' },
    async draw(button, points) {
      calls.draw.push({ button, points })
      return { sent: points.length, elapsed: 1, aborted: false, reason: '' }
    },
    async stop() { calls.stop++; return true },
    async selftest() { return 'SELFTEST ok' },
    async shot() { return 'SHOT ok' },
  }
  return { state, calls }
}

function defsOf(state) {
  const map = new Map()
  for (const d of __buildToolDefinitions(state)) map.set(d.name, d)
  return map
}

const file = audit.auditPath()
function rows() {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

console.log(`数据目录: ${DATA}`)
console.log(`审计文件: ${file}`)

try {
  // ---- 1) 正常路径：status → arm → draw → dryRun ----
  console.log('\n[1] 每次工具调用写一行（ok / seq 递增 / 字段完整）')
  const { state, calls } = makeState()
  const defs = defsOf(state)

  const status = await defs.get('stroke_status').execute({})
  ok(status.text.includes('dsh-stroke'), 'stroke_status 正常返回')
  eq(rows().length, 1, '第一次调用后 1 行审计')
  const first = rows()[0]
  eq(first.engine, 'stroke', 'engine 字段')
  eq(first.seq, 1, 'seq 从 1 开始')
  eq(first.tool, 'stroke_status', 'tool 字段')
  eq(first.decision, 'ok', 'decision=ok')
  ok(!Number.isNaN(Date.parse(first.t)), `t 是可解析时间（${first.t}）`)
  ok(typeof first.callId === 'string' && first.callId.length === 36, 'callId 是 uuid')

  const arm = await defs.get('stroke_arm').execute({ seconds: 30 })
  ok(arm.text.includes('已开启笔势会话'), 'stroke_arm 正常返回')
  eq(rows().length, 2, 'arm 后 2 行')
  eq(rows()[1].tool, 'stroke_arm', 'arm 的 tool')
  eq(rows()[1].seq, 2, 'seq 递增到 2')

  const draw = await defs.get('stroke_draw').execute({ strokes: [{ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }] })
  ok(draw.text.includes('笔势结果'), 'stroke_draw 正常返回')
  eq(calls.draw.length, 1, '桩 helper 真的被调用 1 次（说明测试是活的）')
  eq(rows().length, 3, 'draw 后 3 行')
  eq(rows()[2].tool, 'stroke_draw', 'draw 的 tool')
  ok(!('dryRun' in rows()[2]), '真发不标 dryRun')

  // ---- 2) dryRun 必须能区分 ----
  console.log('\n[2] dryRun 单独标记（不伪装成执行过）')
  const dry = await defs.get('stroke_draw').execute({ strokes: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }], dryRun: true })
  ok(dry.text.includes('dryRun'), 'dryRun 返回预演说明')
  eq(calls.draw.length, 1, 'dryRun 不调用 helper')
  eq(rows().length, 4, 'dryRun 也留痕（4 行）')
  eq(rows()[3].dryRun, true, 'dryRun 行标了 dryRun:true')
  eq(rows()[3].decision, 'ok', 'dryRun 决策规则仍记 ok')

  // ---- 3) denied 真的记 denied ----
  console.log('\n[3] 未授权调用记成 denied（不是 ok / 不是 error）')
  const { state: idle, calls: idleCalls } = makeState({ auditPath: file })
  const idleDefs = defsOf(idle)
  const denied = await idleDefs.get('stroke_draw').execute({ strokes: [{ points: [{ x: 5, y: 5 }] }] })
  ok(denied.text.includes('未开启会话'), '未授权时拒绝')
  eq(idleCalls.draw.length, 0, '拒绝时不调用 helper')
  eq(rows().length, 5, '拒绝也留痕（5 行）')
  eq(rows()[4].decision, 'denied', 'decision=denied')
  eq(rows()[4].reason, 'not-armed-or-session-expired', 'reason 记了原因')

  // ---- 4) 回读校验：ok ⇔ 盘上真有这行 ----
  console.log('\n[4] appendAudit 回读校验（返回值 ok 必须对应盘上真有此行）')
  const probe = audit.appendAudit({ tool: 'probe', decision: 'ok', callId: 'CID-PROBE-123' })
  eq(probe.ok, true, '写入返回 ok')
  ok(readFileSync(file, 'utf8').includes('CID-PROBE-123'), '回读能读到 callId')
  ok(probe.seq === rows().length, `seq 连续（${probe.seq}）`)

  // ---- 5) 写失败：工具不崩，安全动作明说"未留痕" ----
  console.log('\n[5] 写失败：工具不崩 + arm/stop 明说"审计未留痕"')
  const blocker = join(DATA, 'blocker')
  writeFileSync(blocker, 'x') // 用它当"父目录"→ mkdir 必失败（ENOTDIR/EEXIST）
  const brokenDir = join(blocker, 'nested')
  process.env.DSH_HANDS_DATA_DIR = brokenDir
  const failedPath = audit.auditPath()
  ok(failedPath.includes('nested'), '审计路径已指向不可写位置（测试前提成立）')

  const { state: broken } = makeState()
  const brokenDefs = defsOf(broken)

  const armBroken = await brokenDefs.get('stroke_arm').execute({ seconds: 30 })
  ok(armBroken.text.includes('已开启笔势会话'), 'arm 照常生效（工具不崩）')
  ok(armBroken.text.includes('审计未留痕'), 'arm 返回值明说"审计未留痕"')
  ok(armBroken.text.includes('nested'), 'arm 的提示带上失败路径')

  const stopBroken = await brokenDefs.get('stroke_stop').execute({})
  ok(stopBroken.text.includes('已停止'), 'stop 照常生效')
  ok(stopBroken.text.includes('审计未留痕'), 'stop 返回值明说"审计未留痕"')

  const statusBroken = await brokenDefs.get('stroke_status').execute({})
  ok(statusBroken.text.includes('dsh-stroke'), 'status 照常返回')
  ok(!statusBroken.text.includes('审计未留痕'), 'status 不骚扰用户（只在日志警告）')

  const r = audit.appendAudit({ tool: 'probe', decision: 'ok', callId: 'CID-FAIL' })
  eq(r.ok, false, 'appendAudit 失败返回 ok:false（不抛）')
  ok(typeof r.error === 'string' && r.error.length > 0, `失败原因可读（${r.error}）`)

  process.env.DSH_HANDS_DATA_DIR = DATA

  // ---- 6) 不污染真实位置 ----
  console.log('\n[6] 隔离检查')
  ok(!existsSync(join(tmpdir(), 'dsh-x2', 'stroke.jsonl')), '没往 %TEMP%\\dsh-x2 写 stroke 审计')
  ok(existsSync(file), '隔离数据目录下审计文件存在')

  console.log(`\n自测通过：${checks} 项检查全部通过`)
} finally {
  try { rmSync(DATA, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(join(DATA, 'blocker'), { force: true }) } catch { /* ignore */ }
}
