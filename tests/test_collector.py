"""Tests for runtime-adjustable Sampler settings.

Run: python3 -m unittest discover -s tests   (from the zmnMon root)
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collector import Sampler, parse_fd_limit, DEFAULT_PROC_RE


class DefaultPatternTests(unittest.TestCase):
    """The default --proc should target the app (Tauri/WebKit), not unrelated browsers."""

    def _re(self, osname):
        return re.compile(DEFAULT_PROC_RE[osname])

    def test_matches_tauri_app(self):
        path = "/Users/x/zmNinjaNg/app/src-tauri/target/debug/app"
        self.assertTrue(self._re("Darwin").search(path))
        self.assertTrue(self._re("Linux").search(path))

    def test_does_not_match_google_chrome(self):
        chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        self.assertIsNone(self._re("Darwin").search(chrome))
        self.assertIsNone(self._re("Linux").search(chrome))

    def test_does_not_match_spotify_or_electron(self):
        for path in ("/Applications/Spotify.app/Contents/MacOS/Spotify",
                     "/Applications/Claude.app/Contents/Frameworks/Electron Framework.framework/X"):
            self.assertIsNone(self._re("Darwin").search(path), path)


# A trimmed real `/proc/<pid>/limits`.
LIMITS_FIXTURE = """\
Limit                     Soft Limit           Hard Limit           Units
Max cpu time              unlimited            unlimited            seconds
Max file size             unlimited            unlimited            bytes
Max open files            1024                 4096                 files
Max locked memory         8388608              8388608              bytes
"""


class FdLimitTests(unittest.TestCase):
    def test_returns_soft_limit(self):
        self.assertEqual(parse_fd_limit(LIMITS_FIXTURE), 1024)

    def test_unlimited_returns_none(self):
        text = "Max open files            unlimited            unlimited            files\n"
        self.assertIsNone(parse_fd_limit(text))

    def test_missing_line_returns_none(self):
        self.assertIsNone(parse_fd_limit("Limit  Soft  Hard\nMax cpu time  unlimited\n"))


class SetPatternTests(unittest.TestCase):
    def test_changes_which_commands_match(self):
        s = Sampler(proc_pattern="WebKit")
        self.assertFalse(s.proc_re.search("/usr/bin/firefox"))  # sanity: not matched yet
        s.set_pattern("firefox")
        self.assertTrue(s.proc_re.search("/usr/bin/firefox"))
        self.assertFalse(s.proc_re.search("WebKitNetworkProcess"))
        self.assertEqual(s.proc_pattern, "firefox")

    def test_resets_churn_baseline(self):
        s = Sampler(proc_pattern="WebKit")
        s._prev_keys = {("a",)}
        s.set_pattern("firefox")
        self.assertIsNone(s._prev_keys)

    def test_invalid_regex_raises_and_keeps_previous(self):
        s = Sampler(proc_pattern="WebKit")
        with self.assertRaises(re.error):
            s.set_pattern("(")
        self.assertEqual(s.proc_pattern, "WebKit")
        self.assertTrue(s.proc_re.search("WebKitNetworkProcess"))


class SetPeerTests(unittest.TestCase):
    def test_sets_peer(self):
        s = Sampler(proc_pattern="WebKit")
        s.set_peer("192.168.1.5")
        self.assertEqual(s.peer, "192.168.1.5")

    def test_empty_means_all_peers(self):
        s = Sampler(proc_pattern="WebKit", peer="192.168.1.5")
        s.set_peer("")
        self.assertIsNone(s.peer)

    def test_resets_churn_baseline(self):
        s = Sampler(proc_pattern="WebKit")
        s._prev_keys = {("a",)}
        s.set_peer("192.168.1.5")
        self.assertIsNone(s._prev_keys)


if __name__ == "__main__":
    unittest.main()
