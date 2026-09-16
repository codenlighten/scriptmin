'use strict'

const { OP, TAIL, isPush, pushValue, pushOp, opSize, opsSize, parse, encode, toBuffer } = require('./script')
const { equivalent } = require('./symbolic')
const { analyze, heights } = require('./analysis')
const { peephole } = require('./peephole')
const { windowsRegion } = require('./windows')
const { rescheduleFragment } = require('./schedule')
const { Cache, StackTable } = require('./superopt')
const { proveEquivalent, differential } = require('./verify')
const { profile } = require('./profile')

const EFFORT = {
  low: { window: 4, tableCost: 4, maxExpand: 0, rounds: 1, chunks: [Infinity, 64] },
  medium: { window: 6, tableCost: 5, maxExpand: 1500, rounds: 2, chunks: [Infinity, 256, 64, 16] },
  high: { window: 8, tableCost: 6, maxExpand: 5000, searchAll: true, rounds: 4, chunks: [Infinity, 512, 256, 128, 64, 32, 16, 8] }
}

const tables = new Map()
function tableFor (cost) {
  if (!tables.has(cost)) tables.set(cost, new StackTable({ maxCost: cost }))
  return tables.get(cost)
}

function schedulePass (ops, g, ga, cfg) {
  const { hm, ha } = heights(ops, g, ga, cfg)
  let best = ops
  let bestLog = []
  if (ops.length < 3) return { ops, rewrites: [] }
  for (const K of cfg.chunks) {
    const cand = []
    const log = []
    let pos = 0
    while (pos < ops.length) {
      let end = Math.min(ops.length, pos + K)
      while (end < ops.length && isPush(ops[end - 1])) end++
      const chunk = ops.slice(pos, end)
      const r = chunk.length >= 3 ? rescheduleFragment(chunk, hm[pos], ha[pos], cfg) : null
      if (r && opsSize(r) < opsSize(chunk)) {
        cand.push(...r)
        log.push({ pass: 'stack-scheduling', index: pos, before: chunk, after: r, saved: opsSize(chunk) - opsSize(r) })
      } else {
        cand.push(...chunk)
      }
      pos = end
    }
    if (opsSize(cand) < opsSize(best)) { best = cand; bestLog = log }
  }
  return { ops: best, rewrites: bestLog }
}

function optimizeRegion (ops, g, ga, cache, cfg) {
  let cur = ops
  let log = []
  const take = res => { cur = res.ops; log = log.concat(res.rewrites) }
  take(peephole(cur, g, ga, cfg))
  for (let round = 0; round < cfg.rounds; round++) {
    const before = opsSize(cur)
    if (cfg.schedule !== false) take(schedulePass(cur, g, ga, cfg))
    take(peephole(cur, g, ga, cfg))
    if (cfg.superopt !== false) take(windowsRegion(cur, g, ga, cache, cfg))
    take(peephole(cur, g, ga, cfg))
    if (opsSize(cur) >= before) break
  }
  if (!equivalent(ops, cur, g, ga, cfg)) {
    return { ops, rewrites: [], reverted: true }
  }
  return { ops: cur, rewrites: log }
}

function normalizePushes (ops) {
  const rewrites = []
  const out = ops.map((op, index) => {
    if (op.code === TAIL || !isPush(op)) return op
    const min = pushOp(pushValue(op))
    if (opSize(min) >= opSize(op)) return op
    rewrites.push({ pass: 'push-encoding', index, before: [op], after: [min], saved: opSize(op) - opSize(min) })
    return min
  })
  return { ops: out, rewrites }
}

function warningsFor (ops) {
  const w = []
  const has = codes => ops.some(o => codes.includes(o.code))
  if (has([OP.OP_CHECKSIG, OP.OP_CHECKSIGVERIFY, OP.OP_CHECKMULTISIG, OP.OP_CHECKMULTISIGVERIFY])) {
    w.push('The script checks signatures. Signatures commit to the script code, so they (and any OP_PUSH_TX preimage) must be produced against the optimized script. Covenants that embed their own script hash, length or bytes must be regenerated from it.')
  }
  if (has([OP.OP_CODESEPARATOR])) {
    w.push('OP_CODESEPARATOR present: the signed script code after each separator changes with optimization.')
  }
  if (has([OP.OP_SUBSTR, OP.OP_LEFT, OP.OP_RIGHT, OP.OP_LSHIFTNUM, OP.OP_RSHIFTNUM])) {
    w.push('Chronicle opcodes were modelled with their post-Chronicle stack effects (pass --no-chronicle to treat them as barriers).')
  }
  return w
}

