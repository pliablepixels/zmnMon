#!/usr/bin/env bash
# Launch zmnMon with HTTP sniffing against a peer host (needs root for tcpdump).
# Usage: ./start.sh [PEER_IP]   (defaults to 192.168.50.108)
set -euo pipefail
cd "$(dirname "$0")"
PEER="${1:-192.168.50.108}"
exec sudo python3 zmnmon.py --peer "$PEER" --sniff
