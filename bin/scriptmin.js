#!/usr/bin/env node
'use strict'

const fs = require('fs')

// Output piped into something that stops reading (| head) is not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e })
const path = require('path')
const { optimize, profile, Cache, toAsm, toBuffer } = require('../src')
const { parse } = require('../src/script')
const { StackTable } = require('../src/superopt')
const { EFFORT } = require('../src/optimize')

const USAGE = `scriptmin — Bitcoin Script minimizer

Usage:
  scriptmin [options] <script-file | ->
  scriptmin compile [options] <circuit.json>

"compile" builds a script from a prime-field circuit (see README) with lazy
modular reduction, stack-optimizes it, and checks it against the circuit.
Compile options: --max-bits <n> (default 1024), --tests <n> (default 20),
-o, --asm, --json, --effort.

  scriptmin relax --modulus <p> [options] <script-file>

"relax" lifts a field-arithmetic script (OP_ADD, OP_SUB, OP_MUL, OP_MOD by p,
input range checks) back to its circuit and recompiles it with lazy reduction.
Relax options: --max-bits <n> (default 768), --modulus-input (take p from the
stack instead of pushing it), --tests <n>, -o, --json.

Input is hex, ASM (bsv format), or raw bytes (--binary). "-" reads stdin.

Options:
  -o, --out <file>        write the optimized script (hex, or ASM with --asm, raw with --binary)
  --asm                   write ASM instead of hex
  --binary                read and write raw bytes
  --profile               print a byte profile of the input and exit
  --explain               list every rewrite applied
  --explain-limit <n>     rewrites to list (default 50, 0 = all)
  --json                  print the report as JSON
  --effort <level>        low | medium | high (default medium)
  --db <file>             pattern database: load known solutions, save new ones
  --tests <n>             differential interpreter runs (default 100, 0 = off)
  --stacks <file>         JSON array of starting stacks (arrays of hex) to test against
  --no-verify             skip the symbolic equivalence proof (not recommended)
  --no-chronicle          treat Chronicle opcodes (OP_SUBSTR, OP_LEFT, ...) as barriers
  -h, --help              show this help
`

function parseArgs (argv) {
  const a = { effort: 'medium', explainLimit: 50, tests: 100 }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => { if (i + 1 >= argv.length) die(`${x} needs a value`); return argv[++i] }
    switch (x) {
      case '-o': case '--out': a.out = next(); break
      case '--asm': a.asm = true; break
      case '--binary': a.binary = true; break
      case '--profile': a.profile = true; break
      case '--explain': a.explain = true; break
      case '--explain-limit': a.explainLimit = Number(next()); break
      case '--json': a.json = true; break
      case '--effort': a.effort = next(); break
      case '--db': a.db = next(); break
      case '--tests': a.tests = Number(next()); break
      case '--stacks': a.stacks = next(); break
      case '--no-verify': a.verify = false; break
      case '--no-chronicle': a.chronicle = false; break
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break
      default:
        if (x.startsWith('-') && x !== '-') die(`unknown option ${x}`)
        if (a.file) die('only one input file')
        a.file = x
    }
  }
  if (!a.file) { process.stdout.write(USAGE); process.exit(1) }
  if (!EFFORT[a.effort]) die(`unknown effort "${a.effort}"`)
  return a
}

function die (msg) {
  process.stderr.write(`scriptmin: ${msg}\n`)
  process.exit(2)
}

const fmt = n => n.toLocaleString('en-US')
const clip = (text, ops, width = 150) => (text.length <= width ? text : `${text.slice(0, width)}… (${fmt(ops)} ops)`)
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)

function readInput (a) {
  const raw = a.file === '-' ? fs.readFileSync(0) : fs.readFileSync(a.file)
  if (a.binary) return raw
  try {
    return toBuffer(raw.toString('utf8'))
  } catch (e) {
    die(`could not parse input as hex or ASM: ${e.message}`)
  }
}

function printProfile (p) {
  const out = []
  out.push(`${fmt(p.bytes)} bytes, ${fmt(p.ops)} ops`, '')
  for (const c of p.categories) out.push(`  ${pad(c.name, 24)} ${lpad(fmt(c.bytes), 12)}  ${lpad(c.pct.toFixed(2), 6)}%`)
  out.push('', 'Top opcodes by bytes:')
  for (const o of p.opcodes.slice(0, 12)) out.push(`  ${pad(o.name, 24)} ${lpad(fmt(o.count), 10)} ops ${lpad(fmt(o.bytes), 12)} bytes`)
  out.push('', 'PICK/ROLL depths (constant indices):')
  out.push(`  ${pad('depth', 10)} ${lpad('PICK', 10)} ${lpad('ROLL', 10)}`)
  p.depths.buckets.forEach((b, i) => out.push(`  ${pad(b, 10)} ${lpad(fmt(p.depths.PICK[i]), 10)} ${lpad(fmt(p.depths.ROLL[i]), 10)}`))
  if (p.patterns.length) {
    out.push('', 'Most expensive repeated patterns:')
    for (const g of p.patterns) out.push(`  ${lpad(fmt(g.bytes), 10)} bytes ${lpad(fmt(g.count), 8)}x  ${g.pattern}`)
  }
  return out.join('\n') + '\n'
}

