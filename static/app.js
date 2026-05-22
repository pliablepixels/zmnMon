"use strict";

// CLOSE_WAIT alert levels (header + chart shading). Client-only; adjustable in
// Settings and remembered across reloads via localStorage.
let ALERT_CW_WARN = Number(localStorage.getItem("zmn.cwWarn")) || 3;
let ALERT_CW_CRIT = Number(localStorage.getItem("zmn.cwCrit")) || 8;
const MAX_POINTS = 5000;     // client-side history cap
const NOISE_STATES = ["LISTEN", "CLOSING"]; // hidden from the states chart by default

const STATE_COLORS = {
  ESTABLISHED: "#56d364", CLOSE_WAIT: "#ff7b72", TIME_WAIT: "#79c0ff",
  SYN_SENT: "#ffa657", SYN_RECV: "#e3b341", FIN_WAIT_1: "#d2a8ff",
  FIN_WAIT_2: "#bc8cff", LAST_ACK: "#f778ba", CLOSING: "#ff9bce", LISTEN: "#8b949e",
};
const PALETTE = ["#58a6ff", "#56d364", "#ff7b72", "#ffa657", "#d2a8ff",
  "#79c0ff", "#e3b341", "#f778ba", "#a5d6ff", "#ffab70"];

let meta = null;
let samples = [];
let latest = null;
let markers = [];
let lastTs = 0;
let lastRxWall = 0;
let showNoise = false;
let showLegends = localStorage.getItem("zmn.legends") !== "off";
let pollTimer = null;
let follow = true;       // does the window's right edge track the latest sample?
let span = null;         // window width in seconds; null = full data range
let frozenWin = null;    // fixed {min, max} used only when !follow (after a pan)
const charts = {};

const MARKER_COLOR = "#d29922";
const MARKER_HIT_PX = 6;     // click within this many px of a line targets it for delete

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function shortName(name) { return name.split("/").pop().split(" ").pop() || name; }
function fmtAddr(host, port) {
  if (!host && port == null) return "";
  return esc(host || "*") + ":" + (port == null ? "*" : port);
}
function fmtNum(v) { return v == null ? "—" : (Number.isInteger(v) ? String(v) : v.toFixed(1)); }
function fmtClock(epochSec) {
  const d = new Date(epochSec * 1000);
  return d.toLocaleTimeString([], { hour12: false }) +
    "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 2);
}

// ---- plugins ----------------------------------------------------------------
function tooltipPlugin(fmt) {
  let el;
  return {
    hooks: {
      init: (u) => {
        el = document.createElement("div");
        el.className = "u-tooltip";
        u.over.appendChild(el);
        u.over.addEventListener("mouseleave", () => { el.style.display = "none"; });
      },
      setCursor: (u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left < 0) { el.style.display = "none"; return; }
        const x = u.data[0][idx];
        let rows = "";
        for (let i = 1; i < u.series.length; i++) {
          const s = u.series[i];
          if (s.show === false) continue;
          const v = u.data[i][idx];
          if (v == null) continue;
          const stroke = typeof s.stroke === "function" ? s.stroke(u, i) : s.stroke;
          rows += `<div class="t-row"><span><span class="t-dot" style="background:${stroke}"></span>${esc(s.label)}</span><b>${fmt(v)}</b></div>`;
        }
        if (!rows) { el.style.display = "none"; return; }
        el.innerHTML = `<div class="t-time">${fmtClock(x)}</div>${rows}`;
        el.style.display = "block";
        const w = el.offsetWidth, h = el.offsetHeight;
        const oW = u.over.clientWidth, oH = u.over.clientHeight;
        let tx = left + 14, ty = top + 14;
        if (tx + w > oW) tx = left - 14 - w;
        if (ty + h > oH) ty = Math.max(0, oH - h);
        el.style.transform = `translate(${tx}px, ${ty}px)`;
      },
    },
  };
}

