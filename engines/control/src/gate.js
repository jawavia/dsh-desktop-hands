// src/gate.js —— ④ 授权 fan-out：读 core gate.json 的 control scope（x2 侧）。
// 数据文件：~/.dsh/dsh-desktop-hands/gate.json（dsh-desktop-hands 负责写）。
// 返回 null 表示 gate.json 缺失/损坏 → 调用方回退旧 arm.json（回滚分支）。
//
// 2026-11-08（Q7 审计统一顺带修）：数据目录也认 DSH_HANDS_DATA_DIR。
// 原因：测试必须能把"读授权"一起隔离——否则跑测试时读到的是**真人**的 gate.json
// （pixel 侧 lib/gate.js 已先这么做，这里是同一套约定）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DATA_DIR = () => process.env.DSH_HANDS_DATA_DIR || join(homedir(), '.dsh', 'dsh-desktop-hands')
const GATE = (dir) => join(dir || DATA_DIR(), 'gate.json')

/** @param {string} [dataDir] 覆盖数据目录（测试用）；缺省 DSH_HANDS_DATA_DIR || ~/.dsh/dsh-desktop-hands */
export function readControlScope(dataDir) {
  try {
    const p = GATE(dataDir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const armedUntil = Number(j.armedUntil) || 0
    const control = j && j.scopes && j.scopes.control
    const armed = armedUntil > Date.now() && !!(control && control.armed === true)
    return { armed, armedUntil, by: (j && j.by) || '' }
  } catch {
    return null
  }
}

/** ⑤ StopBus：读 stop.signal token；缺失/损坏返回 null。 */
export function readStop(dataDir) {
  try {
    const p = join(dataDir || DATA_DIR(), 'stop.signal')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { level: j.level === 'soft' ? 'soft' : 'hard', at: Number(j.at) || 0, by: j.by || '', reason: j.reason || '' }
  } catch {
    return null
  }
}