// optimize(script, options) -> { script: Buffer, ops, report }
function optimize (input, options = {}) {
  const t0 = Date.now()
  const cfg = Object.assign({}, EFFORT[options.effort || 'medium'], options)
  cfg.chronicle = options.chronicle !== false
  const cache = options.cache || new Cache({ table: tableFor(cfg.tableCost) })
  if (!cache.table) cache.table = tableFor(cfg.tableCost)
  cfg.cache = cache
  const buf = toBuffer(input)
  const original = parse(buf)

  let rewrites = []
  let ops = original
  if (cfg.pushes !== false) {
    const res = normalizePushes(ops)
    ops = res.ops
    rewrites = rewrites.concat(res.rewrites)
  }

  // Byte offset of each original op, for the explanation.
  const offsets = []
  let off = 0
  for (const op of original) { offsets.push(off); off += opSize(op) }

  const { regions, barriers } = analyze(ops, cfg)
  const out = []
  let cursor = 0
  let reverted = 0
  for (const r of regions) {
    while (cursor < r.start) out.push(ops[cursor++])
    const regionOps = ops.slice(r.start, r.end)
    if (regionOps.length) {
      const res = optimizeRegion(regionOps, r.g, r.ga, cache, cfg)
      if (res.reverted) reverted++
      for (const rw of res.rewrites) {
        rw.regionOffset = offsets[r.start] === undefined ? off : offsets[r.start]
        rewrites.push(rw)
      }
      out.push(...res.ops)
    }
    cursor = r.end
  }
  while (cursor < ops.length) out.push(ops[cursor++])

  const script = encode(out)
  const verification = { symbolic: null, differential: null }
  if (cfg.verify !== false) {
    const proof = proveEquivalent(original, out, cfg)
    verification.symbolic = proof
    if (!proof.ok) {
      const err = new Error('internal error: optimized script failed the equivalence proof: ' + proof.reason)
      err.proof = proof
      throw err
    }
  }
  if (cfg.differential !== 0 && cfg.differential !== false) {
    const diff = differential(buf, script, { runs: typeof cfg.differential === 'number' ? cfg.differential : 100, stacks: cfg.stacks || [] })
    verification.differential = diff
    if (!diff.ok) {
      const err = new Error('internal error: optimized script disagrees with the original on a test input')
      err.diff = diff
      throw err
    }
  }

  // Savings by what the bytes were doing, from profiles of both scripts.
  const pa = profile(original, { ngrams: 0 })
  const pb = profile(out, { ngrams: 0 })
  const byCategory = pa.categories.map(c => {
    const d = pb.categories.find(x => x.name === c.name)
    return { name: c.name, before: c.bytes, after: d ? d.bytes : 0, saved: c.bytes - (d ? d.bytes : 0) }
  })
  for (const c of pb.categories) {
    if (!pa.categories.find(x => x.name === c.name)) byCategory.push({ name: c.name, before: 0, after: c.bytes, saved: -c.bytes })
  }
  byCategory.sort((x, y) => y.saved - x.saved)

  const passes = {}
  for (const rw of rewrites) passes[rw.pass] = (passes[rw.pass] || 0) + rw.saved
  const before = buf.length
  const after = script.length
  return {
    script,
    ops: out,
    report: {
      original: { bytes: before, ops: original.length },
      optimized: { bytes: after, ops: out.length },
      saved: before - after,
      reductionPct: before ? (100 * (before - after)) / before : 0,
      byCategory,
      passes: Object.entries(passes).sort((x, y) => y[1] - x[1]).map(([name, saved]) => ({ name, saved })),
      rewrites,
      regions: regions.length,
      barriers: barriers.length,
      reverted,
      verification,
      cache: { hits: cache.hits, entries: cache.added, searches: cache.searches },
      warnings: warningsFor(original),
      ms: Date.now() - t0
    }
  }
}

module.exports = { optimize, profile: (input, o) => profile(parse(toBuffer(input)), o), EFFORT, Cache }
