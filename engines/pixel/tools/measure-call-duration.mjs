// Print recent tool-call durations (call event time -> matching result event time).
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = 0; i <= buf.length - 4; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
const events = []
for (const off of offsets) {
  try {
    const text = zstdDecompressSync(buf.subarray(off)).toString('utf8')
    for (const line of text.split(/\r?\n/)) if (line.trim()) { try { events.push(JSON.parse(line)) } catch { } }
  } catch { }
}
events.sort((a, b) => a.seq - b.seq)
const calls = new Map()
const out = []
for (const e of events) {
  if (e.type === 'tool/call') {
    const args = typeof e.data?.arguments === 'string' ? e.data.arguments : ''
    calls.set(e.data?.callId, { name: e.data?.name, args, time: e.time })
  }
  if (e.type === 'tool/result') {
    const id = e.data?.message?.source?.callId
    const c = calls.get(id)
    if (c) {
      out.push({ name: c.name, ms: e.time - c.time, argLen: c.args.length, snippet: c.args.replace(/\s+/g, ' ').slice(0, 90) })
      calls.delete(id)
    }
  }
}
for (const o of out.slice(-14)) console.log(`${o.name} ${o.ms}ms argLen=${o.argLen} :: ${o.snippet}`)
