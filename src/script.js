'use strict'

const bsv = require('@smartledger/bsv')
const { encodeNum } = require('./num')

const OP = Object.assign({}, bsv.Opcode.map)
const NAMES = {}
for (const [name, code] of Object.entries(OP)) {
  // Prefer the canonical names over aliases (OP_FALSE, OP_TRUE, OP_NOP2...).
  if (NAMES[code] === undefined || /^OP_(FALSE|TRUE|NOP2|NOP3)$/.test(NAMES[code])) NAMES[code] = name
}
NAMES[OP.OP_CHECKLOCKTIMEVERIFY] = 'OP_CHECKLOCKTIMEVERIFY'
NAMES[OP.OP_CHECKSEQUENCEVERIFY] = 'OP_CHECKSEQUENCEVERIFY'

// An op is { code, data } for pushes, { code } otherwise. A tail op
// ({ code: TAIL, raw }) holds bytes we never touch: everything after a
// top-level OP_RETURN, or an unparseable remainder. A dead op
// ({ code: DEAD, raw }) is an `OP_0 OP_IF ... OP_ENDIF` block with no OP_ELSE
// of its own: it never executes and has no stack effect, and it is how data
// envelopes (inscriptions and similar) are carried, so it is kept verbatim too.
const TAIL = -1
const DEAD = -2

function isPush (op) {
  return op.code >= 0 && (op.code <= OP.OP_PUSHDATA4 || op.code === OP.OP_1NEGATE ||
    (op.code >= OP.OP_1 && op.code <= OP.OP_16))
}

// The bytes a push places on the stack.
function pushValue (op) {
  if (op.code === OP.OP_0) return Buffer.alloc(0)
  if (op.code === OP.OP_1NEGATE) return Buffer.from([0x81])
  if (op.code >= OP.OP_1 && op.code <= OP.OP_16) return Buffer.from([op.code - OP.OP_1 + 1])
  return op.data
}

function opSize (op) {
  if (op.code === TAIL || op.code === DEAD) return op.raw.length
  if (op.code === OP.OP_0 || op.code > OP.OP_PUSHDATA4) return 1
  if (op.code < OP.OP_PUSHDATA1) return 1 + op.data.length
  if (op.code === OP.OP_PUSHDATA1) return 2 + op.data.length
  if (op.code === OP.OP_PUSHDATA2) return 3 + op.data.length
  return 5 + op.data.length
}

function opsSize (ops) {
  let n = 0
  for (const op of ops) n += opSize(op)
  return n
}

// Smallest push that places `buf` on the stack.
function pushOp (buf) {
  const len = buf.length
  if (len === 0) return { code: OP.OP_0 }
  if (len === 1 && buf[0] >= 1 && buf[0] <= 16) return { code: OP.OP_1 + buf[0] - 1 }
  if (len === 1 && buf[0] === 0x81) return { code: OP.OP_1NEGATE }
  if (len < OP.OP_PUSHDATA1) return { code: len, data: buf }
  if (len <= 0xff) return { code: OP.OP_PUSHDATA1, data: buf }
  if (len <= 0xffff) return { code: OP.OP_PUSHDATA2, data: buf }
  return { code: OP.OP_PUSHDATA4, data: buf }
}

function pushCost (buf) {
  return opSize(pushOp(buf))
}

function numOp (n) {
  return pushOp(encodeNum(n))
}

// Where the `OP_0 OP_IF` block whose OP_IF sits at `i` ends (the index after
// its OP_ENDIF), or -1 if it is not a dead block: it has an OP_ELSE of its own
// (that branch runs), no matching OP_ENDIF, or a truncated push.
function deadBlockEnd (buf, i) {
  let depth = 0
  while (i < buf.length) {
    const code = buf[i++]
    if (code > 0 && code <= OP.OP_PUSHDATA4) {
      let len = code
      if (code >= OP.OP_PUSHDATA1) {
        const w = code === OP.OP_PUSHDATA1 ? 1 : code === OP.OP_PUSHDATA2 ? 2 : 4
        if (i + w > buf.length) return -1
        len = w === 1 ? buf[i] : w === 2 ? buf.readUInt16LE(i) : buf.readUInt32LE(i)
        i += w
      }
      if (i + len > buf.length) return -1
      i += len
      continue
    }
    if (code === OP.OP_IF || code === OP.OP_NOTIF || code === OP.OP_VERIF || code === OP.OP_VERNOTIF) depth++
    else if (code === OP.OP_ELSE && depth === 1) return -1
    else if (code === OP.OP_ENDIF && --depth === 0) return i
  }
  return -1
}

