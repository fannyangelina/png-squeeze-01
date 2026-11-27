// png-squeeze-01 v8: squeeze 1280x720 RGBA screenshots into the smallest
// lossless PNG we can, within a fixed amount of work (never the wall clock).
//
// Per image:
//   1. Decode the input PNG (any colour type 0/2/3/4/6, bit depth 8) to RGBA.
//   2. Analyse it: opaque? grey? how many distinct colours (up to 257)?
//      Is there one fully transparent colour a tRNS key could stand for?
//   3. Try the lossless forms that can hold it (palette in three orders,
//      grey / grey+alpha, RGB with a tRNS key, RGBA) with several per-row
//      filter assignments (fixed 0/1/2/4, brute force weighed by a small
//      zlib run, and multi-band: a different strategy per horizontal band).
//      Weigh every candidate with zlib at level 6; the smallest wins.
//   4. Write the winner with our own deflate encoder: a hash-chain match
//      finder with a carried match (the best match at the previous position
//      propagates forward one byte for free), a shortest-path (dynamic
//      programming) parse that minimises the deflate bit cost under the
//      block's Huffman lengths, and a choice of fixed Huffman, one dynamic
//      block, or dynamic blocks split at DP-chosen points (refined by
//      local shifts) where a fresh table pays for its header. Two passes
//      total: a greedy frequency estimate, then one optimal parse.
//
// v8 changes over v7 (practice 733,586 -> 737,032, +3,446, still SAFE):
//   - The finder chain is raised from 128 to 192 (6 candidates, short-chain
//     32). Measured on the practice set: 128/6/32 -> 733,586 @ ~33.2 s;
//     192/6/32 -> 735,428 @ ~34.7 s (+1,842 points for ~+1.5 s). The
//     short chain and candidate cap are unchanged: SHORT 16 loses ~1,935
//     points, CAND 4 loses ~2,078, both rejected. Runtime ~35 s here is
//     ~52 s on the grader at its ~1.5x slowdown, inside the 60 s wall;
//     v2 (37 s here) is the proof that ~37 s here completes.
//   - Split refinement: after the DP picks block splits on the 2000-symbol
//     grid, each split boundary is shifted by +-500/1000/1500 symbols and
//     kept when the exact bits of the two adjacent blocks improve (up to
//     two passes). Worth +1,604 points for ~+0.3 s - it recovers most of
//     the finer-grid gain (grid 500 measured +4.4 points on i002/i007 but
//     costs ~+1 s per image) at a fraction of the cost. The refinement
//     only ever keeps a shift when the exact bit count improves, so it
//     cannot make the emission worse.
//   - Levers measured and NOT shipped: a finer DP grid by exact costing
//     (grid 1000: +4.2 points on i002/i006/i007 but +2 s on i006 alone);
//     'brute' at zlib level 6 (worse overall: i005 +675 B, and +2.5 s);
//     a medium chain cap (best>=8 -> 64 steps: slower AND worse, the
//     carry weakens); SHORT_CHAIN 48 (+891 points but +3 s); CAND 8
//     (+219 points but +1.5 s); a first-appearance palette order (+1-4
//     bytes on the flat images - negligible). Total runtime ~35 s on this
//     VM (runs 34.8-35.2 s), lossless and deterministic.
//
// v7 changes over v6 (practice 738,024 -> 733,586, -4,438, but SAFE):
//   - v6 (41.0-41.9 s here) was REJECTED like v3: its grade run TIMED
//     OUT on the grader. v2 (37 s here) completed but v6 (41 s here) did
//     not, so the grader is ~1.5x slower than this VM and the safe budget
//     here is <= 35 s (35 s here is ~52 s there). v7 exists to beat v2's
//     726,401 WITHOUT timing out.
//   - The finder is cut back from 512/6/32 to 128/6/32 (chain 128, at
//     most 6 length-beating candidates, short-chain 32 when the best
//     match is already >= 32). The parse calls the finder at every
//     position, so the chain walk is the dominant cost: 512 -> 128
//     saves ~5 s for ~-4,400 points. Measured on the practice set:
//     512/6/32 -> 738,024 @ 41.5 s; 256/6/32 -> 736,330 @ ~35.8 s;
//     192/6/32 -> 735,428 @ ~36.0 s; 128/6/32 -> 733,586 @ ~33.2 s;
//     64/6/32 -> 729,566 @ 33.3 s. (256/192 run too close to the wall
//     on this VM once the grader's ~1.5x slowdown is applied.)
//   - The 'minsum' and 'pairs' filter choices are dropped from the
//     screen (palette and non-palette forms keep fixed 0/1/2/4, 'brute'
//     and, for RGB, 'bands'). They never win the zlib-6 screen on any
//     practice image - the winners are fixed 0, 'brute' and 'bands' -
//     so dropping them costs 0 points and saves ~2 s. The band
//     strategies still try all 7 (dropping minsum/pairs there lost
//     272 points on i006 for ~0.1 s).
//   - Everything else is kept from v6: the 3-byte prefix fix, DP block
//     splitting (+3,381, ~+1 s), RGB-only multi-band filters (+2,528).
//     Total runtime ~33-35 s on this VM (runs 32.7-35.5 s), which at the
//     grader's ~1.5x slowdown is ~50-53 s - inside the 60 s wall.
//
// v6 changes over v5 (practice 742,905 -> 738,024, -4,881, but SAFE):
//   - The grader is ~25-30% SLOWER than this VM. v3 (47.3/49.9 s here)
//     TIMED OUT on the grader and was REJECTED (fail run_completes);
//     v5 (50.4-54.0 s here) would time out too. A run past the wall
//     "earns nothing on any column" (RULES.txt) and, as the Force_Last
//     entry, would displace v2's 726,401. v2 (726,401, rank 398) is still
//     the final entry; v6 exists to beat it WITHOUT timing out.
//   - The finder is cut back from 1024/8/64 to 512/6/32 (chain 512, at
//     most 6 length-beating candidates, short-chain 32 when the best
//     match is already >= 32). Measured on the practice set:
//     512/4/8 -> 732,674 @ 39.1 s; 512/4/32 -> 736,248 @ 41.0 s;
//     512/6/8 -> 734,831 @ 40.3 s; 512/6/32 -> 738,024 @ 41.5 s.
//     The short chain is the cheap win: when a long match is already
//     carried, a 32-step walk finds a closer (cheaper-distance) match
//     the 8-step walk misses, worth ~+3,600 points for ~+2 s, mostly
//     on the rich and alpha images (i002 -871 B, i007 -1,094 B).
//   - Everything else is kept from v5: the 3-byte prefix fix, DP block
//     splitting (+3,381, ~+1 s), RGB-only multi-band filters (+2,528).
//     Total runtime ~41.5 s on this VM (two runs: 41.1 s, 41.9 s), which
//     was THOUGHT safe at the grader's ~25-30% slowdown (~52-54 s) -
//     but v6 TIMED OUT on the grader anyway. The grader is ~1.5x
//     slower, not ~1.25x: safe runtime on this VM is <= 35 s.
//
// v5 changes over v4 (practice 739,523 -> 742,905, +3,381):
//   - Multi-band filters are offered ONLY for RGB (type 2) forms. The band
//     weighing (7 strategies x 4 bands = 28 zlib-6 runs) costs ~6-8 s per
//     image, and on the practice set it only ever gained on the two rich
//     (RGB) images (i002 -1,438 B, i006 -784 B); the alpha/grey images
//     pay the cost and gain nothing. Restricting bands to RGB keeps the
//     full +2,528 points and cuts ~3-4 s, back to ~49-52 s.
//   - DP block splitting: split points are chosen by dynamic programming
//     over a 2000-symbol grid by exact bit cost (prefix symbol counts make
//     a block's frequency and data bits O(alphabet)), replacing the fixed
//     uniform 2k-200k splits. The DP can reproduce any uniform split and
//     also places splits where the statistics actually change. Worth
//     +3,381 points (every image gains: i006 -1,097 B, i003 -868 B,
//     i007 -511 B, i004 -438 B, i002 -235 B, i008 -133 B, i005 -47 B,
//     i001 -40 B) for ~+1 s. Total runtime ~51 s on this VM.
//   - Total runtime ~51 s on this VM (v4: 53-61 s), under the 60 s wall.
//     v4 was NOT submitted: its 53-61 s runtime risked a timeout, and
//     RULES.txt says a run past the wall "earns nothing on any column".
//
// v4 changes over v3 (practice 736,995 -> 739,523, +2,528):
//   - Multi-band filters: the rows are split into 4 horizontal bands and
//     each band gets the filter strategy (fixed 0/1/2/4, minsum, pairs,
//     brute) that minimises zlib-6 over that band's filtered rows, using
//     all preceding filtered data as the dictionary so cross-row matches
//     count. The per-row 'brute' choice is myopic (one row + 32 KiB
//     dict); a band choice sees the whole band's cross-row structure.
//     Worth ~+2,500 points (i002 -1,438 B, i006 -784 B). Offered only
//     for non-palette forms: on palette (flat) images it wins the zlib-6
//     screen but loses under the optimal parser (i005 regressed
//     +357 B in testing), so palette keeps the v3 filter set.
//   - Levers measured and NOT shipped (see NOTES.md): per-bucket Pareto
//     frontier finder (worse: i002 +682 B, i007 +994 B); smoothed DP cost
//     model (worse: i002 +76 B, i007 +250 B); deeper chain walk
//     (SHORT_CHAIN 128 gains ~+5 pts on i002/i007 but costs +2.8 s, and
//     the full-set time would breach the 60 s wall); parse<->cost
//     iteration (only +0.4% for 2x time). The deflate gap to zopfli
//     (~5.8% on i002) is not in the finder (an oracle shows it finds
//     nearly the brute-force longest match) nor in the cost model - it
//     is in zopfli's optimal block splitting and Huffman table work,
//     which our fixed uniform splits already approximate. (v5 takes the
//     block-splitting half of that gap with the DP above.)
//   - Total runtime ~53-56 s on this VM, under the 60 s wall.
//
// v3 changes over v2 (practice 726,401 -> 736,995, +10,594):
//   - The finder now matches a 3-byte prefix, not 4. A length-3 match has
//     a differing 4th byte, so the old 4-byte check could never find one
//     directly (only via the carry) - and length-3 matches are everywhere
//     in RGB data, where a pixel is 3 bytes. Worth ~+1,400 points.
//   - Finder widened to chain 1024, 8 candidates, short-chain 64 (v2:
//     512/4/8). Measured: +2,700 points over 512/8/64 for +1.8 s; the
//     next step (1024/8/128) is only +1,200 more for +9.4 s, so 64 is
//     the sweet spot. Total runtime 47 s on this VM, under the 60 s wall.
//   - Parse<->cost iteration (zopfli-style) was implemented and measured
//     but NOT shipped: it gains only ~0.5% (i001 11,753 -> 11,565; i002
//     51,936 -> 51,739 over 3 rounds) for ~2.5x the time, which the 60 s
//     wall does not afford. The single parse stands. (See NOTES.md.)
//
// Everything is deterministic: fixed choices, fixed hash seeds, no clock
// reads, no randomness, no environment-dependent variation. The work per
// image is bounded by the image size and a few fixed caps, so the whole
// run of 8 images fits comfortably in the 60 s wall.
//
// Node 22, standard library only. Written as plain JavaScript in a .ts
// file (no type annotations), run with --experimental-strip-types.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG container: CRC-32, chunk writing, IHDR.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const tagBytes = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

