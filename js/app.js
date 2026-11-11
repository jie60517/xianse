import { REF_TC } from "./look.js";

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

const FX_LABELS = { grain: "顆粒", diffusion: "柔焦", halation: "高光紅暈", texture: "紋理", dust: "灰塵與刮痕", vignette: "暗角" };
const state = { name: "", loaded: false, seed: 1, busy: false, pending: false, nextId: 0, fxDefaults: null, pos: 50 };
const after = $("after"), before = $("before"), viewer = $("viewer"), stage = $("stage");

// ---------- loading ----------
function load(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { say("這個檔案不是 JPEG、PNG 或 WebP，請換一個檔案。"); return; }
  state.name = file.name; state.loaded = false; $("download").disabled = true;
  say("讀取中"); worker.postMessage({ type: "load", file });
}
$("file").addEventListener("change", (e) => load(e.target.files[0]));
for (const ev of ["dragenter", "dragover"]) stage.addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); });
for (const ev of ["dragleave", "drop"]) stage.addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); });
stage.addEventListener("drop", (e) => load(e.dataTransfer.files[0]));
$("another").addEventListener("click", () => $("file").click());

// ---------- settings ----------
function settings() {
  const fx = {};
  if (state.fxDefaults) for (const k of Object.keys(FX_LABELS)) { const el = $("fx_" + k); if (el) fx[k] = $("fxOn").checked ? +el.value : 0; }
  return { strength: +$("strength").value, fx: state.fxDefaults ? fx : null, seed: state.seed };
}
function requestPreview() {
  if (!state.loaded) return;
  if (state.busy) { state.pending = true; return; }          // keep only the newest request
  state.busy = true; $("busy").hidden = false;
  worker.postMessage({ type: "preview", id: ++state.nextId, ...settings() });
}
$("strength").addEventListener("input", (e) => { $("strengthOut").textContent = (+e.target.value).toFixed(2).replace(/0$/, ""); requestPreview(); });
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
    el.value = defaults[k]; out.textContent = (+el.value).toFixed(2);
    el.addEventListener("input", () => { out.textContent = (+el.value).toFixed(2); requestPreview(); });
  }
}

// ---------- compare slider ----------
function setSplit(pct) {
  state.pos = Math.max(0, Math.min(100, pct));
  before.style.clipPath = `inset(0 ${100 - state.pos}% 0 0)`; $("split").style.left = state.pos + "%"; $("split").setAttribute("aria-valuenow", Math.round(state.pos));
}
let dragging = false;
const fromPointer = (e) => { const r = viewer.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100); };
viewer.addEventListener("pointerdown", (e) => { dragging = true; viewer.setPointerCapture(e.pointerId); fromPointer(e); });
viewer.addEventListener("pointermove", (e) => { if (dragging) fromPointer(e); });
viewer.addEventListener("pointerup", () => { dragging = false; });
$("split").addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") setSplit(state.pos - 2); if (e.key === "ArrowRight") setSplit(state.pos + 2); });

function fit() {                                            // show the whole photo inside the stage
  if (!state.loaded) return;
  after.style.width = after.style.height = "1px";            // measure the stage without the photo stretching it
  const pad = 44, r = stage.getBoundingClientRect(); const sc = Math.min((r.width - pad) / after.width, (r.height - pad) / after.height, 1);
  after.style.width = Math.round(after.width * sc) + "px"; after.style.height = Math.round(after.height * sc) + "px";
}
addEventListener("resize", fit);

