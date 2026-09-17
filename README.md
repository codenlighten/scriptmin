# scriptmin

A Bitcoin Script minimizer. It takes a working script and returns a smaller
one that does exactly the same thing, then proves that it does.

The objective is serialized bytes, not opcode count: `<257> OP_PICK` is four
bytes, `OP_2DUP` is one.

```
$ scriptmin -o field-6000.min.hex field-6000.hex
Original:         93,167 bytes
Minimized:        58,481 bytes
Saved:            34,686 bytes
Reduction:        37.23%

Breakdown:
  stack-scheduling            -33,358
  peephole                     -1,096
  superoptimizer                 -232

By what the bytes were doing:
  stack                        79,593 ->       44,939  (-34,654)
  arithmetic                   13,541 ->       13,509  (-32)

Verification:
  symbolic proof         passed (1 regions, 0 barriers)
  interpreter tests      passed (100 runs, 38 ran to success)
```

On a real, hand-optimized BLS12-381 Miller loop (the 333 KB script that ran on
mainnet) it removes **40%**, 333,031 → 199,147 bytes, and every test case of the
library it came from still passes. See [docs/real-world.md](docs/real-world.md).

Built on [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv)
for script parsing, hashing and the reference interpreter used in testing.

## Install

```bash
npm install
npm test
npx scriptmin --help
```

Requires Node 20.19+ (the version `@smartledger/bsv` needs). `@smartledger/bsv` is a
peer dependency: a project that already uses it shares its copy.

## Command line

```bash
scriptmin script.hex                     # optimize, print report and hex
scriptmin -o min.hex script.hex          # write the result
scriptmin --asm -o min.asm script.asm    # ASM in, ASM out
scriptmin --profile script.hex           # where the bytes go
scriptmin --explain script.hex           # every rewrite, largest first
scriptmin --json script.hex              # machine-readable report
scriptmin --effort high script.hex       # wider windows, deeper search
scriptmin --db patterns.json script.hex  # reuse and grow a pattern database
scriptmin --stacks inputs.json script.hex  # test against real unlocking stacks
scriptmin compile circuit.json           # compile a prime-field circuit (see below)
scriptmin relax --modulus <p> script.hex # re-reduce existing field arithmetic lazily
```

Input can be hex, ASM in bsv's format (`OP_DUP 14 OP_PICK`, data as bare hex),
or raw bytes with `--binary`. `-` reads stdin.

### Profile

```
$ scriptmin --profile field-300.hex
4,353 bytes, 3,552 ops

  stack                           3,644   83.71%
  arithmetic                        676   15.53%
  data pushes                        33    0.76%

PICK/ROLL depths (constant indices):
  depth            PICK       ROLL
  0-3               110         10
  4-15              351        299
  16-63             122          0
  64-255            335          0
  256+               58          0

Most expensive repeated patterns:
       1,196 bytes      299x  ROLL DROP OP_4 ROLL
       ...
```

The index push in front of `OP_PICK`/`OP_ROLL` is counted as stack movement,
not as a constant.

## What it does

The script is split into **regions** the symbolic engine can model, separated
by **barriers** it cannot: `OP_IF`/`OP_ELSE`/`OP_ENDIF`, `OP_CHECKMULTISIG`,
`OP_DEPTH`, `OP_CODESEPARATOR`, a `PICK` whose index is computed at runtime,
and so on. Barriers are never modified and nothing crosses them. Everything
after a top-level `OP_RETURN` is kept byte for byte.

Each region goes through these passes, repeated while they keep finding savings:

