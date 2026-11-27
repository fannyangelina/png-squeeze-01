# PNG Squeeze v7 — NOTES

Practice score **733,586** (v2 submitted: 726,401, **+7,185**; v6: 738,024,
−4,438; v5: 742,905). Runtime **33.5 s and 35.5 s** across two full runs of
the final freshly-written file on this VM (1.5 shared CPUs; other runs of
the same configuration: 32.7 s, 33.6 s, 33.1 s, 35.2 s — the VM's shared
CPU makes the runtime vary by ~±1 s). All 8 instances lossless
(pixel-by-pixel diff = 0 against the kit checker decoder) and deterministic
(two full runs byte-identical). The final freshly-written main.ts produces
byte-identical output to the experiment build on all 8 images.

## Per-instance results (practice set)

| id | theme | v2 bytes | v7 bytes | delta | v7 points |
|----|-------|----------|----------|-------|-----------|
| i001 | flat  | 11,897 | 11,837 | −60 | 750.8 |
| i002 | rich  | 51,999 | 48,147 | −3,852 | 750.4 |
| i003 | alpha | 99,889 | 99,861 | −28 | 716.3 |
| i004 | grey  | 99,506 | 100,387 | +881 | 727.8 |
| i005 | flat  | 15,925 | 16,183 | +258 | 755.4 |
| i006 | rich  | 173,934 | 173,140 | −794 | 710.4 |
| i007 | alpha | 60,920 | 59,346 | −1,574 | 717.9 |
| i008 | grey  | 23,993 | 23,872 | −121 | 739.7 |
| **total score** | | **726,401** | **733,586** | | |

Points = 1000·(2·scale − bytes)/(2·scale − scale/2), clamped 0–1000, with
scale bytes i001 13547, i002 55063, i003 107892, i004 110521, i005 18669,
i006 185295, i007 64285, i008 26807. Score = 1000·mean(points).

Still **~59,800 points below the rank-50 cutoff (793,368)** and ~71,600
below the top score (805,215). v7 trades score for safety on purpose;
see "Why v7 exists".

## Why v7 exists (why v3 and v6 timed out)

- **v3 REJECTED 2026-11-27 ~21:13 WIB: grade run TIMED OUT** (fail
  run_completes). v3's practice runtime was 47.3/49.9 s on this VM but
  >60 s on the grader's 1 CPU.
- **v6 REJECTED 2026-11-27 ~21:56 WIB: grade run TIMED OUT as well**,
  at only 41.0–41.9 s on this VM. v2 (37 s here) completed and its dev
  score matched practice exactly, but v6 (41 s here) did not — so the
  grader is ~1.5x slower than this VM, not ~1.25x as first estimated.
  RULES.txt: a run past the wall "earns nothing on any column: it has
  no score, ranks below every scored entry and takes no reward."
- Neither rejection displaced v2: a rejected entry does not replace the
  last checked one, so v2 (726,401, now rank 467) is still the final
  entry. v4 (739,523 @ 53–61 s) and v5 (742,905 @ 50–54 s) were never
  submitted for the same reason.
- **Safe runtime on this VM is <= 35 s**: 35 s here is ~52 s on the
  grader at 1.5x slowdown, inside the 60 s wall. v7 runs 32.7–35.5 s
  here, i.e. ~49–53 s there — below v2's 37 s here on every measured
  run, and v2 is the proof that ~37 s here completes on the grader.

## What changed (measured, not guessed)

Profiling v6 per stage showed the DP parse is the dominant cost
(~2.3–4.9 s per image): unlike the greedy pass, which jumps over
matches, the parse calls the finder at every position, so the chain
walk is what the clock is spent on. The screen is ~1.1–2.8 s per image.

### 1. Finder cut from chain 512 to 128 — the big time buy

Chain sweep (all with the v6 levers, practice set):

| config (chain/cand/short) | score | runtime |
|---------------------------|-------|---------|
| 512 / 6 / 32 (v6) | 738,024 | 41.5 s |
| 256 / 6 / 32 | 736,330 | 35.4–37.1 s |
| 192 / 6 / 32 | 735,428 | ~36.0 s |
| **128 / 6 / 32 (v7)** | **733,586** | **~33.2 s** |
| 64 / 6 / 32 | 729,566 | 33.3 s |

