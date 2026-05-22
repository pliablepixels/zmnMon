"""Tests for the export report builder.

Run: python3 -m unittest discover -s tests   (from the zmnMon root)
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from export import series_stats, build_report


META = {
    "peer": "192.168.183.250",
    "proc_pattern": "WebKit|tauri",
    "interval": 1.0,
    "history_seconds": 7200,
    "states": ["ESTABLISHED", "CLOSE_WAIT", "TIME_WAIT"],
    "sniffing": False,
    "hostname": "myhost",
    "platform": "Linux",
    "started": 1_700_000_000.0,
}


def make_sample(ts, *, procs=None, tcp=None, churn=(0, 0)):
    return {
        "ts": ts,
        "processes": procs or [],
        "tcp_states": tcp or {},
        "peer_states": tcp or {},
        "churn": {"opened": churn[0], "closed": churn[1]},
    }


def proc(pid, name, *, fds=None, sockets=None, rss_kb=None, cpu=None, mem=None, threads=None):
    return {"pid": pid, "name": name, "cpu": cpu, "mem": mem, "rss_kb": rss_kb,
            "threads": threads, "fds": fds, "sockets": sockets}


class SeriesStatsTests(unittest.TestCase):
    def test_increasing_series_is_growing(self):
        s = series_stats([1, 2, 3, 4])
        self.assertEqual(s["first"], 1)
        self.assertEqual(s["last"], 4)
        self.assertEqual(s["min"], 1)
        self.assertEqual(s["max"], 4)
        self.assertEqual(s["delta"], 3)
        self.assertEqual(s["trend"], "growing")

    def test_flat_series_is_stable(self):
        s = series_stats([5, 5, 5])
        self.assertEqual(s["delta"], 0)
        self.assertEqual(s["trend"], "stable")

    def test_rise_then_recover_is_stable(self):
        # Peaked at 5 but ended at 2 (recovered) -> not a leak.
        s = series_stats([1, 5, 2])
        self.assertEqual(s["last"], 2)
        self.assertEqual(s["max"], 5)
        self.assertEqual(s["trend"], "stable")

    def test_none_values_are_ignored(self):
        s = series_stats([None, 2, None, 6])
        self.assertEqual(s["first"], 2)
        self.assertEqual(s["last"], 6)
        self.assertEqual(s["min"], 2)
        self.assertEqual(s["max"], 6)
        self.assertEqual(s["delta"], 4)
        self.assertEqual(s["trend"], "growing")

    def test_empty_series_is_stable_with_none_values(self):
        s = series_stats([])
        self.assertIsNone(s["first"])
        self.assertIsNone(s["last"])
        self.assertIsNone(s["delta"])
        self.assertEqual(s["trend"], "stable")

    def test_all_none_series(self):
        s = series_stats([None, None])
        self.assertIsNone(s["first"])
        self.assertEqual(s["trend"], "stable")


class BuildReportTests(unittest.TestCase):
    def test_header_has_host_and_sample_count(self):
        samples = [make_sample(100.0), make_sample(105.0), make_sample(110.0)]
        out = build_report(META, samples, samples[-1])
        self.assertIn("**Host:** myhost (Linux)", out)
        self.assertIn("**Samples:** 3", out)

    def test_growing_fds_listed_in_leak_indicators(self):
        samples = [
            make_sample(100.0, procs=[proc(100, "app", fds=10, sockets=3)]),
            make_sample(101.0, procs=[proc(100, "app", fds=20, sockets=5)]),
            make_sample(102.0, procs=[proc(100, "app", fds=30, sockets=9)]),
        ]
        out = build_report(META, samples, samples[-1])
        self.assertIn("pid 100", out)
        self.assertIn("## Leak indicators", out)
        # The indicators section should mention this process's fd growth.
        indicators = out.split("## Leak indicators", 1)[1]
        self.assertIn("pid 100", indicators)
        self.assertIn("growing", indicators)

    def test_flat_run_reports_no_leak_indicators(self):
        samples = [
            make_sample(100.0, procs=[proc(200, "calm", fds=5, sockets=2)],
                        tcp={"ESTABLISHED": 4}),
            make_sample(101.0, procs=[proc(200, "calm", fds=5, sockets=2)],
                        tcp={"ESTABLISHED": 4}),
        ]
        out = build_report(META, samples, samples[-1])
        indicators = out.split("## Leak indicators", 1)[1]
        self.assertIn("none detected", indicators)

    def test_close_wait_and_time_wait_always_present(self):
        samples = [make_sample(100.0, tcp={"ESTABLISHED": 2})]
        out = build_report(META, samples, samples[-1])
        self.assertIn("CLOSE_WAIT", out)
        self.assertIn("TIME_WAIT", out)

    def test_state_first_last_max_values(self):
        samples = [
            make_sample(100.0, tcp={"CLOSE_WAIT": 2}),
            make_sample(101.0, tcp={"CLOSE_WAIT": 5}),
            make_sample(102.0, tcp={"CLOSE_WAIT": 9}),
        ]
        out = build_report(META, samples, samples[-1])
        self.assertIn("| CLOSE_WAIT | 2 | 9 | 2 | 9 |", out)

    def test_churn_totals(self):
        samples = [
            make_sample(100.0, churn=(0, 0)),
            make_sample(101.0, churn=(3, 1)),
            make_sample(102.0, churn=(2, 1)),
        ]
        out = build_report(META, samples, samples[-1])
        self.assertIn("5 opened / 2 closed", out)

    def test_raw_section_includes_samples_and_connections(self):
        conns = [{"laddr": "10.0.0.1", "lport": 5000, "raddr": "192.168.183.250",
                  "rport": 80, "pid": 100, "fd": 7, "state": "CLOSE_WAIT"}]
        latest = make_sample(100.0, tcp={"CLOSE_WAIT": 1})
        latest["connections"] = conns
        out = build_report(META, [latest], latest)
        self.assertIn("## Raw data", out)
        self.assertIn('"ts"', out)
        self.assertIn("10.0.0.1", out)
        # The raw sample block must round-trip as JSON.
        block = out.split("```json", 1)[1].split("```", 1)[0]
        self.assertEqual(json.loads(block)[0]["ts"], 100.0)

    def test_empty_history_is_valid(self):
        out = build_report(META, [], None)
        self.assertIn("**Host:** myhost", out)
        self.assertIn("no samples", out.lower())


class MarkerReportTests(unittest.TestCase):
    MARKERS = [
        {"id": 1, "ts": 100.0, "text": "after entering event screen", "created": 100.5},
        {"id": 2, "ts": 102.0, "text": "left event screen", "created": 102.5},
    ]

    def _samples(self):
        return [make_sample(100.0, tcp={"CLOSE_WAIT": 1}),
                make_sample(102.0, tcp={"CLOSE_WAIT": 2})]

    def test_markers_section_lists_notes(self):
        out = build_report(META, self._samples(), None, self.MARKERS)
        self.assertIn("## Markers", out)
        self.assertIn("after entering event screen", out)
        self.assertIn("left event screen", out)

    def test_markers_section_precedes_tcp_states(self):
        out = build_report(META, self._samples(), None, self.MARKERS)
        self.assertLess(out.index("## Markers"), out.index("## TCP states"))

    def test_no_markers_shows_none_added(self):
        out = build_report(META, self._samples(), None, [])
        section = out.split("## Markers", 1)[1].split("##", 1)[0]
        self.assertIn("none added", section)

    def test_build_report_without_markers_arg_still_works(self):
        out = build_report(META, self._samples(), None)
        self.assertIn("## Markers", out)
        self.assertIn("none added", out.split("## Markers", 1)[1].split("##", 1)[0])

    def test_markers_present_with_empty_history(self):
        out = build_report(META, [], None, self.MARKERS)
        self.assertIn("after entering event screen", out)

    def test_markers_in_raw_json(self):
        out = build_report(META, self._samples(), None, self.MARKERS)
        block = out.split("Markers (raw):", 1)[1].split("```json", 1)[1].split("```", 1)[0]
        parsed = json.loads(block)
        self.assertEqual(parsed[0]["text"], "after entering event screen")


if __name__ == "__main__":
    unittest.main()