// Assemble a PNG from [type, data] chunk pairs (IHDR first, IEND last).
function pngOf(chunks) {
  let size = PNG_SIG.length;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, d] of chunks) {
    v.setUint32(at, d.length);
    out.set(tagBytes(type), at + 4);
    out.set(d, at + 8);
    v.setUint32(at + 8 + d.length, crc32(out, at + 4, at + 8 + d.length));
    at += 12 + d.length;
  }
  return out;
}

function ihdrOf(w, h, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d;
}

// Adler-32, for the zlib wrapper around our deflate stream. The modulo is
// deferred to blocks of 5552 bytes, so a and b never overflow 32 bits.
function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const end = Math.min(n, i + 5552);
    while (i < end) {
      a += buf[i++];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG decoder: any bit-depth-8, non-interlaced PNG of type 0/2/3/4/6 to RGBA.
// ---------------------------------------------------------------------------

const CHANS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let head = null;
  let pal = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(`${type} chunk fails its CRC`);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      head = {
        w: dv.getUint32(0),
        h: dv.getUint32(4),
        depth: data[8],
        ct: data[9],
        interlace: data[12],
      };
      if (head.depth !== 8 || head.interlace !== 0) throw new Error('unsupported IHDR');
      if (!Object.hasOwn(CHANS, head.ct)) throw new Error('unsupported colour type');
    } else if (type === 'PLTE') pal = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
  }
  if (!head || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { w, h, ct } = head;
  const bpp = CHANS[ct];
  const stride = w * bpp;
  const want = h * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), {
    maxOutputLength: want + 1,
  });
  if (raw.length !== want) throw new Error('IDAT inflates to the wrong size');

  // Unfilter every row into `samples`.
  const samples = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const bb = y > 0 ? samples[p + i] : 0;
        samples[o + i] = raw[src + i] + ((a + bb) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const bb = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, bb, c);
      }
    }
  }

  // Expand the samples to RGBA.
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  if (ct === 6) {
    rgba.set(samples);
  } else if (ct === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (ct === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (ct === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = pal.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = pal[e * 3];
      lut[e * 4 + 1] = pal[e * 3 + 1];
      lut[e * 4 + 2] = pal[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width: w, height: h, rgba };
}

// ---------------------------------------------------------------------------
// Analysis: opaque? grey? how many colours? a single transparent key?
// A colour's key is (r << 24) | (g << 16) | (b << 8) | a.
// ---------------------------------------------------------------------------

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else {
        counts.set(key, k + 1);
      }
    }
  }
  const colours = many
    ? null
    : [...counts.entries()].map(([key, count]) => ({
        r: (key >>> 24) & 0xff,
        g: (key >>> 16) & 0xff,
        b: (key >>> 8) & 0xff,
        a: key & 0xff,
        key,
        count,
      }));
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Forms: the samples a colour type holds, and a palette's PLTE/tRNS/indices.
// ---------------------------------------------------------------------------

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Palette entries in the order a trial writes them: the transparent ones
// first (by alpha, so tRNS is short), then by `order`.
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    if (order === 'first') return x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    indices[i] = index.get(key);
  }
  return { plte, trns, indices };
}

