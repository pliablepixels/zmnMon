"""Parser tests using real output captured from zmNinjaNg issue #150 and macOS lsof.

Run: python3 -m unittest discover -s tests   (from the zmnMon root)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from collector import parse_ss, parse_lsof, parse_ps, count_states, normalize_state


# Linux `ss -tanp` output. The ESTAB rows are the healthy-baseline sockets from
# issue #150; the CLOSE-WAIT rows are the leaked sockets from the failure state.
SS_FIXTURE = """\
State      Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
ESTAB      0      0      192.168.183.3:40672 192.168.183.250:80 users:(("WebKitNetworkPr",pid=1614207,fd=28))
ESTAB      0      0      192.168.183.3:40678 192.168.183.250:80 users:(("WebKitNetworkPr",pid=1614207,fd=32))
CLOSE-WAIT 0      0      192.168.183.3:34100 192.168.183.250:80 users:(("WebKitNetworkPr",pid=1608060,fd=34))
CLOSE-WAIT 0      0      192.168.183.3:41496 192.168.183.250:80 users:(("WebKitNetworkPr",pid=1608060,fd=28))
CLOSE-WAIT 0      0      192.168.183.3:41882 192.168.183.250:80 users:(("WebKitNetworkPr",pid=1608060,fd=31))
TIME-WAIT  0      0      192.168.183.3:50000 192.168.183.250:80
LISTEN     0      128    127.0.0.1:631       0.0.0.0:*          users:(("cupsd",pid=900,fd=7))
"""

# macOS `lsof -nP -iTCP +c 0` output. Includes IPv4, IPv6, a LISTEN with no peer,
# and a multi-word COMMAND ("Google Chrome Helper") to exercise PID detection.
LSOF_FIXTURE = """\
COMMAND                      PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
com.apple.WebKit.Networking 57631 arjun   18u  IPv4 0x9d384cfe5ea0338d      0t0  TCP 192.168.1.3:63497->192.168.183.250:80 (ESTABLISHED)
com.apple.WebKit.Networking 57631 arjun   34u  IPv4 0x1111111111111111      0t0  TCP 192.168.1.3:34100->192.168.183.250:80 (CLOSE_WAIT)
node                         57496 arjun   16u  IPv6 0x8aa3486accb814a5      0t0  TCP [::1]:5173 (LISTEN)
target/debug/app             57523 arjun   42u  IPv6 0xf604f09c5addd7e0      0t0  TCP [::1]:63497->[::1]:5173 (ESTABLISHED)
Google Chrome Helper          5000 arjun   10u  IPv4 0xabcabcabcabcabca      0t0  TCP 192.168.1.3:55000->1.2.3.4:443 (ESTABLISHED)
"""

# Linux `ps -eo pid,ppid,%cpu,%mem,rss,nlwp,comm` (healthy snapshot from #150).
PS_LINUX_FIXTURE = """\
  PID  PPID %CPU %MEM    RSS NLWP COMMAND
1614194  6633  6.5  0.3 206556   47 app
1614207 1614194  7.1  0.0  56304   12 WebKitNetworkProcess
1614213 1614194 43.4  0.6 438028   22 WebKitWebProcess
"""

# macOS `ps -o pid,ppid,%cpu,%mem,rss,command` (no NLWP column).
PS_MACOS_FIXTURE = """\
  PID  PPID %CPU %MEM    RSS COMMAND