| Pass | What it does |
| --- | --- |
| **push-encoding** | Re-encodes non-minimal pushes (`OP_PUSHDATA1 01 05` becomes `OP_5`). |
| **peephole** | Fixed rules: `OP_SWAP OP_ADD` becomes `OP_ADD`, `OP_EQUAL OP_VERIFY` becomes `OP_EQUALVERIFY`, `OP_1 OP_PICK` becomes `OP_OVER`, and so on. |
| **stack-scheduling** | Lifts the region to its dataflow (which operations run on which values, and what must be left on the stack), then regenerates all the stack movement using liveness. A value's last use becomes a move (`ROLL`/`ROT`/`SWAP`) instead of a copy followed by a drop later. Dead values are dropped when they surface. Operations that cannot fail and whose results are never used are removed. Operand order is picked by cost for commutative ops. Large constants are pushed once and then copied. Alt-stack moves are replayed in their original order, and a value parked on the alt stack is not also kept on the main stack. Deep values that are still needed several times (a field modulus, say) are rolled to the top once so later uses are shallow copies; the scheduler runs under several such policies and keeps the smallest result. Repeated expressions are computed once and kept alive (common subexpression elimination), tried against recomputation. At `medium` and `high` effort a beam search over the scheduler's own choices (operand order, what to roll up, including the value the next few operations need most) replaces a single greedy pass where the stack stays shallow enough for it to be affordable. |
| **superoptimizer** | For every short window of pure stack code, computes the stack transformation and finds the cheapest sequence producing it. A table of every stack-op sequence up to 5 bytes (6 at `--effort high`) answers most windows instantly. An A\* search handles windows with constants or the alt stack. Non-overlapping replacements are chosen by dynamic programming. |
| **constant-folding** | Superoptimizer windows over constant operands (`OP_3 OP_5 OP_ADD` becomes `OP_8`, including hashes, `CAT`, `SPLIT` and numeric comparisons). |

`--effort low|medium|high` sets the window length, table depth, search budget,
how many chunkings the scheduler tries, and the beam width (none, 4, 8).

### Pattern database

`--db patterns.json` stores every window solution keyed by the window's bytes
and the facts that constrain its replacement. Later runs look solutions up
instead of searching. The database grows as you optimize more scripts.

## Correctness

Every rewrite is checked before it is applied, and the whole result is checked
again at the end. There are two independent checks.

**Symbolic proof** (always on unless `--no-verify`). Each region of the
original and optimized script runs on a symbolic stack. Every value is an input
slot, a constant, or an operation applied to other values, with commutative
operands normalized. Two regions are equivalent when:

1. **They require the same stack depth.** The optimized region fails on a
   too-short stack exactly when the original does. The analysis tracks how many
   items are guaranteed to exist at each point, including across `IF`/`ELSE`
   branches, so `OP_1 OP_DUP OP_DROP` becomes `OP_1` while a bare
   `OP_DUP OP_DROP` at the start of a script is kept. There it is what makes an
   empty stack fail.
2. **They leave identical symbolic main and alt stacks.**
3. **They evaluate the same set of operations that can fail.** Arithmetic
   can fail on oversized numbers, `DIV` on zero, `VERIFY` on false. Script
   failure is all-or-nothing and every such operation is deterministic, so a
   check may move, and a repeated identical check may run once, but no
   distinct check may disappear. Operations that cannot fail (`EQUAL`, `SIZE`,
   hashes, `INVERT`) may be removed when their results are unused.

The barrier sequences of the two scripts must be identical. If the proof fails,
`optimize` throws instead of returning a script.

**Interpreter tests** (`--tests N`, default 100). Both scripts run on the
`@smartledger/bsv` interpreter with random starting stacks, plus any you supply
with `--stacks`. Success, final stack and final alt stack must match. Random
stacks rarely get past a script's first real check, so for large verifiers pass
realistic unlocking stacks with `--stacks`.

### Assumptions and caveats

- **Target rules are current BSV consensus (post-Genesis, post-Chronicle).**
  Chronicle opcodes (`OP_SUBSTR`, `OP_LEFT`, `OP_RIGHT`, `OP_LSHIFTNUM`,
  `OP_RSHIFTNUM`) are modelled with their Chronicle stack effects. Use
  `--no-chronicle` to treat them as barriers.
- **Signatures commit to the script.** `OP_CHECKSIG` signs the script code, so
  signatures and OP_PUSH_TX preimages must be created against the optimized
  script. A covenant that embeds its own script hash, length or bytes must be
  regenerated. The report warns when a script checks signatures.
- **Pre-Genesis limits are not preserved.** These are the 1,000-item stack limit
  and the 201-opcode limit, and optimized code can build a deeper intermediate
  stack.
- **Constant folding only reads minimally encoded operands of at most 4 bytes.**
  Those decode identically in every era, with or without `MINIMALDATA`.
- **Push re-encoding changes behaviour only under the `MINIMALDATA` policy
  flag,** where the original script would already have failed.

## Circuit compiler

Once arithmetic has been emitted as Script, the optimizer cannot know that
values only matter modulo p. A circuit carries that information, so
`scriptmin compile` starts from one and uses **lazy reduction**: sums,
differences, constant multiples and products are left unreduced while they
fit in a bit budget, and a value is reduced only when it would outgrow the
budget or must be canonical (outputs and equality checks). The program then
goes through the stack optimizer like any other script.

