"""Tests for runtime-adjustable Sampler settings.

Run: python3 -m unittest discover -s tests   (from the zmnMon root)
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collector import Sampler


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


class SetZmHostTests(unittest.TestCase):
    def test_sets_host(self):
        s = Sampler(proc_pattern="WebKit")
        s.set_zm_host("192.168.1.5")
        self.assertEqual(s.zm_host, "192.168.1.5")

    def test_empty_means_all_peers(self):
        s = Sampler(proc_pattern="WebKit", zm_host="192.168.1.5")
        s.set_zm_host("")
        self.assertIsNone(s.zm_host)

    def test_resets_churn_baseline(self):
        s = Sampler(proc_pattern="WebKit")
        s._prev_keys = {("a",)}
        s.set_zm_host("192.168.1.5")
        self.assertIsNone(s._prev_keys)


if __name__ == "__main__":
    unittest.main()
