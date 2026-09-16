'use strict'

// Symbolic stack execution.
//
// Every stack value is an interned id: an input slot (the value that was at
// depth i when the fragment started), an alt-stack input slot, a constant, or
// the application of an opcode to other ids. Two fragments are equivalent when,
// run from the same unknown starting stacks, they
//   - need the same incoming depth (so they underflow on exactly the same inputs),
//   - leave identical symbolic main and alt stacks, and
//   - evaluate the same multiset of operations that can fail.
// The last point is what makes reordering and dead-value removal safe: script
// failure is all-or-nothing, so what matters is which checks run, not when.

const bsv = require('@smartledger/bsv')
const { OP, isPush, pushValue } = require('./script')
const { decodeNum, encodeNum, castToBool } = require('./num')

const H = bsv.crypto.Hash
const TRUE = Buffer.from([1])
const FALSE = Buffer.alloc(0)
const bool = b => (b ? TRUE : FALSE)

class Interner {
  constructor () {
    this.ids = new Map()
    this.info = []
    this.inputs = []
    this.alts = []
  }

  _get (key, info) {
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.info.length
      this.ids.set(key, id)
      this.info.push(info)
    }
    return id
  }

  input (i) {
    let id = this.inputs[i]
    if (id === undefined) id = this.inputs[i] = this._get('i' + i, { kind: 'in', index: i })
    return id
  }

  altInput (i) {
    let id = this.alts[i]
    if (id === undefined) id = this.alts[i] = this._get('a' + i, { kind: 'alt', index: i })
    return id
  }
  konst (buf) { return this._get('c' + buf.toString('hex'), { kind: 'const', buf }) }
  app (name, args, proj) {
    const key = name + '(' + args.join(',') + ')' + (proj === undefined ? '' : '#' + proj)
    return this._get(key, { kind: 'app', name, args, proj })
  }

  isConst (id) { return this.info[id].kind === 'const' }
  constBuf (id) { return this.info[id].buf }
}

// Numeric folding only when every operand is a minimally encoded number of at
// most 4 bytes: those decode the same way before Genesis, after Genesis, and
// with or without MINIMALDATA.
function nums (bufs) {
  const out = []
  for (const b of bufs) {
    const n = decodeNum(b, 4)
    if (n === null) return null
    out.push(n)
  }
  return out
}

function numFold (fn) {
  return bufs => {
    const n = nums(bufs)
    if (n === null) return null
    const r = fn(...n)
    return r === null ? null : [typeof r === 'boolean' ? bool(r) : encodeNum(r)]
  }
}

// Op specs: pops, outputs ('one' | 'size' | 'split' | 'none'), whether the op is
// commutative in its two operands, whether it is total (cannot fail once its
// operands are present), and an optional constant folder.
const SPECS = {}
function spec (code, s) { SPECS[code] = Object.assign({ outputs: 'one', comm: false, total: false, fold: null }, s) }

