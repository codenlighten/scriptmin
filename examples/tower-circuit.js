'use strict'

// Extension-field tower arithmetic written straight from textbook formulas,
// the shape of a pairing verifier's Miller loop: Fp2 = Fp[u]/(u^2+1),
// Fp6 = Fp2[v]/(v^3-xi) with xi = 9+u, Fp12 = Fp6[w]/(w^2-v).
// Nothing is shared between formulas, so the same products are recomputed
// the way a first-cut generator would.

class Builder {
  constructor (inputs) {
    this.inputs = inputs
    this.gates = []
  }

  gate (g) { this.gates.push(g); return this.inputs + this.gates.length - 1 }
  add (a, b) { return this.gate({ op: 'add', a, b }) }
  sub (a, b) { return this.gate({ op: 'sub', a, b }) }
  mul (a, b) { return this.gate({ op: 'mul', a, b }) }
  mulc (a, k) { return this.gate({ op: 'mulc', a, k }) }

  // Fp2: [c0, c1]
  add2 (a, b) { return [this.add(a[0], b[0]), this.add(a[1], b[1])] }
  mul2 (a, b) {
    return [
      this.sub(this.mul(a[0], b[0]), this.mul(a[1], b[1])),
      this.add(this.mul(a[0], b[1]), this.mul(a[1], b[0]))
    ]
  }

  // multiply by xi = 9 + u
  xi2 (a) { return [this.sub(this.mulc(a[0], 9), a[1]), this.add(this.mulc(a[1], 9), a[0])] }

  // Fp6: [a0, a1, a2] of Fp2
  add6 (a, b) { return [this.add2(a[0], b[0]), this.add2(a[1], b[1]), this.add2(a[2], b[2])] }
  mul6 (a, b) {
    const c0 = this.add2(this.mul2(a[0], b[0]), this.xi2(this.add2(this.mul2(a[1], b[2]), this.mul2(a[2], b[1]))))
    const c1 = this.add2(this.add2(this.mul2(a[0], b[1]), this.mul2(a[1], b[0])), this.xi2(this.mul2(a[2], b[2])))
    const c2 = this.add2(this.add2(this.mul2(a[0], b[2]), this.mul2(a[1], b[1])), this.mul2(a[2], b[0]))
    return [c0, c1, c2]
  }

  // multiply by v: (x0, x1, x2) -> (xi*x2, x0, x1)
  v6 (a) { return [this.xi2(a[2]), a[0], a[1]] }

  // Fp12: [a0, a1] of Fp6
  mul12 (a, b) {
    return [
      this.add6(this.mul6(a[0], b[0]), this.v6(this.mul6(a[1], b[1]))),
      this.add6(this.mul6(a[0], b[1]), this.mul6(a[1], b[0]))
    ]
  }
}

const flat12 = x => x.flat(2)

function fp12Input (offset) {
  const v = i => offset + i
  return [
    [[v(0), v(1)], [v(2), v(3)], [v(4), v(5)]],
    [[v(6), v(7)], [v(8), v(9)], [v(10), v(11)]]
  ]
}

// f <- f^2 * g, `steps` times: 24 inputs, 12 outputs.
function millerLikeCircuit (steps) {
  const b = new Builder(24)
  let f = fp12Input(0)
  const g = fp12Input(12)
  for (let i = 0; i < steps; i++) f = b.mul12(b.mul12(f, f), g)
  return { inputs: 24, gates: b.gates, outputs: flat12(f) }
}

// The circuit as scriptmin IR, for `scriptmin compile`.
function toIR (circuit, modulus) {
  return {
    modulus: '0x' + modulus.toString(16),
    inputs: circuit.inputs,
    gates: circuit.gates.map(g => (g.k !== undefined ? Object.assign({}, g, { k: String(g.k) }) : g)),
    outputs: circuit.outputs
  }
}

module.exports = { Builder, millerLikeCircuit, toIR }

if (require.main === module) {
  const { P } = require('./naive-field-compiler')
  process.stdout.write(JSON.stringify(toIR(millerLikeCircuit(Number(process.argv[2] || 1)), P)) + '\n')
}