// Shade vertical bands where `seriesLabel` is at or above `threshold`.
function shadePlugin(seriesLabel, threshold, color) {
  return {
    hooks: {
      drawClear: (u) => {
        const t = typeof threshold === "function" ? threshold() : threshold;
        const si = u.series.findIndex((s) => s._label === seriesLabel);
        if (si < 1) return;
        const xs = u.data[0], ys = u.data[si];
        const ctx = u.ctx, top = u.bbox.top, h = u.bbox.height;
        ctx.save();
        ctx.fillStyle = color;
        for (let i = 0; i < xs.length; i++) {
          if ((ys[i] || 0) < t) continue;
          const xPrev = i > 0 ? (xs[i - 1] + xs[i]) / 2 : xs[i];
          const xNext = i < xs.length - 1 ? (xs[i] + xs[i + 1]) / 2 : xs[i];
          const x0 = u.valToPos(xPrev, "x", true);
          const x1 = u.valToPos(xNext, "x", true);
          ctx.fillRect(x0, top, Math.max(1, x1 - x0), h);
        }
        ctx.restore();
      },
    },
  };
}

// Draw a dashed vertical line + truncated label at each marker's timestamp.
function markerPlugin() {
  return {
    hooks: {
      draw: (u) => {
        if (!markers.length) return;
        const ctx = u.ctx, top = u.bbox.top, h = u.bbox.height;
        const x0 = u.bbox.left, x1 = u.bbox.left + u.bbox.width;
        ctx.save();
        ctx.strokeStyle = MARKER_COLOR;
        ctx.fillStyle = MARKER_COLOR;
        ctx.lineWidth = 1;
        ctx.font = "10px -apple-system, system-ui, sans-serif";
        ctx.textBaseline = "top";
        for (const m of markers) {
          const x = u.valToPos(m.ts, "x", true);
          if (x < x0 || x > x1) continue;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + h);
          ctx.stroke();
          ctx.setLineDash([]);
          const label = m.text.length > 18 ? m.text.slice(0, 17) + "…" : m.text;
          ctx.fillText(label, x + 3, top + 2);
        }
        ctx.restore();
      },
    },
  };
}

// Chart input: plain click = marker (add on empty, edit/delete on a line),
// horizontal drag = pan, wheel = zoom, double-click = resume live.
function attachChartInput(u) {
  const over = u.over;
  let downLeft = null, lastX = null, moved = 0;
  over.addEventListener("mousedown", (e) => {
    downLeft = u.cursor.left; lastX = e.clientX; moved = 0;
  });
  window.addEventListener("mousemove", (e) => {
    if (downLeft == null) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    moved += Math.abs(dx);
    if (moved > 4 && dx) {
      const w = currentScale();
      if (w) panBy(-dx * (w.max - w.min) / (over.clientWidth || 1));
    }
  });
  window.addEventListener("mouseup", () => {
    if (downLeft == null) return;
    const left = u.cursor.left, top = u.cursor.top;
    const wasClick = moved <= 4;
    downLeft = null;
    if (!wasClick || left < 0) return;  // a drag (pan), or cursor outside plot
    let hit = null;
    for (const m of markers) {
      if (Math.abs(u.valToPos(m.ts, "x") - left) <= MARKER_HIT_PX) { hit = m; break; }
    }
    const rect = over.getBoundingClientRect();
    if (hit) openMarkerPopover(rect.left + left, rect.top + top, hit);
    else openAddPopover(rect.left + left, rect.top + top, u.posToVal(left, "x"));
  });
  over.addEventListener("wheel", (e) => {
    e.preventDefault();
    const center = u.posToVal(u.cursor.left >= 0 ? u.cursor.left : over.clientWidth / 2, "x");
    zoomAround(center, e.deltaY < 0 ? 0.8 : 1.25);  // wheel up = zoom in
  }, { passive: false });
  over.addEventListener("dblclick", goLive);
}

function popoverEl() {
  let el = $("marker-pop");
  if (!el) {
    el = document.createElement("div");
    el.id = "marker-pop";
    document.body.appendChild(el);
    document.addEventListener("mousedown", (e) => {
      if (el.style.display !== "none" && !el.contains(e.target)) closePopover();
    });
  }
  return el;
}
function placePopover(el, x, y) {
  el.style.display = "flex";
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + "px";
}
function closePopover() { const el = $("marker-pop"); if (el) el.style.display = "none"; }

function openAddPopover(x, y, ts) {
  const el = popoverEl();
  el.innerHTML = '<input type="text" id="marker-input" placeholder="note…" maxlength="200">' +
    '<button id="marker-save">Add</button>';
  placePopover(el, x, y);
  const input = $("marker-input");
  input.focus();
  const save = () => {
    const text = input.value.trim();
    closePopover();
    if (text) addMarker(ts, text);
  };
  $("marker-save").onclick = save;
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") closePopover();
  };
}