function printReport (r, a) {
  const out = []
  out.push(`Original:   ${lpad(fmt(r.original.bytes), 12)} bytes`)
  out.push(`Minimized:  ${lpad(fmt(r.optimized.bytes), 12)} bytes`)
  out.push(`Saved:      ${lpad(fmt(r.saved), 12)} bytes`)
  out.push(`Reduction:  ${lpad(r.reductionPct.toFixed(2), 11)}%`)
  if (r.passes.length) {
    out.push('', 'Breakdown:')
    for (const p of r.passes) out.push(`  ${pad(p.name, 22)} ${lpad('-' + fmt(p.saved), 12)}`)
  }
  const moved = r.byCategory.filter(c => c.saved !== 0)
  if (moved.length) {
    out.push('', 'By what the bytes were doing:')
    for (const c of moved) out.push(`  ${pad(c.name, 22)} ${lpad(fmt(c.before), 12)} -> ${lpad(fmt(c.after), 12)}  (${c.saved > 0 ? '-' : '+'}${fmt(Math.abs(c.saved))})`)
  }
  const v = r.verification
  out.push('', 'Verification:')
  out.push(`  symbolic proof         ${v.symbolic ? (v.symbolic.ok ? `passed (${v.symbolic.regions} regions, ${v.symbolic.barriers} barriers)` : 'FAILED') : 'skipped'}`)
  out.push(`  interpreter tests      ${v.differential ? `passed (${v.differential.runs} runs, ${v.differential.succeeded} ran to success)` : 'skipped'}`)
  if (r.reverted) out.push(`  note: ${r.reverted} region(s) left unoptimized after a failed local check`)
  for (const w of r.warnings) out.push('', 'Warning: ' + w)
  if (a.explain) {
    out.push('', 'Rewrites:')
    const list = r.rewrites.slice().sort((x, y) => y.saved - x.saved)
    const shown = a.explainLimit ? list.slice(0, a.explainLimit) : list
    for (const rw of shown) {
      out.push(`  [${rw.pass}${rw.rule ? ': ' + rw.rule : ''}] -${rw.saved} bytes (region @${rw.regionOffset ?? 0})`)
      out.push(`      ${clip(toAsm(rw.before, { maxData: 8 }), rw.before.length)}`)
      out.push(`   => ${clip(toAsm(rw.after, { maxData: 8 }), rw.after.length) || '(nothing)'}`)
    }
    if (shown.length < list.length) out.push(`  ... ${list.length - shown.length} more (--explain-limit 0 for all)`)
  }
  out.push('', `(${r.ms} ms)`)
  return out.join('\n') + '\n'
}

function compileMain (argv) {
  const a = { maxBits: 1024, tests: 20, effort: 'medium' }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => { if (i + 1 >= argv.length) die(`${x} needs a value`); return argv[++i] }
    if (x === '--max-bits') a.maxBits = Number(next())
    else if (x === '--tests') a.tests = Number(next())
    else if (x === '-o' || x === '--out') a.out = next()
    else if (x === '--asm') a.asm = true
    else if (x === '--json') a.json = true
    else if (x === '--effort') a.effort = next()
    else if (x.startsWith('-')) die(`unknown option ${x}`)
    else a.file = x
  }
  if (!a.file) die('compile needs a circuit file')
  const { compileField } = require('../src/field')
  let res
  try {
    res = compileField(JSON.parse(fs.readFileSync(a.file, 'utf8')), { maxBits: a.maxBits, tests: a.tests, optimizeOptions: { effort: a.effort } })
  } catch (e) {
    die(e.message)
  }
  if (a.out) fs.writeFileSync(a.out, a.asm ? toAsm(parse(res.script)) + '\n' : res.script.toString('hex') + '\n')
  const r = res.report
  if (a.json) {
    process.stdout.write(JSON.stringify({ script: res.script.toString('hex'), gates: r.gates, maxBits: r.maxBits, bytes: r.optimized, referenceBytes: r.reference, checked: r.checked, ms: r.ms }, null, 2) + '\n')
  } else {
    const out = []
    out.push(`Gates:                    ${lpad(fmt(r.gates), 10)}`)
    out.push(`Reduce every operation:   ${lpad(fmt(r.reference), 10)} bytes (stack-optimized)`)
    out.push(`Lazy reduction (${r.maxBits} bits): ${lpad(fmt(r.optimized), 10)} bytes`)
    out.push(`Saved by lazy reduction:  ${lpad(fmt(r.reference - r.optimized), 10)} bytes (${(100 * (r.reference - r.optimized) / r.reference).toFixed(2)}%)`)
    out.push('', `Checked against the circuit on ${r.checked} input vectors (all zeros, all p-1, random).`)
    out.push(`Stack optimization of the lazy program: ${r.stack.verification.symbolic.ok ? 'proof passed' : 'proof skipped'}.`)
    out.push('', `(${r.ms} ms)`)
    process.stdout.write(out.join('\n') + '\n')
    if (!a.out) process.stdout.write('\n' + res.script.toString('hex') + '\n')
  }
}