spec(OP.OP_1ADD, { pops: 1, fold: numFold(a => a + 1n) })
spec(OP.OP_1SUB, { pops: 1, fold: numFold(a => a - 1n) })
spec(OP.OP_NEGATE, { pops: 1, fold: numFold(a => -a) })
spec(OP.OP_ABS, { pops: 1, fold: numFold(a => (a < 0n ? -a : a)) })
spec(OP.OP_NOT, { pops: 1, fold: numFold(a => a === 0n) })
spec(OP.OP_0NOTEQUAL, { pops: 1, fold: numFold(a => a !== 0n) })
spec(OP.OP_ADD, { pops: 2, comm: true, fold: numFold((a, b) => a + b) })
spec(OP.OP_SUB, { pops: 2, fold: numFold((a, b) => a - b) })
spec(OP.OP_MUL, { pops: 2, comm: true, fold: numFold((a, b) => a * b) })
spec(OP.OP_DIV, { pops: 2, fold: numFold((a, b) => (b === 0n ? null : a / b)) })
spec(OP.OP_MOD, { pops: 2, fold: numFold((a, b) => (b === 0n ? null : a % b)) })
spec(OP.OP_BOOLAND, { pops: 2, comm: true, fold: numFold((a, b) => a !== 0n && b !== 0n) })
spec(OP.OP_BOOLOR, { pops: 2, comm: true, fold: numFold((a, b) => a !== 0n || b !== 0n) })
spec(OP.OP_NUMEQUAL, { pops: 2, comm: true, fold: numFold((a, b) => a === b) })
spec(OP.OP_NUMNOTEQUAL, { pops: 2, comm: true, fold: numFold((a, b) => a !== b) })
spec(OP.OP_LESSTHAN, { pops: 2, fold: numFold((a, b) => a < b) })
spec(OP.OP_GREATERTHAN, { pops: 2, fold: numFold((a, b) => a > b) })
spec(OP.OP_LESSTHANOREQUAL, { pops: 2, fold: numFold((a, b) => a <= b) })
spec(OP.OP_GREATERTHANOREQUAL, { pops: 2, fold: numFold((a, b) => a >= b) })
spec(OP.OP_MIN, { pops: 2, comm: true, fold: numFold((a, b) => (a < b ? a : b)) })
spec(OP.OP_MAX, { pops: 2, comm: true, fold: numFold((a, b) => (a > b ? a : b)) })
spec(OP.OP_WITHIN, { pops: 3, fold: numFold((x, lo, hi) => lo <= x && x < hi) })
spec(OP.OP_EQUAL, { pops: 2, comm: true, total: true, fold: ([a, b]) => [bool(a.equals(b))] })
spec(OP.OP_SIZE, { pops: 1, outputs: 'size', total: true, fold: ([a]) => [a, encodeNum(a.length)] })
spec(OP.OP_INVERT, { pops: 1, total: true, fold: ([a]) => [Buffer.from(a.map(x => ~x & 0xff))] })
spec(OP.OP_AND, { pops: 2, comm: true, fold: ([a, b]) => (a.length !== b.length ? null : [Buffer.from(a.map((x, i) => x & b[i]))]) })
spec(OP.OP_OR, { pops: 2, comm: true, fold: ([a, b]) => (a.length !== b.length ? null : [Buffer.from(a.map((x, i) => x | b[i]))]) })
spec(OP.OP_XOR, { pops: 2, comm: true, fold: ([a, b]) => (a.length !== b.length ? null : [Buffer.from(a.map((x, i) => x ^ b[i]))]) })
spec(OP.OP_CAT, { pops: 2, fold: ([a, b]) => (a.length + b.length > 520 ? null : [Buffer.concat([a, b])]) })
spec(OP.OP_SPLIT, {
  pops: 2,
  outputs: 'split',
  fold: ([a, p]) => {
    const n = decodeNum(p, 4)
    if (n === null || n < 0n || n > BigInt(a.length)) return null
    return [a.slice(0, Number(n)), a.slice(Number(n))]
  }
})
spec(OP.OP_NUM2BIN, { pops: 2 })
spec(OP.OP_BIN2NUM, { pops: 1 })
spec(OP.OP_LSHIFT, { pops: 2 })
spec(OP.OP_RSHIFT, { pops: 2 })
spec(OP.OP_RIPEMD160, { pops: 1, total: true, fold: ([a]) => [H.ripemd160(a)] })
spec(OP.OP_SHA1, { pops: 1, total: true, fold: ([a]) => [H.sha1(a)] })
spec(OP.OP_SHA256, { pops: 1, total: true, fold: ([a]) => [H.sha256(a)] })
spec(OP.OP_HASH160, { pops: 1, total: true, fold: ([a]) => [H.sha256ripemd160(a)] })
spec(OP.OP_HASH256, { pops: 1, total: true, fold: ([a]) => [H.sha256sha256(a)] })
spec(OP.OP_CHECKSIG, { pops: 2 })
spec(OP.OP_VERIFY, { pops: 1, outputs: 'none' })
// Before Chronicle OP_2MUL/OP_2DIV are disabled and OP_VER is a bad opcode, so
// they always fail there. Modelling them as non-total operations is sound in
// both eras: they are never removed, and their arity only matters when they run.
spec(OP.OP_2MUL, { pops: 1 })
spec(OP.OP_2DIV, { pops: 1 })
spec(OP.OP_VER, { pops: 0 })

// Chronicle opcodes that were NOPs before activation: arity depends on era.
const CHRONICLE_SPECS = {}
CHRONICLE_SPECS[OP.OP_SUBSTR] = { pops: 3 }
CHRONICLE_SPECS[OP.OP_LEFT] = { pops: 2 }
CHRONICLE_SPECS[OP.OP_RIGHT] = { pops: 2 }
CHRONICLE_SPECS[OP.OP_LSHIFTNUM] = { pops: 2 }
CHRONICLE_SPECS[OP.OP_RSHIFTNUM] = { pops: 2 }
for (const k of Object.keys(CHRONICLE_SPECS)) {
  CHRONICLE_SPECS[k] = Object.assign({ outputs: 'one', comm: false, total: false, fold: null }, CHRONICLE_SPECS[k])
}

// Fused verify opcodes are the base op followed by OP_VERIFY, exactly as the
// interpreter implements them. 1ADD/1SUB are ADD/SUB with a constant 1 so the
// two spellings intern to the same value.
const COMPOSITE = {}
COMPOSITE[OP.OP_EQUALVERIFY] = [{ code: OP.OP_EQUAL }, { code: OP.OP_VERIFY }]
COMPOSITE[OP.OP_NUMEQUALVERIFY] = [{ code: OP.OP_NUMEQUAL }, { code: OP.OP_VERIFY }]
COMPOSITE[OP.OP_CHECKSIGVERIFY] = [{ code: OP.OP_CHECKSIG }, { code: OP.OP_VERIFY }]

