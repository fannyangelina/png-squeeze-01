# png-squeeze-01 v3 — NOTES

## Result (practice set, 2026-11-27)

| image | theme | scale | v2 bytes | v3 bytes | delta | v3 points |
|-------|-------|-------|----------|----------|-------|-----------|
| i001 | flat | 13,547 | 11,897 | 11,763 | −134 | 754.5 |
| i002 | rich | 55,063 | 51,999 | 48,867 | −3,132 | 741.7 |
| i003 | alpha | 107,892 | 99,889 | 100,589 | +700 | 711.8 |
| i004 | grey | 110,521 | 99,506 | 99,251 | −255 | 734.6 |
| i005 | flat | 18,669 | 15,925 | 15,628 | −297 | 775.3 |
| i006 | rich | 185,295 | 173,934 | 174,363 | +429 | 706.0 |
| i007 | alpha | 64,285 | 60,920 | 58,423 | −2,497 | 727.5 |
| i008 | grey | 26,807 | 23,993 | 23,671 | −322 | 744.7 |
| **total** | | | **538,063** | **532,555** | **−5,508** | |

- **Practice score: 736,995** (v2: 726,401; **+10,594**). Score = 1000 × mean of
  per-instance points; points = 1000 × (2·scale − bytes) / (2·scale − scale/2).
- **Runtime: 47–50 s** on this VM (1.5 shared CPUs; two runs: 47.3 s, 49.9 s).
  Under the 60 s wall, but with less margin than v2 (37 s). The grader is 1 CPU;
  if it runs ~20% slower than this VM the set lands near 58 s. Watch the dev
  score: if v3 times out at check time it will not displace v2 (Force_Last
  keeps the last *checked* entry).
- **Lossless:** all 8 images decode pixel-identical to the reference
  (kit checker decoder `program/scorer/checker/png.mjs`, diff = 0 on every
  image, RGBA byte-for-byte).
- **Deterministic:** two full runs produce byte-identical PNGs on all 8.
- **Repo size:** main.ts is 1,325 lines (~46 KB); the repo stays far under 1 MiB.

## What v3 changed (measured, not guessed)

### 1. The finder now matches a 3-byte prefix, not 4 — ~+1,400 points

The v2 `findMatches` required the candidate's first **4** bytes to equal the
target's, then extended from offset 4. A match of length exactly 3 has a
differing 4th byte, so the old finder could *never* find a length-3 match
directly — the only length-3 matches it ever returned came via the carry
(a length-4+ match at the previous position shortened by one). In RGB data
a pixel is 3 bytes, so length-3 matches are everywhere; zopfli takes
thousands of them and v2 took almost none.

Fix: compare a 3-byte prefix and extend from offset 3. Measured on i002
(baseline finder): 51,999 → 51,015 (−984). On the full set with the medium
finder it is worth ~+1,400 points (score 734,300 vs 732,900 for the same
finder with the 4-byte check). It hurts two images in raw bytes (i003 +1,330,
i006 +935 at the baseline finder) but the score weights small-scale images
more, so the net is positive.

### 2. Finder widened to chain 1024 / 8 candidates / short-chain 64 — ~+2,700 points

v2 used chain 512, 4 candidates, short-chain 8. Sweep on i002 (3-byte fix,
no iteration):

| chain | matches | short | i002 bytes | i002 time |
|-------|---------|-------|-----------|-----------|
| 512 | 4 | 8 | 51,015 | 3.8 s |
| 512 | 8 | 64 | 49,102 | 5.1 s |
| 1024 | 8 | 64 | 48,867 | ~5 s |
| 1024 | 8 | 128 | 48,674 | 6.5 s |
| 1024 | 16 | 128 | 48,612 | 6.4 s |
| 2048 | 16 | 128 | 49,653* | 6.9 s |
| 4096 | 16 | 512 | 49,085 | 15.0 s |

\* the 2048/16/128 run predates the 3-byte fix; the 4096 run likewise.

Full-set results (3-byte fix, no iteration): 512/8/64 → 734,300 @ 45.1 s;
1024/8/64 → **736,995 @ ~48 s**; 1024/8/128 → 738,200 @ 56.3 s;
1024/16/128 → 737,990 @ 55.1 s. The 1024/8/64 setting is the sweet spot:
+2,700 over 512/8/64 for +1.8 s, while the next step buys only +1,200
for +9.4 s. v3 ships 1024/8/64.

