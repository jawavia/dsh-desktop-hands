// Repository self-check for dsh-click-matrix.
//
// Catches the failure modes that bit us during development:
//   - syntax errors in any first-party JS/MJS module,
//   - UTF-8 corruption / mojibake (a PowerShell rewrite once turned Chinese
//     strings into replacement-question garbage),
//   - version drift between index.js PLUGIN_VERSION and package.json,
//   - missing package entry files and broken locale JSON.
//
// Usage: node tools/check-repo.mjs   (npm run check)
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

function pass(message) {
  notes.push(message)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

// ---- 1) syntax + encoding for first-party code ---------------------------
const codeFiles = walk(ROOT).filter((f) => /\.(mjs|cjs|js)$/i.test(f))
const mojibakeMarkers = ['\u951b', '\u935c', '\u9428', '\u93c2', '\u9366', '\u748b', '\u93b4', '\u935a', '\u5bee', '\u7f02', '\u6d60', '\u9359', '\u93b5', '\u59dd']
let syntaxChecked = 0
for (const file of codeFiles) {
  const text = readText(file)
  const rel = relative(ROOT, file)
  if (text.includes('\uFFFD')) fail(`${rel}: contains U+FFFD (encoding corruption)`)
  for (const marker of mojibakeMarkers) {
    if (text.includes(marker)) {
      fail(`${rel}: mojibake marker "${marker}" found (UTF-8/ANSI corruption)`)
      break
    }
  }
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`${rel}: syntax error\n${(result.stderr || '').split('\n').slice(0, 6).join('\n')}`)
  }
  syntaxChecked++
}
pass(`syntax/encoding: ${syntaxChecked} JS/MJS files`)

// ---- 2) JSON files -------------------------------------------------------
for (const file of walk(ROOT).filter((f) => f.endsWith('.json'))) {
  const rel = relative(ROOT, file)
  try {
    JSON.parse(readText(file))
  } catch (error) {
    fail(`${rel}: invalid JSON (${error.message})`)
  }
}
pass('JSON: package.json + locale files parse')

// ---- 3) version consistency ---------------------------------------------
let pkg = null
try {
  pkg = JSON.parse(readText(join(ROOT, 'package.json')))
} catch {
  fail('package.json: missing or invalid')
}
if (pkg) {
  const indexText = readText(join(ROOT, 'index.js'))
  const match = indexText.match(/const PLUGIN_VERSION = '([^']+)'/)
  if (!match) fail('index.js: PLUGIN_VERSION not found')
  else if (match[1] !== pkg.version) {
    fail(`version drift: index.js=${match[1]} package.json=${pkg.version}`)
  } else {
    pass(`version: ${pkg.version} (index.js == package.json)`)
  }
  const required = ['index.js', 'client.js', 'lib/grid.js', 'lib/access.js', 'lib/doctor.js', 'runtime/helper.cs', 'runtime/bootstrap.mjs', 'skills/click-matrix/SKILL.md', 'locale/en.json', 'locale/zh.json']
  for (const rel of required) {
    if (!existsSync(join(ROOT, rel))) fail(`missing file: ${rel}`)
  }
  pass(`required files: ${required.length}`)
  if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') {
    fail('package.json: dsh.client.platform=web declaration missing')
  } else {
    pass('package manifest: web client declared（引擎形态，无独立 dsh.bundle）')
  }
  if (!pkg.scripts || !pkg.scripts.test) fail('package.json: npm test script missing')
}

// ---- 4) client loader id ------------------------------------------------
try {
  const client = readText(join(ROOT, 'client.js'))
  if (!client.includes("window.__ModuleLoader__.load")) fail('client.js: ModuleLoader.load missing')
  if (pkg && !client.includes(`id: '${pkg.name}'`)) fail(`client.js: loader id must equal package name "${pkg.name}"`)
  pass('client.js: loader id matches package name')
} catch {
  fail('client.js: unreadable')
}

// ---- 5) tool description boundary ---------------------------------------
// The model API rejects the whole request when a tool description is not a
// string (provider error: tools[N].description "invalid type: sequence").
try {
  const indexText = readText(join(ROOT, 'index.js'))
  const bad = []
  const re = /(^|\n)\s*description\s*:\s*\[/g
  let m
  while ((m = re.exec(indexText))) {
    bad.push('index.js:' + (indexText.slice(0, m.index).match(/\n/g) || []).length + 1)
  }
  if (bad.length) fail('tool description array literal found at ' + bad.join(', ') + ' (must be a string)')
  else if (!indexText.includes('sanitizeToolDefinition')) fail('index.js: sanitizeToolDefinition guard missing')
  else pass('tool descriptions: string boundary guarded')
} catch {
  fail('index.js: unreadable for description boundary check')
}

for (const note of notes) console.log('PASS', note)
if (failures.length > 0) {
  console.error(`\nFAIL ${failures.length} issue(s):`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log(`\nPASS repo check: ${notes.length} checks, 0 failed`)