const STACK_OPS = new Set([
  OP.OP_TOALTSTACK, OP.OP_FROMALTSTACK, OP.OP_2DROP, OP.OP_2DUP, OP.OP_3DUP, OP.OP_2OVER,
  OP.OP_2ROT, OP.OP_2SWAP, OP.OP_DROP, OP.OP_DUP, OP.OP_NIP, OP.OP_OVER, OP.OP_PICK,
  OP.OP_ROLL, OP.OP_ROT, OP.OP_SWAP, OP.OP_TUCK, OP.OP_NOP
])

class SymState {
  constructor (interner, { record = false, chronicle = true } = {}) {
    this.I = interner
    this.main = []
    this.alt = []
    this.D = 0 // incoming main-stack items this fragment requires
    this.A = 0 // incoming alt-stack items this fragment requires
    this.events = new Map()
    this.apps = record ? [] : null
    this.usedAlt = false
    this.chronicle = chronicle
  }

  ensure (k) {
    const need = k - this.main.length
    if (need <= 0) return
    const fresh = new Array(need)
    for (let j = 0; j < need; j++) fresh[j] = this.I.input(this.D + need - 1 - j)
    this.D += need
    this.main = fresh.concat(this.main)
  }

  ensureAlt (k) {
    const need = k - this.alt.length
    if (need <= 0) return
    const fresh = new Array(need)
    for (let j = 0; j < need; j++) fresh[j] = this.I.altInput(this.A + need - 1 - j)
    this.A += need
    this.alt = fresh.concat(this.alt)
  }

  specFor (code) {
    return SPECS[code] || (this.chronicle ? CHRONICLE_SPECS[code] : undefined)
  }

  // True if `op` can be modelled; false leaves the state untouched.
  supports (op) {
    const code = op.code
    if (code < 0) return false
    if (isPush(op)) return true
    if (STACK_OPS.has(code)) {
      if (code === OP.OP_PICK || code === OP.OP_ROLL) {
        const m = this.main
        if (m.length === 0 || !this.I.isConst(m[m.length - 1])) return false
        const n = decodeNum(this.I.constBuf(m[m.length - 1]), 4)
        return n !== null && n >= 0n && n < 4096n
      }
      return true
    }
    if (COMPOSITE[code] || code === OP.OP_1ADD || code === OP.OP_1SUB) return true
    return this.specFor(code) !== undefined
  }

  step (op) {
    if (!this.supports(op)) return false
    this._exec(op)
    return true
  }

  _exec (op) {
    const code = op.code
    const m = this.main
    if (isPush(op)) { m.push(this.I.konst(pushValue(op))); return }
    switch (code) {
      case OP.OP_NOP: return
      case OP.OP_DUP: this.ensure(1); this.main.push(this.main[this.main.length - 1]); return
      case OP.OP_DROP: this.ensure(1); this.main.pop(); return
      case OP.OP_2DROP: this.ensure(2); this.main.length -= 2; return
      case OP.OP_NIP: this.ensure(2); this.main.splice(this.main.length - 2, 1); return
      case OP.OP_OVER: this.ensure(2); this.main.push(this.main[this.main.length - 2]); return
      case OP.OP_SWAP: { this.ensure(2); const s = this.main; const l = s.length; const t = s[l - 1]; s[l - 1] = s[l - 2]; s[l - 2] = t; return }
      case OP.OP_TUCK: { this.ensure(2); const s = this.main; s.splice(s.length - 2, 0, s[s.length - 1]); return }
      case OP.OP_ROT: { this.ensure(3); const s = this.main; s.push(s.splice(s.length - 3, 1)[0]); return }
      case OP.OP_2DUP: { this.ensure(2); const s = this.main; s.push(s[s.length - 2], s[s.length - 1]); return }
      case OP.OP_3DUP: { this.ensure(3); const s = this.main; s.push(s[s.length - 3], s[s.length - 2], s[s.length - 1]); return }
      case OP.OP_2OVER: { this.ensure(4); const s = this.main; s.push(s[s.length - 4], s[s.length - 3]); return }
      case OP.OP_2ROT: { this.ensure(6); const s = this.main; s.push(...s.splice(s.length - 6, 2)); return }
      case OP.OP_2SWAP: { this.ensure(4); const s = this.main; s.push(...s.splice(s.length - 4, 2)); return }
      case OP.OP_TOALTSTACK: {
        this.ensure(1)
        const v = this.main.pop()
        this.alt.push(v)
        this.usedAlt = true
        // Alt-stack moves are recorded in order and replayed in order, so the
        // alt stack's contents never depend on how the main stack is scheduled.
        if (this.apps) this.apps.push({ code, inputs: [v], outputs: [], event: false, pinned: true, comm: false, passthrough: false })
        return
      }
      case OP.OP_FROMALTSTACK: {
        this.ensureAlt(1)
        const v = this.alt.pop()
        this.main.push(v)
        this.usedAlt = true
        if (this.apps) this.apps.push({ code, inputs: [], outputs: [v], event: false, pinned: true, comm: false, passthrough: false })
        return
      }
      case OP.OP_PICK:
      case OP.OP_ROLL: {
        const n = Number(decodeNum(this.I.constBuf(m.pop()), 4))
        this.ensure(n + 1)
        const s = this.main
        const idx = s.length - 1 - n
        const v = s[idx]
        if (code === OP.OP_ROLL) s.splice(idx, 1)
        s.push(v)
        return
      }
      case OP.OP_1ADD: this._exec({ code: OP.OP_1 }); this._apply(OP.OP_ADD, SPECS[OP.OP_ADD]); return
      case OP.OP_1SUB: this._exec({ code: OP.OP_1 }); this._apply(OP.OP_SUB, SPECS[OP.OP_SUB]); return
    }
    if (COMPOSITE[code]) {
      for (const sub of COMPOSITE[code]) this._exec(sub)
      return
    }
    this._apply(code, this.specFor(code))
  }

