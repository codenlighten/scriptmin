'use strict'

// Circuit IR compiler for prime-field arithmetic.
//
// A circuit says what is computed, not how the stack moves, and it says that
// values only matter modulo p. That is information emitted Script has lost,
// and it allows lazy reduction: sums, differences and small multiples are
// left unreduced, and a value is reduced only when its size would exceed a
// bit budget, or when it must be canonical (outputs and equality checks).
//
// IR (JSON):
//   {
//     "modulus": "0x30644e...",          prime, decimal or 0x-hex
//     "inputs": 24,                      field elements on the stack, first deepest,
//                                        each assumed to be in [0, p)
//     "gates": [
//       { "op": "add" | "sub" | "mul", "a": 0, "b": 1 },
//       { "op": "mulc", "a": 3, "k": "9" },
//       { "op": "const", "v": "5" },
//       { "op": "assertEqual", "a": 7, "b": 9 }
//     ],
//     "outputs": [ ... ]                 value indices left on the stack, first deepest
//   }
// Value i < inputs is input i; value inputs + j is the result of gate j
// (assertEqual gates produce no usable value).

const { OP, numOp, pushOp, encode } = require('./script')
const { encodeNum } = require('./num')

const PUSH = 'push'

function big (x) {
  return typeof x === 'bigint' ? x : BigInt(x)
}

function parseIR (ir) {
  const p = big(ir.modulus)
  if (p < 3n) throw new Error('modulus must be an odd prime')
  const gates = ir.gates.map((g, j) => {
    const out = Object.assign({}, g)
    if (g.k !== undefined) out.k = big(g.k)
    if (g.v !== undefined) out.v = big(g.v)
    for (const key of ['a', 'b']) {
      if (g[key] !== undefined && !(g[key] >= 0 && g[key] < ir.inputs + j)) {
        throw new Error(`gate ${j}: operand ${key}=${g[key]} is not an earlier value`)
      }
    }
    if (!['add', 'sub', 'mul', 'mulc', 'const', 'assertEqual'].includes(g.op)) throw new Error(`gate ${j}: unknown op ${g.op}`)
    return out
  })
  for (const o of ir.outputs) {
    if (!(o >= 0 && o < ir.inputs + gates.length)) throw new Error(`output ${o} is not a value`)
  }
  return { p, inputs: ir.inputs, gates, outputs: ir.outputs.slice() }
}

// Reference semantics: every value canonical in [0, p).
function evaluateIR (ir, inputs) {
  const c = ir.p ? ir : parseIR(ir)
  const p = c.p
  const mod = x => ((x % p) + p) % p
  const vals = inputs.map(big)
  for (const g of c.gates) {
    switch (g.op) {
      case 'add': vals.push(mod(vals[g.a] + vals[g.b])); break
      case 'sub': vals.push(mod(vals[g.a] - vals[g.b])); break
      case 'mul': vals.push(mod(vals[g.a] * vals[g.b])); break
      case 'mulc': vals.push(mod(vals[g.a] * g.k)); break
      case 'const': vals.push(mod(g.v)); break
      case 'assertEqual':
        if (vals[g.a] !== vals[g.b]) return { ok: false }
        vals.push(null)
        break
    }
  }
  return { ok: true, outputs: c.outputs.map(o => vals[o]) }
}

