#!/usr/bin/env node
// tools/verify.mjs —— 本地产品化验证流水线（等价"本地 CI"）。
// 一条命令跑完全量检查 + 测试 + 语法检查；全绿退出 0，任一失败退出 1。
// 不发布、不上传：所有检查都在本机跑。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

// 2026-11-08：测试必须与**真人授权文件**隔离。
// 起因：host-smoke 会真的走一次 `/click-matrix arm` 命令，而 pixel 的 fan-out 原来写死
// `~/.dsh/dsh-desktop-hands/gate.json` → 每跑一次 verify 就会用 60 秒 fan-out 覆盖掉
// 现有的常开/授权窗口（实测 2026-11-08 01:57 发生过）。现在统一给子进程指一个临时数据目录。
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'dsh-hands-verify-'))
// 2026-11-08 13:5x：还要隔离 pixel 自己的数据目录（audit/config/captures）。
// 背景：pixel 的 dataDirectory() 只认 DSH_HOME（不认 DSH_HANDS_DATA_DIR），
// 于是 host-smoke 的 e2e（arm / 人类输入模拟 / Esc）会把测试动作写进**真实审计链**
// （实测 40→47 条，多出 command armed / human-mouse suspended / escape paused）。
const TEST_DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hands-verify-home-'))
const CHILD_ENV = { ...process.env, DSH_HANDS_DATA_DIR: TEST_DATA_DIR, DSH_HOME: TEST_DSH_HOME }

// [名称, 脚本路径(相对 ROOT), 说明]
const CHECKS = [
  ['bundle 结构自检', 'tools/check-bundle.mjs', 'patch 结构 / 依赖一致 / 无 dsh.client / profile 门禁'],
  ['工具面断言(fail-closed)', 'tools/assert-surface.mjs', '25 注册真名一个不能少（默认合并态 14+6+5；源码仍声明 35）/ 描述与参数上限 / schema 预算 16KB / SKILL 引用名 ⊆ 注册真名 / 注册点形态'],
  ['pixel 静态自检', 'engines/pixel/tools/check-repo.mjs', '语法/JSON/版本/manifest/工具描述'],
  ['pixel access 单测', 'engines/pixel/tools/access-smoke.mjs', 'config/access/policy（134 断言）'],
  ['pixel grid 单测', 'engines/pixel/tools/grid-smoke.mjs', '多显示器/混合 DPI（163 断言）'],
  ['pixel client 单测', 'engines/pixel/tools/client-smoke.mjs', 'client 芯片注册'],
  ['pixel host 冒烟', 'engines/pixel/tools/host-smoke.mjs', '宿主逻辑 e2e（142 检查）'],
  ['control(x2) 语法', 'engines/control/src/tools.js', 'node --check'],
  ['control(x2) dryRun 预演', 'engines/control/test/dryrun-smoke.mjs', 'screen_act/screen_sequence 的 dryRun 零注入、零授权、不伪装成执行（24 检查）'],
  ['control(x2) 审计路径', 'engines/control/test/audit-path-test.mjs', '审计落 ~/.dsh/dsh-desktop-hands/audit/、不写 %TEMP%、arm.json 不搬（24 检查）'],
  ['stroke 审计', 'engines/stroke/test/audit-smoke.mjs', '每次调用留一行、写失败不崩、回读校验（42 检查）'],
  ['control(x2) 语法', 'engines/control/src/deny.js', 'node --check'],
  ['control(x2) 语法', 'engines/control/src/gate.js', 'node --check'],
  ['control(x2) 语法', 'engines/control/src/policy.js', 'node --check'],
  ['stroke 语法', 'engines/stroke/index.js', 'node --check'],
  // 2026-11-08（跨三引擎 seam）：原来的 15 项都是单引擎自测或 node --check，
  // 没有一项把 pixel/control/stroke 放到同一份共享状态（gate / deny-list / 审计）上一起验。
  // 这项在临时数据目录上跑：一次 fan-out 三 scope / 共享 deny-list / audit-report / tree-manifest 抽样 hash。
  ['跨三引擎集成冒烟', 'tools/integration-smoke.mjs', '一次授权 fan-out 三 scope / 共享 deny-list / audit-report 跑通 / tree-manifest 抽样 hash（17 检查）'],
  // 2026-11-08（I3 单一源机制）：BUILD-ID.json 必须与活树全量指纹自洽。
  // 打包前必须 `node tools/build-id.mjs --update`；之后若日常编辑再改文件，这一项会红——那是提醒刷新，不是代码坏了。
  ['BUILD-ID 自洽', 'tools/build-id.mjs', 'tools/BUILD-ID.json ↔ 活树全量指纹（--check；单一源门禁，打包前 --update）'],
]

let failed = 0
const startedAt = Date.now()

for (const [name, script, desc] of CHECKS) {
  const path = join(ROOT, script)
  const isCheck = script.endsWith('.js') && (script.includes('deny.js') || script.includes('gate.js') || script.includes('policy.js') || script.includes('index.js') || script.includes('tools.js'))
  let r
  if (isCheck && script.includes('engines/')) {
    r = spawnSync(NODE, ['--check', path], { encoding: 'utf8', env: CHILD_ENV })
  } else {
    r = spawnSync(NODE, [path], { encoding: 'utf8', timeout: 120000, env: CHILD_ENV })
  }
  const ok = r.status === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    const err = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')
    if (err) console.log('       ' + err.replace(/\n/g, '\n       '))
  }
}

console.log('')
console.log(`verify 完成：${CHECKS.length - failed}/${CHECKS.length} 项通过，用时 ${Date.now() - startedAt}ms`)
process.exit(failed === 0 ? 0 : 1)
