// Look v2 in the browser - a port of analysis/look.py. No DOM: runs in a Worker and in Node.
// The photo is measured first (analyse), then each ingredient of the look is applied only as
// far as that photo needs it. All colour maths is in OKLab.

// Average chroma the reference photos carry in each of 10 lightness zones (models/group_07.json "tc").
export const REF_TC = [0.01615, 0.01613, 0.02587, 0.04061, 0.051, 0.05651, 0.05573, 0.04439, 0.03064, 0.01662];
const LC = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

export const P = {
  white_cap: 0.925, knee: 0.74, black_floor: 0.085, toe_keep: 0.55, density: 0.22, shadow_colour: 0.85, max_colour_gain: 1.55,
  hi_desat: 0.30, warm_hi: [0.0035, 0.0085], warm_sh: [0.003, 0.005], mid_contrast: 0.06,
  hue: { green: -7.0, yellow_green: -5.0, yellow: -3.0, sky: -5.0, blue: -4.0, cyan: -2.0 }, green_dark: 0.02, blue_dark: 0.02,
};

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// linear -> sRGB 8-bit through a table indexed by sqrt(linear): fine steps where the curve is steep
const ENC_N = 4096, ENC = new Uint8Array(ENC_N + 1);
for (let i = 0; i <= ENC_N; i++) { const l = (i / ENC_N) ** 2; const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; ENC[i] = Math.min(255, Math.max(0, Math.round(c * 255))); }
const enc = (l) => ENC[(Math.sqrt(l < 0 ? 0 : l > 1 ? 1 : l) * ENC_N + 0.5) | 0];

const ss = (x, a, b) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function interp(x, xs, ys) {                      // numpy.interp: linear, clamped at the ends
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1; while (xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}

function percentile(sorted, q) {                  // numpy default (linear interpolation)
  const pos = (q / 100) * (sorted.length - 1), i = Math.floor(pos), f = pos - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

// Find a uniform print border (white/black frame) that ends in a hard edge. Returns [top, bottom, left, right] in pixels.
export function contentBox(rgba, w, h) {
  const line = (horizontal, idx) => {              // mean, max channel std, of one row/column
    const n = horizontal ? w : h; const s = [0, 0, 0], s2 = [0, 0, 0];
    for (let k = 0; k < n; k++) { const o = (horizontal ? idx * w + k : k * w + idx) * 4; for (let c = 0; c < 3; c++) { const v = rgba[o + c]; s[c] += v; s2[c] += v * v; } }
    const mean = s.map((v) => v / n); const sd = Math.max(...s2.map((v, c) => Math.sqrt(Math.max(v / n - mean[c] * mean[c], 0))));
    return { mean, sd };
  };
  const absDev = (horizontal, idx, ref) => {
    const n = horizontal ? w : h; let d = 0;
    for (let k = 0; k < n; k++) { const o = (horizontal ? idx * w + k : k * w + idx) * 4; for (let c = 0; c < 3; c++) d += Math.abs(rgba[o + c] - ref[c]); }
    return d / (n * 3);
  };
  const run = (horizontal, fromEnd) => {
    const total = horizontal ? h : w, lim = Math.floor(total * 0.22); const at = (i) => (fromEnd ? total - 1 - i : i);
    if (lim < 1) return 0;
    const ref = line(horizontal, at(0)).mean; let n = 0;
    for (let i = 0; i < lim; i++) { const l = line(horizontal, at(i)); if (l.sd > 3.0 || Math.max(...l.mean.map((v, c) => Math.abs(v - ref[c]))) > 4.0) break; n++; }
    if (n < 4 || n >= lim) return 0;
    return absDev(horizontal, at(Math.min(n + 2, lim - 1)), ref) > 14 ? n + 2 : 0;
  };
  return [run(true, false), run(true, true), run(false, false), run(false, true)];
}

// Area-averaged copy of the picture area, long edge <= 256, as OKLab planes.
function smallLab(rgba, w, h, box) {
  const [t, b, l, r] = box; const cw = w - l - r, ch = h - t - b; const sc = Math.min(1, 256 / Math.max(cw, ch));
  const sw = Math.max(1, Math.round(cw * sc)), sh = Math.max(1, Math.round(ch * sc)); const n = sw * sh;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let y = 0; y < sh; y++) {
    const y0 = t + Math.floor((y * ch) / sh), y1 = Math.max(y0 + 1, t + Math.floor(((y + 1) * ch) / sh));
    for (let x = 0; x < sw; x++) {
      const x0 = l + Math.floor((x * cw) / sw), x1 = Math.max(x0 + 1, l + Math.floor(((x + 1) * cw) / sw));
      let R = 0, G = 0, Bl = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const o = (yy * w + xx) * 4; R += rgba[o]; G += rgba[o + 1]; Bl += rgba[o + 2]; }
      const k = 1 / ((y1 - y0) * (x1 - x0));          // PIL averages the 8-bit values, so do the same
      const lr = LIN[Math.round(R * k)], lg = LIN[Math.round(G * k)], lb = LIN[Math.round(Bl * k)];
      const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb), m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb), s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      const i = y * sw + x;
      L[i] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_; A[i] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_; B[i] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
    }
  }
  return { L, A, B, n };
}