function openMarkerPopover(x, y, marker) {
  const el = popoverEl();
  el.innerHTML = '<input type="text" id="marker-input" maxlength="200">' +
    '<button id="marker-save">Save</button>' +
    '<button id="marker-del">Delete</button>';
  placePopover(el, x, y);
  const input = $("marker-input");
  input.value = marker.text;
  input.focus();
  input.select();
  const save = () => {
    const text = input.value.trim();
    closePopover();
    if (text && text !== marker.text) updateMarker(marker.id, text);
  };
  $("marker-save").onclick = save;
  $("marker-del").onclick = () => { closePopover(); deleteMarker(marker.id); };
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") closePopover();
  };
}

async function addMarker(ts, text) {
  try {
    const r = await fetch("/api/markers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts, text }),
    });
    if (r.ok) {
      markers.push(await r.json());
      markers.sort((a, b) => a.ts - b.ts);
      redrawMarkers();
    }
  } catch (e) { /* ignore; next poll re-syncs */ }
}

async function deleteMarker(id) {
  try {
    const r = await fetch("/api/markers?id=" + id, { method: "DELETE" });
    if (r.ok) {
      markers = markers.filter((m) => m.id !== id);
      redrawMarkers();
    }
  } catch (e) { /* ignore; next poll re-syncs */ }
}

async function updateMarker(id, text) {
  try {
    const r = await fetch("/api/markers?id=" + id, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok) {
      const upd = await r.json();
      markers = markers.map((m) => (m.id === upd.id ? upd : m));
      redrawMarkers();
    }
  } catch (e) { /* ignore; next poll re-syncs */ }
}

function redrawMarkers() { for (const k in charts) charts[k].u.redraw(); }

// ---- time navigation (zoom / pan, synced across all charts) ----------------
// follow + span model: zooming changes the span (granularity) and, while
// following, keeps the window pinned to the latest sample so it slides with new
// data. Panning sets a fixed frozen window. Live resumes following at the
// current span.
function dataBounds() {
  if (!samples.length) return null;
  return { min: samples[0].ts, max: samples[samples.length - 1].ts };
}
function dataSpan() { const b = dataBounds(); return b ? b.max - b.min : 0; }
function minSpan() { return Math.max(2 * (meta && meta.interval || 1), 0.5); }

// The x-window to show right now, derived from follow/span/frozenWin + data.
function currentScale() {
  const b = dataBounds();
  if (!b) return null;
  if (!follow) return frozenWin || { min: b.min, max: b.max };
  if (span == null) return { min: b.min, max: b.max };
  return { min: b.max - span, max: b.max };  // last `span` seconds, right-anchored
}

function applyScale() {
  const s = currentScale();
  if (s) for (const k in charts) charts[k].u.setScale("x", s);
  updateNav();
}

function effectiveSpan() {
  const s = currentScale();
  return s ? s.max - s.min : dataSpan();
}

function zoomAround(center, factor) {
  const b = dataBounds();
  if (!b) return;
  const newSpan = effectiveSpan() * factor;
  if (follow) {
    span = newSpan >= dataSpan() ? null : Math.max(minSpan(), newSpan);
  } else {
    const w = frozenWin || { min: b.min, max: b.max };
    let min = center - (center - w.min) * factor;
    let max = center + (w.max - center) * factor;
    if (max - min < minSpan()) { min = center - minSpan() / 2; max = center + minSpan() / 2; }
    frozenWin = { min: Math.max(b.min, min), max: Math.min(b.max, max) };
    span = frozenWin.max - frozenWin.min;
  }
  applyScale();
}

function panBy(deltaSec) {
  const s = currentScale(), b = dataBounds();
  if (!s || !b) return;
  const width = s.max - s.min;
  let min = s.min + deltaSec, max = s.max + deltaSec;
  if (min < b.min) { min = b.min; max = b.min + width; }
  if (max > b.max) { max = b.max; min = b.max - width; }
  follow = false;
  frozenWin = { min, max };
  span = width;
  applyScale();
}

function goLive() {
  follow = true;
  frozenWin = null;  // keep span -> resume following at the current granularity
  applyScale();
}

function fmtSpan(sec) {
  sec = Math.round(sec);
  if (sec < 90) return sec + "s";
  const m = Math.round(sec / 60);
  return m < 90 ? m + "m" : Math.round(m / 60) + "h";
}

