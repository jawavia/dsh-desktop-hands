// core/abort.mjs —— ⑤ StopBus：唯一停止通道（shared stop.signal token，纯函数零依赖）。
//
// 数据文件：~/.dsh/dsh-desktop-hands/stop.signal（原子写 tmp+rename）。
// token：{ level: hard|soft, at: ms, by: hotkey|stop|command|esc, reason? }
// 写入者唯一 = 触发器（hotkey/STOP//stop）；读取者 = 各引擎的检测点（helper 读线程/worker/点循环）。
// 语义：hard = 立即停+归还鼠标；soft = 到原子边界停（报 boundary），继续需人类确认。
// 生命周期：/stop 写 token；/arm（fan-out）清 token（重新授权=恢复）。token 不自动过期。
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function stopPath(dataDir) {
  return join(dataDir, 'stop.signal')
}

/** 写 stop token（原子）。 */
export function writeStop(dataDir, { level = 'hard', by = 'command', reason = '' } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const j = { level: level === 'soft' ? 'soft' : 'hard', at: Date.now(), by, reason: String(reason || '').slice(0, 200) }
  const target = stopPath(dataDir)
  const tmp = target + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(j) + '\n', 'utf8')
  renameSync(tmp, target)
  return j
}

/** 读 token；缺失/损坏返回 null。 */
export function readStop(dataDir) {
  try {
    const p = stopPath(dataDir)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { level: j.level === 'soft' ? 'soft' : 'hard', at: Number(j.at) || 0, by: j.by || '', reason: j.reason || '' }
  } catch {
    return null
  }
}

/** 清 token（重新授权/恢复时调）。 */
export function clearStop(dataDir) {
  try {
    rmSync(stopPath(dataDir), { force: true })
    return true
  } catch {
    return false
  }
}
