# PNG Squeeze v7

Squeeze 1280x720 RGBA screenshots into the smallest lossless PNG, within a
fixed amount of work (never the wall clock). Node 22, standard library only.

## Result (practice set)

Practice score **733,586** (v2 submitted: 726,401; v6: 738,024; v5: 742,905).
Runtime **~33-35 s** on this VM (1.5 shared CPUs) — inside the 60 s wall on
the grader, which runs ~1.5x slower than this VM (see NOTES.md for why the
budget is 35 s here, not 42 s). Runs of the final file: 33.5 s and 35.5 s.

| image | theme | bytes | points |
|-------|-------|-------|--------|
| i001 | flat | 11,837 | 750.8 |
| i002 | rich | 48,147 | 750.4 |
| i003 | alpha | 99,861 | 716.3 |
| i004 | grey | 100,387 | 727.8 |
| i005 | flat | 16,183 | 755.4 |
| i006 | rich | 173,140 | 710.4 |
| i007 | alpha | 59,346 | 717.9 |
| i008 | grey | 23,872 | 739.7 |

## How it works

1. Decode the input PNG to RGBA (any colour type 0/2/3/4/6, bit depth 8).
2. Analyse it (opaque? grey? distinct colours? a single transparent key?).
3. Try the lossless forms that can hold it (palette in three orders,
   grey / grey+alpha, RGB with a tRNS key, RGBA) with several per-row
   filter assignments (fixed 0/1/2/4, brute force weighed by a small zlib
   run, and multi-band for RGB: a different strategy per horizontal band).
   Weigh every candidate with zlib level 6; the smallest wins the screen.
4. Write the winner with our own deflate encoder: a hash-chain match
   finder (chain 128, short-chain 32, at most 6 length-beating candidates,
   3-byte prefix so length-3 matches are found, carried match), a
   shortest-path (dynamic programming) parse minimising the deflate bit
   cost, and emission as fixed Huffman, one dynamic block, or dynamic
   blocks split at DP-chosen points. Two passes: a greedy frequency
   estimate, then one optimal parse.

v7 over v6: the finder is cut from chain 512 to 128 (the parse calls it at
every position, so the chain walk dominates the runtime) and the 'minsum'
and 'pairs' filter choices are dropped from the screen (they never win it).
That trades ~4,400 points for ~8 s — the time v6 needed to survive the
grader. See NOTES.md for the measurements behind every choice.

## Verification

- All 8 practice images decode pixel-identical to the reference (kit
  checker decoder, diff = 0), two full runs byte-identical.
- Deterministic: fixed choices, fixed hash seeds, no clock reads.
