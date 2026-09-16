'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { execFileSync } = require('child_process')
const { optimize, profile, Cache, toAsm, equivalent, proveEquivalent } = require('../src')
const { parse, encode, toBuffer, OP } = require('../src/script')
const { decodeNum, encodeNum } = require('../src/num')
const { StackTable } = require('../src/superopt')
const { equivalent: equivOps } = require('../src/symbolic')
const { randomCircuit, compileNaive } = require('../examples/naive-field-compiler')

const asm = r => toAsm(r.ops)
const opt = (s, o) => optimize(s, Object.assign({ differential: 50 }, o))

test('script numbers round-trip and reject non-minimal encodings', () => {
  for (const n of [0n, 1n, -1n, 127n, 128n, -128n, 255n, 256n, -255n, 2147483647n, -2147483647n]) {
    assert.strictEqual(decodeNum(encodeNum(n)), n)
  }
  assert.strictEqual(decodeNum(Buffer.from([0x00])), null)
  assert.strictEqual(decodeNum(Buffer.from([0x80])), null)
  assert.strictEqual(decodeNum(Buffer.from([0x05, 0x00])), null)
  assert.strictEqual(decodeNum(Buffer.from([0xff, 0x00])), 255n)
})

test('parse/encode round-trips every push form and keeps data after OP_RETURN verbatim', () => {
  const hex = '00' + '0102' + '4c03aabbcc' + '4d0200ddee' + '4e01000000ff' + '76' + '6a' + '4c' // truncated push after RETURN
  const buf = Buffer.from(hex, 'hex')
  const ops = parse(buf)
  assert.strictEqual(encode(ops).toString('hex'), hex)
  assert.strictEqual(ops[ops.length - 1].code, -1)
})

test('does not remove an op whose only effect is failing on a short stack', () => {
  assert.strictEqual(asm(opt('OP_DUP OP_DROP OP_1')), 'OP_DUP OP_DROP OP_1')
  assert.strictEqual(asm(opt('OP_1 OP_DUP OP_DROP')), 'OP_1')
  // Inside a branch the condition was consumed, so nothing is known to be left.
  assert.strictEqual(asm(opt('OP_IF OP_DUP OP_DROP OP_ENDIF OP_1')), 'OP_IF OP_DUP OP_DROP OP_ENDIF OP_1')
  assert.strictEqual(asm(opt('OP_2 OP_IF OP_DUP OP_DROP OP_ENDIF')), 'OP_2 OP_IF OP_DUP OP_DROP OP_ENDIF')
  assert.strictEqual(asm(opt('OP_2 OP_3 OP_IF OP_DUP OP_DROP OP_ENDIF')), 'OP_2 OP_3 OP_IF OP_ENDIF')
})

test('folds constants, including through verification', () => {
  assert.strictEqual(asm(opt('OP_3 OP_5 OP_ADD')), 'OP_8')
  assert.strictEqual(asm(opt('OP_DUP OP_3 OP_5 OP_ADD OP_8 OP_NUMEQUALVERIFY')), 'OP_DUP')
  // Division by zero always fails: it must stay.
  assert.match(asm(opt('OP_1 OP_1 OP_0 OP_DIV')), /OP_DIV/)
})

test('finds shorter stack sequences', () => {
  assert.strictEqual(asm(opt('OP_1 OP_PICK OP_1 OP_PICK')), 'OP_2DUP')
  assert.strictEqual(asm(opt('OP_3 OP_PICK OP_3 OP_PICK')), 'OP_2OVER')
  assert.strictEqual(asm(opt('OP_SWAP OP_ADD')), 'OP_ADD')
  assert.strictEqual(asm(opt('OP_SWAP OP_SUB')), 'OP_SWAP OP_SUB')
  assert.strictEqual(asm(opt('OP_EQUAL OP_VERIFY')), 'OP_EQUALVERIFY')
  assert.strictEqual(asm(opt('OP_1 OP_ADD')), 'OP_1ADD')
  assert.strictEqual(asm(opt('OP_TOALTSTACK OP_FROMALTSTACK')), 'OP_TOALTSTACK OP_FROMALTSTACK')
  assert.strictEqual(asm(opt('OP_1 OP_TOALTSTACK OP_FROMALTSTACK')), 'OP_1')
})

