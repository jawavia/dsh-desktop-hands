#!/usr/bin/env node
// dsh-desktop-hands · 骨架自检（只读，不安装、不改配置）
//
// 用法:
//   node tools/check-bundle.mjs
//   node tools/check-bundle.mjs --profile "C:/Users/<you>/.dsh/profiles/desktop"
//
// 检查五组事：
//   1. cordis.patch.yml 结构：一个 insert、三行、id/name 与预期一致、id 不重复
//   2. 依赖一致性：三个 link: 目标存在、包名对得上、各自声明 dsh.bundle.patch
//   3. 本包不得声明 dsh.client（否则输入框会出现两块状态芯片）
//   4. profile 启用门禁：新包进 bundles 时，三个旧 bundle 必须已移出（防同 id 双行）
//   5. 单一源门禁（BUILD-ID）：profile 4 条 link 的真实目标包根，其 buildId 必须与本包一致
//      （防「profile 悄悄指向分叉旧树」；只验目标树身份，不验本包 BUILD-ID 是否最新）
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXPECTED = [
  // 2026-11-08 I2 现行口径：mergeReadSide 默认 **true** → 默认态 = 合并态。
  //   - 默认（不写配置）：旧 10 个（7 读 + 3 窗口）不注册 → pixel 14、全包 25；
  //   - 显式 mergeReadSide=false（回退路径）：旧 10 个注册 → pixel 24、全包 35。
  // 注意：源码里旧 10 个仍**声明**着（只是默认不注册），所以静态核对分两档：
  //   「声明数 24」= 「默认生效 14」+ 「旧 10」；下面 legacy:true 表示该引擎按两档核。
  { id: 'click-matrix', name: 'dsh-click-matrix', tools: 14, legacy: true },
  { id: 'dsh-x2', name: 'dsh-x2', tools: 6 },
  { id: 'dsh-stroke', name: 'dsh-stroke', tools: 5 },
]
const TOTAL = EXPECTED.reduce((n, e) => n + e.tools, 0)
const LEGACY_DECL_SOURCE = 'engines/pixel/lib/doctor.js'

/**
 * 旧 10 个（7 读 + 3 窗口）的服务端单一真源：pixel lib/doctor.js 的两组清单。
 * 直接解析源码而不是在这里再抄一遍名，避免"check-bundle 与 doctor 各说各话"。
 * 解析失败返回 null（调用方必须 FAIL，不许当空数组静默放过）。
 */
function readLegacyReadSideTools() {
  let src = ''
  try { src = readFileSync(join(ROOT, LEGACY_DECL_SOURCE), 'utf8') } catch { return null }
  const listOf = (name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`))
    if (!m) return null
    return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
  }
  const readSide = listOf('READ_SIDE_LEGACY_TOOLS')
  const windowSide = listOf('WINDOW_SIDE_LEGACY_TOOLS')
  if (!readSide || !windowSide) return null
  return [...readSide, ...windowSide]
}
const NEW_BUNDLE = 'dsh-desktop-hands'

let fails = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => { fails += 1; console.log(`FAIL  ${m}`) }
const info = (m) => console.log(`INFO  ${m}`)

function die(msg) {
  console.log(`FAIL  ${msg}`)
  process.exit(1)
}

// ---------- 1. manifest ----------
const manifestPath = join(ROOT, 'package.json')
if (!existsSync(manifestPath)) die(`缺少 ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest.name !== NEW_BUNDLE) fail(`manifest.name = ${manifest.name}，应为 ${NEW_BUNDLE}`)
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail(`manifest.dsh.bundle.patch = ${JSON.stringify(manifest.dsh?.bundle?.patch)}，应为 ./cordis.patch.yml`)
} else pass('manifest.dsh.bundle.patch = ./cordis.patch.yml')

if (manifest.dsh?.client) {
  fail('manifest 声明了 dsh.client —— 客户端芯片由 dsh-click-matrix 自带，重复声明会出现两块芯片')
} else pass('manifest 未声明 dsh.client（不会重复芯片）')

const engines = manifest.engines?.dsh || manifest.dsh?.engines?.dsh
if (!engines || !engines.includes('<0.3.0')) fail(`engines.dsh = ${JSON.stringify(engines)}，应取三家交集 <0.3.0`)
else pass(`engines.dsh = ${engines}`)

