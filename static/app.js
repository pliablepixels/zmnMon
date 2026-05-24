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
let isPanning = false;   // true while dragging a chart; suppresses the hover tooltip
const chartSpan = {};    // per-chart window width in seconds (id -> sec); absent = full
const chartLive = {};    // per-chart: false when frozen in the past; absent/true = live
const chartEdge = {};    // per-chart frozen right-edge epoch seconds (when not live)
const liveBadges = {};   // per-chart header live/frozen badge element (id -> button)
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
        if (isPanning || idx == null || left < 0) { el.style.display = "none"; return; }
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
        // uPlot draw hooks work in device pixels, so scale strokes/font by the
        // pixel ratio or the label renders tiny on HiDPI screens.
        const dpr = (typeof uPlot !== "undefined" && uPlot.pxRatio) || window.devicePixelRatio || 1;
        const ctx = u.ctx, top = u.bbox.top, h = u.bbox.height;
        const x0 = u.bbox.left, x1 = u.bbox.left + u.bbox.width;
        ctx.save();
        ctx.strokeStyle = MARKER_COLOR;
        ctx.fillStyle = MARKER_COLOR;
        ctx.lineWidth = dpr;
        ctx.font = `600 ${12 * dpr}px -apple-system, system-ui, sans-serif`;
        ctx.textBaseline = "top";
        for (const m of markers) {
          const x = u.valToPos(m.ts, "x", true);
          if (x < x0 || x > x1) continue;
          ctx.setLineDash([4 * dpr, 3 * dpr]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + h);
          ctx.stroke();
          ctx.setLineDash([]);
          const label = m.text.length > 18 ? m.text.slice(0, 17) + "…" : m.text;
          ctx.fillText(label, x + 4 * dpr, top + 3 * dpr);
        }
        ctx.restore();
      },
    },
  };
}

// uPlot's legend marker is just an outlined box (we set stroke, not fill). Fill it
// with the series colour when the series is shown, leave it as an outline when the
// series is toggled off — so the legend reflects what's currently drawn.
function legendMarkerPlugin() {
  const restyle = (u) => {
    const markers = u.root.querySelectorAll(".u-legend .u-marker");  // markers[0] = x series; markers[i] = series[i]
    for (let i = 1; i < u.series.length; i++) {
      const marker = markers[i];
      if (!marker) continue;
      const s = u.series[i];
      const stroke = typeof s.stroke === "function" ? s.stroke(u, i) : s.stroke;
      marker.style.background = s.show ? stroke : "transparent";
    }
  };
  return { hooks: { ready: restyle, setSeries: restyle } };
}

