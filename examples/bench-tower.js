'use strict'

// Benchmark on Fp12 tower arithmetic (see tower-circuit.js), compiled naively.

const crypto = require('crypto')
const bsv = require('@smartledger/bsv')
const { optimize } = require('../src')
const { evaluate } = require('../src/verify')
const { encodeNum } = require('../src/num')
const { compileNaive, evaluateCircuit, P } = require('./naive-field-compiler')
const { millerLikeCircuit } = require('./tower-circuit')

const steps = (process.argv[2] || '1,2,4').split(',').map(Number)
const effort = process.argv[3] || 'medium'
const lastUse = process.argv[4] === 'lastuse'
const flags = bsv.Script.Interpreter.currentConsensusFlags()
const fmt = n => n.toLocaleString('en-US')

console.log(`Fp12 f <- f^2 * g chains, effort=${effort}, baseline=${lastUse ? 'ROLL at last use' : 'PICK everything'}`)
console.log('steps   gates     original    optimized   reduction     time   check')
for (const n of steps) {
  const c = millerLikeCircuit(n)
  const script = compileNaive(c, { modulus: 'pick', lastUse })
  const res = optimize(script, { effort, differential: 0 })
  const inputs = []
  for (let i = 0; i < c.inputs; i++) inputs.push(BigInt('0x' + crypto.randomBytes(32).toString('hex')) % P)
  const expected = evaluateCircuit(c, inputs).map(v => encodeNum(v).toString('hex')).join()
  const stack = inputs.map(encodeNum)
  const a = evaluate(script, stack, flags)
  const b = evaluate(res.script, stack, flags)
  const ok = a.ok && b.ok && a.stack.join() === expected && b.stack.join() === expected
  const r = res.report
  console.log(
    String(n).padEnd(5), fmt(c.gates.length).padStart(7), fmt(r.original.bytes).padStart(12), fmt(r.optimized.bytes).padStart(12),
    (r.reductionPct.toFixed(2) + '%').padStart(11), ((r.ms / 1000).toFixed(1) + 's').padStart(8),
    `  ${ok ? 'ok' : 'MISMATCH'}, proof ${r.verification.symbolic.ok ? 'ok' : 'FAILED'}`
  )
  console.log('        ' + r.passes.map(p => `${p.name} -${fmt(p.saved)}`).join(', '))
  if (!ok) process.exitCode = 1
}
