#!/usr/bin/env python3
"""voicean.py <run>: per trial, when each direction's voice arrives after the second app joins."""
import json, sys, os
run = sys.argv[1]
THR = float(os.environ.get('THR', '0.01'))
def lvl(path):
    out = []
    for line in open(path):
        a = line.split()
        if len(a) == 2: out.append((int(a[0]), float(a[1])))
    return out
L = {'sender': lvl(f'{run}/sender/lvl.log'), 'viewer': lvl(f'{run}/viewer/lvl.log')}
marks = [(int(l.split(' ', 2)[0]), l.split(' ', 2)[1], json.loads(l.split(' ', 2)[2])) for l in open(f'{run}/voice-marks.log')]
trials = {}
for t, e, info in marks:
    if e == 'trial': trials[info['t']] = {'first': info['first'], 'second': info['second'], 'tag': info.get('tag')}
    if e in ('join', 'unmute-click', 'trial-end', 'unmute-again', 'mute-samples'): trials.setdefault(info['t'], {})[e] = (t, info)
def onset(series, start, end):
    # first 1 s span (20 windows) from `start` with >= 70% of windows above THR
    win = [(t, v) for t, v in series if start <= t <= end]
    for i in range(len(win)):
        span = [v for t, v in win[i:] if t < win[i][0] + 1_000_000]
        if len(span) >= 3 and sum(v > THR for v in span) / len(span) >= 0.7:
            return win[i][0]
    return None
def active(series, a, b):
    s = [v for t, v in series if a <= t < b]
    return (sum(v > THR for v in s) / len(s)) if s else None
rows = []
for k in sorted(trials):
    tr = trials[k]
    if 'join' not in tr or 'trial-end' not in tr: continue
    tj = tr['join'][0]; tc = tr['unmute-click'][0]; te = tr['trial-end'][0]
    first, second = tr['first'], tr['second']
    # first -> second: heard on second's output; second -> first: on first's output
    a = onset(L[second], tj, te); b = onset(L[first], tc, te)
    rev = tr['mute-samples'][1]['reverted']
    bins = lambda role, t0: ' '.join(f"{(active(L[role], t0 + i*1_000_000, t0 + (i+1)*1_000_000) or 0):.1f}" for i in range(14))
    print(f"trial {k}: {first}->{second} arrives {((a - tj)/1e6 if a else float('nan')):.2f} s after join; "
          f"{second}->{first} arrives {((b - tc)/1e6 if b else float('nan')):.2f} s after unmute click; unmute reverted={rev}")
    print(f"   {second} out (first's voice), per s from join : {bins(second, tj)}")
    print(f"   {first} out (second's voice), per s from click: {bins(first, tc)}")

# Relay connect time of the second app (first media-stats sample listing it), when sampled.
try:
    rows = []
    for l in open(f'{run}/relay-stats.log'):
        t, st, body = l.split(' ', 2)
        if st == '200': rows.append((int(t), {p['user_id'] for p in json.loads(body)['participants']}))
    scene = json.load(open(f'{run}/scene.json'))
    uid = {'sender': scene['sender']['id'], 'viewer': scene['viewer']['id']}
    print('connect (relay sees the joiner, 0.5 s sampling) -> first voice heard by the joiner:')
    for k in sorted(trials):
        tr = trials[k]
        if 'join' not in tr or 'trial-end' not in tr: continue
        tj = tr['join'][0]; te = tr['trial-end'][0]
        c = next((t for t, ids in rows if t >= tj and uid[tr['second']] in ids), None)
        a = onset(L[tr['second']], tj, te)
        print(f"  trial {k}: connect +{(c - tj)/1e6:.2f} s, voice +{((a - tj)/1e6 if a else float('nan')):.2f} s" if c else f"  trial {k}: no stats")
except FileNotFoundError:
    pass
