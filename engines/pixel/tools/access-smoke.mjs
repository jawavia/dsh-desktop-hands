// 纯 Node 单元测试（不碰真实桌面 / helper / 鼠标键盘）：
//   lib/config.js  v0.4 配置字段与夹取
//   lib/access.js  人类活动内部等待（waitForHumanIdleMs）+ 作用域化 allowSelf
//   lib/policy.js  evaluateWindowDeny 第 4 参数 extra（selfAllow 放行判定）
// 运行: node tools/access-smoke.mjs   （全部 PASS 退出码 0；断言失败抛错退出码 1）
import assert from 'node:assert/strict'
import { normalizeConfig, describeConfig } from '../lib/config.js'
import { AccessGate } from '../lib/access.js'
import { evaluateWindowDeny, intrinsicOwnProcesses, ownProcessNames } from '../lib/policy.js'

let checks = 0
function ok(cond, msg) {
  checks += 1
  assert.ok(cond, msg)
}
function eq(actual, expected, msg) {
  checks += 1
  assert.deepEqual(actual, expected, msg)
}
function pass(name) {
  console.log('PASS ' + name)
}

// 没有 approval 服务的 ctx：需要放行的用例先 humanArm 打开授权窗口。
const NO_APPROVAL = { get: () => undefined }
const AGENT = { agent: { id: 'agent-smoke' } }

function makeGate(overrides = {}) {
  const config = normalizeConfig({ mode: 'ask', minIntervalMs: 0, armClicks: 10, ...overrides })
  return new AccessGate({ ctx: NO_APPROVAL, config })
}

// ---------------------------------------------------------------------------
// A. config 夹取
// ---------------------------------------------------------------------------
{
  const d = normalizeConfig(null)
  ok(d.humanWaitMaxMs === 30000, 'humanWaitMaxMs 默认 30000')
  ok(d.allowSelfWindow === false, 'allowSelfWindow 默认 false')
  ok(d.allowSelfRect === null, 'allowSelfRect 默认 null')
  ok(d.allowSelfMaxMs === 120000, 'allowSelfMaxMs 默认 120000')

  ok(normalizeConfig({ humanWaitMaxMs: -100 }).humanWaitMaxMs === 0, 'humanWaitMaxMs 下界 0')
  ok(normalizeConfig({ humanWaitMaxMs: 0 }).humanWaitMaxMs === 0, 'humanWaitMaxMs=0 表示禁用内部等待')
  ok(normalizeConfig({ humanWaitMaxMs: 600000 }).humanWaitMaxMs === 60000, 'humanWaitMaxMs 上界 60000')
  ok(normalizeConfig({ humanWaitMaxMs: '2500' }).humanWaitMaxMs === 2500, 'humanWaitMaxMs 接受数字字符串')
  ok(normalizeConfig({ humanWaitMaxMs: 'abc' }).humanWaitMaxMs === 30000, 'humanWaitMaxMs 非法回退默认')

  ok(normalizeConfig({ allowSelfMaxMs: 1 }).allowSelfMaxMs === 5000, 'allowSelfMaxMs 下界 5000')
  ok(normalizeConfig({ allowSelfMaxMs: 600000 }).allowSelfMaxMs === 600000, 'allowSelfMaxMs 上界 600000')
  ok(normalizeConfig({ allowSelfMaxMs: 9999999 }).allowSelfMaxMs === 600000, 'allowSelfMaxMs 超上界被夹取')
  ok(normalizeConfig({ allowSelfMaxMs: 'x' }).allowSelfMaxMs === 120000, 'allowSelfMaxMs 非法回退默认')

  ok(normalizeConfig({ allowSelfWindow: 'true' }).allowSelfWindow === true, 'allowSelfWindow 接受 "true"')
  ok(normalizeConfig({ allowSelfWindow: 'off' }).allowSelfWindow === false, 'allowSelfWindow 接受 "off"')
  ok(normalizeConfig({ allowSelfWindow: 1 }).allowSelfWindow === true, 'allowSelfWindow 接受 1')

  const rect = normalizeConfig({ allowSelfRect: { x: 10, y: 20, w: 640, h: 480 } }).allowSelfRect
  eq(rect, { x: 10, y: 20, w: 640, h: 480 }, 'allowSelfRect 合法值被规范为 {x,y,w,h}')
  ok(Object.isFrozen(rect) === true, 'allowSelfRect 结果为冻结对象')
  eq(
    normalizeConfig({ allowSelfRect: { x: 0, y: 0, width: 800, height: 600 } }).allowSelfRect,
    { x: 0, y: 0, w: 800, h: 600 },
    'allowSelfRect 兼容 width/height 别名',
  )
  eq(
    normalizeConfig({ allowSelfRect: { x: '5', y: '6', w: '100', h: '50' } }).allowSelfRect,
    { x: 5, y: 6, w: 100, h: 50 },
    'allowSelfRect 接受数字字符串',
  )
  const badRects = [
    null,
    undefined,
    'rect',
    [],
    {},
    { x: 1, y: 2, w: 0, h: 5 },
    { x: -1, y: 0, w: 10, h: 10 },
    { x: 0, y: 0, w: 10 },
    { x: 0, y: 0, w: 10.5, h: 10 },
    { x: 0, y: 0, w: 'x', h: 10 },
  ]
  for (const bad of badRects) {
    ok(normalizeConfig({ allowSelfRect: bad }).allowSelfRect === null, '非法 allowSelfRect → null: ' + JSON.stringify(bad))
  }

  const text = describeConfig(d)
  ok(text.includes('humanWaitMaxMs=30000'), 'describeConfig 提到 humanWaitMaxMs')
  ok(text.includes('allowSelfWindow=false'), 'describeConfig 提到 allowSelfWindow')
  ok(text.includes('allowSelfMaxMs=120000'), 'describeConfig 提到 allowSelfMaxMs')
  ok(text.includes('allowSelfRect=null'), 'describeConfig 提到 allowSelfRect')
  pass('config: v0.4 字段默认值与夹取')
}

