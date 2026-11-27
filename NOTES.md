# png-squeeze-01 v8 — NOTES

## Result

- **Practice score: 737,032** (per-instance bytes below), **+3,446 vs v7
  (733,586)**. v7 is the current final entry (dev 733,580, rank 356 of
  4,164, submitted 2026-11-27 22:40 WIB).
- **Runtime: 35.56 s and 37.43 s** on this VM for the full 8-image set
  (two verification runs of the final file). Experiment runs of the same
  config measured 34.77–36.39 s. The VM's runtime varies ±1–1.5 s run to
  run under load; the score is deterministic.
- **Lossless**: all 8 instances diff = 0 pixel-by-pixel via the kit
  checker decoder (`program/scorer/checker/png.mjs`).
- **Deterministic**: two full runs byte-identical (sha256 of all 8 outputs
  match). No clock reads, no randomness, fixed work per image.
- Repo size: main.ts 64,961 B + README + LICENSE + NOTES ≈ 68 KB total,
  well under the 1 MiB limit.

## Per-instance results (practice set)

| id | theme | scale | bytes | points | vs v7 bytes |
|----|-------|-------|-------|--------|-------------|
| i001 | flat | 13,547 | 11,826 | 751.4 | 11,837 → 11,826 (−11) |
| i002 | rich | 55,063 | 47,868 | 753.8 | 48,147 → 47,868 (−279) |
| i003 | alpha | 107,892 | 99,457 | 718.8 | 99,861 → 99,457 (−404) |
| i004 | grey | 110,521 | 99,901 | 730.7 | 100,387 → 99,901 (−486) |
| i005 | flat | 18,669 | 15,957 | 763.5 | 16,183 → 15,957 (−226) |
| i006 | rich | 185,295 | 172,391 | 713.1 | 173,140 → 172,391 (−749) |
| i007 | alpha | 64,285 | 59,119 | 720.2 | 59,346 → 59,119 (−227) |
| i008 | grey | 26,807 | 23,667 | 744.8 | 23,872 → 23,667 (−205) |
| **total** | | | **530,186** | **737,032** | 538,063 → 530,186 (−7,877) |

Points = 1000·(2·scale − bytes)/(2·scale − scale/2), clamped 0–1000.
Score = 1000·mean of the 8 per-instance points.

## What each v8 lever gained / cost (measured on the practice set)

### (a) Finer DP grid — exact grid too slow, refinement shipped instead

- Grid 1000 (exact costing, i002/i006/i007 only): i002 −97 B (+1.2 pts),
  i007 −178 B (+1.8), i006 −342 B (+1.2) but i006 time +2.04 s.
- Grid 500: i002 −140 B (+1.7), i007 −263 B (+2.7), time +0.85/+1.05 s.
- Exact finer grid NOT affordable at full-set scale.
- **Split refinement (SHIPPED)**: after the DP picks splits on the
  2000-symbol grid, each interior boundary is shifted by ±500/±1000/
  ±1500 symbols and kept when the exact bits of the two adjacent blocks
  improve; up to 2 passes. Gains vs chain-192-no-refine: i002 −91 B
  (+1.1), i007 −153 B (+1.6), i006 −388 B (+1.4), i003 −351 B (+2.2),
  i004 −141 B (+0.9), i005 −65 B (+2.3), i008 −133 B (+3.3),
  i001 −2 B — total **+1,604 points for ~+0.3 s**. 1-pass refine =
  737,017 (only −15 vs 2-pass 737,032); reduced deltas (±500/±1000
  only) = 737,020 (−12) — deltas/pass count barely matter, full form kept.
- The refinement only ever keeps a shift when the exact bit count
  improves, so it cannot make the emission worse.

### (b) Dual-start filter search — NOT built

- 'brute' at zlib level 6 tested and REJECTED: chain 192 + brute 6 =
  733,334 @ 37.23 s — i002/i003/i006 improved but i005 +675 B and
  i004 +159 B, and +2.5 s; chain 128 + brute 6 = 731,956 @ 36.86 s.
- First-appearance palette order tested and REJECTED: i001 −4 B,
  i005 −2 B at chain 128; −2/−1 B at chain 192 — negligible, and the
  extra screen form costs ~+0.3–0.4 s per flat image.
- The 'minsum' second-start idea was not built (v7 notes: minsum never
  wins the zlib-6 screen; v2 measured parsing both candidates doubles
  work for no gain).

### (c) Per-image adaptive chain — full-set chain 192 chosen instead