```
$ scriptmin compile examples/ir/fp12-step.json
Gates:                           624
Reduce every operation:        3,779 bytes (stack-optimized)
Lazy reduction (1024 bits):      2,173 bytes
Saved by lazy reduction:       1,606 bytes (42.50%)

Checked against the circuit on 22 input vectors (all zeros, all p-1, random).
Stack optimization of the lazy program: proof passed.
```

Circuit format:

```json
{
  "modulus": "0x3fff...ff81",
  "inputs": 24,
  "gates": [
    { "op": "mul", "a": 0, "b": 1 },
    { "op": "sub", "a": 24, "b": 2 },
    { "op": "mulc", "a": 25, "k": "9" },
    { "op": "const", "v": "5" },
    { "op": "assertEqual", "a": 26, "b": 27 }
  ],
  "outputs": [26]
}
```

Values `0 … inputs-1` are the inputs (first input deepest on the stack, each
assumed to be in `[0, p)`), and value `inputs + j` is the result of gate `j`.
Outputs are left on the stack canonical, first output deepest.

The bit budget trades script size against number size. On a four-step Fp12
chain (`f ← f² · g`):

| budget | bytes | interpreter time |
| ---: | ---: | ---: |
| reduce every op | 14,654 | 101 ms |
| 512 bits | 9,924 | 58 ms |
| 1,024 bits (default) | 8,598 | 65 ms |
| 2,048 bits | 8,324 | 104 ms |

Moderate budgets are smaller *and* faster, because most `OP_MOD`s disappear.

**Verification is different here.** A lazily reduced program computes
different intermediate integers, so it is not proven equivalent symbolically
to the reference. Instead both are run on the interpreter and compared with
the circuit's exact results: all-zero inputs, all `p-1` inputs, and random
field elements (`--tests`). For circuits of additions, subtractions and
multiplications, a program that is wrong as a polynomial map disagrees at a
random point with probability at least 1 − degree/p (Schwartz–Zippel), which
is overwhelming for a 254-bit prime. The stack optimization applied afterwards
is still proven symbolically. Inputs outside `[0, p)` are not range-checked:
that remains the verifier's responsibility, as with any field circuit.

## Relaxing field arithmetic

`scriptmin relax` works on scripts that already exist. A script composed from
modules that each return canonical field elements reduces after almost every
addition, because every module boundary promises canonical output. relax lifts
the script back to its circuit, drops every reduction by p, and compiles the
circuit again with lazy reduction.

```bash
scriptmin relax --modulus 0x1a0111ea…aaab fp12-mul.hex
scriptmin relax --modulus 0x1a0111ea…aaab --modulus-input fp12-mul.hex   # take p from the stack
```

- **What it accepts.** The script may use only pushes, stack moves, `OP_ADD`,
  `OP_SUB`, `OP_MUL`, `OP_MOD` by the one constant prime, and constant range
  checks on its inputs (`OP_WITHIN OP_VERIFY`). It refuses anything else.
- **Why dropping reductions is safe.** Ring operations preserve congruence mod
  p, so every value of the relaxed circuit is congruent to the original's. The
  outputs are reduced to canonical form.
- **What equality then needs.** The relaxed outputs equal the original's
  exactly when the original's outputs are canonical for canonical inputs. That
  is what a field module promises, and relax checks it on the interpreter:
  all-zero, all-(p−1) and random canonical inputs must give identical stacks,
  and out-of-range inputs must be refused by both.
- **Range checks.** They are kept and moved to the front of the script.

On the BLS12-381 tower of
[script-high-level-modules](docs/real-world.md), in the form those modules take
inside a pairing (inputs already known canonical, p on the stack):

| module | scriptmin | relaxed | `OP_MOD` |
| --- | ---: | ---: | ---: |
| fp12.mul | 2,032 | 1,493 | 188 → 27 |
| fp12.cycSqr | 917 | 665 | 98 → 24 |

Interpreter time drops less than the reduction count, 11–22%, because
unreduced operands make each `OP_MUL` larger. Where a module multiplies by large
constants (the Frobenius maps) relaxing makes it bigger, so it is a choice to
measure per module, not a pass to apply blindly.

## Library

