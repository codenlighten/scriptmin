'use strict'

// Fixed rewrite rules. Each rule proposes a replacement; nothing is applied
// unless the symbolic checker proves the window equivalent at that position.
// Rules can therefore be written for the common case without spelling out
// their side conditions (stack underflow, constant-ness, ...).

const { OP, isPush, pushValue, opsSize } = require('./script')
const { decodeNum } = require('./num')
const { equivalent, SPECS } = require('./symbolic')
const { heights } = require('./analysis')

const COMM2 = new Set(Object.entries(SPECS).filter(([, s]) => s.comm && s.pops === 2).map(([c]) => Number(c)))

const m = {
  code: c => op => op.code === c,
  push: () => op => isPush(op),
  num: n => op => {
    if (!isPush(op)) return false
    const v = decodeNum(pushValue(op), 4)
    return v !== null && v === BigInt(n)
  },
  comm2: () => op => COMM2.has(op.code)
}
const c = code => m.code(code)
const k = code => ({ code })

const RULES = [
  { name: 'DUP DROP', match: [c(OP.OP_DUP), c(OP.OP_DROP)], out: () => [] },
  { name: 'OVER DROP', match: [c(OP.OP_OVER), c(OP.OP_DROP)], out: () => [] },
  { name: 'DUP NIP', match: [c(OP.OP_DUP), c(OP.OP_NIP)], out: () => [] },
  { name: '2DUP 2DROP', match: [c(OP.OP_2DUP), c(OP.OP_2DROP)], out: () => [] },
  { name: 'SWAP SWAP', match: [c(OP.OP_SWAP), c(OP.OP_SWAP)], out: () => [] },
  { name: '2SWAP 2SWAP', match: [c(OP.OP_2SWAP), c(OP.OP_2SWAP)], out: () => [] },
  { name: 'ROT ROT ROT', match: [c(OP.OP_ROT), c(OP.OP_ROT), c(OP.OP_ROT)], out: () => [] },
  { name: 'TOALT FROMALT', match: [c(OP.OP_TOALTSTACK), c(OP.OP_FROMALTSTACK)], out: () => [] },
  { name: 'FROMALT TOALT', match: [c(OP.OP_FROMALTSTACK), c(OP.OP_TOALTSTACK)], out: () => [] },
  { name: 'NOP', match: [c(OP.OP_NOP)], out: () => [] },
  { name: 'push DROP', match: [m.push(), c(OP.OP_DROP)], out: () => [] },
  { name: 'push push 2DROP', match: [m.push(), m.push(), c(OP.OP_2DROP)], out: () => [] },
  { name: '0 PICK', match: [m.num(0), c(OP.OP_PICK)], out: () => [k(OP.OP_DUP)] },
  { name: '1 PICK', match: [m.num(1), c(OP.OP_PICK)], out: () => [k(OP.OP_OVER)] },
  { name: '0 ROLL', match: [m.num(0), c(OP.OP_ROLL)], out: () => [] },
  { name: '1 ROLL', match: [m.num(1), c(OP.OP_ROLL)], out: () => [k(OP.OP_SWAP)] },
  { name: '2 ROLL', match: [m.num(2), c(OP.OP_ROLL)], out: () => [k(OP.OP_ROT)] },
  { name: 'SWAP DROP', match: [c(OP.OP_SWAP), c(OP.OP_DROP)], out: () => [k(OP.OP_NIP)] },
  { name: 'SWAP NIP', match: [c(OP.OP_SWAP), c(OP.OP_NIP)], out: () => [k(OP.OP_DROP)] },
  { name: 'TUCK DROP', match: [c(OP.OP_TUCK), c(OP.OP_DROP)], out: () => [k(OP.OP_SWAP)] },
  { name: 'SWAP OVER', match: [c(OP.OP_SWAP), c(OP.OP_OVER)], out: () => [k(OP.OP_TUCK)] },
  { name: 'DROP DROP', match: [c(OP.OP_DROP), c(OP.OP_DROP)], out: () => [k(OP.OP_2DROP)] },
  { name: 'NIP DROP', match: [c(OP.OP_NIP), c(OP.OP_DROP)], out: () => [k(OP.OP_2DROP)] },
  { name: 'OVER OVER', match: [c(OP.OP_OVER), c(OP.OP_OVER)], out: () => [k(OP.OP_2DUP)] },
  { name: '2 PICK x3', match: [m.num(2), c(OP.OP_PICK), m.num(2), c(OP.OP_PICK), m.num(2), c(OP.OP_PICK)], out: () => [k(OP.OP_3DUP)] },
  { name: '3 PICK x2', match: [m.num(3), c(OP.OP_PICK), m.num(3), c(OP.OP_PICK)], out: () => [k(OP.OP_2OVER)] },
  { name: 'SWAP commutative', match: [c(OP.OP_SWAP), m.comm2()], out: w => [w[1]] },
  { name: '1 ADD', match: [m.num(1), c(OP.OP_ADD)], out: () => [k(OP.OP_1ADD)] },
  { name: '1 SUB', match: [m.num(1), c(OP.OP_SUB)], out: () => [k(OP.OP_1SUB)] },
  { name: 'EQUAL VERIFY', match: [c(OP.OP_EQUAL), c(OP.OP_VERIFY)], out: () => [k(OP.OP_EQUALVERIFY)] },
  { name: 'NUMEQUAL VERIFY', match: [c(OP.OP_NUMEQUAL), c(OP.OP_VERIFY)], out: () => [k(OP.OP_NUMEQUALVERIFY)] },
  { name: 'CHECKSIG VERIFY', match: [c(OP.OP_CHECKSIG), c(OP.OP_VERIFY)], out: () => [k(OP.OP_CHECKSIGVERIFY)] }
]

const BY_FIRST_LEN = RULES.slice().sort((a, b) => b.match.length - a.match.length)

// One left-to-right sweep over a modelled region. Returns { ops, rewrites }.
function peepholeRegion (ops, g, ga, opts = {}) {
  const { hm, ha } = heights(ops, g, ga, opts)
  const out = []
  const rewrites = []
  let i = 0
  while (i < ops.length) {
    let applied = false
    for (const rule of BY_FIRST_LEN) {
      const n = rule.match.length
      if (i + n > ops.length) continue
      let ok = true
      for (let j = 0; j < n && ok; j++) ok = rule.match[j](ops[i + j])
      if (!ok) continue
      const win = ops.slice(i, i + n)
      const repl = rule.out(win)
      if (opsSize(repl) >= opsSize(win)) continue
      if (!equivalent(win, repl, hm[i], ha[i], opts)) continue
      out.push(...repl)
      rewrites.push({ pass: 'peephole', rule: rule.name, index: i, before: win, after: repl, saved: opsSize(win) - opsSize(repl) })
      i += n
      applied = true
      break
    }
    if (!applied) out.push(ops[i++])
  }
  return { ops: out, rewrites }
}

function peephole (ops, g, ga, opts = {}, maxRounds = 8) {
  let all = []
  for (let r = 0; r < maxRounds; r++) {
    const res = peepholeRegion(ops, g, ga, opts)
    if (!res.rewrites.length) break
    ops = res.ops
    all = all.concat(res.rewrites)
  }
  return { ops, rewrites: all }
}

module.exports = { peephole, RULES }
