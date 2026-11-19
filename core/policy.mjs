// core/policy.mjs —— ③ 拒绝清单下沉：共享 deny-list 的加载器 + 匹配器（纯函数，零依赖）。
//
// 数据文件：~/.dsh/dsh-desktop-hands/deny-list.json（由本模块 seed；随包也有一份 core/deny-list.json）。
// 三个引擎（pixel=click-matrix / control=x2 / stroke）各自读同一份，判定一致。
// 兜底：文件缺失/损坏时，各引擎回到自己的内置清单（"各自读旧配置" 的回滚分支）。
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIPPED = join(HERE, 'deny-list.json')

/** exe basename lower-case. */
export function processBase(p) {
  if (typeof p !== 'string' || p.trim() === '') return ''
  const parts = p.replaceAll('/', '\\').split('\\')
  return parts[parts.length - 1].trim().toLowerCase()
}

/** 读并校验共享 deny-list.json；非法/缺失返回 null。 */
export function readDenyGroups(path) {
  try {
    if (!existsSync(path)) return null
    const j = JSON.parse(readFileSync(path, 'utf8'))
    const groups = j && j.groups
    if (!groups || typeof groups !== 'object') return null
    const out = {}
    for (const [id, g] of Object.entries(groups)) {
      if (!g || typeof g !== 'object') continue
      out[id] = {
        label: typeof g.label === 'string' ? g.label : id,
        processes: Array.isArray(g.processes) ? g.processes.map(String) : [],
        titleExact: Array.isArray(g.titleExact) ? g.titleExact.map(String) : [],
        titleNeedles: Array.isArray(g.titleNeedles) ? g.titleNeedles.map(String) : [],
      }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * 匹配一个窗口对象 {process,title} 是否命中某组拒绝规则。
 * @returns {{group:string,label:string,rule:string}|null}
 */
export function matchWindow(window, groups) {
  if (!window || typeof window !== 'object' || !groups) return null
  const proc = processBase(window.process)
  const title = typeof window.title === 'string' ? window.title.trim() : ''
  const titleLower = title.toLowerCase()
  for (const [group, p] of Object.entries(groups)) {
    if (proc && p.processes.some((x) => processBase(x) && processBase(x) === proc)) {
      return { group, label: p.label, rule: `process:${proc}` }
    }
    if (title && p.titleExact.some((t) => title === t)) {
      return { group, label: p.label, rule: `title:${title}` }
    }
    if (title && p.titleNeedles.some((t) => titleLower.includes(t.toLowerCase()))) {
      return { group, label: p.label, rule: `title-contains:${title}` }
    }
  }
  return null
}

/**
 * 把随包的 deny-list.json 播种到数据目录（缺才写，原子写）。返回实际文件路径或 null。
 * 用于 dsh-desktop-hands 启动时统一播种；三引擎只读不写。
 */
export function seedDenyList(dataDir) {
  try {
    if (!existsSync(SHIPPED)) return null
    const target = join(dataDir, 'deny-list.json')
    if (existsSync(target)) return target
    mkdirSync(dataDir, { recursive: true })
    const tmp = target + '.tmp-' + process.pid
    writeFileSync(tmp, readFileSync(SHIPPED, 'utf8'), 'utf8')
    renameSync(tmp, target)
    return target
  } catch {
    return null
  }
}

/** 从随包文件读内置 groups（dsh-desktop-hands doctor 用）。 */
export function shippedGroups() {
  return readDenyGroups(SHIPPED)
}
