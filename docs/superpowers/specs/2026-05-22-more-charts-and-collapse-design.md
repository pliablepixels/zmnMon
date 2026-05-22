# More charts + collapsible panels — design

**Date:** 2026-05-22
**Status:** Approved

## Scope
Three new charts plus collapsible chart panels.

1. **Threads per process** — chart the already-collected `threads` (NLWP). Linux only.
2. **Aggregate totals** — one chart summing fds, sockets, and RSS across all
   matched processes; fds/sockets on the left axis (counts), RSS on a right axis (MB).
3. **FD usage (% of limit)** — per process, `fds / RLIMIT_NOFILE * 100`. Needs a
   small collector change to read the soft fd limit.
4. **Collapsible panels** — each chart can collapse to its header to free space.

## Collector (`collector.py`)
- `parse_fd_limit(text) -> int | None` — pure: scan `/proc/<pid>/limits` text for
  the `Max open files` line, return the soft limit (column after the label) or
  `None` (e.g. "unlimited"/missing).
- `_fd_limit(pid)` — read `/proc/<pid>/limits`, call `parse_fd_limit`; `None` on
  any OSError (so non-Linux returns None).
- `Sampler.sample` adds `fd_limit` to each process dict.

## Frontend (`static/app.js`, `static/index.html`)
- `upsert` gains an optional `override = { scales, axes }` so a chart can use
  custom scales/axes (used by the dual-axis totals chart); existing charts
  unaffected.
- New panels (resizable) + render upserts:
  - `chart-threads`: per-process `threads` (procStyler).
  - `chart-total`: series `fds`, `sockets` on scale `y`; `RSS (MB)` on scale `mb`
    (right axis). Totals summed across processes per sample.
  - `chart-fdpct`: per process `procAgg(fds)/procAgg(fd_limit)*100`, `%` axis.
- **Collapsible panels:** `setupCollapsibles()` adds a small collapse button
  (absolute, top-right) to each `.panel.resizable`. Toggling adds `.collapsed`
  (`.collapsed .chart/.hint` hidden, height auto, `resize:none`) and persists
  `zmn.collapsed.<chartId>`. On expand, `fitChart` re-sizes the plot. State is
  applied on load.

## Testing
- `tests/test_collector.py` (extend, test-first): `parse_fd_limit` returns the
  soft limit; returns `None` for "unlimited" / a missing line.
- Browser (Playwright): the three new charts exist; the totals chart has two
  y-scales; collapsing a panel hides its chart and persists across reload.

## Out of scope (YAGNI)
- Hard-limit vs soft-limit distinction (use soft).
- Per-pid (vs per-name) breakdowns.
