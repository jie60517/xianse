// Look v2 in the browser - a port of analysis/look.py. No DOM: runs in a Worker and in Node.
// The photo is measured first (analyse), then each ingredient of the look is applied only as
// far as that photo needs it. All colour maths is in OKLab.

// Average chroma the reference photos carry in each of 10 lightness zones (models/group_07.json "tc").
export const REF_TC = [0.01615, 0.01613, 0.02587, 0.04061, 0.051, 0.05651, 0.05573, 0.04439, 0.03064, 0.01662];
const LC = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

export const P = {
  ref_tc: REF_TC, min_colour_gain: 1.0, key: 0,
  // white_cap: where pure white ends up at strength 1. Kept within about 1% of white for every style: anything
  // lower (0.925 at first, then 0.94-0.97) read as grey on snow, white walls and paper.
  white_cap: 0.992, knee: 0.80, black_floor: 0.085, toe_keep: 0.55, density: 0.14, shadow_colour: 0.6, max_colour_gain: 1.4,
  hi_gain_limit: 1.12, skin_gain_limit: 1.12,
  // tints are [a, b] in OKLab (a: green- / red+, b: blue- / yellow+) for shadows, mid-tones and highlights
  hi_desat: 0.30, warm_hi: [0.002, 0.008], warm_mid: [0.003, 0.009], warm_sh: [0.002, 0.006], mid_contrast: 0.06,
  // hue: degrees each colour family is turned. sat: how much more (+) or less (-) of each family the style keeps,
  // at the standard strength. Families sit 30 degrees apart: pink, red, orange, yellow, yellow_green, green, teal,
  // cyan, sky, blue, violet, purple. Red and orange are never turned: that is where skin lives.
  hue: { green: -7.0, yellow_green: -5.0, yellow: -3.0, sky: -5.0, blue: -4.0, cyan: -2.0 }, sat: {}, green_dark: 0.02, blue_dark: 0.02,
};
const FAMILIES = ["pink", "red", "orange", "yellow", "yellow_green", "green", "teal", "cyan", "sky", "blue", "violet", "purple"];