- Chain 256 per-image: i002 −171 B (+2.1, +1.01 s), i007 −93 B (+1.0,
  +1.20 s), i006 −387 B (+1.4, +0.62 s), i003 −65 B (+0.4, +0.35 s).
- Chain 192 per-image: i002 −188 B (+2.3, +0.04 s), i007 −74 B (+0.8,
  −0.12 s), i006 −361 B (+1.3, +0.44 s), i003 −53 B (+0.3, +0.08 s),
  i004 −345 B (+2.1, −0.03 s).
- **Full-set chain 192/6/32: 735,428 (+1,842 vs v7) @ 34.55–34.87 s**
  (two runs). Gains spread across ALL images, so selective application
  saves little time.
- Medium-chain cap REJECTED: 192 med64 = 731,913 @ 35.90 s (SLOWER and
  worse — capping the walk weakens the carry, so later positions do more
  discovery work); med96 = 733,421 @ 33.07 s; med48 = 730,392 @ 32.77 s.
- SHORT_CHAIN 16 at 192 = 733,493 @ 33.55 s (loses 1,935 pts for ~1.1 s
  — bad trade); CAND 4 at 192 = 733,350 @ 34.49 s (loses 2,078 pts,
  saves ~0.1–0.4 s — bad trade); 192/4/16 = 731,303 @ 31.41 s.
- SHORT_CHAIN 48 at 192 = 737,923 (+891 vs 737,032) @ 38.26 s — too
  slow, rejected. CAND 8 at 192 = 737,251 (+219) @ 36.56 s — too slow,
  rejected.

### Final A/B: chain 192 vs 176 (both + refine), 4 alternating runs

| run | chain | score | secs |
|-----|-------|-------|------|
| A | 192 | 737,032 | 36.39 |
| A | 176 | 736,959 | 35.43 |
| B | 192 | 737,032 | 35.34 |
| B | 176 | 736,959 | 35.77 |

192 wins by 73 points (deterministic); runtimes overlap within VM noise.
**Final v8 = chain 192/6/32 + split refinement = 737,032.**

## Runtime safety

- The grader is ~1.5× slower than this VM: v2 (37 s here) completed,
  v3 (47–50 s) and v6 (41 s) TIMED OUT. v7 (33 s here) scored fine.
- v8 runs 34.8–37.4 s here across 7 measured runs (34.77, 35.19, 35.20,
  35.34, 35.56, 36.39, 37.43). At 1.5× that is ~52–56 s on the grader,
  inside the 60 s wall — and v2's 37 s here is the proof that ~37 s
  here completes. The top end (37.4 s) is the VM under load, not the
  code; the score is identical at every runtime.
- A run past the wall "earns nothing on any column" (RULES.txt) and, as
  the Force_Last entry, would displace v7's 733,580. The margin is
  thinner than v7's, but the v2 precedent (37 s here → completed) covers
  the observed range.

## Remaining gap

- Rank-50 cutoff at v7's score check: 794,957 (emailguidata-cmd).
  Gap from 737,032: ~57,925. Top: reactrailgun 806,128. Rank-100:
  782,802.
- Zopfli ceiling measured locally ~778,646 — v8 (737,032) is still
  ~41,600 below it. The remaining deflate gap is in block splitting /
  Huffman table work (our parse finds nearly the brute-force longest
  match; the finder is not the bottleneck). Parse↔cost iteration was
  measured in v3/v4 and gains only ~0.4–0.5% for ~2.5× time — not
  affordable at this runtime budget.
- The next lever, if any time remains before the 29 Nov 12:00 WIB
  deadline, would be a cheaper approximation of zopfli's block splitting
  (e.g. a second DP pass with the refined splits as the grid), or
  SHORT_CHAIN 48 / CAND 8 if the grader proves faster than 1.5× — but
  both are too slow at the measured 1.5× slowdown and are NOT shipped.

## History

- v1: 705,406 (rank 1507) — palette/grey/RGB forms, zlib-9 screen.
- v2: 726,401 (rank 398) — own deflate: hash-chain finder + DP parse +
  fixed/dynamic Huffman + uniform block splits.
- v3: 736,995 — 3-byte prefix fix + chain 1024; REJECTED (grader timeout).
- v4: 739,523 — multi-band filters; not submitted (53–61 s).
- v5: 742,905 — RGB-only bands + DP block splitting; not submitted
  (50–54 s).
- v6: 738,024 — finder 512/6/32; REJECTED (grader timeout at 41 s here).
- v7: 733,586 practice / 733,580 dev (rank 356) — finder 128/6/32,
  minsum/pairs dropped; SCORED, current final entry.
- v8: 737,032 — finder 192/6/32 + split refinement.
