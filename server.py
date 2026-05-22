"""HTTP server + sampling thread for zmnMon.

Charts read a rolling history of lightweight per-sample aggregates. The full
per-connection list is only kept for the most recent sample (it is the only one
the live table needs), which keeps memory bounded over long runs.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import export
from collector import Sampler, TCP_STATES

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def _lite(sample: dict) -> dict:
    """A history-friendly copy without the (potentially large) connection list."""
    return {k: v for k, v in sample.items() if k != "connections"}


class SampleStore:
    """Thread-safe ring buffer of lite samples plus the latest full sample."""

    def __init__(self, maxlen: int):
        self._lock = threading.Lock()
        self._history: deque = deque(maxlen=maxlen)
        self._latest: dict | None = None

    def add(self, sample: dict) -> None:
        with self._lock:
            self._history.append(_lite(sample))
            self._latest = sample

    def since(self, ts: float) -> dict:
        with self._lock:
            samples = [s for s in self._history if s["ts"] > ts]
            return {"samples": samples, "latest": self._latest}


def _sampling_loop(sampler: Sampler, store: SampleStore, interval: float, stop: threading.Event):
    while not stop.is_set():
        start = time.time()
        try:
            store.add(sampler.sample())
        except Exception as exc:  # keep the thread alive across transient failures
            print(f"[zmnMon] sample error: {exc}")
        stop.wait(max(0.0, interval - (time.time() - start)))


def make_handler(store: SampleStore, meta: dict):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence per-request logging
            pass

        def _send(self, code, body: bytes, content_type: str):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj):
            self._send(200, json.dumps(obj).encode(), "application/json")

        def _export(self):
            data = store.since(0)
            body = export.build_report(meta, data["samples"], data["latest"]).encode()
            stamp = time.strftime("%Y%m%d-%H%M%S")
            filename = f"zmnmon-{meta.get('hostname', 'host')}-{stamp}.md"
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/" or path == "/index.html":
                return self._serve_static("index.html")
            if path == "/api/meta":
                return self._json(meta)
            if path == "/api/samples":
                qs = parse_qs(parsed.query)
                since = float(qs.get("since", ["0"])[0])
                return self._json(store.since(since))
            if path == "/api/export":
                return self._export()
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            self._send(404, b"not found", "text/plain")

        def _serve_static(self, rel: str):
            # Prevent path traversal; only serve files inside STATIC_DIR.
            safe = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if not safe.startswith(STATIC_DIR) or not os.path.isfile(safe):
                return self._send(404, b"not found", "text/plain")
            ext = os.path.splitext(safe)[1]
            with open(safe, "rb") as f:
                self._send(200, f.read(), _CONTENT_TYPES.get(ext, "application/octet-stream"))

    return Handler


def run(zm_host, proc_pattern, interval, port, history_seconds, sniffer=None):
    maxlen = max(1, int(history_seconds / max(interval, 0.1)))
    sampler = Sampler(proc_pattern=proc_pattern, zm_host=zm_host, sniffer=sniffer)
    store = SampleStore(maxlen=maxlen)
    meta = {
        "zm_host": zm_host,
        "proc_pattern": proc_pattern,
        "interval": interval,
        "history_seconds": history_seconds,
        "states": TCP_STATES,
        "sniffing": sniffer is not None,
        "hostname": os.uname().nodename,
        "platform": os.uname().sysname,
        "started": time.time(),
    }

    stop = threading.Event()
    t = threading.Thread(
        target=_sampling_loop, args=(sampler, store, interval, stop), daemon=True
    )
    t.start()

    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store, meta))
    print(f"[zmnMon] sampling every {interval}s, peer filter={zm_host or 'none'}")
    print(f"[zmnMon] dashboard: http://127.0.0.1:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[zmnMon] shutting down")
    finally:
        stop.set()
        httpd.server_close()
