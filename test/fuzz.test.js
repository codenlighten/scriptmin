'use strict'

// Random scripts built from stack ops, arithmetic, hashing, verification and
// control flow. Each is optimized and then run against the original on the
// real interpreter from many random starting stacks.

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const { optimize } = require('../src')
const { OP, numOp, encode, pushOp } = require('../src/script')
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
