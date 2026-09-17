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
  // Before @smartledger/bsv 9.10.1 the interpreter's bitwise ops wrote into
  // their operands, which could corrupt the shared Interpreter.true/false for
  // every later evaluation in the process. Reset them so one run cannot affect
  // the next, whatever version a host project has installed.
  Interpreter.true = Buffer.from([1])
  Interpreter.false = Buffer.alloc(0)
  const interp = new Interpreter()
  let script
  try {
    // A private copy: before 9.10.1, OP_INVERT/OP_AND/OP_OR/OP_XOR modified
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

// Consensus flags for the eras a script is checked in. Chronicle changes what
// some opcodes do (OP_VERIF and OP_VERNOTIF in an unexecuted branch, OP_2MUL,
// OP_SUBSTR, ...), so a script optimized without assuming Chronicle is checked
// under the rules before it as well.
function eraFlags ({ chronicle = true } = {}) {
  const current = Interpreter.currentConsensusFlags()
  if (chronicle) return [current]
  return [current, current & ~(Interpreter.SCRIPT_UTXO_AFTER_CHRONICLE | Interpreter.SCRIPT_ENABLE_CHRONICLE)]
}

// Runs both scripts on random starting stacks (and any supplied ones) and
// compares success, final stack and final alt stack. Failures are compared
// only as failures: an optimized script may fail at a different op. `flags`
// may be a list of flag sets, one per era; the first era that disagrees is
// returned with its counterexample.
function differential (originalBuf, optimizedBuf, { runs = 200, maxDepth = 12, stacks = [], flags } = {}) {
  if (Array.isArray(flags)) {
    let total = 0
    let succeeded = 0
    for (const f of flags) {
      const d = differential(originalBuf, optimizedBuf, { runs, maxDepth, stacks, flags: f })
      if (!d.ok) return Object.assign(d, { flags: f })
      total += d.runs
      succeeded += d.succeeded
    }
    return { ok: true, runs: total, succeeded, eras: flags.length }
  }
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

module.exports = { proveEquivalent, differential, evaluate, encode, eraFlags }