57523     1  0.1  0.2 160016 /Users/arjun/fiddle/zmNinjaNg/app/src-tauri/target/debug/app
57632     1  0.6  0.8 838832 /System/Library/Frameworks/WebKit.framework WebContent
"""


class TestNormalizeState(unittest.TestCase):
    def test_ss_tokens_map_to_canonical(self):
        self.assertEqual(normalize_state("ESTAB"), "ESTABLISHED")
        self.assertEqual(normalize_state("CLOSE-WAIT"), "CLOSE_WAIT")
        self.assertEqual(normalize_state("TIME-WAIT"), "TIME_WAIT")
        self.assertEqual(normalize_state("SYN-SENT"), "SYN_SENT")
        self.assertEqual(normalize_state("FIN-WAIT-1"), "FIN_WAIT_1")
        self.assertEqual(normalize_state("LAST-ACK"), "LAST_ACK")

    def test_lsof_tokens_pass_through(self):
        self.assertEqual(normalize_state("ESTABLISHED"), "ESTABLISHED")
        self.assertEqual(normalize_state("CLOSE_WAIT"), "CLOSE_WAIT")


class TestParseSs(unittest.TestCase):
    def setUp(self):
        self.conns = parse_ss(SS_FIXTURE)

    def test_row_count(self):
        self.assertEqual(len(self.conns), 7)

    def test_state_counts(self):
        counts = count_states(self.conns)
        self.assertEqual(counts["ESTABLISHED"], 2)
        self.assertEqual(counts["CLOSE_WAIT"], 3)
        self.assertEqual(counts["TIME_WAIT"], 1)
        self.assertEqual(counts["LISTEN"], 1)

    def test_close_wait_socket_details(self):
        cw = [c for c in self.conns if c["state"] == "CLOSE_WAIT"]
        self.assertEqual(len(cw), 3)
        first = cw[0]
        self.assertEqual(first["raddr"], "192.168.183.250")
        self.assertEqual(first["rport"], 80)
        self.assertEqual(first["laddr"], "192.168.183.3")
        self.assertEqual(first["lport"], 34100)
        self.assertEqual(first["pid"], 1608060)
        self.assertEqual(first["fd"], 34)
        self.assertEqual(first["proc"], "WebKitNetworkPr")

    def test_row_without_process_has_no_pid(self):
        tw = [c for c in self.conns if c["state"] == "TIME_WAIT"][0]
        self.assertIsNone(tw["pid"])
        self.assertIsNone(tw["proc"])

    def test_filter_by_peer_host(self):
        zm = [c for c in self.conns if c["raddr"] == "192.168.183.250"]
        self.assertEqual(len(zm), 6)  # 2 ESTAB + 3 CLOSE_WAIT + 1 TIME_WAIT


class TestParseLsof(unittest.TestCase):
    def setUp(self):
        self.conns = parse_lsof(LSOF_FIXTURE)

    def test_row_count(self):
        self.assertEqual(len(self.conns), 5)

    def test_state_counts(self):
        counts = count_states(self.conns)
        self.assertEqual(counts["ESTABLISHED"], 3)
        self.assertEqual(counts["CLOSE_WAIT"], 1)
        self.assertEqual(counts["LISTEN"], 1)

    def test_close_wait_socket_details(self):
        cw = [c for c in self.conns if c["state"] == "CLOSE_WAIT"][0]
        self.assertEqual(cw["pid"], 57631)
        self.assertEqual(cw["fd"], 34)
        self.assertEqual(cw["laddr"], "192.168.1.3")
        self.assertEqual(cw["lport"], 34100)
        self.assertEqual(cw["raddr"], "192.168.183.250")
        self.assertEqual(cw["rport"], 80)
        self.assertEqual(cw["proc"], "com.apple.WebKit.Networking")

    def test_ipv6_listen_has_no_peer(self):
        listen = [c for c in self.conns if c["state"] == "LISTEN"][0]
        self.assertEqual(listen["laddr"], "::1")
        self.assertEqual(listen["lport"], 5173)
        self.assertIsNone(listen["raddr"])
        self.assertIsNone(listen["rport"])

    def test_multiword_command_pid_detection(self):
        chrome = [c for c in self.conns if c["pid"] == 5000][0]
        self.assertEqual(chrome["proc"], "Google Chrome Helper")
        self.assertEqual(chrome["fd"], 10)
        self.assertEqual(chrome["rport"], 443)


class TestParsePs(unittest.TestCase):
    def test_linux_with_threads(self):
        procs = parse_ps(PS_LINUX_FIXTURE)
        web = procs[1614213]
        self.assertAlmostEqual(web["cpu"], 43.4)
        self.assertAlmostEqual(web["mem"], 0.6)
        self.assertEqual(web["rss_kb"], 438028)
        self.assertEqual(web["threads"], 22)
        self.assertEqual(web["name"], "WebKitWebProcess")

    def test_macos_without_threads(self):
        procs = parse_ps(PS_MACOS_FIXTURE)
        app = procs[57523]
        self.assertAlmostEqual(app["cpu"], 0.1)
        self.assertEqual(app["rss_kb"], 160016)
        self.assertIsNone(app["threads"])
        # command column may contain spaces/paths and must survive intact
        self.assertTrue(app["name"].endswith("target/debug/app"))


if __name__ == "__main__":
    unittest.main()