// A straight-line program: steps { code, args: [ref | { const }] }, where a
// ref names an input ('i3') or an earlier step ('s7') and code PUSH pushes a
// constant. Emitted to Script by fetching every operand with PICK and cleaning up at
// the end. The optimizer's scheduler then rebuilds the choreography.
function emitProgram (nInputs, steps, outputs) {
  const ops = []
  const stack = []
  for (let i = 0; i < nInputs; i++) stack.push('i' + i)
  const depthOf = v => {
    const q = stack.lastIndexOf(v)
    if (q < 0) throw new Error('internal: value not on stack ' + v)
    return stack.length - 1 - q
  }
  steps.forEach((st, j) => {
    const name = 's' + j
    if (st.code === PUSH) {
      ops.push(pushOp(encodeNum(st.args[0].const)))
      stack.push(name)
      return
    }
    let pushed = 0
    for (const a of st.args) {
      if (typeof a === 'object') ops.push(pushOp(encodeNum(a.const)))
      else ops.push(numOp(depthOf(a)), { code: OP.OP_PICK })
      pushed++
      stack.push('tmp')
    }
    stack.length -= pushed
    ops.push({ code: st.code })
    if (st.code !== OP.OP_NUMEQUALVERIFY) stack.push(name)
  })
  const keep = outputs.slice()
  const final = []
  for (const v of keep) {
    ops.push(numOp(depthOf(v)), { code: OP.OP_PICK })
    stack.push(v)
    final.push(v)
  }
  // Drop everything below the outputs.
  const below = stack.length - final.length
  for (let q = below - 1; q >= 0; q--) {
    ops.push(numOp(stack.length - 1 - q), { code: OP.OP_ROLL }, { code: OP.OP_DROP })
    stack.splice(q, 1)
  }
  return encode(ops)
}

// Plan the program. maxBits: largest intermediate magnitude allowed, in bits;
// 0 reduces after every operation (the reference program).
// modulusInput: take p from the stack, as one more input above the circuit's
// own, instead of pushing it — for code composed into a script that already
// holds p, where pushing it again at every call would cost its full width.
function plan (c, { maxBits = 0, modulusInput = false } = {}) {
  const p = c.p
  const P = modulusInput ? 'i' + c.inputs : { const: p }
  const steps = []
  const limit = maxBits ? (1n << BigInt(maxBits)) : 0n
  // Per value: stack ref and bounds [lo, hi] of the integer it holds.
  const val = []
  for (let i = 0; i < c.inputs; i++) val.push({ ref: 'i' + i, lo: 0n, hi: p - 1n })
  const step = (code, args) => { steps.push({ code, args }); return 's' + (steps.length - 1) }
  const mag = v => (v.lo < 0n ? -v.lo : v.lo) > v.hi ? -v.lo : v.hi

  // x mod p lands in (-p, p) for negative x, [0, p) otherwise.
  const reduce = v => {
    if (v.lo >= 0n && v.hi < p) return v
    return { ref: step(OP.OP_MOD, [v.ref, P]), lo: v.lo < 0n ? -(p - 1n) : 0n, hi: p - 1n }
  }
  const canonical = v => {
    v = reduce(v)
    if (v.lo >= 0n) return v
    const shifted = step(OP.OP_ADD, [v.ref, P])
    return { ref: step(OP.OP_MOD, [shifted, P]), lo: 0n, hi: p - 1n }
  }
  const fits = (lo, hi) => !limit || ((lo < 0n ? -lo : lo) < limit && (hi < 0n ? -hi : hi) < limit)
  const mulBounds = (a, b) => {
    const xs = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]
    return [xs.reduce((m, x) => (x < m ? x : m)), xs.reduce((m, x) => (x > m ? x : m))]
  }
  const binary = (code, a, b, bounds) => {
    let [lo, hi] = bounds(a, b)
    if (!fits(lo, hi)) {
      // Reduce the larger operand first; if that is not enough, both.
      if (mag(a) >= mag(b)) a = reduce(a); else b = reduce(b)
      ;[lo, hi] = bounds(a, b)
      if (!fits(lo, hi)) { a = reduce(a); b = reduce(b); [lo, hi] = bounds(a, b) }
    }
    let r = { ref: step(code, [a.ref, b.ref]), lo, hi }
    if (!limit) r = reduce(r)
    return r
  }

  for (const g of c.gates) {
    switch (g.op) {
      case 'add': val.push(binary(OP.OP_ADD, val[g.a], val[g.b], (a, b) => [a.lo + b.lo, a.hi + b.hi])); break
      case 'sub': val.push(binary(OP.OP_SUB, val[g.a], val[g.b], (a, b) => [a.lo - b.hi, a.hi - b.lo])); break
      case 'mul': val.push(binary(OP.OP_MUL, val[g.a], val[g.b], mulBounds)); break
      case 'mulc': {
        const k = { ref: null, lo: g.k, hi: g.k }
        let a = val[g.a]
        let [lo, hi] = mulBounds(a, k)
        if (!fits(lo, hi)) { a = reduce(a); [lo, hi] = mulBounds(a, k) }
        let r = { ref: step(OP.OP_MUL, [a.ref, { const: g.k }]), lo, hi }
        if (!limit) r = reduce(r)
        val.push(r)
        break
      }
      case 'const': {
        const v = ((g.v % p) + p) % p
        val.push({ ref: step(PUSH, [{ const: v }]), lo: v, hi: v })
        break
      }
      case 'assertEqual': {
        const a = canonical(val[g.a])
        const b = canonical(val[g.b])
        step(OP.OP_NUMEQUALVERIFY, [a.ref, b.ref])
        val.push(null)
        break
      }
    }
  }
  const outputs = c.outputs.map(o => canonical(val[o]).ref)
  return { steps, outputs }
}

