# PNG Squeeze v2 — notes

## Practice-set result (2026-11-27)

| instance | scale | v2 bytes | v2 pts | v1 bytes | v1 pts | zopfli bytes |
|----------|------:|---------:|-------:|---------:|-------:|-------------:|
| i001 flat  | 13,547 | 11,897 | 747.8 | 12,496 | 717.9 | 10,396 |
| i002 rich  | 55,063 | 51,999 | 703.8 | 51,852 | 707.6 | 46,895 |
| i003 alpha | 107,892 | 99,889 | 716.1 | 106,605 | 694.7 | 93,941 |
| i004 grey  | 110,521 | 99,506 | 733.1 | 105,567 | 717.9 | 98,714 |
| i005 flat  | 18,669 | 15,925 | 764.6 | 16,552 | 745.6 | 14,145 |
| i006 rich  | 185,295 | 173,934 | 707.5 | 178,840 | 698.9 | 162,128 |
| i007 alpha | 64,285 | 60,920 | 701.6 | 60,890 | 701.9 | 53,392 |
| i008 grey  | 26,807 | 23,993 | 736.6 | 24,897 | 724.6 | 21,717 |
| **total**  |        |         | **726,401** |    | **705,406** | **~778,646** |

v2 beats v1 on 6 of 8 instances (+20,995 points overall). It loses
slightly on i002 (51,999 vs 51,852) and i007 (60,920 vs 60,890), where
zlib-9 on v1's stream is a touch better than my optimal parse.
Runtime ~37 s for the full set (limit 60 s). All 8 lossless
(pixel-by-pixel vs the kit checker's decoder) and deterministic
(two runs byte-identical).

## What v2 adds over v1

Own deflate with optimal (shortest-path DP) parsing, replacing zlib-9
for the winning stream:

- Hash-chain match finder (3-byte hash, 15-bit table, window 32 KiB,
  max match 258, min 3) with a **carried match**: the best match found
  at position i−1 is a match of length L−1 at the same distance here,
  so it costs nothing to re-find. Once a long match is discovered the
  carry propagates it down the run and the chain walk only needs to look
  for a closer one.
- DP parse minimising exact deflate bit cost (literal/length and
  distance code lengths + extra bits), trying only bucket-top lengths
  per match (proven sufficient: within a length-code bucket every length
  costs the same bits, so the longest dominates).
- Fixed + dynamic Huffman (package-merge code lengths), block splitting
  at 2k/5k/10k/20k/50k/100k/200k symbols, chosen by exact bit count.
- Two passes: greedy frequency estimate, then one optimal parse.
  (A second re-parse gained only ~0.4% on i002 for double the time,
  so it was dropped.)

## Bugs found and fixed during the build

1. **Non-canonical Huffman codes** — the single-pass `canonicalCodes`
   fed the post-assignment incremented code back into the next length's
   recurrence (double-counted `bl_count`); fixed-Huffman literal 65 got
   code 161 instead of 113. Symptom: "invalid bit length repeat" on
   inflate. Fix: two-pass (compute `nextCode[]` first, then assign).
2. **Match-length overestimate** — the old finder extended from `best+1`
   after only checking `data[p+best] === data[i+best]`, without verifying
   bytes 4..best−1. Fix: `matchLen()` verifies all bytes from 4.
3. **Free symbols in the DP cost model** — lengths built from raw
   frequencies gave length 0 to symbols the greedy never used, so the DP
   chased "free" long matches and the real emit paid full price. Fix:
   smooth every emittable symbol to frequency ≥ 1 for the DP cost model
   only; the emit still uses raw frequencies from the actual parse.
4. **Carry pruned the closest match** — seeding the DP's `best` with the
   carried (long, far) match made the chain walk skip the closest
   candidate, which is often a short match at distance 3–4 costing only
   ~2 distance bits and used heavily. i002 went 7% bigger. Fix: always
   record the first (closest) chain candidate, and scan `cand` for the
   longest when carrying (the list is no longer length-ordered).

## Experiments and measurements (i002, same stream)

- Chain length (no carry): 48 → 55,520 B; 256 → 53,649 B;
  1024 → 52,226 B; zlib-9 → 51,795 B. Longer chains find better
  matches but are slow.
- Chain length (with carry + closest-candidate fix): 1 → 76,893 B
  (carry alone is not enough); 4 → 60,756 B; 16 → 55,551 B;
  64 → 53,353 B; 256 → 52,842 B (4.8 s); 512 → 52,621 B (5.2 s);
  1024 → 52,344 B (5.7 s); 4096 → 52,543 B — chain length stops
  mattering past ~1024; the finder is not the bottleneck any more.
- Passes (i002): greedy+dp1+dp2 → 52,621 B, 5.1 s;
  greedy+dp1 → 52,851 B, 2.7 s (kept); fixed-cost dp1 only → 53,863 B.
- Block splits (i002): 50k+ only → 52,851 B; adding 2k/5k/10k/20k →
  51,942 B (saved 909 B). Smaller splits (500/1000) give nothing extra
  on flat images.
- Full-set chain choice: 256 → 724,367 (33.7 s); **512 → 726,401
  (36.9 s, kept)**; 1024 → 728,727 (49.4 s — too close to the 60 s
  wall on a 1-CPU grader, rejected).
- Filter re-weighing: optimal-parsing the screen's runner-up on i002
  gives 54,418 B vs 52,851 B for the winner — the zlib-6 screen already
  ranks candidates the same way the optimal parser does, so parsing a
  second candidate is not worth doubling the work.

## The gap to 800k

v2 totals 538,063 bytes vs zopfli's ~501,328 (~6.8% more bytes), worth
~52k points. Per-instance the gap is 0.8% (i004) to 14% (i001, i007).
What was ruled out as the cause: match-finder chain length (4096 does
not beat 1024), block splitting (small splits help rich images, nothing
on flat ones), a second DP pass (+0.4%), and filter choice (the screen
already picks the optimal-parser winner). The remaining gap is in the
parse/cost model itself — a true zopfli-level compressor iterates the
parse↔cost refinement to convergence and splits blocks by dynamic
programming over split points rather than fixed sizes, and the top
entries (800k+) do something beyond plain zopfli. Those are the levers
for a v3, but each costs significant runtime against the 60 s wall, so
v2 ships at 726k as a safe, verified improvement over v1's 705k.

## Verification

- Lossless: `/tmp/verify.mjs` decodes input and output with the kit
  checker's decoder (`program/scorer/checker/png.mjs`) and compares
  RGBA pixel-by-pixel; all 8 report `diff=0`.
- Deterministic: two full runs produce byte-identical outputs for all 8.
- Runtime: ~37 s for the full set on this VM (1.5 shared CPUs); the
  grader is 1 CPU, so this leaves headroom under the 60 s wall.
- Repo size: main.ts 45,700 bytes + README + LICENSE + NOTES, well
  under the 1 MiB limit.
