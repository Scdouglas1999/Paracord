import json, sys
run = sys.argv[1]; who = sys.argv[2] if len(sys.argv) > 2 else 'sender'
other = 'viewer' if who == 'sender' else 'sender'
lv = [(int(a), float(b)) for a, b in (l.split() for l in open(f'{run}/{other}/lvl.log'))]
m = [(int(l.split(' ', 2)[0]), l.split(' ', 2)[1], json.loads(l.split(' ', 2)[2])) for l in open(f'{run}/mute-marks.log')]
def act(a, b):
    s = [v for t, v in lv if a <= t < b]; return sum(v > 0.01 for v in s) / len(s) if s else float('nan')
cur = {}
for t, e, i in m:
    cur[e] = t
    if e == 'end':
        print(f"gap {i['gap']:5d} ms: voice before {act(cur['before'], cur['muted']):.2f}, after unmute s1..s8: " + ' '.join(f"{act(cur['unmuted'] + k*1_000_000, cur['unmuted'] + (k+1)*1_000_000):.1f}" for k in range(8)))
