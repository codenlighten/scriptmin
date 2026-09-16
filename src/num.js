'use strict'

// Script numbers: little-endian magnitude with the sign in the top bit of the
// last byte. Decoding here is deliberately strict (minimal encoding, bounded
// length) so that anything we fold at compile time decodes identically under
// every flag set and era the interpreter supports.

function decodeNum (buf, maxLen = 4) {
  if (buf.length > maxLen) return null
  if (buf.length === 0) return 0n
  const last = buf[buf.length - 1]
  if ((last & 0x7f) === 0 && (buf.length === 1 || (buf[buf.length - 2] & 0x80) === 0)) {
    return null // non-minimal (includes negative zero)
  }
  let n = 0n
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = i === buf.length - 1 ? buf[i] & 0x7f : buf[i]
    n = (n << 8n) | BigInt(b)
  }
  return (last & 0x80) ? -n : n
}

function encodeNum (n) {
  n = BigInt(n)
  if (n === 0n) return Buffer.alloc(0)
  const neg = n < 0n
  let abs = neg ? -n : n
  const bytes = []
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn))
    abs >>= 8n
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(neg ? 0x80 : 0x00)
  } else if (neg) {
    bytes[bytes.length - 1] |= 0x80
  }
  return Buffer.from(bytes)
}

function castToBool (buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) {
      return !(i === buf.length - 1 && buf[i] === 0x80)
    }
  }
  return false
}

module.exports = { decodeNum, encodeNum, castToBool }
