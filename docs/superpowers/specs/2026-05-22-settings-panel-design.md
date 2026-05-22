# Settings panel — design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Let the user change monitoring settings from the dashboard instead of only via
CLI flags at startup. A gear button opens a settings popover covering the process
pattern, peer/ZM host, sample interval, history length, and the CLOSE_WAIT alert
thresholds.

## Settings and how each behaves

| Setting | Side | On apply |
|---|---|---|
| Process pattern (`proc`) | server | swap regex, **clear history**, reset churn baseline |
| Peer / ZM host (`zm_host`) | server | swap host (`""`→all), **clear history**, reset churn baseline |
| Sample interval (`interval`) | server | update loop cadence + **resize** buffer (keep data) |
| History length (`history_seconds`) | server | **resize** buffer (keep data) |
| CLOSE_WAIT warn / crit | client | update thresholds, re-render, persist to `localStorage` |

Rationale: filter settings change *what* is monitored, so mixing old/new data in
one series is misleading → clear. Timing settings change *how much* is retained;
the x-axis is time-based so differing cadence plots fine → keep and resize.
Thresholds are purely display and have no server state, so they live in the
browser and persist via `localStorage`.

## Components

### `collector.Sampler`

- `set_pattern(pattern: str)` — compile into a local first (an invalid regex
  raises `re.error` and leaves the sampler unchanged), then assign `self.proc_re`,
  store `self.proc_pattern`, and reset `self._prev_keys = None` (churn baseline).
- `set_zm_host(host: str | None)` — normalize `""`/falsy to `None`, assign
  `self.zm_host`, reset `self._prev_keys`.

`__init__` also stores `self.proc_pattern` so the current value is readable.

### `server.SampleStore`

- `clear()` — under the lock, empty `_history` and set `_latest = None`.
- `set_maxlen(n: int)` — under the lock, rebuild `_history` as
  `deque(self._history, maxlen=n)` (keeps the most recent `n`, drops oldest when
  shrinking).

### `server` runtime state

- `RunState` — a tiny holder `{interval: float, history_seconds: int}` shared
  between the sampling loop and the handler. The loop reads `state.interval` each
  cycle, so a change takes effect on the next tick.
- `maxlen(history_seconds, interval) = max(1, int(history_seconds / max(interval, 0.1)))`
  — the same formula `run()` already uses, extracted to a helper.

### Endpoint `POST /api/settings`

Handler gains references to `sampler` and `state` (passed from `run()`).

Body is JSON; any subset of `proc`, `zm_host`, `interval`, `history_seconds`.

1. Parse body → `400` if not valid JSON.
2. **Validate all provided fields before applying anything:**
   - `proc`: present → must be non-empty after trim and compile (`re.compile`);
     else `400` with the error.
   - `zm_host`: present → any string (trimmed); always valid.
   - `interval`: present → float, `>= 0.1`; else `400`.
   - `history_seconds`: present → int, `>= 1`; else `400`.
3. **Apply** (only fields that actually changed vs `meta`):
   - `proc` changed → `sampler.set_pattern(proc)`; mark filter-changed.
   - `zm_host` changed → `sampler.set_zm_host(host)`; mark filter-changed.
   - `interval` changed → `state.interval = interval`; resize needed.
   - `history_seconds` changed → `state.history_seconds = value`; resize needed.
   - filter-changed → `store.clear()`.
   - resize needed → `store.set_maxlen(maxlen(state.history_seconds, state.interval))`.
   - update the matching keys in `meta` (the same dict `/api/meta` serves).
4. Return `200` with the updated `meta`.

Thresholds are not part of this endpoint. The change is runtime-only; a restart
reverts to the CLI values (no server persistence).

### Frontend (`static/app.js`, `static/index.html`)

- A gear button (`#settings-btn`) in the header next to Export opens a settings
  popover (same popover pattern as markers).
- Fields prefilled from `meta`: process pattern, peer host (placeholder
  "all peers"), interval (s), history (s); plus CLOSE_WAIT warn and crit; an
  Apply button and an inline error line.
- `ALERT_CW_WARN` / `ALERT_CW_CRIT` become mutable `let` vars, initialized from
  `localStorage` (falling back to 3 / 8).
- On Apply:
  - Save thresholds locally (numeric, `warn <= crit`), persist to `localStorage`,
    re-render.
  - `POST /api/settings` with the four server fields.
  - `200`: replace `meta` with the response. If `interval` changed, reset the
    poll `setInterval`. If `proc` or `zm_host` changed, clear local
    `samples`/`latest` and reset `lastTs = 0` so the next poll refetches. Redraw,
    close popover.
  - `400`: show the returned message in the error line, keep the popover open.
- Markers are untouched by settings changes.

## Testing

- **`tests/test_collector.py`** (new): `set_pattern` changes which command lines
  match and resets the churn baseline; an invalid regex raises and leaves the
  previous pattern intact. `set_zm_host` updates the host and resets the baseline.
- **`tests/test_markers.py`** (extend): `SampleStore.clear()` empties history and
  latest; `set_maxlen()` keeps the most recent N and drops the oldest when
  shrinking.
- **`/api/settings`** integration-tested with curl: valid multi-field update,
  invalid regex → 400, invalid interval → 400, history shrink resizes, filter
  change clears samples.
- The gear popover apply-flow (success, validation error, history-clear) verified
  in a real browser.

## Out of scope (YAGNI)

- Persisting server settings across restarts.
- Changing the bind port at runtime.
- Toggling sniff/sniff-port/iface at runtime (needs root and a tcpdump restart).