// Chart input: plain click = marker (add on empty, edit/delete on a line),
// horizontal drag = pan THIS chart back/forward in its own history, double-click =
// resume live for THIS chart. No wheel handler, so the wheel scrolls the page;
// zoom is the per-chart bar.
function attachChartInput(u, id) {
  const over = u.over;
  let downLeft = null, lastX = null, moved = 0;
  over.addEventListener("mousedown", (e) => {
    downLeft = u.cursor.left; lastX = e.clientX; moved = 0;
  });
  window.addEventListener("mousemove", (e) => {
    if (downLeft == null) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    moved += Math.abs(dx);
    if (moved > 4 && !isPanning) { isPanning = true; u.setCursor({ left: -10, top: -10 }); }  // drag start: hide the hover tooltip
    if (moved > 4 && dx) {
      const sx = u.scales.x;  // this chart's current window drives the pan rate
      panChart(id, -dx * (sx.max - sx.min) / (over.clientWidth || 1));
    }
  });
  window.addEventListener("mouseup", () => {
    if (downLeft == null) return;
    isPanning = false;
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
  over.addEventListener("dblclick", () => goLiveChart(id));
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

// ---- time navigation (fully per-chart) -------------------------------------
// Every chart is independent: its zoom (chartSpan), whether it follows the latest
// sample (chartLive), and its frozen right edge when paused (chartEdge). Windows
// are right-anchored. Drag a chart to go back through ITS history; double-click it
// (or click its live badge) to resume following.
function dataBounds() {
  if (!samples.length) return null;
  return { min: samples[0].ts, max: samples[samples.length - 1].ts };
}
function dataSpan() { const b = dataBounds(); return b ? b.max - b.min : 0; }
function minSpan() { return Math.max(2 * (meta && meta.interval || 1), 0.5); }

// The x-window for one chart, from its own span + live/edge + the data bounds.
function currentScale(id) {
  const b = dataBounds();
  if (!b) return null;
  const ds = b.max - b.min;
  let eff = chartSpan[id] == null ? ds : Math.min(ds, Math.max(minSpan(), chartSpan[id]));
  const live = chartLive[id] !== false;
  let re = live ? b.max : (chartEdge[id] == null ? b.max : chartEdge[id]);
  re = Math.max(b.min + eff, Math.min(b.max, re));
  return { min: re - eff, max: re };
}

function applyScale() {
  for (const k in charts) {
    const s = currentScale(k);
    if (s) charts[k].u.setScale("x", s);
    updateChartNav(k);
  }
}

function setChartSpan(id, sec) {
  const ds = dataSpan();
  chartSpan[id] = (sec == null || sec >= ds) ? null : Math.max(minSpan(), sec);
  const c = charts[id];
  if (c) { const s = currentScale(id); if (s) c.u.setScale("x", s); }
}

// Drag inside a chart shifts only that chart's window back/forward in time.
function panChart(id, deltaSec) {
  const b = dataBounds();
  if (!b) return;
  const live = chartLive[id] !== false;
  const base = live ? b.max : (chartEdge[id] == null ? b.max : chartEdge[id]);
  chartLive[id] = false;
  chartEdge[id] = Math.max(b.min, Math.min(b.max, base + deltaSec));
  const c = charts[id];
  if (c) { const s = currentScale(id); if (s) c.u.setScale("x", s); }
  updateChartNav(id);
}

function goLiveChart(id) {
  chartLive[id] = true;
  delete chartEdge[id];
  const c = charts[id];
  if (c) { const s = currentScale(id); if (s) c.u.setScale("x", s); }
  updateChartNav(id);
}

// The per-chart live button in the panel header: green "live" while following,
// red "not live" once dragged into the past. Click it to resume live.
function updateChartNav(id) {
  const b = liveBadges[id];
  if (!b) return;
  const live = chartLive[id] !== false;
  b.classList.toggle("frozen", !live);
  b.textContent = live ? "live" : "not live";
  if (live) {
    b.title = "Live — following the latest sample. Drag the chart to go back in time.";
  } else {
    const t = chartEdge[id] != null ? chartEdge[id] : (dataBounds() || {}).max;
    b.title = "Frozen at " + (t ? new Date(t * 1000).toLocaleTimeString([], { hour12: false }) : "—") +
      " — click to resume live";
  }
}

async function clearAll() {
  try {
    const r = await fetch("/api/clear", { method: "POST" });
    if (!r.ok) return;
  } catch (e) { return; }
  samples = []; latest = null; lastTs = 0; markers = [];
  for (const k in charts) {
    charts[k].u.destroy(); delete charts[k];
    delete chartLive[k]; delete chartEdge[k];  // recreated live on the next sample
  }
  const tbody = $("conn-table").querySelector("tbody");
  if (tbody) tbody.innerHTML = '<tr><td class="empty" colspan="7">cleared — waiting for samples…</td></tr>';
  $("conn-summary").innerHTML = "";
  $("conn-count").textContent = "";
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
const ORDER_KEY = "zmn.order";   // remembered panel order (array of chart ids)
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
  // A user resize changes the panel box, so refit the plot, remember the size,
  // and let Packery repack the grid around the new dimensions.
  const ro = new ResizeObserver(() => { fitChart(el, u); persistSize(el); relayoutSoon(); });
  ro.observe(panel);
  return ro;
}

// ---- panel reordering + show/hide (Packery + Draggabilly; remembered) -------
// Packery lays the panels out as a gapless, draggable grid. Each panel is dragged
// by its grip handle only, so dragging inside a chart still pans time
// (attachChartInput) and the bottom-right resize handle still resizes.
let defaultOrder = [];     // panel order as authored in HTML, for Reset layout
let pckry = null;          // the Packery instance, once initialized
let relayoutTimer = null;
const HIDDEN_KEY = "zmn.hidden";
const panelId = (panel) => { const c = panel.querySelector(".chart"); return c ? c.id : null; };
const gridEl = () => document.getElementById("grid");
const allPanels = () => [...gridEl().querySelectorAll(".panel.resizable")];  // includes hidden
const panelById = (id) => allPanels().find((p) => panelId(p) === id) || null;

function initGrid() {
  applyHidden();        // mark hidden panels so Packery skips them
  applySavedOrder();    // reorder the DOM before Packery reads it (pckry still null)
  pckry = new Packery(gridEl(), {
    itemSelector: ".panel.resizable:not(.widget-hidden)",
    columnWidth: ".grid-sizer",
    gutter: 12,
    percentPosition: true,
    transitionDuration: "0.2s",
  });
  pckry.on("dragItemPositioned", persistOrder);  // save after every drop
}

// Make one panel draggable by its grip and let Packery handle the reordering.
function attachReorder(panel, grip) {
  if (!pckry || !window.Draggabilly) return;
  pckry.bindDraggabillyEvents(new Draggabilly(panel, { handle: ".chart-grip" }));
}

function relayout() { if (pckry) pckry.layout(); }
// Resizing fires a burst of ResizeObserver events; repacking on each one would move
// the panel out from under the cursor (runaway resize), so repack once it settles.
function relayoutSoon() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayout, 150);
}

// Packery reorders its internal item list on drag but leaves the DOM untouched, so
// mirror the visual order back into the DOM (hidden panels pushed to the end). This
// keeps reloadItems() — used by show/hide — from resetting a custom drag order.
function syncDom() {
  const grid = gridEl();
  for (const el of pckry.getItemElements()) grid.appendChild(el);            // visible, visual order
  for (const p of allPanels()) if (p.classList.contains("widget-hidden")) grid.appendChild(p);
}
function persistOrder() {
  if (!pckry) return;
  syncDom();
  localStorage.setItem(ORDER_KEY, JSON.stringify(allPanels().map(panelId).filter(Boolean)));
}
function applyOrderList(order) {
  if (!Array.isArray(order)) return;
  const grid = gridEl(), byId = {};
  for (const p of allPanels()) { const id = panelId(p); if (id) byId[id] = p; }
  for (const id of order) if (byId[id]) grid.appendChild(byId[id]);  // sizer/nav stay put
  if (pckry) { pckry.reloadItems(); pckry.layout(); }
}
function applySavedOrder() {
  let order = null;
  try { order = JSON.parse(localStorage.getItem(ORDER_KEY) || "null"); } catch (e) { return; }
  applyOrderList(order);
}

// ---- show / hide widgets ----
function hiddenIds() {
  try { const a = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function persistHidden() {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(
    allPanels().filter((p) => p.classList.contains("widget-hidden")).map(panelId).filter(Boolean)));
}
function applyHidden() {
  const set = new Set(hiddenIds());
  for (const p of allPanels()) p.classList.toggle("widget-hidden", set.has(panelId(p)));
}
function setWidget(id, show) {
  const panel = panelById(id);
  if (!panel) return;
  panel.classList.toggle("widget-hidden", !show);
  persistHidden();
  if (pckry) { pckry.reloadItems(); pckry.layout(); }
  if (show && charts[id]) fitChart(charts[id].el, charts[id].u);  // was 0-sized while hidden
}

function widgetsEl() {
  let el = $("widgets-pop");
  if (!el) {
    el = document.createElement("div");
    el.id = "widgets-pop";
    document.body.appendChild(el);
    document.addEventListener("mousedown", (e) => {
      if (el.style.display !== "none" && !el.contains(e.target) && e.target.id !== "nav-widgets")
        el.style.display = "none";
    });
  }
  return el;
}
function toggleWidgets() {
  const el = widgetsEl();
  if (el.style.display === "flex") { el.style.display = "none"; return; }
  el.innerHTML = "";
  for (const p of allPanels()) {
    const id = panelId(p);
    if (!id) continue;
    const h2 = p.querySelector("h2");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !p.classList.contains("widget-hidden");
    cb.addEventListener("change", () => setWidget(id, cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + (h2 ? h2.textContent.trim() : id)));
    el.appendChild(label);
  }
  const btn = $("nav-widgets").getBoundingClientRect();
  el.style.display = "flex";
  el.style.top = (btn.bottom + 6) + "px";
  el.style.right = Math.max(4, window.innerWidth - btn.right) + "px";
}

function upsert(elId, labels, data, styler, fmt, extraPlugins, yvalues, override) {
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
    scales: (override && override.scales) || { x: { time: true } },
    legend: { show: true, live: true },
    cursor: { drag: { x: false, y: false }, focus: { prox: 30 }, points: { size: 6 } },
    plugins: [tooltipPlugin(fmt), markerPlugin(), legendMarkerPlugin(), ...(extraPlugins || [])],
    axes: (override && override.axes) || [axisX(), axisY(yvalues)],
    series: [{ label: "time" }, ...labels.map((l, i) => styler(l, i))],
  };
  const u = new uPlot(opts, data, el);
  const sc = currentScale(elId);
  if (sc) u.setScale("x", sc);
  fitChart(el, u);  // leave room for the legend
  attachChartInput(u, elId);
  charts[elId] = { u, key, el, ro: observePanel(el, u) };
  updateChartNav(elId);  // badge lives in the header (created in setupCollapsibles)
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
  upsert("chart-threads", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "threads")))], procStyler);
  upsert("chart-fdpct", disp,
    [xs, ...names.map((n) => samples.map((s) => {
      const lim = procAgg(s, n, "fd_limit"), used = procAgg(s, n, "fds");
      return lim > 0 ? +(used / lim * 100).toFixed(1) : null;
    }))],
    procStyler, (v) => v.toFixed(1) + "%", undefined, (u, sp) => sp.map((v) => v + "%"));

  // ---- aggregate totals across matched processes (RSS on a right axis) ----
  const sumField = (s, f) => s.processes.reduce((a, p) => a + (p[f] || 0), 0);
  upsert("chart-total", ["fds", "sockets", "RSS (MB)"],
    [xs, samples.map((s) => sumField(s, "fds")), samples.map((s) => sumField(s, "sockets")),
     samples.map((s) => sumField(s, "rss_kb") / 1024)],
    (label, i) => ({ label, _label: label, stroke: PALETTE[i % PALETTE.length], width: 1.5,
      points: { show: false }, scale: label === "RSS (MB)" ? "mb" : "y" }),
    fmtNum, undefined, undefined,
    { scales: { x: { time: true }, y: {}, mb: {} },
      axes: [axisX(), axisY(), { scale: "mb", side: 1, stroke: "#8b949e",
        grid: { show: false }, ticks: { stroke: "#30363d" }, size: 62,
        values: (u, sp) => sp.map((v) => v + " MB") }] });

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
  if (ageSec > limit) { live.className = "stale"; text.textContent = `no data — ${Math.round(ageSec)}s ago`; }
  else { live.className = ""; text.textContent = "connected"; }
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

