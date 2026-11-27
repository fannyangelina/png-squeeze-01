# PNG Squeeze v6

Squeeze 1280x720 RGBA screenshots into the smallest lossless PNG, within a
fixed amount of work (never the wall clock).

**Practice score: 738,024** (v2: 726,401; v5: 742,905; v3: 736,995).
**Runtime: ~41.5 s** on this VM (two runs: 41.1 s, 41.9 s) — the safe budget,
because the grader is ~25-30% slower than this VM and v3 (47-50 s here)
timed out on it. At the grader's slowdown, 41.5 s here is ~52-54 s there,
inside the 60 s wall with margin.

## How it works

Per image: decode the input PNG to RGBA, analyse it (opaque? grey? how many
colours? a single transparent tRNS key?), try the lossless forms that can
hold it (palette in three orders, grey / grey+alpha, RGB with a tRNS key,
RGBA) with several per-row filter assignments (fixed 0/1/2/4, minimum-sum,
fewest-pairs, brute force, and multi-band for RGB forms: a different
strategy per horizontal band). Every candidate is weighed with zlib at
level 6; the winner is written with our own deflate encoder: a hash-chain
match finder with a carried match, a shortest-path (DP) parse minimising
the deflate bit cost, and a choice of fixed Huffman, one dynamic block, or
dynamic blocks split at DP-chosen points.

## v6 vs v5

v5 scored 742,905 but ran 50.4-54.0 s here — it would time out on the
grader, like v3 did. v6 cuts the finder back from 1024/8/64 to 512/6/32
(chain 512, at most 6 candidates, short-chain 32) and keeps everything
else: the 3-byte prefix fix, DP block splitting, RGB-only multi-band
filters. The short chain is the cheap win (+3,600 points for ~+2 s over
512/4/8). Score 738,024 at 41.5 s: safer, and still +11,623 over the
submitted v2 (726,401).

## Files

- `main.ts` — the deliverable (Node 22, standard library only).
- `LICENSE` — MIT.
- `NOTES.md` — per-instance results, per-lever measurements, and why
  v3/v4/v5 were not submittable.
