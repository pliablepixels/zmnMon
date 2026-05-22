# Per-chart zoom bars — design

**Date:** 2026-05-22
**Status:** Approved

## Problem
Wheel-over-a-chart zooms, which hijacks page scrolling. Replace it with an
explicit per-chart drag bar. Correction from the earlier synced design: **zoom is
per-chart, not synced** — each chart zooms independently.

## Model
- **Per chart:** `chartSpan[id]` = visible window width in seconds (`null` = full).
  Set by that chart's zoom bar; the toolbar `+`/`-` nudge every chart's own span
  (bulk, still independent — not locked to one window).
- **Global (synced):** `follow` (live) and `rightEdge` (the window's right-edge
  timestamp when paused). Pan and Live move time position for all charts together;
  only the *width* (zoom) is per-chart.

`currentScale(id)`: `eff = clamp(chartSpan[id] ?? dataSpan, minSpan, dataSpan)`;
`re = follow ? dataMax : rightEdge` (clamped to `[dataMin+eff, dataMax]`);
window = `[re - eff, re]`. Right-anchored in both live and paused modes.

## Interactions
- **Wheel:** removed (page scrolls normally again).
- **Zoom bar (per chart):** a range `<input>` appended to each chart panel. On
  input, set `chartSpan[id]` from the slider (left = full, right = max zoom-in,
  computed against current `dataSpan`) and rescale just that chart.
- **Toolbar `+`/`-`:** multiply every chart's `chartSpan` by 0.6 / 1/0.6 (clamped;
  `>= dataSpan` → `null`/full). Bulk, per-chart-independent.
- **Drag on a chart / back / forward:** pan — `follow=false`, move `rightEdge` by
  the delta (computed from that chart's own pixel scale), all charts shift.
- **Live / double-click:** `follow=true` (resume tracking latest); each chart keeps
  its own span.
- `applyScale()` rescales every chart via `currentScale(id)`; called each render so
  live windows slide and paused windows hold.

## Nav status
Span is per-chart now, so the toolbar status shows only `Live — following` or
`Frozen at HH:MM:SS` (the shared right edge).

## UI
- Zoom bar injected per `.panel.resizable` (sibling after `.chart`, so it doesn't
  affect the plot's `fitChart` height); hidden when the panel is collapsed.
- Zoom level is in-memory (not persisted) — YAGNI.

## Testing
Browser (Playwright): wheel over a chart does NOT change its x-scale; dragging one
chart's zoom bar narrows only that chart's window (others unchanged); toolbar `-`
widens all; drag-pan shifts all; Live resumes.

## Out of scope
- Persisting per-chart zoom across reloads.
- Per-chart pan (pan stays synced).
