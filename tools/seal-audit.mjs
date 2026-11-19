#!/usr/bin/env node
// seal-audit.mjs —— ② 一次性迁移：封印 click-matrix 的旧审计链。
// 用法:
//   node tools/seal-audit.mjs [auditDir]      # 缺省 ~/.dsh/click-matrix
// 只做 rename（audit.jsonl → audit.sealed-*.jsonl），不删任何东西；可逆。
// 必须在 DSH 关闭时跑（否则运行中的旧实例会带着旧链头继续写新文件）。
// 引擎已 vendor 进本包：直接引用包内的 audit 实现，别指向包外旧目录
// （2026-11-08 修：原来是 file:///D:/LocalChat/dsh-click-matrix/lib/audit.js，
//   换机 / 旧副本被挪走时本脚本必然崩，而它是「一键部署.cmd」的第 2 步。）
import { AuditLog } from '../engines/pixel/lib/audit.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.argv[2] || join(homedir(), '.dsh', 'click-matrix')
const a = new AuditLog({ dir })

const before = a.tail(3) // 封印前窥一眼活动文件（只读）
const r = a.seal()

console.log(JSON.stringify({
  auditDir: dir,
  beforeTotalLines: before.totalLines,
  ...r,
  sealedFiles: a.sealedFiles(),
  verifySealed: a.verifySealed(),
}, null, 2))

// 未封印（本来就空）也算成功；真失败（rename 抛错）才非零退出。
process.exit(r.sealed || r.note === 'no active file' ? 0 : 1)
