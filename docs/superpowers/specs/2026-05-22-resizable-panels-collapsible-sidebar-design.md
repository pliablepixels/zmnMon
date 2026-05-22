# Resizable chart panels + collapsible sidebar — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Let the user resize each chart panel (width and height) and have those sizes
remembered across reloads, and let the connections sidebar collapse to give the
charts more room.

## Decisions

- Resize **both** width and height per chart → move charts off the fixed grid.
- Sidebar collapses with a **thin re-open strip** on the left edge.
- Both panel sizes and the collapsed state persist in `localStorage`.

## Layout (charts) — `static/index.html`

- `main` changes from `display:grid` (2 columns) to `display:flex; flex-wrap:wrap;
  gap:12px; align-content:flex-start`, so panels flow and can take arbitrary widths.
- Chart panels (TCP states, CPU, memory, sockets, fds, churn) get a `resizable`
  marker class:
  - `resize: both; overflow: hidden;` → native bottom-right drag handle.
  - `display:flex; flex-direction:column;` → header/hint fixed, the `.chart` div
    `flex:1; min-height:0` fills the remaining space.
  - Default widths: the two wide panels (states, churn) span full width
    (`flex-basis:100%`); the four per-process panels default to ~half width
    (`width: calc(50% - 6px)`, `min-width` to stay usable) so they sit two per row.
- The nav toolbar (`#nav`) is **not** resizable.

## uPlot sizing — `static/app.js`

- Charts are created sized to their `.chart` div (`clientWidth × clientHeight`)
  rather than a fixed 200px height.
- Each chart gets a `ResizeObserver` on its panel that calls
  `u.setSize({width, height})` from the `.chart` div's content box whenever the
  panel changes size. The observer is stored on the chart record and
  `disconnect()`-ed when the chart is destroyed (label-set change), to avoid leaks.
- The old `window "resize"` handler (which set a fixed 200px height) is replaced by
  this per-panel observer.

## Persisting sizes

- Key per chart: `zmn.size.<chartId>` → `{w, h}` in pixels.
- A native resize sets the panel's **inline** `style.width/height`. The
  ResizeObserver persists the size **only when those inline styles are present**,
  so window/sidebar reflow (which does not set inline styles) never overwrites a
  saved size.
- On chart creation (`upsert`), saved sizes are applied to the panel
  (`style.width/height`) **before** the uPlot instance is created, so each window
  returns at the size it was left.

## Collapsible sidebar — `static/index.html` + `static/app.js`

- A collapse button (◀) in the connections sidebar header (`#conn-head`).
- A thin re-open strip/button (▶) on the left edge of `.layout`, shown only when
  collapsed.
- Toggling sets a `sidebar-collapsed` class on `.layout` (sidebar `display:none`,
  re-open strip visible) and persists `zmn.sidebar` = `"collapsed"` / `"open"`.
- Collapsing reclaims width for the charts automatically: the flex panels reflow
  wider and their ResizeObservers resize the plots. (Panels the user pinned to an
  explicit width stay that width.)
- On load, the saved sidebar state is applied before first render.

## Testing

Client-side layout only — verified in a real browser (Playwright):

- Resize a chart panel → the uPlot plot resizes to match; reload → the panel
  returns at the saved size.
- Collapse the sidebar → it hides, the re-open strip appears, charts widen;
  reload → still collapsed. Click the strip → sidebar returns.

No Python/unit tests (no server change, no pure logic).

## Out of scope (YAGNI)

- A "reset layout" button (clear the saved sizes) — can add later if wanted.
- Per-chart width on very narrow screens beyond the existing responsive stacking.
- Server-side persistence (sizes are a per-browser preference).
