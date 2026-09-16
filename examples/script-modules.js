'use strict'

// Real-world check against script-high-level-modules (the BSV Script module
// library with the BLS12-381 pairing and Groth16 verifier).
//
//   SCRIPT_MODULES=/path/to/script-high-level-modules \
//     node examples/script-modules.js m:fp12.mul f:pairing.miller:63
//
// m:<name> is a module from its catalogue, f:<name>:<arg> a factory call.
// Each module script is optimized on its own, then spliced back in front of
// the project's own test assertions: every honest case must still pass and
// every refusal case must still be refused, under its relay policy flags.

const path = require('path')
const SHM = process.env.SCRIPT_MODULES
if (!SHM) {
  console.error('set SCRIPT_MODULES to a checkout of script-high-level-modules')
  process.exit(2)
}
const SM = path.join(__dirname, '..')
const lib = require(SHM + '/src/index.js')
const { complete, build, refusalValues } = require(SHM + '/src/testkit')
const { Asm } = require(SHM + '/src/asm')
const { policyFlags } = require(SHM + '/src/run')
const { optimize, Cache } = require(SM + '/src')
const { parse, isPush, pushValue } = require(SM + '/src/script')
const { evaluate } = require(SM + '/src/verify')

const effort = process.env.EFFORT || 'medium'
const stackOf = unlock => parse(unlock.toBuffer()).map(op => pushValue(op))

function target (spec) {
  const [kind, name, arg] = spec.split(':')
  if (kind === 'm') return lib.modules[name]
  return lib.factories[name](arg === undefined ? undefined : Number(arg))
}

const specs = process.argv.slice(2)
let tot0 = 0; let tot1 = 0
for (const spec of specs) {
  const m = target(spec)
  const honest = m.cases.filter(c => !c.refuse)
  const refuse = m.cases.filter(c => c.refuse)
  const memo = new Map()
  const moduleFor = (p) => {
    const asm = new Asm()
    asm.given([{ name: '_sentinel', kind: 'bytes', width: 4 }, ...m.inputs])
    m.emit(asm, p)
    const buf = asm.script().toBuffer()
    const k = buf.toString('hex')
    if (!memo.has(k)) {
      const t = Date.now()
      const res = optimize(buf, { effort, differential: 0 })
      memo.set(k, { buf, res, ms: Date.now() - t })
    }
    return memo.get(k)
  }
  let passed = 0; let refused = 0; let unspliced = 0; const problems = []
  const spliced = (p, lock) => {
    const { buf, res } = moduleFor(p)
    const full = lock.toBuffer()
    if (!full.slice(0, buf.length).equals(buf)) return null
    return Buffer.concat([res.script, full.slice(buf.length)])
  }
  for (const c of honest) {
    const p = { ...(c.params || {}) }
    const b = build(m, p, complete(m, p, c.inputs))
    const st = stackOf(b.unlock)
    const opt = spliced(p, b.lock)
    if (!opt) { unspliced++; continue }
    const x = evaluate(b.lock.toBuffer(), st, policyFlags())
    const y = evaluate(opt, st, policyFlags())
    if (!x.ok) problems.push(`original fails honest ${c.name}: ${x.err}`)
    if (!y.ok) problems.push(`OPTIMIZED FAILS honest ${c.name}: ${y.err}`)
    passed++
  }
  for (const c of refuse) {
    const p = { ...(c.params || {}) }
    let b
    try { b = build(m, p, refusalValues(m, p, c.inputs)) } catch (e) { continue }
    const opt = spliced(p, b.lock)
    if (!opt) { unspliced++; continue }
    const st = stackOf(b.unlock)
    const x = evaluate(b.lock.toBuffer(), st, policyFlags())
    const y = evaluate(opt, st, policyFlags())
    if (x.ok !== y.ok) problems.push(`refusal ${c.name}: original ${x.ok} optimized ${y.ok}`)
    refused++
  }
  const first = moduleFor({ ...(honest[0].params || {}) })
  const r = first.res.report
  const ms = first.ms
  tot0 += r.original.bytes; tot1 += r.optimized.bytes
  console.log(`${m.name.padEnd(22)} ${String(r.original.bytes).padStart(9)} -> ${String(r.optimized.bytes).padStart(9)} ${('-' + r.saved).padStart(8)} ${r.reductionPct.toFixed(2).padStart(6)}% ${String(ms).padStart(7)}ms proof ${r.verification.symbolic.ok ? 'ok' : 'FAIL'} honest ${passed} refusals ${refused}${unspliced ? ' unspliced ' + unspliced : ''} ${problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'ok'} | ${r.passes.map(x => x.name + ':' + x.saved).join(' ')}`)
  if (problems.length) process.exitCode = 1
}
if (specs.length > 1) console.log(`total ${tot0} -> ${tot1} (-${tot0 - tot1}, ${(100 * (tot0 - tot1) / tot0).toFixed(2)}%)`)
