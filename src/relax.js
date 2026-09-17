'use strict'

// Relaxing a field-arithmetic script: re-deciding where it reduces.
//
// A script built from modules that each return canonical field elements
// reduces after almost every addition, because every module boundary is a
// promise of canonical output. Inside a larger computation most of those
// promises are never needed: the next operation is another ring operation, and
// only the final outputs (and equality checks) have to be canonical.
//
// relax() lifts such a script back to its arithmetic circuit and compiles that
// circuit again with lazy reduction (src/field.js):
//
//   - the script must be one modelled region using only pushes, stack moves,
//     OP_ADD, OP_SUB, OP_MUL (and OP_1ADD/OP_1SUB), OP_MOD by one constant
//     prime p, and range checks on its inputs (<lo> <hi> OP_WITHIN OP_VERIFY
//     with constant bounds). The checks are kept and moved to the front: a
//     failed check fails the whole script wherever it sits, so the same inputs
//     are refused;
//   - every OP_MOD by p is dropped from the circuit. Ring operations respect
//     congruence mod p, so every value of the circuit is congruent to the
//     corresponding value of the script, and the recompiled outputs are
//     reduced to canonical form;
//   - the result is equal to the script's output exactly when the script's own
//     outputs are canonical for canonical inputs, which is what a module
//     promises and what relax() then tests: both scripts run on the
//     interpreter from the same canonical inputs (all zero, all p-1 and
//     random), and every output must match byte for byte.
//
// The inputs are assumed to be in [0, p), as the modules this is for require.

const crypto = require('crypto')
const bsv = require('@smartledger/bsv')
const { OP, parse, toBuffer } = require('./script')
const { Interner, run } = require('./symbolic')
const { decodeNum, encodeNum } = require('./num')
const { compileIR } = require('./field')
const { optimize } = require('./optimize')
const { evaluate } = require('./verify')

const NAMES = { [OP.OP_ADD]: 'add', [OP.OP_SUB]: 'sub', [OP.OP_MUL]: 'mul', [OP.OP_MOD]: 'mod' }

function bigConst (I, id) {
  if (!I.isConst(id)) return null
  // Constants in field code can be as large as p itself.
  return decodeNum(I.constBuf(id), 1 << 20)
}

// lift(ops, p) -> { inputs, gates, outputs, bounds } or throws with the reason.
// bounds: [{ input, lo, hi }], input counted from the deepest.
function lift (ops, p) {
  const I = new Interner()
  const st = run(ops, I, { record: true })
  if (!st) throw new Error('relax: the script is not one modelled region (control flow, or an opcode that is not modelled)')
  if (st.usedAlt) {
    // Alt-stack moves only transport values; they are fine as long as the
    // alt stack ends as it started.
    if (st.A !== 0 || st.alt.length !== 0) throw new Error('relax: the script leaves or reads alt-stack values')
  }
  const D = st.D
  const val = new Map() // symbolic id -> circuit value index
  for (let i = 0; i < D; i++) val.set(I.input(i), D - 1 - i) // input 0 of the circuit is the deepest
  const gates = []
  const push = (g) => { gates.push(g); return D + gates.length - 1 }
  const constGate = new Map()
  const valueOf = (id) => {
    if (val.has(id)) return val.get(id)
    const c = bigConst(I, id)
    if (c === null) throw new Error('relax: a value comes from an operation the circuit does not model')
    if (!constGate.has(c)) constGate.set(c, push({ op: 'const', v: c }))
    return constGate.get(c)
  }

  const inputIndex = (id) => {
    const info = I.info[id]
    return info.kind === 'in' ? D - 1 - info.index : null
  }
  const bounds = []
  const pendingWithin = new Map() // WITHIN output id -> { input, lo, hi }
  for (const a of st.apps) {
    if (a.pinned) continue // alt-stack moves
    if (a.code === OP.OP_WITHIN) {
      const [x, lo, hi] = a.inputs
      const k = inputIndex(x)
      const l = bigConst(I, lo)
      const h = bigConst(I, hi)
      if (k === null || l === null || h === null) throw new Error('relax: an OP_WITHIN that is not a constant range check on an input')
      pendingWithin.set(a.outputs[0], { input: k, lo: l, hi: h })
      continue
    }
    if (a.code === OP.OP_VERIFY) {
      const b = pendingWithin.get(a.inputs[0])
      if (!b) throw new Error('relax: an OP_VERIFY of something other than an input range check')
      pendingWithin.delete(a.inputs[0])
      bounds.push(b)
      continue
    }
    const name = NAMES[a.code]
    if (!name) throw new Error(`relax: opcode ${a.code} is not ring arithmetic`)
    const [x, y] = a.inputs
    const out = a.outputs[0]
    if (name === 'mod') {
      const m = bigConst(I, y)
      if (m !== p) throw new Error('relax: a reduction is not by the constant modulus')
      val.set(out, valueOf(x)) // congruent: drop it
      continue
    }
    const cx = bigConst(I, x)
    const cy = bigConst(I, y)
    if (name === 'mul' && (cx !== null) !== (cy !== null)) {
      const k = cx !== null ? cx : cy
      val.set(out, push({ op: 'mulc', a: valueOf(cx !== null ? y : x), k }))
      continue
    }
    val.set(out, push({ op: name, a: valueOf(x), b: valueOf(y) }))
  }
  if (pendingWithin.size) throw new Error('relax: an OP_WITHIN result is used for something other than OP_VERIFY')
  for (const id of st.main) {
    if ([...st.apps].some((a) => a.code === OP.OP_WITHIN && a.outputs[0] === id)) throw new Error('relax: a range check result is left on the stack')
  }
  const outputs = st.main.map(valueOf)
  return { inputs: D, gates, outputs, bounds }
}