function updateNav() {
  const status = $("nav-status"), live = $("nav-live");
  if (!status) return;
  if (follow) {
    live.classList.add("active");
    status.textContent = span == null ? "Live — following" : `Live — last ${fmtSpan(span)} window`;
  } else {
    live.classList.remove("active");
    const w = currentScale();
    status.textContent = w ? `Frozen: ${fmtClock(w.min)}–${fmtClock(w.max)}` : "Frozen";
  }
}

async function clearAll() {
  try {
    const r = await fetch("/api/clear", { method: "POST" });
    if (!r.ok) return;
  } catch (e) { return; }
  samples = []; latest = null; lastTs = 0; markers = [];
  for (const k in charts) { charts[k].u.destroy(); delete charts[k]; }
  const tbody = $("conn-table").querySelector("tbody");
  if (tbody) tbody.innerHTML = '<tr><td class="empty" colspan="7">cleared — waiting for samples…</td></tr>';
  $("conn-summary").innerHTML = "";
  $("conn-count").textContent = "";
  goLive();
}

function clearPopEl() {
  let el = $("clear-pop");
  if (!el) {
    el = document.createElement("div");
    el.id = "clear-pop";
    document.body.appendChild(el);
    document.addEventListener("mousedown", (e) => {
      if (el.style.display !== "none" && !el.contains(e.target) && e.target.id !== "nav-clear")
        el.style.display = "none";
    });
  }
  return el;
}

function confirmClear() {
  const el = clearPopEl();
  if (el.style.display === "flex") { el.style.display = "none"; return; }
  el.innerHTML = "<span>Clear all graphs &amp; markers?</span><button id=\"clear-yes\">Clear</button>";
  const btn = $("nav-clear").getBoundingClientRect();
  el.style.display = "flex";
  el.style.top = (btn.bottom + 6) + "px";
  el.style.right = Math.max(4, window.innerWidth - btn.right) + "px";
  $("clear-yes").onclick = () => { el.style.display = "none"; clearAll(); };
}

// ---- settings -------------------------------------------------------------
function restartPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, Math.max(1000, (meta.interval || 1) * 1000));
}

function settingsEl() {
  let el = $("settings-pop");
  if (!el) {
    el = document.createElement("div");
    el.id = "settings-pop";
    document.body.appendChild(el);
    document.addEventListener("mousedown", (e) => {
      if (el.style.display !== "none" && !el.contains(e.target) && e.target.id !== "settings-btn")
        el.style.display = "none";
    });
  }
  return el;
}

function toggleSettings() {
  const el = settingsEl();
  if (el.style.display === "flex") { el.style.display = "none"; return; }
  el.innerHTML =
    '<label>Process pattern<input id="set-proc" type="text"></label>' +
    '<label>Peer host<input id="set-peer" type="text" placeholder="all peers"></label>' +
    '<label>Sample interval (s)<input id="set-interval" type="number" min="0.1" step="0.1"></label>' +
    '<label>History (s)<input id="set-history" type="number" min="1" step="1"></label>' +
    '<label>CLOSE_WAIT warn<input id="set-warn" type="number" min="0" step="1"></label>' +
    '<label>CLOSE_WAIT critical<input id="set-crit" type="number" min="0" step="1"></label>' +
    '<div class="row"><button id="set-apply">Apply</button>' +
    '<button id="set-reset" type="button">Reset layout</button><span id="set-err"></span></div>';
  $("set-proc").value = meta.proc_pattern || "";
  $("set-peer").value = meta.peer || "";
  $("set-interval").value = meta.interval;
  $("set-history").value = meta.history_seconds;
  $("set-warn").value = ALERT_CW_WARN;
  $("set-crit").value = ALERT_CW_CRIT;
  const btn = $("settings-btn").getBoundingClientRect();
  el.style.display = "flex";
  el.style.top = (btn.bottom + 6) + "px";
  el.style.right = (window.innerWidth - btn.right) + "px";
  $("set-apply").onclick = applySettings;
  $("set-reset").onclick = () => { resetLayout(); settingsEl().style.display = "none"; };
  $("set-proc").focus();
}

