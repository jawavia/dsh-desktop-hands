#!/usr/bin/env node
// tools/integration-smoke.mjs —— 跨三引擎集成冒烟（零第三方依赖，只用 Node 自带 assert）
//
// 为什么需要它：verify 里原有的 15 项大多是单引擎自测 + `node --check`，
// 没有一项把 pixel / control / stroke 放到**同一份共享状态**上一起验证。
// 本脚本专门验"融合"这条缝，四组：
//   A. 授权 fan-out：core/gate.mjs 的一次 armAll（或 pixel 侧 fanOutArm）→ 三引擎各读自己的 scope
//      都变 armed；disarm 后三个 scope 全 false。（真实引擎代码路径：control 走 policy.check()，
//      stroke 走它自己的 stroke_status 工具——都经由各自模块读同一份 gate.json。）
//   B. StopBus 的跨引擎清理：core/abort 写 stop.signal → control 读到；pixel 重新授权时清掉。
//   C. 共享 deny-list：core 的 readDenyGroups/matchWindow、pixel 的 matchDefaultDeny、
//      control 的 matchDeny 读到**同一份文件、同一个 group/rule**（用只存在于临时目录的"哨兵组"
//      证明它们读的是共享文件而不是各自内置清单）。stroke v0.1 明确不做 deny 判定，
//      也不导出匹配器 → 只验 core 层并在输出里注明"未能跨引擎验证"。
//   D. 流水线工具：audit-report.mjs 在临时数据目录能跑通（非 0 退出才红）；
//      make-tree-manifest.mjs 能对活树生成清单，且**全量逐文件**复算 sha256（不再保留并行协作期的
//      IN_FLIGHT 排除列表）。复算口径与 tools/build-id.mjs 的全树指纹同源：同一批文件、同一套排除
//      （只跳过 node_modules / .git，以及生成物 tools/BUILD-ID.json 自身——那是防指纹自引用，不是
//      "排除清单"）。清单生成后被并发改写（mtime 晚于清单起点）的文件单独报告、不计失败，但绝不静默跳过。
//
// 【I6 口径】core/gate.mjs、core/abort.mjs 在本包里没有生产 import（index.js:9 只用 core/policy.mjs
// 的 seedDenyList）→ 本脚本里它们是**参考实现**：生产路径以三引擎真实 gate 为准。因此 A/B 组既验
// （1）core 参考实现写出的共享 gate/stop 能被三引擎真实读取端（control policy.check、stroke_status、
// pixel fanOutArm）读到，也验（2）三引擎自己的写路径落到同一份 gate.json——后者才是必测项。
//
// 隔离（关键）：全程不碰真人授权/审计。
//   - DSH_HANDS_DATA_DIR → 临时 data/（共享 gate.json / deny-list.json / audit/*）
//   - DSH_HOME          → 临时 dsh-home/（pixel 自己的数据目录）
//   - USERPROFILE+ HOME → 临时 home/（Node os.homedir() 在 Windows 上认 USERPROFILE；
//     pixel/control 的 deny-list 共享路径与 pixel 的历史审计 ~/.dsh/click-matrix 都按 homedir 拼，
//     不重定向它们就会读到/写到真人数据）
//   跑完递归删除临时树；脚本还会打印真实 gate.json / audit.jsonl 的 sha 与行数（跑前/跑后）。
//
// 退出码与 verify 一致：0 = 全过；1 = 任一检查失败。可单独跑：node tools/integration-smoke.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const asPosix = (p) => String(p).split(sep).join('/')

// ---------------------------------------------------------------------------
// 0. 建临时树 + 重定向所有数据目录（必须在 import 任何引擎模块之前）
// ---------------------------------------------------------------------------
const REAL_HOME = homedir()
const REAL_GATE = join(REAL_HOME, '.dsh', 'dsh-desktop-hands', 'gate.json')
const REAL_AUDIT = join(REAL_HOME, '.dsh', 'click-matrix', 'audit.jsonl')

