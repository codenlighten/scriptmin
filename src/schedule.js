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

const { OP, numOp, pushOp, pushCost, opSize, opsSize } = require('./script')
const { Interner, run, equivalent } = require('./symbolic')
const { search } = require('./superopt')
const { peephole } = require('./peephole')

const pickOps = d => (d === 0 ? [{ code: OP.OP_DUP }] : d === 1 ? [{ code: OP.OP_OVER }] : [numOp(d), { code: OP.OP_PICK }])
const rollOps = d => (d === 0 ? [] : d === 1 ? [{ code: OP.OP_SWAP }] : d === 2 ? [{ code: OP.OP_ROT }] : [numOp(d), { code: OP.OP_ROLL }])

// Per value, the ordered timeline of uses (+1) and supplies (-1) still ahead:
// operation inputs are uses, operation outputs (including values coming back
// from the alt stack) are supplies, the final stack is uses. need(x) is how
// many copies must be kept on the main stack right now so no future use
// finds x missing: the largest excess of uses over supplies over any prefix
// of the remaining timeline.
class Liveness {
  constructor (apps, needed, F) {
    const deltas = new Map()
    const add = (x, d) => { let a = deltas.get(x); if (!a) deltas.set(x, a = []); a.push(d) }
    for (let j = 0; j < apps.length; j++) {
      if (!needed[j]) continue
      for (const x of apps[j].inputs) add(x, 1)
      for (const o of apps[j].outputs) add(o, -1)
    }
    for (const x of F) add(x, 1)
    this.tl = new Map()
    for (const [x, ds] of deltas) {
      const m = ds.length
      const P = new Int32Array(m + 1)
      for (let i = 0; i < m; i++) P[i + 1] = P[i] + ds[i]
      const suf = new Int32Array(m + 2)
      suf[m + 1] = -0x7fffffff
      for (let i = m; i >= 0; i--) suf[i] = Math.max(P[i], suf[i + 1])
      this.tl.set(x, { P, suf })
    }
    this.ptr = new Map()
  }

  need (x, ahead = 0) {
    const t = this.tl.get(x)
    if (!t) return 0
    const p = (this.ptr.get(x) || 0) + ahead
    if (p >= t.P.length - 1) return 0
    return Math.max(0, t.suf[p + 1] - t.P[p])
  }

  advance (x) { this.ptr.set(x, (this.ptr.get(x) || 0) + 1) }

  clone () {
    const c = Object.create(Liveness.prototype)
    c.tl = this.tl
    c.ptr = new Map(this.ptr)
    return c
  }
}

class Machine {
  constructor (I, S, live) {
    this.I = I
    this.S = S
    this.live = live
    this.cnt = new Map()
    for (const x of S) this.cnt.set(x, (this.cnt.get(x) || 0) + 1)
    this.out = []
    this.maxLen = S.length
    this.bytes = 0
    this.budget = Infinity
  }

  clone () {
    const m = new Machine(this.I, this.S.slice(), this.live.clone())
    m.bytes = this.bytes
    m.budget = this.budget
    return m
  }

  cheap (id) { return this.I.isConst(id) && pushCost(this.I.constBuf(id)) <= 2 }
  count (id) { return this.cnt.get(id) || 0 }
  push (id) {
    this.S.push(id)
    this.cnt.set(id, this.count(id) + 1)
    if (this.S.length > this.maxLen) this.maxLen = this.S.length
  }
  removeAt (q) { const id = this.S.splice(q, 1)[0]; this.cnt.set(id, this.count(id) - 1); return id }
  // A schedule is only used when it is smaller than the fragment it replaces.
  // Giving up once it is far past that keeps deep stacks (a constant ROLL
  // index in the tens of thousands) from turning finish() quadratic.
  emit (ops) {
    for (const o of ops) { this.out.push(o); this.bytes += opSize(o) }
    if (this.bytes > this.budget) throw new Error('scheduler: over budget')
  }

  excess (id) { return this.count(id) > this.live.need(id) }

