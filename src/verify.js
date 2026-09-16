'use strict'

const crypto = require('crypto')
const bsv = require('@smartledger/bsv')
const { sameOp, encode, toAsm } = require('./script')
const { Interner, run, statesEquivalent } = require('./symbolic')
const { analyze } = require('./analysis')
const { encodeNum } = require('./num')

// Proves `optimized` equivalent to `original` region by region. Both scripts
// must have identical barrier sequences, and each pair of regions must be
// symbolically equivalent under the stack guarantees computed on the original.
function proveEquivalent (original, optimized, opts = {}) {
  const a = analyze(original, opts)
  const b = analyze(optimized, opts)
  if (a.barriers.length !== b.barriers.length) {
    return { ok: false, reason: `barrier count differs (${a.barriers.length} vs ${b.barriers.length})` }
  }
  for (let k = 0; k < a.barriers.length; k++) {
    if (!sameOp(original[a.barriers[k]], optimized[b.barriers[k]])) {
      return { ok: false, reason: `barrier ${k} differs` }
    }
  }
  for (let k = 0; k < a.regions.length; k++) {
    const ra = a.regions[k]
    const rb = b.regions[k]
    const I = new Interner()
    const sa = run(original.slice(ra.start, ra.end), I, opts)
    const sb = run(optimized.slice(rb.start, rb.end), I, opts)
    if (!sa || !sb || !statesEquivalent(sa, sb, ra.g, ra.ga)) {
      return {
        ok: false,
        reason: `region ${k} not equivalent`,
        region: k,
        before: toAsm(original.slice(ra.start, ra.end), { maxData: 8 }),
        after: toAsm(optimized.slice(rb.start, rb.end), { maxData: 8 })
      }
    }
  }
  return { ok: true, regions: a.regions.length, barriers: a.barriers.length }
}

// --- differential testing against the real interpreter ----------------------

const Interpreter = bsv.Script.Interpreter

// Large elements are compared by digest: scripts can build elements too big to hex-encode.
function show (b) {
  return b.length <= 256 ? b.toString('hex') : `sha256:${crypto.createHash('sha256').update(b).digest('hex')}:${b.length}`
}

function evaluate (scriptBuf, stack, flags) {
  const interp = new Interpreter()
  let script
  try {
    // A private copy: the interpreter's OP_INVERT/OP_AND/OP_OR/OP_XOR modify
    // pushed data in place, and pushed data aliases the script's bytes.
    script = bsv.Script.fromBuffer(Buffer.from(scriptBuf))
  } catch (e) {
    return { ok: false, err: 'unparseable script', stack: [], alt: [] }
  }
  interp.set({
    script,
    stack: stack.map(b => Buffer.from(b)),
    altstack: [],
    flags
  })
  let ok
  try {
    ok = interp.evaluate()
  } catch (e) {
    ok = false
  }
  return {
    ok,
    err: interp.errstr,
    stack: interp.stack.map(show),
    alt: interp.altstack.map(show)
  }
}

function randomElement (rnd) {
  const r = rnd() % 10
  if (r < 5) return encodeNum(BigInt((rnd() % 41) - 20))
  if (r < 7) return encodeNum(BigInt(rnd() % 100000) * (rnd() % 2 ? 1n : -1n))
  if (r < 8) return Buffer.from([1])
  return crypto.randomBytes(rnd() % 40)
}

// Runs both scripts on random starting stacks (and any supplied ones) and
// compares success, final stack and final alt stack. Failures are compared
// only as failures: an optimized script may fail at a different op.
function differential (originalBuf, optimizedBuf, { runs = 200, maxDepth = 12, stacks = [], flags } = {}) {
  flags = flags === undefined ? Interpreter.currentConsensusFlags() : flags
  const rnd = () => crypto.randomBytes(4).readUInt32LE(0)
  const inputs = stacks.slice()
  for (let i = 0; i < runs; i++) {
    const depth = rnd() % (maxDepth + 1)
    const st = []
    for (let j = 0; j < depth; j++) {
      st.push(j > 0 && rnd() % 6 === 0 ? st[rnd() % j] : randomElement(rnd))
    }
    inputs.push(st)
  }
  let succeeded = 0
  for (const st of inputs) {
    const x = evaluate(originalBuf, st, flags)
    const y = evaluate(optimizedBuf, st, flags)
    const same = x.ok === y.ok && (!x.ok || (x.stack.join() === y.stack.join() && x.alt.join() === y.alt.join()))
    if (!same) {
      return { ok: false, runs: inputs.length, succeeded, counterexample: st.map(b => b.toString('hex')), original: x, optimized: y }
    }
    if (x.ok) succeeded++
  }
  return { ok: true, runs: inputs.length, succeeded }
}

module.exports = { proveEquivalent, differential, evaluate, encode }