// ---------------------------------------------------------------------------
// B. check() 人类活动内部等待
// ---------------------------------------------------------------------------

// B1. 不请求等待 → 立刻拒绝（原有 suspended 语义不变）
{
  const gate = makeGate()
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 2000 })
  const t0 = Date.now()
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT })
  const dt = Date.now() - t0
  ok(r.allowed === false && r.code === 'suspended', '不传 waitForHumanIdleMs 时立刻 suspended 拒绝')
  ok(dt < 200, `不等待应立即返回（实际 ${dt}ms）`)
  ok(typeof r.message === 'string' && r.message.includes('人类正在操作'), 'suspended 文案保持“人类正在操作”语义')
  ok(gate.isSuspended() === true, '立即拒绝不会清除人类活动暂停')
  const r0 = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 0 })
  ok(r0.allowed === false && r0.code === 'suspended', 'waitForHumanIdleMs=0 等同不等待')
}

// B2. config.humanWaitMaxMs=0 时禁用内部等待
{
  const gate = makeGate({ humanWaitMaxMs: 0 })
  gate.setSuspended({ reason: 'human-keyboard', idleResumeMs: 2000 })
  const t0 = Date.now()
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 5000 })
  const dt = Date.now() - t0
  ok(r.allowed === false && r.code === 'suspended', 'humanWaitMaxMs=0 时不内部等待')
  ok(dt < 200, `禁用等待后应立即返回（实际 ${dt}ms）`)
}

// B3. 等待成功：暂停解除后继续原逻辑并放行（arm 有效时）
{
  const gate = makeGate()
  gate.humanArm(60, 'smoke')
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 20000 })
  setTimeout(() => gate.clearSuspended(), 60)
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 5000 })
  ok(r.allowed === true && r.code === 'allowed', '内部等待成功后按当前 arm 状态放行')
  ok(typeof r.waitedMs === 'number' && r.waitedMs >= 200, `放行结果带 waitedMs（实际 ${r.waitedMs}）`)
  ok(typeof r.waitNote === 'string' && r.waitNote.includes('已内部等待'), '放行结果带“已内部等待 N 秒后继续”说明')
  ok(r.waitNote.includes('秒后继续'), 'waitNote 含“秒后继续”')
  ok(gate.isSuspended() === false, '等待成功后暂停已清除')
}

// B4. 等待超时：deny('suspended-timeout') + retryAfterMs/waitedMs
{
  const gate = makeGate()
  gate.setSuspended({ reason: 'human-keyboard', idleResumeMs: 20000 })
  const t0 = Date.now()
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 400 })
  const dt = Date.now() - t0
  ok(r.allowed === false && r.code === 'suspended-timeout', '等待超时返回 suspended-timeout')
  ok(typeof r.message === 'string' && r.message.includes('等待人类空闲超时，可稍后重试'), '超时文案含“等待人类空闲超时，可稍后重试”')
  ok(typeof r.retryAfterMs === 'number' && r.retryAfterMs >= 0 && r.retryAfterMs <= 20000, `retryAfterMs 为预计空闲剩余时间（实际 ${r.retryAfterMs}）`)
  ok(typeof r.waitedMs === 'number' && r.waitedMs >= 300, `超时结果带 waitedMs（实际 ${r.waitedMs}）`)
  ok(dt >= 350 && dt < 3000, `超时耗时约等于预算（实际 ${dt}ms）`)
  ok(gate.isSuspended() === true, '超时不会清除人类活动暂停')
}

