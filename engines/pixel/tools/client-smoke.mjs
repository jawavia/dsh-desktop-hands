// Static smoke for client.js: load the plain ModuleLoader factory with stubs and
// assert it registers the chip in conversation.input.left without throwing.
// Run: node tools/client-smoke.mjs
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let captured = null
const fakeReact = {
  createElement: (...args) => ({ type: args[0], props: args[1] || {} }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
}
const fakeWindow = { __ModuleLoader__: { load: (opts) => { captured = opts } } }
const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
}
runInNewContext(code, { window: fakeWindow, require: requireStub, setTimeout, clearInterval, setInterval, fetch: () => Promise.reject(new Error('no fetch')) })
if (!captured || captured.id !== 'dsh-click-matrix') throw new Error('ModuleLoader id mismatch: ' + (captured && captured.id))
const mod = captured.factory(requireStub)
if (!mod || typeof mod.apply !== 'function') throw new Error('factory did not return apply()')
if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) throw new Error('inject must include slots')

const registered = []
let effects = 0
const fakeCtx = {
  get: (name) => (name === 'slots' ? {
    inject: (owner, thunk) => { effects++; const reg = thunk(); registered.push({ owner, reg }); return () => {} },
    register: (opts, render) => ({ slot: opts.name, id: opts.id, order: opts.order, render }),
  } : undefined),
  effect: (fn, label) => { effects++; const d = fn(); return typeof d === 'function' ? d : () => {} },
}
mod.apply(fakeCtx)
if (registered.length !== 2) throw new Error('expected two slot registrations (chip + settings), got ' + registered.length)
const chipReg = registered.map((e) => e.reg).find((r) => r.slot === 'conversation.input.left')
if (!chipReg) throw new Error('missing conversation.input.left registration')
if (chipReg.id !== 'click-matrix-chip') throw new Error('wrong id: ' + chipReg.id)
if (typeof chipReg.render !== 'function') throw new Error('missing chip render')
const wrapper = chipReg.render({ inputActions: { setDraft() {}, submit() {} } })
if (!wrapper || typeof wrapper.type !== 'function') throw new Error('render did not return the chip component')
const el = wrapper.type(wrapper.props)
if (!el || !el.props || !el.props.style) throw new Error('component render produced no element')
const settingsReg = registered.map((e) => e.reg).find((r) => r.slot === 'settings.section')
if (!settingsReg) throw new Error('missing settings.section registration')
if (settingsReg.id !== 'click-matrix') throw new Error('settings section id mismatch: ' + settingsReg.id)
const settingsWrapper = settingsReg.render({})
if (!settingsWrapper || typeof settingsWrapper.type !== 'function') throw new Error('settings section render did not return a component')
console.log('PASS client.js: id, factory, injection, chip + settings section registration, component render')
