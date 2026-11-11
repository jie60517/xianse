// Film-look texture effects, applied after colour grading. Port of analysis/effects.py.
//
//   import { applyEffects, DEFAULTS } from "./effects.js";
//   applyEffects(imageData.data, w, h, { grain: 0.6 }, seed, p => progress(p));
//
// Pure computation: no DOM / Canvas, runs in a Web Worker or in Node.
// Order (physical): vignette -> diffusion -> halation -> grain -> texture (all on linear RGB)
// -> dust & scratches (on display RGB). All sizes are fractions of the long edge.
//
// Memory: the image lives in three Float32Array planes (linear R, G, B). Big blurs run on
// block-averaged copies and are upsampled row by row; grain noise is generated in horizontal
// strips from a counter-based PRNG (any pixel's noise can be recomputed), so no further
// image-size arrays are needed.

export const DEFAULTS = {
  // --- vignette (off by default) ---
  vignette: 0.0,              // 0..1, 1 = corners lose ~70% of their light
  vignette_radius: 0.65,      // where darkening starts (1 = frame corner)
  vignette_softness: 0.6,     // width of the falloff
  vignette_roundness: 0.5,    // 0 = follows the frame's aspect, 1 = circular
  // --- soft focus / diffusion (mist-filter style) ---
  diffusion: 0.3,             // 0..1, mix of scattered light
  diffusion_radius: 0.010,    // glow sigma, fraction of long edge (a second skirt uses 3x)
  diffusion_highlights: 0.5,  // extra bloom for bright areas
  diffusion_threshold: 0.45,  // linear luminance where highlight bloom starts
  // --- halation ---
  halation: 0.35,
  halation_radius: 0.004,     // sigma of the inner glow (outer skirt uses 3.5x)
  halation_threshold: 0.55,   // linear level (max channel) where highlights start to halate
  halation_tint: [1.0, 0.30, 0.08],
  // --- grain ---
  grain: 0.5,
  grain_size: 0.00035,        // grain cell as fraction of long edge
  grain_clump: 0.4,           // weight of the coarser clumping component
  grain_chroma: 0.25,         // colour noise relative to luminance noise
  grain_shadows: 1.15,        // envelope exponent towards black
  grain_highlights: 0.95,     // envelope exponent towards white
  // --- texture (film base / print mottling) ---
  texture: 0.25,              // 0..1, multiplicative; 1 = about +-4% light variation
  texture_scale: 0.03,        // largest mottle size, fraction of long edge
  texture_color: 0.3,         // share of the mottling that is a slight colour shift
  // --- dust & scratches ---
  dust: 0.2,                  // 0..1, number of defects (1 = ~60 specks, ~5 hairs, ~3 scratches)
  dust_size: 1.0,
  dust_light: 0.8,            // fraction of defects that are light
  dust_hairs: 1.0,
  dust_scratches: 1.0,
};

const EFFECT_KEYS = ["vignette", "diffusion", "halation", "grain", "texture", "dust"];
const GRAIN_K = 0.047;   // OKLab-L std of the grain at strength 1 when a grain cell >= 1 px

// ------------------------------------------------------------------------------------- colour
// OKLab matrices (M1: linear sRGB -> LMS, M2: LMS' -> Lab), same numbers as analysis/style.py
const M1 = [0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566,
            0.0883024619, 0.2817188376, 0.6299787005];
const M2 = [0.2104542553, 0.7936177850, -0.0040720468, 1.9779984951, -2.4285922050, 0.4505937099,
            0.0259040371, 0.7827717662, -0.8086757660];

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const M1i = inv3(M1), M2i = inv3(M2);

const LIN_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const ENC_N = 65536;
let ENC_LUT = null;   // linear -> sRGB-encoded 0..1, 16-bit LUT (built on first use)
function encLut() {
  if (!ENC_LUT) {
    ENC_LUT = new Float32Array(ENC_N);
    for (let i = 0; i < ENC_N; i++) {
      const x = i / (ENC_N - 1);
      ENC_LUT[i] = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    }
  }
  return ENC_LUT;
}

const smoothstep = (e0, e1, x) => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------- random
// mulberry32's mixing function; also used as a counter-based hash (mulberry32 at step n is
// hash32(seed + n * 0x6D2B79F5)), so noise for any pixel can be recomputed independently.
function hash32(a) {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}
const U32 = 1 / 4294967296;

function streamSeed(seed, k) {
  return hash32(hash32(seed | 0) ^ Math.imul(k + 1, 0x9E3779B9));
}

/** Sequential PRNG (mulberry32) with the few distributions the effects need. */
function makeRng(seed, k) {
  let s = streamSeed(seed, k);
  let spare = NaN;
  const random = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) * U32;
  };
  const normal = () => {   // Box-Muller, second value cached
    if (spare === spare) { const v = spare; spare = NaN; return v; }
    const u1 = 1 - random(), u2 = random();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
  return {
    random,
    normal,
    uniform: (a, b) => a + (b - a) * random(),
    normals(n) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = normal(); return a; },
    poisson(lam) {          // Knuth; lam is at most a few hundred here
      if (lam <= 0) return 0;
      if (lam > 500) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal()));
      const L = Math.exp(-lam); let k = 0, p = 1;
      do { k++; p *= random(); } while (p > L);
      return k - 1;
    },
    pareto: (a) => Math.pow(1 - random(), -1 / a) - 1,   // numpy's pareto (Lomax)
  };
}

