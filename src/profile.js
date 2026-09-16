'use strict'

// Byte profiler: where a script's serialized bytes go.

const { OP, TAIL, isPush, pushValue, opSize, opName, toAsm } = require('./script')
const { decodeNum } = require('./num')

const CATEGORY = {}
const put = (cat, names) => { for (const n of names) CATEGORY[OP[n]] = cat }
put('stack', ['OP_2DROP', 'OP_2DUP', 'OP_3DUP', 'OP_2OVER', 'OP_2ROT', 'OP_2SWAP', 'OP_IFDUP', 'OP_DEPTH',
  'OP_DROP', 'OP_DUP', 'OP_NIP', 'OP_OVER', 'OP_PICK', 'OP_ROLL', 'OP_ROT', 'OP_SWAP', 'OP_TUCK'])
put('altstack', ['OP_TOALTSTACK', 'OP_FROMALTSTACK'])
put('arithmetic', ['OP_1ADD', 'OP_1SUB', 'OP_2MUL', 'OP_2DIV', 'OP_NEGATE', 'OP_ABS', 'OP_NOT', 'OP_0NOTEQUAL',
  'OP_ADD', 'OP_SUB', 'OP_MUL', 'OP_DIV', 'OP_MOD', 'OP_BOOLAND', 'OP_BOOLOR', 'OP_NUMEQUAL', 'OP_NUMNOTEQUAL',
  'OP_LESSTHAN', 'OP_GREATERTHAN', 'OP_LESSTHANOREQUAL', 'OP_GREATERTHANOREQUAL', 'OP_MIN', 'OP_MAX', 'OP_WITHIN',
  'OP_LSHIFTNUM', 'OP_RSHIFTNUM'])
put('bitwise', ['OP_INVERT', 'OP_AND', 'OP_OR', 'OP_XOR', 'OP_LSHIFT', 'OP_RSHIFT'])
put('data conversion', ['OP_CAT', 'OP_SPLIT', 'OP_NUM2BIN', 'OP_BIN2NUM', 'OP_SIZE', 'OP_SUBSTR', 'OP_LEFT', 'OP_RIGHT'])
put('verification', ['OP_VERIFY', 'OP_EQUAL', 'OP_EQUALVERIFY', 'OP_NUMEQUALVERIFY'])
put('crypto', ['OP_RIPEMD160', 'OP_SHA1', 'OP_SHA256', 'OP_HASH160', 'OP_HASH256', 'OP_CODESEPARATOR',
  'OP_CHECKSIG', 'OP_CHECKSIGVERIFY', 'OP_CHECKMULTISIG', 'OP_CHECKMULTISIGVERIFY'])
put('control', ['OP_IF', 'OP_NOTIF', 'OP_VERIF', 'OP_VERNOTIF', 'OP_ELSE', 'OP_ENDIF', 'OP_RETURN', 'OP_NOP',
  'OP_NOP1', 'OP_CHECKLOCKTIMEVERIFY', 'OP_CHECKSEQUENCEVERIFY', 'OP_NOP9', 'OP_NOP10', 'OP_VER'])

const DEPTH_BUCKETS = [[0, 3], [4, 15], [16, 63], [64, 255], [256, Infinity]]

function profile (ops, { ngrams = 10 } = {}) {
  const total = ops.reduce((n, o) => n + opSize(o), 0)
  const categories = {}
  const opcodes = {}
  const depth = { PICK: DEPTH_BUCKETS.map(() => 0), ROLL: DEPTH_BUCKETS.map(() => 0) }
  const add = (cat, bytes) => { categories[cat] = (categories[cat] || 0) + bytes }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const size = opSize(op)
    if (op.code === TAIL) { add('data (after OP_RETURN)', size); continue }
    const name = isPush(op) ? (op.code === OP.OP_0 || op.code >= OP.OP_1NEGATE ? opName(op.code) : 'push') : opName(op.code)
    const e = opcodes[name] || (opcodes[name] = { count: 0, bytes: 0 })
    e.count++
    e.bytes += size

    if (isPush(op)) {
      const next = ops[i + 1]
      if (next && (next.code === OP.OP_PICK || next.code === OP.OP_ROLL)) {
        // The index push belongs to the stack movement it parameterizes.
        const n = decodeNum(pushValue(op), 4)
        if (n !== null && n >= 0n) {
          const b = DEPTH_BUCKETS.findIndex(([lo, hi]) => n >= lo && n <= hi)
          depth[next.code === OP.OP_PICK ? 'PICK' : 'ROLL'][b]++
        }
        add('stack', size)
        continue
      }
      add(pushValue(op).length <= 4 ? 'small constants' : 'data pushes', size)
      continue
    }
    add(CATEGORY[op.code] || 'other', size)
  }

  if (!ngrams) return summary()
  const grams = new Map()
  const tokens = ops.map(o => (o.code === TAIL ? '<tail>' : isPush(o) ? (pushValue(o).length <= 4 ? toAsm([o]) : `<${pushValue(o).length}b>`) : opName(o.code).replace(/^OP_/, '')))
  const sizes = ops.map(opSize)
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= ops.length; i++) {
      const key = tokens.slice(i, i + n).join(' ')
      let bytes = 0
      for (let j = i; j < i + n; j++) bytes += sizes[j]
      const e = grams.get(key)
      if (e) { e.count++; e.bytes += bytes } else grams.set(key, { pattern: key, count: 1, bytes })
    }
  }
  const patterns = [...grams.values()].filter(e => e.count > 1)
    .sort((a, b) => b.bytes - a.bytes).slice(0, ngrams)
  return summary(patterns)

  function summary (patterns = []) {
    return {
      bytes: total,
      ops: ops.length,
      categories: Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([name, bytes]) => ({ name, bytes, pct: total ? (100 * bytes) / total : 0 })),
      opcodes: Object.entries(opcodes).sort((a, b) => b[1].bytes - a[1].bytes).map(([name, v]) => Object.assign({ name }, v)),
      depths: { buckets: DEPTH_BUCKETS.map(([lo, hi]) => (hi === Infinity ? `${lo}+` : `${lo}-${hi}`)), PICK: depth.PICK, ROLL: depth.ROLL },
      patterns
    }
  }
}

module.exports = { profile }
