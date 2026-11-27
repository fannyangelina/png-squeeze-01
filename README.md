# PNG Squeeze v2 — optimal-parsing deflate

Squeezes 8 screenshots (1280×720 RGBA) into the smallest lossless PNGs.
Node 22, standard library only, no dependencies. Deterministic, single
run, well under the 60 s wall.

## How it works

1. **Decode + analyse** each input PNG (own decoder, CRC-checked).
   Detects opaque / grey / ≤256-colour images and a transparent key.
2. **Colour-type reduction**: palette (3 orderings), grey, grey+alpha,
   RGB, RGBA — whichever form fits the pixels.
3. **Per-row filters**: fixed filters (None/Sub/Up/Average/Paeth) plus
   adaptive assignments (min-sum, fewest-pairs, brute-force per row).
   Candidates are weighed with zlib level 6; the winner is kept.
4. **Optimal deflate** (the v2 addition): the winning filtered stream is
   re-compressed with our own deflate — a hash-chain match finder with a
   **carried match** (the best match at the previous position propagates
   forward one byte for free, so long matches are found once and reused),
   a shortest-path dynamic-programming parse that minimises exact deflate
   bit cost, fixed + dynamic Huffman (package-merge lengths), and block
   splitting at 2k–200k symbols. Two passes: a greedy frequency estimate,
   then one optimal parse.
5. **Write** the smallest valid PNG (IHDR / PLTE / tRNS / IDAT / IEND).

## Results (practice set)

| instance | bytes | points |
|----------|------:|-------:|
| i001 flat  | 11,897 | 747.8 |
| i002 rich  | 51,999 | 703.8 |
| i003 alpha | 99,889 | 716.1 |
| i004 grey  | 99,506 | 733.1 |
| i005 flat  | 15,925 | 764.6 |
| i006 rich  | 173,934 | 707.5 |
| i007 alpha | 60,920 | 701.6 |
| i008 grey  | 23,993 | 736.6 |
| **total score** | | **726,401** |

v1 scored 705,406 on the same set, so v2 gains **+20,995 points**.
Runtime ~37 s for the full set on this machine (limit 60 s). All 8
instances verified lossless pixel-by-pixel with the kit checker's decoder,
and two runs are byte-identical.

## Usage

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input),
               # writes $MAKEFUN_OUTPUT_DIR (default /output)
```

## Files

- `main.ts` — the whole compressor (decoder, analysis, filters, optimal
  deflate, driver). Written from scratch in this session.
- `NOTES.md` — per-instance results, what was tried, and the gap to 800k.
- `LICENSE` — MIT.
