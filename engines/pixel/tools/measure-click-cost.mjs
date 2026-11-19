// Measure per-step token cost from the DSH session log for host-side click steps.
// Decodes the concatenated Zstandard frames of session.v4.jsonl.zstd.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = 0; i <= buf.length - 4; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
const events = []
for (const off of offsets) {
  try {
    const text = zstdDecompressSync(buf.subarray(off)).toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* skip */ }
    }
  } catch { /* skip bad frame */ }
}
events.sort((a, b) => a.seq - b.seq)

let req = 0
let lastTotal = 0
let lastOut = 0
const pendingCalls = []
const pendingResults = { textChars: 0, imgs: 0, results: 0 }
const rows = []
for (const e of events) {
  if (e.type === 'assistant/message') {
    const u = e.data?.usage || {}
    const total = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
    req++
    rows.push({
      req,
      seq: e.seq,
      delta: req === 1 ? total : total - lastTotal,
      out: u.outputTokens || 0,
      calls: pendingCalls.splice(0),
      results: { ...pendingResults },
    })
    pendingResults.textChars = 0
    pendingResults.imgs = 0
    pendingResults.results = 0
    lastTotal = total
    lastOut = u.outputTokens || 0
    continue
  }
  if (e.type === 'tool/call') {
    const args = typeof e.data?.arguments === 'string' ? e.data.arguments : ''
    pendingCalls.push({ name: e.data?.name, argsLen: args.length })
  }
  if (e.type === 'tool/result') {
    const content = e.data?.message?.content || []
    pendingResults.results++
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') pendingResults.textChars += b.text.length
      if (b?.type === 'image') pendingResults.imgs++
    }
  }
}
console.log('requests:', req)
const start = Math.max(0, rows.length - 14)
for (const r of rows.slice(start)) {
  const calls = r.calls.map((c) => `${c.name}(${c.argsLen})`).join(',')
  console.log(`req=${r.req} delta=${r.delta} out=${r.out} calls=[${calls}] results=${r.results.results} resultChars=${r.results.textChars} imgs=${r.results.imgs}`)
}