test('moves values at their last use instead of copying and dropping', () => {
  // [a b c] -> a*b, keeping nothing else.
  const r = opt('OP_2 OP_PICK OP_2 OP_PICK OP_MUL OP_3 OP_ROLL OP_DROP OP_2 OP_ROLL OP_DROP OP_NIP')
  assert.strictEqual(asm(r), 'OP_DROP OP_MUL')
})

test('removes unused results of operations that cannot fail, keeps ones that can', () => {
  assert.strictEqual(asm(opt('OP_7 OP_DUP OP_SHA256 OP_DROP')), 'OP_7')
  assert.strictEqual(asm(opt('OP_7 OP_DUP OP_SIZE OP_NIP OP_DROP')), 'OP_7')
  // With nothing known about the stack, the underflow check has to survive.
  assert.strictEqual(asm(opt('OP_DUP OP_SHA256 OP_DROP')), 'OP_DUP OP_DROP')
  assert.match(asm(opt('OP_7 OP_2DUP OP_ADD OP_DROP')), /OP_ADD/)
})

test('never touches barriers', () => {
  const s = 'OP_DUP OP_DROP OP_DEPTH OP_2 OP_CHECKMULTISIG OP_CODESEPARATOR OP_1 OP_DROP'
  const r = opt(s)
  assert.match(asm(r), /OP_DEPTH OP_2 OP_CHECKMULTISIG OP_CODESEPARATOR/)
})

test('equivalence checker', () => {
  assert.ok(equivalent('OP_OVER OP_OVER', 'OP_2DUP'))
  assert.ok(!equivalent('OP_SWAP OP_SUB', 'OP_SUB'))
  assert.ok(!equivalent('OP_DUP OP_DROP', ''))
  assert.ok(equivalent('OP_DUP OP_DROP', '', 1))
  assert.ok(equivalent('OP_ADD OP_VERIFY OP_MUL OP_VERIFY', 'OP_ROT OP_ROT OP_ADD OP_VERIFY OP_MUL OP_VERIFY') === false)
  const proof = proveEquivalent('OP_IF OP_1 OP_ELSE OP_2 OP_ENDIF', 'OP_IF OP_2 OP_ELSE OP_1 OP_ENDIF')
  assert.ok(!proof.ok)
})

test('entries of the exhaustive table replay to the stacks they are filed under', () => {
  const t = new StackTable({ maxCost: 4 })
  const I = []
  let n = 0
  for (const [key, e] of t.map) {
    if (n++ % 7 !== 0) continue
    const ops = []
    for (const mi of e.seq) ops.push(...t.moves[mi].ops)
    I.push([key, ops])
  }
  for (const [key, ops] of I) {
    const [target] = key.split('|')
    const want = target ? target.split(',').map(Number) : []
    const sim = require('../src/symbolic')
    const Int = new sim.Interner()
    const st = new sim.SymState(Int)
    st.ensure(6)
    for (const o of ops) assert.ok(st.step(o))
    assert.deepStrictEqual(st.main.map(id => Int.info[id].index), want, key)
  }
})

test('the naive field compiler output shrinks and stays equivalent', () => {
  const c = randomCircuit({ gates: 120, seed: 7 })
  const script = compileNaive(c, { modulus: 'pick' })
  const r = optimize(script, { differential: 30 })
  assert.ok(r.report.verification.symbolic.ok)
  assert.ok(r.report.saved > script.length * 0.3, `saved only ${r.report.saved} of ${script.length}`)
  assert.ok(equivOps(parse(script), r.ops))
})

test('pattern database round-trips through JSON', () => {
  const cache = new Cache({ table: new StackTable({ maxCost: 4 }) })
  optimize('OP_1 OP_PICK OP_1 OP_PICK OP_ADD OP_3 OP_5 OP_ADD', { cache, differential: 0 })
  const json = JSON.parse(JSON.stringify(cache.toJSON()))
  const again = new Cache({ entries: json.entries, table: new StackTable({ maxCost: 4 }) })
  const r = optimize('OP_1 OP_PICK OP_1 OP_PICK OP_ADD OP_3 OP_5 OP_ADD', { cache: again, differential: 0 })
  assert.ok(again.hits > 0)
  assert.strictEqual(asm(r), 'OP_2DUP OP_ADD OP_8')
})

