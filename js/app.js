import { STYLES, paramsFor, STANDARD_STRENGTH } from "./look.js";

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

const FX_LABELS = { grain: "顆粒", diffusion: "柔焦", halation: "高光紅暈", texture: "紋理", dust: "灰塵與刮痕", vignette: "暗角" };
const state = { name: "", loaded: false, style: "classic", seed: 1, busy: false, pending: false, nextId: 0, fxDefaults: null, pos: 50, analysis: null, plan: null };
const after = $("after"), before = $("before"), viewer = $("viewer"), easel = $("easel");
const BORDER = 22;                                                           // white print border around the photo, px
// The slider runs 0-200 with 100 as the standard amount; the engine has its own scale.
const STRENGTH_UNIT = STANDARD_STRENGTH / 100;
const strength = () => +$("strength").value * STRENGTH_UNIT;
// Film-texture defaults that differ from the effects module's own: no soft-focus blur unless asked for.
const FX_START = { diffusion: 0 };

// ---------- loading ----------
function load(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { say("這個檔案不是 JPEG、PNG 或 WebP，請換一個檔案。"); return; }
  state.name = file.name; state.loaded = false; $("download").disabled = true;
  say("讀取中"); worker.postMessage({ type: "load", file });
}
$("file").addEventListener("change", (e) => load(e.target.files[0]));
for (const ev of ["dragenter", "dragover"]) $("wall").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); });
for (const ev of ["dragleave", "drop"]) $("wall").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); });
$("wall").addEventListener("drop", (e) => load(e.dataTransfer.files[0]));
$("another").addEventListener("click", () => $("file").click());

// ---------- wall colour behind the print ----------
for (const b of document.querySelectorAll(".walls button")) b.addEventListener("click", () => {
  document.body.dataset.wall = b.dataset.wall;
  for (const o of document.querySelectorAll(".walls button")) o.setAttribute("aria-checked", String(o === b));
});

// ---------- settings ----------
function settings() {
  const fx = {};
  if (state.fxDefaults) for (const k of Object.keys(FX_LABELS)) { const el = $("fx_" + k); if (el) fx[k] = $("fxOn").checked ? +el.value : 0; }
  return { strength: strength(), style: state.style, fx: state.fxDefaults ? fx : null, seed: state.seed };
}
// draft = true while a slider is being dragged: a small, fast render that keeps up with the hand.
// The full-size preview follows when the slider is released.
function requestPreview(draft = false) {
  if (!state.loaded) return;
  if (state.busy) { state.pending = state.pending === "full" || !draft ? "full" : "draft"; return; }   // keep only the newest request
  state.busy = true; if (!draft) $("print").dataset.busy = "";
  worker.postMessage({ type: "preview", id: ++state.nextId, draft, ...settings() });
}
const requestThumbs = () => state.loaded && worker.postMessage({ type: "thumbs", strength: strength() });
$("strength").addEventListener("input", (e) => { $("strengthOut").textContent = String(Math.round(+e.target.value)); requestPreview(true); });
$("strength").addEventListener("change", () => { requestPreview(); requestThumbs(); });
$("fxOn").addEventListener("change", () => { $("fxGroup").classList.toggle("fx-off", !$("fxOn").checked); requestPreview(); });
$("reseed").addEventListener("click", () => { state.seed = (state.seed * 7919 + 13) % 100000; requestPreview(); });

function buildFxSliders(defaults) {
  state.fxDefaults = defaults; const box = $("fxSliders"); box.textContent = "";
  $("fxMissing").hidden = !!defaults; $("reseed").hidden = !defaults; $("fxOn").disabled = !defaults;
  if (!defaults) return;
  for (const [k, label] of Object.entries(FX_LABELS)) {
    if (!(k in defaults)) continue;
    const row = document.createElement("div"); row.className = "fx-row";
    row.innerHTML = `<div class="row"><label for="fx_${k}">${label}</label><output id="fxo_${k}"></output></div><input type="range" id="fx_${k}" min="0" max="1" step="0.05">`;
    box.append(row); const el = row.querySelector("input"), out = row.querySelector("output");
    el.value = k in FX_START ? FX_START[k] : defaults[k]; out.textContent = (+el.value).toFixed(2); trackFill(el);
    el.addEventListener("input", () => { out.textContent = (+el.value).toFixed(2); requestPreview(true); });
    el.addEventListener("change", () => requestPreview());
  }
}