// ---------- 2. cordis.patch.yml ----------
const patchPath = join(ROOT, 'cordis.patch.yml')
if (!existsSync(patchPath)) die(`缺少 ${patchPath}`)
const patch = readFileSync(patchPath, 'utf8')

const insertCount = (patch.match(/^\s*-\s*insert:/gm) || []).length
if (insertCount !== 1) fail(`cordis.patch.yml 里 insert 段有 ${insertCount} 个，应为 1 个（三行都在同一个 insert 内）`)
else pass('cordis.patch.yml: 1 个 insert 段')

// 只取 insert 段里的行（跳过注释与其它顶层条目）
const rows = []
{
  let inInsert = false
  for (const raw of patch.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (/^\s*-\s*insert:/.test(line)) { inInsert = true; continue }
    if (!inInsert) continue
    const idm = line.match(/^\s*-\s*id:\s*["']?([^"'\s#]+)["']?/)
    if (idm) { rows.push({ id: idm[1], name: null, hasConfig: false }); continue }
    const nam = line.match(/^\s*name:\s*["']?([^"'\s#]+)["']?/)
    if (nam && rows.length) { rows[rows.length - 1].name = nam[1]; continue }
    if (/^\s*config:/.test(line) && rows.length) rows[rows.length - 1].hasConfig = true
  }
}

if (rows.length !== EXPECTED.length) fail(`insert 行数 = ${rows.length}，应为 ${EXPECTED.length}`)
else pass(`insert 行数 = ${rows.length}`)

const ids = rows.map((r) => r.id)
if (new Set(ids).size !== ids.length) fail(`insert 里 id 有重复：${ids.join(', ')}`)
else pass(`insert 里 id 不重复：${ids.join(', ')}`)

for (const [i, exp] of EXPECTED.entries()) {
  const row = rows[i]
  if (!row) continue
  if (row.id !== exp.id) fail(`第 ${i + 1} 行 id = ${row.id}，应为 ${exp.id}（id 一改，profile 里按 id 的配置覆盖块会静默失效）`)
  if (row.name !== exp.name) fail(`第 ${i + 1} 行 name = ${row.name}，应为 ${exp.name}`)
  if (!row.hasConfig) fail(`第 ${i + 1} 行（${row.id}）缺 config: {}（保留结构，② 之后按引擎加 scope）`)
}
if (rows.every((r, i) => r.id === EXPECTED[i]?.id && r.name === EXPECTED[i]?.name && r.hasConfig)) {
  pass('三行 id / name / config 全部符合预期')
}

// ---------- 3. 三个引擎依赖（link: 或 file:） ----------
function depDir(name) {
  // 1) 已安装的 node_modules 优先（安装后才是真实解析结果）
  const installed = join(ROOT, 'node_modules', name)
  if (existsSync(installed)) {
    try { return realpathSync(installed) } catch { return installed }
  }
  // 2) 退回到 manifest 里的 link:/file: 目标
  const spec = manifest.dependencies?.[name]
  if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) {
    return resolve(ROOT, spec.slice(spec.indexOf(':') + 1))
  }
  return null
}

for (const exp of EXPECTED) {
  const spec = manifest.dependencies?.[exp.name]
  if (!spec) { fail(`manifest.dependencies 缺 ${exp.name}`); continue }
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) { fail(`${exp.name} 的依赖写法 = ${spec}，本机应使用 link: 或 file:`); continue }

  const dir = depDir(exp.name)
  if (!dir || !existsSync(dir)) { fail(`${exp.name} 的 link 目标不存在：${dir || spec}`); continue }

  let pj
  try { pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
  catch (e) { fail(`${exp.name}: 读不到 ${dir}/package.json（${e.message}）`); continue }

  if (pj.name !== exp.name) fail(`引擎目标包名不符：${exp.name} → ${pj.name}`)
  if (!pj.main) fail(`${exp.name} 缺 main 入口`)
  else if (pj.dsh?.bundle) fail(`${exp.name} 不应声明 dsh.bundle（引擎形态，声明了会在面板独立列出）`)
  else pass(`${exp.name} @ ${pj.version} · ${dir} · 工具 ${exp.tools}`)
}