test('profile accounts for every byte', () => {
  const buf = toBuffer('OP_5 OP_PICK OP_3 OP_ROLL OP_MUL 0102030405060708 OP_ADD OP_SHA256 OP_EQUALVERIFY OP_IF OP_ENDIF')
  const p = profile(buf)
  assert.strictEqual(p.categories.reduce((n, c) => n + c.bytes, 0), buf.length)
  assert.deepStrictEqual(p.depths.PICK, [0, 1, 0, 0, 0])
  assert.deepStrictEqual(p.depths.ROLL, [1, 0, 0, 0, 0])
})

test('CLI optimizes, explains and profiles', () => {
  const bin = path.join(__dirname, '..', 'bin', 'scriptmin.js')
  const file = path.join(require('os').tmpdir(), `scriptmin-test-${process.pid}.asm`)
  require('fs').writeFileSync(file, 'OP_2 OP_PICK OP_2 OP_PICK OP_MUL OP_3 OP_ROLL OP_DROP OP_2 OP_ROLL OP_DROP OP_NIP')
  try {
    const out = execFileSync('node', [bin, '--explain', '--tests', '20', file], { encoding: 'utf8' })
    assert.match(out, /Minimized:\s+2 bytes/)
    assert.match(out, /symbolic proof\s+passed/)
    const json = JSON.parse(execFileSync('node', [bin, '--json', '--tests', '0', file], { encoding: 'utf8' }))
    assert.strictEqual(json.script, '7595')
    const prof = execFileSync('node', [bin, '--profile', file], { encoding: 'utf8' })
    assert.match(prof, /PICK\/ROLL depths/)
  } finally {
    require('fs').unlinkSync(file)
  }
  assert.strictEqual(OP.OP_DROP, 0x75)
})

test('schedules through the alt stack without keeping spare copies', () => {
  const r = opt('OP_TOALTSTACK OP_2 OP_PICK OP_2 OP_PICK OP_MUL OP_FROMALTSTACK OP_3 OP_ROLL OP_DROP OP_ADD OP_NIP OP_NIP')
  assert.strictEqual(r.script.length, 5)
  // Balanced alt-stack use can disappear entirely.
  assert.strictEqual(asm(opt('OP_DUP OP_TOALTSTACK OP_ADD OP_FROMALTSTACK OP_MUL')), 'OP_TUCK OP_ADD OP_MUL')
  // Unbalanced use (a value left on the alt stack) must stay.
  assert.match(asm(opt('OP_DUP OP_TOALTSTACK OP_ADD')), /OP_TOALTSTACK/)
  assert.strictEqual(asm(opt('OP_2 OP_PICK OP_2 OP_PICK OP_ADD OP_TOALTSTACK OP_2DROP OP_DROP OP_FROMALTSTACK')), 'OP_DROP OP_ADD')
})

test('interpreter runs are isolated from each other', () => {
  const { evaluate } = require('../src/verify')
  const flags = require('@smartledger/bsv').Script.Interpreter.currentConsensusFlags()
  // OP_INVERT on a boolean result corrupts the interpreter's shared TRUE buffer.
  evaluate(toBuffer('OP_2 OP_2 OP_3 OP_WITHIN OP_INVERT'), [], flags)
  assert.deepStrictEqual(evaluate(toBuffer('OP_2 OP_2 OP_3 OP_WITHIN'), [], flags).stack, ['01'])
  // ... and pushed data aliases the script bytes.
  const script = toBuffer('84 OP_INVERT')
  evaluate(script, [], flags)
  assert.strictEqual(script.toString('hex'), '018483')
})

