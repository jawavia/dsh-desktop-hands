// Build the WinForms acceptance fixture from test/fixture.cs.
//
// The fixture binary used to be a local build artifact excluded from git, so a
// clean machine (release zip) could not run `npm run test:helper`. This script
// compiles it on demand with the in-box .NET Framework csc.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'test', 'fixture.cs')
const OUT = join(ROOT, 'test', 'bin', 'fixture.exe')

function cscCandidates() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  return [
    process.env.DSH_CLICK_MATRIX_CSC,
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter(Boolean)
}

if (existsSync(OUT)) {
  console.log('fixture already built: ' + OUT)
  process.exit(0)
}
if (!existsSync(SRC)) {
  console.error('fixture source missing: ' + SRC)
  process.exit(1)
}
mkdirSync(dirname(OUT), { recursive: true })
const csc = cscCandidates().find((p) => existsSync(p))
if (!csc) {
  console.error('csc.exe not found; set DSH_CLICK_MATRIX_CSC to a .NET Framework csc')
  process.exit(1)
}
execFileSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/out:${OUT}`,
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  SRC,
], { stdio: 'inherit' })
console.log('built ' + OUT)