// ------------------------------------------------------------------------------------- blur
// 1-D gaussian of one line (src[off + i*stride], i < n) into dst (may be the same array).
// Direct kernel (scipy-like, radius int(4 sigma + 0.5)) for small sigma, three box passes above.
const BOX_MIN_SIGMA = 5;
let padBuf = new Float64Array(1024), tmpBuf = new Float64Array(1024);
const kernelCache = new Map();

function gaussKernel(sigma) {
  let k = kernelCache.get(sigma);
  if (k) return k;
  const r = Math.max(1, Math.floor(4 * sigma + 0.5));
  k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  if (kernelCache.size > 64) kernelCache.clear();
  kernelCache.set(sigma, k);
  return k;
}

function boxRadii(sigma) {   // three box widths whose combined variance matches sigma^2
  const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const r = [];
  for (let i = 0; i < n; i++) r.push(((i < m ? wl : wl + 2) - 1) / 2);
  return r;
}

function padIndex(i, n, mode) {
  if (i >= 0 && i < n) return i;
  if (mode === "wrap") return ((i % n) + n) % n;
  if (mode === "reflect") {   // scipy 'reflect': d c b a | a b c d | d c b a
    const p = 2 * n, m = ((i % p) + p) % p;
    return m < n ? m : p - 1 - m;
  }
  return i < 0 ? 0 : n - 1;   // 'nearest'
}

function blurLine(src, off, stride, n, sigma, mode, dst, doff, dstride) {
  const direct = sigma < BOX_MIN_SIGMA;
  const kern = direct ? gaussKernel(sigma) : null;
  const radii = direct ? null : boxRadii(sigma);
  const P = direct ? (kern.length - 1) / 2 : radii[0] + radii[1] + radii[2];
  const len = n + 2 * P;
  if (padBuf.length < len) { padBuf = new Float64Array(len * 2); tmpBuf = new Float64Array(len * 2); }
  const pad = padBuf;
  for (let i = 0; i < len; i++) pad[i] = src[off + padIndex(i - P, n, mode) * stride];
  if (direct) {
    const K = kern.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < K; k++) s += kern[k] * pad[i + k];
      dst[doff + i * dstride] = s;
    }
    return;
  }
  // three running-sum box passes, each shrinking the valid region by its radius on both sides
  let a = pad, b = tmpBuf, m = len;
  for (const r of radii) {
    const w = 2 * r + 1, inv = 1 / w, out = m - 2 * r;
    let s = 0;
    for (let i = 0; i < w; i++) s += a[i];
    b[0] = s * inv;
    for (let i = 1; i < out; i++) { s += a[i + 2 * r] - a[i - 1]; b[i] = s * inv; }
    const t = a; a = b; b = t; m = out;
  }
  for (let i = 0; i < n; i++) dst[doff + i * dstride] = a[i];
}

/** Gaussian blur of a w x h plane, returns a new Float32Array. mode: nearest | wrap | reflect. */
function blurPlane(src, w, h, sigma, mode = "nearest") {
  const out = new Float32Array(src);
  if (!(sigma > 0)) return out;
  for (let y = 0; y < h; y++) blurLine(out, y * w, 1, w, sigma, mode, out, y * w, 1);
  for (let x = 0; x < w; x++) blurLine(out, x, w, h, sigma, mode, out, x, w);
  return out;
}

function blur1d(arr, sigma, mode) {   // in place on a Float64Array
  if (sigma > 0) blurLine(arr, 0, 1, arr.length, sigma, mode, arr, 0, 1);
  return arr;
}

// ------------------------------------------------------------------------------------- resampling
const factorOf = (sigma) => (sigma > 4 ? Math.max(1, Math.floor(sigma / 2.5)) : 1);

/** Block-average by integer f (edges replicated). getRow(y) returns a length-W view of row y. */
function downRows(W, H, f, getRow) {
  const sw = Math.ceil(W / f), sh = Math.ceil(H / f);
  const out = new Float32Array(sw * sh);
  const full = Math.floor(W / f), rem = W - full * f, padX = sw * f - W;
  const inv = 1 / (f * f);
  for (let sy = 0; sy < sh; sy++) {
    const o = sy * sw;
    for (let yy = 0; yy < f; yy++) {
      const row = getRow(Math.min(sy * f + yy, H - 1));
      let x = 0;
      for (let sx = 0; sx < full; sx++) {
        let s = 0;
        for (let k = 0; k < f; k++) s += row[x++];
        out[o + sx] += s;
      }
      if (rem) {
        let s = 0;
        for (let k = 0; k < rem; k++) s += row[x++];
        out[o + full] += s + padX * row[W - 1];
      }
    }
    for (let sx = 0; sx < sw; sx++) out[o + sx] *= inv;
  }
  return { data: out, w: sw, h: sh };
}

function down(plane, W, H, f) {
  if (f === 1) return { data: plane, w: W, h: H };
  return downRows(W, H, f, (y) => plane.subarray(y * W, y * W + W));
}

