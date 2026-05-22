# Export for Claude analysis — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Let the user export the monitoring run as a single, self-contained file they can
hand to Claude (or read themselves) to analyze a suspected socket/memory leak.
Triggered by a button in the dashboard; output is a Markdown digest followed by
the compact raw time series.

## Background

`zmnMon` samples matched processes once per interval. Each sample (see
`collector.Sampler.sample`) contains:

- `ts` — epoch seconds
- `processes` — list of `{pid, name, cpu, mem, rss_kb, threads, fds, sockets}`
- `tcp_states` — `{STATE: count}` over kept connections
- `zm_states` — same, filtered to `zm_host` when set
- `connections` — full per-connection list (latest sample only, in memory)
- `churn` — `{opened, closed}` vs the previous sample

`server.SampleStore` keeps a ring buffer of **lite** samples (everything except
`connections`) plus the **latest full** sample. `store.since(0)` returns
`{"samples": [...lite...], "latest": {...full...}}`. The export uses the full
history for trends and the latest sample for connection-level detail.

## Components

### `export.py` (new)

Pure functions over plain data — no I/O, no server deps — so they are unit-testable.

- `build_report(meta: dict, samples: list[dict], latest: dict | None) -> str`
  Returns the complete Markdown document.
- Helper(s) for per-series stats: `first`, `last`, `min`, `max`, `delta`, and a
  `trend` flag (`"growing"` when the series rises and ends near its max;
  `"stable"` otherwise). Kept simple and deterministic.

Document structure:

1. **Header** — hostname, platform, `zm_host`, `proc_pattern`, `interval`,
   started (ISO), duration covered, sample count.
2. **Digest**
   - **TCP states** table: per state first → last, min, max, delta, trend.
     `CLOSE_WAIT` and `TIME_WAIT` always shown (even if zero) since they are the
     classic leak symptoms.
   - **Per process** table (keyed by pid/name): `fds`, `sockets`, `rss_kb`
     first → last and peak; `cpu` avg/max. Trend flag per process for fds and
     sockets.
   - **Churn**: cumulative opened vs closed across the run.
   - **Leak indicators**: bullet list naming any series with a `growing` trend
     (e.g. "pid 1234 (app): fds 42 → 311, growing"). Empty → "none detected".
3. **Raw data**
   - Fenced ```json block with the lite sample array (the time series).
   - Latest full connection list as a fenced ```json block.

### `server.py` (change)

- Add route `GET /api/export`:
  - `data = store.since(0)`
  - `body = export.build_report(meta, data["samples"], data["latest"])`
  - Respond `200` with `Content-Type: text/markdown; charset=utf-8` and
    `Content-Disposition: attachment; filename="zmnmon-<hostname>-<YYYYmmdd-HHMMSS>.md"`.
  - Reuse the existing `_send` helper; add a `_download` wrapper that sets the
    disposition header.

### `static/index.html` + `static/app.js` (change)

- Add an **Export** button/anchor near the existing header controls. Simplest
  implementation: `<a href="/api/export" download>Export</a>` styled to match
  existing buttons — the `Content-Disposition` header drives the download, so no
  JS is required. Add JS only if needed to match current control styling.

### `tests/test_export.py` (new)

Feed synthetic `samples`/`latest`/`meta` to `build_report` and assert:

- Header reflects sample count and duration.
- A monotonically rising `fds` series is reported `growing` and listed under
  leak indicators.
- A flat series is reported `stable` and not listed.
- `CLOSE_WAIT`/`TIME_WAIT` rows always appear.
- First/last/peak values are computed correctly.
- Empty history (no samples) produces a valid document, not a crash.

## Error handling

- Empty/None history: `build_report` returns a header + "no samples collected"
  rather than raising; the endpoint still returns a valid file.
- Missing per-process numeric fields (`None`) are skipped in stats, not summed.

## Out of scope (YAGNI)

- Continuous on-disk logging / `--log` flag.
- CSV/JSONL-only export variants.
- Server-side persistence beyond the existing in-memory window.
