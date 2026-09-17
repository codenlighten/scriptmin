# What is on the chain, and what scriptmin saves

Everything before this was measured on scripts written for this project or for
one library. This is a survey of what mainnet actually holds, and what the
optimizer would do to it.

Reproduce it with:

```bash
node examples/mainnet-survey.js collect   # ~20 min, resumable, reads a public API
node examples/mainnet-survey.js report
```

## The sample

240 blocks spread evenly from the Genesis upgrade (height 620,538, February
2020) to height 967,180 (17 September 2026), read through WhatsOnChain. Blocks
with more transactions than the cap are sampled down to 400 of them, so a busy
block counts for as much as a quiet one. That gives 15,564 transactions and
59,323 outputs holding 27,485,018 bytes of locking script.

## Where the bytes are

| script | outputs | | bytes | |
| --- | ---: | ---: | ---: | ---: |
| non-standard | 1,144 | 1.9% | 14,382,348 | 52.3% |
| `OP_RETURN` data output | 26,707 | 45.0% | 11,311,633 | 41.2% |
| P2PKH + inscription | 230 | 0.4% | 1,003,538 | 3.7% |
| P2PKH | 31,175 | 52.6% | 779,375 | 2.8% |
| P2PKH + data | 9 | 0.0% | 6,094 | 0.0% |
| P2PK | 58 | 0.1% | 2,030 | 0.0% |

Half the outputs are P2PKH, which is already minimal, and they hold under 3% of
the bytes. Most bytes are data: `OP_RETURN` payloads, inscription envelopes, and
two single scripts over 5 MB. Non-standard scripts are 1.9% of outputs but half
the bytes, and they are growing: in an earlier, wider sample of 385 blocks they
went from 94 outputs in the 2021 blocks to 922 in the 2026 ones.

## What scriptmin saves

The non-standard scripts fall into 41 templates (the same code, with different
data). One script per template was optimized at `--effort medium`; each passed
the equivalence proof and 20 interpreter runs.

**0.40% of all locking-script bytes; 2.9% of the non-standard ones.** The saving
is concentrated in scripts that check their own transaction with OP_PUSH_TX:

| template | outputs | bytes | saved each |
| --- | ---: | ---: | ---: |
| compiled contract, 2021–2023 (`OP_1 40 76 88 a9 ac …`) | 5 | 7,366 | 2,600 (35%) |
| the same family, other builds | 6 | 3,652 | 1,257 (34%) |
| | 6 | 5,626 | 1,225 (22%) |
| large contract, 2026 (`00 6a 76 88 a9 ac …`) | 2 | 200,262 | 32,081 (16%) |
| time-locked contract, 2024 | 1 | 934 | 240 (26%) |
| token contract, 2022–2023 | 29 | 784 | 129 (16%) |
| covenant parsing its own preimage, 2024–2026 | 120 | 1,341 | 5 (0.4%) |

A wider sample of 385 blocks, with more contract outputs in it, put the same
figure at 0.96% of all locking bytes and 21% of OP_PUSH_TX contract bytes. How
much a sample catches depends on which contract outputs it happens to include;
the shape of the answer does not change.

Nothing was saved on P2PKH, hashlocks, inscription envelopes or `OP_RETURN`
data. Those are already minimal, or they are data, which is kept.

## What this means

- **The audience is contract authors, not the network.** Rewriting the chain's
  scripts is not worth it; generating smaller ones is. A contract that checks
  its own transaction commits to its own code, so the saving is real only for a
  contract deployed from the optimized script — the natural place is a compiler,
  next to whatever emits the script.
- **A contract that was already hand-tuned has little left.** The most common
  covenant in the sample gives up 5 bytes of 1,341. Compiler output gives up a
  fifth to a third.

## What the survey changed in scriptmin

Three rewrites in the first run were correct and still wrong to make. They are
why `keepData` and `templates` exist, both on by default:

| script | what the optimizer did | why it is wrong |
| --- | --- | --- |
| `<document> OP_DROP <pubkey> OP_CHECKSIG` (103 outputs here, 289 in the wider sample) | 121 B → 35 B | the output exists to carry the document |
| `<pubkey> OP_CHECKSIG <tag> <fields…> OP_2DROP OP_2DROP OP_DROP` (39 outputs) | 451 B → 35 B | the same, for signed protocol fields |
| `<hash> 21e8 OP_SIZE … OP_DROP OP_CHECKSIG` (13 outputs, a Boost puzzle) | 46 B → 10 B | the hash names the content being worked on |
| `OP_2 <key A> <key B> <key A> OP_3 OP_CHECKMULTISIG` | 201 B → 136 B | reusing the repeated key with `OP_OVER` stops it being a bare multisig |

A push that no operation uses, and that is not left on the stack, is data.
It is kept byte for byte, and so are standard output templates. Contract savings
are unaffected: across all templates they are the same as with the protections
off.

## Caveats

- One sample, one script per template. Two samples of the same chain gave 0.40%
  and 0.96% of locking bytes.
- Outputs are counted per sampled transaction, not weighted by how much of the
  chain's traffic each block carries.
- Locking scripts only. Unlocking scripts (signatures, contract arguments) are
  not measured here.
- Savings assume the contract is deployed from the optimized script. Scripts
  already on the chain cannot be rewritten.
