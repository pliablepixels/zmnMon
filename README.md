# zmnMon

A live TCP-state and per-process CPU/memory monitor, built to debug the
zmNinjaNg WebKit socket leak
([ZoneMinder/zmNinjaNg#150](https://github.com/ZoneMinder/zmNinjaNg/issues/150)).

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
python3 zmnmon.py --zm-host 192.168.183.250
```

Then visit the dashboard at <http://127.0.0.1:8787/>.

`--zm-host` filters the ZM-only charts and the connection table to that peer.
You can run without it to monitor all matched processes.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--zm-host` | _none_ | ZoneMinder server IP; filters ZM-only charts/table and pulls in sockets to that host. |
| `--proc` | OS-specific regex | Regex matched against the full process command line. |
| `--interval` | `1.0` | Sample interval in seconds. |
| `--port` | `8787` | Dashboard port (bound to `127.0.0.1`). |
| `--history` | `7200` | History retained, in seconds (2h). |
| `--sniff` | off | Capture the HTTP URL each socket hits via `tcpdump` (needs `--zm-host`, root, plaintext HTTP). |
| `--sniff-port` | `80` | HTTP port to sniff. |
| `--sniff-iface` | `any` | Capture interface. |

The default `--proc` regex matches WebKit/tauri/app processes; override it to
watch something else:

```bash
python3 zmnmon.py --proc 'my-process-name'
```

### Sniffing HTTP requests (optional)

To capture which HTTP URL each socket is hitting (plaintext HTTP only), run as root:

```bash
sudo python3 zmnmon.py --zm-host 192.168.183.250 --sniff
```

## Settings

The CLI flags set the initial values, but the gear button (⚙) in the header opens
a settings panel to change them at runtime:

- **Process pattern** and **peer / ZM host** — change *what* is monitored.
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

All charts share one time axis and stay synced. To inspect granular timing or look
back in time:

- **Wheel** over a chart zooms in/out (centered on the cursor); **drag** pans
  through time.
- The toolbar above the charts has zoom in/out, back/forward, and a **Live**
  button.
- Navigating freezes the view at a fixed window while data keeps accumulating;
  **Live** (or double-clicking a chart) resumes following the latest samples.

Panning covers all retained history (it is already in the browser, so it is just
rescaling — no extra requests).

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
  `/api/settings`, and serves the static dashboard.
- `export.py` — builds the Markdown digest + raw report served by `/api/export`.
- `static/` — the dashboard UI ([uPlot](https://github.com/leeoniya/uPlot) charts).
- `zmnmon.py` — CLI entry point.
