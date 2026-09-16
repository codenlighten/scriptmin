'use strict'

// Stack-sequence superoptimizer.
//
// Given a start stack and a target stack over abstract symbols, find the
// cheapest (in serialized bytes) sequence of stack ops and constant pushes that
// turns one into the other. A* over stack states with an admissible heuristic:
// every missing copy costs at least a third of a byte (OP_3DUP makes three) and
// every surplus item at least half a byte (OP_2DROP removes two).

const { OP, numOp, opSize, pushOp } = require('./script')

function numCost (n) { return opSize(numOp(n)) }

const DEEP = []
function deepMove (n) {
  while (DEEP.length <= n) {
    const k = DEEP.length
    const c = numCost(k) + 1
    DEEP.push({ cost: c, pick: [numOp(k), { code: OP.OP_PICK }], roll: [numOp(k), { code: OP.OP_ROLL }] })
  }
  return DEEP[n]
}

// [code, items required, transform(stack) -> stack]
const FIXED = [
  [OP.OP_DUP, 1, s => { s.push(s[s.length - 1]) }],
  [OP.OP_DROP, 1, s => { s.pop() }],
  [OP.OP_SWAP, 2, s => { const l = s.length; const t = s[l - 1]; s[l - 1] = s[l - 2]; s[l - 2] = t }],
  [OP.OP_OVER, 2, s => { s.push(s[s.length - 2]) }],
  [OP.OP_ROT, 3, s => { s.push(s.splice(s.length - 3, 1)[0]) }],
  [OP.OP_NIP, 2, s => { s.splice(s.length - 2, 1) }],
  [OP.OP_TUCK, 2, s => { s.splice(s.length - 2, 0, s[s.length - 1]) }],
  [OP.OP_2DUP, 2, s => { s.push(s[s.length - 2], s[s.length - 1]) }],
  [OP.OP_2DROP, 2, s => { s.length -= 2 }],
  [OP.OP_3DUP, 3, s => { s.push(s[s.length - 3], s[s.length - 2], s[s.length - 1]) }],
  [OP.OP_2OVER, 4, s => { s.push(s[s.length - 4], s[s.length - 3]) }],
  [OP.OP_2ROT, 6, s => { s.push(...s.splice(s.length - 6, 2)) }],
  [OP.OP_2SWAP, 4, s => { s.push(...s.splice(s.length - 4, 2)) }]
]

class BucketQueue {
  constructor () { this.buckets = []; this.min = 0; this.size = 0 }
  push (f, x) {
    (this.buckets[f] || (this.buckets[f] = [])).push(x)
    if (f < this.min) this.min = f
    this.size++
  }

  pop () {
    while (this.min < this.buckets.length) {
      const b = this.buckets[this.min]
      if (b && b.length) { this.size--; return b.pop() }
      this.min++
    }
    return undefined
  }
}

