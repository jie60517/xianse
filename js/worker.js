// All pixel work happens here so the page stays responsive. Photos never leave this device.
import { analyse, render, STYLES } from "./look.js";

let fx = null;                                   // film effects are optional: the page still works if the module is missing
try { fx = await import("./effects.js"); } catch (e) { fx = null; }

// Three working sizes: a small draft that keeps up with a dragged slider, the preview shown at rest,
// and tiny frames for the style strip. The full-size pixels are only touched on download.
const PREVIEW_EDGE = 1400, DRAFT_EDGE = 640, THUMB_EDGE = 220;
let full = null, prev = null, draft = null, thumb = null;      // { data, w, h, analysis, colour: { key, data } }

function pixelsOf(bitmap, w, h) {
  const c = new OffscreenCanvas(w, h); const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(bitmap, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}
const fit = (w, h, edge) => { const sc = Math.min(1, edge / Math.max(w, h)); return [Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc))]; };
const source = (data, w, h) => ({ data, w, h, analysis: analyse(data, w, h), colour: null });

function fxParams(sliders, bw) {
  if (!fx || !sliders) return null;
  const p = {}; let any = false;
  for (const k of Object.keys(sliders)) if (k in fx.DEFAULTS) { p[k] = sliders[k]; if (sliders[k] > 0) any = true; }
  if (bw && "halation" in p) p.halation = 0;       // the red glow has no place on a black-and-white photo
  return any ? p : null;
}

// Colour first, then film effects. The colour result is remembered per size, so moving an
// effect slider (grain, glow ...) does not recompute the colour.
function process(src, job) {
  const key = job.strength + "|" + job.style;
  if (!src.colour || src.colour.key !== key) {
    const px = new Uint8ClampedArray(src.data);
    const res = render(px, src.w, src.h, job.strength, { analysis: src.analysis, style: job.style });
    src.colour = { key, data: px, plan: res.plan };
  }
  const out = new Uint8ClampedArray(src.colour.data);
  const p = fxParams(job.fx, src.colour.plan.bw);
  if (p) fx.applyEffects(out, src.w, src.h, p, job.seed | 0);
  return { out, plan: src.colour.plan };
}

// Large photos: split the colour pass into strips and run them on several cores.
async function colourParallel(src, job, onProgress) {
  const n = Math.max(1, Math.min(8, (self.navigator?.hardwareConcurrency || 2) - 1));
  if (n < 2 || src.w * src.h < 3e6 || typeof Worker === "undefined") {
    const px = new Uint8ClampedArray(src.data); render(px, src.w, src.h, job.strength, { analysis: src.analysis, style: job.style }); return px;
  }
  const out = new Uint8ClampedArray(src.data.length), rows = Math.ceil(src.h / n); let done = 0;
  const workers = [];
  try {
    await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
      const y0 = i * rows, y1 = Math.min(src.h, y0 + rows); if (y0 >= y1) { resolve(); return; }
      const strip = src.data.slice(y0 * src.w * 4, y1 * src.w * 4);
      const w = new Worker(new URL("./colour-worker.js", import.meta.url), { type: "module" }); workers.push(w);
      w.onmessage = (ev) => {
        if (ev.data.error) { reject(new Error(ev.data.error)); return; }
        out.set(new Uint8ClampedArray(ev.data.pixels), y0 * src.w * 4); onProgress?.(++done / n); resolve();
      };
      w.onerror = (e) => reject(new Error(e.message || "colour worker failed"));
      w.postMessage({ index: i, pixels: strip.buffer, w: src.w, h: y1 - y0, strength: job.strength, style: job.style, analysis: src.analysis, offsetY: y0, fullH: src.h }, [strip.buffer]);
    })));
    return out;
  } catch (e) {                                    // any trouble with the helpers: fall back to one core
    const px = new Uint8ClampedArray(src.data); render(px, src.w, src.h, job.strength, { analysis: src.analysis, style: job.style }); return px;
  } finally { for (const w of workers) w.terminate(); }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") {
      const tm = {}, t0 = performance.now(); let tl = t0; const lap = (k) => { const n = performance.now(); tm[k] = Math.round(n - tl); tl = n; };
      const bmp = await createImageBitmap(m.file, { imageOrientation: "from-image" }); lap("decode");
      const w = bmp.width, h = bmp.height; const [pw, ph] = fit(w, h, PREVIEW_EDGE), [dw, dh] = fit(w, h, DRAFT_EDGE), [tw, th] = fit(w, h, THUMB_EDGE);
      const fd = pixelsOf(bmp, w, h), pd = pw === w ? new Uint8ClampedArray(fd) : pixelsOf(bmp, pw, ph), dd = pixelsOf(bmp, dw, dh), td = pixelsOf(bmp, tw, th); bmp.close(); lap("pixels");
      full = source(fd, w, h); prev = source(pd, pw, ph); draft = source(dd, dw, dh); thumb = source(td, tw, th); lap("analyse"); tm.total = Math.round(performance.now() - t0);
      const copy = new Uint8ClampedArray(pd);
      self.postMessage({ type: "loaded", w, h, pw, ph, original: copy.buffer, analysis: full.analysis, effects: fx ? fx.DEFAULTS : null, timing: tm }, [copy.buffer]);
    } else if (m.type === "preview" && prev) {
      const t0 = performance.now(), src = m.draft ? draft : prev; const { out, plan } = process(src, m);
      self.postMessage({ type: "preview", id: m.id, draft: !!m.draft, pw: src.w, ph: src.h, pixels: out.buffer, plan, ms: Math.round(performance.now() - t0) }, [out.buffer]);
    } else if (m.type === "thumbs" && thumb) {      // the same frame in every style, colour only
      const t0 = performance.now(); const frames = STYLES.map((st) => { const px = new Uint8ClampedArray(thumb.data); render(px, thumb.w, thumb.h, m.strength, { analysis: thumb.analysis, style: st.id }); return { id: st.id, pixels: px.buffer }; });
      self.postMessage({ type: "thumbs", w: thumb.w, h: thumb.h, frames, ms: Math.round(performance.now() - t0) }, frames.map((f) => f.pixels));
    } else if (m.type === "export" && full) {
      const t0 = performance.now();
      const out = await colourParallel(full, m, (t) => self.postMessage({ type: "progress", t: 0.55 * t }));
      const tColour = performance.now();
      const p = fxParams(m.fx, full.analysis.bw);
      if (p) fx.applyEffects(out, full.w, full.h, p, m.seed | 0, (t) => self.postMessage({ type: "progress", t: 0.55 + 0.4 * t }));
      const tFx = performance.now();
      const c = new OffscreenCanvas(full.w, full.h); c.getContext("2d").putImageData(new ImageData(out, full.w, full.h), 0, 0);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      self.postMessage({ type: "exported", blob, timing: { colour: Math.round(tColour - t0), effects: Math.round(tFx - tColour), encode: Math.round(performance.now() - tFx) } });
    }
  } catch (e) {
    self.postMessage({ type: "error", stage: m.type, message: String(e && e.message ? e.message : e) });
  }
};