// ---------- 3.5 工具面：源码声明的工具数必须等于预期（fail-closed） ----------
// 2026-11-08：本节以前只把工具数打印出来、不判。但注册是「逐个 try/catch + logWarn」，
// 缺一个工具是**静默**的（doctor 那行「工具清单」原来也是无条件 PASS，v0.9.4 起已改 FAIL）。
// 这里做静态硬对照；运行期真值由 doctor 的「工具清单」行 + tools/assert-surface.mjs 兜。
const TOOL_DECL = {
  'dsh-click-matrix': { file: 'engines/pixel/index.js', pattern: "(?:^|\\n)\\s*define\\(\\s*\\n?\\s*'([a-z][a-z0-9_]+)'" },
  'dsh-x2': { file: 'engines/control/src/tools.js', pattern: "name:\\s*'(screen_[a-z0-9_]+)'" },
  'dsh-stroke': { file: 'engines/stroke/index.js', pattern: "(?:^|\\n)\\s*add\\(\\s*\\n?\\s*'([a-z][a-z0-9_]+)'" },
}
{
  const legacyTools = readLegacyReadSideTools()
  if (legacyTools === null) {
    fail(`读不到旧 10 个工具清单（${LEGACY_DECL_SOURCE} 的 READ_SIDE_LEGACY_TOOLS / WINDOW_SIDE_LEGACY_TOOLS）→ 无法判定默认态/回退态工具面`)
  } else {
    info(`旧 ${legacyTools.length} 个（仅显式 mergeReadSide=false 时注册）：${legacyTools.join(' ')}`)
  }
  let defaultTotal = 0
  let rollbackTotal = 0
  for (const exp of EXPECTED) {
    const spec = TOOL_DECL[exp.name]
    let src = ''
    try { src = readFileSync(join(ROOT, spec.file), 'utf8') } catch (e) {
      fail(`${exp.name}: 读不到源码 ${spec.file}（${e.message}）`)
      continue
    }
    const names = [...src.matchAll(new RegExp(spec.pattern, 'g'))].map((m) => m[1])
    rollbackTotal += names.length
    if (!exp.legacy) {
      defaultTotal += names.length
      if (names.length !== exp.tools) {
        const delta = names.length - exp.tools
        fail(`${exp.name}: 源码声明 ${names.length} 个工具，预期 ${exp.tools} 个（${delta < 0 ? `少 ${-delta} 个` : `多 ${delta} 个`}）`)
      } else {
        pass(`${exp.name}: 源码声明 ${names.length} 个工具 = 预期`)
      }
      continue
    }
    // 两档核对：源码声明 = 默认态生效 + 旧 10（旧 10 只在显式 false 时才注册）。
    const legacyHere = legacyTools || []
    const effective = names.filter((n) => !legacyHere.includes(n))
    const missingLegacy = legacyHere.filter((n) => !names.includes(n))
    defaultTotal += effective.length
    if (missingLegacy.length) {
      fail(`dsh-click-matrix: 源码里少了旧工具声明（${missingLegacy.join(' ')}）→ 显式 mergeReadSide=false 的回退路径会缺工具`)
    }
    if (effective.length !== exp.tools) {
      const delta = effective.length - exp.tools
      fail(`dsh-click-matrix: 默认态应注册 ${exp.tools} 个工具（源码声明 ${names.length} - 旧 ${legacyHere.length} = ${effective.length}，${delta < 0 ? `少 ${-delta} 个` : `多 ${delta} 个`}）`)
    } else {
      pass(`dsh-click-matrix: 源码声明 ${names.length} 个 = 默认生效 ${effective.length} + 旧 ${legacyHere.length} 个（仅回退态）= 默认预期 ${exp.tools}`)
    }
  }
  if (defaultTotal === TOTAL) pass(`默认态工具总数 ${defaultTotal} = 预期 ${TOTAL}（${EXPECTED.map((e) => e.tools).join(' + ')}）`)
  else fail(`默认态工具总数 ${defaultTotal}，预期 ${TOTAL}`)
  const ROLLBACK_TOTAL = EXPECTED.reduce((n, e) => n + e.tools, 0) + (legacyTools ? legacyTools.length : 0)
  if (rollbackTotal === ROLLBACK_TOTAL) pass(`显式 mergeReadSide=false 时工具总数 ${rollbackTotal} = 预期 ${ROLLBACK_TOTAL}（${EXPECTED.map((e) => e.tools).join(' + ')} + 旧 ${legacyTools ? legacyTools.length : '?'}）`)
  else fail(`显式 mergeReadSide=false 时工具总数 ${rollbackTotal}，预期 ${ROLLBACK_TOTAL}`)
}

