#!/usr/bin/env node
// dsh-desktop-hands · profile 切换工具（把三个旧 bundle 换成新单包）
//
// 作用：改 profile 的 package.json 两处 ——
//   1) dependencies 加 "dsh-desktop-hands": "link:<本包绝对路径>"
//   2) dsh.profile.bundles 里用 dsh-desktop-hands 替换 dsh-click-matrix / dsh-stroke / dsh-x2
//
// 为什么要它：只把包装成依赖不算启用（patch 不生效）；而旧新 bundle 并存会让同一 id 插两次
// （两个 helper、工具重复注册，loader 不报错）。手改容易只做一半，所以给一个带备份/校验/回滚的脚本。
//
// 用法（DSH 必须在关闭状态）：
//   node tools/profile-switch.mjs                  # 预演，只打印将要改什么
//   node tools/profile-switch.mjs --apply          # 真改（先写 .bak-<时间戳>，再原子替换）
//   node tools/profile-switch.mjs --rollback <bak> # 字段级回滚（见下；不是整份覆盖）
//   node tools/profile-switch.mjs --profile "D:/other/.dsh/profiles/desktop"   # 指定 profile
//
// 回滚语义（2026-11-08 改）：
//   只还原**本脚本管理的那 4 条依赖**（dsh-desktop-hands + 三个引擎）与 `dsh.profile.bundles` 里这 4 个名字的
//   成员关系；其余字段（scripts / devDependencies / 别的 bundle / 别的 dsh 配置 / version …）**保留当前值**。
//   所以「--apply 之后又手工装了别的插件/改了别的配置」不会被回滚一并抹掉。
//   回滚前仍把**当前** package.json 完整备份成 .bak-hands-rollback-<时间戳>，回滚本身也可再回滚。
//
// 改完仍需手动：在 profile 目录跑 `pnpm install --no-frozen-lockfile --prefer-offline`，然后重启 DSH。
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NEW = 'dsh-desktop-hands'
const OLD = ['dsh-click-matrix', 'dsh-stroke', 'dsh-x2']

