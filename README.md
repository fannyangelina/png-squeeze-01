# PNG Squeeze v3

Squeeze 1280×720 RGBA screenshots into the smallest lossless PNG, within a
fixed amount of work (never the wall clock). Node 22, standard library only.

## How it works

Per image:

1. **Decode** the input PNG (any colour type 0/2/3/4/6, bit depth 8) to RGBA.
2. **Analyse**: opaque? grey? how many distinct colours (up to 257)? Is there
   one fully transparent colour a tRNS key could stand for?
3. **Try the lossless forms** that can hold it (palette in three orders,
   grey / grey+alpha, RGB with a tRNS key, RGBA) with several per-row filter
   assignments (fixed 0/1/2/4, minimum-sum, fewest-pairs, brute force weighed
   by a small zlib run). Weigh every candidate with zlib at level 6; the
   smallest wins the screen.
4. **Write the winner with our own deflate encoder**: a hash-chain match
   finder with a carried match, a shortest-path (dynamic programming) parse
   that minimises the deflate bit cost under the block's Huffman lengths,
   and a choice of fixed Huffman, one dynamic block, or dynamic blocks split
   at 2k–200k symbols where a fresh table pays for its header.

## v3 vs v2

Practice score **736,995** (v2: 726,401; +10,594), runtime ~48 s (v2: 37 s).

- The finder now matches a **3-byte prefix, not 4**: a length-3 match has a
  differing 4th byte, so the old finder could never find one directly — and
  length-3 matches are everywhere in RGB data. Worth ~+1,400 points.
- Finder widened to **chain 1024, 8 candidates, short-chain 64** (v2:
  512/4/8): +2,700 points for +1.8 s.
- Parse↔cost iteration was implemented and measured but **not shipped**:
  only ~0.5% gain for ~2.5× the time. See `NOTES.md` for the full
  measurements, the per-instance results, and the remaining gap to zopfli.

## Run

```sh
node --experimental-strip-types main.ts
```

Reads 8 screenshots from `$MAKEFUN_INPUT_DIR` (default `/input`), writes
lossless PNGs to `$MAKEFUN_OUTPUT_DIR` (default `/output`). Deterministic:
fixed choices, fixed hash seeds, no clock reads, no randomness.

## License

MIT — see `LICENSE`.