### 3. Parse↔cost iteration (zopfli-style) — implemented, measured, NOT shipped

After the first optimal parse, re-derive the Huffman cost model from the
parse's own symbol frequencies and re-parse; repeat until the gain is
<0.1% (cap 3 rounds). Measured per image:

| image | iter0 | iter1 | iter2 | iter3 | total gain |
|-------|-------|-------|-------|-------|-----------|
| i001 | 11,753 | 11,616 | 11,572 | 11,565 | −1.6% |
| i002 | 51,936 | 51,753 | 51,739 | — | −0.38% |

It converges in 1–2 rounds but each round costs a full extra finder+DP
pass (~2.5× total time: i002 3.7 s → 9.0 s for 3 rounds). With the 60 s
wall it does not pay, so v3 ships a single parse and the iteration code
was removed rather than left dormant. Selective iteration on just the two
small flat images (i001, i005) was also measured: +~1,200 points for +12 s
— not worth it either.

### 4. DP block splitting — not built

v2 already splits dynamic blocks at fixed sizes (2k/5k/10k/20k/50k/100k/
200k symbols), picking the cheapest by exact bit cost. Zopfli's own block
splitting adds only ~2% over no splitting, and the fixed sizes already
capture most of that. A DP over split points was not built: the remaining
gap is in the parse itself (see below), not in the split points, and the
time budget is already spent on the finder.

## Diagnosis that drove v3 (why the gap is in the parse)

- Zopfli's deflate run on v2's *own* filtered stream beats v2 by 12–13%
  (i001: v2 IDAT 11,759 vs zopfli-deflate 10,211; i002: 51,942 vs 45,577),
  and v2's stream is actually *better* than zopfli-png's own stream. So the
  gap is in the deflate, not in filter/form choice.
- Zopfli's single optimal pass (1 iter, no split) is already 8–10% better
  than v2's single optimal pass; iteration adds ~2.5% / ~0.6% and block
  splitting ~2% / ~1.7%. The dominant difference is the parse itself.
- Position-by-position parse comparison (i002): 3,483 positions where v2
  has a literal but zopfli has a match covering it. Most are **length-3**
  matches at medium distances (e.g. pos 2248 len 3 dist 207; pos 17981
  len 3 dist 945) — the 4-byte-prefix blind spot — plus longer matches in
  repeating 3-byte patterns where the chain walk burned its 4 candidate
  slots on incrementally-longer matches (6/9/12/15) and broke before
  reaching the longest one (20 at dist 7679).
- Under v2's own cost model those matches are far cheaper than the
  literals (e.g. len-20 @7679 = 22 bits vs 20 literals = 160 bits), so the
  DP would take them *if the finder returned them*. The finder was the
  bottleneck, not the cost model. The 3-byte fix + wider finder close
  part of it; a residual gap remains (below).

## Remaining gap

- Zopfli ceiling (local, pip zopfli 0.4.3 on v2's streams): **778,646**.
  v3 is **41,651 points** below it; the rank-50 cutoff is 777,641
  (**40,646 below**); the top score is 800,545.
- v3 does **not** reach the prize zone. The residual gap is still in the
  parse: even with the big finder (chain 4096/16/512) v2's parse had 8,877
  literals vs zopfli's 6,220 on i002, and 2,844 positions where v2 is a
  literal but zopfli has a match. The remaining misses are longer matches
  in repeating patterns that the chain walk still does not reach, and
  length-3 matches whose cost the DP's greedy-derived model misprices
  (greedy length-code 257 has frequency 0, so its cost length is 14).
- Ideas not tried (for a v4, time permitting): a Pareto/cost-based
  candidate set instead of length-only (record a candidate when it is not
  dominated in length *and* distance-cost); re-derive the DP cost model
  from a *smoothed* frequency that does not starve short matches; DP block
  splitting; per-image adaptive chain (big finder only where it helps
  most — i002/i007 saved ~2,400 bytes each, i003/i006 ~100–600).

## Files

- `main.ts` — the deliverable (Node 22, stdlib only). Written fresh in
  this session in 7 chunks; the rewritten file was verified byte-identical
  in output to the experimental build on all 8 images.
- `README.md`, `LICENSE` (MIT).