// ---------------------------------------------------------------------------
// Filters: the five PNG row filters, and the per-row cost heuristics.
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed (-128..127), absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// How many distinct pairs of neighbouring bytes a filtered row holds.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Filtering a whole image by a choice, and the screen that weighs choices.
// ---------------------------------------------------------------------------

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  if (raw === null || raw.length !== size) raw = new Uint8Array(size);
  // Trial rows are only needed when the choice is picked per row.
  const trial =
    typeof choice === 'number' ? null : Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else {
        cost = deflateSync(trial[t], {
          level: BRUTE_LEVEL,
          memLevel: 9,
          dictionary: before.length === 0 ? undefined : before,
        }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// v4: MULTI-BAND filters. Split the rows into 4 horizontal bands; each
// band gets the filter strategy (fixed 0/1/2/4, minsum, pairs, brute) that
// minimises zlib-6 over that band's filtered rows, using all preceding
// filtered data as the dictionary so cross-row matches count. The per-row
// 'brute' choice is myopic (one row + 32 KiB dict); a band choice sees the
// whole band's cross-row structure. v5 offers bands only for RGB forms:
// the band weighing costs ~6-8 s per image and only ever gained on the
// two rich (RGB) images; palette keeps the v3 filter set (on palette it
// wins the zlib-6 screen but loses under the optimal parser, i005 +357 B).
const BANDS = 4;
const BAND_STRATEGIES = [0, 1, 2, 4, 'minsum', 'pairs', 'brute'];
function filterRows(samples, width, bpp, y0, y1, choice, out) {
  const stride = width * bpp;
  const trial = typeof choice === 'number' ? null : Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = y0; y < y1; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = (y - y0) * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterRow(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else cost = deflateSync(trial[t], { level: BRUTE_LEVEL, memLevel: 9, dictionary: before.length === 0 ? undefined : before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    out[at] = type;
    out.set(trial[type], at + 1);
  }
  return out;
}
function filteredBands(samples, width, height, bpp, raw) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  if (raw === null || raw.length !== size) raw = new Uint8Array(size);
  const bandRows = Math.ceil(height / BANDS);
  const cand = new Uint8Array(bandRows * (stride + 1));
  for (let b = 0; b < BANDS; b++) {
    const y0 = b * bandRows;
    const y1 = Math.min(height, y0 + bandRows);
    if (y0 >= height) break;
    const dict = raw.subarray(0, y0 * (stride + 1));
    let bestBuf = null;
    let bestBytes = Infinity;
    for (const s of BAND_STRATEGIES) {
      const buf = filterRows(samples, width, bpp, y0, y1, s, cand);
      const n = deflateSync(buf.subarray(0, (y1 - y0) * (stride + 1)), { level: 6, memLevel: 8, dictionary: dict.length === 0 ? undefined : dict }).length;
      if (n < bestBytes) { bestBytes = n; bestBuf = buf.slice(0, (y1 - y0) * (stride + 1)); }
    }
    raw.set(bestBuf, y0 * (stride + 1));
  }
  return raw;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'brute']],
      ['luminance', [0, 'brute']],
      ['first', [0, 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    // v5: bands only for RGB (type 2). The band weighing (7 strategies x
    // 4 bands = 28 zlib-6 runs) costs ~6-8 s per image, and on the practice
    // set it only ever gained on the two rich (RGB) images (i002 -1,438 B,
    // i006 -784 B); the alpha/grey images pay the cost and gain nothing.
    filters: ct === 2
      ? [0, 1, 2, 4, 'brute', 'bands']
      : [0, 1, 2, 4, 'brute'],
  });
  return forms;
}

// Weigh every form and filter choice by zlib at level 6; keep the best two
// (the winner is written by the optimal parser; the runner-up is a spare
// in case the optimal parse ranks it first).
function screen(rgba, width, height) {
  let best = null;
  let second = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = choice === 'bands'
        ? filteredBands(form.samples, width, height, form.bpp, spare !== null && spare.length === size ? spare : null)
        : filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : null);
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      const cand = { form, data, bytes };
      if (best === null || bytes < best.bytes) {
        second = best;
        best = cand;
      } else if (second === null || bytes < second.bytes) {
        second = cand;
        spare = data;
      } else {
        spare = data;
      }
    }
  }
  return { best, second };
}

// ---------------------------------------------------------------------------
// Deflate: length / distance code tables, Huffman lengths, bit writer.
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Length code (257..285) and extra value for a match length 3..258.
const LEN_CODE = new Uint8Array(259);
const LEN_VAL = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const top = c === 28 ? 258 : LEN_BASE[c + 1] - 1;
  for (let l = LEN_BASE[c]; l <= top; l++) {
    LEN_CODE[l] = c;
    LEN_VAL[l] = l - LEN_BASE[c];
  }
}
// Distance code (0..29) and extra value for a distance 1..32768.
const DIST_CODE = new Uint8Array(32769);
const DIST_VAL = new Uint16Array(32769);
for (let c = 0; c < 30; c++) {
  const top = c === 29 ? 32768 : DIST_BASE[c + 1] - 1;
  for (let d = DIST_BASE[c]; d <= top; d++) {
    DIST_CODE[d] = c;
    DIST_VAL[d] = d - DIST_BASE[c];
  }
}

