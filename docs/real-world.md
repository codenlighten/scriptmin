# Real-world results: script-high-level-modules

[script-high-level-modules](https://github.com/codenlighten/script-high-level-modules) is a library of
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
| **pairing.finalExp** | 473,562 | 284,713 | 39.9% |
| **pairing.miller63** | 333,031 | 199,147 | 40.2% |
| fp12.powX | 98,985 | 62,631 | 36.7% |
| fp12.powXc | 73,674 | 48,494 | 34.2% |
| sha256.block | 49,181 | 38,304 | 22.1% |
| g1.inSubgroup | 8,530 | 7,683 | 9.9% |
| fp12.inv | 3,523 | 2,214 | 37.2% |
| fp12.mul | 3,248 | 2,207 | 32.0% |
| fp12.sqr | 2,375 | 1,538 | 35.2% |
| fp12.mulLine | 2,178 | 1,451 | 33.4% |
| fp12.cycSqr | 1,342 | 1,000 | 25.5% |
| fp12.frob | 798 | 630 | 21.1% |
| fp6.mul | 791 | 541 | 31.6% |
| g2.stepAdd | 598 | 471 | 21.2% |
| g2.stepDouble | 587 | 454 | 22.7% |
| fp6.sqr | 500 | 336 | 32.8% |
| g2.inSubgroup | 444 | 411 | 7.4% |
| totp.verify | 269 | 266 | 1.1% |
| fp12.conj | 223 | 176 | 21.1% |
| schnorr.liftX | 208 | 201 | 3.4% |
| g2.onCurve | 205 | 176 | 14.2% |
| fp6.sub | 179 | 124 | 30.7% |
| ec.add | 167 | 152 | 9.0% |
| fp6.add | 164 | 107 | 34.8% |
| ec.double | 153 | 136 | 11.1% |
| g1.onCurve | 85 | 80 | 5.9% |
| fp6.mulV | 80 | 48 | 40.0% |
| fp2.mul | 69 | 54 | 21.7% |
| fp2.inv | 67 | 53 | 20.9% |
| fp2.sub | 47 | 36 | 23.4% |
| fp2.add | 43 | 31 | 27.9% |
| fp2.sqr | 42 | 28 | 33.3% |
| fp2.mulFp | 36 | 25 | 30.6% |
| fp2.mulXi | 32 | 21 | 34.4% |
| int.modexp | 31 | 21 | 32.3% |
| sha256.Sigma0 | 31 | 27 | 12.9% |
| sha256.Sigma1 | 31 | 27 | 12.9% |
| fp2.neg | 28 | 21 | 25.0% |
| int.modinv | 27 | 16 | 40.7% |
| sha256.sigma0 | 25 | 22 | 12.0% |
| sha256.sigma1 | 25 | 22 | 12.0% |
| fp2.conj | 24 | 15 | 37.5% |
| int.modsub | 22 | 15 | 31.8% |
| int.modadd | 20 | 13 | 35.0% |
| int.modmul | 20 | 13 | 35.0% |
| u32.maj | 17 | 13 | 23.5% |
| u32.ch | 9 | 8 | 11.1% |
| bytes.reverse, bytes.beToNum, u32.rotr, u32.shr, u32.xor, u32.add, hmac.sha256, hmac.sha1 | | | 0% |

Every row: proof passed, every honest case passed, every refusal case refused.
All 55 modules together: 1,056,231 → 654,677 bytes (−38.0%). On an idle machine the 333 KB Miller loop takes about a minute and the final
exponentiation (473 KB as emitted today) about two and a half. Together, one
full pairing goes from 806,593 to 483,860 bytes (−40.0%).

`pairing.miller63` by pass: stack scheduling −92,071, peephole −41,432,
superoptimizer −381.

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

About 25 KB of that is the alt stack. The modules park temporaries there
(`OP_TOALTSTACK` … `OP_FROMALTSTACK`) because inside one module that is the cheap
way to clear them. Once the whole region is rescheduled, most of those round
trips are unnecessary: when a region leaves the alt stack as it found it, the
scheduler also tries keeping those values on the main stack. That alone took
the Miller loop from 229,981 to 205,273 bytes.

The last few percent come from not scheduling greedily. The remaining cost
is dominated by fetching the modulus, `<n> OP_PICK OP_MOD`, two bytes each,
tens of thousands of times per stage. When p sits directly below the value
being reduced that fetch is a one-byte `OP_OVER`, but getting it there means
rolling p up *before* an operation that does not use it, which a greedy
scheduler never has a reason to do. A beam search over the scheduler's choices
(operand order, what to roll up, including the value the next few operations
need most) finds those moments: the Miller loop from 205,273 to 199,147 bytes,
`fp12.powX` from 65,493 to 62,631.

## Where it found nothing

`u32.add`, `bytes.reverse`, `hmac.*` and the `u32` rotations did not shrink.
They are short, dominated by `OP_SPLIT`/`OP_CAT`/byte shuffling whose
choreography is already minimal, or small enough that the scheduler's generic
output is no better than the hand-written one.

## On mainnet

The module library's chain tooling can build its stage scripts through
scriptmin (`SCRIPTMIN=1`, see its `src/minimize.js`). Its two-transaction
BLS12-381 pairing chain was redeployed that way:

| | as first deployed | minimized |
| --- | ---: | ---: |
| Miller-loop stage script | 344,840 B | 206,795 B |
| final-exponentiation stage script | 476,067 B | 297,263 B |
| fees for the whole chain | 165,942 sat | 102,572 sat |

Funding [`7948b2a3…`](https://whatsonchain.com/tx/7948b2a31e07484ba764e2c69fd9e923e10e5ab406f3abea9a8767e04d117902),
Miller loop [`282bf493…`](https://whatsonchain.com/tx/282bf49356d28c986b685081e45ed29d92c16ccdcccb642c446ce0a392594307),
final exponentiation [`016ce0cc…`](https://whatsonchain.com/tx/016ce0cc88a3bf4764f8f3d7108129d8229742bd1048241ca6fe71642c4e2d2d).
The library's chain walker rebuilds both stages through the recorded scriptmin
commit, finds them in the funding transaction byte for byte, and checks that
the final carrier holds e(P, Q).
