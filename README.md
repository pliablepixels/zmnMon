# zmnMon

A live TCP-state and per-process CPU/memory monitor for hunting socket and
file-descriptor leaks.

It samples your processes once a second and serves a small web dashboard that
charts TCP connection states (e.g. `CLOSE_WAIT` growth) and per-process CPU and
memory over time, plus a live table of the current connections.

- **No dependencies** — Python 3 standard library only, no `pip install`.
- **No root needed** for your own processes (root is only required for `--sniff`).
- **Cross-platform** — Linux samples via `ss` / `ps` / `/proc`; macOS via `lsof` / `ps`.

## Requirements

- Python 3.8+
- Linux: `ss` and `ps` on `PATH`
- macOS: `lsof` and `ps` on `PATH`
- Optional (for `--sniff`): `tcpdump` and root

## Running

Run as the same user that owns the app you want to watch, then open the printed URL:

```bash
python3 zmnmon.py --proc 'my-app' --peer 192.168.183.250
```

Then visit the dashboard at <http://127.0.0.1:8787/>.

`--peer` filters the peer-only charts and the connection table to that remote
host. You can run without it to monitor all matched processes.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--proc` | OS-specific regex | Regex matched against the full process command line. |
| `--peer` | _none_ | Remote peer IP; filters the peer-only charts/table and pulls in connections to that host. |
| `--interval` | `1.0` | Sample interval in seconds. |
| `--port` | `8787` | Dashboard port (bound to `127.0.0.1`). |
| `--history` | `7200` | History retained, in seconds (2h). |
| `--sniff` | off | Capture the HTTP URL each socket hits via `tcpdump` (needs `--peer`, root, plaintext HTTP). |
| `--sniff-port` | `80` | HTTP port to sniff. |
| `--sniff-iface` | `any` | Capture interface. |

The default `--proc` regex matches common desktop-app frameworks
(WebKit/tauri/Electron/Chrome/`app`); override it to watch your own process:

```bash
python3 zmnmon.py --proc 'my-process-name'
```

These can also be changed at runtime from the Settings panel (see below).

### Sniffing HTTP requests (optional)

To capture which HTTP URL each socket is hitting (plaintext HTTP only), run as root:

```bash
sudo python3 zmnmon.py --peer 192.168.183.250 --sniff
```

Or use the convenience script (defaults to `192.168.50.108`, override with an IP):

```bash
./start.sh                # sudo python3 zmnmon.py --peer 192.168.50.108 --sniff
./start.sh 10.0.0.42      # use a different peer
```

## Settings

The CLI flags set the initial values, but the gear button (⚙) in the header opens
a settings panel to change them at runtime:

- **Process pattern** and **peer host** — change *what* is monitored.
  Applying them clears the collected history and resets the churn baseline so the
  charts restart cleanly under the new filter. An invalid regex is rejected with
  an inline error.
- **Sample interval** and **history length** — change *how* data is retained.
  These resize the buffer but keep existing data.
- **CLOSE_WAIT warn / critical** — the alert thresholds driving the header badge
  and the red chart shading. These are client-side and remembered across reloads
  (`localStorage`).

Server-side changes are runtime-only; a restart reverts to the CLI values.
Backed by `POST /api/settings`.

## Markers

Click any chart to drop a time-stamped note (e.g. "after entering event screen").
Type the note in the popover and press Enter. The marker shows as a vertical line
on **every** chart (they share one time axis), so you can line the note up against
CPU, sockets, CLOSE_WAIT, etc. Click an existing marker line to **edit or delete**
it. Markers are kept in memory (cleared on restart, like the samples) and are
included in the export. Backed by `POST` / `PATCH` / `DELETE /api/markers`.

## Navigating the charts

All charts share one time axis and stay synced. The toolbar above the charts has
zoom in/out, back/forward, **Live**, and **Clear**.

- **Wheel** (or the zoom buttons) changes the granularity. While following, you
  *stay* live — the window becomes the most recent slice (e.g. "last 30s") and
  keeps sliding as new data arrives. Zoom all the way out for the full range.
- **Drag** (or back/forward) pans through time and **freezes** the view at a
  fixed window so you can inspect history; new data keeps accumulating off-screen.
- **Live** (or double-clicking a chart) resumes following at the current
  granularity.
- **Clear** wipes the collected graph data and all markers (after a confirm) so
  you can start a fresh capture. Backed by `POST /api/clear`.

Panning covers all retained history (it is already in the browser, so it is just
rescaling — no extra requests).

### Layout

- **Resize a chart** by dragging its bottom-right corner (width and height). Each
  chart's size is remembered across reloads.
- **Collapse the connections sidebar** with the ◀ button in its header to give the
  charts more room; a thin strip on the left edge reopens it. The collapsed state
  is remembered too.
- **Reset layout** (in the gear settings panel) clears all remembered chart sizes
  and re-expands the sidebar.

## Exporting for analysis

Click **Export** in the dashboard header (or fetch `GET /api/export`) to download
a single self-contained Markdown file covering the run so far (up to `--history`).
It is meant to be handed straight to Claude for leak analysis. The file contains:

- a **digest** — per TCP state and per process, the first → last / min / max /
  delta and a growing-vs-stable trend, cumulative connection churn, and a
  "leak indicators" list calling out anything that grew steadily;
- the **raw** lite-sample time series plus the latest full connection list, so
  the details behind the digest are still available.

```bash
curl -OJ http://127.0.0.1:8787/api/export   # saves zmnmon-<host>-<timestamp>.md
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## How it works

- `collector.py` — samples TCP connection states and per-process CPU/memory.
- `sniffer.py` — optional `tcpdump`-based HTTP URL capture.
- `server.py` — sampling thread, an in-memory marker store, and a `http.server`
  that exposes `/api/samples`, `/api/meta`, `/api/export`, `/api/markers`,
  `/api/settings`, `/api/clear`, and serves the static dashboard.
- `export.py` — builds the Markdown digest + raw report served by `/api/export`.
- `static/` — the dashboard UI ([uPlot](https://github.com/leeoniya/uPlot) charts).
- `zmnmon.py` — CLI entry point.