// Chart sizing is handled per-panel by ResizeObserver (observePanel); Packery
// relayouts on window resize, and the observers refit each plot to its new box.
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

function setupCollapsibles() {
  document.querySelectorAll(".panel.resizable").forEach((panel) => {
    const chart = panel.querySelector(".chart");
    const id = chart && chart.id;
    const btn = document.createElement("button");
    btn.className = "chart-collapse";
    btn.title = "Collapse / expand";
    panel.appendChild(btn);
    // Drag handle to reorder this panel among the charts.
    const grip = document.createElement("div");
    grip.className = "chart-grip";
    grip.title = "Drag to reorder";
    grip.textContent = "⠿";
    panel.appendChild(grip);
    attachReorder(panel, grip);
    // Per-chart live button: green "live" / red "not live"; click to resume live.
    const live = document.createElement("button");
    live.className = "chart-live";
    live.addEventListener("click", () => { if (id) goLiveChart(id); });
    panel.appendChild(live);
    if (id) { liveBadges[id] = live; updateChartNav(id); }
    // Per-chart zoom bar: left = full range, right = max zoom-in. Zooms only this chart.
    const bar = document.createElement("input");
    bar.type = "range"; bar.min = "0"; bar.max = "100"; bar.value = "0";
    bar.className = "zoom-bar"; bar.title = "Zoom this chart";
    bar.addEventListener("input", () => {
      if (id) setChartSpan(id, dataSpan() * (1 - bar.value / 100));
    });
    panel.appendChild(bar);
    const apply = (collapsed) => {
      panel.classList.toggle("collapsed", collapsed);
      btn.textContent = collapsed ? "▸" : "▾";
    };
    apply(id && localStorage.getItem("zmn.collapsed." + id) === "1");
    btn.addEventListener("click", () => {
      const collapsed = !panel.classList.contains("collapsed");
      apply(collapsed);
      if (id) localStorage.setItem("zmn.collapsed." + id, collapsed ? "1" : "0");
      if (!collapsed && charts[id]) fitChart(charts[id].el, charts[id].u);  // re-fit on expand
      relayout();  // height changed — repack the grid
    });
  });
  relayout();  // account for panels that started collapsed
}

