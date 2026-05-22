"""Optional HTTP URL sniffer for zmnMon.

`ss`/`lsof` only expose IP:port. To learn which URL a socket was hitting we have
to read the HTTP request line from the packet payload, which means a packet
capture. This runs `tcpdump` against the ZoneMinder host and keeps a map of
local source port -> last HTTP request seen on it, so even a socket that has
since gone into CLOSE_WAIT (no live packets) still shows the URL it was serving.

Constraints:
- Requires root (raw capture). Run zmnMon with sudo, or grant tcpdump cap_net_raw.
- Plaintext HTTP only. HTTPS payloads are encrypted and yield nothing.
- IPv4 only (the #150 ZM server is IPv4 on :80).
"""
from __future__ import annotations

import re
import subprocess
import threading
import time
from typing import Optional

_IP_RE = re.compile(r"IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+):")
_REQ_RE = re.compile(r"^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) (\S+) HTTP/1\.[01]")
_HOST_RE = re.compile(r"^Host:\s*(\S+)", re.IGNORECASE)


class TcpdumpParser:
    """Line-fed state machine over `tcpdump -n -A` output.

    feed_line returns ("req", entry) when a request line is seen and
    ("host", entry) when the following Host header fills it in. The entry dict is
    the same object across both events, so a consumer that stores it on "req"
    sees the host appear in place.
    """

    def __init__(self):
        self._cur_lport: Optional[int] = None
        self._cur_entry: Optional[dict] = None

    def feed_line(self, line: str):
        m = _IP_RE.search(line)
        if m:
            # src is the client (we filter capture to dst == ZM host).
            self._cur_lport = int(m.group(2))
            return None
        m = _REQ_RE.match(line.strip())
        if m and self._cur_lport is not None:
            self._cur_entry = {
                "lport": self._cur_lport, "method": m.group(1),
                "path": m.group(2), "host": None,
            }
            return ("req", self._cur_entry)
        m = _HOST_RE.match(line.strip())
        if m and self._cur_entry is not None:
            self._cur_entry["host"] = m.group(1)
            return ("host", self._cur_entry)
        return None


def parse_tcpdump(output: str) -> list[dict]:
    """Parse a whole `tcpdump -n -A` capture into request entries (for tests)."""
    parser = TcpdumpParser()
    entries: list[dict] = []
    for line in output.splitlines():
        ev = parser.feed_line(line)
        if ev and ev[0] == "req":
            entries.append(ev[1])  # mutated in place if a Host line follows
    return entries


class Sniffer:
    def __init__(self, host: str, port: int = 80, iface: str = "any"):
        self.host = host
        self.port = port
        self.iface = iface
        self._map: dict[int, dict] = {}
        self._lock = threading.Lock()
        self._proc: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        bpf = f"tcp and dst host {self.host} and dst port {self.port}"
        cmd = ["tcpdump", "-i", self.iface, "-l", "-n", "-A", "-s", "0", bpf]
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        parser = TcpdumpParser()
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            ev = parser.feed_line(line)
            if not ev:
                continue
            _, entry = ev
            entry["ts"] = time.time()
            with self._lock:
                self._map[entry["lport"]] = entry

    def get(self, lport: Optional[int]) -> Optional[dict]:
        if lport is None:
            return None
        with self._lock:
            return self._map.get(lport)

    def stop(self) -> None:
        if self._proc:
            self._proc.terminate()