// problem: {
//   start, startAlt, target, targetAlt: arrays of small non-negative ints
//   consts: Map<symbol, Buffer>   symbols that may be pushed fresh
//   bound: only solutions strictly cheaper than this are returned
//   maxLen, maxAlt: height limits
//   touch, touchAlt: the solution must consume the whole start stack at some point
//                    (so it underflows on exactly the inputs the original did)
//   maxExpand: search budget
// }
// returns { ops, cost } or null
function search (p) {
  const nsym = 1 + Math.max(-1, ...p.start, ...p.startAlt, ...p.target, ...p.targetAlt, ...p.consts.keys())
  const need = new Int32Array(nsym)
  for (const x of p.target) need[x]++
  for (const x of p.targetAlt) need[x]++
  const useAlt = p.startAlt.length > 0 || p.targetAlt.length > 0 || p.allowAlt
  const targetKey = p.target.join(',') + '|' + p.targetAlt.join(',')
  const constList = [...p.consts.entries()].map(([sym, buf]) => [sym, pushOp(buf)])
  const have = new Int32Array(nsym)

  const h = (main, alt) => {
    have.fill(0)
    for (const x of main) have[x]++
    for (const x of alt) have[x]++
    let missing = 0
    let surplus = 0
    for (let s = 0; s < nsym; s++) {
      if (have[s] < need[s]) {
        if (have[s] === 0 && !p.consts.has(s)) return Infinity
        missing += need[s] - have[s]
      } else surplus += have[s] - need[s]
    }
    return Math.max(Math.ceil(missing / 3), Math.ceil(surplus / 2))
  }

  const isGoal = st =>
    (!p.touch || st.t) && (!p.touchAlt || st.ta) &&
    st.main.length === p.target.length && st.alt.length === p.targetAlt.length &&
    (st.main.join(',') + '|' + st.alt.join(',')) === targetKey

  const keyOf = st => st.main.join(',') + '|' + st.alt.join(',') + '|' + (st.t ? 1 : 0) + (st.ta ? 1 : 0)

  const root = { main: p.start.slice(), alt: p.startAlt.slice(), t: p.start.length === 0, ta: p.startAlt.length === 0, g: 0, parent: null, op: null }
  const best = new Map()
  const q = new BucketQueue()
  const h0 = h(root.main, root.alt)
  if (h0 >= p.bound) return null
  q.push(h0, root)
  best.set(keyOf(root), 0)
  let expanded = 0

  while (q.size) {
    const st = q.pop()
    if (best.get(keyOf(st)) < st.g) continue
    if (isGoal(st)) {
      const ops = []
      for (let n = st; n.parent; n = n.parent) ops.push(...n.op.slice().reverse())
      return { ops: ops.reverse(), cost: st.g }
    }
    if (++expanded > p.maxExpand) return null

    const L = st.main.length
    const consider = (main, alt, cost, ops, touched, touchedAlt) => {
      const g = st.g + cost
      if (g >= p.bound || main.length > p.maxLen || alt.length > p.maxAlt) return
      const hh = h(main, alt)
      if (g + hh >= p.bound) return
      // A move that produces a non-goal state still costs at least one more byte.
      const child = { main, alt, t: touched, ta: touchedAlt, g, parent: st, op: ops }
      const k = keyOf(child)
      const prev = best.get(k)
      if (prev !== undefined && prev <= g) return
      best.set(k, g)
      q.push(g + hh, child)
    }

    for (const [code, k, fn] of FIXED) {
      if (k > L) continue
      const m = st.main.slice()
      fn(m)
      consider(m, st.alt, 1, [{ code }], st.t || k === L, st.ta)
    }
    for (let n = 2; n < L; n++) {
      const mv = deepMove(n)
      const m = st.main.slice()
      m.push(m[L - 1 - n])
      consider(m, st.alt, mv.cost, mv.pick, st.t || n + 1 === L, st.ta)
    }
    for (let n = 3; n < L; n++) {
      const mv = deepMove(n)
      const m = st.main.slice()
      const v = m.splice(L - 1 - n, 1)[0]
      m.push(v)
      consider(m, st.alt, mv.cost, mv.roll, st.t || n + 1 === L, st.ta)
    }
    for (const [sym, op] of constList) {
      let c = 0
      for (const x of st.main) if (x === sym) c++
      for (const x of st.alt) if (x === sym) c++
      if (c >= need[sym]) continue
      const m = st.main.slice()
      m.push(sym)
      consider(m, st.alt, opSize(op), [op], st.t, st.ta)
    }
    if (useAlt) {
      if (L >= 1) {
        const m = st.main.slice()
        const a = st.alt.slice()
        a.push(m.pop())
        consider(m, a, 1, [{ code: OP.OP_TOALTSTACK }], st.t || L === 1, st.ta)
      }
      if (st.alt.length >= 1) {
        const m = st.main.slice()
        const a = st.alt.slice()
        m.push(a.pop())
        consider(m, a, 1, [{ code: OP.OP_FROMALTSTACK }], st.t, st.ta || st.alt.length === 1)
      }
    }
  }
  return null
}

// Memoizes solutions by transformation. Consults the exhaustive table first;
// A* only runs for what the table cannot answer (constants, alt stack, deep
// windows, or replacements longer than the table's cost limit).
class Cache {
  constructor ({ entries, table } = {}) {
    this.map = new Map(entries || [])
    this.table = table || null
    this.added = 0
    this.hits = 0
    this.searches = 0
  }

  static key (p) {
    const consts = [...p.consts.entries()].map(([s, b]) => s + '=' + b.toString('hex')).join(';')
    return [p.start, p.startAlt, p.target, p.targetAlt].map(x => x.join(',')).join('|') +
      `|${consts}|${p.bound}|${p.maxLen}|${p.maxAlt}|${p.touch ? 1 : 0}${p.touchAlt ? 1 : 0}|${p.allowAlt ? 1 : 0}|${Math.min(p.g || 0, 64)}|${p.tableOnly ? 1 : 0}`
  }