// compileIR(ir, { maxBits }) -> { script, reference }
//   script:    lazily reduced program, before stack optimization
//   reference: every value reduced after every operation
function compileIR (ir, { maxBits = 1024, modulusInput = false } = {}) {
  const c = parseIR(ir)
  const lazy = plan(c, { maxBits, modulusInput })
  const ref = plan(c, { maxBits: 0, modulusInput })
  const n = c.inputs + (modulusInput ? 1 : 0)
  return {
    circuit: c,
    script: emitProgram(n, lazy.steps, lazy.outputs),
    reference: emitProgram(n, ref.steps, ref.outputs)
  }
}

// Compile, stack-optimize, and check against the circuit's exact semantics.
function compileField (ir, { maxBits = 1024, tests = 20, optimizeOptions = {} } = {}) {
  const { optimize } = require('./optimize')
  const { evaluate } = require('./verify')
  const bsv = require('@smartledger/bsv')
  const crypto = require('crypto')
  const flags = bsv.Script.Interpreter.currentConsensusFlags()
  const t0 = Date.now()
  const { circuit, script, reference } = compileIR(ir, { maxBits })
  const opt = optimize(script, Object.assign({ differential: 0 }, optimizeOptions))
  const refOpt = optimize(reference, Object.assign({ differential: 0 }, optimizeOptions))
  const p = circuit.p
  const randomField = () => BigInt('0x' + crypto.randomBytes(Math.ceil(p.toString(16).length / 2) + 8).toString('hex')) % p
  const vectors = [
    Array(circuit.inputs).fill(0n),
    Array(circuit.inputs).fill(p - 1n)
  ]
  for (let i = 0; i < tests; i++) vectors.push(Array.from({ length: circuit.inputs }, randomField))
  let checked = 0
  for (const inputs of vectors) {
    const want = evaluateIR(circuit, inputs)
    const stack = inputs.map(encodeNum)
    for (const [name, buf] of [['optimized', opt.script], ['reference', refOpt.script]]) {
      const got = evaluate(buf, stack, flags)
      const expected = want.ok ? want.outputs.map(v => encodeNum(v).toString('hex')) : null
      const good = want.ok ? got.ok && got.stack.join() === expected.join() : !got.ok
      if (!good) {
        const err = new Error(`${name} script disagrees with the circuit on inputs [${inputs.join(', ')}]`)
        err.got = got
        err.expected = expected
        throw err
      }
    }
    checked++
  }
  return {
    script: opt.script,
    report: {
      gates: circuit.gates.length,
      maxBits,
      naive: script.length,
      optimized: opt.script.length,
      reference: refOpt.script.length,
      referenceNaive: reference.length,
      stack: opt.report,
      checked,
      ms: Date.now() - t0
    }
  }
}

module.exports = { parseIR, evaluateIR, compileIR, compileField }