function axisMap(n, f, nSmall) {   // bilinear, pixel-centre aligned, same as effects.py _upsample
  const i0 = new Int32Array(n), i1 = new Int32Array(n), t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / f - 0.5;
    let a = Math.floor(p); a = a < 0 ? 0 : a > nSmall - 1 ? nSmall - 1 : a;
    i0[i] = a; i1[i] = Math.min(a + 1, nSmall - 1);
    const tt = p - a; t[i] = tt < 0 ? 0 : tt > 1 ? 1 : tt;
  }
  return { i0, i1, t };
}

/** Returns row(y, out) that writes row y of the bilinear upsample (to W x H) of a small plane. */
function makeUpsampler(small, sw, sh, f, W, H) {
  if (f === 1) return (y, out) => out.set(small.subarray(y * W, y * W + W));
  const X = axisMap(W, f, sw), Y = axisMap(H, f, sh), tmp = new Float32Array(sw);
  return (y, out) => {
    const r0 = Y.i0[y] * sw, r1 = Y.i1[y] * sw, t = Y.t[y];
    for (let x = 0; x < sw; x++) { const a = small[r0 + x]; tmp[x] = a + (small[r1 + x] - a) * t; }
    const { i0, i1, t: tx } = X;
    for (let x = 0; x < W; x++) { const a = tmp[i0[x]]; out[x] = a + (tmp[i1[x]] - a) * tx[x]; }
  };
}

/** effects.py _blur_small: the block mean already blurred by ~f/sqrt(12); take that off. */
function blurSmall(small, w, h, f, sigma) {
  const s = Math.sqrt(Math.max(sigma * sigma - (f > 1 ? f * f / 12 : 0), 0.25)) / f;
  return blurPlane(small, w, h, s, "nearest");
}

// ------------------------------------------------------------------------------------- effects
function vignette(img, p) {
  const st = p.vignette;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const radius = p.vignette_radius, soft = p.vignette_softness, rnd = p.vignette_roundness;
  const a = W / Math.max(H, W), b = H / Math.max(H, W);
  const sx = (1 - rnd) + rnd * a, sy = (1 - rnd) + rnd * b;
  const norm = 1 / Math.sqrt(sx * sx + sy * sy);
  const hx = Math.max(1, (W - 1) / 2), hy = Math.max(1, (H - 1) / 2);
  const xx = new Float64Array(W);
  for (let x = 0; x < W; x++) { const v = (x - (W - 1) / 2) / hx * sx; xx[x] = v * v; }
  for (let y = 0; y < H; y++) {
    const v = (y - (H - 1) / 2) / hy * sy, yy = v * v, o = y * W;
    for (let x = 0; x < W; x++) {
      const r = Math.sqrt(xx[x] + yy) * norm;
      const g = 1 - 0.7 * st * smoothstep(radius, radius + soft, r);
      R[o + x] *= g; G[o + x] *= g; B[o + x] *= g;
    }
  }
}

function diffusion(img, p) {
  const st = p.diffusion;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const r = p.diffusion_radius * Math.max(W, H);
  const a = 0.30 * st, f = factorOf(r);
  const sm = [R, G, B].map((c) => down(c, W, H, f));
  const sw = sm[0].w, sh = sm[0].h, n = sw * sh;
  // scattered light: wide = 0.6 G(r) + 0.4 G(3r); out = (1-a) lin + a wide + bloom, summed at low res
  const acc = sm.map(({ data }) => {
    const g1 = blurSmall(data, sw, sh, f, r), g3 = blurSmall(data, sw, sh, f, 3 * r);
    for (let i = 0; i < n; i++) g1[i] = a * (0.6 * g1[i] + 0.4 * g3[i]);
    return g1;
  });
  if (p.diffusion_highlights > 0) {
    const th = p.diffusion_threshold, k = 0.35 * st * p.diffusion_highlights;
    const w = new Float32Array(n);
    const [sr, sg, sb] = sm.map((s) => s.data);
    for (let i = 0; i < n; i++) w[i] = smoothstep(th, th + 0.45, 0.2126 * sr[i] + 0.7152 * sg[i] + 0.0722 * sb[i]);
    sm.forEach(({ data }, c) => {
      const hl = new Float32Array(n);
      for (let i = 0; i < n; i++) hl[i] = data[i] * w[i];
      const g1 = blurSmall(hl, sw, sh, f, r), g3 = blurSmall(hl, sw, sh, f, 3 * r);
      const A = acc[c];
      for (let i = 0; i < n; i++) A[i] += k * (0.5 * g1[i] + 0.5 * g3[i]);
    });
  }
  const ups = acc.map((A) => makeUpsampler(A, sw, sh, f, W, H));
  const row = new Float32Array(W), keep = 1 - a;
  [R, G, B].forEach((C, c) => {
    for (let y = 0; y < H; y++) {
      ups[c](y, row);
      const o = y * W;
      for (let x = 0; x < W; x++) C[o + x] = C[o + x] * keep + row[x];
    }
  });
}

