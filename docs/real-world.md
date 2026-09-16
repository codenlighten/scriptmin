# Real-world results: script-high-level-modules

[script-high-level-modules](https://github.com/codenlighten) is a library of
BSV Script modules, from field arithmetic through a full BLS12-381 pairing and
a Groth16 verifier. Its `pairing.miller(63)` ran on mainnet as a 333 KB locking
script. The modules are already optimized by hand: lazy reduction, hoisted
constants, altstack clears, consumption at last use (its `docs/optimization.md`
describes each technique with before/after measurements).

So this is the hard case for a minimizer: code that has already been tuned.

## Method

`examples/script-modules.js` does this for each module:

1. Emit the module on its own, exactly as the library's `moduleSize` does.
2. Optimize it with `scriptmin` (default effort). The whole-script symbolic
   proof must pass.
3. Splice the optimized module back in front of the library's **own test
   assertions**, which compare every output with the module's model and check
   the caller's stack is untouched.
4. Run every honest case and every refusal case on the interpreter under the
   library's relay policy flags (MINIMALDATA, CLEANSTACK and the rest). Honest
   cases must still pass. Refusal cases must still be refused.

Modules that read their spending transaction (`tx.*`, `totp` variants that
use locktime) are skipped: their scripts are committed to by their own
witness.

## Results

| module | original | scriptmin | saved |
| --- | ---: | ---: | ---: |
| **pairing.miller63** | **333,031** | **229,981** | **30.9%** |
| fp12.powX | 98,985 | 72,802 | 26.5% |
| fp12.powXc | 73,674 | 55,352 | 24.9% |
| sha256.block | 49,181 | 38,304 | 22.1% |
| g1.inSubgroup | 8,530 | 8,095 | 5.1% |
| fp12.inv | 3,523 | 2,457 | 30.3% |
| fp12.mul | 3,248 | 2,413 | 25.7% |
| fp12.sqr | 2,375 | 1,701 | 28.4% |
| fp12.mulLine | 2,178 | 1,536 | 29.5% |
| fp12.cycSqr | 1,342 | 1,020 | 24.0% |
| fp12.frob | 798 | 647 | 18.9% |
| fp6.mul | 791 | 565 | 28.6% |
| g2.stepAdd | 598 | 493 | 17.6% |
| g2.stepDouble | 587 | 477 | 18.7% |
| fp6.sqr | 500 | 348 | 30.4% |
| g2.inSubgroup | 444 | 414 | 6.8% |
| totp.verify | 269 | 266 | 1.1% |
| fp12.conj | 223 | 182 | 18.4% |
| schnorr.liftX | 208 | 201 | 3.4% |
| g2.onCurve | 205 | 178 | 13.2% |
| fp6.sub | 179 | 124 | 30.7% |
| ec.add | 167 | 152 | 9.0% |
| fp6.add | 164 | 107 | 34.8% |
| ec.double | 153 | 139 | 9.2% |
| fp2.mul | 69 | 54 | 21.7% |
| fp2.inv | 67 | 53 | 20.9% |
| u32.add, bytes.*, hmac.*, u32 rotations | | | 0% |

Every row: proof passed, every honest case passed, every refusal case refused.
The 333 KB Miller loop takes about 40 seconds.

`pairing.miller63` by pass: stack scheduling −58,864, peephole −41,639,
superoptimizer −2,547.

## What the minimizer found

The peephole share is large, and the rules that fire point at specific
emitter habits that an emit-time rewrite in `Asm` would remove at the source:

| pattern | example saving |
| --- | --- |
| `OP_SWAP OP_SWAP` | 310 of 835 bytes saved in `fp12.mul`, 58 in `g2.stepDouble` |
| `OP_SWAP` before a commutative op (`ADD`, `MUL`, ...) | 137 bytes in `g1.inSubgroup` |
| `OP_1 OP_SUB` instead of `OP_1SUB` | 136 bytes in `g1.inSubgroup` |
| `OP_FROMALTSTACK OP_TOALTSTACK` | 32 bytes in `fp12.mul` |
| `3 OP_PICK 3 OP_PICK` instead of `OP_2OVER` | throughout the tower |

The `SWAP SWAP` pairs look like composition artifacts: one module leaves its
result in the order its caller's convention needs, and the next module swaps it
straight back.

The rest is stack scheduling. Rebuilding choreography from the dataflow finds
moves where copies and later drops were emitted, and shallower access paths,
across module boundaries that hand-optimization inside a module cannot see.

## Where it found nothing

`u32.add`, `bytes.reverse`, `hmac.*` and the `u32` rotations did not shrink.
They are short, dominated by `OP_SPLIT`/`OP_CAT`/byte shuffling whose
choreography is already minimal, or small enough that the scheduler's generic
output is no better than the hand-written one.
