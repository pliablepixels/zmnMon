"use strict";

const ALERT_CW_WARN = 3;     // CLOSE_WAIT count -> header warns + chart shading
const ALERT_CW_CRIT = 8;     // CLOSE_WAIT count -> header critical
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
let lastTs = 0;
let lastRxWall = 0;
let showNoise = false;
const charts = {};

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
        const si = u.series.findIndex((s) => s._label === seriesLabel);
        if (si < 1) return;
        const xs = u.data[0], ys = u.data[si];
        const ctx = u.ctx, top = u.bbox.top, h = u.bbox.height;
        ctx.save();
        ctx.fillStyle = color;
        for (let i = 0; i < xs.length; i++) {
          if ((ys[i] || 0) < threshold) continue;
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

function axisX() { return { stroke: "#8b949e", grid: { stroke: "#21262d", width: 1 }, ticks: { stroke: "#30363d" } }; }
function axisY() { return { stroke: "#8b949e", grid: { stroke: "#21262d", width: 1 }, ticks: { stroke: "#30363d" }, size: 48 }; }

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

function upsert(elId, labels, data, styler, fmt, extraPlugins) {
  fmt = fmt || fmtNum;
  const el = $(elId);
  const key = labels.join("|");
  const existing = charts[elId];
  if (existing && existing.key === key) { existing.u.setData(data); return; }
  if (existing) existing.u.destroy();
  const opts = {
    width: el.clientWidth || 600, height: 200,
    scales: { x: { time: true } },
    legend: { show: true, live: true },
    cursor: { focus: { prox: 30 }, points: { size: 6 } },
    plugins: [tooltipPlugin(fmt), ...(extraPlugins || [])],
    axes: [axisX(), axisY()],
    series: [{ label: "time" }, ...labels.map((l, i) => styler(l, i))],
  };
  charts[elId] = { u: new uPlot(opts, data, el), key, el };
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
    [shadePlugin("CLOSE_WAIT", ALERT_CW_WARN, "rgba(218,54,52,0.14)")]);

  // ---- per-process series ----
  const names = [...new Set(samples.flatMap((s) => s.processes.map((p) => p.name)))].sort();
  const disp = names.map(shortName);
  upsert("chart-cpu", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "cpu")))],
    procStyler, (v) => v.toFixed(1) + "%");
  upsert("chart-mem", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "rss_kb") / 1024))],
    procStyler, (v) => v.toFixed(1) + " MB");
  upsert("chart-sockets", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "sockets")))], procStyler);
  upsert("chart-fds", disp, [xs, ...names.map((n) => samples.map((s) => procAgg(s, n, "fds")))], procStyler);

  upsert("chart-churn", ["opened", "closed"],
    [xs, samples.map((s) => s.churn.opened), samples.map((s) => s.churn.closed)],
    (l, i) => ({ label: l, _label: l, stroke: i === 0 ? "#56d364" : "#ff7b72", width: 1.5, points: { show: false } }));

  renderConnections();
  renderHeader();
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
    `peer <b>${esc(meta.zm_host || "all")}</b> &middot; ` +
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
    render();
  } catch (e) { /* liveness flags the gap */ }
  updateLiveness();
}

window.addEventListener("resize", () => {
  for (const k in charts) charts[k].u.setSize({ width: charts[k].el.clientWidth, height: 200 });
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
window.addEventListener("focus", poll);

(async function init() {
  meta = await (await fetch("/api/meta")).json();
  $("toggle-noise").addEventListener("change", (e) => { showNoise = e.target.checked; render(); });
  await poll();
  setInterval(poll, Math.max(1000, (meta.interval || 1) * 1000));
  setInterval(updateLiveness, 1000);
})();