function fingerprint(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return { exists: true, lines: text.split('\n').filter((l) => l.trim()).length, sha256: sha256(text) }
  } catch {
    return { exists: false, lines: 0, sha256: '' }
  }
}
const REAL_BEFORE = { gate: fingerprint(REAL_GATE), audit: fingerprint(REAL_AUDIT) }

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-hands-integration-'))
const DATA = join(TMP_ROOT, 'data')
const FAKE_HOME = join(TMP_ROOT, 'home')
const FAKE_DSH_HOME = join(TMP_ROOT, 'dsh-home')
for (const d of [DATA, FAKE_HOME, FAKE_DSH_HOME]) mkdirSync(d, { recursive: true })

process.env.DSH_HANDS_DATA_DIR = DATA
process.env.DSH_HOME = FAKE_DSH_HOME
process.env.USERPROFILE = asPosix(FAKE_HOME) // Windows: os.homedir() 读 USERPROFILE
process.env.HOME = asPosix(FAKE_HOME)        // POSIX 语义下同一份映射

const HOMEDIR_ISOLATED = asPosix(homedir()).toLowerCase() === asPosix(FAKE_HOME).toLowerCase()

// 共享 deny-list：往**临时 home** 的共享位置播种一份"哨兵"清单。
// 三个引擎都按 <homedir>/.dsh/dsh-desktop-hands/deny-list.json 读，所以它们读的就是这一份。
const SHARED_DENY = join(FAKE_HOME, '.dsh', 'dsh-desktop-hands', 'deny-list.json')
mkdirSync(dirname(SHARED_DENY), { recursive: true })
const SENTINEL_GROUP = 'smoke-sentinel'
const SENTINEL_PROCESS = 'dsh-smoke-sentinel.exe'
const SENTINEL_TITLE = '冒烟哨兵窗口标题'
const SENTINEL_DENY = {
  version: 1,
  source: 'integration-smoke',
  note: '只存在于临时目录的哨兵清单：用来证明三引擎读的是同一份共享 deny-list，而不是各自内置清单。',
  groups: {
    [SENTINEL_GROUP]: {
      label: '集成冒烟哨兵',
      processes: [SENTINEL_PROCESS],
      titleExact: [SENTINEL_TITLE],
      titleNeedles: ['冒烟哨兵'],
    },
  },
}
const { writeFileSync } = await import('node:fs')
writeFileSync(SHARED_DENY, JSON.stringify(SENTINEL_DENY, null, 2) + '\n', 'utf8')

// ---------------------------------------------------------------------------
// 1. 加载三引擎与 core（都在环境重定向之后；用动态 import 保证顺序）
// ---------------------------------------------------------------------------
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href)
// 【I6 标注】core/gate.mjs 与 core/abort.mjs 在这里只作「参考实现」被引用：
// 生产路径以三引擎真实 gate 为准（它们没有被 index.js 生产 import）；A/B 组同时验三引擎真实读取端。
const coreGate = await imp('core/gate.mjs')
const corePolicy = await imp('core/policy.mjs')
const coreAbort = await imp('core/abort.mjs')
const pixelGate = await imp('engines/pixel/lib/gate.js')
const pixelPolicy = await imp('engines/pixel/lib/policy.js')
const controlGate = await imp('engines/control/src/gate.js')
const controlPolicy = await imp('engines/control/src/policy.js')
const controlDeny = await imp('engines/control/src/deny.js')
const stroke = await imp('engines/stroke/index.js')
// 与 tools/check-bundle.mjs、verify 第 17 项同一实现：全树指纹规则只在 tools/build-id.mjs 写一份
const buildIdTool = await imp('tools/build-id.mjs')

// stroke 的 stroke_status 工具是它对外暴露的"读授权"路径（内部 readStrokeScope 未导出）。
const strokeState = stroke.__createState({})
const strokeStatusTool = stroke.__buildToolDefinitions(strokeState).find((d) => d.name === 'stroke_status')
assert.ok(strokeStatusTool && typeof strokeStatusTool.execute === 'function', 'stroke 未导出可用的 stroke_status 工具')

const strokeStatusText = async () => String((await strokeStatusTool.execute({})).text || '')

// ---------------------------------------------------------------------------
// 2. 检查框架
// ---------------------------------------------------------------------------
let total = 0
let failed = 0
const startedAt = Date.now()
const notes = []

function section(title) {
  console.log('')
  console.log(`[${title}]`)
}