```js
const { optimize, profile, proveEquivalent, differential, Cache } = require('scriptmin')

const { script, ops, report } = optimize(hexOrAsmOrBuffer, {
  effort: 'medium',      // 'low' | 'medium' | 'high'
  differential: 100,     // interpreter test runs, 0 to skip
  stacks: [],            // extra starting stacks (arrays of Buffers)
  verify: true,          // symbolic proof
  chronicle: true,
  cache: new Cache()     // share across calls to reuse solutions
})

report.saved            // bytes
report.passes           // [{ name, saved }]
report.byCategory       // [{ name, before, after, saved }]  stack, arithmetic, data pushes...
report.rewrites         // [{ pass, rule?, before, after, saved, regionOffset }]
report.verification     // { symbolic, differential }

profile(script)                    // categories, opcodes, PICK/ROLL depths, costly patterns
proveEquivalent(a, b)              // { ok, regions, barriers } or { ok: false, reason }
differential(a, b, { runs: 500 })  // { ok, runs, succeeded } or a counterexample
```

## Benchmarks

Two circuit generators compile modular arithmetic over a 254-bit modulus into
Script. Each benchmark optimizes the output, checks the symbolic proof, and
runs both scripts on the interpreter with random field elements, comparing
against the circuit's exact results.

- `examples/tower-circuit.js`: Fp2 → Fp6 → Fp12 tower multiplication from
  textbook formulas, chained as `f ← f² · g` like a Miller loop.
- `examples/naive-field-compiler.js`: random circuits, plus the compiler
  both benchmarks use. By default it fetches every operand with `OP_PICK`
  and cleans up at the end. With `lastUse` it already `OP_ROLL`s each value
  at its last use, which is a much stronger baseline.

Fp12 tower chains (`node examples/bench-tower.js 1,4 medium lastuse`):

| steps | gates | baseline | original | optimized | reduction |
| ---: | ---: | --- | ---: | ---: | ---: |
| 1 | 624 | PICK everything | 9,530 | 3,861 | 59.5% |
| 1 | 624 | ROLL at last use | 6,178 | 3,861 | 37.5% |
| 4 | 2,496 | PICK everything | 38,516 | 15,342 | 60.2% |
| 4 | 2,496 | ROLL at last use | 24,844 | 15,342 | 38.3% |

Random circuits, modulus fetched with `OP_PICK` (`npm run bench`):

| gates | baseline | original | optimized | reduction | time |
| ---: | --- | ---: | ---: | ---: | ---: |
| 500 | PICK everything | 7,433 | 4,370 | 41.2% | 0.8s |
| 500 | ROLL at last use | 5,582 | 4,370 | 21.7% | |
| 6,000 | PICK everything | 93,167 | 58,481 | 37.2% | 2.9s |
| 6,000 | ROLL at last use | 77,714 | 58,481 | 24.7% | |
| 25,000 | PICK everything | 388,659 | 245,717 | 36.8% | 15.4s |

Both baselines optimize to the same bytes: the scheduler rebuilds the stack
choreography from the dataflow, so the compiler's own choices do not matter.

When the compiler re-pushes the 33-byte modulus at every reduction instead of
fetching it (`node examples/bench.js 6000 medium push`), a 312 KB script drops
to 58 KB.

These are generated benchmarks. Hand-tuned scripts will save less. Times were
taken on a desktop machine and vary with load.

## Layout

```
src/script.js     parsing, encoding, push costs, ASM
src/num.js        script numbers
src/symbolic.js   symbolic stack IR, opcode semantics, equivalence
src/analysis.js   regions, barriers, guaranteed stack depths
src/peephole.js   fixed rules
src/schedule.js   liveness-driven stack scheduler
src/superopt.js   A* search, exhaustive sequence table, pattern cache
src/windows.js    window selection and dynamic programming
src/verify.js     whole-script proof, differential interpreter testing
src/profile.js    byte profiler
src/field.js      circuit IR compiler with lazy modular reduction
src/relax.js      lift field-arithmetic scripts back to circuits and re-reduce them
src/optimize.js   pipeline and report
bin/scriptmin.js  command line
```

## Roadmap

- Circuit-level algebraic rewriting: shared factors (`a*b + a*c` becomes
  `a*(b+c)`), Karatsuba and squaring formulas, with tower-aware rules for Fp2,
  Fp6 and Fp12.
- Stack scheduling across `IF`/`ELSE` where both branches can be modelled.
- Modelling `OP_CHECKMULTISIG` with constant key and signature counts.