// Seven styles. Each is the same engine with targets taken from one group of reference photos (models/group_0X.json):
// how much colour the group carries per lightness zone (ref_tc), where its whites and blacks sit, its overall key,
// the tint its shadows / mid-tones / highlights lean to (the group's "ta"/"tb"), and which colour families it turns
// or keeps more or less of (the group's "fam"). "classic" is the broad house look (group 7).
export const STYLES = [
  { id: "classic", name: "相紙", note: "最接近參考照片的整體樣貌", params: {} },
  // group 5: the least colour of all, mid-tones leaning slightly green rather than warm
  { id: "calm", name: "薄霧", note: "顏色收斂，中間調帶一點青綠", params: {
      ref_tc: [0.0163, 0.0154, 0.024, 0.0358, 0.0417, 0.0441, 0.0405, 0.0352, 0.0285, 0.0167], min_colour_gain: 0.76, white_cap: 0.992,
      warm_sh: [0.000, -0.005], warm_mid: [-0.011, 0.001], warm_hi: [-0.004, 0.003], hi_desat: 0.36, density: 0.11,
      hue: { green: -9, yellow_green: -5, yellow: -2, cyan: -6, sky: -6, blue: -7 }, sat: { pink: -0.22, red: -0.18, orange: -0.16, yellow: -0.14, yellow_green: -0.10, green: -0.08, teal: -0.06, cyan: -0.06, sky: -0.08, blue: -0.10, violet: -0.18, purple: -0.22 } } },
  // group 6: bright, yellow-warm shadows under clean highlights
  { id: "daylight", name: "正午", note: "整體提亮，暗部帶暖黃、亮部乾淨", params: {
      ref_tc: [0.0159, 0.0235, 0.0353, 0.0474, 0.0561, 0.0639, 0.058, 0.051, 0.0393, 0.0179], key: 0.28, white_cap: 0.992, black_floor: 0.10,
      warm_sh: [0.006, 0.020], warm_mid: [0.001, 0.014], warm_hi: [-0.003, 0.004],
      hue: { green: -6, yellow_green: -5, yellow: -3, sky: -7, blue: -6, cyan: -2 }, sat: { yellow: 0.14, yellow_green: 0.12, green: 0.08, sky: 0.18, cyan: 0.10, blue: 0.06 } } },
  // group 2: golden highlights over neutral shadows, greens pulled to olive, blues held back
  { id: "amber", name: "琥珀", note: "亮部金黃、綠色偏橄欖、藍色收斂", params: {
      ref_tc: [0.0147, 0.0193, 0.0257, 0.0532, 0.0726, 0.0821, 0.0783, 0.0802, 0.0621, 0.0285], key: -0.2, white_cap: 0.992, max_colour_gain: 1.55,
      warm_sh: [-0.004, -0.002], warm_mid: [0.010, 0.015], warm_hi: [0.005, 0.020], hi_desat: 0.1, density: 0.17,
      hue: { yellow: -7, yellow_green: -9, green: -13, teal: -12, cyan: -12, sky: -4, blue: -2 },
      sat: { red: 0.10, orange: 0.20, yellow: 0.22, yellow_green: 0.06, cyan: -0.14, sky: -0.22, blue: -0.25, violet: -0.18 } } },
  // group 4: dark, red-brown shadows, warm highlights, greens muted
  { id: "warmlight", name: "燭火", note: "畫面壓暗，暗部偏紅褐、亮部暖", params: {
      ref_tc: [0.0196, 0.023, 0.0342, 0.0458, 0.0622, 0.0684, 0.0623, 0.0696, 0.0619, 0.0383], key: -0.32, white_cap: 0.992,
      warm_sh: [0.016, 0.010], warm_mid: [0.010, 0.013], warm_hi: [0.003, 0.014], hi_desat: 0.08, density: 0.16,
      hue: { yellow: -4, yellow_green: -5, green: -8, teal: -10, cyan: -14, sky: -5, blue: -3 },
      sat: { pink: 0.08, red: 0.18, orange: 0.12, yellow_green: -0.18, green: -0.26, teal: -0.24, cyan: -0.16, sky: -0.10, blue: -0.10 } } },
  // group 1: the darkest, whites held lowest, cool colours drained
  { id: "lowkey", name: "深夜", note: "整體最暗，冷色褪去、暗部偏藍", params: {
      ref_tc: [0.0102, 0.0162, 0.0327, 0.0477, 0.0584, 0.0671, 0.0671, 0.0492, 0.0298, 0.0184], key: -0.45, white_cap: 0.992, black_floor: 0.06,
      warm_sh: [-0.002, -0.006], warm_mid: [0.004, 0.010], warm_hi: [0.004, 0.012], density: 0.17,
      hue: { green: -9, yellow_green: -6, yellow: -3, sky: -4, blue: -2, cyan: -3 },
      sat: { yellow_green: -0.12, green: -0.28, teal: -0.30, cyan: -0.30, sky: -0.30, blue: -0.30, violet: -0.24, purple: -0.14, pink: -0.08 } } },
  // group 3: the most colour, blacks lifted, shadows leaning teal
  { id: "vivid", name: "花期", note: "顏色最濃、黑位抬高、暗部帶青", params: {
      ref_tc: [0.0138, 0.0319, 0.0466, 0.0699, 0.0886, 0.1006, 0.0881, 0.0708, 0.0533, 0.0369], max_colour_gain: 1.65, black_floor: 0.16, toe_keep: 0.7,
      white_cap: 0.992, mid_contrast: 0.0, density: 0.10, warm_sh: [-0.008, -0.003], warm_mid: [0.006, 0.006], warm_hi: [0.002, 0.010],
      hue: { green: -4, yellow_green: -3, yellow: -2, sky: -4, blue: -4, cyan: -3 },
      sat: { pink: 0.25, red: 0.22, orange: 0.18, yellow: 0.30, yellow_green: 0.30, green: 0.30, teal: 0.30, cyan: 0.34, sky: 0.30, blue: 0.20, violet: 0.20, purple: 0.25 } } },
];
export const paramsFor = (id) => ({ ...P, ...(STYLES.find((s) => s.id === id) || STYLES[0]).params });

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

export const STANDARD_STRENGTH = 1.5;                 // the amount the look was tuned at; the interface shows it as 100

