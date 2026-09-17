'use strict'

// Superoptimizes short windows of pure stack code (stack ops, pushes and
// operations on constants): computes each window's stack transformation, asks
// the search for the cheapest equivalent, then picks the best non-overlapping
// set of replacements by dynamic programming.

const { OP, isPush, pushValue, opsSize, opSize, encode } = require('./script')
const { decodeNum } = require('./num')
const { Interner, SymState, SPECS, STACK_OPS, COMPOSITE, equivalent } = require('./symbolic')
const { heights } = require('./analysis')

function eligible (op) {
  return isPush(op) || STACK_OPS.has(op.code) || !!SPECS[op.code] || !!COMPOSITE[op.code] ||
    op.code === OP.OP_1ADD || op.code === OP.OP_1SUB
}

// Build the search problem for a window, or null if it is not a pure stack transformation.
function problemFor (win, g, ga, opts) {
  const I = new Interner()
  const st = new SymState(I, opts)
  const trace = []
  const maxDepth = opts.maxWindowDepth || 64
  for (let j = 0; j < win.length; j++) {
    const op = win[j]
    if ((op.code === OP.OP_PICK || op.code === OP.OP_ROLL) && j > 0 && isPush(win[j - 1])) {
      const n = decodeNum(pushValue(win[j - 1]), 4)
      if (n !== null && n >= BigInt(maxDepth)) return { stop: true, problem: null }
    }
    if (!st.step(op)) return { stop: true, problem: null }
    if (st.events.size) return { stop: true, problem: null }
    trace.push([st.main.length, st.D, st.alt.length, st.A])
  }
  const D = st.D
  const A = st.A
  let maxLen = D
  let maxAlt = A
  for (const [len, d, alen, a] of trace) {
    maxLen = Math.max(maxLen, len + D - d)
    maxAlt = Math.max(maxAlt, alen + A - a)
  }
  const sym = id => {
    const info = I.info[id]
    if (info.kind === 'in') return info.index
    if (info.kind === 'alt') return D + info.index
    return null
  }
  const consts = new Map()
  const constSym = new Map()
  const map = id => {
    const s = sym(id)
    if (s !== null) return s
    if (!I.isConst(id)) return null
    if (!constSym.has(id)) {
      const k = D + A + constSym.size
      constSym.set(id, k)
      consts.set(k, I.constBuf(id))
    }
    return constSym.get(id)
  }
  const target = st.main.map(map)
  const targetAlt = st.alt.map(map)
  if (target.includes(null) || targetAlt.includes(null)) return { stop: false, problem: null }
  const start = []
  for (let i = D - 1; i >= 0; i--) start.push(i)
  const startAlt = []
  for (let i = A - 1; i >= 0; i--) startAlt.push(D + i)
  return {
    stop: false,
    problem: {
      start, startAlt, target, targetAlt, consts,
      maxLen: Math.max(maxLen, target.length),
      maxAlt: Math.max(maxAlt, targetAlt.length),
      touch: D > g,
      touchAlt: A > ga,
      allowAlt: st.usedAlt
    }
  }
}

function windowsRegion (ops, g, ga, cache, opts = {}) {
  const W = opts.window || 6
  const maxExpand = opts.maxExpand ?? 20000
  const tableN = cache.table ? cache.table.N : 0
  opts = Object.assign({}, opts, { maxWindowDepth: opts.searchAll ? 64 : Math.max(tableN, 8) })
  const { hm, ha } = heights(ops, g, ga, opts)
  const n = ops.length
  const cands = Array.from({ length: n }, () => [])

  for (let i = 0; i < n; i++) {
    if (!eligible(ops[i])) continue
    let size = 0
    for (let len = 1; len <= W && i + len <= n; len++) {
      const op = ops[i + len - 1]
      if (!eligible(op)) break
      size += opSize(op)
      if (size < 2 && !(len === 1 && op.code === OP.OP_NOP)) continue
      const win = ops.slice(i, i + len)
      const { stop, problem } = problemFor(win, hm[i], ha[i], opts)
      if (stop) break
      if (!problem) continue
      problem.bound = size
      problem.g = hm[i]
      problem.maxExpand = maxExpand
      // Pure stack shuffles with constants are left to the table unless effort
      // allows open-ended search; folding and alt-stack windows always search.
      // The A* search's cost grows with the stack it starts from, while its
      // wins do not: on real scripts every replacement it finds starts from a
      // stack of at most ~16 items, and the deeper searches only run out their
      // budget. Past that depth the window is left to the table.
      problem.tableOnly = problem.start.length > (opts.searchMaxDepth ?? 16) || (!opts.searchAll && (
        (!win.some(o => !isPush(o) && !STACK_OPS.has(o.code)) && !problem.allowAlt && !!problem.consts.size) ||
        problem.start.length > tableN))
      // The window's bytes plus the facts that constrain its replacement
      // determine the answer, so they make a compact, reusable key.
      const key = encode(win).toString('hex') + '|' + (problem.touch ? 1 : 0) + (problem.touchAlt ? 1 : 0) +
        '|' + Math.min(tableN, Math.max(problem.start.length, hm[i])) + '|' + (problem.tableOnly ? 1 : 0) +
        '|' + (cache.table ? cache.table.maxCost : 0) + '/' + maxExpand
      const r = cache.solve(problem, key)
      if (!r || r.cost >= size) continue
      if (!equivalent(win, r.ops, hm[i], ha[i], opts)) continue
      cands[i].push({ len, ops: r.ops, cost: r.cost })
    }
  }

  const best = new Array(n + 1).fill(0)
  const choice = new Array(n).fill(null)
  for (let i = n - 1; i >= 0; i--) {
    best[i] = opSize(ops[i]) + best[i + 1]
    for (const c of cands[i]) {
      if (c.cost + best[i + c.len] < best[i]) {
        best[i] = c.cost + best[i + c.len]
        choice[i] = c
      }
    }
  }
  const out = []
  const rewrites = []
  for (let i = 0; i < n;) {
    const c = choice[i]
    if (!c) { out.push(ops[i++]); continue }
    const before = ops.slice(i, i + c.len)
    const folded = before.some(o => !isPush(o) && !STACK_OPS.has(o.code))
    rewrites.push({ pass: folded ? 'constant-folding' : 'superoptimizer', index: i, before, after: c.ops, saved: opsSize(before) - c.cost })
    out.push(...c.ops)
    i += c.len
  }
  return { ops: out, rewrites }
}

module.exports = { windowsRegion, problemFor }
