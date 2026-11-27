# PNG Squeeze — png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/fannyangelina/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/fannyangelina/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG compressor for 1280×720 RGBA screenshots, written in pure
Node 22 stdlib (`main.ts`, no dependencies).

How it squeezes: it decodes each screenshot, analyses it (opaque? grey?
how many colours? a single transparent key?), then tries the lossless
forms that can hold it — palette (type 3) in count, luminance and
first-appearance order, grey (type 0) / grey+alpha (type 4), RGB (type 2)
with a tRNS key when one exists, or RGBA (type 6) — each with several
per-row filter assignments (fixed filters, minimum-sum, fewest-pairs, and
brute force weighed by a small zlib run over the preceding 32 KiB).
Every candidate is weighed by zlib at level 6; the winner is re-compressed
at level 9 (several settings tried, smallest kept) and written out with
correct CRCs. Deterministic: fixed work, no clock reads — two runs are
byte-identical.

Practice-set score: **~705,400** (house baseline fixed-paeth: ~420,400;
scale compressor: 666,670). Runtime ~15 s for 8 images on one CPU,
well inside the 60 s wall. See NOTES.md for the per-instance numbers.
