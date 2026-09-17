'use strict'

// Random scripts built from stack ops, arithmetic, hashing, verification and
// control flow. Each is optimized and then run against the original on the
// real interpreter from many random starting stacks.

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { optimize } = require('../src')
const { OP, numOp, encode, pushOp } = require('../src/script')
const { encodeNum } = require('../src/num')
const { differential } = require('../src/verify')

function rng (seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
}

const STACK = ['OP_DUP', 'OP_DROP', 'OP_SWAP', 'OP_OVER', 'OP_ROT', 'OP_NIP', 'OP_TUCK', 'OP_2DUP', 'OP_2DROP',
  'OP_3DUP', 'OP_2OVER', 'OP_2ROT', 'OP_2SWAP', 'OP_TOALTSTACK', 'OP_FROMALTSTACK', 'OP_NOP']
const ARITH = ['OP_ADD', 'OP_SUB', 'OP_MUL', 'OP_1ADD', 'OP_1SUB', 'OP_NEGATE', 'OP_ABS', 'OP_NOT', 'OP_0NOTEQUAL',
  'OP_MIN', 'OP_MAX', 'OP_NUMEQUAL', 'OP_LESSTHAN', 'OP_BOOLAND', 'OP_BOOLOR', 'OP_WITHIN', 'OP_DIV', 'OP_MOD']
const OTHER = ['OP_EQUAL', 'OP_SIZE', 'OP_SHA256', 'OP_HASH160', 'OP_CAT', 'OP_VERIFY', 'OP_EQUALVERIFY',
  'OP_NUMEQUALVERIFY', 'OP_DEPTH', 'OP_IFDUP', 'OP_SPLIT', 'OP_AND', 'OP_INVERT']

function randomScript (r, len, withControl) {
  const ops = []
  let depth = 0
  for (let i = 0; i < len; i++) {
    const k = r() % 100
    if (k < 30) ops.push({ code: OP[STACK[r() % STACK.length]] })
    else if (k < 45) { ops.push(numOp(r() % 7)); ops.push({ code: r() % 2 ? OP.OP_PICK : OP.OP_ROLL }) } else if (k < 60) ops.push(numOp((r() % 21) - 5))
    else if (k < 62) ops.push(pushOp(crypto.randomBytes(r() % 6)))
    else if (k < 82) ops.push({ code: OP[ARITH[r() % ARITH.length]] })
    else if (k < 92) ops.push({ code: OP[OTHER[r() % OTHER.length]] })
    else if (withControl) {
      if (k < 95) { ops.push({ code: OP.OP_IF }); depth++ } else if (k < 97 && depth) ops.push({ code: OP.OP_ELSE })
      else if (depth) { ops.push({ code: OP.OP_ENDIF }); depth-- }
    }
  }
  while (depth--) ops.push({ code: OP.OP_ENDIF })
  return ops
}

test('random scripts optimize to interpreter-equivalent scripts', () => {
  const r = rng(0xC0FFEE)
  let saved = 0
  for (let i = 0; i < 300; i++) {
    const ops = randomScript(r, 4 + (r() % 30), i % 3 === 0)
    const buf = encode(ops)
    const res = optimize(buf, { differential: false })
    assert.ok(res.script.length <= buf.length)
    const diff = differential(buf, res.script, { runs: 60, maxDepth: 10 })
    assert.ok(diff.ok, `mismatch for ${buf.toString('hex')} -> ${res.script.toString('hex')}: ${JSON.stringify(diff)}`)
    saved += buf.length - res.script.length
  }
  assert.ok(saved > 0)
})

test('stack-only scripts: heavy fuzz', () => {
  const r = rng(12345)
  for (let i = 0; i < 400; i++) {
    const ops = []
    const n = 3 + (r() % 14)
    for (let j = 0; j < n; j++) {
      const k = r() % 10
      if (k < 6) ops.push({ code: OP[STACK[r() % STACK.length]] })
      else if (k < 8) { ops.push(numOp(r() % 5)); ops.push({ code: r() % 2 ? OP.OP_PICK : OP.OP_ROLL }) } else ops.push(numOp(r() % 17))
    }
    const buf = encode(ops)
    const res = optimize(buf, { differential: false, effort: i % 20 === 0 ? 'high' : 'medium' })
    const diff = differential(buf, res.script, { runs: 80, maxDepth: 9 })
    assert.ok(diff.ok, `mismatch for ${buf.toString('hex')} -> ${res.script.toString('hex')}: ${JSON.stringify(diff)}`)
  }
})

// Every modelled opcode (including signatures, Chronicle opcodes and bit
// shifts), unusual push encodings, boundary numbers, OP_NOTIF, OP_RETURN and
// OP_0 OP_IF blocks inside branches, and PICK/ROLL with a computed index. Starting
// stacks are small numbers, booleans and repeats, so checks pass more often.
const WIDE = [...STACK, ...ARITH, ...OTHER, 'OP_NUMNOTEQUAL', 'OP_GREATERTHAN', 'OP_LESSTHANOREQUAL',
  'OP_GREATERTHANOREQUAL', 'OP_SHA1', 'OP_RIPEMD160', 'OP_HASH256', 'OP_OR', 'OP_XOR', 'OP_BIN2NUM',
  'OP_2DIV', 'OP_SUBSTR', 'OP_LEFT', 'OP_RIGHT', 'OP_CHECKSIG', 'OP_CODESEPARATOR']
