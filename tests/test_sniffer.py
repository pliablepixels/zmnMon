"""Tests for the tcpdump HTTP request parser.

Fixtures mimic `tcpdump -n -A` output for the nph-zms stream and the
tauri-plugin-http control request described in issue #150, including an `-i any`
header line (which carries an interface + direction before "IP").
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sniffer import parse_tcpdump, TcpdumpParser

TCPDUMP_FIXTURE = """\
13:45:01.123456 IP 192.168.183.3.41882 > 192.168.183.250.80: Flags [P.], seq 1:200, ack 1, win 502, length 199
E..xxxxx........
GET /zm/cgi-bin/nph-zms?monitor=19&mode=single&scale=100&maxfps=10&connkey=95765&_t=1779057914732 HTTP/1.1
Host: 192.168.183.250
User-Agent: Mozilla/5.0 AppleWebKit/605.1.15
Accept: */*

13:45:02.000000 eth0  Out IP 192.168.183.3.41883 > 192.168.183.250.80: Flags [P.], seq 1:150, ack 1, win 502, length 149
E..yyyyy........
GET /zm/index.php?command=17&connkey=95765&view=request&request=stream HTTP/1.1
Host: 192.168.183.250
User-Agent: tauri-plugin-http/2.5.9
"""


class TestParseTcpdump(unittest.TestCase):
    def setUp(self):
        self.entries = parse_tcpdump(TCPDUMP_FIXTURE)

    def test_two_requests(self):
        self.assertEqual(len(self.entries), 2)

    def test_nph_zms_request_mapped_to_local_port(self):
        e = self.entries[0]
        self.assertEqual(e["lport"], 41882)
        self.assertEqual(e["method"], "GET")
        self.assertIn("nph-zms", e["path"])
        self.assertIn("monitor=19", e["path"])
        self.assertEqual(e["host"], "192.168.183.250")

    def test_tauri_control_request_with_iface_header(self):
        e = self.entries[1]
        self.assertEqual(e["lport"], 41883)  # parsed despite "eth0  Out" prefix
        self.assertIn("command=17", e["path"])
        self.assertEqual(e["host"], "192.168.183.250")

    def test_host_fills_in_after_request_line(self):
        # Streaming: the request entry is emitted before its Host line arrives,
        # and must be back-filled in place.
        p = TcpdumpParser()
        self.assertIsNone(p.feed_line("13:45:01 IP 10.0.0.2.5000 > 10.0.0.9.80: Flags [P.]"))
        ev = p.feed_line("GET /a HTTP/1.1")
        self.assertEqual(ev[0], "req")
        entry = ev[1]
        self.assertIsNone(entry["host"])
        ev2 = p.feed_line("Host: example")
        self.assertEqual(ev2[0], "host")
        self.assertEqual(entry["host"], "example")  # same object, filled in

    def test_request_without_preceding_ip_is_ignored(self):
        p = TcpdumpParser()
        self.assertIsNone(p.feed_line("GET /orphan HTTP/1.1"))


if __name__ == "__main__":
    unittest.main()
