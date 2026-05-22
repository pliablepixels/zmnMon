#!/usr/bin/env python3
"""zmnMon: live TCP-state and per-process CPU/memory monitor for debugging the
zmNinjaNg WebKit socket leak (https://github.com/ZoneMinder/zmNinjaNg/issues/150).

Run it as the same user that owns the app, then open the printed URL.

  python3 zmnmon.py --zm-host 192.168.183.250

Linux samples via `ss`/`ps`/`/proc`; macOS via `lsof`/`ps`. No root needed for
your own processes; no pip install (standard library only).
"""
import argparse
import os
import platform
import sys

import server
from collector import DEFAULT_PROC_RE


def main():
    default_proc = DEFAULT_PROC_RE.get(platform.system(), DEFAULT_PROC_RE["Linux"])
    p = argparse.ArgumentParser(description="zmNinjaNg socket/memory monitor")
    p.add_argument("--zm-host", default=None,
                   help="ZoneMinder server IP. Filters the ZM-only charts and the "
                        "connection table, and pulls in tauri-plugin-http sockets to "
                        "that host even if not owned by a matched process.")
    p.add_argument("--proc", default=default_proc, dest="proc_pattern",
                   help=f"Regex matched against full process command line "
                        f"(default for this OS: {default_proc!r})")
    p.add_argument("--interval", type=float, default=1.0, help="Sample interval seconds (default 1)")
    p.add_argument("--port", type=int, default=8787, help="Dashboard port (default 8787)")
    p.add_argument("--history", type=int, default=7200, dest="history_seconds",
                   help="History retained in seconds (default 7200 = 2h)")
    p.add_argument("--sniff", action="store_true",
                   help="Capture the HTTP URL each socket is hitting via tcpdump "
                        "(needs --zm-host, root, and plaintext HTTP).")
    p.add_argument("--sniff-port", type=int, default=80, help="HTTP port to sniff (default 80)")
    p.add_argument("--sniff-iface", default="any", help="Capture interface (default 'any')")
    args = p.parse_args()

    sniffer = None
    if args.sniff:
        if not args.zm_host:
            p.error("--sniff requires --zm-host")
        if os.geteuid() != 0:
            print("[zmnMon] warning: --sniff needs root for tcpdump; run with sudo.", file=sys.stderr)
        from sniffer import Sniffer
        sniffer = Sniffer(host=args.zm_host, port=args.sniff_port, iface=args.sniff_iface)
        sniffer.start()
        print(f"[zmnMon] sniffing HTTP to {args.zm_host}:{args.sniff_port} on {args.sniff_iface}")

    server.run(
        zm_host=args.zm_host,
        proc_pattern=args.proc_pattern,
        interval=args.interval,
        port=args.port,
        history_seconds=args.history_seconds,
        sniffer=sniffer,
    )


if __name__ == "__main__":
    main()
