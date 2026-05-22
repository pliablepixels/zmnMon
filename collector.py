"""Process and TCP socket sampling for zmnMon.

Pure parsers (parse_ss, parse_lsof, parse_ps) turn raw command output into a
normalized list of connection / process dicts. sample() runs the right commands
for the current platform and returns one Sample.

A connection dict:
    {state, laddr, lport, raddr, rport, proc, pid, fd}

A process dict (keyed by pid):
    {cpu, mem, rss_kb, threads, name}

Sockets are visible without root as long as zmnMon runs as the same user that
owns the app processes.
"""
from __future__ import annotations

import os
import platform
import re
import subprocess
import time
from typing import Optional

# Canonical TCP states we chart. CLOSE_WAIT is the leak signal in issue #150.
TCP_STATES = [
    "ESTABLISHED",
    "CLOSE_WAIT",
    "TIME_WAIT",
    "SYN_SENT",
    "SYN_RECV",
    "FIN_WAIT_1",
    "FIN_WAIT_2",
    "LAST_ACK",
    "CLOSING",
    "LISTEN",
]

# Default process-name regex per platform. Override with --proc.
DEFAULT_PROC_RE = {
    "Linux": r"WebKit|tauri|(^|/)app($|\s)|nph-zms",
    "Darwin": r"WebKit|tauri|target/.*/app|(^|/)app($|\s)",
}


def normalize_state(token: str) -> str:
    """Map an ss or lsof state token to a canonical name (hyphens -> underscores)."""
    t = token.strip().upper()
    if t == "ESTAB":
        return "ESTABLISHED"
    return t.replace("-", "_")


def _split_host_port(s: str) -> tuple[Optional[str], Optional[int]]:
    """Parse 'host:port', '[ipv6]:port', or '*:port' into (host, port)."""
    s = s.strip()
    if not s or s in ("*:*", "*"):
        return None, None
    if s.startswith("["):
        host, _, port = s[1:].partition("]:")
    else:
        host, _, port = s.rpartition(":")
    host = host if host not in ("*", "") else None
    try:
        return host, int(port)
    except ValueError:
        return host, None


_SS_USER_RE = re.compile(r'\("([^"]+)",pid=(\d+),fd=(\d+)\)')