function halation(img, p) {
  const st = p.halation;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const L = Math.max(W, H), r = p.halation_radius * L;
  const th = p.halation_threshold, th2 = Math.min(th + 0.4, 1.0);
  // S = highlight signal (max channel, soft-thresholded); built row by row, only its low-res copy is kept
  const f = factorOf(r);
  const srow = new Float32Array(W);
  const S = (o, x) => {
    let m = R[o + x]; if (G[o + x] > m) m = G[o + x]; if (B[o + x] > m) m = B[o + x];
    return m;
  };
  const small = downRows(W, H, f, (y) => {
    const o = y * W;
    for (let x = 0; x < W; x++) { const m = S(o, x); srow[x] = m * smoothstep(th, th2, m); }
    return srow;
  });
  // blur_mix: 0.55 G(r) + 0.45 G(3.5 r) at the resolution set by the smaller sigma
  const g1 = blurSmall(small.data, small.w, small.h, f, r);
  const g2 = blurSmall(small.data, small.w, small.h, f, 3.5 * r);
  for (let i = 0; i < g1.length; i++) g1[i] = 0.55 * g1[i] + 0.45 * g2[i];
  const up = makeUpsampler(g1, small.w, small.h, f, W, H);
  const k = 1.6 * st, [tr, tg, tb] = p.halation_tint;
  const halo = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    up(y, halo);
    const o = y * W;
    for (let x = 0; x < W; x++) {
      const m = S(o, x);
      // only the glow that spills past the highlight, and little of it where the receiver is bright
      let spill = halo[x] - m * smoothstep(th, th2, m);
      if (spill <= 0) continue;
      spill *= k * (1 - 0.85 * smoothstep(0.5 * th, th, m));
      R[o + x] += spill * tr; G[o + x] += spill * tg; B[o + x] += spill * tb;
    }
  }
}

// --- grain noise: gaussian-filtered white noise, made per strip from a counter-based PRNG -------
/**
 * Unnormalised noise field for full-res region [x0, x0+w) x [y0, y0+h) into out (w*h).
 * The field is white noise at 1/fl resolution, blurred with sigmaLow (low-res px) and bilinearly
 * upsampled. White noise is a pure function of (salt, low-res x, y), so strips join seamlessly
 * and the field has no edges (effects.py uses 'wrap' on a finite field; statistically the same).
 */
function noiseField(salt, sigmaLow, fl, x0, y0, w, h, out) {
  const lo = (X) => (fl === 1 ? X : Math.floor((X + 0.5) / fl - 0.5));
  const lx0 = lo(x0), lx1 = lo(x0 + w - 1) + (fl > 1 ? 1 : 0);
  const ly0 = lo(y0), ly1 = lo(y0 + h - 1) + (fl > 1 ? 1 : 0);
  const kern = gaussKernel(sigmaLow), r = (kern.length - 1) / 2, K = kern.length;
  const lw = lx1 - lx0 + 1, lh = ly1 - ly0 + 1;
  const gw = lw + 2 * r, gh = lh + 2 * r;
  // White noise: one hash per cell, the sum of its 4 bytes (mean 510, var 21845). Not gaussian per
  // cell, but the field is a blur over many cells, so it is gaussian for all practical purposes
  // (the excess kurtosis -0.3 is divided by the ~7..40 cells each output averages) and it is
  // several times cheaper than Box-Muller. Scale does not matter: fieldNorm() measures it.
  const g = new Float32Array(gw * gh);
  const colKey = new Uint32Array(gw);
  for (let i = 0; i < gw; i++) colKey[i] = hash32((lx0 - r + i) ^ salt);
  const salt2 = hash32(salt ^ 0x5bd1e995);
  for (let j = 0; j < gh; j++) {
    const rk = hash32((ly0 - r + j) ^ salt2), o = j * gw;
    for (let i = 0; i < gw; i++) {
      const k = hash32(colKey[i] ^ rk);
      g[o + i] = (k & 255) + ((k >>> 8) & 255) + ((k >>> 16) & 255) + (k >>> 24) - 510;
    }
  }
  // separable valid convolution with the symmetric kernel (pairs folded: half the multiplies)
  const kc = kern[r];
  const hp = new Float32Array(lw * gh);   // horizontal pass: lw x gh
  for (let j = 0; j < gh; j++) {
    const o = j * gw, oo = j * lw;
    for (let i = 0; i < lw; i++) {
      const b = o + i;
      let s = kc * g[b + r];
      for (let k = 0; k < r; k++) s += kern[k] * (g[b + k] + g[b + K - 1 - k]);
      hp[oo + i] = s;
    }
  }
  const lowres = fl === 1 ? out : new Float32Array(lw * lh);   // vertical pass: lw x lh
  for (let j = 0; j < lh; j++) {
    const oo = j * lw, bc = (j + r) * lw;
    for (let i = 0; i < lw; i++) {
      let s = kc * hp[bc + i];
      for (let k = 0; k < r; k++) s += kern[k] * (hp[(j + k) * lw + i] + hp[(j + K - 1 - k) * lw + i]);
      lowres[oo + i] = s;
    }
  }
  if (fl === 1) return out;
  // bilinear upsample (no clamping needed: the field extends past the image)
  const xi = new Int32Array(w), xt = new Float32Array(w), tmp = new Float32Array(lw);
  for (let i = 0; i < w; i++) {
    const pp = (x0 + i + 0.5) / fl - 0.5, a = Math.floor(pp);
    xi[i] = a - lx0; xt[i] = pp - a;
  }
  for (let j = 0; j < h; j++) {
    const pp = (y0 + j + 0.5) / fl - 0.5, a = Math.floor(pp), t = pp - a;
    const r0 = (a - ly0) * lw, r1 = r0 + lw;
    for (let i = 0; i < lw; i++) { const v = lowres[r0 + i]; tmp[i] = v + (lowres[r1 + i] - v) * t; }
    const o = j * w;
    for (let i = 0; i < w; i++) { const v = tmp[xi[i]]; out[o + i] = v + (tmp[xi[i] + 1] - v) * xt[i]; }
  }
  return out;
}