  solve (p, key) {
    const k = key || Cache.key(p)
    if (this.map.has(k)) {
      this.hits++
      const v = this.map.get(k)
      return v && { ops: v.ops.map(o => (o.data ? { code: o.code, data: Buffer.from(o.data, 'hex') } : { code: o.code })), cost: v.cost }
    }
    let r = null
    const t = this.table
    const tableable = t && t.applicable(p)
    if (tableable) r = t.lookup(p)
    if (!r && !(tableable && p.bound - 1 <= t.maxCost) && p.maxExpand > 0 && !p.tableOnly) {
      this.searches++
      r = search(p)
    }
    this.map.set(k, r && { ops: r.ops.map(o => (o.data ? { code: o.code, data: o.data.toString('hex') } : { code: o.code })), cost: r.cost })
    this.added++
    return r
  }

  toJSON () {
    return { version: 1, entries: [...this.map.entries()] }
  }
}

module.exports = { search, Cache }

// Exhaustive table of short stack-op sequences.
//
// Enumerates every sequence of pure stack ops (no constants, no alt stack)
// up to `maxCost` bytes over N symbolic inputs, cheapest first, and records
// for each resulting stack (and each depth the sequence reaches) the cheapest
// sequence producing it. A window lookup is then a map probe.
class StackTable {
  constructor ({ N = 6, maxCost = 4, maxLen = 9 } = {}) {
    this.N = N
    this.maxCost = maxCost
    this.map = new Map()
    const t0 = Date.now()
    this._build(maxLen)
    this.ms = Date.now() - t0
  }

  _build (maxLen) {
    const N = this.N
    const moves = []
    for (const [code, k, fn] of FIXED) moves.push({ ops: [{ code }], cost: 1, k, fn })
    for (let n = 2; n < maxLen; n++) {
      moves.push({ ops: [numOp(n), { code: OP.OP_PICK }], cost: numCost(n) + 1, k: n + 1, fn: s => { s.push(s[s.length - 1 - n]) } })
    }
    for (let n = 3; n < maxLen; n++) {
      moves.push({ ops: [numOp(n), { code: OP.OP_ROLL }], cost: numCost(n) + 1, k: n + 1, fn: s => { s.push(s.splice(s.length - 1 - n, 1)[0]) } })
    }
    const startMain = []
    for (let i = N - 1; i >= 0; i--) startMain.push(i)
    const seen = new Set()
    let frontier = [[{ main: startMain, t: 0, seq: [] }]]
    const buckets = frontier
    for (let cost = 0; cost <= this.maxCost; cost++) {
      const bucket = buckets[cost] || []
      for (const st of bucket) {
        const key = st.main.join(',') + '|' + st.t
        if (seen.has(key)) continue
        seen.add(key)
        this.map.set(key, { cost, seq: st.seq })
        const L = st.main.length
        for (let mi = 0; mi < moves.length; mi++) {
          const mv = moves[mi]
          if (mv.k > L) continue
          const c = cost + mv.cost
          if (c > this.maxCost) continue
          const main = st.main.slice()
          mv.fn(main)
          if (main.length > maxLen) continue
          const t = Math.max(st.t, mv.k + N - L)
          if (t > N) continue
          ;(buckets[c] || (buckets[c] = [])).push({ main, t, seq: st.seq.concat(mi) })
        }
      }
      buckets[cost] = null
    }
    this.moves = moves
    frontier = null
  }

  // p: a problem as built for search(). The start stack must hold distinct
  // symbols; it is relabelled onto the table's inputs. Returns { ops, cost } or null.
  applicable (p) {
    if (p.start.length > this.N || p.startAlt.length || p.targetAlt.length || p.consts.size || p.allowAlt) return false
    return new Set(p.start).size === p.start.length
  }

  lookup (p) {
    if (!this.applicable(p)) return null
    const D = p.start.length
    const label = new Map()
    p.start.forEach((x, j) => label.set(x, D - 1 - j))
    const full = []
    for (let i = this.N - 1; i >= D; i--) full.push(i)
    for (const x of p.target) {
      if (!label.has(x)) return null
      full.push(label.get(x))
    }
    const base = full.join(',') + '|'
    let best = null
    const lo = p.touch ? D : 0
    const hi = p.touch ? D : Math.min(this.N, Math.max(D, p.g || 0))
    for (let t = lo; t <= hi; t++) {
      const e = this.map.get(base + t)
      if (e && e.cost < p.bound && (!best || e.cost < best.cost)) best = e
    }
    if (!best) return null
    const ops = []
    for (const mi of best.seq) for (const o of this.moves[mi].ops) ops.push(o.data ? { code: o.code, data: o.data } : { code: o.code })
    return { ops, cost: best.cost }
  }
}

module.exports.StackTable = StackTable
