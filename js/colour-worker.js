// Helper for large exports: applies the colour look to one horizontal strip of the photo.
import { render } from "./look.js";

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    const px = new Uint8ClampedArray(m.pixels);
    render(px, m.w, m.h, m.strength, { analysis: m.analysis, style: m.style, offsetY: m.offsetY, fullH: m.fullH });
    self.postMessage({ index: m.index, pixels: px.buffer }, [px.buffer]);
  } catch (e) {
    self.postMessage({ index: m.index, error: String(e && e.message ? e.message : e) });
  }
};