function resetLayout() {
  for (const k in charts) {
    const panel = panelOf(charts[k].el);
    if (panel) { panel.style.width = ""; panel.style.height = ""; }
    localStorage.removeItem(sizeKey(k));  // panels revert to CSS defaults; observers resize plots
    localStorage.removeItem("zmn.collapsed." + k);
  }
  document.querySelectorAll(".panel.collapsed").forEach((p) => {
    p.classList.remove("collapsed");
    const b = p.querySelector(".chart-collapse");
    if (b) b.textContent = "▾";
  });
  for (const k in charts) { delete chartSpan[k]; chartLive[k] = true; delete chartEdge[k]; }  // reset zoom + go live
  document.querySelectorAll(".zoom-bar").forEach((b) => { b.value = "0"; });
  document.querySelectorAll(".panel.widget-hidden").forEach((p) => p.classList.remove("widget-hidden"));
  localStorage.removeItem(HIDDEN_KEY);            // show every widget again
  applyOrderList(defaultOrder);                  // restore the authored order + repack
  localStorage.removeItem(ORDER_KEY);
  for (const k in charts) fitChart(charts[k].el, charts[k].u);  // refit any just-shown charts
  applyScale();                                  // re-anchor every chart to live
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
  $("nav-widgets").addEventListener("click", toggleWidgets);
  $("nav-clear").addEventListener("click", confirmClear);
  $("conn-collapse").addEventListener("click", () => setSidebar(true));
  $("sidebar-show").addEventListener("click", () => setSidebar(false));
  if (localStorage.getItem("zmn.sidebar") === "collapsed") setSidebar(true);
  defaultOrder = allPanels().map(panelId).filter(Boolean);  // authored order, before any reorder
  initGrid();          // applies hidden + saved order, then starts Packery
  setupCollapsibles(); // adds grip/collapse/zoom and binds Draggabilly (needs pckry)
  await poll();
  restartPoll();
  setInterval(updateLiveness, 1000);
})();
