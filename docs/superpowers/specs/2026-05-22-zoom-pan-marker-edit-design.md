# Synced zoom/pan + marker editing — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Let the user navigate each chart in time — zoom in for granular timing and pan
back/forth over the retained history — with all charts staying time-synced. While
navigating, let the user edit or remove existing markers. Panning covers all
retained history (already client-side, so it is just rescaling).

## Decisions

- **Synced:** zoom/pan on any chart applies the same time window to all charts.
- **Controls:** both mouse gestures (wheel zoom, drag pan) and a toolbar
  (zoom in/out, back/forward, Live).
- **History depth:** all retained history (no 30-min cap).
- **Markers:** clicking a marker opens an editable popover (Save + Delete);
  adding stays add-only.

## The live/frozen mechanic

Today `render()` calls `upsert(...)` which, for an existing chart, does
`setData(data)` — uPlot's default resets the x-scale to the full data range every
poll (live follow). To support navigation:

- Module state: `viewMode` is `"live"` or `"frozen"`; `viewWin` is `{min, max}`
  (epoch seconds) when frozen, else `null`.
- `setData` is called as `setData(data, viewMode === "live")`. Live → reset to
  full range (follow latest). Frozen → keep the current scale, so the window stays
  put while new samples accumulate off-screen.
- Newly created charts (label set changed) while frozen get `u.setScale("x",
  viewWin)` applied right after creation.

## Navigation (client, `static/app.js`)

- `dataBounds()` → `{min: xs[0], max: xs[last]}` from `samples` (empty → null).
- `applyWindow(min, max)`: clamp to `dataBounds`, enforce a minimum span (e.g.
  2× the sample interval) so zoom-in can't collapse to zero, set
  `viewMode="frozen"` and `viewWin`, call `u.setScale("x", viewWin)` on every
  chart, update the toolbar status.
- `goLive()`: `viewMode="live"`, `viewWin=null`, snap every chart's x-scale to
  `dataBounds` (or let the next `setData` follow), update toolbar.
- **Zoom**: new span = current span × factor (`0.6` in, `1/0.6` out) around a
  center. Center is the cursor x for the wheel, the window center for the buttons.
- **Pan**: shift the window by a delta — buttons move ±25% of the span; drag
  converts pixel delta to a time delta via `u.posToVal`. Clamp to `dataBounds`.
- uPlot native drag-zoom is disabled (`cursor.drag = { x:false, y:false }`) so
  horizontal drag is free for panning and does not conflict with marker clicks;
  double-click calls `goLive()`.

### Gesture routing (extends the existing marker click handler)

On each chart's `u.over`:
- `mousedown` records the start position.
- `mousemove` with the button down → pan by the incremental delta (frozen).
- `mouseup`: if total movement < ~4px → treat as a click → marker add/edit/delete;
  otherwise it was a pan (no marker).
- `wheel` → zoom around the cursor x (`preventDefault`).

### Toolbar (`static/index.html`)

A thin bar spanning the top of `<main>` (full grid width). Shows the window
status — "Live — following" or the frozen `HH:MM:SS–HH:MM:SS` range — and buttons:
zoom in, zoom out, ◀ back, forward ▶, Live (Live disabled/active-styled when
already live). Styled to match the dark theme.

## Marker editing

- Clicking a marker line (existing hit-test) opens a popover **pre-filled with the
  marker text** plus **Save** and **Delete** buttons; Enter saves, Esc cancels.
- Clicking empty space keeps the add-only popover.
- `addMarker`/`deleteMarker` stay; add `updateMarker(id, text)` → `PATCH`.

### Server (`server.py`)

- `MarkerStore.update(marker_id, text) -> dict | None` — find by id, set `text`,
  return the updated marker (id/ts/created preserved); `None` if not found.
- `do_PATCH` for `/api/markers?id=N`, body `{text}`:
  - `400` invalid JSON / empty text, `404` unknown id, `200` updated marker.
- No other server changes; zoom/pan is entirely client-side over loaded history.

## Testing

- **`tests/test_markers.py`** (extend, test-first): `MarkerStore.update` changes
  the text and preserves id/ts/created; unknown id returns `None`.
- **`PATCH /api/markers`** integration-tested with curl (update, empty→400,
  unknown→404), confirming the edited text appears in `/api/export`.
- **Browser (Playwright):** wheel/zoom and buttons change the x-scale; a frozen
  view survives a poll (does not snap back); Live resumes following; editing a
  marker changes its label and persists. Screenshot the zoomed + edited state.

## Out of scope (YAGNI)

- Per-chart independent windows (we chose synced).
- Y-axis zoom (time/x only).
- Saving the view window or fetching history beyond what is already retained.