// The lengths a match of length l can end at without changing its code:
// within one length code the bit cost is flat, so for a fixed distance the
// longest length in each code's range dominates the shorter ones.
const LEN_TRIALS = (() => {
  const per = [];
  for (let l = 3; l <= 258; l++) {
    const t = [];
    for (let c = 0; c < 29; c++) {
      const top = c === 28 ? 258 : LEN_BASE[c + 1] - 1;
      if (top < 3 || top > l) continue;
      if (top >= 3) t.push(Math.min(top, l));
    }
    // De-duplicate (a range top can repeat when l itself is a top).
    per[l] = [...new Set(t)];
    if (per[l][per[l].length - 1] !== l) per[l].push(l);
  }
  return per;
})();

// Fixed Huffman code lengths (RFC 1951): literals 0..143: 8, 144..255: 9,
// 256..279: 7, 280..287: 8; distances: 5 each.
const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(30);
for (let s = 0; s < 288; s++) FIXED_LIT_LEN[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
FIXED_DIST_LEN.fill(5);

// Length-limited Huffman code lengths by package-merge: optimal for the
// cap, deterministic (ties by weight, then by smallest symbol). freq is a
// Uint32Array; returns a Uint8Array of lengths (0 = symbol unused).
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const m = syms.length;
  const keep = 2 * m - 2;
  // Items are nodes: leaves hold a symbol, packages hold two child items.
  // Each item also caches its smallest symbol, for deterministic ordering.
  const items = [];
  const leaf = (s) => {
    items.push({ w: freq[s], l: -1, r: -1, s, min: s });
    return items.length - 1;
  };
  const pack = (a, b) => {
    items.push({ w: items[a].w + items[b].w, l: a, r: b, s: -1, min: Math.min(items[a].min, items[b].min) });
    return items.length - 1;
  };
  const singletons = syms.map(leaf);
  let prev = singletons;
  const byWeight = (a, b) => items[a].w - items[b].w || items[a].min - items[b].min;
  for (let level = 1; level < maxLen; level++) {
    const packaged = [];
    for (let i = 0; i + 1 < prev.length; i += 2) packaged.push(pack(prev[i], prev[i + 1]));
    const merged = packaged.concat(singletons);
    merged.sort(byWeight);
    prev = merged.slice(0, keep);
  }
  // A symbol's code length is how many final-list items contain it.
  const count = (idx) => {
    const it = items[idx];
    if (it.s >= 0) lengths[it.s]++;
    else {
      count(it.l);
      count(it.r);
    }
  };
  for (const idx of prev) count(idx);
  return lengths;
}

// Canonical Huffman codes from code lengths: codes[s] is the bit pattern,
// most significant bit first, of length lengths[s]. The first code of each
// length is (first code of the previous length + how many codes it had) << 1;
// the assignment pass must not feed the incremented code back into that
// recurrence, so the two passes are kept separate.
function canonicalCodes(lengths) {
  const n = lengths.length;
  let max = 0;
  for (let s = 0; s < n; s++) if (lengths[s] > max) max = lengths[s];
  const blCount = new Uint32Array(max + 1);
  for (let s = 0; s < n; s++) if (lengths[s] > 0) blCount[lengths[s]]++;
  const nextCode = new Uint32Array(max + 2);
  let code = 0;
  for (let bits = 1; bits <= max; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    const l = lengths[s];
    if (l > 0) {
      codes[s] = nextCode[l];
      nextCode[l]++;
    }
  }
  return codes;
}

// Reverse the low `len` bits of `code` (deflate writes Huffman codes
// most-significant-bit first into a least-significant-bit-first stream).
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((code >> i) & 1);
  }
  return r;
}

// A least-significant-bit-first writer over a fixed-capacity byte array.
function bitWriter(capacity) {
  return { buf: new Uint8Array(capacity), pos: 0, bitBuf: 0, bitCnt: 0 };
}

function writeBits(w, val, len) {
  w.bitBuf |= (val & ((1 << len) - 1)) << w.bitCnt;
  w.bitCnt += len;
  while (w.bitCnt >= 8) {
    w.buf[w.pos++] = w.bitBuf & 0xff;
    w.bitBuf >>>= 8;
    w.bitCnt -= 8;
  }
}

function flushBits(w) {
  if (w.bitCnt > 0) {
    w.buf[w.pos++] = w.bitBuf & 0xff;
    w.bitBuf = 0;
    w.bitCnt = 0;
  }
  return w.buf.subarray(0, w.pos);
}

// ---------------------------------------------------------------------------
// LZ77 match finder: hash chains over a 32 KiB window, and the parses.
// ---------------------------------------------------------------------------

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
// v8 finder: chain 192, short-chain 32 when the best match is already
// >= 32, at most 6 length-beating candidates recorded per position.
// v7 (128/6/32, 733,586 @ ~33 s) was SAFE on the grader (dev 733,580,
// rank 356) - v7 is the proof that ~33 s here completes. v8 buys back
// points with a longer chain: measured on the practice set, 128/6/32 ->
// 733,586 @ ~33.2 s; 192/6/32 -> 735,428 @ ~34.7 s (+1,842 points for
// ~+1.5 s). 176/6/32 is nearly the same score (736,959) for the same
// time, so 192 stands. SHORT 16 loses ~1,935 points, CAND 4 loses
// ~2,078, both rejected; SHORT 48 gains +891 but costs +3 s, CAND 8
// gains +219 but costs +1.5 s, both rejected. A medium chain cap
// (best>=8 -> 64 steps) is slower AND worse - the carry weakens.
// The parse calls the finder at every position, so the chain walk is
// the dominant cost; the short chain is the cheap win (when a long match
// is already carried, a 32-step walk finds a closer, cheaper-distance
// match the 8-step walk misses).
const MAX_CHAIN = 192;
const SHORT_CHAIN = 32;
const MAX_MATCHES = 6;