// ---------- contact strip: one small frame per style ----------
function buildSheet() {
  const sheet = $("sheet"); sheet.textContent = "";
  for (const st of STYLES) {
    const b = document.createElement("button"); b.type = "button"; b.className = "frame"; b.dataset.style = st.id; b.title = st.note;
    b.setAttribute("aria-pressed", String(st.id === state.style));
    b.innerHTML = `<canvas></canvas><span>${st.name}</span>`;
    b.addEventListener("click", () => { state.style = st.id; for (const o of sheet.children) o.setAttribute("aria-pressed", String(o === b)); requestPreview(); });
    b.addEventListener("keydown", (e) => {                   // arrow keys walk along the row
      const next = e.key === "ArrowRight" ? b.nextElementSibling : e.key === "ArrowLeft" ? b.previousElementSibling : null;
      if (next) { e.preventDefault(); next.focus(); next.click(); }
    });
    sheet.append(b);
  }
  sheet.hidden = false;
}

// ---------- compare slider ----------
function setSplit(pct) {
  state.pos = Math.max(0, Math.min(100, pct));
  before.style.clipPath = `inset(0 ${100 - state.pos}% 0 0)`;
  const w = after.getBoundingClientRect().width; $("split").style.left = BORDER + (w * state.pos) / 100 + "px"; $("split").setAttribute("aria-valuenow", Math.round(state.pos));
}
let dragging = false;
const fromPointer = (e) => { const r = after.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100); };
viewer.addEventListener("pointerdown", (e) => { dragging = true; viewer.setPointerCapture(e.pointerId); fromPointer(e); });
viewer.addEventListener("pointermove", (e) => { if (dragging) fromPointer(e); });
viewer.addEventListener("pointerup", () => { dragging = false; });
$("split").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") setSplit(state.pos - 2); if (e.key === "ArrowRight") setSplit(state.pos + 2); });

function fit() {                                            // show the whole print inside the easel
  if (!state.loaded) return;
  $("print").style.visibility = "hidden"; for (const c of [after, before]) c.style.width = c.style.height = "1px";
  const r = easel.getBoundingClientRect(); const availW = r.width - 2 * BORDER - 8, availH = r.height - 2 * BORDER - 124;
  const sc = Math.max(0.05, Math.min(availW / after.width, availH / after.height, 1));
  for (const c of [after, before]) { c.style.width = Math.round(after.width * sc) + "px"; c.style.height = Math.round(after.height * sc) + "px"; }
  $("print").style.visibility = ""; setSplit(state.pos);
}
addEventListener("resize", fit);

// ---------- readouts ----------
const pct = (v) => Math.round(v * 100);
function showReadout() {
  const an = state.analysis, plan = state.plan; if (!an || !plan) return;
  const rows = [];
  rows.push(["最暗點", `<b>${pct(an.p_black)}%</b>　${plan.lift > 0.002 ? `稍微鬆開 <b>+${(plan.lift * 100).toFixed(1)}</b>` : "夠了，不動"}`]);
  rows.push(["最亮點", `<b>${pct(an.p_white)}%</b>　${plan.pulls ? `收斂到 <b>${pct(plan.cap)}%</b> 以下` : plan.over ? "亮部只稍微收一點" : "沒有過亮，不動"}`]);
  if (plan.bw) rows.push(["顏色", "黑白照片，只調明暗"]);
  else {
    const up = plan.need.filter((g) => g > 1.03).length, down = plan.need.filter((g) => g < 0.97).length;
    rows.push(["色彩量", up ? `<b>${up}</b> 個亮度帶不足，已補上` : down ? `<b>${down}</b> 個亮度帶收斂` : "各亮度帶都足夠，不動"]);
    rows.push(["冷暖", plan.keep < 0.6 ? "照片本身色調明顯，保留原樣" : "接近中性，依風格加上色調"]);
  }
  const [t, b, l, r] = an.box; if (t + b + l + r > 0) rows.push(["邊框", "偵測到相框，邊框保持原樣"]);
  $("facts").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const zones = $("zones"), ref = paramsFor(state.style).ref_tc, top = 0.105; zones.textContent = "";
  for (let z = 0; z < 10; z++) {
    const have = an.tc_measured[z], empty = have === null || Number.isNaN(have), g = Math.round(28 + z * 22), gain = plan.need[z];
    const moved = !empty && !plan.bw && Math.abs(gain - 1) > 0.03;
    const cell = document.createElement("div"); cell.className = "zone";
    cell.innerHTML = `<div class="zone-bar" style="background:rgb(${g},${g},${g})" title="亮度 ${z * 10}–${z * 10 + 10}%">` +
      (empty ? "" : `<div class="zone-have" style="height:${Math.min(100, (have / top) * 100)}%"></div>`) +
      `<div class="zone-ref" style="bottom:${Math.min(98, (ref[z] / top) * 100)}%"></div></div>` +
      `<div class="zone-gain ${moved ? "on" : ""}">${empty ? "" : moved ? gain.toFixed(1) : ""}</div>`;
    zones.append(cell);
  }
  $("readout").hidden = false;
  // museum label under the print: style, then file, then what was measured and done
  const st = STYLES.find((s) => s.id === state.style);
  $("labelTitle").innerHTML = `${st.name}<span>${st.note}</span>`;
  $("labelFile").textContent = `${state.name}，${state.size}`;
  const bits = [`最暗點 ${pct(an.p_black)}%`, plan.pulls ? `最亮點 ${pct(an.p_white)}%，收斂到 ${pct(plan.cap)}% 以下` : `最亮點 ${pct(an.p_white)}%`];
  if (plan.bw) bits.push("黑白照片，只調明暗"); else { const up = plan.need.filter((g) => g > 1.03).length; if (up) bits.push(`${up} 個亮度帶補上顏色`); }
  $("labelFacts").textContent = bits.join("；") + "。";
}
for (const el of document.querySelectorAll("input[type=range]")) trackFill(el);
function trackFill(el) { const f = () => el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)) * 100 + "%"); el.addEventListener("input", f); f(); }