async function applySettings() {
  const errEl = $("set-err");
  errEl.textContent = "";
  const warn = Number($("set-warn").value), crit = Number($("set-crit").value);
  if (!Number.isFinite(warn) || !Number.isFinite(crit) || warn > crit) {
    errEl.textContent = "warn must be a number <= crit";
    return;
  }
  ALERT_CW_WARN = warn; ALERT_CW_CRIT = crit;
  localStorage.setItem("zmn.cwWarn", warn);
  localStorage.setItem("zmn.cwCrit", crit);

  const prevProc = meta.proc_pattern, prevPeer = meta.peer || "", prevInt = meta.interval;
  const payload = {
    proc: $("set-proc").value.trim(),
    peer: $("set-peer").value.trim(),
    interval: Number($("set-interval").value),
    history_seconds: Number($("set-history").value),
  };
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { errEl.textContent = await r.text(); return; }
    meta = await r.json();
    if (meta.proc_pattern !== prevProc || (meta.peer || "") !== prevPeer) {
      samples = []; latest = null; lastTs = 0;  // filter changed -> refetch fresh
    }
    if (meta.interval !== prevInt) restartPoll();
    settingsEl().style.display = "none";
    render();
    await poll();
  } catch (e) {
    errEl.textContent = "request failed";
  }
}

function axisX() { return { stroke: "#8b949e", grid: { stroke: "#21262d", width: 1 }, ticks: { stroke: "#30363d" } }; }
function axisY(values) {
  const a = { stroke: "#8b949e", grid: { stroke: "#21262d", width: 1 }, ticks: { stroke: "#30363d" },
    size: values ? 62 : 48 };
  if (values) a.values = values;  // e.g. tick labels with a unit suffix
  return a;
}

function stateStyler(label) {
  if (label === "STUCK") {
    return { label: "STUCK (CW+FIN_WAIT_2)", _label: "STUCK", stroke: "#ff3b30",
      width: 3, dash: [8, 4], points: { show: false } };
  }
  return { label, _label: label, stroke: STATE_COLORS[label] || "#8b949e",
    width: label === "CLOSE_WAIT" ? 2.5 : 1.5, points: { show: false } };
}
function procStyler(label, i) {
  return { label, _label: label, stroke: PALETTE[i % PALETTE.length], width: 1.5, points: { show: false } };
}

// ---- per-panel sizing (resizable + remembered) ----------------------------
const sizeKey = (id) => "zmn.size." + id;
function panelOf(el) { return el.closest(".panel"); }

function applySavedSize(el) {
  const panel = panelOf(el);
  if (!panel) return;
  try {
    const s = JSON.parse(localStorage.getItem(sizeKey(el.id)) || "null");
    if (s && s.w && s.h) { panel.style.width = s.w + "px"; panel.style.height = s.h + "px"; }
  } catch (e) { /* ignore bad stored value */ }
}

function persistSize(el) {
  const panel = panelOf(el);
  // Only a user drag sets inline width/height; reflow does not, so this never
  // overwrites a remembered size with a layout-driven one.
  if (panel && panel.style.width && panel.style.height) {
    localStorage.setItem(sizeKey(el.id), JSON.stringify({ w: panel.offsetWidth, h: panel.offsetHeight }));
  }
}

// Size the plot to fill its .chart box, leaving room for the legend below it so
// it isn't clipped by the panel's overflow:hidden (needed for the resize handle).
function fitChart(el, u) {
  const legend = u.root && u.root.querySelector(".u-legend");
  const legendH = legend ? legend.offsetHeight : 0;  // 0 when hidden via CSS; capped + scrolls
  const w = el.clientWidth, h = Math.max(40, el.clientHeight - legendH);
  if (w > 0) u.setSize({ width: w, height: h });
}

function observePanel(el, u) {
  const panel = panelOf(el);
  if (!panel || !window.ResizeObserver) return null;
  const ro = new ResizeObserver(() => { fitChart(el, u); persistSize(el); });
  ro.observe(panel);
  return ro;
}

function upsert(elId, labels, data, styler, fmt, extraPlugins, yvalues) {
  fmt = fmt || fmtNum;
  const el = $(elId);
  const key = labels.join("|");
  const existing = charts[elId];
  if (existing && existing.key === key) {
    existing.u.setData(data, false);  // never auto-reset; applyScale() sets the window
    return;
  }
  if (existing) { if (existing.ro) existing.ro.disconnect(); existing.u.destroy(); }
  applySavedSize(el);  // restore remembered panel size before measuring
  const opts = {
    width: el.clientWidth || 600, height: el.clientHeight || 200,
    scales: { x: { time: true } },
    legend: { show: true, live: true },
    cursor: { drag: { x: false, y: false }, focus: { prox: 30 }, points: { size: 6 } },
    plugins: [tooltipPlugin(fmt), markerPlugin(), ...(extraPlugins || [])],
    axes: [axisX(), axisY(yvalues)],
    series: [{ label: "time" }, ...labels.map((l, i) => styler(l, i))],
  };
  const u = new uPlot(opts, data, el);
  const sc = currentScale();
  if (sc) u.setScale("x", sc);
  fitChart(el, u);  // leave room for the legend
  attachChartInput(u);
  charts[elId] = { u, key, el, ro: observePanel(el, u) };
}