const median = (arr) => { const s = Float32Array.from(arr).sort(); return percentile(s, 50); };

// Measure the photo: black/white points, how much colour each lightness zone carries, its own colour balance.
export function analyse(rgba, w, h, box = contentBox(rgba, w, h)) {
  const { L, A, B, n } = smallLab(rgba, w, h, box);
  const C = new Float32Array(n); for (let i = 0; i < n; i++) C[i] = Math.hypot(A[i], B[i]);
  const Ls = Float32Array.from(L).sort(), Cs = Float32Array.from(C).sort();
  const sum = new Float64Array(10), cnt = new Int32Array(10); let cAll = 0;
  for (let i = 0; i < n; i++) { const z = Math.min(9, Math.max(0, Math.floor(L[i] * 10))); sum[z] += C[i]; cnt[z]++; cAll += C[i]; }
  const raw = Array.from({ length: 10 }, (_, z) => (cnt[z] > 40 ? Math.max(sum[z] / cnt[z], 0.003) : NaN));
  const valid = raw.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
  const tc = valid.length >= 2 ? raw.map((v, i) => (Number.isNaN(v) ? interp(i, valid, valid.map((j) => raw[j])) : v)) : new Array(10).fill(0);
  // the photo's own neutral axis (same iteration as style.estimate_cast)
  let use = []; for (let i = 0; i < n; i++) if (L[i] > 0.25 && L[i] < 0.95) use.push(i);
  if (use.length < 200) use = Array.from({ length: n }, (_, i) => i);
  let ea = median(use.map((i) => A[i])), eb = median(use.map((i) => B[i]));
  for (const r of [0.07, 0.055, 0.045, 0.045]) {
    let sa = 0, sb = 0, k = 0; for (const i of use) if (Math.hypot(A[i] - ea, B[i] - eb) < r) { sa += A[i]; sb += B[i]; k++; }
    if (k < 200) break; ea = sa / k; eb = sb / k;
  }
  return { box, p_black: percentile(Ls, 0.5), p_white: percentile(Ls, 99.5), tc, tc_measured: raw, cast: [ea, eb], bw: percentile(Cs, 95) < 0.02, chroma: cAll / n, zone_share: Array.from(cnt, (c) => c / n) };
}

// What the look will do to this photo at a given strength (shown in the interface, used by render).
export function plan(an, strength, p = P) {
  const s = strength;
  const lift = s * p.toe_keep * Math.max(p.black_floor - an.p_black, 0);
  const raw = REF_TC.map((r, i) => clamp(r / Math.max(an.tc[i], 0.003), 1.0, p.max_colour_gain));
  const need = raw.map((v, i) => 0.25 * raw[Math.max(i - 1, 0)] + 0.5 * v + 0.25 * raw[Math.min(i + 1, 9)]);
  const keep = clamp(1 - Math.hypot(an.cast[0], an.cast[1]) / 0.035, 0.25, 1.0) * Math.min(s, 1.25) / Math.max(s, 1e-6);
  return { lift, need, keep, over: an.p_white > p.knee, cap: p.white_cap + (1 - s) * (1 - p.white_cap), bw: an.bw };
}

