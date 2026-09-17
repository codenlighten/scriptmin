'use strict'

// Splits a script into regions that the symbolic executor can model, separated
// by "barrier" ops it cannot (control flow, OP_CHECKMULTISIG, OP_DEPTH, a PICK
// whose index is not a constant, ...). Optimizations never touch barriers and
// never cross them.
//
// Alongside the split it computes, for each region, how many main and alt stack
// items are guaranteed to exist whenever that region runs. The guarantee is
// what lets `OP_1 OP_DUP OP_DROP` drop to `OP_1` while `OP_DUP OP_DROP` at the
// very start of a script must stay: there it is the only thing that fails an
// empty stack.

const { OP, TAIL, DEAD, isPush, pushValue } = require('./script')
const { Interner, SymState } = require('./symbolic')

function barrierEffect (op, g, ga, frames) {
  const c = op.code
  if (op.keep) return [g + 1, ga] // a data push kept verbatim
  switch (c) {
    case OP.OP_IF:
    case OP.OP_NOTIF: {
      const start = Math.max(g, 1) - 1
      frames.push({ g: start, ga, ends: [] })
      return [start, ga]
    }
    case OP.OP_VERIF:
    case OP.OP_VERNOTIF:
      frames.push({ g: 0, ga, ends: [] })
      return [0, ga]
    case OP.OP_ELSE: {
      const f = frames[frames.length - 1]
      if (!f) return [0, 0]
      f.ends.push([g, ga])
      return [f.g, f.ga]
    }
    case OP.OP_ENDIF: {
      const f = frames.pop()
      if (!f) return [0, 0]
      let mg = g
      let mga = ga
      const ends = f.ends.length ? f.ends : [[f.g, f.ga]]
      for (const [eg, ega] of ends) { mg = Math.min(mg, eg); mga = Math.min(mga, ega) }
      return [mg, mga]
    }
    case OP.OP_DEPTH: return [g + 1, ga]
    case OP.OP_IFDUP: return [Math.max(g, 1), ga]
    case OP.OP_PICK: return [Math.max(g, 2), ga]
    case OP.OP_ROLL: return [Math.max(g, 2) - 1, ga]
    case OP.OP_CHECKMULTISIG: return [1, ga]
    case OP.OP_CHECKMULTISIGVERIFY: return [0, ga]
    case OP.OP_RETURN:
    case OP.OP_CODESEPARATOR:
    case OP.OP_NOP1:
    case OP.OP_CHECKLOCKTIMEVERIFY:
    case OP.OP_CHECKSEQUENCEVERIFY:
    case OP.OP_NOP9:
    case OP.OP_NOP10:
      return [g, ga]
    default:
      if (c === TAIL) return [0, 0]
      if (c === DEAD) return [g, ga] // pushes OP_0, pops it, runs nothing else
      return [Math.max(g - 3, 0), ga]
  }
}

// Returns { regions: [{ start, end, g, ga }], barriers: [index] }.
function analyze (ops, opts = {}) {
  const regions = []
  const barriers = []
  const frames = []
  const I = new Interner()
  let g = 0
  let ga = 0
  let start = 0
  let st = new SymState(I, opts)
  const close = end => {
    regions.push({ start, end, g, ga })
    const gEnd = Math.max(g, st.D) + (st.main.length - st.D)
    const gaEnd = Math.max(ga, st.A) + (st.alt.length - st.A)
    return [gEnd, gaEnd]
  }
  for (let i = 0; i < ops.length; i++) {
    if (st.step(ops[i])) continue
    const [ge, gae] = close(i)
    barriers.push(i);
    [g, ga] = barrierEffect(ops[i], ge, gae, frames)
    start = i + 1
    st = new SymState(I, opts)
  }
  close(ops.length)
  return { regions, barriers }
}

// Marks, with `keep: true`, the pushes whose value nothing uses: no operation
// takes it as an operand, and it is not left on the stack for code after its
// region. Such a push only carries data (a protocol tag, a content hash, a
// document), so removing it would not change what the script does but would
// lose what the output was for. A region is treated as carrying data when one
// of its unused pushes is at least `minBytes` long; then every unused push in
// it is kept. A kept push is a barrier, left byte for byte by every pass and
// by the proof. Returns the number of pushes marked.
function markUnusedData (ops, { minBytes = 2, chronicle = true } = {}) {
  const { regions } = analyze(ops, { chronicle })
  let marked = 0
  for (const r of regions) {
    const I = new Interner()
    const st = new SymState(I, { chronicle, trackUses: true })
    for (let i = r.start; i < r.end; i++) st.step(ops[i])
    const live = new Set([...st.uses, ...st.main, ...st.alt])
    const unused = []
    for (let i = r.start; i < r.end; i++) {
      const op = ops[i]
      if (isPush(op) && !op.keep && !live.has(I.konst(pushValue(op)))) unused.push(op)
    }
    // A region carrying data keeps all of it, one-byte fields and empty pushes
    // included: those are as much a part of a protocol's payload as the rest.
    if (!unused.some(op => pushValue(op).length >= minBytes)) continue
    for (const op of unused) { op.keep = true; marked++ }
  }
  return marked
}

// Guaranteed main/alt heights before each op of a region, given its entry guarantee.
function heights (ops, g, ga, opts = {}) {
  const I = new Interner()
  const st = new SymState(I, opts)
  const hm = new Array(ops.length + 1)
  const ha = new Array(ops.length + 1)
  for (let i = 0; i <= ops.length; i++) {
    hm[i] = Math.max(g, st.D) + (st.main.length - st.D)
    ha[i] = Math.max(ga, st.A) + (st.alt.length - st.A)
    if (i < ops.length && !st.step(ops[i])) throw new Error('heights: op outside a modelled region at ' + i)
  }
  return { hm, ha }
}

module.exports = { analyze, heights, markUnusedData }