  _apply (code, sp) {
    this.ensure(sp.pops)
    const s = this.main
    const args = sp.pops ? s.splice(s.length - sp.pops) : []
    const I = this.I

    if (code === OP.OP_VERIFY) {
      const x = args[0]
      if (I.isConst(x) && castToBool(I.constBuf(x))) return
      const v = I.app('VERIFY', args)
      this._event(v)
      if (this.apps) this.apps.push({ code, inputs: args, outputs: [], event: true, comm: false, passthrough: false })
      return
    }

    if (sp.fold && args.every(a => I.isConst(a))) {
      const r = sp.fold(args.map(a => I.constBuf(a)))
      if (r !== null) {
        for (const b of r) s.push(I.konst(b))
        return
      }
    }

    const key = sp.comm ? args.slice().sort((a, b) => a - b) : args
    const name = String(code)
    let outputs
    if (sp.outputs === 'size') outputs = [args[0], I.app(name, key)]
    else if (sp.outputs === 'split') outputs = [I.app(name, key, 0), I.app(name, key, 1)]
    else outputs = [I.app(name, key)]
    if (!sp.total) this._event(I.app(name, key))
    for (const o of outputs) s.push(o)
    if (this.apps) {
      this.apps.push({ code, inputs: args, outputs, event: !sp.total, comm: sp.comm, passthrough: sp.outputs === 'size' })
    }
  }

  _event (id) {
    this.events.set(id, (this.events.get(id) || 0) + 1)
  }
}

// Run `ops` symbolically. Returns the final state, or null if an op cannot be
// modelled (control flow, signature-count-dependent ops, non-constant PICK...).
function run (ops, interner, opts) {
  const st = new SymState(interner, opts)
  for (const op of ops) {
    if (!st.step(op)) return null
  }
  return st
}

function padded (items, have, want, mk) {
  if (have >= want) return items
  const fresh = []
  for (let i = want - 1; i >= have; i--) fresh.push(mk(i))
  return fresh.concat(items)
}

function sameMap (a, b) {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

// Equivalence of two fragments that start at a point where at least `g` main
// and `ga` alt items are known to exist.
function equivalent (opsA, opsB, g = 0, ga = 0, opts = {}) {
  const I = new Interner()
  const a = run(opsA, I, opts)
  const b = run(opsB, I, opts)
  if (!a || !b) return false
  return statesEquivalent(a, b, g, ga)
}

function statesEquivalent (a, b, g, ga) {
  if (Math.max(a.D, g) !== Math.max(b.D, g)) return false
  if (Math.max(a.A, ga) !== Math.max(b.A, ga)) return false
  if (!sameMap(a.events, b.events)) return false
  const D = Math.max(a.D, b.D)
  const A = Math.max(a.A, b.A)
  const I = a.I
  const ma = padded(a.main, a.D, D, i => I.input(i))
  const mb = padded(b.main, b.D, D, i => I.input(i))
  const aa = padded(a.alt, a.A, A, i => I.altInput(i))
  const ab = padded(b.alt, b.A, A, i => I.altInput(i))
  return arrEq(ma, mb) && arrEq(aa, ab)
}

function arrEq (x, y) {
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

module.exports = { Interner, SymState, run, equivalent, statesEquivalent, SPECS, STACK_OPS, COMPOSITE }
