#!/usr/bin/env python3
"""pacing.py <log> <phase> [--json]: presentation pacing of the main window
between the last 'FRMARK start <phase>' and the next 'FRMARK end <phase>',
from the '[frame] commit=.. present=.. seq=.. refresh=..' lines that
PARACORD_FRAME_TRACE=1 prints (client/src-tauri/src/linux_frame_clock.rs).

Intervals are counted in display refreshes. A compositor without a vblank
counter (KWin's virtual output reports seq 0) gets its refreshes numbered from
the presentation times, which sit on its refresh grid. A gap over 100 ms ends
an active run, so the pause between two actions is not read as a slow frame.

Output: presented fps over the active time, the histogram of intervals in
refreshes (1v = one refresh), the share at the most common interval, the
share of consecutive intervals that change length, gaps over 25 ms,
commits replaced before they were shown, and commit-to-screen latency.
"""
import json
import re
import statistics
import sys
from collections import Counter

FRAME = re.compile(r'\[frame\] commit=(\d+) (?:present=(\d+) seq=(\d+) refresh=(\d+) flags=(\d+)|discarded)')


def phase_lines(lines, phase):
    starts = [i for i, l in enumerate(lines) if l.rstrip().endswith(f'FRMARK start {phase}')]
    if not starts:
        return None
    start = starts[-1]
    end = next((i for i in range(start, len(lines)) if lines[i].rstrip().endswith(f'FRMARK end {phase}')), None)
    return None if end is None else lines[start:end]


def pace(lines, phase):
    """The pacing of one phase, or None when the log has no such phase or too few frames."""
    span = phase_lines(lines, phase)
    if span is None:
        return None
    frames, discarded = [], 0
    for l in span:
        m = FRAME.search(l)
        if not m:
            continue
        if m[2] is None:
            discarded += 1
            continue
        frames.append((int(m[1]), int(m[2]), int(m[3]), int(m[4])))
    if len(frames) < 3:
        return {'phase': phase, 'fps': 0.0, 'frames': len(frames), 'mode': 0, 'at_mode_pct': 0,
                'one_refresh_pct': 0, 'hist': {}, 'cadence_changes_pct': 0, 'gaps_over_25ms': 0,
                'max_gap_ms': 0, 'superseded': 0, 'discarded': discarded, 'latency_med_ms': 0,
                'latency_p90_ms': 0, 'hz': 0, 'active_s': 0}
    frames.sort(key=lambda f: f[1])
    refresh_ns = statistics.median(f[3] for f in frames) or 4_168_000
    period_us = refresh_ns / 1000
    if len({f[2] for f in frames}) <= 1:
        t0 = frames[0][1]
        frames = [(c, p, round((p - t0) / period_us), r) for c, p, _, r in frames]
    # Distinct presentations: a later commit on the same refresh replaced the earlier one.
    shown, superseded = [], 0
    for f in frames:
        if shown and f[2] == shown[-1][2]:
            superseded += 1
            shown[-1] = f
        else:
            shown.append(f)
    runs, cur = [], [shown[0]]
    for a, b in zip(shown, shown[1:]):
        if b[1] - a[1] > 100_000:
            runs.append(cur)
            cur = [b]
        else:
            cur.append(b)
    runs.append(cur)
    intervals, gaps_ms, active_us, n_active, changes, pairs = [], [], 0, 0, 0, 0
    for run in runs:
        if len(run) < 2:
            continue
        iv = [b[2] - a[2] for a, b in zip(run, run[1:])]
        intervals += iv
        gaps_ms += [(b[1] - a[1]) / 1000 for a, b in zip(run, run[1:])]
        active_us += run[-1][1] - run[0][1]
        n_active += len(run) - 1
        changes += sum(1 for x, y in zip(iv, iv[1:]) if x != y)
        pairs += max(0, len(iv) - 1)
    hist = Counter(min(v, 9) for v in intervals)
    total = sum(hist.values()) or 1
    mode, mode_n = hist.most_common(1)[0] if hist else (0, 0)
    latency = sorted((f[1] - f[0]) / 1000 for f in shown)
    return {
        'phase': phase,
        'hz': round(1e9 / refresh_ns, 1),
        'fps': round(n_active / (active_us / 1e6), 1) if active_us else 0.0,
        'active_s': round(active_us / 1e6, 2),
        'frames': n_active,
        'hist': {(str(k) if k < 9 else '9+'): round(100 * hist[k] / total) for k in sorted(hist)},
        'mode': mode,
        'at_mode_pct': round(100 * mode_n / total),
        'one_refresh_pct': round(100 * hist.get(1, 0) / total),
        'cadence_changes_pct': round(100 * changes / pairs) if pairs else 0,
        'max_gap_ms': round(max(gaps_ms), 1) if gaps_ms else 0,
        'gaps_over_25ms': sum(1 for g in gaps_ms if g > 25),
        'superseded': superseded,
        'discarded': discarded,
        'latency_med_ms': round(statistics.median(latency), 1),
        'latency_p90_ms': round(latency[int(len(latency) * 0.9)], 1),
    }


if __name__ == '__main__':
    log, phase = sys.argv[1], sys.argv[2]
    out = pace(open(log, errors='replace').read().splitlines(), phase)
    if out is None:
        sys.exit(f'{phase}: no such phase in {log}')
    if '--json' in sys.argv:
        print(json.dumps(out))
    else:
        h = ' '.join(f'{k}v:{v}%' for k, v in out['hist'].items())
        print(f"{phase:13s} {out['fps']:5.1f} fps over {out['active_s']:4.1f}s | 1v {out['one_refresh_pct']}% "
              f"| cadence changes {out['cadence_changes_pct']}% | {h} | max gap {out['max_gap_ms']} ms, "
              f">25ms: {out['gaps_over_25ms']} | superseded {out['superseded']} | "
              f"lat {out['latency_med_ms']}/{out['latency_p90_ms']} ms")