/** 1 / std of a field, measured on a 512 x 512 sample (effects.py also normalises empirically). */
const NORM_CACHE = new Map();   // results depend only on (salt, sigma, factor); reused while a slider is dragged
function fieldNorm(salt, sigmaLow, fl) {
  const key = salt + "|" + sigmaLow + "|" + fl, hit = NORM_CACHE.get(key);
  if (hit !== undefined) return hit;
  const v = fieldNormCompute(salt, sigmaLow, fl);
  if (NORM_CACHE.size > 64) NORM_CACHE.clear();
  NORM_CACHE.set(key, v);
  return v;
}
function fieldNormCompute(salt, sigmaLow, fl) {
  const n = 512, a = noiseField(salt, sigmaLow, fl, 0, 0, n, n, new Float32Array(n * n));
  let s = 0, s2 = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; s2 += a[i] * a[i]; }
  const m = s / a.length;
  return 1 / (Math.sqrt(Math.max(s2 / a.length - m * m, 0)) + 1e-12);
}

function grain(img, p, seed) {
  const st = p.grain;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const c = p.grain_size * Math.max(W, H);
  const amp = GRAIN_K * st * Math.min(1, c);   // c < 1: each pixel averages 1/c^2 grain cells
  const sig = Math.sqrt((0.5 * c) ** 2 + 0.7 ** 2);   // 0.7 px stands for the scanner / lens MTF
  const clump = p.grain_clump, chroma = p.grain_chroma;
  const base = streamSeed(seed, 1);
  const spec = (k, sigma, fl) => {
    const salt = hash32(base ^ Math.imul(k + 1, 0x27d4eb2d));
    return { salt, sl: sigma / fl, fl, norm: fieldNorm(salt, sigma / fl, fl) };
  };
  const fN = spec(0, sig, 1);
  const fC = clump > 0 ? spec(1, 2.5 * sig, 2.5 * sig >= 2.5 ? 2 : 1) : null;
  const flc = 1.6 * sig >= 2.0 ? 2 : 1;
  const fA = chroma > 0 ? spec(2, 1.6 * sig, flc) : null;
  const fB = chroma > 0 ? spec(3, 1.6 * sig, flc) : null;
  const kN = fN.norm / Math.sqrt(1 + (fC ? clump * clump : 0));
  const kC = fC ? clump * fC.norm / Math.sqrt(1 + clump * clump) : 0;
  const kA = fA ? chroma * fA.norm : 0, kB = fB ? chroma * fB.norm : 0;

  // envelope w(L) = L^a (1-L)^b normalised to peak 1, tabulated over OKLab L
  const ea = p.grain_shadows, eb = p.grain_highlights, Lp = ea / (ea + eb);
  const NE = 4096, env = new Float32Array(NE + 2);
  for (let i = 0; i <= NE + 1; i++) {
    const Lc = Math.min(Math.max(i / NE, 1e-4), 1 - 1e-4);
    env[i] = amp * Math.exp(ea * Math.log(Lc / Lp) + eb * Math.log((1 - Lc) / (1 - Lp)));
  }
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = M1;
  const [b00, b01, b02] = M2;
  const [c00, c01, c02, c10, c11, c12, c20, c21, c22] = M2i;
  const [d00, d01, d02, d10, d11, d12, d20, d21, d22] = M1i;

  const SH = 128;
  const nb = new Float32Array(W * SH), cb = fC && new Float32Array(W * SH);
  const ab = fA && new Float32Array(W * SH), bb = fB && new Float32Array(W * SH);
  for (let y0 = 0; y0 < H; y0 += SH) {
    const h = Math.min(SH, H - y0);
    noiseField(fN.salt, fN.sl, 1, 0, y0, W, h, nb);
    if (fC) noiseField(fC.salt, fC.sl, fC.fl, 0, y0, W, h, cb);
    if (fA) { noiseField(fA.salt, fA.sl, fA.fl, 0, y0, W, h, ab); noiseField(fB.salt, fB.sl, fB.fl, 0, y0, W, h, bb); }
    const o0 = y0 * W, cnt = h * W;
    for (let i = 0; i < cnt; i++) {
      const o = o0 + i;
      const r = R[o] > 0 ? R[o] : 0, g = G[o] > 0 ? G[o] : 0, b = B[o] > 0 ? B[o] : 0;
      let l = Math.cbrt(a00 * r + a01 * g + a02 * b);
      let m = Math.cbrt(a10 * r + a11 * g + a12 * b);
      let s = Math.cbrt(a20 * r + a21 * g + a22 * b);
      let Lok = (b00 * l + b01 * m + b02 * s) * NE;
      Lok = Lok < 0 ? 0 : Lok > NE ? NE : Lok;
      const li = Lok | 0, e = env[li] + (env[li + 1] - env[li]) * (Lok - li);
      const dL = (kN * nb[i] + (fC ? kC * cb[i] : 0)) * e;
      if (fA) {
        const da = kA * ab[i] * e, db = kB * bb[i] * e;
        l += c00 * dL + c01 * da + c02 * db;
        m += c10 * dL + c11 * da + c12 * db;
        s += c20 * dL + c21 * da + c22 * db;
      } else {
        l += c00 * dL; m += c10 * dL; s += c20 * dL;
      }
      l = l * l * l; m = m * m * m; s = s * s * s;
      R[o] = d00 * l + d01 * m + d02 * s;
      G[o] = d10 * l + d11 * m + d12 * s;
      B[o] = d20 * l + d21 * m + d22 * s;
    }
  }
}