// ---------- 4.5 单一源门禁（BUILD-ID）：4 条 link 的真实目标必须是同一棵树 ----------
// I3：README 里「活树只有这一份」原来只是文档宣告。profile 的 4 条 link 一旦漂到分叉旧树
// （真实历史：D:\LocalChat\dsh-desktop-hands 还停在 v0.2.2），文档与实物就脱节了。
// 做法：解析 link 的**真实路径**（realpath，跟 junction/软链）→ 从目标目录上溯找包根
// tools/BUILD-ID.json（pixel/control/stroke 是包内子目录，包根在两级之上）→
// 把该树记录里的 buildId 与本包 BUILD-ID.json 的 buildId 硬对比。
//   找不到 BUILD-ID / 包根不是本包 / buildId 不同 → FAIL，并打印「link 实际路径 + 包根 + 两边 buildId」。
// 边界：本门禁只验「目标树与本包是不是同一源」，不验「本包 BUILD-ID 是否最新」——
// 后者是 build-id.mjs --check（verify 第 17 项）的事；所以两边「旧得一样」时这里仍 PASS。
const BUILD_ID_LINKS = [NEW_BUNDLE, ...EXPECTED.map((e) => e.name)]
const ownBuildIdPath = join(ROOT, 'tools', 'BUILD-ID.json')
const ownBuildId = (() => {
  try { return JSON.parse(readFileSync(ownBuildIdPath, 'utf8')) } catch { return null }
})()

function resolveLinkTarget(spec) {
  if (typeof spec !== 'string') return { kind: 'not-link', spec }
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) return { kind: 'not-link', spec }
  const abs = resolve(profileDir, spec.slice(spec.indexOf(':') + 1))
  if (!existsSync(abs)) return { kind: 'missing', spec, target: abs }
  let real = abs
  try { real = realpathSync(abs) } catch { /* 保持原样 */ }
  return { kind: 'dir', spec, target: real }
}

