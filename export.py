"""Build a single Markdown report (digest + raw data) from a monitoring run.

Pure functions over plain sample dicts (no I/O, no server deps) so they are
unit-testable. `build_report` is what the /api/export endpoint serves.
"""
from __future__ import annotations

import json
from datetime import datetime


def series_stats(values: list) -> dict:
    """Summarize a numeric time series, ignoring None entries.

    trend is "growing" when the series ends higher than it started and finishes
    near its peak (a still-climbing leak); otherwise "stable" (flat, or rose then
    recovered).
    """
    vals = [v for v in values if v is not None]
    if not vals:
        return {"first": None, "last": None, "min": None, "max": None,
                "delta": None, "trend": "stable"}
    first, last = vals[0], vals[-1]
    lo, hi = min(vals), max(vals)
    delta = last - first
    trend = "growing" if last > first and last >= hi * 0.9 else "stable"
    return {"first": first, "last": last, "min": lo, "max": hi,
            "delta": delta, "trend": trend}


def _n(v) -> str:
    return "-" if v is None else str(v)


def _sign(v) -> str:
    return "-" if v is None else f"{v:+g}"


def _fl(d: dict) -> str:
    """Render a series as 'first->last (peak)', or '-' if empty."""
    if d["first"] is None:
        return "-"
    return f"{d['first']}->{d['last']} ({d['max']})"


def _ordered_states(meta: dict, samples: list[dict]) -> list[str]:
    states = list(meta.get("states") or [])
    for forced in ("CLOSE_WAIT", "TIME_WAIT"):
        if forced not in states:
            states.append(forced)
    observed: set[str] = set()
    for s in samples:
        observed |= set(s.get("tcp_states") or {})
    for st in sorted(observed):
        if st not in states:
            states.append(st)
    return states


def _process_series(samples: list[dict]) -> tuple[list[int], dict[int, dict]]:
    """Collect per-pid value series in first-seen order."""
    order: list[int] = []
    by_pid: dict[int, dict] = {}
    for s in samples:
        for p in s.get("processes") or []:
            pid = p["pid"]
            if pid not in by_pid:
                by_pid[pid] = {"name": p.get("name"), "fds": [], "sockets": [],
                               "rss_kb": [], "cpu": []}
                order.append(pid)
            rec = by_pid[pid]
            rec["name"] = p.get("name") or rec["name"]
            for key in ("fds", "sockets", "rss_kb", "cpu"):
                rec[key].append(p.get(key))
    return order, by_pid


def build_report(meta: dict, samples: list[dict], latest: dict | None) -> str:
    lines: list[str] = ["# zmnMon report", ""]
    lines.append(f"- **Host:** {meta.get('hostname')} ({meta.get('platform')})")
    lines.append(f"- **ZM host:** {meta.get('zm_host') or 'none'}")
    lines.append(f"- **Process filter:** `{meta.get('proc_pattern')}`")
    lines.append(f"- **Interval:** {meta.get('interval')}s")
    if meta.get("started"):
        started = datetime.fromtimestamp(meta["started"]).isoformat(timespec="seconds")
        lines.append(f"- **Started:** {started}")
    lines.append(f"- **Samples:** {len(samples)}")

    if not samples:
        lines += ["", "_No samples collected._", ""]
        return "\n".join(lines) + "\n"

    duration = samples[-1]["ts"] - samples[0]["ts"]
    lines.append(f"- **Duration:** {duration:.1f}s")

    states = _ordered_states(meta, samples)
    state_stats = {
        st: series_stats([s.get("tcp_states", {}).get(st, 0) for s in samples])
        for st in states
    }

    lines += ["", "## TCP states", "",
              "| State | First | Last | Min | Max | Delta | Trend |",
              "|---|---|---|---|---|---|---|"]
    for st in states:
        d = state_stats[st]
        lines.append(
            f"| {st} | {_n(d['first'])} | {_n(d['last'])} | {_n(d['min'])} | "
            f"{_n(d['max'])} | {_sign(d['delta'])} | {d['trend']} |"
        )

    order, by_pid = _process_series(samples)
    lines += ["", "## Processes", "",
              "| PID | Name | fds first->last (peak) | sockets first->last (peak) "
              "| rss_kb peak | cpu max | trends |",
              "|---|---|---|---|---|---|---|"]
    proc_stats: dict[int, dict] = {}
    for pid in order:
        rec = by_pid[pid]
        f, so = series_stats(rec["fds"]), series_stats(rec["sockets"])
        r, c = series_stats(rec["rss_kb"]), series_stats(rec["cpu"])
        proc_stats[pid] = {"fds": f, "sockets": so, "rss_kb": r, "cpu": c}
        growing = [lbl for lbl, dd in (("fds", f), ("sockets", so), ("rss", r))
                   if dd["trend"] == "growing"]
        trends = ", ".join(f"{g} growing" for g in growing) or "stable"
        lines.append(
            f"| {pid} | {rec['name']} | {_fl(f)} | {_fl(so)} | {_n(r['max'])} | "
            f"{_n(c['max'])} | {trends} |"
        )

    opened = sum((s.get("churn") or {}).get("opened", 0) for s in samples)
    closed = sum((s.get("churn") or {}).get("closed", 0) for s in samples)
    lines += ["", "## Churn", "", f"- {opened} opened / {closed} closed (cumulative)"]

    lines += ["", "## Leak indicators", ""]
    indicators: list[str] = []
    for st in states:
        d = state_stats[st]
        if d["trend"] == "growing":
            indicators.append(f"- {st}: {d['first']} -> {d['last']} (growing)")
    for pid in order:
        rec, st = by_pid[pid], proc_stats[pid]
        for label in ("fds", "sockets", "rss_kb"):
            d = st[label]
            if d["trend"] == "growing":
                indicators.append(
                    f"- pid {pid} ({rec['name']}): {label} {d['first']} -> {d['last']} (growing)"
                )
    lines += indicators or ["- none detected"]

    conns = (latest or {}).get("connections") or []
    lines += ["", "## Raw data", "", "Lite samples (time series):", "",
              "```json", json.dumps(samples, separators=(",", ":")), "```",
              "", "Latest connections:", "",
              "```json", json.dumps(conns, separators=(",", ":")), "```"]

    return "\n".join(lines) + "\n"