// ---------- worker replies ----------
const scratch = document.createElement("canvas");            // holds a draft render before it is scaled up
const paint = (canvas, w, h, buf) => { canvas.width = w; canvas.height = h; canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0); };
window.__timing = {};                                        // last measured durations in ms, for diagnosis
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "loaded" && m.timing) window.__timing.load = m.timing; if (m.ms !== undefined) window.__timing[m.type] = m.ms;
  if (m.type === "loaded") {
    state.analysis = m.analysis; state.loaded = true;
    paint(before, m.pw, m.ph, m.original); paint(after, m.pw, m.ph, m.original.slice(0));
    $("drop").hidden = true; $("print").hidden = false; $("another").hidden = false; $("download").disabled = false;
    state.size = `${m.w} × ${m.h}`;
    if (state.fxDefaults === null || !!m.effects !== !!state.fxDefaults) buildFxSliders(m.effects);
    buildSheet(); state.pos = 100; state.reveal = true; fit(); say(""); requestPreview(); requestThumbs();
  } else if (m.type === "preview") {
    state.busy = false;
    if (m.id === state.nextId) {
      const img = new ImageData(new Uint8ClampedArray(m.pixels), m.pw, m.ph), g = after.getContext("2d");
      if (m.draft) { scratch.width = m.pw; scratch.height = m.ph; scratch.getContext("2d").putImageData(img, 0, 0); g.imageSmoothingQuality = "high"; g.drawImage(scratch, 0, 0, after.width, after.height); }
      else g.putImageData(img, 0, 0);
      state.plan = m.plan; showReadout();
    }
    if (state.pending) { const d = state.pending === "draft"; state.pending = false; requestPreview(d); } else { delete $("print").dataset.busy; if (state.reveal) { state.reveal = false; curtain(); } }
  } else if (m.type === "thumbs") {
    for (const f of m.frames) { const c = document.querySelector(`.frame[data-style="${f.id}"] canvas`); if (c) paint(c, m.w, m.h, f.pixels); }
    fit();
  } else if (m.type === "progress") {
    say(`輸出原尺寸中 ${Math.round(m.t * 100)}%`);
  } else if (m.type === "exported") {
    const a = document.createElement("a"); a.href = URL.createObjectURL(m.blob); a.download = state.name.replace(/\.[^.]+$/, "") + "_顯色.jpg"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); $("download").disabled = false; say("已下載"); window.__timing.export = m.timing;
  } else if (m.type === "error") {
    state.busy = false; delete $("print").dataset.busy; $("download").disabled = !state.loaded;
    say(m.stage === "load" ? "這張照片讀不進來，檔案可能損毀或格式不支援。" : m.stage === "export" ? "輸出失敗，照片可能太大。請關掉其他分頁後再試一次。" : "處理失敗，請再調整一次或重新載入照片。");
    console.error(m);
  }
};
$("download").addEventListener("click", () => { $("download").disabled = true; say("輸出原尺寸中 0%"); worker.postMessage({ type: "export", ...settings() }); });
function say(t) { $("status").textContent = t; $("wallStatus").textContent = t; }

// The one authored moment: when the first result is ready, the curtain draws back from the original to the middle.
function curtain() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setSplit(50); return; }
  const t0 = performance.now(), dur = 900;
  const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(2, -10 * k); setSplit(100 - 50 * (k === 1 ? 1 : e)); if (k < 1 && !dragging) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