async function check(name, fn) {
  total++
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}`)
    const detail = String(error && error.message ? error.message : error)
    console.log('       ' + detail.replace(/\n/g, '\n       '))
  }
}

const gateFile = () => join(DATA, 'gate.json')
const gateJson = () => JSON.parse(readFileSync(gateFile(), 'utf8'))

// ---------------------------------------------------------------------------
// 3. 隔离自检
// ---------------------------------------------------------------------------
section('隔离：临时目录 + homedir 重定向')
await check('数据目录全部落在临时树内（不碰真实 ~/.dsh）', () => {
  assert.equal(process.env.DSH_HANDS_DATA_DIR, DATA)
  assert.equal(process.env.DSH_HOME, FAKE_DSH_HOME)
  assert.ok(asPosix(DATA).startsWith(asPosix(TMP_ROOT)), 'DSH_HANDS_DATA_DIR 不在临时树内')
  assert.notEqual(asPosix(DATA).toLowerCase(), asPosix(join(REAL_HOME, '.dsh', 'dsh-desktop-hands')).toLowerCase())
  assert.equal(asPosix(SHARED_DENY).startsWith(asPosix(TMP_ROOT)), true)
})
await check(`os.homedir() 已重定向到临时 home（pixel/control 的 deny 路径因此被隔离）`, () => {
  assert.ok(HOMEDIR_ISOLATED, `homedir()=${homedir()} 未跟随 USERPROFILE=${process.env.USERPROFILE}`)
})

// ---------------------------------------------------------------------------
// 4. A. 授权 fan-out：一次授权 → 三 scope
// ---------------------------------------------------------------------------
section('A. 授权 fan-out：一次人类动作让 pixel/control/stroke 三个 scope 同时 armed')
// 【I6】core.armAll 是参考实现（生产路径无 import，以三引擎真实 gate 为准）；
// 紧接着 3 条用 control policy.check / stroke_status / pixel fanOutArm 三个真实读取端复核同一份 gate.json。
await check('core.armAll() → gate.json 三个 scope 都 armed，core.isEngineArmed 三项全 true', () => {
  coreGate.armAll(DATA, { seconds: 120, by: 'integration-smoke', note: 'fan-out' })
  const j = gateJson()
  assert.ok(j.armedUntil > Date.now(), 'armedUntil 未在未来')
  for (const engine of ['pixel', 'control', 'stroke']) {
    assert.equal(j.scopes[engine].armed, true, `${engine} scope 未 arm`)
    assert.equal(coreGate.isEngineArmed(engine, DATA), true, `core 读 ${engine} 未 armed`)
  }
})
await check('control 引擎真实路径 policy.check() 读到 armed → 放行（null）', () => {
  assert.equal(controlPolicy.check('click', {}, { armRequired: true }), null, 'control 未按共享 gate 放行')
})
await check('stroke 引擎真实路径 stroke_status 读到 armed（文本含「已授权」）', async () => {
  const text = await strokeStatusText()
  assert.match(text, /会话: 已授权/, `stroke 未读到共享 gate：${text.split('\n')[0]}`)
})
await check('pixel 侧 fanOutArm() 写出的仍是同一份 gate.json，三引擎都读到 armed（反向验证）', async () => {
  pixelGate.fanOutArm({ seconds: 60, by: 'integration-smoke', note: 'pixel-fanout' })
  for (const engine of ['pixel', 'control', 'stroke']) {
    assert.equal(coreGate.isEngineArmed(engine, DATA), true, `pixel fanOutArm 后 core 读 ${engine} 未 armed`)
  }
  assert.equal(controlPolicy.check('click', {}, { armRequired: true }), null)
  assert.match(await strokeStatusText(), /会话: 已授权/)
})

// ---------------------------------------------------------------------------
// 5. B. StopBus 跨引擎：stop token 写入 → control 读到；pixel 重新授权时清掉
// ---------------------------------------------------------------------------
section('B. StopBus：core 写 stop.signal → control 读到；pixel 重新 arm 时清掉（重新授权=恢复）')
// 【I6】coreAbort.writeStop 是参考实现（生产路径以三引擎真实 gate 为准）；controlGate.readStop 是 control 的真实读取端。
await check('stop token 跨引擎可见，且 pixel fanOutArm 会清除它', () => {
  coreAbort.writeStop(DATA, { level: 'hard', by: 'command', reason: 'integration-smoke' })
  const seen = controlGate.readStop(DATA)
  assert.ok(seen, 'control 没读到 stop.signal')
  assert.equal(seen.level, 'hard')
  pixelGate.fanOutArm({ seconds: 30, by: 'integration-smoke', note: 'clear-stop' })
  assert.equal(controlGate.readStop(DATA), null, 'pixel 重新授权后 stop.signal 未被清除')
})

// ---------------------------------------------------------------------------
// 6. A'. disarm：三 scope 全 false
// ---------------------------------------------------------------------------
section("A'. disarm：三个 scope 全 false（control 拒绝、stroke 未授权）")
await check('core.disarm() → 三 scope 全 false，control.check 拒绝且给出人类授权提示', async () => {
  coreGate.disarm(DATA, { by: 'integration-smoke', note: 'disarm' })
  const j = gateJson()
  assert.equal(Number(j.armedUntil) || 0, 0, 'armedUntil 未归零')
  for (const engine of ['pixel', 'control', 'stroke']) {
    assert.equal(j.scopes[engine].armed, false, `${engine} scope 未 disarm`)
    assert.equal(coreGate.isEngineArmed(engine, DATA), false, `core 读 ${engine} 仍未 false`)
  }
  const denial = controlPolicy.check('click', {}, { armRequired: true })
  assert.equal(typeof denial, 'string', 'control 未拒绝')
  assert.match(denial, /需要人类授权/)
  assert.match(await strokeStatusText(), /会话: 未授权/)
})
await check('pixel 侧 fanOutDisarm() → 同样让三 scope 全 false（两条 disarm 路径一致）', async () => {
  pixelGate.fanOutDisarm({ by: 'integration-smoke', note: 'disarm' })
  for (const engine of ['pixel', 'control', 'stroke']) {
    assert.equal(coreGate.isEngineArmed(engine, DATA), false, `pixel fanOutDisarm 后 ${engine} 仍未 false`)
  }
  assert.equal(coreGate.isEngineArmed('control', DATA), false)
  assert.equal(typeof controlPolicy.check('click', {}, { armRequired: true }), 'string')
})

// ---------------------------------------------------------------------------
// 7. C. 共享 deny-list
// ---------------------------------------------------------------------------
section('C. 共享 deny-list：三个引擎读到同一份（临时哨兵清单）')
const probeWindow = { process: 'C:/Program Files/Smoke/' + SENTINEL_PROCESS, title: '随便什么窗口' }
await check('core.readDenyGroups + matchWindow 命中哨兵组', () => {
  const groups = corePolicy.readDenyGroups(SHARED_DENY)
  assert.ok(groups, 'core 读不到共享 deny-list')
  assert.deepEqual(Object.keys(groups), [SENTINEL_GROUP], 'core 读到的 group 不是哨兵清单')
  const hit = corePolicy.matchWindow(probeWindow, groups)
  assert.ok(hit, 'core 未命中哨兵进程')
  assert.equal(hit.group, SENTINEL_GROUP)
  assert.match(hit.rule, /^process:/)
})
await check('pixel.matchDefaultDeny() 命中的是**共享文件**（哨兵不在它的内置清单里）', () => {
  assert.ok(HOMEDIR_ISOLATED, 'homedir 未隔离，无法验证 pixel 读共享文件')
  const hit = pixelPolicy.matchDefaultDeny(probeWindow)
  assert.ok(hit, 'pixel 未命中哨兵（说明它回退到了内置清单）')
  assert.equal(hit.group, SENTINEL_GROUP, `pixel 命中 ${hit.group}`)
  assert.equal(hit.rule, `process:${SENTINEL_PROCESS}`)
})
await check('control.matchDeny() 读到同一份文件、同一个 group/rule', () => {
  assert.ok(HOMEDIR_ISOLATED, 'homedir 未隔离，无法验证 control 读共享文件')
  const hit = controlDeny.matchDeny(probeWindow)
  assert.ok(hit, 'control 未命中哨兵（说明它回退到了旧行为）')
  assert.equal(hit.group, SENTINEL_GROUP)
  assert.equal(hit.rule, `process:${SENTINEL_PROCESS}`)
})
await check('负例一致：不在清单里的窗口三处都不命中（防"全都拒"式假绿）', () => {
  const win = { process: 'notepad.exe', title: '无标题 - 记事本' }
  assert.equal(corePolicy.matchWindow(win, corePolicy.readDenyGroups(SHARED_DENY)), null)
  assert.equal(pixelPolicy.matchDefaultDeny(win), null)
  assert.equal(controlDeny.matchDeny(win), null)
})
await check('titleExact 也走共享文件（三处一致）', () => {
  const win = { process: 'notepad.exe', title: SENTINEL_TITLE }
  const coreHit = corePolicy.matchWindow(win, corePolicy.readDenyGroups(SHARED_DENY))
  const pixelHit = pixelPolicy.matchDefaultDeny(win)
  const controlHit = controlDeny.matchDeny(win)
  assert.equal(coreHit && coreHit.group, SENTINEL_GROUP)
  assert.equal(pixelHit && pixelHit.group, SENTINEL_GROUP)
  assert.equal(controlHit && controlHit.group, SENTINEL_GROUP)
  assert.equal(coreHit.rule, pixelHit.rule)
  assert.equal(coreHit.rule, controlHit.rule)
})
notes.push(
  'stroke v0.1 不实现 deny 判定（engines/stroke/index.js 头部注释明示"画布范围内暂不做 deny/自身窗口判定"），'
    + '也不导出匹配器 → 共享 deny-list 的跨引擎验证覆盖 core + pixel + control 三个读取端；stroke 侧未能跨引擎验证。',
)

// ---------------------------------------------------------------------------
// 8. D. 流水线工具：audit-report / make-tree-manifest
// ---------------------------------------------------------------------------
section('D. 流水线工具：audit-report 跑通 + make-tree-manifest 抽样可复算')
await check('audit-report.mjs 在临时数据目录上跑通（退出 0，control/stroke 审计可校验）', () => {
  // 先让两个"该有审计"的引擎各写一行：control 用 policy.audit()，stroke 的几行由上面 stroke_status 调用写。
  controlPolicy.audit({ action: 'integration-smoke', decision: 'ok' })
  assert.ok(existsSync(join(DATA, 'audit', 'control.jsonl')), 'control 审计没写出来')
  assert.ok(existsSync(join(DATA, 'audit', 'stroke.jsonl')), 'stroke 审计没写出来')
  const r = spawnSync(NODE, [join(ROOT, 'tools', 'audit-report.mjs'), '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env },
  })
  assert.equal(r.status, 0, `audit-report 退出码 ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-500)}`)
  let summary = null
  try {
    summary = JSON.parse(String(r.stdout).trim().split('\n').pop())
  } catch {
    assert.fail('audit-report --json 输出不是 JSON: ' + String(r.stdout).slice(0, 300))
  }
  assert.equal(summary.failed, 0, 'audit-report 报告了 FAIL')
  const byEngine = Object.fromEntries(summary.engines.map((e) => [e.engine, e]))
  // pixel 是历史主链：本脚本把 homedir 重定向了，所以它必然"还不存在" → WARN（不算 FAIL）。
  assert.equal(byEngine.pixel.exists, false, '临时 home 下不应有 pixel 历史审计')
  assert.equal(byEngine.control.exists, true)
  assert.equal(byEngine.control.ok, true, 'control 审计校验失败: ' + byEngine.control.detail)
  assert.ok(byEngine.control.lines >= 1, 'control 审计行数 < 1')
  assert.equal(byEngine.stroke.exists, true)
  assert.equal(byEngine.stroke.ok, true, 'stroke 审计校验失败: ' + byEngine.stroke.detail)
  assert.ok(byEngine.stroke.lines >= 1, 'stroke 审计行数 < 1')
  // 顺便证明 stroke_status 真的留了痕（每次工具调用一行）
  const strokeRows = readFileSync(join(DATA, 'audit', 'stroke.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.ok(strokeRows.some((l) => JSON.parse(l).tool === 'stroke_status'), 'stroke 审计里没有 stroke_status 的痕迹')
})

section('E. make-tree-manifest：活树清单 + 全量逐文件复算（与 build-id 指纹同口径）')
const MANIFEST = join(TMP_ROOT, 'tree.sha256')
let MANIFEST_ROWS = []
// 清单生成的起点时间：用来区分「清单生成后又被人并发改了」与「清单/哈希本身算错」。
const MANIFEST_STARTED_AT = Date.now()
await check('make-tree-manifest.mjs 能对活树生成清单（退出 0，行数 > 0）', () => {
  const r = spawnSync(
    NODE,
    [join(ROOT, 'tools', 'make-tree-manifest.mjs'), ROOT, MANIFEST, '--exclude=node_modules', '--exclude=.git'],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env } },
  )
  assert.equal(r.status, 0, `make-tree-manifest 退出码 ${r.status}: ${(r.stderr || '').trim().slice(-500)}`)
  const text = readFileSync(MANIFEST, 'utf8')
  MANIFEST_ROWS = text.split('\n').filter((l) => l.trim())
  assert.ok(MANIFEST_ROWS.length > 50, `清单只有 ${MANIFEST_ROWS.length} 行，活树不可能这么少`)
  const paths = MANIFEST_ROWS.map((l) => l.split(' *./').pop())
  for (const must of ['core/gate.mjs', 'core/policy.mjs', 'engines/stroke/index.js', 'tools/integration-smoke.mjs', 'tools/verify.mjs']) {
    assert.ok(paths.includes(must), `清单里缺 ${must}`)
  }
  for (const line of MANIFEST_ROWS.slice(0, 3)) assert.match(line, /^[0-9a-f]{64} \*\.\//)
})
await check('清单逐文件 sha256 全量复算（不排除任何并行编辑文件；与 build-id 指纹同口径）', () => {
  assert.ok(MANIFEST_ROWS.length > 20, '清单行数不足以复算')
  const parsed = MANIFEST_ROWS.map((line) => {
    const m = line.match(/^([0-9a-f]{64}) \*\.\/(.+)$/)
    assert.ok(m, `清单行格式不认识: ${line.slice(0, 80)}`)
    return { hash: m[1], rel: m[2] }
  })
  // 与 tools/build-id.mjs 的全树指纹**同一口径**：清单里除了生成物 tools/BUILD-ID.json 自身，
  // 其余每一行都要和指纹的 files 列表一一对应（指纹排除它是防自引用，不是"并行编辑排除清单"）。
  const fp = buildIdTool.computeTreeFingerprint(ROOT)
  const rowsForFingerprint = parsed.filter((e) => e.rel !== 'tools/BUILD-ID.json')
  assert.equal(
    rowsForFingerprint.length,
    fp.fileCount,
    `清单 ${rowsForFingerprint.length} 行（除 BUILD-ID.json 自身）≠ 指纹 fileCount ${fp.fileCount}：两处遍历口径已分叉`,
  )
  const manifestRels = new Set(rowsForFingerprint.map((e) => e.rel))
  for (const f of fp.files) assert.ok(manifestRels.has(f.rel), `清单里缺 ${f.rel}`)
  for (const e of rowsForFingerprint) assert.ok(fp.files.some((f) => f.rel === e.rel), `指纹里缺 ${e.rel}`)

  // 全量复算：清单每一行都重算（不再抽样、不再 IN_FLIGHT 排除）。
  // 命中不一致时用 mtime 区分「并发写盘」与「真错」：mtime 晚于清单生成起点 → 并发改写，
  // 单独报告（不判红，但打印到 std out，绝不静默跳过）；否则一律算失败。
  const mismatched = []
  const concurrent = []
  for (const entry of parsed) {
    const abs = join(ROOT, ...entry.rel.split('/'))
    let actual = ''
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        actual = sha256(readFileSync(abs))
        lastError = null
      } catch (error) {
        lastError = error
        actual = ''
      }
      if (actual === entry.hash) break
      // 给并发写盘一点时间（最多重试 3 次 × ~60ms）
      const until = Date.now() + 60
      while (Date.now() < until) { /* spin */ }
    }
    if (actual === entry.hash) continue
    let mtimeMs = 0
    try { mtimeMs = statSync(abs).mtimeMs } catch { /* 下面统一报 */ }
    if (!lastError && mtimeMs > MANIFEST_STARTED_AT) {
      concurrent.push(`${entry.rel}: 清单 ${entry.hash.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…（mtime 晚于清单起点 → 并发写盘）`)
    } else {
      mismatched.push(lastError
        ? `${entry.rel}: 读不到（${lastError.message}）`
        : `${entry.rel}: 清单 ${entry.hash.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`)
    }
  }
  if (concurrent.length) {
    console.log(`       INFO  ${concurrent.length} 个文件在清单生成后被并发改写（不计失败，但不隐藏）：`)
    for (const line of concurrent) console.log('             ' + line)
  }
  assert.deepEqual(mismatched, [], `全量复算失败（${parsed.length} 个文件里 ${mismatched.length} 个不符）：\n` + mismatched.join('\n'))

  // 与 tools/BUILD-ID.json 对一次读数：stale 只报告（硬判是 verify 第 17 项 build-id --check），
  // 这样并行编辑期不会出现「integration 红 / build-id 也红」的双重噪声。
  const bidPath = join(ROOT, 'tools', 'BUILD-ID.json')
  assert.ok(existsSync(bidPath), '缺少 tools/BUILD-ID.json（打包前必须 node tools/build-id.mjs --update）')
  const record = JSON.parse(readFileSync(bidPath, 'utf8'))
  const same = record.buildId === fp.buildId && record.fileCount === fp.fileCount && record.treeSha256 === fp.treeSha256
  if (same) {
    console.log(`       BUILD-ID 与活树一致：buildId=${fp.buildId} fileCount=${fp.fileCount}`)
  } else {
    console.log('       INFO  BUILD-ID 已过期（并行编辑期允许；打包前必须 --update）：')
    console.log(`             记录 buildId=${record.buildId} fileCount=${record.fileCount} treeSha256=${String(record.treeSha256).slice(0, 16)}…`)
    console.log(`             实际 buildId=${fp.buildId} fileCount=${fp.fileCount} treeSha256=${fp.treeSha256}`)
    notes.push('integration-smoke E 组：本次运行的活树与 tools/BUILD-ID.json 不一致（并行编辑 / 未 --update）。本组只报告，硬判由 verify 第 17 项 build-id --check 负责；打包前必须在活树根跑 node tools/build-id.mjs --update。')
  }
})

// ---------------------------------------------------------------------------
// 9. 收尾：真实文件指纹（跑前/跑后）+ 清理临时树
// ---------------------------------------------------------------------------
const REAL_AFTER = { gate: fingerprint(REAL_GATE), audit: fingerprint(REAL_AUDIT) }
const sameReal =
  REAL_BEFORE.gate.sha256 === REAL_AFTER.gate.sha256 &&
  REAL_BEFORE.gate.lines === REAL_AFTER.gate.lines &&
  REAL_BEFORE.audit.sha256 === REAL_AFTER.audit.sha256 &&
  REAL_BEFORE.audit.lines === REAL_AFTER.audit.lines

console.log('')
console.log('[隔离证据] 真实数据文件（本脚本全程重定向到临时目录，不应变化）')
const fmt = (f) => (f.exists ? `lines=${f.lines} sha256=${f.sha256}` : '不存在')
console.log(`  跑前 gate.json   : ${fmt(REAL_BEFORE.gate)}`)
console.log(`  跑后 gate.json   : ${fmt(REAL_AFTER.gate)}`)
console.log(`  跑前 audit.jsonl : ${fmt(REAL_BEFORE.audit)}`)
console.log(`  跑后 audit.jsonl : ${fmt(REAL_AFTER.audit)}`)
if (sameReal) {
  console.log('  结论：真实 gate.json / audit.jsonl 未变化（隔离有效）')
} else {
  console.log('  注意：真实文件指纹发生变化——本脚本没有写它们的代码路径（已全部重定向），'
    + '若是并行会话/agent 同时操作属外部写入；请单独核对。')
}

if (notes.length) {
  console.log('')
  console.log('[说明]')
  for (const n of notes) console.log('  · ' + n)
}

try {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  console.log('')
  console.log(`临时数据目录已清理：${TMP_ROOT}`)
} catch (error) {
  console.log(`临时数据目录清理失败（不影响结论）：${TMP_ROOT} — ${String(error && error.message ? error.message : error)}`)
}

console.log('')
console.log(`integration-smoke 完成：${total - failed}/${total} 项通过，用时 ${Date.now() - startedAt}ms`)
process.exit(failed === 0 ? 0 : 1)