// B4b. 请求的等待时长受 config.humanWaitMaxMs 夹取
{
  const gate = makeGate({ humanWaitMaxMs: 300 })
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 20000 })
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 999999 })
  ok(r.code === 'suspended-timeout', '超长等待请求仍以 humanWaitMaxMs 为预算超时')
  ok(r.waitBudgetMs === 300, `waitBudgetMs 被夹取到 300（实际 ${r.waitBudgetMs}）`)
  ok(r.waitedMs <= 900, `实际等待不超过预算容差（实际 ${r.waitedMs}）`)
}

// B5. 等待期间 exec.signal abort → 立即停止等待并拒绝
{
  const gate = makeGate()
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 20000 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 60)
  const t0 = Date.now()
  const r = await gate.check({ toolName: 'mouse_click', exec: { ...AGENT, signal: ac.signal }, waitForHumanIdleMs: 5000 })
  const dt = Date.now() - t0
  ok(r.allowed === false && r.code === 'aborted', 'abort 后停止等待并拒绝（code=aborted）')
  ok(dt < 1000, `abort 应尽快唤醒等待（实际 ${dt}ms）`)
  ok(typeof r.waitedMs === 'number' && r.waitedMs >= 0, 'abort 结果带 waitedMs')
}

// B6. 等待期间人类接管暂停（Esc/STOP）→ 立即停止等待并拒绝 paused
{
  const gate = makeGate()
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 20000 })
  setTimeout(() => gate.setPaused({ reason: 'escape' }), 60)
  const t0 = Date.now()
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 5000 })
  const dt = Date.now() - t0
  ok(r.allowed === false && r.code === 'paused', '等待中变为暂停 → 拒绝 paused')
  ok(dt < 1000, `暂停应立即打断等待（实际 ${dt}ms）`)
  ok(typeof r.message === 'string' && r.message.includes('已暂停'), '暂停文案保持“已暂停”语义')
  ok(typeof r.waitedMs === 'number' && r.waitedMs >= 0, '暂停打断结果带 waitedMs')
}

// B7. 等待成功但无授权/审批服务 → 继续原有检查逻辑（不是 suspended）
{
  const gate = makeGate()
  gate.setSuspended({ reason: 'human-mouse', idleResumeMs: 20000 })
  setTimeout(() => gate.clearSuspended(), 40)
  const r = await gate.check({ toolName: 'mouse_click', exec: AGENT, waitForHumanIdleMs: 3000 })
  ok(r.allowed === false && r.code === 'approval-unavailable', '等待成功后继续原有检查（无 approval 服务 → approval-unavailable）')
  ok(typeof r.waitedMs === 'number' && r.waitedMs > 0, '继续检查的拒绝结果也带 waitedMs')
  ok(gate.isSuspended() === false, '等待成功后暂停已清除')
}

// B8. snapshot() 增加 selfAllow 字段，原有字段不变
{
  const gate = makeGate()
  const snap = gate.snapshot()
  ok('selfAllow' in snap === true, 'snapshot() 含 selfAllow 字段')
  ok(snap.selfAllow.active === false && snap.selfAllow.rect === null, '未授权时 selfAllow 为 inactive')
  ok('mode' in snap && 'paused' in snap && 'suspended' in snap && 'armed' in snap, 'snapshot() 原有字段保留')
  pass('access: 人类活动内部等待（成功/超时/abort/暂停打断/继续检查）')
}

