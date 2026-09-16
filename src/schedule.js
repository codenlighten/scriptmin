'use strict'

// Stack scheduler.
//
// Lifts a fragment to its dataflow (the ordered operations it evaluates, and
// the stack it must leave behind), then re-emits the stack choreography from
// scratch using liveness:
//   - an operand whose value is needed again is copied (PICK/OVER/DUP),
//     otherwise its last copy is moved (ROLL/ROT/SWAP) instead of copied
//     and dropped later;
//   - values that become dead are dropped as soon as they surface;
//   - operations that cannot fail and whose results are never used are not
//     emitted at all;
//   - operand order of commutative operations is chosen by cost;
//   - large constants are pushed once and then copied, small ones are pushed
//     at each use.
// The result is only kept if it is smaller and symbolically equivalent.

const { OP, numOp, pushOp, pushCost, opsSize } = require('./script')
const { Interner, run, equivalent } = require('./symbolic')
const { search } = require('./superopt')
const { peephole } = require('./peephole')

const pickOps = d => (d === 0 ? [{ code: OP.OP_DUP }] : d === 1 ? [{ code: OP.OP_OVER }] : [numOp(d), { code: OP.OP_PICK }])
const rollOps = d => (d === 0 ? [] : d === 1 ? [{ code: OP.OP_SWAP }] : d === 2 ? [{ code: OP.OP_ROT }] : [numOp(d), { code: OP.OP_ROLL }])

class Machine {
  constructor (I, S, pending) {
    this.I = I
    this.S = S
    this.pending = pending
    this.cnt = new Map()
    for (const x of S) this.cnt.set(x, (this.cnt.get(x) || 0) + 1)
    this.out = []
  }

  clone () {
    const m = new Machine(this.I, this.S.slice(), new Map(this.pending))
    return m
  }

  cheap (id) { return this.I.isConst(id) && pushCost(this.I.constBuf(id)) <= 2 }
  count (id) { return this.cnt.get(id) || 0 }
  push (id) { this.S.push(id); this.cnt.set(id, this.count(id) + 1) }
  removeAt (q) { const id = this.S.splice(q, 1)[0]; this.cnt.set(id, this.count(id) - 1); return id }
  emit (ops) { for (const o of ops) this.out.push(o) }
  excess (id) { return this.count(id) > (this.pending.get(id) || 0) }

  stage (order, passthrough) {
    let staged = 0
    const S = this.S
    for (const x of order) {
      const pend = (this.pending.get(x) || 0) - 1
      this.pending.set(x, pend)
      if (this.cheap(x)) {
        this.emit([pushOp(this.I.constBuf(x))])
        this.push(x)
        staged++
        continue
      }
      let p = -1
      for (let q = S.length - 1 - staged; q >= 0; q--) if (S[q] === x) { p = q; break }
      if (p < 0) {
        if (!this.I.isConst(x)) throw new Error('scheduler: operand not on stack')
        this.emit([pushOp(this.I.constBuf(x))])
        this.push(x)
        staged++
        continue
      }
      let inStaged = 0
      for (let q = S.length - staged; q < S.length; q++) if (S[q] === x) inStaged++
      const copies = this.count(x) - inStaged
      const d = S.length - 1 - p
      if (copies - 1 + (passthrough ? 1 : 0) >= pend) {
        let trivial = true
        for (let q = p + 1; q < S.length && trivial; q++) trivial = S[q] === x
        if (!trivial) {
          this.emit(rollOps(d))
          S.splice(p, 1)
          S.push(x)
        }
      } else {
        this.emit(pickOps(d))
        this.push(x)
      }
      staged++
    }
  }

  // Byte cost of stage(order) without performing it.
  stageCost (order, passthrough) {
    const S = this.S
    const removed = new Set()
    const staged = []
    const pendDelta = new Map()
    const removedOf = new Map()
    let cost = 0
    for (const x of order) {
      const pend = (this.pending.get(x) || 0) + (pendDelta.get(x) || 0) - 1
      pendDelta.set(x, (pendDelta.get(x) || 0) - 1)
      if (this.cheap(x)) { cost += pushCost(this.I.constBuf(x)); staged.push(x); continue }
      let p = -1
      let above = 0
      for (let q = S.length - 1; q >= 0; q--) {
        if (removed.has(q)) continue
        if (S[q] === x) { p = q; break }
        above++
      }
      if (p < 0) { cost += pushCost(this.I.constBuf(x)); staged.push(x); continue }
      const d = above + staged.length
      const copies = this.count(x) - (removedOf.get(x) || 0)
      if (copies - 1 + (passthrough ? 1 : 0) >= pend) {
        let trivial = above === 0
        for (const y of staged) trivial = trivial && y === x
        if (!trivial) cost += opsSize(rollOps(d))
        removed.add(p)
        removedOf.set(x, (removedOf.get(x) || 0) + 1)
      } else {
        cost += opsSize(pickOps(d))
      }
      staged.push(x)
    }
    return cost
  }

  cleanup () {
    for (;;) {
      const L = this.S.length
      if (L >= 1 && this.excess(this.S[L - 1])) { this.emit([{ code: OP.OP_DROP }]); this.removeAt(L - 1); continue }
      if (L >= 2 && this.excess(this.S[L - 2])) { this.emit([{ code: OP.OP_NIP }]); this.removeAt(L - 2); continue }
      break
    }
  }

