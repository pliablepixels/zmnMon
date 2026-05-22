# Chart markers / annotations — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Let the user click any chart to drop a time-anchored note (e.g. "after entering
event screen"). The marker shows as a vertical line on every chart (all share
one time axis) and is included in the export so it can be handed to Claude.

## Decisions

- **Scope:** global. A marker is a point in time; its line is drawn on all charts.
- **Note entry:** inline popover at the click point (type, Enter to save, Esc to cancel).
- **Edit/delete:** add + delete. Clicking near an existing marker offers delete.
- **Persistence:** in-memory, same lifetime as the sample data. A restart clears
  both. Disk persistence is out of scope (YAGNI).

## Data model

```
marker = {"id": int, "ts": float, "text": str, "created": float}
```

- `id` — server-assigned, monotonically increasing from 1.
- `ts` — epoch seconds the user clicked (the annotated moment).
- `text` — the note (non-empty, trimmed).
- `created` — wall time the marker was added.

## Components

### `server.py`

**`MarkerStore`** — thread-safe, mirrors `SampleStore`:

- `add(ts: float, text: str) -> dict` — assigns next id, stores, returns the marker.
- `delete(marker_id: int) -> bool` — removes; returns whether something was removed.
- `all() -> list[dict]` — snapshot sorted by `ts`.

**Endpoints** (handler gains `do_POST` and `do_DELETE`; only `do_GET` exists today):

- `POST /api/markers` — JSON body `{ts, text}`.
  - `400` if body is not valid JSON, `ts` is missing/non-numeric, or `text` is
    empty after trimming.
  - `200` with the created marker otherwise.
- `DELETE /api/markers?id=N`.
  - `400` if `id` missing/non-integer.
  - `404` if no marker has that id.
  - `200` with `{"deleted": true}` otherwise.
- `GET /api/samples` response gains `"markers": [...]` (the full set every poll;
  they are few, so no incremental logic). Shape becomes
  `{"samples", "latest", "markers"}`.

`run()` constructs the `MarkerStore`, passes it to `make_handler`, and the
samples handler includes `markers.all()` in its response.

### `export.py`

`build_report(meta, samples, latest, markers=None)` — new trailing `markers`
argument defaulting to `None` (existing callers/tests unaffected).

- Adds a **`## Markers`** section directly after the header summary (before TCP
  states), so the user's annotations frame the rest of the report. One bullet per
  marker, sorted by `ts`: `- <ISO time> — <note>`. Empty/none → `- none added`.
- Markers are also emitted in the **Raw data** section as a fenced JSON block, so
  Claude has exact timestamps to line up against the time series.
- Placed before the early return for empty history, so markers show even if no
  samples were collected.

### Frontend (`static/app.js`, `static/index.html`)

- Module-level `markers` array, replaced from each poll response.
- **`markerPlugin`** — a draw hook (same shape as `shadePlugin`) that, for each
  marker, draws a vertical dashed line at `u.valToPos(ts, "x", true)` across the
  plot height in a distinct color (amber `#d29922`) with a small truncated label
  near the top. Reads the shared `markers` array, so every redraw reflects the
  current set.
- **Click handling** — on each chart's `u.over`:
  - Track mousedown→mouseup movement; if it moved more than a few px treat it as a
    drag (zoom) and ignore, so existing interactions still work.
  - Convert click x to a timestamp via `u.posToVal(left, "x")`.
  - If the click is within ~6px of an existing marker line → show a delete popover
    ("Delete: <note>?") → `DELETE /api/markers?id=N`.
  - Otherwise → show the note-entry popover → `POST /api/markers`.
  - Blank text or Esc cancels (no marker created).
- After a successful add/delete, update the local `markers` array and re-render
  immediately rather than waiting for the next poll.
- Small CSS for the popover (absolutely positioned input + buttons, matching the
  dark theme).

## Testing

- **`tests/test_export.py`**: Markers section renders the note text and a time;
  markers appear in the raw JSON; empty/omitted markers produce "none added";
  calling `build_report` without the `markers` arg still works (back-compat).
- **`tests/test_markers.py`** (new): `MarkerStore.add` returns a marker with a
  positive id and the given ts/text; ids increment; `all()` is sorted by ts;
  `delete` removes and returns True; deleting an unknown id returns False.
- The plugin, click handling, and popover are verified by running the dashboard
  in a browser — consistent with how live sampling is handled (not unit-tested).

## Out of scope (YAGNI)

- Editing/renaming a marker (delete + re-add instead).
- Disk persistence across restarts.
- Dragging markers to reposition.
