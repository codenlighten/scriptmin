'use strict'

// A deliberately straightforward compiler for modular arithmetic circuits, in
// the style many Script generators start with: every operand is fetched with
// <depth> OP_PICK, the modulus is pushed at every reduction, nothing is freed
// until the end, and a final cleanup rolls and drops every temporary.
//
// Used as a benchmark: it is correct, and it is the kind of output a
// minimizer should be able to shrink without knowing anything about fields.

const { OP, numOp, pushOp, encode } = require('../src/script')
const { encodeNum } = require('../src/num')

// A 254-bit prime-sized modulus (2^254 - 127); the benchmark only needs its size.
const P = (1n << 254n) - 127n

function rng (seed) {
  let s = BigInt(seed) || 1n
  return () => {
    s ^= (s << 13n) & 0xffffffffffffffffn
    s ^= s >> 7n
    s ^= (s << 17n) & 0xffffffffffffffffn
    return Number(s & 0x7fffffffn)
  }
}

// circuit: { inputs, gates: [{ op: 'mul'|'add'|'sub', a, b }], outputs: [value index] }
// Values are numbered: 0..inputs-1 are inputs, inputs+i is gate i.
function randomCircuit ({ inputs = 8, gates = 200, outputs = 4, seed = 1 } = {}) {
  const r = rng(seed)
  const list = []
  const ops = ['mul', 'mul', 'add', 'sub']
  for (let i = 0; i < gates; i++) {
    const n = inputs + i
    // Favour recent values, like real formulas do.
    const pick = () => (r() % 3 === 0 ? r() % n : Math.max(0, n - 1 - (r() % Math.min(n, 12))))
    list.push({ op: ops[r() % ops.length], a: pick(), b: pick() })
  }
  const outs = []
  for (let i = 0; i < outputs; i++) outs.push(inputs + gates - 1 - i * 3)
  return { inputs, gates: list, outputs: outs }
}

// modulus: 'push' re-pushes the 33-byte modulus at every reduction;
//          'pick' pushes it once and fetches it with OP_PICK like any value.
function compileNaive (c, { modulus = 'push' } = {}) {
  const ops = []
  const stack = [] // value index per stack slot, bottom first
  for (let i = 0; i < c.inputs; i++) stack.push(i)
  const depthOf = v => stack.length - 1 - stack.lastIndexOf(v)
  const MOD = 'p'
  let p = pushOp(encodeNum(P))
  if (modulus === 'pick') {
    ops.push(p)
    stack.push(MOD)
    p = null
  }
  const modulusOps = () => {
    if (p) return [p]
    // The operation's result sits on top, one slot above the tracked stack.
    return [numOp(depthOf(MOD) + 1), { code: OP.OP_PICK }]
  }

  c.gates.forEach((g, i) => {
    ops.push(numOp(depthOf(g.a)), { code: OP.OP_PICK })
    stack.push(-1)
    ops.push(numOp(depthOf(g.b)), { code: OP.OP_PICK })
    stack.pop()
    if (g.op === 'mul') ops.push({ code: OP.OP_MUL }, ...modulusOps(), { code: OP.OP_MOD })
    if (g.op === 'add') ops.push({ code: OP.OP_ADD }, ...modulusOps(), { code: OP.OP_MOD })
    if (g.op === 'sub') ops.push({ code: OP.OP_SUB }, ...modulusOps(), { code: OP.OP_ADD }, ...modulusOps(), { code: OP.OP_MOD })
    stack.push(c.inputs + i)
  })

  // Cleanup: drop everything that is not an output, then order the outputs.
  const keep = new Set(c.outputs)
  for (let q = stack.length - 1; q >= 0; q--) {
    if (!keep.has(stack[q])) {
      ops.push(numOp(stack.length - 1 - q), { code: OP.OP_ROLL }, { code: OP.OP_DROP })
      stack.splice(q, 1)
    }
  }
  for (const v of c.outputs) {
    ops.push(numOp(depthOf(v)), { code: OP.OP_ROLL })
    stack.splice(stack.lastIndexOf(v), 1)
    stack.push(v)
  }
  return encode(ops)
}

function evaluateCircuit (c, inputs) {
  const vals = inputs.slice()
  for (const g of c.gates) {
    const a = vals[g.a]
    const b = vals[g.b]
    if (g.op === 'mul') vals.push((a * b) % P)
    if (g.op === 'add') vals.push((a + b) % P)
    if (g.op === 'sub') vals.push((((a - b) + P) % P))
  }
  return c.outputs.map(o => vals[o])
}

module.exports = { P, randomCircuit, compileNaive, evaluateCircuit }

if (require.main === module) {
  const gates = Number(process.argv[2] || 200)
  const c = randomCircuit({ gates, seed: Number(process.argv[3] || 1) })
  process.stdout.write(compileNaive(c, { modulus: process.argv[4] || 'push' }).toString('hex') + '\n')
}