// ---------------------------------------------------------------------------
// C. 作用域化 allowSelf
// ---------------------------------------------------------------------------
{
  let clock = 1000
  const gate = new AccessGate({
    ctx: NO_APPROVAL,
    config: normalizeConfig({ allowSelfWindow: true }),
    now: () => clock,
  })
  const empty = gate.selfAllowSnapshot()
  ok(empty.active === false && empty.armed === false, '初始未授权')
  ok(empty.rect === null && empty.remainingMs === 0, '未授权时 rect=null/remainingMs=0')
  ok(gate.selfAllows({ x: 120, y: 120 }) === false, '未授权时 selfAllows=false')

  const arm = gate.selfAllowArm({ rect: { x: 100, y: 100, w: 50, h: 50 }, seconds: 10, source: 'command' })
  ok(arm.ok === true && arm.active === true && arm.armed === true, 'selfAllowArm 成功并返回快照')
  ok(arm.remainingMs === 10000, 'seconds 换算为 remainingMs')
  ok(arm.seconds === 10, '快照带剩余秒数')
  ok(arm.source === 'command', '快照带来源（可审计）')
  eq(arm.rect, { x: 100, y: 100, w: 50, h: 50 }, '快照 rect 规范为 {x,y,w,h}')
  ok(gate.snapshot().selfAllow.active === true, 'snapshot().selfAllow 反映已授权')
  ok('paused' in gate.snapshot() && 'suspended' in gate.snapshot(), 'snapshot() 其它字段保持')

  // 边界：左/上闭，右/下开
  ok(gate.selfAllows({ x: 100, y: 100 }) === true, '矩形左上角在范围内')
  ok(gate.selfAllows({ x: 149, y: 149 }) === true, '矩形内右下角在范围内')
  ok(gate.selfAllows({ x: 150, y: 120 }) === false, '右边界为开区间')
  ok(gate.selfAllows({ x: 120, y: 150 }) === false, '下边界为开区间')
  ok(gate.selfAllows({ x: 99, y: 120 }) === false, '左外侧不在范围内')
  ok(gate.selfAllows(null) === false, '无点参数返回 false')
  ok(gate.selfAllows({ x: NaN, y: 1 }) === false, '非法坐标返回 false')

  // 过期
  clock = 1000 + 10001
  ok(gate.selfAllowSnapshot().active === false, '超过 until 后变 inactive')
  ok(gate.selfAllowSnapshot().remainingMs === 0, '过期后 remainingMs=0')
  ok(gate.selfAllows({ x: 120, y: 120 }) === false, '过期后不再放行任何点')

  // 重新授予 + 关闭
  const arm2 = gate.selfAllowArm({ rect: { x: 0, y: 0, w: 10, h: 10 }, seconds: 5 })
  ok(arm2.ok === true && arm2.active === true, '重新授予成功')
  const off = gate.selfAllowOff()
  ok(off.ok === true && off.wasActive === true, 'selfAllowOff 返回 ok 与 wasActive')
  ok(off.active === false && gate.selfAllowSnapshot().active === false, '关闭后状态为 inactive')
  const offAgain = gate.selfAllowOff()
  ok(offAgain.ok === true && offAgain.wasActive === false, '重复关闭是幂等的')

  // 非法 rect 一律拒绝且不改变现有状态
  const badRects = [
    null,
    {},
    { x: -1, y: 0, w: 10, h: 10 },
    { x: 0, y: 0, w: 0, h: 10 },
    { x: 0, y: 0, w: 10, h: -2 },
    { x: 'a', y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 10.5, h: 10 },
  ]
  for (const bad of badRects) {
    const badArm = gate.selfAllowArm({ rect: bad, seconds: 5 })
    ok(badArm.ok === false && typeof badArm.error === 'string', '非法 rect 被拒绝: ' + JSON.stringify(bad))
    ok(gate.selfAllowSnapshot().active === false, '非法 rect 不改变授权状态')
  }

  // seconds 夹取到 config.allowSelfMaxMs（120000ms）；缺省用 armDefaultSeconds=60
  const bigArm = gate.selfAllowArm({ rect: { x: 0, y: 0, w: 5, h: 5 }, seconds: 99999 })
  ok(bigArm.ok === true && bigArm.remainingMs === 120000, 'seconds 被夹取到 allowSelfMaxMs')
  const defArm = gate.selfAllowArm({ rect: { x: 0, y: 0, w: 5, h: 5 } })
  ok(defArm.ok === true && defArm.remainingMs === 60000, 'seconds 缺省用 armDefaultSeconds')

  // rect 缺省时回退到 config.allowSelfRect
  const cfgRectGate = new AccessGate({
    ctx: NO_APPROVAL,
    config: normalizeConfig({ allowSelfRect: { x: 1, y: 2, w: 3, h: 4 } }),
    now: () => clock,
  })
  const cfgArm = cfgRectGate.selfAllowArm({ seconds: 5 })
  ok(cfgArm.ok === true, 'rect 缺省时用 config.allowSelfRect')
  eq(cfgArm.rect, { x: 1, y: 2, w: 3, h: 4 }, 'config.allowSelfRect 作为默认矩形')
  pass('access: 作用域化 allowSelf（授予/过期/越界/关闭/夹取）')
}

