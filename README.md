# PNG Squeeze v8

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun](https://img.shields.io/badge/make.fun-entry-green)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun](https://img.shields.io/badge/make.fun-png--squeeze--01-orange)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Squeeze 1280×720 RGBA screenshots into the smallest lossless PNG we can,
within a fixed amount of work (never the wall clock).

## How it works

Per image:

1. **Decode** the input PNG (any colour type 0/2/3/4/6, bit depth 8) to RGBA.
2. **Analyse**: opaque? grey? how many distinct colours (up to 257)? Is there
   one fully transparent colour a tRNS key could stand for?
3. **Try the lossless forms** that can hold it (palette in three orders,
   grey / grey+alpha, RGB with a tRNS key, RGBA) with several per-row filter
   assignments (fixed 0/1/2/4, brute force weighed by a small zlib run, and
   multi-band: a different strategy per horizontal band). Weigh every
   candidate with zlib at level 6; the smallest wins the screen.
4. **Write the winner with our own deflate encoder**: a hash-chain match
   finder with a carried match, a shortest-path (dynamic programming) parse
   that minimises the deflate bit cost, and a choice of fixed Huffman, one
   dynamic block, or dynamic blocks split at DP-chosen points — refined by
   local shifts — where a fresh table pays for its header.

## Results (practice set)

| image | theme | bytes | points |
|-------|-------|-------|--------|
| i001 | flat | 11,826 | 751.4 |
| i002 | rich | 47,868 | 753.8 |
| i003 | alpha | 99,457 | 718.8 |
| i004 | grey | 99,901 | 730.7 |
| i005 | flat | 15,957 | 763.5 |
| i006 | rich | 172,391 | 713.1 |
| i007 | alpha | 59,119 | 720.2 |
| i008 | grey | 23,667 | 744.8 |
| **total** | | **530,186** | **737,032** |

Practice score **737,032** (+3,446 vs v7's 733,586). Runtime ~35–37 s on
this VM for the 8-image set (two verification runs: 37.43 s, 35.56 s).
All 8 instances lossless (pixel-by-pixel diff = 0 via the kit checker
decoder) and deterministic (two runs byte-identical).

## v8 changes over v7

- Finder chain raised from 128 to 192 (6 candidates, short-chain 32):
  +1,842 points for ~+1.5 s.
- Split refinement: after the DP picks block splits on the 2000-symbol
  grid, each boundary is shifted by ±500/1000/1500 symbols and kept when
  the exact bits of the two adjacent blocks improve (up to two passes):
  +1,604 points for ~+0.3 s.

See NOTES.md for the full measurement log, including the levers that were
measured and rejected.

## Running

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

Node 22, standard library only. No network, no clock reads, deterministic.
