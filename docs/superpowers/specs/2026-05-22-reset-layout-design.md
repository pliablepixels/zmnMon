# Reset layout — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

A control to undo manual layout changes: clear all remembered chart sizes (panels
back to CSS defaults) and re-expand the sidebar.

## Decisions
- Resets **both** chart sizes and the sidebar collapse state.
- Lives in the **gear settings popover** (next to Apply), as a secondary button.

## Implementation (`static/app.js`, `static/index.html`)
- Add a secondary `#set-reset` button to the settings popover row.
- `resetLayout()`:
  - For each chart: clear the panel's inline `style.width/height` and
    `localStorage.removeItem("zmn.size.<id>")`. Panels revert to CSS defaults;
    each chart's `ResizeObserver` resizes the plot automatically.
  - `setSidebar(false)` to re-expand (persists `zmn.sidebar = "open"`).
  - Close the popover.
- Client-only; no server change.

## Testing
Browser (Playwright): resize a panel and collapse the sidebar, open settings →
Reset layout → the panel returns to default width and the sidebar expands; reload
confirms the remembered size is gone.

## Out of scope
- Resetting CLOSE_WAIT thresholds or other settings (those aren't "layout").