// ---------------------------------------------------------------------------
// D. policy.evaluateWindowDeny 第 4 参数 extra
// ---------------------------------------------------------------------------
{
  const own = intrinsicOwnProcesses()[0]
  ok(typeof own === 'string' && own === 'DeepSeek Harness.exe', '内置自身进程名单含 DeepSeek Harness.exe')

  const cfgSelf = normalizeConfig({ allowSelfWindow: true })
  const cfgPlain = normalizeConfig({})
  const ownNames = ownProcessNames(cfgSelf)
  const ownWindow = {
    handle: 101,
    title: 'DSH',
    process: 'DeepSeek Harness.exe',
    rect: { x: 0, y: 0, width: 1600, height: 900 },
    denied: true,
  }
  const rect = { x: 0, y: 0, w: 1600, h: 900 }
  const extraOk = { selfAllow: { point: { x: 800, y: 450 }, rect }, allowSelfWindow: true }

  // 向后兼容：3 参数旧调用行为不变
  const base = evaluateWindowDeny(ownWindow, cfgSelf, ownNames)
  ok(base.denied === true, '3 参数旧调用仍拒绝自身窗口（向后兼容）')
  ok(Array.isArray(base.reasons) && base.reasons.length === 2, '旧调用 reasons 保持（helper 标记 + 自身进程）')
  ok(base.selfAllowed === undefined, '旧调用不产生 selfAllowed 字段')
  ok(evaluateWindowDeny(ownWindow, cfgSelf, ownNames, null).denied === true, 'extra=null 时保持拒绝')

  // 自身窗口 + 配置开关 + 点在矩形内 → 放行
  const allowed = evaluateWindowDeny(ownWindow, cfgSelf, ownNames, extraOk)
  ok(allowed.denied === false && allowed.selfAllowed === true, '自身窗口 + allowSelfWindow + 点在矩形内 → 放行')
  eq(allowed.reasons, [], '放行时 reasons 为空数组（下游按 denied 分支消费）')
  ok(Array.isArray(allowed.selfAllowedReasons) && allowed.selfAllowedReasons.length === 2, '放行原因保留在 selfAllowedReasons 供审计')

  // 自身进程原因单独存在（helper 未标记 denied）也可放行
  const allowed2 = evaluateWindowDeny({ ...ownWindow, denied: false }, cfgSelf, ownNames, extraOk)
  ok(allowed2.denied === false && allowed2.selfAllowed === true, '仅自身进程原因时也可放行')

  // 各种不放行组合
  ok(evaluateWindowDeny(ownWindow, cfgPlain, ownProcessNames(cfgPlain), extraOk).denied === true, 'config.allowSelfWindow=false 时不放行')
  ok(
    evaluateWindowDeny(ownWindow, cfgSelf, ownNames, { selfAllow: { point: { x: 1600, y: 450 }, rect }, allowSelfWindow: true }).denied === true,
    '点落在矩形右边界（开区间）不放行',
  )
  ok(
    evaluateWindowDeny(ownWindow, cfgSelf, ownNames, { selfAllow: { point: { x: 800, y: 450 }, rect: { x: 0, y: 0, w: 400, h: 300 } }, allowSelfWindow: true })
      .denied === true,
    '点不在给定矩形内不放行',
  )
  ok(evaluateWindowDeny(ownWindow, cfgSelf, ownNames, { selfAllow: extraOk.selfAllow, allowSelfWindow: false }).denied === true, 'extra.allowSelfWindow=false 显式否决')
  ok(evaluateWindowDeny(ownWindow, cfgSelf, ownNames, { allowSelfWindow: true }).denied === true, '缺 selfAllow 时不放行')
  ok(evaluateWindowDeny(ownWindow, cfgSelf, ownNames, {}).denied === true, '空 extra 不放行')

  // 管理员窗口 / 最小化 / 安全界面 / deny 列表 → 一律不放行
  ok(evaluateWindowDeny({ ...ownWindow, elevated: true }, cfgSelf, ownNames, extraOk).denied === true, '自身进程但管理员窗口不放行')
  ok(evaluateWindowDeny({ ...ownWindow, minimized: true }, cfgSelf, ownNames, extraOk).denied === true, '最小化窗口不放行')
  const cfgDenySelf = normalizeConfig({ allowSelfWindow: true, denyProcesses: ['DeepSeek Harness.exe'] })
  ok(evaluateWindowDeny(ownWindow, cfgDenySelf, ownProcessNames(cfgDenySelf), extraOk).denied === true, '自身进程被 denyProcesses 显式禁止时不放行')
  const secure = {
    handle: 102,
    title: 'Windows 安全',
    process: 'LogonUI.exe',
    className: 'LogonUI',
    rect: { x: 0, y: 0, width: 1600, height: 900 },
    denied: true,
  }
  ok(evaluateWindowDeny(secure, cfgSelf, ownProcessNames(cfgSelf), extraOk).denied === true, '系统安全/登录界面不放行')
  const cfgDenyApp = normalizeConfig({ allowSelfWindow: true, denyProcesses: ['notepad.exe'] })
  const notepad = { handle: 103, title: '无标题 - 记事本', process: 'notepad.exe', rect: { x: 0, y: 0, width: 800, height: 600 }, denied: true }
  ok(evaluateWindowDeny(notepad, cfgDenyApp, ownProcessNames(cfgDenyApp), extraOk).denied === true, 'denyProcesses 命中的第三方窗口不放行')
  const cfgTitle = normalizeConfig({ allowSelfWindow: true, denyTitleContains: ['DSH'] })
  ok(evaluateWindowDeny(ownWindow, cfgTitle, ownProcessNames(cfgTitle), extraOk).denied === true, 'denyTitleContains 命中不放行')

  // 普通窗口 / 无窗口：行为不变
  const normal = { handle: 104, title: '记事本', process: 'notepad.exe', rect: { x: 0, y: 0, width: 800, height: 600 } }
  const normalDeny = evaluateWindowDeny(normal, cfgSelf)
  ok(normalDeny.denied === false && normalDeny.reasons.length === 0, '普通窗口不受影响')
  ok(normalDeny.selfAllowed === undefined, '普通窗口不产生 selfAllowed 字段')
  ok(evaluateWindowDeny(null, cfgSelf, ownNames, extraOk).denied === true, '没有可识别窗口时仍拒绝')
  pass('policy: allowSelf 仅放行“自身窗口”这一类原因')
}