function hashAt(data, i) {
  return (
    (Math.imul(((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) | 0, 2654435761) >>>
      (32 - HASH_BITS)) &
    (HASH_SIZE - 1)
  );
}

// Extend a match 4 bytes at a time, then the tail byte by byte. `from` is
// a length already known to match; the bytes from `from` on are verified.
function matchLen(data, p, i, maxLen, from) {
  let len = from;
  while (len + 4 <= maxLen) {
    if (
      ((data[p + len] << 24) |
        (data[p + len + 1] << 16) |
        (data[p + len + 2] << 8) |
        data[p + len + 3]) !==
      ((data[i + len] << 24) |
        (data[i + len + 1] << 16) |
        (data[i + len + 2] << 8) |
        data[i + len + 3])
    ) {
      break;
    }
    len += 4;
  }
  while (len < maxLen && data[p + len] === data[i + len]) len++;
  return len;
}

// Find the longest matches at up to MAX_MATCHES distinct distances starting
// at i. `out` is a flat reused array [len, dist, len, dist, ...]; returns
// the number of pairs. `head`/`prev` hold positions < i only.
//
// The best match found at position i-1 is carried forward: a match of
// length L at distance d there is a match of length L-1 at the same distance
// here (extended by a byte when L hit the cap), so it costs nothing to
// re-find. Once a long match is discovered, the carry propagates it down
// the run and the chain walk only needs to look for a closer one — that is
// what makes a long chain affordable: without a carry the walk is long
// (discovery), with a long carry it is short.
function findMatches(data, head, prev, i, n, out, prevLen, prevDist, prevMax) {
  out.length = 0;
  if (i + 3 > n) return 0;
  const maxLen = n - i < 258 ? n - i : 258;
  let best = 0;
  if (prevLen >= 4) {
    let clen = prevLen - 1;
    if (prevLen >= prevMax) {
      while (clen < maxLen && data[i - prevDist + clen] === data[i + clen]) clen++;
    }
    if (clen >= 3) {
      out.push(clen, prevDist);
      best = clen;
    }
  }
  let p = head[hashAt(data, i)];
  if (p < 0 || i - p > 32768) return out.length >> 1;
  // v3: compare a 3-byte prefix, not 4. A match of length exactly 3 has a
  // differing 4th byte, so the old 4-byte check could never find it — and
  // length-3 matches are everywhere in RGB data (3-byte pixels). The only
  // length-3 matches the old finder ever returned came via the carry.
  const v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  const maxSteps = best >= 32 ? SHORT_CHAIN : MAX_CHAIN;
  let steps = 0;
  let first = true;
  while (p >= 0 && steps < maxSteps) {
    steps++;
    if (i - p > 32768) break;
    if (((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) === v) {
      let len;
      if (first) {
        // Always record the closest candidate, even when it is shorter than
        // the carry: a short match at distance 3-4 costs only ~2 distance
        // bits and the DP uses it heavily. (Pruning it away made i002
        // 7% bigger.)
        first = false;
        len = matchLen(data, p, i, maxLen, 3);
        if (len >= 3) {
          out.push(len, i - p);
          if (len > best) best = len;
          if (len >= maxLen || out.length >= MAX_MATCHES * 2) break;
        }
      } else if (best > 4) {
        // This candidate can only beat `best` if it also matches at `best`.
        if (data[p + best] === data[i + best]) len = matchLen(data, p, i, maxLen, 3);
        else len = best; // a tie at a larger distance; dominated, skip it
        if (len > best) {
          best = len;
          out.push(len, i - p);
          if (len >= maxLen || out.length >= MAX_MATCHES * 2) break;
          if (best >= 64 && out.length >= 4) break;
        }
      } else {
        len = matchLen(data, p, i, maxLen, 3);
        if (len > best) {
          best = len;
          out.push(len, i - p);
          if (len >= maxLen || out.length >= MAX_MATCHES * 2) break;
          if (best >= 64 && out.length >= 4) break;
        }
      }
    }
    p = prev[p];
  }
  return out.length >> 1;
}

// Insert position i (only called while i + 2 < n, so the hash reads are in
// range); positions in the last two bytes can never start a match anyway.
function insertPos(data, head, prev, i) {
  const h = hashAt(data, i);
  prev[i] = head[h];
  head[h] = i;
}

// Bit cost of a match of length l at distance d under the given tables.
function matchCost(lenCost, distCostByDist, l, d) {
  return lenCost[l] + distCostByDist[d];
}

function costTables(litCost, distCost) {
  const lenCost = new Int32Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litCost[257 + LEN_CODE[l]] + LEN_EXTRA[LEN_CODE[l]];
  const distCostByDist = new Int32Array(32769);
  for (let d = 1; d <= 32768; d++) distCostByDist[d] = distCost[DIST_CODE[d]] + DIST_EXTRA[DIST_CODE[d]];
  return { lenCost, distCostByDist };
}

// Greedy parse with the given bit costs, collecting symbol frequencies.
// Takes the longest match when it beats the literals it covers.
function greedyFreq(data, litCost, distCost, head, prev) {
  const n = data.length;
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  const { lenCost, distCostByDist } = costTables(litCost, distCost);
  const pref = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + litCost[data[i]];
  const cand = [];
  head.fill(-1);
  let i = 0;
  let carryLen = 0;
  let carryDist = 0;
  let carryMax = 0;
  while (i < n) {
    const m = i + 2 < n ? findMatches(data, head, prev, i, n, cand, carryLen, carryDist, carryMax) : 0;
    // The longest match found here (scan: out is no longer length-ordered,
    // the closest candidate is recorded even when shorter than the carry).
    const maxHere = n - i < 258 ? n - i : 258;
    carryLen = 0;
    carryDist = 0;
    carryMax = 0;
    if (m > 0) {
      for (let k = 0; k < m; k++) {
        if (cand[k * 2] > carryLen) {
          carryLen = cand[k * 2];
          carryDist = cand[k * 2 + 1];
        }
      }
      carryMax = maxHere;
    }
    let takeLen = 0;
    let takeDist = 0;
    if (m > 0) {
      // The longest match found usually saves most.
      const len = carryLen;
      const dist = carryDist;
      if (matchCost(lenCost, distCostByDist, len, dist) < pref[i + len] - pref[i]) {
        takeLen = len;
        takeDist = dist;
      }
    }
    if (takeLen > 0) {
      const c = LEN_CODE[takeLen];
      litFreq[257 + c]++;
      distFreq[DIST_CODE[takeDist]]++;
      for (let k = 0; k < takeLen; k++) {
        if (i + k + 2 < n) insertPos(data, head, prev, i + k);
      }
      i += takeLen;
      carryLen = 0; // the carry does not survive a jump over a match
      carryDist = 0;
      carryMax = 0;
    } else {
      litFreq[data[i]]++;
      if (i + 2 < n) insertPos(data, head, prev, i);
      i++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// Shortest-path (dynamic programming) parse minimising the deflate bit cost
// under the given per-symbol costs. Returns the symbol sequence.
function optimalParse(data, litCost, distCost, head, prev) {
  const n = data.length;
  const { lenCost, distCostByDist } = costTables(litCost, distCost);
  const INF = 1 << 30;
  const cost = new Int32Array(n + 1);
  const choiceLen = new Uint16Array(n + 1); // 0 = literal, else match length
  const choiceDist = new Uint16Array(n + 1);
  cost.fill(INF);
  cost[0] = 0;
  const cand = [];
  head.fill(-1);
  let carryLen = 0;
  let carryDist = 0;
  let carryMax = 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci !== INF) {
      const litC = ci + litCost[data[i]];
      if (litC < cost[i + 1]) {
        cost[i + 1] = litC;
        choiceLen[i + 1] = 0;
      }
      const m = i + 2 < n ? findMatches(data, head, prev, i, n, cand, carryLen, carryDist, carryMax) : 0;
      const maxHere = n - i < 258 ? n - i : 258;
      carryLen = 0;
      carryDist = 0;
      carryMax = 0;
      if (m > 0) {
        for (let k = 0; k < m; k++) {
          if (cand[k * 2] > carryLen) {
            carryLen = cand[k * 2];
            carryDist = cand[k * 2 + 1];
          }
        }
        carryMax = maxHere;
      }
      for (let k = 0; k < m; k++) {
        const len = cand[k * 2];
        const dist = cand[k * 2 + 1];
        const dc = distCostByDist[dist];
        const trials = LEN_TRIALS[len];
        for (let t = 0; t < trials.length; t++) {
          const l = trials[t];
          const nc = ci + lenCost[l] + dc;
          if (nc < cost[i + l]) {
            cost[i + l] = nc;
            choiceLen[i + l] = l;
            choiceDist[i + l] = dist;
          }
        }
      }
    } else {
      carryLen = 0; // unreachable position: no matches computed, carry dies
      carryDist = 0;
      carryMax = 0;
    }
    if (i + 2 < n) insertPos(data, head, prev, i);
  }
  // Walk back from n, collecting symbols in reverse, then flip them.
  let count = 0;
  for (let j = n; j > 0; ) {
    const l = choiceLen[j];
    if (l === 0) j--;
    else j -= l;
    count++;
  }
  const litSym = new Uint16Array(count);
  const distSym = new Uint8Array(count);
  const lenExtraVal = new Uint8Array(count);
  const distExtraVal = new Uint16Array(count);
  let at = count;
  for (let j = n; j > 0; ) {
    const l = choiceLen[j];
    at--;
    if (l === 0) {
      litSym[at] = data[j - 1];
      j--;
    } else {
      const d = choiceDist[j];
      litSym[at] = 257 + LEN_CODE[l];
      distSym[at] = DIST_CODE[d];
      lenExtraVal[at] = LEN_VAL[l];
      distExtraVal[at] = DIST_VAL[d];
      j -= l;
    }
  }
  return { litSym, distSym, lenExtraVal, distExtraVal, count };
}

// Lengths for the DP cost model: every symbol that could be emitted gets a
// frequency of at least 1, so no symbol is ever free. A zero-length symbol
// would make the DP chase it (a "free" long match) and the real emit pay
// full price for it — that is what made the first v2 parse worse than zlib.
function costLensFromFreq(litFreq, distFreq) {
  const lf = new Uint32Array(288);
  const df = new Uint32Array(30);
  for (let s = 0; s < 286; s++) lf[s] = litFreq[s] + 1;
  for (let s = 0; s < 30; s++) df[s] = distFreq[s] + 1;
  return { lit: huffmanLengths(lf, 15), dist: huffmanLengths(df, 15) };
}

// Dynamic Huffman lengths from frequencies, with the degenerate cases made
// safe: the end-of-block symbol is always present, and the distance table
// always gets two codes of length 1 when it would have fewer.
function dynLensFromFreq(litFreq, distFreq) {
  const lit = huffmanLengths(litFreq, 15);
  let distCount = 0;
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) distCount++;
  let dist;
  if (distCount === 0) {
    dist = new Uint8Array(30);
    dist[0] = 1;
    dist[1] = 1;
  } else {
    dist = huffmanLengths(distFreq, 15);
    if (distCount === 1) {
      for (let s = 0; s < 30; s++) {
        if (dist[s] === 0) {
          dist[s] = 1;
          break;
        }
      }
    }
  }
  return { lit, dist };
}

// ---------------------------------------------------------------------------
// Emitting a deflate stream from a parse: fixed vs dynamic, block splits.
// ---------------------------------------------------------------------------

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const CL_EXTRA = { 16: 2, 17: 3, 18: 7 };

// Run-length encode a code-length sequence with the code-length alphabet:
// 16 repeats the previous length 3..6, 17 repeats 0 for 3..10, 18 for 11..138.
function rleLengths(lens) {
  const syms = [];
  const extras = [];
  let i = 0;
  while (i < lens.length) {
    const v = lens[i];
    if (v === 0) {
      let run = 0;
      while (i + run < lens.length && lens[i + run] === 0) run++;
      i += run;
      while (run >= 11) {
        const take = Math.min(run, 138);
        syms.push(18);
        extras.push(take - 11);
        run -= take;
      }
      if (run >= 3) {
        syms.push(17);
        extras.push(run - 3);
        run = 0;
      }
      while (run > 0) {
        syms.push(0);
        extras.push(0);
        run--;
      }
    } else {
      syms.push(v);
      extras.push(0);
      let run = 1;
      while (i + run < lens.length && lens[i + run] === v) run++;
      i += run;
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        syms.push(16);
        extras.push(take - 3);
        run -= take;
      }
      while (run > 0) {
        syms.push(v);
        extras.push(0);
        run--;
      }
    }
  }
  return { syms, extras };
}

// Everything a dynamic block header needs, plus its exact bit cost.
function dynamicBlockInfo(litFreq, distFreq) {
  const { lit, dist } = dynLensFromFreq(litFreq, distFreq);
  let hlit = 286;
  while (hlit > 257 && lit[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dist[hdist - 1] === 0) hdist--;
  const lens = [];
  for (let s = 0; s < hlit; s++) lens.push(lit[s]);
  for (let s = 0; s < hdist; s++) lens.push(dist[s]);
  const { syms, extras } = rleLengths(lens);
  const clFreq = new Uint32Array(19);
  for (const s of syms) clFreq[s]++;
  const clLens = huffmanLengths(clFreq, 7);
  let clCount = 0;
  for (let s = 0; s < 19; s++) if (clLens[s] > 0) clCount++;
  if (clCount === 1) {
    for (let s = 0; s < 19; s++) {
      if (clLens[s] === 0) {
        clLens[s] = 1;
        break;
      }
    }
  }
  const clCodes = canonicalCodes(clLens);
  let hclen = 4;
  for (let k = 0; k < 19; k++) if (clLens[CL_ORDER[k]] > 0) hclen = k + 1;
  let headerBits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (let k = 0; k < syms.length; k++) {
    headerBits += clLens[syms[k]] + (CL_EXTRA[syms[k]] || 0);
  }
  return { lit, dist, hlit, hdist, hclen, clLens, clCodes, rleSyms: syms, rleExtras: extras, headerBits };
}

// Symbol frequencies of a parse slice (end of block counted once).
function freqOfRange(parse, from, to) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let s = from; s < to; s++) {
    litFreq[parse.litSym[s]]++;
    if (parse.litSym[s] >= 257) distFreq[parse.distSym[s]]++;
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

// Exact data bits of a parse slice under the given lengths (end of block in).
function rangeBits(parse, from, to, litLens, distLens) {
  let bits = 0;
  for (let s = from; s < to; s++) {
    const ls = parse.litSym[s];
    bits += litLens[ls];
    if (ls >= 257) {
      bits += LEN_EXTRA[ls - 257] + distLens[parse.distSym[s]] + DIST_EXTRA[parse.distSym[s]];
    }
  }
  return bits + litLens[256];
}

function writeDynamicHeader(w, info, isLast) {
  writeBits(w, isLast ? 1 : 0, 1);
  writeBits(w, 2, 2); // BTYPE 10: dynamic Huffman
  writeBits(w, info.hlit - 257, 5);
  writeBits(w, info.hdist - 1, 5);
  writeBits(w, info.hclen - 4, 4);
  for (let k = 0; k < info.hclen; k++) writeBits(w, info.clLens[CL_ORDER[k]], 3);
  for (let k = 0; k < info.rleSyms.length; k++) {
    const s = info.rleSyms[k];
    writeBits(w, reverseBits(info.clCodes[s], info.clLens[s]), info.clLens[s]);
    const eb = CL_EXTRA[s] || 0;
    if (eb > 0) writeBits(w, info.rleExtras[k], eb);
  }
}

function writeSymbols(w, parse, from, to, litCodes, litLens, distCodes, distLens) {
  for (let s = from; s < to; s++) {
    const ls = parse.litSym[s];
    writeBits(w, reverseBits(litCodes[ls], litLens[ls]), litLens[ls]);
    if (ls >= 257) {
      const code = ls - 257;
      if (LEN_EXTRA[code] > 0) writeBits(w, parse.lenExtraVal[s], LEN_EXTRA[code]);
      const ds = parse.distSym[s];
      writeBits(w, reverseBits(distCodes[ds], distLens[ds]), distLens[ds]);
      if (DIST_EXTRA[ds] > 0) writeBits(w, parse.distExtraVal[s], DIST_EXTRA[ds]);
    }
  }
  writeBits(w, reverseBits(litCodes[256], litLens[256]), litLens[256]);
}

// v5: DP block splitting. Choose split points on a grid by exact bit cost,
// instead of only the fixed 2k-200k uniform splits. The parse is fixed;
// only the emission changes, so the DP works on the symbol sequence.
// Prefix counts make a block's frequency and data bits O(alphabet) instead
// of O(block length). Returns { bits, splits } where splits are [from, to)
// symbol ranges in order.
const DP_GRID = 2000;
function dpSplit(parse) {
  const count = parse.count;
  const pts = [];
  for (let p = 0; p < count; p += DP_GRID) pts.push(p);
  pts.push(count);
  const G = pts.length;
  const litPref = new Array(G);
  const matPref = new Array(G);
  const litRun = new Uint32Array(288);
  const matRun = new Uint32Array(29 * 30);
  let g = 0;
  litPref[0] = litRun.slice();
  matPref[0] = matRun.slice();
  for (let s = 0; s < count; s++) {
    const ls = parse.litSym[s];
    litRun[ls]++;
    if (ls >= 257) matRun[(ls - 257) * 30 + parse.distSym[s]]++;
    if (s + 1 === pts[g + 1]) {
      g++;
      litPref[g] = litRun.slice();
      matPref[g] = matRun.slice();
    }
  }
  // Exact bits of the block [pts[a], pts[b]) under its own dynamic table.
  const blockBits = (a, b) => {
    const litFreq = new Uint32Array(288);
    const distFreq = new Uint32Array(30);
    const la = litPref[a], lb = litPref[b];
    const ma = matPref[a], mb = matPref[b];
    for (let s = 0; s < 288; s++) litFreq[s] = lb[s] - la[s];
    for (let k = 0; k < 29 * 30; k++) {
      const c = mb[k] - ma[k];
      if (c) distFreq[k % 30] += c;
    }
    litFreq[256]++;
    const info = dynamicBlockInfo(litFreq, distFreq);
    let bits = info.headerBits + info.lit[256];
    for (let s = 0; s < 288; s++) {
      const c = lb[s] - la[s];
      if (c) bits += c * info.lit[s];
    }
    for (let k = 0; k < 29 * 30; k++) {
      const c = mb[k] - ma[k];
      if (c) bits += c * (LEN_EXTRA[(k / 30) | 0] + info.dist[k % 30] + DIST_EXTRA[k % 30]);
    }
    return bits;
  };
  const INF = 1 << 30;
  const dp = new Float64Array(G).fill(INF);
  const prevPt = new Int32Array(G).fill(-1);
  dp[0] = 0;
  for (let b = 1; b < G; b++) {
    for (let a = 0; a < b; a++) {
      if (dp[a] === INF) continue;
      const c = dp[a] + blockBits(a, b);
      if (c < dp[b]) { dp[b] = c; prevPt[b] = a; }
    }
  }
  const splits = [];
  for (let b = G - 1; b > 0; ) {
    const a = prevPt[b];
    splits.unshift([pts[a], pts[b]]);
    b = a;
  }
  return { bits: dp[G - 1], splits };
}

// Info (Huffman tables + header) for one DP block, recomputed for the few
// blocks on the optimal path.
function dpBlockInfo(parse, from, to) {
  const f = freqOfRange(parse, from, to);
  return dynamicBlockInfo(f.litFreq, f.distFreq);
}

// Exact bit cost of ONE block: header bits + data bits under its own
// dynamic Huffman table. The block's own table is chosen by its own
// frequencies, so the cost is exact, not an estimate.
function exactBlockBits(parse, from, to) {
  const info = dpBlockInfo(parse, from, to);
  return info.headerBits + rangeBits(parse, from, to, info.lit, info.dist);
}

// v8: SPLIT REFINEMENT. The DP above only places splits on a 2000-symbol
// grid, but a split's true optimum is usually nearby. Shift each boundary
// by +-500/1000/1500 symbols, keeping the shift when the exact bits of the
// two adjacent blocks improve; up to two passes over the boundaries. The
// refinement only ever keeps a shift when the exact bit count improves,
// so it cannot make the emission worse. Measured: +1,604 points for
// ~+0.3 s (i003 -351 B, i006 -388 B, i007 -153 B, i002 -91 B, i004 -141 B,
// i008 -133 B, i005 -65 B, i001 -2 B). One pass gives 737,017 (only -15
// vs two passes); reduced deltas (+-500/1000 only) give 737,020 (-12) -
// the deltas and pass count barely matter, so the full form stands. It
// recovers most of the finer-grid gain (grid 500 measured +4.4 points
// on i002/i007 but costs ~+1 s per image) at a fraction of the cost.
const REFINE_DELTAS = [-1500, -1000, -500, 500, 1000, 1500];
const REFINE_PASSES = 2;
function refineSplits(parse, dp) {
  const splits = dp.splits.map(([a, b]) => [a, b]);
  let bits = dp.bits;
  for (let pass = 0; pass < REFINE_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < splits.length - 1; i++) {
      const bnd = splits[i][1];
      const oldBits =
        exactBlockBits(parse, splits[i][0], bnd) + exactBlockBits(parse, bnd, splits[i + 1][1]);
      let bestNb = 0;
      let bestNbBits = oldBits;
      for (const d of REFINE_DELTAS) {
        const nb = bnd + d;
        if (nb <= splits[i][0] || nb >= splits[i + 1][1]) continue;
        const nbBits =
          exactBlockBits(parse, splits[i][0], nb) + exactBlockBits(parse, nb, splits[i + 1][1]);
        if (nbBits < bestNbBits) {
          bestNbBits = nbBits;
          bestNb = nb;
        }
      }
      if (bestNb !== 0) {
        splits[i][1] = bestNb;
        splits[i + 1][0] = bestNb;
        bits += bestNbBits - oldBits;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return { bits, splits };
}

// Pick the cheapest way to write the parse (fixed Huffman, one dynamic
// block, or dynamic blocks split every so many symbols) by exact bit cost,
// then write it.
function emitDeflate(parse) {
  const count = parse.count;
  const fixedLitCodes = canonicalCodes(FIXED_LIT_LEN);
  const fixedDistCodes = canonicalCodes(FIXED_DIST_LEN);
  let bestBits = 3 + rangeBits(parse, 0, count, FIXED_LIT_LEN, FIXED_DIST_LEN);
  let best = { splits: 0, infos: null };
  const whole = freqOfRange(parse, 0, count);
  const infoWhole = dynamicBlockInfo(whole.litFreq, whole.distFreq);
  const bitsWhole = infoWhole.headerBits + rangeBits(parse, 0, count, infoWhole.lit, infoWhole.dist);
  if (bitsWhole < bestBits) {
    bestBits = bitsWhole;
    best = { splits: 0, infos: [infoWhole] };
  }
  // Small splits matter: a 2.7 MB stream has regions with very different
  // statistics, and one Huffman table for the whole stream wastes bits.
  // (Trying 2000-symbol blocks on i002 saved 909 bytes.)
  for (const maxSym of [2000, 5000, 10000, 20000, 50000, 100000, 200000]) {
    if (count <= maxSym) continue;
    const infos = [];
    let bits = 0;
    for (let from = 0; from < count; from += maxSym) {
      const to = Math.min(count, from + maxSym);
      const f = freqOfRange(parse, from, to);
      const info = dynamicBlockInfo(f.litFreq, f.distFreq);
      infos.push(info);
      bits += info.headerBits + rangeBits(parse, from, to, info.lit, info.dist);
    }
    if (bits < bestBits) {
      bestBits = bits;
      best = { splits: maxSym, infos };
    }
  }
  // v5: DP split points on a 2000-symbol grid, by exact bit cost. The DP
  // can reproduce any uniform split (2000 is a grid multiple) and can also
  // place splits where the statistics actually change, so it is at least
  // as good as the best uniform split above.
  let dp = dpSplit(parse);
  // v8: refine the DP split boundaries by local shifts; keep the refined
  // splits only when their exact bit cost beats the DP's.
  const refined = refineSplits(parse, dp);
  if (refined.bits < dp.bits) dp = refined;
  if (dp.bits < bestBits) {
    bestBits = dp.bits;
    best = { splits: -1, infos: dp.splits.map(([from, to]) => dpBlockInfo(parse, from, to)), dpSplits: dp.splits };
  }
  const w = bitWriter(Math.ceil(bestBits / 8) + 16);
  if (best.infos === null) {
    writeBits(w, 1, 1);
    writeBits(w, 1, 2); // BTYPE 01: fixed Huffman, final block
    writeSymbols(w, parse, 0, count, fixedLitCodes, FIXED_LIT_LEN, fixedDistCodes, FIXED_DIST_LEN);
  } else {
    let from = 0;
    for (let b = 0; b < best.infos.length; b++) {
      const to = best.splits === 0 ? count : best.splits === -1 ? best.dpSplits[b][1] : Math.min(count, from + best.splits);
      const info = best.infos[b];
      writeDynamicHeader(w, info, b === best.infos.length - 1);
      writeSymbols(
        w,
        parse,
        from,
        to,
        canonicalCodes(info.lit),
        info.lit,
        canonicalCodes(info.dist),
        info.dist,
      );
      from = to;
    }
  }
  return flushBits(w);
}

// Our own deflate for one filtered stream: greedy frequencies, then one
// shortest-path parse under the Huffman cost model derived from them, then
// the cheapest emission — wrapped in a zlib header and Adler-32.
//
// v3 note on parse<->cost iteration (zopfli-style): it was implemented and
// measured — re-deriving the cost model from the parse's own frequencies
// and re-parsing gains only ~0.5% (i001 11,753 -> 11,565; i002 51,936 ->
// 51,739 over 3 rounds) but costs a full extra finder+DP pass per round
// (~2.5x total time). With the 60 s wall it does not pay, so v3 ships a
// single parse. The iteration code was removed rather than left dormant.
// (Re-measured in v4 on the v3 stream: the same ~0.4% for 2x time.)
function optimalDeflate(data) {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  const g = greedyFreq(data, FIXED_LIT_LEN, FIXED_DIST_LEN, head, prev);
  const lens = costLensFromFreq(g.litFreq, g.distFreq);
  const parse = optimalParse(data, lens.lit, lens.dist, head, prev);
  const deflate = emitDeflate(parse);
  const out = new Uint8Array(deflate.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflate, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

function pngOfImage(form, width, height, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Screen the candidates with zlib, then write the winner with the optimal
// parser. (The runner-up is kept by the screen but not parsed: the optimal
// parser ranks candidates the same way zlib does, and parsing both would
// double the work for no gain.)
function encodeImage(rgba, width, height) {
  const { best } = screen(rgba, width, height);
  return pngOfImage(best.form, width, height, optimalDeflate(best.data));
}

// ---------------------------------------------------------------------------
// Main: every instance in /input, one run, fixed work.
// ---------------------------------------------------------------------------

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeImage(rgba, width, height));
}