  stage (order) {
    let staged = 0
    const S = this.S
    for (const x of order) {
      this.live.advance(x)
      const need = this.live.need(x)
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
      if (copies - 1 >= need) {
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
  stageCost (order) {
    const S = this.S
    const removed = new Set()
    const staged = []
    const ahead = new Map()
    const removedOf = new Map()
    let cost = 0
    for (const x of order) {
      ahead.set(x, (ahead.get(x) || 0) + 1)
      const need = this.live.need(x, ahead.get(x))
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
      if (copies - 1 >= need) {
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
    // Hoisting: a value that sits deep but is still needed several times is
    // rolled to the top once, so its next uses are cheap shallow copies
    // instead of repeated deep PICKs.
    const hoisted = []
    if (this.hoist) {
      for (const x of new Set(app.inputs)) {
        if (this.I.isConst(x) && this.cheap(x)) continue
        if (this.live.need(x) < this.hoist.minUses) continue
        let q = -1
        for (let i = this.S.length - 1; i >= 0; i--) if (this.S[i] === x) { q = i; break }
        if (q < 0 || this.S.length - 1 - q < this.hoist.minDepth) continue
        hoisted.push(x)
      }
    }
    this.hoistValues(hoisted)
    let order = app.inputs
    if (app.comm && app.inputs.length === 2 && app.inputs[0] !== app.inputs[1]) {
      const alt = [app.inputs[1], app.inputs[0]]
      if (this.stageCost(alt) < this.stageCost(order)) order = alt
    }
    this.applyOrdered(app, order)
  }

  hoistValues (xs) {
    for (const x of xs) {
      let q = -1
      for (let i = this.S.length - 1; i >= 0; i--) if (this.S[i] === x) { q = i; break }
      if (q < 0) continue
      this.emit(rollOps(this.S.length - 1 - q))
      this.S.splice(q, 1)
      this.S.push(x)
    }
  }

  applyOrdered (app, order) {
    // Large constants with more than one remaining use are pushed once, before
    // staging, so later uses can copy them.
    for (const x of new Set(order)) {
      if (this.I.isConst(x) && !this.cheap(x) && this.count(x) === 0 && this.live.need(x) > 1) {
        this.emit([pushOp(this.I.constBuf(x))])
        this.push(x)
      }
    }
    this.stage(order)
    for (let j = 0; j < app.inputs.length; j++) this.removeAt(this.S.length - 1)
    for (const o of app.outputs) { this.push(o); this.live.advance(o) }
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
    const small = tailS.length <= 6 && tailF.length <= 7
    const generic = this.clone()
    generic.out = []
    // A short tail is searched for below, which may beat the generic arrangement.
    if (small) generic.budget = Infinity
    generic.arrange(F, prefix)
    let ops = generic.out
    if (small) {
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

// Beam search over the scheduler's own decisions. The greedy Machine picks,
// per operation, an operand order and whether to hoist, looking no further
// than that operation. This keeps the `width` cheapest partial schedules,
// scored by bytes emitted plus a lookahead estimate of what fetching the next
// few operations' operands will cost from the resulting stack.
// Every partial schedule in the beam has processed the same operations, so
// their liveness pointers are identical at the start of a step. They share one
// base and record only what the current operation advances.
class LiveView {
  constructor (base) {
    this.base = base
    this.local = new Map()
  }

  pos (x) {
    const l = this.local.get(x)
    return l !== undefined ? l : (this.base.ptr.get(x) || 0)
  }

  need (x, ahead = 0) {
    const t = this.base.tl.get(x)
    if (!t) return 0
    const p = this.pos(x) + ahead
    if (p >= t.P.length - 1) return 0
    return Math.max(0, t.suf[p + 1] - t.P[p])
  }

  advance (x) { this.local.set(x, this.pos(x) + 1) }

  clone () {
    const c = new LiveView(this.base)
    c.local = new Map(this.local)
    return c
  }
}

class BeamMachine extends Machine {
  constructor (I, S, live, tail = null, bytes = 0) {
    super(I, S, live)
    this.tail = tail
    this.bytes = bytes
  }

  emit (ops) {
    if (!ops.length) return
    this.tail = { ops, prev: this.tail }
    this.bytes += opsSize(ops)
  }

  clone () {
    return new BeamMachine(this.I, this.S.slice(), this.live.clone(), this.tail, this.bytes)
  }

  ops () {
    const parts = []
    for (let t = this.tail; t; t = t.prev) parts.push(t.ops)
    const out = []
    for (let i = parts.length - 1; i >= 0; i--) for (const o of parts[i]) out.push(o)
    return out
  }

  // Estimated bytes to bring the operands of `apps` to the top from here.
  lookahead (apps) {
    let h = 0
    const S = this.S
    for (const app of apps) {
      for (const x of app.inputs) {
        if (this.cheap(x)) { h += pushCost(this.I.constBuf(x)); continue }
        let d = -1
        for (let i = S.length - 1; i >= 0; i--) if (S[i] === x) { d = S.length - 1 - i; break }
        if (d < 0) { h += 1; continue } // produced later, arrives near the top
        h += d <= 1 ? 1 : d <= 16 ? 2 : 3
      }
    }
    return h
  }
}

function hotValue (m, app, next, minFreq) {
  const freq = new Map()
  for (const a of next) for (const x of a.inputs) if (!m.cheap(x)) freq.set(x, (freq.get(x) || 0) + 1)
  let hot = null
  for (const [x, f] of freq) if (f >= minFreq && m.count(x) > 0 && !app.inputs.includes(x) && (!hot || f > freq.get(hot))) hot = x
  if (hot === null) return null
  let d = -1
  for (let i = m.S.length - 1; i >= 0; i--) if (m.S[i] === hot) { d = m.S.length - 1 - i; break }
  return d >= 1 ? hot : null
}

function choicesFor (m, app, next) {
  const orders = [app.inputs]
  if (app.comm && app.inputs.length === 2 && app.inputs[0] !== app.inputs[1]) orders.push([app.inputs[1], app.inputs[0]])
  const hoists = [[]]
  for (const x of new Set(app.inputs)) {
    if (m.cheap(x) || m.count(x) === 0) continue
    let d = -1
    for (let i = m.S.length - 1; i >= 0; i--) if (m.S[i] === x) { d = m.S.length - 1 - i; break }
    if (d >= 2) hoists.push([x])
  }
  // The value the next few operations need most, if it is not an input here:
  // rolling it up now lets this operation's result land above it.
  const hot = hotValue(m, app, next, 2)
  if (hot !== null) hoists.push([hot])
  const out = []
  for (const h of hoists) for (const o of orders) out.push({ hoist: h, order: o })
  return out
}

function beamSchedule (I, S0, live, apps, needed, F, opts) {
  const width = opts.beam
  const L = opts.lookahead || 4
  const seq = []
  for (let j = 0; j < apps.length; j++) if (needed[j]) seq.push(apps[j])
  const base = live.clone()
  const root = new BeamMachine(I, S0.slice(), new LiveView(base))
  root.cleanup()
  let beam = [root]
  for (let k = 0; k < seq.length; k++) {
    const app = seq[k]
    const next = seq.slice(k + 1, k + 1 + L)
    const seen = new Map()
    for (const m of beam) {
      m.live = new LiveView(base)
      for (const choice of choicesFor(m, app, next)) {
        const c = m.clone()
        c.hoistValues(choice.hoist)
        c.applyOrdered(app, choice.order)
        const key = c.S.join(',')
        const prev = seen.get(key)
        if (!prev || c.bytes < prev.bytes) seen.set(key, c)
      }
    }
    const scored = [...seen.values()].map((c) => ({ c, score: c.bytes + c.lookahead(next) }))
    scored.sort((a, b) => a.score - b.score || a.c.bytes - b.c.bytes)
    beam = scored.slice(0, width).map((x) => x.c)
    // Advance the shared pointers exactly as every candidate just did.
    for (const x of app.inputs) base.advance(x)
    for (const o of app.outputs) base.advance(o)
  }
  for (const m of beam) m.live = new LiveView(base)
  let best = null
  for (const m of beam) {
    const plain = new Machine(I, m.S.slice(), m.live.clone())
    plain.out = m.ops()
    plain.bytes = m.bytes
    plain.budget = budgetFor(opts)
    try {
      plain.finish(F, opts)
    } catch (e) {
      if (opts.debug && !/over budget/.test(e.message)) throw e
      continue
    }
    if (!best || opsSize(plain.out) < opsSize(best)) best = plain.out
  }
  return best
}

// Reschedules one fragment. Returns new ops or null.
function rescheduleFragment (ops, g, ga, opts = {}) {
  const I = new Interner()
  const st = run(ops, I, Object.assign({}, opts, { record: true }))
  if (!st) return null
  const F = st.main
  const recorded = st.apps
  // Variant with common subexpression elimination: an operation whose
  // results were all produced earlier is dropped, and liveness keeps the
  // earlier results alive until their last use.
  const seen = new Set()
  const deduped = recorded.filter(a => {
    if (a.pinned) return true
    const fresh = a.outputs.length === 0
      ? !seen.has('v' + a.inputs.join(',') + ':' + a.code)
      : a.outputs.some((o, idx) => !(a.passthrough && idx === 0) && !seen.has(o))
    for (const o of a.outputs) seen.add(o)
    if (a.outputs.length === 0) seen.add('v' + a.inputs.join(',') + ':' + a.code)
    return fresh
  })
  const appLists = deduped.length < recorded.length && opts.cse !== false ? [recorded, deduped] : [recorded]
  // Variant without the alt stack: when the fragment neither reads alt-stack
  // values it did not push nor leaves anything there, its alt moves only
  // transport values, and the scheduler can keep those values on the main
  // stack instead of paying two bytes per round trip.
  if (st.usedAlt && st.A === 0 && st.alt.length === 0 && opts.altElimination !== false) {
    const isAlt = a => a.code === OP.OP_TOALTSTACK || a.code === OP.OP_FROMALTSTACK
    for (const list of appLists.slice()) appLists.push(list.filter(a => !isAlt(a)))
  }
  let best = null
  const scheduleOpts = Object.assign({}, opts, { budget: 2 * opsSize(ops) + 16 })
  for (const apps of appLists) {
    const r = scheduleApps(I, st.D, apps, F, scheduleOpts)
    if (r && (!best || opsSize(r) < opsSize(best))) best = r
  }
  if (!best) return null

  const out = peephole(best, g, ga, opts).ops
  if (!equivalent(ops, out, g, ga, opts)) return null
  return out
}

function scheduleApps (I, D, apps, F, opts) {

  const uses = new Map()
  const inc = x => uses.set(x, (uses.get(x) || 0) + 1)
  for (const x of F) inc(x)
  const needed = new Array(apps.length).fill(false)
  for (let j = apps.length - 1; j >= 0; j--) {
    const a = apps[j]
    const used = a.outputs.some((o, idx) => !(a.passthrough && idx === 0) && (uses.get(o) || 0) > 0)
    if (a.event || a.pinned || used) {
      needed[j] = true
      for (const x of a.inputs) inc(x)
    }
  }

  const S0 = []
  for (let i = D - 1; i >= 0; i--) S0.push(I.input(i))
  const live = new Liveness(apps, needed, F)
  let best = null
  let maxLen = 0
  for (const hoist of opts.hoistVariants || HOIST_VARIANTS) {
    const mach = new Machine(I, S0.slice(), live.clone())
    mach.budget = budgetFor(opts)
    mach.hoist = hoist
    try {
      mach.cleanup()
      for (let j = 0; j < apps.length; j++) if (needed[j]) mach.apply(apps[j])
      mach.finish(F, opts)
    } catch (e) {
      // An inconsistency here means a missed case in the scheduler, never a
      // wrong script: the fragment is simply left as it was.
      if (opts.debug && !/over budget/.test(e.message)) throw e
      continue
    }
    if (!best || opsSize(mach.out) < opsSize(best)) best = mach.out
    maxLen = Math.max(maxLen, mach.maxLen)
  }
  // The beam copies and scans the stack for every candidate at every step, so
  // its cost grows with stack depth. Generated field code stays shallow (the
  // BLS12-381 final exponentiation peaks near 500 items); code that keeps
  // thousands of values live gets the greedy schedule.
  if (opts.beam && maxLen <= (opts.beamMaxStack || 640)) {
    if (opts.stats) opts.stats.beamRuns = (opts.stats.beamRuns || 0) + 1
    try {
      const b = beamSchedule(I, S0, live, apps, needed, F, opts)
      if (b && (!best || opsSize(b) < opsSize(best))) best = b
    } catch (e) {
      if (opts.debug) throw e
    }
  }
  return best
}

// Bytes a schedule may emit before it is abandoned: peephole runs afterwards,
// so allow room above the size it has to beat.
const budgetFor = opts => opts.budget ?? Infinity

// Scheduling is greedy, so it runs once per hoisting policy and keeps the smallest.
const HOIST_VARIANTS = [null, { minUses: 3, minDepth: 17 }, { minUses: 6, minDepth: 17 }, { minUses: 10, minDepth: 17 }]

module.exports = { rescheduleFragment }
