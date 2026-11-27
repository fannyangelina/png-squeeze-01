# PNG Squeeze v6 — NOTES

Practice score **738,024** (v2: 726,401, **+11,623**; v5: 742,905, −4,881;
v3: 736,995, +1,029). Runtime **41.1 s and 41.9 s** across two full runs
of the final file on this VM (1.5 shared CPUs). All 8 instances lossless
(pixel-by-pixel diff = 0 against the kit checker decoder) and deterministic
(two full runs byte-identical). The final freshly-written main.ts produces
byte-identical output to the experiment build on all 8 images.

## Per-instance results (practice set)

| id | theme | v2 bytes | v6 bytes | delta | v6 points |
|----|-------|----------|----------|-------|-----------|
| i001 | flat  | 11,897 | 11,881 | −16 | 748.7 |
| i002 | rich  | 51,999 | 47,816 | −4,183 | 754.4 |
| i003 | alpha | 99,889 | 99,999 | +110 | 715.4 |
| i004 | grey  | 99,506 | 99,237 | −269 | 734.7 |
| i005 | flat  | 15,925 | 15,682 | −243 | 773.3 |
| i006 | rich  | 173,934 | 172,547 | −1,387 | 712.5 |
| i007 | alpha | 60,920 | 59,174 | −1,746 | 719.7 |
| i008 | grey  | 23,993 | 23,640 | −353 | 745.4 |
| **total score** | | **726,401** | **738,024** | | |

Points = 1000·(2·scale − bytes)/(2·scale − scale/2), clamped 0–1000, with
scale bytes i001 13547, i002 55063, i003 107892, i004 110521, i005 18669,
i006 185295, i007 64285, i008 26807. Score = 1000·mean(points).

Still **~50,500 points below the rank-50 cutoff (788,539)** and ~67,100
below the top score (805,100). v6 trades score for safety on purpose;
see "Why v6 exists".

## What shipped: the finder cut back to 512/6/32

v5's finder (chain 1024, 8 candidates, short-chain 64) is cut to chain
512, at most 6 length-beating candidates, short-chain 32 when the best
match is already >= 32. Everything else is kept from v5: the 3-byte
prefix fix, DP block splitting, RGB-only multi-band filters.

Finder sweep (all with the v5 levers, practice set):

| config (chain/cand/short) | score | runtime |
|---------------------------|-------|---------|
| 512 / 4 / 8 (v2's finder) | 732,674 | 39.1 s |
| 512 / 4 / 32 | 736,248 | 41.0 s |
| 512 / 6 / 8 | 734,831 | 40.3 s |
| **512 / 6 / 32 (v6)** | **738,024** | **41.5 s** |
| 512 / 8 / 64 (v3's finder, v5 levers) | ~734,300* | ~45 s |

\* v3 NOTES: 512/8/64 with the 3-byte fix was 734,300 @ 45.1 s without
the v5 levers; the v6 config beats it on both score and time because
MAX_MATCHES 6 (not 8) and the DP split + RGB bands add points cheaply.

The short chain is the cheap win: when a long match is already carried,
a 32-step walk finds a closer (cheaper-distance) match the 8-step walk
misses — worth ~+3,600 points for ~+2 s (512/4/8 -> 512/4/32), mostly on
the rich and alpha images (i002 −871 B, i007 −1,094 B). Adding the 5th
and 6th candidates is worth ~+1,800 more for ~+0.5 s (512/4/32 ->
512/6/32). The two effects stack almost fully additively.

## Why v6 exists (why v3/v4/v5 were not submittable)

- **v3 REJECTED 2026-11-27 ~21:13 WIB: grade run TIMED OUT** (fail
  run_completes). v3's practice runtime was 47.3/49.9 s on this VM but
  >60 s on the grader's 1 CPU — the grader is ~25-30% slower than this
  VM. RULES.txt: a run past the wall "earns nothing on any column: it
  has no score, ranks below every scored entry and takes no reward."
  The rejection did NOT displace v2, so v2 (726,401, rank 398) is still
  the final entry.
- **v4 (739,523 @ 52.9-61.5 s) and v5 (742,905 @ 50.4-54.0 s)** were
  built and verified but never submitted — both would time out on the
  grader at the measured slowdown.
- **Safe runtime on this VM is <= 42 s**: 42 s here is ~52-55 s on the
  grader at 25-30% slowdown, inside the 60 s wall with margin. v6 runs
  41.1-41.9 s here, i.e. ~52-54 s there. The runtime is CPU-bound
  (user time ≈ real time), so the grader's dedicated 1 CPU should be
  more consistent than this VM's shared CPU — but the margin is kept
  anyway.

## Remaining gap

- Zopfli ceiling (local, on v3's streams): **~778,646**. Our v6 is
  738,024, so ~40,600 points of the gap is the deflate itself.
- The top entry (805,100, "Dual-Start Multi-Band Filter + Run-Aware
  Optimal Block-Split") beats the zopfli ceiling by ~26,000 points, so
  its stream is better than zopfli-png's. We have taken both of its
  named levers (multi-band filters, optimal block splitting) and are
  still ~67,000 points behind — its edge is in the details (its
  "dual-start" filter search and "run-aware" split placement).
- What is left, if a v7 is attempted (only with runtime to spare — v6
  has ~0.5 s of headroom to the 42 s budget, so any v7 lever must be
  nearly free or must buy its own time): a finer DP grid (1000 symbols)
  for the block split; a "dual-start" filter search (two different
  starting filter assignments per band, keeping the better); per-image
  adaptive chain. The finder, the cost model, and parse<->cost
  iteration have all been measured and are exhausted (see v4/v5 NOTES).

## Verification

- Practice set: `~/workspace/png-squeeze-01/png-squeeze-01-run-20261127-kit/practice/input/`
- Losslessness: pixel-by-pixel diff = 0 for all 8 instances, using the kit
  checker's decoder (`program/scorer/checker/png.mjs`), run on the final
  freshly-written file's output.
- Determinism: two full runs of the final file byte-identical (`diff -r`
  clean).
- Byte-identity: the final freshly-written main.ts produces byte-identical
  output to the experiment build on all 8 images.
- Runtime: 41.1 s and 41.9 s across two full runs of the final file on
  this VM (1.5 shared CPUs); the 60 s wall is on 1 CPU, ~25-30% slower.
- Repo size: main.ts 1,559 lines (~57 KB); total well under the 1 MiB limit.