// Apply the look in place. Returns { analysis, plan }.
export function render(rgba, w, h, strength = 1.5, opts = {}) {
  const p = opts.params || P, s = strength;
  const an = opts.analysis || analyse(rgba, w, h); const pl = plan(an, s, p);
  const [bt, bb, bl, br] = an.box; const { lift, need, keep, over, cap } = pl; const knee = p.knee, span = cap - knee;
  // hue tables: 12 soft colour families, interpolated per degree
  const hp = p.hue;
  const dh = [0, 0, 0, hp.yellow, hp.yellow_green, hp.green, hp.green * 0.5, hp.cyan, hp.sky, hp.blue, 0, 0];
  const dl = [0, 0, 0, 0, -p.green_dark * 0.5, -p.green_dark, -p.green_dark * 0.5, 0, -p.blue_dark, -p.blue_dark, 0, 0];
  const DH = new Float32Array(362), DL = new Float32Array(362);
  for (let d = 0; d <= 361; d++) { let a = 0, b = 0; for (let f = 0; f < 12; f++) { const dist = Math.abs(((d - f * 30 + 180) % 360 + 360) % 360 - 180); const wt = Math.max(0, 1 - dist / 30); a += wt * dh[f]; b += wt * dl[f]; } DH[d] = a; DL[d] = b; }
  const NEED = new Float32Array(1025); for (let i = 0; i <= 1024; i++) NEED[i] = interp(i / 1024, LC, need);
  const dens = Math.min(s, 1.7) * p.density, R2D = 180 / Math.PI, D2R = Math.PI / 180;
  for (let y = bt; y < h - bb; y++) {
    for (let x = bl; x < w - br; x++) {
      const o = (y * w + x) * 4; const lr = LIN[rgba[o]], lg = LIN[rgba[o + 1]], lb = LIN[rgba[o + 2]];
      const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb), m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb), s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_; let a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_, b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
      // tone: toe only as far as needed, a little mid contrast, shoulder below white
      let L1 = L + lift * (1 - ss(L, 0, 0.45));
      const u = (L1 - 0.5) / 0.5; L1 += s * p.mid_contrast * (L1 - 0.5) * Math.max(1 - u * u, 0);
      if (over && L1 > knee) L1 = knee + span * Math.tanh(((L1 - knee) / span) * 0.95);
      if (!pl.bw) {
        const C = Math.hypot(a, b); let h_ = Math.atan2(b, a) * R2D; if (h_ < 0) h_ += 360;
        // colour amount: fill this zone's shortfall; weak colours gain most, greys/strong colours/skin least
        let gain = 1 + s * p.shadow_colour * (NEED[(clamp(L1, 0, 1) * 1024) | 0] - 1);
        gain = 1 + (gain - 1) * (1 - ss(C, 0.07, 0.16)) * ss(C, 0.004, 0.02);
        const skin = ss(h_, 12, 32) * (1 - ss(h_, 78, 95));
        gain = 1 + (gain - 1) * (1 - 0.65 * skin); gain = Math.min(gain, 1.0 + 0.7 * (1 - 0.6 * skin));
        let C1 = C * gain * (1 - s * p.hi_desat * ss(L1, 0.8, 0.97));
        L1 -= dens * Math.max(C1 - 0.035, 0) * ss(L1, 0.12, 0.45) * (1 - 0.6 * ss(h_, 35, 60) * (1 - ss(h_, 75, 95)));
        // hue: olive greens, cyan-leaning blues, golden yellows
        const hi = h_ | 0, hf = h_ - hi, gate = ss(C1, 0.02, 0.06);
        const h1 = (h_ + s * gate * (DH[hi] + hf * (DH[hi + 1] - DH[hi]))) * D2R; L1 += s * gate * (DL[hi] + hf * (DL[hi + 1] - DL[hi]));
        // split tone relative to the photo's own balance
        const wHi = ss(L1, 0.55, 0.9), wSh = 1 - ss(L1, 0.15, 0.5), k = s * keep;
        a = C1 * Math.cos(h1) + k * (p.warm_hi[0] * wHi + p.warm_sh[0] * wSh); b = C1 * Math.sin(h1) + k * (p.warm_hi[1] * wHi + p.warm_sh[1] * wSh);
      }
      L1 = clamp(L1, 0, 1);
      const l3 = (L1 + 0.3963377774 * a + 0.2158037573 * b) ** 3, m3 = (L1 - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L1 - 0.0894841775 * a - 1.291485548 * b) ** 3;
      rgba[o] = enc(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3);
      rgba[o + 1] = enc(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3);
      rgba[o + 2] = enc(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3);
    }
  }
  return { analysis: an, plan: pl };
}