// ---------- readouts ----------
const pct = (v) => Math.round(v * 100);
function showStrip(an, plan) {
  const strip = $("strip"); strip.textContent = "";
  const key = document.createElement("div"); key.className = "strip-key";
  key.innerHTML = `<span><i class="k-have"></i>這張照片的色彩量</span><span><i class="k-ref"></i>參考照片的色彩量</span>`; strip.append(key);
  const top = 0.09;
  for (let z = 0; z < 10; z++) {
    const have = an.tc_measured[z], g = Math.round(20 + z * 22), gain = plan.need[z];
    const cell = document.createElement("div"); cell.className = "zone";
    const empty = Number.isNaN(have) || have === null;
    cell.innerHTML = `<div class="zone-bar" style="background:rgb(${g},${g},${g})" title="亮度 ${z * 10}–${z * 10 + 10}%">` +
      (empty ? "" : `<div class="zone-have" style="height:${Math.min(100, (have / top) * 100)}%"></div>`) +
      `<div class="zone-ref" style="bottom:${Math.min(98, (REF_TC[z] / top) * 100)}%"></div></div>` +
      `<div class="zone-gain ${!empty && !plan.bw && gain > 1.03 ? "on" : ""}">${empty ? "—" : plan.bw ? "·" : gain > 1.03 ? "×" + gain.toFixed(2) : "不動"}</div>`;
    strip.append(cell);
  }
}
function showFacts(an, plan) {
  const rows = [];
  rows.push(["最暗點", `<b>${pct(an.p_black)}%</b> ${plan.lift > 0.002 ? `稍微鬆開 <b>+${(plan.lift * 100).toFixed(1)}</b>` : "夠了，不動"}`]);
  rows.push(["最亮點", `<b>${pct(an.p_white)}%</b> ${plan.over ? `收斂到 <b>${pct(plan.cap)}%</b> 以下` : "沒有過亮，不動"}`]);
  if (plan.bw) rows.push(["顏色", "黑白照片，只調明暗"]);
  else {
    const boosted = plan.need.filter((g) => g > 1.03).length;
    rows.push(["色彩量", boosted ? `<b>${boosted}</b> 個亮度帶不足，已補上` : "各亮度帶都足夠，不動"]);
    rows.push(["冷暖", plan.keep < 0.6 ? "照片本身色調明顯，保留原樣，只加一點暖色" : "接近中性，亮部加奶油色"]);
  }
  const [t, b, l, r] = an.box; if (t + b + l + r > 0) rows.push(["邊框", "偵測到相框，邊框保持原樣"]);
  $("facts").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(""); $("readout").hidden = false;
}

// ---------- worker replies ----------
let analysis = null;
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "loaded") {
    analysis = m.analysis; state.loaded = true;
    for (const c of [after, before]) { c.width = m.pw; c.height = m.ph; }
    before.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(m.original), m.pw, m.ph), 0, 0);
    after.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(m.original.slice(0)), m.pw, m.ph), 0, 0);
    $("drop").hidden = true; viewer.hidden = false; $("another").hidden = false; $("download").disabled = false;
    $("fileNote").textContent = state.name; $("sizeNote").textContent = `${m.w} × ${m.h}`;
    if (state.fxDefaults === null || !!m.effects !== !!state.fxDefaults) buildFxSliders(m.effects);
    setSplit(50); fit(); say(""); requestPreview();
  } else if (m.type === "preview") {
    state.busy = false;
    if (m.id === state.nextId) { after.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(m.pixels), m.pw, m.ph), 0, 0); showStrip(analysis, m.plan); showFacts(analysis, m.plan); }
    if (state.pending) { state.pending = false; requestPreview(); } else $("busy").hidden = true;
  } else if (m.type === "progress") {
    say(`輸出原尺寸中 ${Math.round(m.t * 100)}%`);
  } else if (m.type === "exported") {
    const a = document.createElement("a"); a.href = URL.createObjectURL(m.blob); a.download = state.name.replace(/\.[^.]+$/, "") + "_顯色.jpg"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); $("download").disabled = false; say("已下載");
  } else if (m.type === "error") {
    state.busy = false; $("busy").hidden = true; $("download").disabled = !state.loaded;
    say(m.stage === "load" ? "這張照片讀不進來，檔案可能損毀或格式不支援。" : m.stage === "export" ? "輸出失敗，照片可能太大。請關掉其他分頁後再試一次。" : "處理失敗，請再調整一次或重新載入照片。");
    console.error(m);
  }
};
$("download").addEventListener("click", () => { $("download").disabled = true; say("輸出原尺寸中 0%"); worker.postMessage({ type: "export", ...settings() }); });
function say(t) { $("status").textContent = t; }
