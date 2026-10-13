#!/usr/bin/env python3
"""analyze.py [--require-display-link] [--json <out>] <run.log>...: one row per
phase of the frame-timing page, and the gate's verdict.

Each run.log is the client's stderr as run.sh records it (lines stamped
"[t=<CLOCK_MONOTONIC µs>]" by stamp.py), next to <run>.cpu from cpusample.py.

Per phase:
- presented frames from PARACORD_FRAME_TRACE (pacing.py): fps, share of
  frames one refresh apart (1v), gaps over 25 ms;
- the page's own cadence: rAF callbacks per second, scroll events per second;
- CPU of the client's whole process tree, percent of one core.

The gate (thresholds from docs/design/gtk4-plan.md, "Test plan"):
- compositor phases (css-anim, css-anim-raf, glass): >= 180 fps presented at
  240 Hz (75% of the display's refresh, so 108 at 144 Hz and 45 at 60 Hz) and
  >= 85% of frames one refresh apart;
- with --require-display-link, the same for the phases WebKit's display link
  drives (raf-anim, scroll, scroll-glass). Off by default until the system
  WebKitGTK's display link follows the display (see the README).

With several runs the verdict uses each phase's median across them. Exits 1
when the gate fails.
"""
import json
import os
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacing import pace  # noqa: E402

MIN_FPS_SHARE = 0.75  # of the refresh: 180 fps at 240 Hz (docs/design/gtk4-plan.md)
MIN_ONE_REFRESH_PCT = 85.0
COMPOSITOR_PHASES = ['css-anim', 'css-anim-raf', 'glass']
DISPLAY_LINK_PHASES = ['raf-anim', 'scroll', 'scroll-glass']
ORDER = ['idle', 'idle-raf', 'css-anim', 'css-anim-raf', 'raf-anim', 'scroll', 'scroll-glass', 'glass']

STAMP = re.compile(r'^\[t=(\d+)\] ')
MARK = re.compile(r'\[mark t=(\d+)\] ')


def cpu_samples(path):
    if not os.path.exists(path):
        return []
    return [tuple(map(int, l.split())) for l in open(path) if len(l.split()) == 2]


def cpu_between(samples, a, b):
    """Percent of one core used by the tree between monotonic µs a and b."""
    if len(samples) < 2:
        return None
    sa = min(samples, key=lambda s: abs(s[0] - a))
    sb = min(samples, key=lambda s: abs(s[0] - b))
    if sb[0] <= sa[0]:
        return None
    return round(100 * (sb[1] - sa[1]) / os.sysconf('SC_CLK_TCK') / ((sb[0] - sa[0]) / 1e6), 1)


def analyze(log):
    lines = open(log, errors='replace').read().splitlines()
    samples = cpu_samples(log[:-4] + '.cpu' if log.endswith('.log') else log + '.cpu')
    page = {}
    marks = {}
    result = {}
    for l in lines:
        m = re.search(r'PHASERES (\S+) (\{.*\})', l)
        if m:
            page[m[1]] = json.loads(m[2])
            continue
        m = re.search(r'RESULT (\{.*\})', l)
        if m:
            result = json.loads(m[1])
            continue
        m = re.search(r'FRMARK (start|end) (\S+)\s*$', l)
        if m:
            t = MARK.search(l) or STAMP.search(l)
            if t:
                marks.setdefault(m[2], {})[m[1]] = int(t[1])
    rows = {}
    for phase in sorted(set(page) | set(marks), key=lambda p: ORDER.index(p) if p in ORDER else 99):
        row = {'phase': phase}
        p = pace(lines, phase)
        if p is not None and p['frames']:
            row.update(fps=p['fps'], one_refresh_pct=p['one_refresh_pct'], mode=p['mode'],
                       at_mode_pct=p['at_mode_pct'], gaps25=p['gaps_over_25ms'],
                       changes_pct=p['cadence_changes_pct'], hz=p['hz'], lat_ms=p['latency_med_ms'])
        d = page.get(phase, {})
        if d.get('raf'):
            row['raf'] = d['raf']['rate']
        if d.get('scrollEvents'):
            row['scroll_ev'] = d['scrollEvents']['rate']
        if d.get('scrollTopChanges'):
            row['scroll_top'] = d['scrollTopChanges']['rate']
        span = marks.get(phase, {})
        if 'start' in span and 'end' in span:
            row['cpu'] = cpu_between(samples, span['start'], span['end'])
        rows[phase] = row
    return {'log': log, 'size': f"{result.get('w')}x{result.get('h')}", 'gl': result.get('gl'), 'rows': rows}


def median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 1) if values else None


def main(argv):
    require_dl = '--require-display-link' in argv
    json_out = None
    if '--json' in argv:
        json_out = argv[argv.index('--json') + 1]
    logs = [a for a in argv if a.endswith('.log')]
    if not logs:
        sys.exit(__doc__)
    runs = [analyze(l) for l in logs]
    for run in runs:
        print(f"# {os.path.basename(run['log'])}  page {run['size']}  {run['gl']}")
        for r in run['rows'].values():
            pres = (f"present {r['fps']:6.1f} fps 1v {r['one_refresh_pct']:3d}% >25ms {r['gaps25']:3d}"
                    if 'fps' in r else 'present   none                    ')
            page = ''.join([f" rAF {r['raf']:6.1f}/s" if 'raf' in r else '',
                            f" scroll {r['scroll_ev']:6.1f}/s" if 'scroll_ev' in r else ''])
            cpu = f"cpu {r['cpu']:5.1f}%" if r.get('cpu') is not None else 'cpu   n/a'
            print(f"  {r['phase']:13s} {pres} | {cpu} |{page}")

    gated = COMPOSITOR_PHASES + (DISPLAY_LINK_PHASES if require_dl else [])
    summary, failures = {}, []
    for phase in ORDER:
        rs = [run['rows'][phase] for run in runs if phase in run['rows']]
        if not rs:
            if phase in gated:
                failures.append(f'{phase}: missing from every run')
            continue
        s = {k: median([r.get(k) for r in rs]) for k in ('fps', 'one_refresh_pct', 'raf', 'scroll_ev', 'cpu', 'hz')}
        summary[phase] = s
        if phase in gated:
            min_fps = MIN_FPS_SHARE * (s['hz'] or 240.0)
            if s['fps'] is None or s['fps'] < min_fps:
                failures.append(f"{phase}: {s['fps']} fps presented, needs >= {min_fps:.0f} "
                                f"(75% of {s['hz']} Hz)")
            if s['one_refresh_pct'] is None or s['one_refresh_pct'] < MIN_ONE_REFRESH_PCT:
                failures.append(f"{phase}: {s['one_refresh_pct']}% one refresh apart, needs >= {MIN_ONE_REFRESH_PCT:.0f}%")
    print(f"# median of {len(runs)} run(s); gated phases: {', '.join(gated)}")
    for phase, s in summary.items():
        print(f"  {phase:13s} fps {s['fps']}  1v {s['one_refresh_pct']}%  rAF {s['raf']}  scroll {s['scroll_ev']}  cpu {s['cpu']}%")
    for f in failures:
        print(f'GATE FAIL: {f}')
    print('GATE: ' + ('FAIL' if failures else 'PASS'))
    if json_out:
        with open(json_out, 'w') as f:
            json.dump({'runs': runs, 'median': summary, 'gated': gated, 'failures': failures,
                       'pass': not failures}, f, indent=1)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