def parse_ss(output: str) -> list[dict]:
    """Parse `ss -tanp` output (Linux)."""
    conns: list[dict] = []
    for line in output.splitlines():
        if not line.strip() or line.startswith("State"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        state = normalize_state(parts[0])
        laddr, lport = _split_host_port(parts[3])
        raddr, rport = _split_host_port(parts[4])
        proc = pid = fd = None
        if len(parts) > 5:
            m = _SS_USER_RE.search(" ".join(parts[5:]))
            if m:
                proc, pid, fd = m.group(1), int(m.group(2)), int(m.group(3))
        conns.append({
            "state": state, "laddr": laddr, "lport": lport,
            "raddr": raddr, "rport": rport, "proc": proc, "pid": pid, "fd": fd,
        })
    return conns


_LSOF_STATE_RE = re.compile(r"\(([A-Z_]+)\)\s*$")


def parse_lsof(output: str) -> list[dict]:
    """Parse `lsof -nP -iTCP +c 0` output (macOS). COMMAND may contain spaces."""
    conns: list[dict] = []
    for line in output.splitlines():
        if not line.strip() or line.startswith("COMMAND"):
            continue
        m_state = _LSOF_STATE_RE.search(line)
        if not m_state:
            continue  # TCP row with no state (skip)
        state = normalize_state(m_state.group(1))
        toks = line.split()
        # PID is the first all-digit token; everything before it is the command.
        pid_idx = next((i for i, t in enumerate(toks) if t.isdigit()), None)
        if pid_idx is None:
            continue
        proc = " ".join(toks[:pid_idx])
        pid = int(toks[pid_idx])
        fd_field = toks[pid_idx + 2] if len(toks) > pid_idx + 2 else ""
        m_fd = re.match(r"(\d+)", fd_field)
        fd = int(m_fd.group(1)) if m_fd else None
        # Address is the token immediately before the trailing "(STATE)".
        addr = toks[-2]
        local, _, peer = addr.partition("->")
        laddr, lport = _split_host_port(local)
        raddr, rport = _split_host_port(peer) if peer else (None, None)
        conns.append({
            "state": state, "laddr": laddr, "lport": lport,
            "raddr": raddr, "rport": rport, "proc": proc, "pid": pid, "fd": fd,
        })
    return conns


def parse_ps(output: str) -> dict[int, dict]:
    """Parse `ps` output. Header drives column mapping; last column is the command.

    Recognized headers: PID, %CPU, %MEM, RSS, NLWP (threads). Missing columns -> None.
    """
    lines = [ln for ln in output.splitlines() if ln.strip()]
    if not lines:
        return {}
    header = lines[0].split()
    idx = {name: i for i, name in enumerate(header)}
    ncols = len(header)
    procs: dict[int, dict] = {}
    for line in lines[1:]:
        toks = line.split()
        if len(toks) < ncols:
            continue
        fixed = toks[: ncols - 1]
        name = " ".join(toks[ncols - 1:])

        def num(col, cast):
            if col in idx and idx[col] < len(fixed):
                try:
                    return cast(fixed[idx[col]])
                except ValueError:
                    return None
            return None

        pid = num("PID", int)
        if pid is None:
            continue
        procs[pid] = {
            "cpu": num("%CPU", float),
            "mem": num("%MEM", float),
            "rss_kb": num("RSS", int),
            "threads": num("NLWP", int),
            "name": name,
        }
    return procs


def count_states(conns: list[dict]) -> dict[str, int]:
    """Count connections per canonical state."""
    counts: dict[str, int] = {}
    for c in conns:
        counts[c["state"]] = counts.get(c["state"], 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Live sampling (not unit-tested; verified by running against the real app)
# ---------------------------------------------------------------------------

def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=10
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return ""


def _discover_pids(proc_re: re.Pattern) -> dict[int, str]:
    """Return {pid: full_command} for processes matching proc_re (by full args)."""
    out = _run(["ps", "-eo", "pid=,args="])
    me = os.getpid()
    found: dict[int, str] = {}
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_str, _, args = line.partition(" ")
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        # Skip our own process: the --proc pattern appears in our command line.
        if pid == me:
            continue
        if proc_re.search(args):
            found[pid] = args.strip()
    return found


def _fd_count(pid: int) -> Optional[int]:
    try:
        return len(os.listdir(f"/proc/{pid}/fd"))
    except OSError:
        return None


def _collect_connections() -> list[dict]:
    if platform.system() == "Linux":
        return parse_ss(_run(["ss", "-tanp"]))
    return parse_lsof(_run(["lsof", "-nP", "-iTCP", "+c", "0"]))


def _collect_process_stats(pids: list[int]) -> dict[int, dict]:
    if not pids:
        return {}
    if platform.system() == "Linux":
        out = _run(["ps", "-o", "pid,ppid,%cpu,%mem,rss,nlwp,comm",
                    "-p", ",".join(map(str, pids))])
    else:
        out = _run(["ps", "-o", "pid,ppid,%cpu,%mem,rss,comm",
                    "-p", ",".join(map(str, pids))])
    return parse_ps(out)


class Sampler:
    """Stateful sampler. Holds the previous connection set to compute churn."""

    def __init__(self, proc_pattern: str, zm_host: Optional[str] = None, sniffer=None):
        self.proc_re = re.compile(proc_pattern)
        self.zm_host = zm_host
        self.sniffer = sniffer  # optional sniffer.Sniffer: maps local port -> URL
        self._prev_keys: Optional[set] = None

    @staticmethod
    def _conn_key(c: dict) -> tuple:
        return (c["laddr"], c["lport"], c["raddr"], c["rport"], c["pid"], c["fd"])

    def sample(self) -> dict:
        ts = time.time()
        pids = _discover_pids(self.proc_re)
        all_conns = _collect_connections()

        # Keep connections owned by a matched process, or (if a ZM host is given)
        # any connection whose peer is that host. The latter catches the
        # tauri-plugin-http control path described in issue #150.
        def keep(c):
            if c["pid"] in pids:
                return True
            if self.zm_host and c["raddr"] == self.zm_host:
                return True
            return False

        conns = [c for c in all_conns if keep(c)]
        for c in conns:
            if c["pid"] in pids and not c.get("proc"):
                c["proc"] = pids[c["pid"]].split("/")[-1][:30]
            c["request"] = self.sniffer.get(c["lport"]) if self.sniffer else None

        stats = _collect_process_stats(list(pids))
        # Count sockets owned per pid from the connection list.
        sock_by_pid: dict[int, int] = {}
        for c in all_conns:
            if c["pid"] in pids:
                sock_by_pid[c["pid"]] = sock_by_pid.get(c["pid"], 0) + 1

        processes = []
        for pid, args in pids.items():
            st = stats.get(pid, {})
            processes.append({
                "pid": pid,
                "name": st.get("name") or args.split("/")[-1][:30],
                "cpu": st.get("cpu"),
                "mem": st.get("mem"),
                "rss_kb": st.get("rss_kb"),
                "threads": st.get("threads"),
                "fds": _fd_count(pid),
                "sockets": sock_by_pid.get(pid, 0),
            })
        processes.sort(key=lambda p: p["name"])

        zm_conns = (
            [c for c in conns if c["raddr"] == self.zm_host] if self.zm_host else conns
        )

        keys = {self._conn_key(c) for c in conns}
        if self._prev_keys is None:
            churn = {"opened": 0, "closed": 0}
        else:
            churn = {
                "opened": len(keys - self._prev_keys),
                "closed": len(self._prev_keys - keys),
            }
        self._prev_keys = keys

        return {
            "ts": ts,
            "processes": processes,
            "tcp_states": count_states(conns),
            "zm_states": count_states(zm_conns),
            "connections": conns,
            "churn": churn,
        }
