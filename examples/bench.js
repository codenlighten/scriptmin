'use strict'

// Benchmark: naive field-arithmetic scripts of increasing size.
// Each result is proven equivalent symbolically, then both scripts are run on
// the interpreter with real field inputs and checked against the circuit.

const crypto = require('crypto')
const { optimize } = require('../src')
const { evaluate } = require('../src/verify')
const { encodeNum } = require('../src/num')
const { randomCircuit, compileNaive, evaluateCircuit, P } = require('./naive-field-compiler')
const bsv = require('@smartledger/bsv')

const sizes = (process.argv[2] || '50,500,2000,10000').split(',').map(Number)
const effort = process.argv[3] || 'medium'
const modulus = process.argv[4] || 'push'
const flags = bsv.Script.Interpreter.currentConsensusFlags()
const fmt = n => n.toLocaleString('en-US')

console.log(`effort=${effort} modulus=${modulus}`)
console.log('gates      original     optimized      saved   reduction    time   interpreter check')
for (const gates of sizes) {
  const c = randomCircuit({ gates, seed: gates })
  const script = compileNaive(c, { modulus })
  const res = optimize(script, { effort, differential: 0 })
  let checks = 0
  for (let t = 0; t < 3; t++) {
    const inputs = []
    for (let i = 0; i < c.inputs; i++) inputs.push(BigInt('0x' + crypto.randomBytes(32).toString('hex')) % P)
    const stack = inputs.map(encodeNum)
    const expected = evaluateCircuit(c, inputs).map(v => encodeNum(v).toString('hex'))
    const a = evaluate(script, stack, flags)
    const b = evaluate(res.script, stack, flags)
    if (!a.ok || !b.ok || a.stack.join() !== expected.join() || b.stack.join() !== expected.join()) {
      console.error('MISMATCH', { gates, a: a.err, b: b.err })
      process.exit(1)
    }
    checks++
  }
  const r = res.report
  console.log(
    String(gates).padEnd(6),
    fmt(r.original.bytes).padStart(12),
    fmt(r.optimized.bytes).padStart(13),
    fmt(r.saved).padStart(10),
    (r.reductionPct.toFixed(2) + '%').padStart(11),
    ((r.ms / 1000).toFixed(1) + 's').padStart(7),
    `  ${checks}/3 ok, proof ${r.verification.symbolic.ok ? 'ok' : 'FAILED'}`
  )
  console.log('       ' + r.passes.map(p => `${p.name} -${fmt(p.saved)}`).join(', '))
}
