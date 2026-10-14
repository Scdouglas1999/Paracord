#!/usr/bin/env python3
"""vidan.py <run> [tag]: per Viewing quality step, the picture size the viewer decoded and uploaded (probe DOUT/UP), 3 s after the change to the next."""
import json, re, sys, collections
run = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else None
marks = []
for l in open(f'{run}/video-marks.log'):
    t, e, j = l.split(' ', 2); j = json.loads(j)
    if e == 'quality' and (tag is None or j['tag'] == tag): marks.append((int(t), j['q'], j['tag']))
ev = []
for l in open(f'{run}/viewer/probe.log'):
    m = re.match(r'^(UP|DOUT) t=(\d+).* w=(\d+) h=(\d+)', l)
    if m: ev.append((m[1], int(m[2]), int(m[3]), int(m[4])))
for i, (t, q, tg) in enumerate(marks):
    end = marks[i + 1][0] if i + 1 < len(marks) else t + 8_000_000
    for kind in ('DOUT', 'UP'):
        c = collections.Counter((w, h) for k, ts, w, h in ev if k == kind and t + 3_000_000 <= ts < end)
        n = sum(c.values())
        print(f"{tg} {q:7s} {kind:4s} " + ', '.join(f"{w}x{h} ({v/((end - t - 3e6)/1e6):.1f}/s)" for (w, h), v in c.most_common(3)) if n else f"{tg} {q:7s} {kind:4s} none")