function findBuildIdRoot(startDir) {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    const file = join(dir, 'tools', 'BUILD-ID.json')
    if (existsSync(file)) return { root: dir, file }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function buildIdGate(prof) {
  const deps = prof.dependencies || {}
  const enabled = (prof.dsh?.profile?.bundles || []).includes(NEW_BUNDLE)
  info('单一源门禁（BUILD-ID）：解析 profile 4 条 link 的真实目标树')
  if (!ownBuildId) {
    fail(`本包缺 ${ownBuildIdPath}（先跑 node tools/build-id.mjs --update）—— 无法判定 profile 指向哪棵树`)
    return
  }
  for (const name of BUILD_ID_LINKS) {
    const spec = deps[name]
    if (spec === undefined) {
      if (enabled) fail(`profile.dependencies 缺 ${name}：启用态下解析不到该包`)
      else info(`${name}: profile.dependencies 没有该条（未启用态，跳过）`)
      continue
    }
    const r = resolveLinkTarget(spec)
    if (r.kind === 'not-link') { info(`${name}: ${spec} 不是 link:/file:（版本号等），无法判定目标树`); continue }
    if (r.kind === 'missing') { fail(`${name}: link 实际路径不存在 → ${r.target}（原值 ${spec}）`); continue }
    const found = findBuildIdRoot(r.target)
    if (!found) {
      fail(`${name}: link 实际目标 ${r.target} 上溯到根都没有 tools/BUILD-ID.json → 指向分叉/旧树`
        + `（本包活树 ${ROOT}，buildId ${ownBuildId.buildId}）`)
      continue
    }
    let rec
    try {
      rec = JSON.parse(readFileSync(found.file, 'utf8'))
    } catch (e) {
      fail(`${name}: ${found.file} 不可解析（${e.message}）→ link 实际目标 ${r.target}`)
      continue
    }
    let rootPkg = null
    try { rootPkg = JSON.parse(readFileSync(join(found.root, 'package.json'), 'utf8')) } catch { /* 下面判 */ }
    if (!rootPkg || rootPkg.name !== NEW_BUNDLE) {
      fail(`${name}: link 实际目标 ${r.target} 上溯到的包根 ${found.root} 不是 ${NEW_BUNDLE}`
        + `（package.json.name = ${rootPkg ? rootPkg.name : '读不到'}）`)
      continue
    }
    if (rec.buildId !== ownBuildId.buildId) {
      fail(`${name}: BUILD-ID 不一致 —— link 实际目标 ${r.target} · 包根 ${found.root}`
        + `；目标树 buildId=${rec.buildId}（version ${rec.version}） vs 本包 buildId=${ownBuildId.buildId}（version ${manifest.version}）`
        + ' → profile 指向了分叉旧树')
    } else {
      pass(`${name}: link 实际目标 ${r.target} · 包根 ${found.root} · buildId=${rec.buildId}（与本包一致）`)
    }
  }
}

// ---------- 4. profile 启用门禁 ----------
function argProfile() {
  const i = process.argv.indexOf('--profile')
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

const profileDir = argProfile()
const profilePkg = join(profileDir, 'package.json')
if (!existsSync(profilePkg)) {
  info(`profile 不存在，跳过启用门禁：${profilePkg}`)
} else {
  let prof
  try { prof = JSON.parse(readFileSync(profilePkg, 'utf8')) }
  catch (e) { fail(`profile manifest 不可解析：${profilePkg}（${e.message}）`); prof = null }
  if (prof) {
    const bundles = prof.dsh?.profile?.bundles || []
    const deps = prof.dependencies || {}
    const oldNames = EXPECTED.map((e) => e.name)
    const enabled = bundles.includes(NEW_BUNDLE)
    const stillOld = oldNames.filter((n) => bundles.includes(n))

    info(`profile: ${profileDir}`)
    info(`profile bundles: ${bundles.length} 条`)

    if (!enabled) {
      info(`本包尚未启用（bundles 里没有 ${NEW_BUNDLE}）——骨架交付态，启用步骤见 README §3`)
      if (stillOld.length) info(`当前仍由旧 bundle 提供：${stillOld.join(', ')}`)
      const x2Missing = !bundles.includes('dsh-x2')
      // 默认合并态全包 25（14+6+5）；x2 缺 = 少 6 个 → 19。显式 mergeReadSide=false 时全包 35 → 29。
      if (x2Missing) info('提示：dsh-x2 不在 bundles 里 → 它的 6 个工具当前不会注册（live 工具数 19 而不是 25；显式 mergeReadSide=false 时 29 而不是 35）')
    } else {
      pass(`profile 已启用 ${NEW_BUNDLE}`)
      if (deps[NEW_BUNDLE]) pass(`profile.dependencies 有 ${NEW_BUNDLE} = ${deps[NEW_BUNDLE]}`)
      else fail(`profile.dependencies 缺 ${NEW_BUNDLE}（bundles 里有名字但依赖没有 → 解析不到包）`)

      if (stillOld.length) {
        fail(`同 id 双行：bundles 里仍留着 ${stillOld.join(', ')}，与本包三行 insert 重复（loader 不报错，但哪行的 config 生效取决于顺序）`)
      } else {
        pass('三个旧 bundle 已全部移出 bundles（无同 id 双行）')
      }

      // 引擎目标漂移检查：解析成绝对路径再比（profile 用 link: 绝对路径，包用 file: 相对路径）
      const resolveSpec = (s) => {
        if (typeof s !== 'string') return null
        if (s.startsWith('link:') || s.startsWith('file:')) return resolve(ROOT, s.slice(s.indexOf(':') + 1))
        return null // 版本号等无法解析，跳过
      }
      for (const n of oldNames) {
        const a = resolveSpec(deps[n])
        const b = resolveSpec(manifest.dependencies?.[n])
        if (a && b && a !== b) fail(`引擎目标漂移：profile 侧 ${n} = ${deps[n]} → ${a}，本包 → ${b}`)
      }
    }

    // 单一源门禁对「已启用 / 未启用」都跑：只要 profile 里写了 link，就必须指向同一棵活树
    buildIdGate(prof)
  }
}

// ---------- 汇总 ----------
console.log('')
console.log(`默认态工具总数 ${TOTAL}（${EXPECTED.map((e) => e.tools).join(' + ')}）；显式 mergeReadSide=false 时回退到 ${TOTAL + (readLegacyReadSideTools() || []).length}。其中 stroke_diag 容易被漏掉。`)
console.log(`版本：${EXPECTED.map((e) => e.name).join(' / ')}（详见上面各行）`)
console.log(fails === 0 ? 'RESULT: PASS' : `RESULT: FAIL（${fails} 项）`)
process.exit(fails === 0 ? 0 : 1)
