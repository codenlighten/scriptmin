'use strict'

const script = require('./script')
const { optimize, profile, Cache } = require('./optimize')
const { equivalent } = require('./symbolic')
const { proveEquivalent, differential } = require('./verify')
const { search } = require('./superopt')

module.exports = {
  optimize,
  profile,
  Cache,
  search,
  equivalent: (a, b, g = 0, ga = 0) => equivalent(script.parse(script.toBuffer(a)), script.parse(script.toBuffer(b)), g, ga),
  proveEquivalent: (a, b, opts) => proveEquivalent(script.parse(script.toBuffer(a)), script.parse(script.toBuffer(b)), opts),
  differential: (a, b, opts) => differential(script.toBuffer(a), script.toBuffer(b), opts),
  parse: script.parse,
  encode: script.encode,
  toAsm: script.toAsm,
  toBuffer: script.toBuffer
}