function procAgg(sample, name, field) {
  let sum = 0;
  for (const p of sample.processes) if (p.name === name) sum += p[field] || 0;
  return sum;
}

function render() {
  if (!meta || !samples.length) return;
  const xs = samples.map((s) => s.ts);

  // ---- TCP states (noise hidden by default, derived STUCK line, red shading) ----
  let stateLabels = meta.states.filter((st) => samples.some((s) => (s.tcp_states[st] || 0) > 0));
  if (!showNoise) stateLabels = stateLabels.filter((st) => !NOISE_STATES.includes(st));
  const labels = [...stateLabels];
  const data = [xs, ...stateLabels.map((st) => samples.map((s) => s.tcp_states[st] || 0))];
  const stuck = samples.map((s) => (s.tcp_states.CLOSE_WAIT || 0) + (s.tcp_states.FIN_WAIT_2 || 0));
  if (Math.max(0, ...stuck) > 0) { labels.push("STUCK"); data.push(stuck); }
  upsert("chart-states", labels, data, stateStyler, fmtNum,
    [shadePlugin("CLOSE_WAIT", () => ALERT_CW_WARN, "rgba(218,54,52,0.14)")]);

  // ---- per-process series ----
  const names = [...new Set(samples.flatMap((s) => s.processes.map((p) => p.name)))].sort();
  const disp = names.map(shortName);
  upsert("chart-cpu", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "cpu")))],
    procStyler, (v) => v.toFixed(1) + "%");
  upsert("chart-mem", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "rss_kb") / 1024))],
    procStyler, (v) => v.toFixed(1) + " MB", undefined, (u, splits) => splits.map((v) => v + " MB"));
  upsert("chart-sockets", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "sockets")))], procStyler);
  upsert("chart-fds", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "fds")))], procStyler);

  upsert("chart-churn", ["opened", "closed"],
    [xs, samples.map((s) => s.churn.opened), samples.map((s) => s.churn.closed)],
    (l, i) => ({ label: l, _label: l, stroke: i === 0 ? "#56d364" : "#ff7b72", width: 1.5, points: { show: false } }));

  renderConnections();
  renderHeader();
  applyScale();  // keep the time window (live-sliding or frozen) after new data
}

function renderConnections() {
  const last = samples[samples.length - 1];
  const counts = (last && last.tcp_states) || {};
  const summary = $("conn-summary");
  const present = meta.states.filter((st) => (counts[st] || 0) > 0);
  summary.innerHTML = present.length
    ? present.map((st) => `<span class="pill ${st}">${st} ${counts[st]}</span>`).join("")
    : '<span class="meta">no open sockets</span>';

  const tbody = $("conn-table").querySelector("tbody");
  const conns = (latest && latest.connections) ? latest.connections.slice() : [];
  $("conn-count").textContent = conns.length ? `(${conns.length})` : "";
  if (!conns.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="7">no matching connections</td></tr>';
    return;
  }
  const rank = (st) => (st === "CLOSE_WAIT" ? 0 : 1);
  conns.sort((a, b) =>
    rank(a.state) - rank(b.state) || a.state.localeCompare(b.state) ||
    (a.proc || "").localeCompare(b.proc || ""));
  tbody.innerHTML = conns.map((c) => {
    const cls = c.state === "CLOSE_WAIT" ? ' class="cw"' : "";
    const req = c.request ? `${c.request.method} ${c.request.path}` : "";
    return `<tr${cls}><td><span class="pill ${esc(c.state)}">${esc(c.state)}</span></td>` +
      `<td>${esc(c.proc || "")}</td>` +
      `<td class="num">${c.pid ?? ""}</td><td class="num">${c.fd ?? ""}</td>` +
      `<td>${fmtAddr(c.laddr, c.lport)}</td><td>${fmtAddr(c.raddr, c.rport)}</td>` +
      `<td class="req" title="${esc(req)}">${esc(req)}</td></tr>`;
  }).join("");
}