const TEXTURE_CACHE = new Map();   // same seed, size and scale give the same mottle; only its strength changes
function texture(img, p, seed) {
  const st = p.texture;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const L = Math.max(W, H), scale = p.texture_scale, color = p.texture_color;
  const rng = makeRng(seed, 2);
  const octaves = [[1.0, 1.0], [0.4, 0.55], [0.15, 0.3]];   // (size relative to scale, weight)
  const f = Math.max(1, Math.floor(0.15 * scale * L / 3));  // all octaves are smooth enough for this grid
  const w = Math.ceil(W / f), h = Math.ceil(H / f), n = w * h;
  const fractal = () => {
    const t = new Float32Array(n);
    let wsum = 0;
    for (const [k, wgt] of octaves) {
      const wn = new Float32Array(n);
      for (let i = 0; i < n; i++) wn[i] = rng.normal();
      const b = blurPlane(wn, w, h, k * scale * L / f, "wrap");
      let s = 0, s2 = 0;
      for (let i = 0; i < n; i++) { s += b[i]; s2 += b[i] * b[i]; }
      const mean = s / n, sd = Math.sqrt(Math.max(s2 / n - mean * mean, 0)) + 1e-12;
      for (let i = 0; i < n; i++) t[i] += wgt * b[i] / sd;
      wsum += wgt * wgt;
    }
    const k = 1 / Math.sqrt(wsum);
    for (let i = 0; i < n; i++) t[i] *= k;
    return t;
  };
  const amp = 0.04 * st;
  const tkey = seed + "|" + W + "|" + H + "|" + scale + "|" + (color > 0 ? 1 : 0);
  let cached = TEXTURE_CACHE.get(tkey);
  if (!cached) {
    cached = { t1: fractal(), t2: color > 0 ? fractal() : null };
    if (TEXTURE_CACHE.size > 6) TEXTURE_CACHE.clear();
    TEXTURE_CACHE.set(tkey, cached);
  }
  const { t1, t2 } = cached;
  const cvec = [1.0, 0.1, -0.9];   // slight warm/cool drift, like uneven base density
  [R, G, B].forEach((C, c) => {
    const fac = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lf = amp * (1 - color) * t1[i];
      if (t2) lf += amp * color * t2[i] * cvec[c];
      fac[i] = Math.exp(lf);
    }
    const up = makeUpsampler(fac, w, h, f, W, H), row = new Float32Array(W);
    for (let y = 0; y < H; y++) {
      up(y, row);
      const o = y * W;
      for (let x = 0; x < W; x++) C[o + x] *= row[x];
    }
  });
}

// --- dust & scratches -------------------------------------------------------------------------
/** Irregular, anti-aliased blob of radius r px (supersampled), opacity 0..1. */
function speck(rng, r) {
  const R = Math.ceil(3.2 * r) + 2;
  const ss = R < 40 ? 4 : 2;
  const n = 2 * R + 1, N = n * ss;
  const cov = new Float32Array(N * N);
  const blobs = [[0, 0, r]];
  if (rng.random() < 0.3) {
    const a = rng.uniform(0, 2 * Math.PI);
    blobs.push([1.3 * r * Math.sin(a), 1.3 * r * Math.cos(a), r * rng.uniform(0.3, 0.6)]);
  }
  const harm = [[2, 0.2], [3, 0.15], [5, 0.1], [8, 0.06], [13, 0.04]];
  for (const [cy, cx, rb] of blobs) {
    const ang = rng.uniform(0, Math.PI);
    const elong = rng.random() < 0.35 ? rng.uniform(1.0, 2.2) : 1.0;
    const amps = harm.map(([, a]) => rng.uniform(-a, a)), phs = harm.map(() => rng.uniform(0, 6.28));
    const ca = Math.cos(ang), sa = Math.sin(ang), soft = Math.max(0.8, 0.15 * rb);
    for (let iy = 0; iy < N; iy++) {
      const Y = (iy - R * ss + 0.5) / ss - cy;
      for (let ix = 0; ix < N; ix++) {
        const X = (ix - R * ss + 0.5) / ss - cx;
        const xr = X * ca + Y * sa, yr = -X * sa + Y * ca;
        const d = Math.hypot(xr / elong, yr), th = Math.atan2(yr, xr);
        let q = 1;
        for (let k = 0; k < 5; k++) q += amps[k] * Math.cos(harm[k][0] * th + phs[k]);
        const rad = rb * q;
        let c = (rad - d) / soft + 0.5; c = c < 0 ? 0 : c > 1 ? 1 : c;
        let core = 1 - d / rad; core = core < 0 ? 0 : core > 1 ? 1 : core;
        c *= 0.75 + 0.25 * core;
        const j = iy * N + ix;
        if (c > cov[j]) cov[j] = c;
      }
    }
  }
  const out = new Float32Array(n * n), inv = 1 / (ss * ss);
  for (let iy = 0; iy < N; iy++)
    for (let ix = 0; ix < N; ix++) out[((iy / ss) | 0) * n + ((ix / ss) | 0)] += cov[iy * N + ix] * inv;
  return { data: out, w: n, h: n, R };
}