// What the look will do to this photo at a given strength (shown in the interface, used by render).
export function plan(an, strength, p = P) {
  const s = strength;
  // a photo that is mostly dark (night, a dim cabin) gets less of the lift: raising that much black reads as haze
  const dark = (an.zone_share?.[0] || 0) + (an.zone_share?.[1] || 0);
  const lift = Math.min(s, STANDARD_STRENGTH) * p.toe_keep * Math.max(p.black_floor - an.p_black, 0) * (1 - 0.6 * clamp((dark - 0.35) / 0.35, 0, 1));   // stops growing at the standard strength
  // highlights (zones 8-9) may only gain a little colour: a faint cast in snow or a white wall is not "missing colour"
  const raw = p.ref_tc.map((r, i) => clamp(r / Math.max(an.tc[i], 0.003), p.min_colour_gain, i >= 8 ? Math.min(p.max_colour_gain, p.hi_gain_limit) : p.max_colour_gain));
  const need = raw.map((v, i) => 0.25 * raw[Math.max(i - 1, 0)] + 0.5 * v + 0.25 * raw[Math.min(i + 1, 9)]);
  // a photo that is mostly bright (snow, white rooms) keeps its whites closer to white, and takes half the tint:
  // a tinted highlight is a mood on a small window, but a colour cast on a field of snow
  const bright = (an.zone_share?.[8] || 0) + (an.zone_share?.[9] || 0), mostlyBright = clamp((bright - 0.15) / 0.3, 0, 1);
  const keep = clamp(1 - Math.hypot(an.cast[0], an.cast[1]) / 0.035, 0.25, 1.0) * Math.min(s, 1.25) / Math.max(s, 1e-6);
  // pull: how far pure white is brought down. Never more than 0.08, whatever the style or strength.
  const pull = Math.min(Math.min(s, 1.6) * (1 - p.white_cap) * (1 - 0.6 * mostlyBright), 0.08);
  // The shoulder is L - pull * t^2 over [knee, 1]; its slope at white is 1 - 2 * pull / (1 - knee). Starting the
  // shoulder early enough (span >= 4 * pull) keeps that slope >= 0.5, so tones can never fold back on themselves.
  const knee = 1 - Math.max(1 - p.knee, 4 * pull);
  // over: the shoulder is active. pulls: the photo's white point really ends up lower (what the interface reports).
  return { lift, need, keep, tintShare: 1 - 0.5 * mostlyBright, over: an.p_white > knee, pulls: an.p_white > knee && an.p_white > 1 - pull, cap: 1 - pull, knee, bw: an.bw };
}

