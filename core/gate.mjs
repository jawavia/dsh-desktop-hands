// core/gate.mjs —— ④ 授权 fan-out：唯一授权来源（shared gate.json，纯函数零依赖）。
//
// 数据文件：~/.dsh/dsh-desktop-hands/gate.json（原子写）。
// 一次人类动作（armAll）给三个引擎各开一个 scope；每引擎只读自己的 scope。
// 文件缺失 = 回滚分支（各引擎回退旧授权：click-matrix 内存 arm / x2 arm.json / stroke 会话）。
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const ENGINES = ['pixel', 'control', 'stroke']

export function gatePath(dataDir) {
  return join(dataDir, 'gate.json')
}

/** 读 gate.json；缺失/损坏/过期返回 null（调用方据此走回滚分支）。 */
export function readGate(dataDir) {
  try {
    const p = gatePath(dataDir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const armedUntil = Number(j.armedUntil) || 0
    const scopes = j && j.scopes && typeof j.scopes === 'object' ? j.scopes : {}
    const out = { armedUntil, by: j.by || '', note: j.note || '', scopes: {} }
    for (const e of ENGINES) {
      out.scopes[e] = { armed: scopes[e] && scopes[e].armed === true }
    }
    return out
  } catch {
    return null
  }
}

/** 原子写 gate.json。 */
export function writeGate(dataDir, { armedUntil, by = '', note = '', scopes = {} }) {
  mkdirSync(dataDir, { recursive: true })
  const j = {
    version: 1,
    armedUntil: Number(armedUntil) || 0,
    by,
    note,
    scopes: { pixel: {}, control: {}, stroke: {} },
  }
  for (const e of ENGINES) j.scopes[e] = { armed: scopes[e] && scopes[e].armed === true }
  const target = gatePath(dataDir)
  const tmp = target + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
  return j
}

/** fan-out：一次人类动作给三引擎各开一个 scope。 */
export function armAll(dataDir, { seconds = 600, by = 'command', note = '', engines = ENGINES } = {}) {
  const armedUntil = Date.now() + Math.max(1, Number(seconds) || 600) * 1000
  const scopes = {}
  for (const e of ENGINES) scopes[e] = { armed: engines.includes(e) }
  return writeGate(dataDir, { armedUntil, by, note, scopes })
}

/** 关闭全部授权（armedUntil 归零，scopes 全 false）。 */
export function disarm(dataDir, { by = 'command', note = '' } = {}) {
  const scopes = {}
  for (const e of ENGINES) scopes[e] = { armed: false }
  return writeGate(dataDir, { armedUntil: 0, by, note, scopes })
}

/**
 * 某引擎当前是否被授权。返回值：
 *   true  = 已授权（scope 开 + 未过期）
 *   false = 未授权（gate.json 存在但该 scope 关/已过期）
 *   null  = gate.json 缺失/损坏 → 调用方走回滚分支
 */
export function isEngineArmed(engine, dataDir) {
  const g = readGate(dataDir)
  if (!g) return null
  const now = Date.now()
  if (!(g.armedUntil > now)) return false
  return g.scopes[engine] ? g.scopes[engine].armed === true : false
}