const argv = process.argv.slice(2)
const opt = (name, def = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const has = (name) => argv.includes(name)

const profileDir = resolve(opt('--profile', join(os.homedir(), '.dsh', 'profiles', 'desktop')))
const pkgPath = join(profileDir, 'package.json')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bakPath = join(profileDir, `package.json.bak-hands-${stamp}`)

function log(kind, msg) { console.log(`${kind.padEnd(5)} ${msg}`) }
function fail(msg) { console.log(`FAIL  ${msg}`); process.exit(1) }

// ---------- 字段级回滚（不是整份覆盖） ----------
// 2026-11-08 改：以前 `--rollback` 是 copyFileSync 整份覆盖，会把备份时点之后手工加进 profile 的
// 其它插件/配置一起抹掉（11-07 出过同类事故）。现在只还原本脚本管理的 4 个名字：
//   - dependencies 里的 dsh-desktop-hands + 三个引擎（备份里没有的 = --apply 新增的 → 撤销）；
//   - dsh.profile.bundles 里这 4 个名字的成员关系（其余 bundle 保持当前值与当前顺序）。
// 其余字段（scripts / devDependencies / 别的 bundle / 别的 dsh 配置 / version …）保留当前值。
const MANAGED = new Set([NEW, ...OLD])

function planRollback(manifest, backup) {
  const next = structuredClone(manifest)

  // 依赖：管理名取备份值；备份里没有 → 删除；备份有而当前没有 → 补回（按备份里的顺序追加）
  const bakDeps = backup.dependencies || {}
  const curDeps = next.dependencies || {}
  const deps = {}
  for (const [name, spec] of Object.entries(curDeps)) {
    if (!MANAGED.has(name)) { deps[name] = spec; continue }
    if (bakDeps[name] !== undefined) deps[name] = bakDeps[name]
    // else: 备份里没有 → 这条是 --apply 新加的，撤销
  }
  for (const [name, spec] of Object.entries(bakDeps)) {
    if (MANAGED.has(name) && !(name in deps)) deps[name] = spec
  }
  next.dependencies = deps

  // bundles：只有这 4 个名字按备份还成员关系，其余条目原样、原顺序保留。
  // 插入位置 = 当前第一个管理名所在的位置（没有就追加到末尾），和 --apply 的「原地换名」对称。
  const curBundles = Array.isArray(next.dsh?.profile?.bundles) ? next.dsh.profile.bundles : []
  const bakBundles = Array.isArray(backup.dsh?.profile?.bundles) ? backup.dsh.profile.bundles : []
  const bakManaged = bakBundles.filter((n) => MANAGED.has(n))
  const anchor = curBundles.findIndex((n) => MANAGED.has(n))
  const insertAt = anchor < 0 ? curBundles.length : curBundles.slice(0, anchor).filter((n) => !MANAGED.has(n)).length
  const cleaned = curBundles.filter((n) => !MANAGED.has(n))
  const merged = [...cleaned.slice(0, insertAt), ...bakManaged, ...cleaned.slice(insertAt)]
  if (curBundles.length || bakManaged.length || next.dsh?.profile?.bundles) {
    next.dsh = next.dsh || {}
    next.dsh.profile = next.dsh.profile || {}
    next.dsh.profile.bundles = merged
  }
  return { next, merged }
}

const rb = opt('--rollback')
if (rb) {
  const src = resolve(rb)
  if (!existsSync(src)) fail(`备份不存在：${src}`)
  // 防跨 profile 回滚：备份必须就在 --profile 指定的目录里。
  // （2026-11-07 事故：一键回滚.cmd 漏传 --profile，把测试 profile 的备份写进了真实 desktop。）
  if (dirname(src) !== profileDir) {
    fail(`拒绝跨 profile 回滚：备份在 ${dirname(src)}，但 --profile 指向 ${profileDir}。请显式传 --profile 与备份路径一致。`)
  }
  if (!existsSync(pkgPath)) fail(`profile 不存在：${pkgPath}`)

  let backup, manifest
  try { backup = JSON.parse(readFileSync(src, 'utf8')) }
  catch (e) { fail(`备份不可解析：${src}（${e.message}）`) }
  try { manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) }
  catch (e) { fail(`当前 package.json 不可解析：${pkgPath}（${e.message}）`) }

  const { next } = planRollback(manifest, backup)

  // 逐字段列出真实差异（只为报告，不判红）
  const changes = []
  const beforeDeps = manifest.dependencies || {}
  const afterDeps = next.dependencies || {}
  for (const name of [NEW, ...OLD]) {
    const a = beforeDeps[name]
    const b = afterDeps[name]
    if (a === b) continue
    if (b === undefined) changes.push(`dependencies -= ${name}（备份里没有 → 撤销 --apply 的新增）`)
    else if (a === undefined) changes.push(`dependencies += ${name}: ${b}`)
    else changes.push(`dependencies.${name}: ${a} → ${b}`)
  }
  const beforeBundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const afterBundles = Array.isArray(next.dsh?.profile?.bundles) ? next.dsh.profile.bundles : []
  if (JSON.stringify(beforeBundles) !== JSON.stringify(afterBundles)) {
    changes.push(`bundles: ${beforeBundles.length} → ${afterBundles.length} 条：${afterBundles.join(', ')}`)
  }

  console.log(`profile: ${profileDir}`)
  console.log(`备份   : ${src}`)
  console.log('')
  log('MODE', '字段级回滚：只还原 4 条依赖 + bundles 里这 4 个名字；其余字段保留当前值')
  if (!changes.length) {
    log('DONE', '当前 4 条依赖与 bundles 成员关系已等于备份里的目标状态，未写任何文件')
    process.exit(0)
  }
  for (const c of changes) log('DIFF', c)
  console.log('')

  // 回滚本身也要可逆：先把当前 package.json 完整备份一份（整份文件，用于「再回滚」）。
  // 命名故意**不带** `bak-hands-` 前缀：一键部署/启用/回滚.cmd 会挑「最新 package.json.bak-hands-*」
  // 当回滚目标，这份若也叫 bak-hands-* 会被误选成「最新 hands 备份」，语义就反了。
  const rollbackBak = join(profileDir, `package.json.bak-rollback-${stamp}`)
  copyFileSync(pkgPath, rollbackBak)
  if (!existsSync(rollbackBak)) fail(`当前 profile 的备份未生成：${rollbackBak} —— 已中止，未改 profile`)
  log('BACKUP', rollbackBak)

  const tmp = pkgPath + '.tmp-hands'
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmp, pkgPath)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch {}
    fail(`写入失败：${e.message} —— profile 未改，备份在 ${rollbackBak}`)
  }
  log('WRITE', pkgPath)
  log('CHECK', `bundles 现在 ${afterBundles.length} 条：${afterBundles.join(', ')}`)
  console.log('')
  log('NEXT', '1) 确认 DSH 已关闭；2) 在 profile 目录跑 pnpm install --no-frozen-lockfile --prefer-offline；3) 重启 DSH')
  log('UNDO', `撤销这次回滚：node tools/profile-switch.mjs --rollback "${rollbackBak}"`)
  process.exit(0)
}

if (!existsSync(pkgPath)) fail(`profile 不存在：${pkgPath}`)

// ---------- DSH 是否在运行 ----------
function dshRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
    return /DeepSeek Harness\.exe/i.test(out)
  } catch { return false }
}

// ---------- 计算改动 ----------
let manifest
try { manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) }
catch (e) { fail(`package.json 不可解析：${e.message}`) }