function relaxMain (argv) {
  const a = { maxBits: 768, tests: 32 }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    const next = () => { if (i + 1 >= argv.length) die(`${x} needs a value`); return argv[++i] }
    if (x === '--modulus') a.modulus = next()
    else if (x === '--max-bits') a.maxBits = Number(next())
    else if (x === '--modulus-input') a.modulusInput = true
    else if (x === '--tests') a.tests = Number(next())
    else if (x === '-o' || x === '--out') a.out = next()
    else if (x === '--json') a.json = true
    else if (x.startsWith('-')) die(`unknown option ${x}`)
    else a.file = x
  }
  if (!a.file || !a.modulus) die('relax needs a script file and --modulus')
  const { relax } = require('../src/relax')
  let res
  try {
    res = relax(readInput({ file: a.file }), { modulus: BigInt(a.modulus), maxBits: a.maxBits, modulusInput: a.modulusInput, tests: a.tests })
  } catch (e) {
    die(e.message)
  }
  if (a.out) fs.writeFileSync(a.out, res.script.toString('hex') + '\n')
  const r = res.report
  if (a.json) {
    process.stdout.write(JSON.stringify(Object.assign({ script: res.script.toString('hex') }, r), (k, v) => (typeof v === 'bigint' ? String(v) : v), 2) + '\n')
    return
  }
  const out = []
  out.push(`Original:  ${lpad(fmt(r.original.bytes), 10)} bytes, ${fmt(r.original.mod)} OP_MOD`)
  out.push(`Relaxed:   ${lpad(fmt(r.relaxed.bytes), 10)} bytes, ${fmt(r.relaxed.mod)} OP_MOD  (reductions only where values outgrow ${r.maxBits} bits or must be canonical)`)
  out.push('', `Circuit: ${r.inputs} inputs, ${r.gates} gates, ${r.outputs} outputs, ${r.bounds} input range checks kept.`)
  out.push(`Equal to the original on ${r.checked} canonical input vectors; both refuse ${r.refusalsChecked} out-of-range ones.`)
  if (r.modulusInput) out.push('The relaxed script takes p as one more input, on top.')
  process.stdout.write(out.join('\n') + '\n')
  if (!a.out) process.stdout.write('\n' + res.script.toString('hex') + '\n')
}

function main () {
  if (process.argv[2] === 'compile') return compileMain(process.argv.slice(3))
  if (process.argv[2] === 'relax') return relaxMain(process.argv.slice(3))
  const a = parseArgs(process.argv.slice(2))
  const buf = readInput(a)

  if (a.profile) {
    const p = profile(buf)
    process.stdout.write(a.json ? JSON.stringify(p, null, 2) + '\n' : printProfile(p))
    return
  }

  let cache
  if (a.db) {
    let entries
    if (fs.existsSync(a.db)) {
      const j = JSON.parse(fs.readFileSync(a.db, 'utf8'))
      if (j.version !== 1) die(`unsupported pattern database version in ${a.db}`)
      entries = j.entries
    }
    cache = new Cache({ entries, table: new StackTable({ maxCost: EFFORT[a.effort].tableCost }) })
  }

  let stacks = []
  if (a.stacks) stacks = JSON.parse(fs.readFileSync(a.stacks, 'utf8')).map(s => s.map(h => Buffer.from(h, 'hex')))

  let res
  try {
    res = optimize(buf, {
      effort: a.effort,
      cache,
      verify: a.verify,
      chronicle: a.chronicle,
      differential: a.tests,
      stacks
    })
  } catch (e) {
    process.stderr.write(`scriptmin: ${e.message}\n`)
    if (e.proof) process.stderr.write(JSON.stringify(e.proof, null, 2) + '\n')
    if (e.diff) process.stderr.write(JSON.stringify(e.diff, null, 2) + '\n')
    process.exit(3)
  }

  if (a.db && cache) fs.writeFileSync(a.db, JSON.stringify(cache.toJSON()))

  if (a.out) {
    const data = a.binary ? res.script : a.asm ? toAsm(parse(res.script)) + '\n' : res.script.toString('hex') + '\n'
    fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true })
    fs.writeFileSync(a.out, data)
  }

  if (a.json) {
    const r = Object.assign({}, res.report, {
      rewrites: res.report.rewrites.map(rw => Object.assign({}, rw, { before: toAsm(rw.before), after: toAsm(rw.after) })),
      script: res.script.toString('hex')
    })
    process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  } else {
    process.stdout.write(printReport(res.report, a))
    if (!a.out) process.stdout.write('\n' + res.script.toString('hex') + '\n')
  }
}

main()