// ---------------------------------------------------------------------------
// E. 三层 ACL（放行 / 拒绝 / 申请；优先级 拒绝 > 放行 > 申请 > 默认）
// ---------------------------------------------------------------------------
{
  const plain = { handle: 1, process: 'x.exe', title: 'x', rect: { x: 0, y: 0, w: 100, h: 100 } }
  // 默认：不在任何名单 → 不因名单被拦
  ok(evaluateWindowDeny(plain, normalizeConfig({})).denied === false, '默认（不在名单）不被拦')
  // 拒绝 → 拦
  const denyCfg = normalizeConfig({ denyProcesses: ['x.exe'] })
  ok(evaluateWindowDeny(plain, denyCfg).denied === true, '拒绝名单命中 → 拦')
  // 申请 → 拦（需人类确认）
  const askCfg = normalizeConfig({ askProcesses: ['x.exe'] })
  const ask = evaluateWindowDeny(plain, askCfg)
  ok(ask.denied === true && ask.reasons.some((r) => r.includes('申请名单')), '申请名单命中 → 需人类确认')
  // 放行 > 申请：同一目标同时放行+申请 → 放行豁免申请
  const allowAsk = normalizeConfig({ allowProcesses: ['x.exe'], askProcesses: ['x.exe'] })
  ok(evaluateWindowDeny(plain, allowAsk).denied === false, '放行 > 申请（allow 豁免 ask）')
  // 拒绝 > 放行：同一目标同时拒绝+放行 → 拒绝仍拦
  const denyAllow = normalizeConfig({ denyProcesses: ['x.exe'], allowProcesses: ['x.exe'] })
  ok(evaluateWindowDeny(plain, denyAllow).denied === true, '拒绝 > 放行（allow 盖不过 deny）')
  // 放行盖不过内置安全清单
  const regedit = { handle: 2, process: 'regedit.exe', title: '注册表编辑器', rect: { x: 0, y: 0, w: 100, h: 100 } }
  ok(evaluateWindowDeny(regedit, normalizeConfig({ allowProcesses: ['regedit.exe'] })).denied === true, '放行盖不过内置安全清单')
  pass('policy: 三层 ACL 放行 / 拒绝 / 申请（拒绝 > 放行 > 申请）')
}

console.log(`PASS tools/access-smoke.mjs: ${checks} 项断言全部通过（config / access / policy）`)