// Size and shift operands stay small so the interpreter does not build huge elements.
const SIZED = ['OP_NUM2BIN', 'OP_LSHIFT', 'OP_RSHIFT', 'OP_LSHIFTNUM', 'OP_RSHIFTNUM', 'OP_2MUL']
const ODD = [
  () => ({ code: OP.OP_PUSHDATA1, data: Buffer.from([7]) }),
  () => ({ code: 1, data: Buffer.from([3]) }),
  () => ({ code: 2, data: Buffer.from([2, 0x00]) }),
  () => ({ code: 1, data: Buffer.from([0x80]) }),
  () => pushOp(Buffer.from('ffffff7f', 'hex')),
  () => pushOp(Buffer.from('0000008000', 'hex')),
  () => pushOp(Buffer.from('ffffffff', 'hex')),
  () => ({ code: OP.OP_1NEGATE })
]

function wideScript (r, len) {
  const ops = []
  let depth = 0
  for (let i = 0; i < len; i++) {
    const k = r() % 100
    if (k < 42) ops.push({ code: OP[WIDE[r() % WIDE.length]] })
    else if (k < 46) { ops.push(numOp(r() % 9)); ops.push({ code: OP[SIZED[r() % SIZED.length]] }) } else if (k < 58) { ops.push(numOp(r() % 6)); ops.push({ code: r() % 2 ? OP.OP_PICK : OP.OP_ROLL }) } else if (k < 70) ops.push(numOp((r() % 12) - 3))
    else if (k < 80) ops.push(ODD[r() % ODD.length]())
    else if (k < 83) ops.push(pushOp(crypto.randomBytes(r() % 5)))
    else if (k < 86) ops.push({ code: r() % 2 ? OP.OP_PICK : OP.OP_ROLL })
    else if (k < 88) ops.push({ code: OP.OP_0 }, { code: OP.OP_IF }, numOp(r() % 4), { code: OP.OP_DUP }, { code: OP.OP_DROP }, { code: OP.OP_ENDIF })
    else if (k < 93) { ops.push({ code: r() % 2 ? OP.OP_IF : OP.OP_NOTIF }); depth++ } else if (k < 95 && depth) ops.push({ code: OP.OP_ELSE })
    else if (k < 97 && depth) { ops.push({ code: OP.OP_ENDIF }); depth-- } else if (k < 98 && depth) ops.push({ code: OP.OP_RETURN })
  }
  while (depth--) ops.push({ code: OP.OP_ENDIF })
  return ops
}

test('wide opcode fuzz with stacks that pass checks', () => {
  const r = rng(0xB5B)
  const small = () => {
    const k = r() % 12
    if (k < 6) return encodeNum(BigInt(r() % 5))
    if (k < 8) return Buffer.from([1])
    if (k < 9) return Buffer.alloc(0)
    if (k < 10) return Buffer.from([0x80])
    return crypto.randomBytes(1 + (r() % 4))
  }
  const stacks = []
  for (let i = 0; i < 40; i++) {
    const st = []
    const d = r() % 12
    for (let j = 0; j < d; j++) st.push(j && r() % 4 === 0 ? st[r() % j] : small())
    stacks.push(st)
  }
  let passing = 0
  for (let i = 0; i < 150; i++) {
    const buf = encode(wideScript(r, 3 + (r() % 40)))
    const res = optimize(buf, { differential: false })
    const diff = differential(buf, res.script, { runs: 20, maxDepth: 10, stacks })
    assert.ok(diff.ok, `mismatch for ${buf.toString('hex')} -> ${res.script.toString('hex')}: ${JSON.stringify(diff)}`)
    passing += diff.succeeded
  }
  assert.ok(passing > 0)
})

// OP_0 OP_IF blocks holding OP_VERIF/OP_VERNOTIF inside other conditionals: in
// an unexecuted branch those open a conditional after Chronicle and do nothing
// before it. Optimized without assuming Chronicle, and checked in both eras.
test('conditionals whose meaning changes with Chronicle, checked in both eras', () => {
  const { eraFlags } = require('../src/verify')
  const r = rng(0xC4C)
  const pick = a => a[r() % a.length]
  const seq = () => Array.from({ length: r() % 3 }, () => pick(['OP_DUP', 'OP_DROP', 'OP_SWAP', 'OP_OVER', 'OP_1', 'OP_ADD', 'OP_NIP', 'OP_DUP OP_DROP', 'OP_RETURN'])).join(' ')
  const { toBuffer } = require('../src/script')
  for (let i = 0; i < 400; i++) {
    const src = [seq(), pick(['OP_1', 'OP_0', '']), 'OP_IF', 'OP_0 OP_IF', pick(['OP_VERIF', 'OP_VERNOTIF']), seq(),
      pick(['OP_ELSE', '']), seq(), 'OP_ENDIF', seq(), pick(['OP_ENDIF', '']), seq(), 'OP_DUP OP_DROP', seq()].join(' ').replace(/\s+/g, ' ').trim()
    const buf = toBuffer(src)
    const res = optimize(buf, { chronicle: false, differential: false })
    const diff = differential(buf, res.script, { runs: 15, maxDepth: 5, flags: eraFlags({ chronicle: false }) })
    assert.ok(diff.ok, `mismatch for ${src} -> ${res.script.toString('hex')}: ${JSON.stringify(diff)}`)
  }
})
