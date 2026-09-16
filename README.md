# scriptmin

A Bitcoin Script minimizer. It takes a working script and returns a smaller
one that does exactly the same thing, then proves that it does.

The objective is serialized bytes, not opcode count: `<257> OP_PICK` is four
bytes, `OP_2DUP` is one.

```
$ scriptmin -o field-6000.min.hex field-6000.hex
Original:         93,167 bytes
Minimized:        72,926 bytes
Saved:            20,241 bytes
Reduction:        21.73%

Breakdown:
  stack-scheduling            -18,890
  peephole                     -1,101
  superoptimizer                 -250

By what the bytes were doing:
  stack                        79,593 ->       59,352  (-20,241)

Verification:
  symbolic proof         passed (1 regions, 0 barriers)
  interpreter tests      passed (100 runs, 47 ran to success)
```

Built on [`@smartledger/bsv`](https://www.npmjs.com/package/@smartledger/bsv)
for script parsing, hashing and the reference interpreter used in testing.

## Install

```bash
npm install
npm test
npx scriptmin --help
```

Requires Node 18+.

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
| **stack-scheduling** | Lifts the region to its dataflow (which operations run on which values, and what must be left on the stack), then regenerates all the stack movement using liveness. A value's last use becomes a move (`ROLL`/`ROT`/`SWAP`) instead of a copy followed by a drop later. Dead values are dropped when they surface. Operations that cannot fail and whose results are never used are removed. Operand order is picked by cost for commutative ops. Large constants are pushed once and then copied. |
| **superoptimizer** | For every short window of pure stack code, computes the stack transformation and finds the cheapest sequence producing it. A table of every stack-op sequence up to 5 bytes (6 at `--effort high`) answers most windows instantly. An A\* search handles windows with constants or the alt stack. Non-overlapping replacements are chosen by dynamic programming. |
| **constant-folding** | Superoptimizer windows over constant operands (`OP_3 OP_5 OP_ADD` becomes `OP_8`, including hashes, `CAT`, `SPLIT` and numeric comparisons). |

`--effort low|medium|high` sets the window length, table depth, search budget
and how many chunkings the scheduler tries.

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
3. **They evaluate the same multiset of operations that can fail.** Arithmetic
   can fail on oversized numbers, `DIV` on zero, `VERIFY` on false. Script
   failure is all-or-nothing, so these checks may move but may not disappear.
   Operations that cannot fail (`EQUAL`, `SIZE`, hashes, `INVERT`) may be
   removed when their results are unused.

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

`examples/naive-field-compiler.js` compiles random modular-arithmetic circuits
(254-bit modulus) the way a first-cut generator would. Every operand is fetched
with `OP_PICK`, nothing is freed until the end, and a final cleanup rolls and
drops every temporary. `examples/bench.js` optimizes the output, checks the
proof, and runs both scripts on the interpreter with real field elements
against the circuit's expected outputs.

Modulus kept on the stack and fetched with `OP_PICK` (`npm run bench`):

| gates | original | optimized | reduction | time |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 690 | 457 | 33.8% | 0.2s |
| 500 | 7,433 | 5,125 | 31.1% | 0.4s |
| 2,000 | 30,528 | 23,277 | 23.8% | 2.5s |
| 6,000 | 93,167 | 72,926 | 21.7% | 19.5s |

When the compiler also re-pushes the 33-byte modulus at every reduction
(`node examples/bench.js 50,500,2000,6000 medium push`), a 312 KB script
drops to 73 KB. The optimizer converges to the same output from both versions.

These are synthetic and deliberately naive. Hand-tuned scripts will save less.

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
src/optimize.js   pipeline and report
bin/scriptmin.js  command line
```

## Roadmap

- An IR mode that takes a compiler's symbolic program directly, before
  emission discards information.
- Common subexpression elimination, weighing the cost of keeping a value alive
  against recomputing it.
- Algebraic rewriting (`a*b + a*c` becomes `a*(b+c)`), with domain-aware rules
  for Fp, Fp2, Fp6 and Fp12 and SMT-checked side conditions.
- Stack scheduling through the alt stack, and across `IF`/`ELSE` where both
  branches can be modelled.
- Modelling `OP_CHECKMULTISIG` with constant key and signature counts.
- Faster scheduling on very deep stacks. Time is currently superlinear in the
  number of live values.