  apply (app) {
    let order = app.inputs
    if (app.comm && app.inputs.length === 2 && app.inputs[0] !== app.inputs[1]) {
      const alt = [app.inputs[1], app.inputs[0]]
      if (this.stageCost(alt, app.passthrough) < this.stageCost(order, app.passthrough)) order = alt
    }
    // Large constants with more than one remaining use are pushed once, before
    // staging, so later uses can copy them.
    for (const x of new Set(order)) {
      if (this.I.isConst(x) && !this.cheap(x) && this.count(x) === 0 && (this.pending.get(x) || 0) > 1) {
        this.emit([pushOp(this.I.constBuf(x))])
        this.push(x)
      }
    }
    this.stage(order, app.passthrough)
    for (let j = 0; j < app.inputs.length; j++) this.removeAt(this.S.length - 1)
    for (const o of app.outputs) this.push(o)
    this.emit([{ code: app.code }])
    this.cleanup()
  }

  finish (F, opts) {
    const S = this.S
    for (;;) {
      let q = -1
      for (let i = S.length - 1; i >= 0; i--) if (this.excess(S[i])) { q = i; break }
      if (q < 0) break
      const d = S.length - 1 - q
      this.emit(d === 0 ? [{ code: OP.OP_DROP }] : d === 1 ? [{ code: OP.OP_NIP }] : [numOp(d), { code: OP.OP_ROLL }, { code: OP.OP_DROP }])
      this.removeAt(q)
    }
    let prefix = 0
    while (prefix < S.length && prefix < F.length && S[prefix] === F[prefix]) prefix++
    if (prefix === S.length && prefix === F.length) return

    const tailS = S.slice(prefix)
    const tailF = F.slice(prefix)
    const generic = this.clone()
    generic.out = []
    generic.arrange(F, prefix)
    let ops = generic.out
    if (tailS.length <= 6 && tailF.length <= 7) {
      const sym = new Map()
      const symOf = id => { if (!sym.has(id)) sym.set(id, sym.size); return sym.get(id) }
      const start = tailS.map(symOf)
      const target = tailF.map(symOf)
      const consts = new Map()
      for (const id of tailF) if (this.I.isConst(id)) consts.set(symOf(id), this.I.constBuf(id))
      const problem = {
        start, startAlt: [], target, targetAlt: [], consts,
        bound: opsSize(ops), maxLen: Math.max(start.length, target.length) + 2, maxAlt: 0,
        touch: false, touchAlt: false, g: start.length, maxExpand: opts.maxExpand ?? 20000
      }
      const r = opts.cache ? opts.cache.solve(problem) : search(problem)
      if (r) ops = r.ops
    }
    this.emit(ops)
    this.S = F.slice()
  }

  arrange (F, prefix) {
    const S = this.S
    let placed = 0
    for (let k = prefix; k < F.length; k++) {
      const x = F[k]
      let stillNeeded = 0
      for (let j = k; j < F.length; j++) if (F[j] === x) stillNeeded++
      let loose = 0
      let q = -1
      for (let i = S.length - 1 - placed; i >= prefix; i--) {
        if (S[i] === x) { loose++; if (q < 0) q = i }
      }
      if (loose >= stillNeeded) {
        this.emit(rollOps(S.length - 1 - q))
        S.splice(q, 1)
        S.push(x)
      } else {
        // More copies are needed than are free to move: copy the shallowest one.
        let p = -1
        for (let i = S.length - 1; i >= 0; i--) if (S[i] === x) { p = i; break }
        if (p >= 0 && !(this.cheap(x))) this.emit(pickOps(S.length - 1 - p))
        else if (this.I.isConst(x)) this.emit([pushOp(this.I.constBuf(x))])
        else throw new Error('scheduler: value missing from final stack')
        S.push(x)
      }
      placed++
    }
  }
}

// Reschedules one fragment with no alt-stack use. Returns new ops or null.
function rescheduleFragment (ops, g, ga, opts = {}) {
  const I = new Interner()
  const st = run(ops, I, Object.assign({}, opts, { record: true }))
  if (!st || st.usedAlt) return null
  const F = st.main
  const apps = st.apps

  const uses = new Map()
  const inc = x => uses.set(x, (uses.get(x) || 0) + 1)
  for (const x of F) inc(x)
  const needed = new Array(apps.length).fill(false)
  for (let j = apps.length - 1; j >= 0; j--) {
    const a = apps[j]
    const used = a.outputs.some((o, idx) => !(a.passthrough && idx === 0) && (uses.get(o) || 0) > 0)
    if (a.event || used) {
      needed[j] = true
      for (const x of a.inputs) inc(x)
    }
  }

  const S = []
  for (let i = st.D - 1; i >= 0; i--) S.push(I.input(i))
  const mach = new Machine(I, S, uses)
  try {
    mach.cleanup()
    for (let j = 0; j < apps.length; j++) if (needed[j]) mach.apply(apps[j])
    mach.finish(F, opts)
  } catch (e) {
    // An inconsistency here means a missed case in the scheduler, never a
    // wrong script: the fragment is simply left as it was.
    if (opts.debug) throw e
    return null
  }

  const out = peephole(mach.out, g, ga, opts).ops
  if (!equivalent(ops, out, g, ga, opts)) return null
  return out
}

module.exports = { rescheduleFragment }