const linkSpec = `link:${ROOT.replace(/\\/g, '/')}`
// 三个引擎的 link 也归本脚本管：全部从 ROOT 推出来，换机器/换目录不用手改。
const ENGINE_LINKS = [
  ['dsh-click-matrix', 'engines/pixel'],
  ['dsh-x2', 'engines/control'],
  ['dsh-stroke', 'engines/stroke'],
]
const allDeps = [[NEW, linkSpec], ...ENGINE_LINKS.map(([name, rel]) => [name, `link:${join(ROOT, rel).replace(/\\/g, '/')}`])]
const deps = manifest.dependencies || {}
const bundles = manifest.dsh?.profile?.bundles || []

const plan = []
for (const [name, spec] of allDeps) {
  const now = deps[name]
  if (now === spec) plan.push({ kind: 'noop', msg: `dependencies 已是 ${name} = ${spec}` })
  else if (now) plan.push({ kind: 'set', msg: `dependencies.${name}: ${now} → ${spec}` })
  else plan.push({ kind: 'add', msg: `dependencies += ${name}: ${spec}` })
}

const removed = OLD.filter((n) => bundles.includes(n))
const newListed = bundles.includes(NEW)
if (newListed) plan.push({ kind: 'noop', msg: `bundles 里已有 ${NEW}` })
else plan.push({ kind: 'add', msg: `bundles += ${NEW}` })
if (removed.length) plan.push({ kind: 'del', msg: `bundles -= ${removed.join(', ')}（否则同 id 会插两次）` })
else plan.push({ kind: 'noop', msg: 'bundles 里没有三个旧条目' })

console.log(`profile: ${profileDir}`)
console.log(`本包   : ${ROOT}  (${NEW})`)
console.log('')
for (const p of plan) log(p.kind.toUpperCase(), p.msg)
console.log('')
log('CHECK', `bundles 现在 ${bundles.length} 条：${bundles.join(', ')}`)

const noChange = plan.every((p) => p.kind === 'noop')
if (noChange) { log('DONE', '已经是目标状态，无需改动'); process.exit(0) }

if (!has('--apply')) {
  console.log('')
  log('DRY', '预演结束，未写任何文件。确认无误后加 --apply 真改（DSH 必须已关闭）。')
  process.exit(0)
}

if (dshRunning() && !has('--force')) {
  fail('检测到 DeepSeek Harness.exe 正在运行 —— 不要在运行时改 profile。先完全退出 DSH 再 --apply。')
}
if (has('--force')) log('WARN', '--force：跳过"DSH 是否在运行"检查（只应在 profile 副本上测试时用）')

// ---------- 真改 ----------
const next = structuredClone(manifest)
next.dependencies = next.dependencies || {}
for (const [name, spec] of allDeps) next.dependencies[name] = spec
next.dsh = next.dsh || {}
next.dsh.profile = next.dsh.profile || {}

// 保住原顺序：把新名字放在第一个被删条目的位置（没有就追加到末尾）
const before = bundles.slice()
const target = []
let inserted = false
for (const name of before) {
  if (OLD.includes(name)) {
    if (!inserted) { target.push(NEW); inserted = true }
    continue
  }
  target.push(name)
}
if (!inserted) target.push(NEW)
next.dsh.profile.bundles = target

// 先写整份备份，并**确认它真的落盘且可解析**，否则宁可不改 profile。
// （这里曾经写成 `if (!existsSync(bakPath)) rmSync(bakPath)`：条件反了 —— 不存在才去删，
//   是永远不会执行的死代码，等于「备份失败也照写」，已修。）
copyFileSync(pkgPath, bakPath)
if (!existsSync(bakPath)) fail(`备份未生成：${bakPath} —— 已中止，未改 profile`)
try { JSON.parse(readFileSync(bakPath, 'utf8')) }
catch (e) { fail(`备份不可解析：${bakPath}（${e.message}）—— 已中止，未改 profile`) }
log('BACKUP', bakPath)

const tmp = pkgPath + '.tmp-hands'
writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
renameSync(tmp, pkgPath)
log('WRITE', pkgPath)

log('BUNDLES', `${before.length} → ${target.length} 条：${target.join(', ')}`)
console.log('')
log('NEXT', '1) 确认 DSH 已关闭；2) 在 profile 目录跑 pnpm install --no-frozen-lockfile --prefer-offline；')
log('NEXT', '3) 重启 DSH；4) 跑 node tools/check-bundle.mjs 与验收 1–7')
log('UNDO', `node tools/profile-switch.mjs --rollback "${bakPath}"`)

// 写后自检：文件必须能解析，且内容 = 预期（与上面写入的 next 一致）。
// 失败时**不自动改回**，只明确给出「用哪一个备份恢复」——回滚会动 profile，留给人决定。
try {
  const after = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (JSON.stringify(after) === JSON.stringify(next)) log('VERIFY', '写后校验通过（内容与预期一致）')
  else log('WARN', `写后校验：内容与预期不同，请先 diff 再决定是否回滚（备份 ${bakPath}）`)
} catch (e) {
  log('WARN', `写后校验失败：${e.message} —— 用备份恢复：node tools/profile-switch.mjs --rollback "${bakPath}"`)
}
