// All pixel work happens here so the page stays responsive. Photos never leave this machine.
import { analyse, render } from "./look.js";

let fx = null;                                   // film effects are optional: the page still works if the module is missing
try { fx = await import("./effects.js"); } catch (e) { fx = null; }

const PREVIEW_EDGE = 1400;
let full = null, prev = null;                    // { data: Uint8ClampedArray, w, h, analysis }

function pixelsOf(bitmap, w, h) {
  const c = new OffscreenCanvas(w, h); const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(bitmap, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

function fxParams(sliders, bw) {
  if (!fx || !sliders) return null;
  const p = {}; let any = false;
  for (const k of Object.keys(sliders)) if (k in fx.DEFAULTS) { p[k] = sliders[k]; if (sliders[k] > 0) any = true; }
  if (bw && "halation" in p) p.halation = 0;       // the red glow has no place on a black-and-white photo
  return any ? p : null;
}

function process(src, job, onProgress) {
  const out = new Uint8ClampedArray(src.data);
  const res = render(out, src.w, src.h, job.strength, { analysis: src.analysis });
  onProgress?.(0.6);
  const p = fxParams(job.fx, res.plan.bw);
  if (p) fx.applyEffects(out, src.w, src.h, p, job.seed | 0, (t) => onProgress?.(0.6 + 0.4 * t));
  return { out, res };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") {
      const bmp = await createImageBitmap(m.file, { imageOrientation: "from-image" });
      const w = bmp.width, h = bmp.height; const sc = Math.min(1, PREVIEW_EDGE / Math.max(w, h));
      const pw = Math.max(1, Math.round(w * sc)), ph = Math.max(1, Math.round(h * sc));
      const fd = pixelsOf(bmp, w, h), pd = sc === 1 ? new Uint8ClampedArray(fd) : pixelsOf(bmp, pw, ph); bmp.close();
      full = { data: fd, w, h, analysis: analyse(fd, w, h) }; prev = { data: pd, w: pw, h: ph, analysis: analyse(pd, pw, ph) };
      const copy = new Uint8ClampedArray(pd);
      self.postMessage({ type: "loaded", w, h, pw, ph, original: copy.buffer, analysis: full.analysis, effects: fx ? fx.DEFAULTS : null }, [copy.buffer]);
    } else if (m.type === "preview" && prev) {
      const { out, res } = process(prev, m);
      self.postMessage({ type: "preview", id: m.id, pw: prev.w, ph: prev.h, pixels: out.buffer, plan: res.plan }, [out.buffer]);
    } else if (m.type === "export" && full) {
      const { out } = process(full, m, (t) => self.postMessage({ type: "progress", t }));
      const c = new OffscreenCanvas(full.w, full.h); c.getContext("2d").putImageData(new ImageData(out, full.w, full.h), 0, 0);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      self.postMessage({ type: "exported", blob });
    }
  } catch (e) {
    self.postMessage({ type: "error", stage: m.type, message: String(e && e.message ? e.message : e) });
  }
};
