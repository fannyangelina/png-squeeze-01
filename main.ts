// png-squeeze-01 v2: squeeze 1280x720 RGBA screenshots into the smallest
// lossless PNG we can, within a fixed amount of work (never the wall clock).
//
// Per image:
//   1. Decode the input PNG (any colour type 0/2/3/4/6, bit depth 8) to RGBA.
//   2. Analyse it: opaque? grey? how many distinct colours (up to 257)?
//      Is there one fully transparent colour a tRNS key could stand for?
//   3. Try the lossless forms that can hold it (palette in three orders,
//      grey / grey+alpha, RGB with a tRNS key, RGBA) with several per-row
//      filter assignments (fixed 0/1/2/4, minimum-sum, fewest-pairs, brute
//      force weighed by a small zlib run). Weigh every candidate with zlib
//      at level 6; the smallest wins the screen.
//   4. Write the winner with our own deflate encoder: a hash-chain match
//      finder with a carried match (the best match at the previous position
//      propagates forward one byte for free), a shortest-path (dynamic
//      programming) parse that minimises the deflate bit cost under the
//      block's Huffman lengths, and a choice of fixed Huffman, one dynamic
//      block, or dynamic blocks split at 2k–200k symbols where a fresh
//      table pays for its header. Two passes total: a greedy frequency
//      estimate, then one optimal parse. (A second re-parse gained only
//      ~0.4% for double the time, so it was dropped; chain 512 is the
//      sweet spot — 1024 gains ~2k points for +12 s, too close to the
//      60 s wall on a 1-CPU grader.) That is where the bytes go: zlib's
//      greedy matcher leaves several percent on the table against an
//      optimal parse, and this is the whole point of v2.
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

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum', 'brute']],
      ['luminance', [0, 'minsum', 'brute']],
      ['first', [0, 'minsum', 'brute']],
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
    filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'],
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
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : null);
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
const MAX_CHAIN = 512;
const SHORT_CHAIN = 8;
const MAX_MATCHES = 4;

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
  const v = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
  const maxSteps = best >= 32 ? SHORT_CHAIN : MAX_CHAIN;
  let steps = 0;
  let first = true;
  while (p >= 0 && steps < maxSteps) {
    steps++;
    if (i - p > 32768) break;
    if (((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) === v) {
      let len;
      if (first) {
        // Always record the closest candidate, even when it is shorter than
        // the carry: a short match at distance 3-4 costs only ~2 distance
        // bits and the DP uses it heavily. (Pruning it away made i002
        // 7% bigger.)
        first = false;
        len = matchLen(data, p, i, maxLen, 4);
        if (len >= 3) {
          out.push(len, i - p);
          if (len > best) best = len;
          if (len >= maxLen || out.length >= MAX_MATCHES * 2) break;
        }
      } else if (best > 4) {
        // This candidate can only beat `best` if it also matches at `best`.
        if (data[p + best] === data[i + best]) len = matchLen(data, p, i, maxLen, 4);
        else len = best; // a tie at a larger distance; dominated, skip it
        if (len > best) {
          best = len;
          out.push(len, i - p);
          if (len >= maxLen || out.length >= MAX_MATCHES * 2) break;
          if (best >= 64 && out.length >= 4) break;
        }
      } else {
        len = matchLen(data, p, i, maxLen, 4);
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

// Symbol frequencies of a parse (end of block counted once).
function freqFromParse(parse) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  const { litSym, distSym, count } = parse;
  for (let s = 0; s < count; s++) {
    litFreq[litSym[s]]++;
    if (litSym[s] >= 257) distFreq[distSym[s]]++;
  }
  litFreq[256]++;
  return { litFreq, distFreq };
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
  const w = bitWriter(Math.ceil(bestBits / 8) + 16);
  if (best.infos === null) {
    writeBits(w, 1, 1);
    writeBits(w, 1, 2); // BTYPE 01: fixed Huffman, final block
    writeSymbols(w, parse, 0, count, fixedLitCodes, FIXED_LIT_LEN, fixedDistCodes, FIXED_DIST_LEN);
  } else {
    let from = 0;
    for (let b = 0; b < best.infos.length; b++) {
      const to = best.splits === 0 ? count : Math.min(count, from + best.splits);
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

// Our own deflate for one filtered stream: greedy frequencies, then two
// shortest-path parses re-deriving the Huffman lengths, then the cheapest
// emission — wrapped in a zlib header and Adler-32.
//
// Two passes only: a greedy frequency estimate, then one optimal parse.
// A second re-parse (dp2) gained only ~0.4% on i002 for double the time,
// so it is dropped — the 60 s wall matters more than 230 bytes.
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