// Apply the look in place. Returns { analysis, plan }.
// opts.offsetY / opts.fullH: rgba holds only rows offsetY .. offsetY+h of an image fullH rows tall
// (used to split a large export across several workers); opts.analysis must then be given.
export function render(rgba, w, h, strength = STANDARD_STRENGTH, opts = {}) {
  const p = opts.params || paramsFor(opts.style), s = strength;
  const an = opts.analysis || analyse(rgba, w, h); const pl = plan(an, s, p);
  const [bt, bb, bl, br] = an.box; const { lift, need, keep, over, cap, knee } = pl; const drop = 1 - cap, kspan = 1 - knee;
  const sCap = Math.min(s, 2);                          // contrast, hue turns and per-family amounts stop growing here; the colour fill goes on to 3
  const contrast = sCap * p.mid_contrast * clamp(lift / 0.04, 0, 1);      // only to win back contrast lost to a lifted toe
  // hue tables: 12 soft colour families, interpolated per degree
  const hp = p.hue;
  const dh = FAMILIES.map((f) => (f === "red" || f === "orange" ? 0 : f === "teal" ? hp.teal ?? (hp.green || 0) * 0.5 : hp[f] || 0));
  const dc = FAMILIES.map((f) => (p.sat[f] || 0) / STANDARD_STRENGTH);
  const dl = [0, 0, 0, 0, -p.green_dark * 0.5, -p.green_dark, -p.green_dark * 0.5, 0, -p.blue_dark, -p.blue_dark, 0, 0];
  const DH = new Float32Array(362), DL = new Float32Array(362), DC = new Float32Array(362);
  for (let d = 0; d <= 361; d++) { let a = 0, b = 0, c = 0; for (let f = 0; f < 12; f++) { const dist = Math.abs(((d - f * 30 + 180) % 360 + 360) % 360 - 180); const wt = Math.max(0, 1 - dist / 30); a += wt * dh[f]; b += wt * dl[f]; c += wt * dc[f]; } DH[d] = a; DL[d] = b; DC[d] = c; }
  const NEED = new Float32Array(1025); for (let i = 0; i <= 1024; i++) NEED[i] = interp(i / 1024, LC, need);
  const keyAmt = p.key * 0.12 * Math.min(s, 1.6);
  const dens = Math.min(s, 1.7) * p.density, R2D = 180 / Math.PI, D2R = Math.PI / 180;
  const offY = opts.offsetY || 0, fullH = opts.fullH || h;
  for (let y = Math.max(0, bt - offY); y < Math.min(h, fullH - bb - offY); y++) {
    for (let x = bl; x < w - br; x++) {
      const o = (y * w + x) * 4; const lr = LIN[rgba[o]], lg = LIN[rgba[o + 1]], lb = LIN[rgba[o + 2]];
      const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb), m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb), s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_; let a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_, b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
      // tone: toe only as far as needed, a little mid contrast, shoulder below white
      let L1 = L + lift * (1 - ss(L, 0, 0.45));
      if (contrast > 0) { const u = (L1 - 0.5) / 0.5; L1 += contrast * (L1 - 0.5) * Math.max(1 - u * u, 0); }
      if (keyAmt !== 0) L1 += keyAmt * Math.sin(Math.PI * clamp(L1, 0, 1)) * (keyAmt < 0 ? 1 - ss(L1, 0.7, 0.95) : 1);   // style key: moves the mid-tones, leaves both ends in place; a darker key leaves the highlights alone, or whites turn grey
      // shoulder: eases the top down by `drop`, quadratically; plan() sizes the span so the slope stays >= 0.5
      if (over && L1 > knee) { const t = Math.min((L1 - knee) / kspan, 1); L1 -= drop * t * t; }
      if (!pl.bw) {
        const C = Math.hypot(a, b); let h_ = Math.atan2(b, a) * R2D; if (h_ < 0) h_ += 360;
        // colour amount: fill this zone's shortfall; weak colours gain most, greys/strong colours/skin least
        let gain = 1 + s * p.shadow_colour * (NEED[(clamp(L1, 0, 1) * 1024) | 0] - 1);
        const skin = ss(h_, 12, 32) * (1 - ss(h_, 78, 95));
        if (gain >= 1) {
          // near-neutral pixels are left alone (boosting them turns a faint cast into a visible one)
          gain = 1 + (gain - 1) * (1 - ss(C, 0.07, 0.16)) * ss(C, 0.015, 0.05);
          gain = 1 + (gain - 1) * (1 - 0.8 * skin); gain = Math.min(gain, 1.0 + 0.7 * (1 - skin) + (p.skin_gain_limit - 1) * skin);
        } else {
          gain = Math.max(1 + (gain - 1) * (1 - 0.5 * skin), 0.2);                               // a quieter style takes colour off everything, skin a little less
        }
        let C1 = C * gain * (1 - Math.min(s * p.hi_desat, 0.75) * ss(L1, 0.8, 0.97));
        L1 -= dens * Math.max(C1 - 0.035, 0) * ss(L1, 0.25, 0.55) * (1 - 0.6 * ss(h_, 35, 60) * (1 - ss(h_, 75, 95)));
        // per colour family: how much of it the style keeps, and where it is turned to. Skin is mostly spared.
        const hi = h_ | 0, hf = h_ - hi;
        const more = DC[hi] + hf * (DC[hi + 1] - DC[hi]);
        C1 *= 1 + sCap * more * (1 - 0.9 * skin) * ss(C, 0.015, 0.05) * (more > 0 ? (1 - ss(C1, 0.07, 0.16)) * (1 - ss(C1 / Math.max(L1, 0.05), 0.25, 0.45)) : 1);   // and none to colours already near the screen's limit for their brightness
        const gate = ss(C1, 0.02, 0.06);
        const h1 = (h_ + sCap * gate * (1 - 0.7 * skin) * (DH[hi] + hf * (DH[hi + 1] - DH[hi]))) * D2R; L1 += sCap * gate * ss(L1, 0.15, 0.4) * (DL[hi] + hf * (DL[hi + 1] - DL[hi]));   // deepening greens and blues is for mid-tones up, not for shadows
        // split tone relative to the photo's own balance
        const wHi = ss(L1, 0.55, 0.85) * (1 - 0.85 * ss(L1, 0.88, 0.98)) * (1 - ss(L, 0.9, 0.99)), wSh = 1 - ss(L1, 0.15, 0.5), wMid = ss(L1, 0.2, 0.45) * (1 - ss(L1, 0.6, 0.85)), k = s * keep * pl.tintShare * (1 - 0.85 * skin * ss(C, 0.02, 0.05));   // the cream tint fades out before white, and mostly spares skin
        a = C1 * Math.cos(h1) + k * (p.warm_hi[0] * wHi + p.warm_mid[0] * wMid + p.warm_sh[0] * wSh); b = C1 * Math.sin(h1) + k * (p.warm_hi[1] * wHi + p.warm_mid[1] * wMid + p.warm_sh[1] * wSh);
      }
      // deep shadows (L < 0.18) are never pushed darker than they were, and the guard eases off by L 0.38:
      // detail down there is what keeps a photo from feeling heavy
      if (L1 < L && L < 0.38) L1 += (L - L1) * (1 - ss(L, 0.18, 0.38));
      L1 = clamp(L1, 0, 1);
      const l3 = (L1 + 0.3963377774 * a + 0.2158037573 * b) ** 3, m3 = (L1 - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L1 - 0.0894841775 * a - 1.291485548 * b) ** 3;
      rgba[o] = enc(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3);
      rgba[o + 1] = enc(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3);
      rgba[o + 2] = enc(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3);
    }
  }
  return { analysis: an, plan: pl };
}