function renderHeader() {
  const last = samples[samples.length - 1];
  const cw = last ? (last.tcp_states.CLOSE_WAIT || 0) : 0;
  const alert = $("alert");
  alert.textContent = `CLOSE_WAIT: ${cw}`;
  alert.className = cw >= ALERT_CW_CRIT ? "crit" : cw >= ALERT_CW_WARN ? "warn" : "";

  $("meta").innerHTML =
    `<b>${esc(meta.hostname)}</b> ${esc(meta.platform)} &middot; ` +
    `peer <b>${esc(meta.peer || "all")}</b> &middot; ` +
    `every <b>${meta.interval}s</b> &middot; ` +
    `sniff <b>${meta.sniffing ? "on" : "off"}</b> &middot; <b>${samples.length}</b> samples`;
}

function updateLiveness() {
  const live = $("live"), text = $("live-text");
  if (!lastRxWall) { text.textContent = "connecting…"; return; }
  const ageSec = (Date.now() - lastRxWall) / 1000;
  const limit = Math.max(3, (meta && meta.interval ? meta.interval : 1) * 3);
  if (ageSec > limit) { live.className = "stale"; text.textContent = `stale — ${Math.round(ageSec)}s ago`; }
  else { live.className = ""; text.textContent = "live"; }
}

async function poll() {
  try {
    const r = await fetch("/api/samples?since=" + lastTs);
    const j = await r.json();
    if (j.samples && j.samples.length) {
      samples.push(...j.samples);
      lastTs = samples[samples.length - 1].ts;
      lastRxWall = Date.now();
      if (samples.length > MAX_POINTS) samples.splice(0, samples.length - MAX_POINTS);
    }
    latest = j.latest;
    if (j.markers) markers = j.markers;
    render();
  } catch (e) { /* liveness flags the gap */ }
  updateLiveness();
}

// Chart sizing is handled per-panel by ResizeObserver (observePanel); window
// resizes change panel widths via flex reflow, which the observers pick up.
function setSidebar(collapsed) {
  document.querySelector(".layout").classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem("zmn.sidebar", collapsed ? "collapsed" : "open");
}

function setLegends(on) {
  showLegends = on;
  document.body.classList.toggle("legends-hidden", !on);
  localStorage.setItem("zmn.legends", on ? "on" : "off");
  for (const k in charts) fitChart(charts[k].el, charts[k].u);  // reclaim/yield legend space
}

function resetLayout() {
  for (const k in charts) {
    const panel = panelOf(charts[k].el);
    if (panel) { panel.style.width = ""; panel.style.height = ""; }
    localStorage.removeItem(sizeKey(k));  // panels revert to CSS defaults; observers resize plots
  }
  setSidebar(false);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
window.addEventListener("focus", poll);

(async function init() {
  window.zmnCharts = charts;  // debug handle: inspect uPlot instances from the console
  meta = await (await fetch("/api/meta")).json();
  $("toggle-noise").addEventListener("change", (e) => { showNoise = e.target.checked; render(); });
  document.body.classList.toggle("legends-hidden", !showLegends);
  $("toggle-legends").checked = showLegends;
  $("toggle-legends").addEventListener("change", (e) => setLegends(e.target.checked));
  $("settings-btn").addEventListener("click", toggleSettings);
  $("nav-zoomin").addEventListener("click", () => { const w = currentScale(); if (w) zoomAround((w.min + w.max) / 2, 0.6); });
  $("nav-zoomout").addEventListener("click", () => { const w = currentScale(); if (w) zoomAround((w.min + w.max) / 2, 1 / 0.6); });
  $("nav-back").addEventListener("click", () => { const w = currentScale(); if (w) panBy(-(w.max - w.min) * 0.25); });
  $("nav-fwd").addEventListener("click", () => { const w = currentScale(); if (w) panBy((w.max - w.min) * 0.25); });
  $("nav-live").addEventListener("click", goLive);
  $("nav-clear").addEventListener("click", confirmClear);
  $("conn-collapse").addEventListener("click", () => setSidebar(true));
  $("sidebar-show").addEventListener("click", () => setSidebar(false));
  if (localStorage.getItem("zmn.sidebar") === "collapsed") setSidebar(true);
  updateNav();
  await poll();
  restartPoll();
  setInterval(updateLiveness, 1000);
})();