function parse (buf, { deadBlocks = true } = {}) {
  const ops = []
  let i = 0
  let depth = 0
  while (i < buf.length) {
    const start = i
    const code = buf[i++]
    if (code > 0 && code <= OP.OP_PUSHDATA4) {
      let len
      if (code < OP.OP_PUSHDATA1) {
        len = code
      } else {
        const w = code === OP.OP_PUSHDATA1 ? 1 : code === OP.OP_PUSHDATA2 ? 2 : 4
        if (i + w > buf.length) { ops.push({ code: TAIL, raw: buf.slice(start) }); break }
        len = w === 1 ? buf[i] : w === 2 ? buf.readUInt16LE(i) : buf.readUInt32LE(i)
        i += w
      }
      if (i + len > buf.length) { ops.push({ code: TAIL, raw: buf.slice(start) }); break }
      ops.push({ code, data: Buffer.from(buf.slice(i, i + len)) })
      i += len
      continue
    }
    if (deadBlocks && code === OP.OP_IF && start > 0 && buf[start - 1] === OP.OP_0 &&
        ops.length && ops[ops.length - 1].code === OP.OP_0) {
      const end = deadBlockEnd(buf, start)
      if (end > 0) {
        ops.pop()
        ops.push({ code: DEAD, raw: Buffer.from(buf.slice(start - 1, end)) })
        i = end
        continue
      }
    }
    ops.push({ code })
    if (code === OP.OP_IF || code === OP.OP_NOTIF || code === OP.OP_VERIF || code === OP.OP_VERNOTIF) depth++
    else if (code === OP.OP_ENDIF) depth--
    else if (code === OP.OP_RETURN && depth === 0) {
      // Nothing after a top-level OP_RETURN executes, and it is often data
      // that indexers read. Keep it byte-for-byte.
      if (i < buf.length) ops.push({ code: TAIL, raw: buf.slice(i) })
      break
    }
  }
  return ops
}

function encode (ops) {
  const parts = []
  for (const op of ops) {
    if (op.code === TAIL || op.code === DEAD) { parts.push(op.raw); continue }
    if (op.code === OP.OP_0 || op.code > OP.OP_PUSHDATA4) { parts.push(Buffer.from([op.code])); continue }
    const len = op.data.length
    let head
    if (op.code < OP.OP_PUSHDATA1) head = Buffer.from([op.code])
    else if (op.code === OP.OP_PUSHDATA1) head = Buffer.from([op.code, len])
    else if (op.code === OP.OP_PUSHDATA2) { head = Buffer.alloc(3); head[0] = op.code; head.writeUInt16LE(len, 1) } else { head = Buffer.alloc(5); head[0] = op.code; head.writeUInt32LE(len, 1) }
    parts.push(head, op.data)
  }
  return Buffer.concat(parts)
}

function opName (code) {
  return NAMES[code] || ('OP_UNKNOWN' + code)
}

function toAsm (ops, { maxData = 0 } = {}) {
  return ops.map(op => {
    if (op.code === TAIL) return `<tail ${op.raw.length} bytes>`
    if (op.code === DEAD) return toAsm(parse(op.raw, { deadBlocks: false }), { maxData })
    if (op.code === OP.OP_0) return 'OP_0'
    if (op.code > 0 && op.code <= OP.OP_PUSHDATA4) {
      const hex = op.data.toString('hex')
      const shown = maxData && hex.length > maxData * 2 ? hex.slice(0, maxData * 2) + '…' : hex
      return op.code >= OP.OP_PUSHDATA1 ? `${opName(op.code)}:${shown}` : shown
    }
    return opName(op.code)
  }).join(' ')
}

// Accepts a Buffer, hex, or ASM (bsv's format: data as bare hex, opcodes by name).
function toBuffer (input) {
  if (Buffer.isBuffer(input)) return input
  const text = String(input).trim()
  if (text === '') return Buffer.alloc(0)
  if (/^([0-9a-fA-F]{2})+$/.test(text.replace(/\s+/g, '')) && !/\bOP_/.test(text)) {
    return Buffer.from(text.replace(/\s+/g, ''), 'hex')
  }
  return bsv.Script.fromASM(text.replace(/\s+/g, ' ')).toBuffer()
}

function sameOp (a, b) {
  if (a.code !== b.code) return false
  if (a.code === TAIL || a.code === DEAD) return a.raw.equals(b.raw)
  if (a.data || b.data) return !!a.data && !!b.data && a.data.equals(b.data)
  return true
}

module.exports = {
  OP, TAIL, DEAD, isPush, pushValue, opSize, opsSize, pushOp, pushCost, numOp,
  parse, encode, toAsm, toBuffer, opName, sameOp
}
