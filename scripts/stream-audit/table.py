#!/usr/bin/env python3
"""table.py <analyze.json> [...]: one markdown row per phase from analyze.py's JSON."""
import json
import sys

rows = []
for path in sys.argv[1:]:
    rows += json.load(open(path))

print('| Phase | Received layer | Enc fps (top) | Mb/s (rx layer) | Decoded/s | Uploaded/s | Unique on screen/s | Of layer on screen | Gap p95 / max ms | Cap→screen ms (med/p95) | Viewer CPU (main thr) | Sender CPU | A/V ms |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for r in rows:
    top = r['layers'][-1] if r['layers'] else {}
    rx = next((L for L in r['layers'] if L['size'] == r.get('received_layer')), {})
    cv = r.get('cpu_viewer') or {}
    cs = r.get('cpu_sender') or {}
    print(f"| {r['phase']} | {r.get('received_layer')} | {top.get('enc_fps')} | {rx.get('mbps')} | {r['dec_fps']} | {r['up_fps']} | "
          f"{r['presented_unique_per_s']} | {r.get('layer_presented_pct')}% | {r['unique_gap_ms_p95']} / {r['unique_gap_ms_max']} | "
          f"{r['lat_cap_to_present_ms_med']} / {r['lat_cap_to_present_ms_p95']} | {cv.get('total')} ({cv.get('main_thread')}) | {cs.get('total')} | {r.get('av_offset_ms')} |")
