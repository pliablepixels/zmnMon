"""HTTP server + sampling thread for zmnMon.

Charts read a rolling history of lightweight per-sample aggregates. The full
per-connection list is only kept for the most recent sample (it is the only one
the live table needs), which keeps memory bounded over long runs.
"""
from __future__ import annotations

import json
import os
import re
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

    def clear(self) -> None:
        with self._lock:
            self._history.clear()
            self._latest = None

    def set_maxlen(self, n: int) -> None:
        with self._lock:
            self._history = deque(self._history, maxlen=max(1, n))


class MarkerStore:
    """Thread-safe store of user annotations (time-anchored notes)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._markers: list[dict] = []
        self._next_id = 1

    def add(self, ts: float, text: str) -> dict:
        with self._lock:
            marker = {"id": self._next_id, "ts": float(ts), "text": text,
                      "created": time.time()}
            self._next_id += 1
            self._markers.append(marker)
            return dict(marker)

    def delete(self, marker_id: int) -> bool:
        with self._lock:
            for i, m in enumerate(self._markers):
                if m["id"] == marker_id:
                    del self._markers[i]
                    return True
            return False

    def update(self, marker_id: int, text: str) -> dict | None:
        with self._lock:
            for m in self._markers:
                if m["id"] == marker_id:
                    m["text"] = text
                    return dict(m)
            return None

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(m) for m in sorted(self._markers, key=lambda m: m["ts"])]


class RunState:
    """Mutable timing knobs shared by the sampling loop and the HTTP handler."""

    def __init__(self, interval: float, history_seconds: int):
        self.interval = interval
        self.history_seconds = history_seconds


def history_maxlen(history_seconds: float, interval: float) -> int:
    return max(1, int(history_seconds / max(interval, 0.1)))


def _sampling_loop(sampler: Sampler, store: SampleStore, state: RunState, stop: threading.Event):
    while not stop.is_set():
        start = time.time()
        try:
            store.add(sampler.sample())
        except Exception as exc:  # keep the thread alive across transient failures
            print(f"[zmnMon] sample error: {exc}")
        stop.wait(max(0.0, state.interval - (time.time() - start)))


def make_handler(store: SampleStore, meta: dict, markers: "MarkerStore",
                 sampler: Sampler, state: "RunState"):
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
            body = export.build_report(
                meta, data["samples"], data["latest"], markers.all()
            ).encode()
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
                payload = store.since(since)
                payload["markers"] = markers.all()
                return self._json(payload)
            if path == "/api/export":
                return self._export()
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            self._send(404, b"not found", "text/plain")

        def do_POST(self):
            path = urlparse(self.path).path
            if path == "/api/markers":
                return self._add_marker()
            if path == "/api/settings":
                return self._update_settings()
            return self._send(404, b"not found", "text/plain")

        def _add_marker(self):
            body = self._read_json()
            if body is None:
                return self._send(400, b"invalid JSON body", "text/plain")
            text = str(body.get("text", "")).strip()
            try:
                ts = float(body["ts"])
            except (KeyError, TypeError, ValueError):
                return self._send(400, b"ts must be a number", "text/plain")
            if not text:
                return self._send(400, b"text must not be empty", "text/plain")
            return self._json(markers.add(ts, text))

        def _update_settings(self):
            body = self._read_json()
            if body is None:
                return self._send(400, b"invalid JSON body", "text/plain")
            # Validate every provided field before applying any of them.
            proc = peer = interval = history = None
            if "proc" in body:
                proc = str(body["proc"]).strip()
                if not proc:
                    return self._send(400, b"process pattern must not be empty", "text/plain")
                try:
                    re.compile(proc)
                except re.error as exc:
                    return self._send(400, f"invalid regex: {exc}".encode(), "text/plain")
            if "peer" in body:
                peer = str(body["peer"]).strip() or None
            if "interval" in body:
                try:
                    interval = float(body["interval"])
                except (TypeError, ValueError):
                    return self._send(400, b"interval must be a number", "text/plain")
                if interval < 0.1:
                    return self._send(400, b"interval must be >= 0.1", "text/plain")
            if "history_seconds" in body:
                try:
                    history = int(body["history_seconds"])
                except (TypeError, ValueError):
                    return self._send(400, b"history_seconds must be an integer", "text/plain")
                if history < 1:
                    return self._send(400, b"history_seconds must be >= 1", "text/plain")

            # Apply only what actually changed.
            cleared = resized = False
            if proc is not None and proc != meta["proc_pattern"]:
                sampler.set_pattern(proc)
                meta["proc_pattern"] = proc
                cleared = True
            if "peer" in body and peer != meta["peer"]:
                sampler.set_peer(peer)
                meta["peer"] = peer
                cleared = True
            if interval is not None and interval != meta["interval"]:
                state.interval = interval
                meta["interval"] = interval
                resized = True
            if history is not None and history != meta["history_seconds"]:
                state.history_seconds = history
                meta["history_seconds"] = history
                resized = True

            if cleared:
                store.clear()
            if resized:
                store.set_maxlen(history_maxlen(state.history_seconds, state.interval))
            return self._json(meta)

        def do_DELETE(self):
            parsed = urlparse(self.path)
            if parsed.path != "/api/markers":
                return self._send(404, b"not found", "text/plain")
            try:
                marker_id = int(parse_qs(parsed.query).get("id", [""])[0])
            except ValueError:
                return self._send(400, b"id must be an integer", "text/plain")
            if markers.delete(marker_id):
                return self._json({"deleted": True})
            return self._send(404, b"no such marker", "text/plain")

        def do_PATCH(self):
            parsed = urlparse(self.path)
            if parsed.path != "/api/markers":
                return self._send(404, b"not found", "text/plain")
            try:
                marker_id = int(parse_qs(parsed.query).get("id", [""])[0])
            except ValueError:
                return self._send(400, b"id must be an integer", "text/plain")
            body = self._read_json()
            if body is None:
                return self._send(400, b"invalid JSON body", "text/plain")
            text = str(body.get("text", "")).strip()
            if not text:
                return self._send(400, b"text must not be empty", "text/plain")
            updated = markers.update(marker_id, text)
            if updated is None:
                return self._send(404, b"no such marker", "text/plain")
            return self._json(updated)

        def _read_json(self):
            try:
                length = int(self.headers.get("Content-Length", 0))
                return json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return None

        def _serve_static(self, rel: str):
            # Prevent path traversal; only serve files inside STATIC_DIR.
            safe = os.path.normpath(os.path.join(STATIC_DIR, rel))
            if not safe.startswith(STATIC_DIR) or not os.path.isfile(safe):
                return self._send(404, b"not found", "text/plain")
            ext = os.path.splitext(safe)[1]
            with open(safe, "rb") as f:
                self._send(200, f.read(), _CONTENT_TYPES.get(ext, "application/octet-stream"))

    return Handler


def run(peer, proc_pattern, interval, port, history_seconds, sniffer=None):
    sampler = Sampler(proc_pattern=proc_pattern, peer=peer, sniffer=sniffer)
    store = SampleStore(maxlen=history_maxlen(history_seconds, interval))
    markers = MarkerStore()
    state = RunState(interval=interval, history_seconds=history_seconds)
    meta = {
        "peer": peer,
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
        target=_sampling_loop, args=(sampler, store, state, stop), daemon=True
    )
    t.start()

    httpd = ThreadingHTTPServer(
        ("127.0.0.1", port), make_handler(store, meta, markers, sampler, state)
    )
    print(f"[zmnMon] sampling every {interval}s, peer filter={peer or 'none'}")
    print(f"[zmnMon] dashboard: http://127.0.0.1:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[zmnMon] shutting down")
    finally:
        stop.set()
        httpd.server_close()
