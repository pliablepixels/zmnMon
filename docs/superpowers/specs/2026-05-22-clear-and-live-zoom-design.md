# Clear data + live-tracking zoom — design

**Date:** 2026-05-22
**Status:** Approved

Two changes bundled in one turn:

1. A **Clear** action that wipes graph data and markers.
2. **Zoom keeps tracking live**: zooming changes granularity but stays following
   the latest data; only panning freezes the view.

---

## 1. Clear graphs + markers

### Decisions
- Clear wipes **both** the collected samples and all markers.
- A **Clear** button lives in the nav toolbar with a **confirm** step.

### Server
- `MarkerStore.clear()` — empties all markers (`SampleStore.clear()` already exists).
- `POST /api/clear` — calls `store.clear()` and `markers.clear()`, returns
  `{"cleared": true}`.

### Frontend
- A **Clear** button in the nav toolbar. Clicking shows a small inline confirm
  popover ("Clear all graphs & markers?" → **Clear**; click-away cancels) so it
  is not a one-tap accident.
- On confirm: `POST /api/clear`, then reset client state — `samples=[]`,
  `latest=null`, `lastTs=0`, `markers=[]` — call `goLive()` and re-render. Data
  re-accumulates from the next poll.

---

## 2. Zoom keeps tracking live

### Current behavior (to change)
Zoom/pan set `viewMode="frozen"` with a fixed `{min,max}`, and `setData` uses
`resetScales = (viewMode === "live")`. Zooming therefore stops live tracking.

### New view-state model
Replace the binary live/frozen with:

- `follow` (bool) — does the window's right edge track the latest sample?
- `span` (number seconds, or `null` for the full data range) — the window width
  / granularity.
- `frozenWin` ({min,max} or `null`) — the fixed window used only when `!follow`.

### Effective window (`currentScale()`), given `bounds = dataBounds()`
- `span == null`  → `{min: bounds.min, max: bounds.max}` (full range).
- `follow`        → `{min: bounds.max - span, max: bounds.max}` (right-anchored,
  slides as new data arrives).
- `!follow`       → `frozenWin`.

Clamp to bounds; enforce a minimum span (≈2× interval).

### Behaviors
- **Zoom** (wheel / +/- buttons): compute a new span = effective span × factor,
  clamped to `[minSpan, dataSpan]`. If it reaches/exceeds the data span, set
  `span = null` (full). Stays in the current `follow` state:
  - following → window auto-becomes the last `span` seconds (right-anchored);
    cursor position is ignored (newest data is what you want live).
  - frozen → recompute `frozenWin` around the cursor/center at the new span.
- **Pan** (drag / back-forward buttons): `follow = false`; set `frozenWin` to the
  current window shifted by the delta (span preserved); clamp to bounds.
- **Live** button / double-click: `follow = true`, `frozenWin = null`; **keep
  `span`** so tracking resumes at the current granularity.

### Rendering
`upsert` always calls `setData(data, false)` (never let uPlot reset the scale),
then `applyScale()` sets every chart's x-scale to `currentScale()`. Because a
following window is recomputed from `bounds.max` each render, it slides with new
samples; a frozen window stays put. Direct user actions (zoom/pan/live) also call
`applyScale()` immediately.

### Nav status
- following, `span == null` → "Live — following"
- following, `span` set     → "Live — last {Ns} window"
- frozen                    → "Frozen: HH:MM:SS–HH:MM:SS"

Live button shows active styling whenever `follow` is true.

---

## Testing

- **`tests/test_markers.py`** (extend, test-first): `MarkerStore.clear()` empties
  the store.
- **`POST /api/clear`** integration (curl): add samples + markers, clear, confirm
  both empty.
- **Browser (Playwright):**
  - Clear: click → confirm → graphs and markers gone, status returns to Live.
  - Live zoom: while following, wheel-zoom in → window shrinks to a recent span
    AND still advances after a poll (max grows); status shows a "last Ns" window;
    pan → status goes Frozen and the window stops advancing; Live → resumes
    following at the same span.

## Out of scope (YAGNI)
- Per-chart spans (still synced).
- Persisting the view/granularity across reloads.
