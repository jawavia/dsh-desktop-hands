#!/usr/bin/env node
// audit-path-test.mjs — dsh-x2 审计路径统一自测（Q7 审计统一，2026-11-08）
//
// 断言：
//   1) 默认审计路径 = ~/.dsh/dsh-desktop-hands/audit/control.jsonl（**不再**是 %TEMP%\dsh-x2）
//   2) DSH_HANDS_DATA_DIR / config.auditDir 都能重定向（测试隔离用）
//   3) arm.json 仍留在 %TEMP%\dsh-x2（只搬审计，不搬授权状态）
//   4) 新位置下 hash 链照常可写可校验；篡改能被 verifyAudit 抓到
//   5) 写失败：audit() 保持旧契约（抛），safeAudit() 不抛、handler 被调用（工具不崩且"没写成"可见）
//
// 运行：node engines/control/test/audit-path-test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pol from '../src/policy.js'

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

const DATA = mkdtempSync(join(tmpdir(), 'dsh-x2-audit-'))
process.env.DSH_HANDS_DATA_DIR = DATA
const LEGACY_AUDIT = join(tmpdir(), 'dsh-x2', 'audit.jsonl')
const legacyBefore = existsSync(LEGACY_AUDIT) ? statSync(LEGACY_AUDIT).mtimeMs : null

try {
  // ---- 1) 路径计算：默认不再是 %TEMP%\dsh-x2 ----
  console.log('\n[1] 默认审计路径（不随授权状态目录）')
  const saved = process.env.DSH_HANDS_DATA_DIR
  delete process.env.DSH_HANDS_DATA_DIR
  const defaultAudit = pol.auditPath()
  eq(defaultAudit, join(homedir(), '.dsh', 'dsh-desktop-hands', 'audit', 'control.jsonl'), '默认审计路径')
  ok(!defaultAudit.startsWith(join(tmpdir(), 'dsh-x2')), '默认审计路径不在 %TEMP%\\dsh-x2 下')
  ok(defaultAudit.endsWith('control.jsonl'), '文件名是 control.jsonl')
  const defaultArm = pol.statePath()
  eq(defaultArm, join(tmpdir(), 'dsh-x2', 'arm.json'), 'arm.json 仍在 %TEMP%\\dsh-x2（没搬家）')
  ok(!defaultArm.startsWith(join(homedir(), '.dsh', 'dsh-desktop-hands')), 'arm.json 没有被搬进 ~/.dsh')
  process.env.DSH_HANDS_DATA_DIR = saved

  // ---- 2) 环境变量 / 显式 config 重定向 ----
  console.log('\n[2] DSH_HANDS_DATA_DIR / config.auditDir 重定向')
  eq(pol.auditPath(), join(DATA, 'audit', 'control.jsonl'), 'DSH_HANDS_DATA_DIR 生效')
  eq(pol.auditPath({ auditDir: join(DATA, 'x') }), join(DATA, 'x', 'control.jsonl'), 'config.auditDir 优先')
  eq(pol.auditDir(), join(DATA, 'audit'), 'auditDir() 一致')

  // ---- 3) 新位置写 hash 链 ----
  console.log('\n[3] 新位置可写 + hash 链可校验')
  const r1 = pol.audit({ kind: 'allow', tool: 'screen_act', action: 'click' })
  const r2 = pol.audit({ kind: 'deny', tool: 'screen_act', action: 'click', reason: 'not-armed' })
  eq(r1.seq, 1, '第一条 seq=1')
  eq(r2.seq, 2, '第二条 seq=2')
  const file = join(DATA, 'audit', 'control.jsonl')
  ok(existsSync(file), `审计文件写成: ${file}`)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  eq(lines.length, 2, '两行')
  const row = JSON.parse(lines[0])
  ok(typeof row.h === 'string' && row.h.length === 64, 'hash 链字段 h 是 64 位')
  eq(row.prev, '0'.repeat(64), '首行 prev 是 64 个 0')
  eq(pol.verifyAudit(), null, '整链校验通过（null = 无断点）')
  ok(JSON.parse(JSON.parse(lines[1]).b).reason === 'not-armed', 'b 里保存着可独立校验的正文')

  // ---- 4) 篡改检测 ----
  console.log('\n[4] 篡改检测（链仍然有用，不只是"写一行")')
  const tampered = lines.map((l, i) => {
    if (i !== 0) return l
    const j = JSON.parse(l)
    j.b = j.b.replace('"kind":"allow"', '"kind":"deny"') // 改正文、不改 h → 必然对不上
    return JSON.stringify(j)
  })
  writeFileSync(file, tampered.join('\n') + '\n', 'utf8')
  const broken = pol.verifyAudit()
  ok(broken !== null, '篡改后 verifyAudit 报断点')
  eq(broken.reason, 'hash', '断点原因是 hash')
  rmSync(file)

  // ---- 5) 写失败：不崩工具，但"没写成"可见 ----
  console.log('\n[5] 写失败语义')
  const blocker = join(DATA, 'blocker')
  writeFileSync(blocker, 'x') // 拿文件当目录 → 必失败
  const brokenDir = join(blocker, 'audit')
  let handlerCalls = 0
  pol.setAuditErrorHandler(() => { handlerCalls++ })

  let threw = false
  try {
    pol.audit({ kind: 'allow', tool: 'screen_act' }, { auditDir: brokenDir })
  } catch {
    threw = true
  }
  ok(threw, 'audit() 保持旧契约：写失败会抛')
  const soft = pol.safeAudit({ kind: 'allow', tool: 'screen_act' }, { auditDir: brokenDir })
  eq(soft.ok, false, 'safeAudit() 不抛，返回 ok:false')
  ok(typeof soft.error === 'string' && soft.error.length > 0, `失败原因可读（${soft.error.slice(0, 40)}…）`)
  ok(handlerCalls >= 2, `错误 handler 被调用（${handlerCalls} 次，index.js 接的是 ctx.logger.warn）`)
  pol.setAuditErrorHandler(null)

  // ---- 6) 不污染旧位置 ----
  console.log('\n[6] 旧位置隔离检查')
  const legacyAfter = existsSync(LEGACY_AUDIT) ? statSync(LEGACY_AUDIT).mtimeMs : null
  eq(legacyAfter, legacyBefore, '%TEMP%\\dsh-x2\\audit.jsonl 未被本次测试写入')
  ok(!existsSync(join(tmpdir(), 'dsh-x2', 'control.jsonl')), '%TEMP%\\dsh-x2 下没有 control.jsonl')

  console.log(`\n自测通过：${checks} 项检查全部通过`)
} finally {
  try { rmSync(DATA, { recursive: true, force: true }) } catch { /* ignore */ }
}