/** Polyline (ys, xs spaced <= 0.5 px) of given width into a patch; ink per unit length conserved. */
function pathPatch(ys, xs, width, opac) {
  const N = ys.length, sb = Math.max(width / 2.5, 0.5), pad = Math.ceil(4 * sb) + 2;
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (ys[i] < ymin) ymin = ys[i]; if (ys[i] > ymax) ymax = ys[i];
    if (xs[i] < xmin) xmin = xs[i]; if (xs[i] > xmax) xmax = xs[i];
  }
  const y0 = Math.floor(ymin) - pad, x0 = Math.floor(xmin) - pad;
  const h = Math.ceil(ymax) + pad - y0 + 1, w = Math.ceil(xmax) + pad - x0 + 1;
  const patch = new Float32Array(w * h);
  const arr = typeof opac !== "number";
  for (let i = 0; i < N; i++) {
    const seg = i === 0 ? 0 : Math.hypot(ys[i] - ys[i - 1], xs[i] - xs[i - 1]);
    const wt = arr ? seg * opac[i] : seg;
    if (wt === 0) continue;
    const py = ys[i] - y0, px = xs[i] - x0, iy = Math.floor(py), ix = Math.floor(px);
    const fy = py - iy, fx = px - ix, o = iy * w + ix;
    patch[o] += wt * (1 - fy) * (1 - fx); patch[o + w] += wt * fy * (1 - fx);
    patch[o + 1] += wt * (1 - fy) * fx; patch[o + w + 1] += wt * fy * fx;
  }
  const out = blurPlane(patch, w, h, sb, "reflect");
  const k = (arr ? 1 : opac) * width / (Math.sqrt(2 * Math.PI) * sb);
  for (let i = 0; i < out.length; i++) { const v = out[i] * k; out[i] = v > 1 ? 1 : v; }
  return { data: out, w, h, y0, x0 };
}