256/192 run too close to the wall once the grader's ~1.5x slowdown is
applied (256 measured 37.1 s on one run — above v2's 37 s, which is the
largest runtime known to complete on the grader). 64 is no faster than
128 in practice (33.3 s vs ~33.2 s) but loses 4,020 points, so 128 is
the sweet spot. SHORT_CHAIN 16 instead of 32 saves ~1 s but loses
~1,840 points; CAND 4 instead of 6 saves ~0.7 s but loses ~1,840
points — both rejected as bad trades.

### 2. 'minsum' and 'pairs' dropped from the screen — free ~2 s

The screen's winning choice on every practice image is fixed 0,
'brute', or 'bands' (i001/i005/i007/i008: 0; i002/i006: bands; i003/i004:
brute). 'minsum' and 'pairs' never win, so dropping them from the
palette and non-palette filter lists costs 0 points and saves ~2 s
(35.4 s -> 33.2 s at chain 128; dropping 'pairs' alone saved 0.8 s,
dropping 'minsum' as well saved another ~1.9 s). Dropping fixed 1/2/4
as well saved nothing measurable and was not done — a scored image
could still want a fixed filter. The band strategies still try all 7:
dropping minsum/pairs there lost 272 points (i006 +604 B) for ~0.1 s,
so they stay. Dropping 'brute' instead would save ~4.9 s but lose
4,017 points (i004 +4,643 B) — rejected.

### 3. Kept from v6 (the cheap levers)

- 3-byte prefix fix (nearly free, ~+1,400 points over the old 4-byte
  check; length-3 matches are everywhere in RGB data).
- DP block splitting (~+1 s, +3,381 points; a coarser 4000-symbol grid
  saves ~1.7 s but loses 1,143 points — rejected).
- RGB-only multi-band filters (+2,528 points; dropping bands entirely
  saves ~0 s in v6's screen and loses 2,303 points — rejected).
- The uniform-split loop in emitDeflate is kept: skipping it saved no
  measurable time and the DP does not always dominate every uniform
  split (5000 is not a multiple of the 2000 grid).

## Remaining gap

- Zopfli ceiling (local, on v3's streams): **~778,646**. Our v7 is
  733,586, so ~45,000 points of the gap is the deflate itself.
- The top entry (805,215) beats the zopfli ceiling by ~26,600 points,
  so its stream is better than zopfli-png's. We have taken both of its
  named levers (multi-band filters, optimal block-split) and are still
  ~71,600 points behind — its edge is in the details (its "dual-start"
  filter search and "run-aware" split placement).
- What is left, if a v8 is attempted (only with runtime to spare — v7
  has ~1–2 s of headroom to the 35 s budget, so any v8 lever must be
  nearly free or must buy its own time): a finer DP grid (1000 symbols)
  for the block split; a "dual-start" filter search (two different
  starting filter assignments per band, keeping the better); per-image
  adaptive chain (a longer chain only on the images where it pays).
  The finder, the cost model, and parse<->cost iteration have all been
  measured and are exhausted (see v4/v5/v6 NOTES).

## Verification

- Practice set: `~/workspace/png-squeeze-01/png-squeeze-01-run-20261127-kit/practice/input/`
- Losslessness: pixel-by-pixel diff = 0 for all 8 instances, using the kit
  checker's decoder (`program/scorer/checker/png.mjs`), run on the final
  freshly-written file's output.
- Determinism: two full runs of the final file byte-identical
  (`diff -r` clean).
- Byte-identity: the final freshly-written main.ts produces byte-identical
  output to the experiment build on all 8 images (diff clean, 1,591
  lines, 60,631 bytes).
- Runtime: 33.5 s and 35.5 s across two full runs of the final file on
  this VM (1.5 shared CPUs); other runs of the same configuration:
  32.7 s, 33.6 s, 33.1 s, 35.2 s. The 60 s wall is on 1 CPU, ~1.5x
  slower than this VM.
- Repo size: main.ts 1,591 lines (~59 KB); total well under the 1 MiB limit.