// <depth> OP_PICK <lo> <hi> OP_WITHIN OP_VERIFY for each bound, against the
// untouched input stack.
function boundChecks (bounds, inputs) {
  const { numOp, pushOp } = require('./script')
  const ops = []
  for (const b of bounds) {
    const depth = inputs - 1 - b.input
    ops.push(numOp(depth), { code: OP.OP_PICK }, pushOp(encodeNum(b.lo)), pushOp(encodeNum(b.hi)), { code: OP.OP_WITHIN }, { code: OP.OP_VERIFY })
  }
  return ops
}

function randomField (p) {
  const bytes = Math.ceil(p.toString(16).length / 2) + 8
  return BigInt('0x' + crypto.randomBytes(bytes).toString('hex')) % p
}

// relax(script, { modulus, maxBits, modulusInput, tests, optimizeOptions }) -> { script, report }
//
// modulusInput: the relaxed script takes p as one more input, on top of the
// original's, instead of pushing it. The original is still run with its own
// inputs only.
function relax (input, { modulus, maxBits = 768, modulusInput = false, tests = 32, optimizeOptions = {} } = {}) {
  if (modulus === undefined) throw new Error('relax: needs the modulus')
  const p = BigInt(modulus)
  const buf = toBuffer(input)
  const ops = parse(buf)
  const circuit = lift(ops, p)
  const ir = {
    modulus: p,
    inputs: circuit.inputs,
    gates: circuit.gates.map((g) => Object.assign({}, g)),
    outputs: circuit.outputs
  }
  const { script: lazy } = compileIR(ir, { maxBits, modulusInput })
  const { encode } = require('./script')
  const full = Buffer.concat([encode(boundChecks(circuit.bounds, circuit.inputs + (modulusInput ? 1 : 0))), lazy])
  const optimized = optimize(full, Object.assign({ differential: 0 }, optimizeOptions))

  // Equal to the original, output for output, on canonical inputs.
  const flags = bsv.Script.Interpreter.currentConsensusFlags()
  const withP = (stack) => (modulusInput ? stack.concat([encodeNum(p)]) : stack)
  const vectors = [Array(circuit.inputs).fill(0n), Array(circuit.inputs).fill(p - 1n)]
  for (let i = 0; i < tests; i++) vectors.push(Array.from({ length: circuit.inputs }, () => randomField(p)))
  // Inputs the range checks must refuse, one input at a time.
  const refusals = []
  for (const b of circuit.bounds) {
    const v = Array.from({ length: circuit.inputs }, () => randomField(p))
    v[b.input] = b.hi
    refusals.push(v)
  }
  for (const v of refusals) {
    const stack = v.map(encodeNum)
    const a = evaluate(buf, stack, flags)
    const b = evaluate(optimized.script, withP(stack), flags)
    if (a.ok !== b.ok || (a.ok && a.stack.join() !== b.stack.join())) {
      throw new Error('relax: the relaxed script and the original disagree on an out-of-range input')
    }
  }
  for (const v of vectors) {
    const stack = v.map(encodeNum)
    const a = evaluate(buf, stack, flags)
    const b = evaluate(optimized.script, withP(stack), flags)
    if (!a.ok) throw new Error(`relax: the original script fails on canonical inputs (${a.err})`)
    if (!b.ok || a.stack.join() !== b.stack.join()) {
      const err = new Error('relax: the relaxed script disagrees with the original; its outputs are not canonical, or it is not pure field arithmetic')
      err.inputs = v.map(String)
      throw err
    }
  }

  const count = (b) => {
    const c = { mod: 0, mul: 0 }
    for (const op of parse(b)) { if (op.code === OP.OP_MOD) c.mod++; if (op.code === OP.OP_MUL) c.mul++ }
    return c
  }
  return {
    script: optimized.script,
    report: {
      original: { bytes: buf.length, ...count(buf) },
      relaxed: { bytes: optimized.script.length, ...count(optimized.script) },
      gates: circuit.gates.length,
      inputs: circuit.inputs,
      outputs: circuit.outputs.length,
      maxBits,
      modulusInput,
      checked: vectors.length,
      bounds: circuit.bounds.length,
      refusalsChecked: refusals.length,
      proof: optimized.report.verification.symbolic
    }
  }
}

module.exports = { lift, relax }