function dust(img, p, seed) {
  const st = p.dust;
  if (st <= 0) return;
  const { R, G, B, W, H } = img;
  const L = Math.max(W, H), size = p.dust_size;
  const rng = makeRng(seed, 3);
  // defects are collected and applied light-first, then dark, which equals effects.py's two union masks
  const light = [], dark = [];
  const pick = () => (rng.random() < p.dust_light ? light : dark);

  // specks: power-law sizes (many tiny, few larger)
  const nSpeck = rng.poisson(60 * st);
  for (let i = 0; i < nSpeck; i++) {
    const r = Math.min(size * L * 0.0008 * (rng.pareto(1.6) + 1), size * L * 0.0035);
    const sp = speck(rng, r), list = pick(), op = rng.uniform(0.55, 0.95);
    for (let j = 0; j < sp.data.length; j++) sp.data[j] *= op;
    list.push({ ...sp, y0: Math.floor(rng.uniform(0, H)) - sp.R, x0: Math.floor(rng.uniform(0, W)) - sp.R });
  }

  // hairs / fibres: random walks whose curvature drifts slowly plus a little kinking
  const nHair = rng.poisson(5 * st * p.dust_hairs);
  for (let i = 0; i < nHair; i++) {
    const length = size * L * rng.uniform(0.015, 0.07);
    const n = Math.floor(length / 0.4) + 2;
    const bend = rng.normals(n);
    const bk = rng.uniform(1.5, 6) / length * 0.4 / Math.sqrt(n);
    for (let j = 1; j < n; j++) bend[j] += bend[j - 1];
    const kink = blur1d(rng.normals(n), n / 25, "reflect");
    const kk = Math.sqrt(n / 25) * 0.25 / Math.max(n / 25, 1);
    let th = rng.uniform(0, 2 * Math.PI), py = rng.uniform(0, H), px = rng.uniform(0, W);
    const ys = new Float64Array(n), xs = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      th += bend[j] * bk + kink[j] * kk;
      py += Math.sin(th) * 0.4; px += Math.cos(th) * 0.4;
      ys[j] = py; xs[j] = px;
    }
    const width = size * L * rng.uniform(0.0003, 0.0006);
    pick().push(pathPatch(ys, xs, width, rng.uniform(0.6, 0.9)));
  }

  // vertical scratches: long, very thin, slight wobble, broken in places, mostly light
  const nScr = rng.poisson(3 * st * p.dust_scratches);
  for (let i = 0; i < nScr; i++) {
    const ya = rng.uniform(-0.3, 0.6) * H, yb = ya + rng.uniform(0.3, 1.0) * H;
    const s0 = Math.max(0, ya), s1 = Math.min(H - 1, yb);
    const n = Math.max(0, Math.ceil((s1 - s0) / 0.5));
    if (n < 10) continue;
    const ys = new Float64Array(n);
    for (let j = 0; j < n; j++) ys[j] = s0 + 0.5 * j;
    const wob = blur1d(rng.normals(n), n / 8, "nearest");
    let wmax = 0;
    for (let j = 0; j < n; j++) wmax = Math.max(wmax, Math.abs(wob[j]));
    const wk = L * rng.uniform(0.0005, 0.002) / (wmax + 1e-9), xc = rng.uniform(0.03, 0.97) * W;
    const xs = new Float64Array(n);
    for (let j = 0; j < n; j++) xs[j] = xc + wob[j] * wk;
    const on = blur1d(rng.normals(n), Math.max(4.0, n / 40), "nearest");
    let s = 0, s2 = 0;
    for (let j = 0; j < n; j++) { s += on[j]; s2 += on[j] * on[j]; }
    const sd = Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 0)) + 1e-9;
    const width = L * rng.uniform(0.00012, 0.00025), op = rng.uniform(0.25, 0.5);
    for (let j = 0; j < n; j++) {
      let v = on[j] / sd + 0.8; v = v < 0 ? 0 : v > 1 ? 1 : v;          // breaks along the scratch
      const u = j / (n - 1), e = Math.min(1, Math.min(u, 1 - u) / 0.05);  // fade in/out at the ends
      on[j] = op * v * e;
    }
    const patch = pathPatch(ys, xs, width, on);
    (rng.random() < 0.85 ? light : dark).push(patch);
  }

  const stamp = (pt, target) => {
    const ya = Math.max(0, pt.y0), xa = Math.max(0, pt.x0);
    const yb = Math.min(H, pt.y0 + pt.h), xb = Math.min(W, pt.x0 + pt.w);
    for (let y = ya; y < yb; y++) {
      const po = (y - pt.y0) * pt.w - pt.x0, o = y * W;
      for (let x = xa; x < xb; x++) {
        const a = pt.data[po + x];
        if (a <= 0) continue;
        const k = 1 - a, add = target * a;
        R[o + x] = R[o + x] * k + add; G[o + x] = G[o + x] * k + add; B[o + x] = B[o + x] * k + add;
      }
    }
  };
  for (const pt of light) stamp(pt, 0.93);
  for (const pt of dark) stamp(pt, 0.04);
}

// ------------------------------------------------------------------------------------- pipeline
/**
 * Apply all enabled effects in place. rgba: Uint8ClampedArray (RGBA, row-major); alpha untouched.
 * params override DEFAULTS (unknown keys throw). Deterministic for a given seed.
 * onProgress(fraction 0..1) is called after each stage.
 */
export function applyEffects(rgba, width, height, params = {}, seed = 0, onProgress = null) {
  const p = { ...DEFAULTS };
  for (const k of Object.keys(params || {})) {
    if (!(k in DEFAULTS)) throw new Error(`unknown effect parameter: ${k}`);
    p[k] = params[k];
  }
  const W = width | 0, H = height | 0, N = W * H;
  if (rgba.length < N * 4) throw new Error("rgba buffer smaller than width*height*4");
  const report = (v) => { if (onProgress) onProgress(v); };
  if (EFFECT_KEYS.every((k) => !(p[k] > 0)) || N === 0) { report(1); return; }

  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    R[i] = LIN_LUT[rgba[j]]; G[i] = LIN_LUT[rgba[j + 1]]; B[i] = LIN_LUT[rgba[j + 2]];
  }
  const img = { R, G, B, W, H };
  // rough share of the run time of each stage, for the progress callback
  const stages = [
    [() => vignette(img, p), 0.05], [() => diffusion(img, p), 0.10], [() => halation(img, p), 0.10],
    [() => grain(img, p, seed), 0.45], [() => texture(img, p, seed), 0.08],
  ];
  let done = 0.04;
  for (const [fn, w] of stages) { fn(); done += w; report(done); }

  // linear -> display (16-bit LUT, as effects.py)
  const enc = encLut();
  for (const C of [R, G, B]) {
    for (let i = 0; i < N; i++) {
      let v = C[i]; v = v < 0 ? 0 : v > 1 ? 1 : v;
      C[i] = enc[(v * (ENC_N - 1) + 0.5) | 0];
    }
  }
  dust(img, p, seed);
  report(0.95);

  // quantise; without grain, dither +-0.5 LSB so smooth glows and vignettes do not band
  const rng = p.grain <= 0 ? makeRng(seed, 9) : null;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const d = rng ? rng.random() : 0.5;
    let r = R[i] * 255 + d, g = G[i] * 255 + d, b = B[i] * 255 + d;
    rgba[j] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    rgba[j + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    rgba[j + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  }
  report(1);
}