test('computes repeated expressions once', () => {
  assert.strictEqual(asm(opt('OP_2DUP OP_MUL OP_ROT OP_ROT OP_MUL OP_ADD')), 'OP_MUL OP_DUP OP_ADD')
  assert.strictEqual(asm(opt('OP_DUP OP_SHA256 OP_SWAP OP_SHA256 OP_CAT')), 'OP_SHA256 OP_DUP OP_CAT')
  // The same check twice fails exactly when it fails once.
  assert.strictEqual(asm(opt('OP_OVER OP_OVER OP_ADD OP_VERIFY OP_ADD OP_VERIFY')), 'OP_ADD OP_VERIFY')
  // Different checks must all survive.
  assert.match(asm(opt('OP_OVER OP_OVER OP_ADD OP_VERIFY OP_SUB OP_VERIFY')), /OP_ADD.*OP_SUB/)
})

test('Fp12 tower multiplication: smaller than a last-use compiler and still correct', () => {
  const crypto = require('crypto')
  const { evaluate } = require('../src/verify')
  const { compileNaive: compile, evaluateCircuit, P } = require('../examples/naive-field-compiler')
  const { millerLikeCircuit } = require('../examples/tower-circuit')
  const flags = require('@smartledger/bsv').Script.Interpreter.currentConsensusFlags()
  const c = millerLikeCircuit(1)
  const script = compile(c, { modulus: 'pick', lastUse: true })
  const r = optimize(script, { differential: 0 })
  assert.ok(r.report.saved > script.length * 0.25, `saved only ${r.report.saved} of ${script.length}`)
  const inputs = Array.from({ length: c.inputs }, () => BigInt('0x' + crypto.randomBytes(32).toString('hex')) % P)
  const expected = evaluateCircuit(c, inputs).map(v => encodeNum(v).toString('hex'))
  const out = evaluate(r.script, inputs.map(encodeNum), flags)
  assert.ok(out.ok, out.err)
  assert.deepStrictEqual(out.stack, expected)
})

test('field circuit compiler: lazy reduction matches the circuit exactly', () => {
  const { compileField, evaluateIR } = require('../src/field')
  const ir = {
    modulus: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff43', // 2^256 - 189
    inputs: 3,
    gates: [
      { op: 'mul', a: 0, b: 1 }, // 3
      { op: 'sub', a: 2, b: 3 }, // 4  may go negative before reduction
      { op: 'mulc', a: 4, k: '-7' }, // 5
      { op: 'const', v: '12345' }, // 6
      { op: 'add', a: 5, b: 6 }, // 7
      { op: 'mul', a: 7, b: 7 }, // 8
      { op: 'assertEqual', a: 3, b: 3 } // 9
    ],
    outputs: [8, 4]
  }
  for (const maxBits of [0, 300, 1024]) {
    const r = compileField(ir, { maxBits, tests: 15 })
    assert.strictEqual(r.report.checked, 17)
    assert.ok(r.report.optimized <= r.report.reference + 8)
  }
  // A failing assertion fails the script too.
  const failing = Object.assign({}, ir, { gates: ir.gates.concat([{ op: 'assertEqual', a: 0, b: 1 }]) })
  assert.strictEqual(evaluateIR(failing, [1n, 2n, 3n]).ok, false)
  compileField(failing, { tests: 5 })
})

test('beam scheduling is never worse than greedy, and skips deep stacks', () => {
  const { compileNaive: compile } = require('../examples/naive-field-compiler')
  const { millerLikeCircuit } = require('../examples/tower-circuit')
  const script = compile(millerLikeCircuit(1), { modulus: 'pick', lastUse: true })
  const greedy = optimize(script, { differential: 0, beam: 0 })
  const beamed = optimize(script, { differential: 0, beam: 4 })
  assert.ok(beamed.report.verification.symbolic.ok)
  assert.ok(beamed.script.length <= greedy.script.length, `${beamed.script.length} > ${greedy.script.length}`)

  const { rescheduleFragment } = require('../src/schedule')
  const ops = parse(script)
  const deep = {}
  rescheduleFragment(ops, 0, 0, { beam: 4, beamMaxStack: 1, stats: deep })
  assert.ok(!deep.beamRuns, 'a stack deeper than beamMaxStack must not be beam-searched')
  const shallow = {}
  const out = rescheduleFragment(ops, 0, 0, { beam: 4, stats: shallow })
  assert.ok(shallow.beamRuns > 0)
  assert.ok(equivOps(ops, out))
})
