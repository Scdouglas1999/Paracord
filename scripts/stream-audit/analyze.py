#!/usr/bin/env python3
"""analyze.py <run dir> [--json out.json] [--phase substr]: per-phase numbers
for a stream-audit run, stage by stage.

Reads (all stamped with CLOCK_MONOTONIC µs):
  marks.log              phase start/end marks from drive/campaign.mjs
  src.log                SRC lines from pattern.py (the synthetic screen)
  sender/probe.log       CAP, ESRC, EIN, EOUT, ECFG from probe.c in the sender
  viewer/probe.log       DIN, DOUT, UP, SW from probe.c in the viewer
  viewer/app.log         the viewer's [frame] commit/present trace (wp_presentation)
  {sender,viewer}/cpu.log  per-process and per-thread ticks (cpuprobe.py)
  relay.log              the relay's per-connection counters (media-stats)
  {sender,viewer}/audio.log  tone-burst onsets at the capture sink and the viewer's output
  gpu.log                nvidia-smi pmon

A frame is followed by the 16-bit code pattern.py baked into it (12-bit counter
+ 4-bit check), unwrapped to the source frame number near the event's time.
"""
import bisect
import collections
import json
import re
import statistics
import sys

RUN = sys.argv[1]
args = sys.argv[2:]
out_json = args[args.index('--json') + 1] if '--json' in args else None
only = args[args.index('--phase') + 1] if '--phase' in args else None


def kv(parts):
    return dict(p.split('=', 1) for p in parts if '=' in p)


def read_lines(path):
    try:
        with open(path, errors='replace') as f:
            return f.read().splitlines()
    except OSError:
        return []


def valid(code):
    if code is None or code < 0:
        return None
    n12, chk = code >> 4, code & 15
    return n12 if chk == ((((n12 >> 8) + (n12 >> 4) + n12) & 15) ^ 5) else None


# ── source ──────────────────────────────────────────────────────────────────
src_t, src_n = [], []
for l in read_lines(f'{RUN}/src.log'):
    if l.startswith('SRC '):
        d = kv(l.split())
        src_t.append(int(d['t']))
        src_n.append(int(d['n']))
src_time_of = {}
for t, n in zip(src_t, src_n):
    src_time_of[n] = t
fps_src = None


def unwrap(n12, t):
    """The full source frame number for a 12-bit counter seen at time t."""
    if n12 is None:
        return None
    i = bisect.bisect_right(src_t, t) - 1
    if i < 0:
        return n12
    ref = src_n[i]
    k = round((ref - n12) / 4096)
    n = n12 + 4096 * k
    if n > ref + 2:
        n -= 4096
    return n


# ── probe logs ──────────────────────────────────────────────────────────────
def load_probe(path):
    ev = collections.defaultdict(list)
    order = []
    for l in read_lines(path):
        parts = l.split()
        if not parts:
            continue
        tag = parts[0]
        d = kv(parts[1:])
        if 't' not in d:
            continue
        d['t'] = int(d['t'])
        ev[tag].append(d)
        order.append((tag, d))
    return ev, order


S, S_order = load_probe(f'{RUN}/sender/probe.log')
V, _ = load_probe(f'{RUN}/viewer/probe.log')

# Encoder input codes per encoder context: the ESRC just before each EIN on the
# encode thread (lavc: CPU frame into the filter graph, then the GPU frame into
# the encoder). libvpx EIN carries its own code.
ein_code = []  # (t, ctx, n)
last_esrc = None
for tag, d in S_order:
    if tag == 'ESRC':
        last_esrc = d
    elif tag == 'EIN':
        code = int(d.get('code', -3))
        if code < 0 and last_esrc is not None:
            code = int(last_esrc.get('code', -3))
        n = unwrap(valid(code), d['t'])
        ein_code.append((d['t'], d['ctx'], n))
        last_esrc = None
ecfg = {}
for d in S['ECFG']:
    ecfg[d['ctx']] = d

cap_code = [(d['t'], unwrap(valid(int(d['code'])), d['t'])) for d in S['CAP']]
cap_time_of = {}
for t, n in cap_code:
    if n is not None and n not in cap_time_of:
        cap_time_of[n] = t
ein_time_of = collections.defaultdict(dict)  # ctx -> n -> t
for t, ctx, n in ein_code:
    if n is not None and n not in ein_time_of[ctx]:
        ein_time_of[ctx][n] = t

up = [(d['t'], int(d['w']), int(d['h']), unwrap(valid(int(d['code'])), d['t']), int(d['dur'])) for d in V['UP']]
sw = [(d['t'], unwrap(valid(int(d['code'])), d['t']) if 'code' in d else None, int(d.get('code', -20)), d.get('x')) for d in V['SW']]

# ── the viewer's presentation trace ──────────────────────────────────────────
FRAME = re.compile(r'\[frame\] commit=(\d+) (?:present=(\d+) seq=(\d+) refresh=(\d+) flags=(\d+)|discarded)')
commits = []  # (commit_us, present_us or None)
for l in read_lines(f'{RUN}/viewer/app.log'):
    m = FRAME.search(l)
    if m:
        commits.append((int(m[1]), int(m[2]) if m[2] else None))
commits.sort()
commit_ts = [c[0] for c in commits]


def present_of(swap_t):
    """The presentation of the commit made by the paint that ended in this swap."""
    i = bisect.bisect_right(commit_ts, swap_t) - 1
    if i < 0 or swap_t - commit_ts[i] > 40_000:
        return None, False
    return commits[i][1], True


# ── marks ───────────────────────────────────────────────────────────────────
phases = []
open_ = {}
for l in read_lines(f'{RUN}/marks.log'):
    t, ev, js = l.split(' ', 2)
    info = json.loads(js)
    if ev == 'start':
        open_[info['phase']] = (int(t), info)
    elif ev == 'end' and info['phase'] in open_:
        t0, i0 = open_.pop(info['phase'])
        phases.append((info['phase'], t0, int(t), i0))


# ── cpu ─────────────────────────────────────────────────────────────────────
def load_cpu(path):
    samples = collections.OrderedDict()
    for l in read_lines(path):
        p = l.split()
        if len(p) != 5:
            continue
        samples.setdefault(int(p[0]), []).append((p[1], int(p[2]), p[3], int(p[4])))
    return list(samples.items())


CPU = {side: load_cpu(f'{RUN}/{side}/cpu.log') for side in ('sender', 'viewer')}


def cpu_window(side, t0, t1):
    s = CPU[side]
    if not s:
        return None
    ts = [x[0] for x in s]
    i0 = max(0, bisect.bisect_left(ts, t0))
    i1 = min(len(s) - 1, bisect.bisect_right(ts, t1) - 1)
    if i1 <= i0:
        return None
    a, b = dict(), dict()
    for kind, pid, comm, ticks in s[i0][1]:
        a[(kind, pid)] = (comm, ticks)
    for kind, pid, comm, ticks in s[i1][1]:
        b[(kind, pid)] = (comm, ticks)
    dur = (s[i1][0] - s[i0][0]) / 1e6
    procs = collections.Counter()
    threads = collections.Counter()
    main_pid = None
    for (kind, pid), (comm, ticks) in b.items():
        if (kind, pid) not in a:
            continue
        d = (ticks - a[(kind, pid)][1]) / 100 / dur * 100  # % of one core
        if kind == 'P':
            procs[comm] += d
            if comm.startswith('paracord-deskto'):
                main_pid = pid
        else:
            threads[(pid, comm)] += d
    total = sum(procs.values())
    main_thread = next((v for (pid, comm), v in threads.items() if pid == main_pid), None)
    return {
        'total': round(total, 1),
        'procs': {k: round(v, 1) for k, v in procs.most_common(4)},
        'main_thread': round(main_thread, 1) if main_thread is not None else None,
        'top_threads': [(comm, round(v, 1)) for (pid, comm), v in threads.most_common(5)],
    }


# ── relay ───────────────────────────────────────────────────────────────────
relay = []
for l in read_lines(f'{RUN}/relay.log'):
    p = l.split(' ', 2)
    if len(p) == 3 and p[1] == '200':
        try:
            relay.append((int(p[0]), json.loads(p[2])))
        except ValueError:
            pass


def relay_window(t0, t1):
    if not relay:
        return None
    ts = [r[0] for r in relay]
    i0 = bisect.bisect_left(ts, t0)
    i1 = bisect.bisect_right(ts, t1) - 1
    if i1 <= i0:
        return None
    dur = (relay[i1][0] - relay[i0][0]) / 1e6

    def rows(snapshot):
        body = snapshot[1]
        items = body.get('participants', body) if isinstance(body, dict) else body
        return {str(c.get('user_id')): c for c in items} if isinstance(items, list) else {}
    a, b = rows(relay[i0]), rows(relay[i1])
    out = {}
    for uid, c in b.items():
        if uid not in a:
            continue
        d = {k: c[k] - a[uid][k] for k in c if isinstance(c[k], int) and k != 'user_id'}
        out[uid] = {
            'video_dg_in_per_s': round(d.get('video_datagrams_received', 0) / dur, 1),
            'kf_streams_in_per_s': round(d.get('stream_frames_received', 0) / dur, 2),
            'mbps_in': round(d.get('bytes_received', 0) * 8 / dur / 1e6, 2),
            'dg_out_per_s': round(d.get('datagrams_sent', 0) / dur, 1),
            'mbps_out': round(d.get('bytes_sent', 0) * 8 / dur / 1e6, 2),
        }
    return out


# ── audio ───────────────────────────────────────────────────────────────────
def load_bursts(path):
    """Onsets in CLOCK_MONOTONIC µs (audiorec.py logs arrival-based onsets with n=;
    older lines used the pipeline clock and are corrected with the CLOCK line)."""
    off = None
    out = []
    for l in read_lines(path):
        p = l.split()
        d = kv(p[1:])
        if p and p[0] == 'CLOCK':
            off = int(d['mono']) - int(d['now'])
        elif p and p[0] == 'BURST':
            if 'n' in d:
                out.append(int(d['t']))
            elif off is not None:
                out.append(int(d['t']) + off)
    return sorted(out)


def load_levels(path):
    return [(int(kv(l.split()[1:])['t']), float(kv(l.split()[1:])['rms'])) for l in read_lines(path) if l.startswith('LEVEL')]


A_CAP = load_bursts(f'{RUN}/sender/audio.log')
A_VIEW = load_bursts(f'{RUN}/viewer/audio.log')
LEVELS = load_levels(f'{RUN}/viewer/audio.log')


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def med(xs):
    return statistics.median(xs) if xs else None


def r1(x, nd=1):
    return None if x is None else round(x, nd)


# ── per phase ───────────────────────────────────────────────────────────────
def analyze(name, t0, t1, info):
    dur = (t1 - t0) / 1e6
    W = lambda xs, key=lambda e: e['t']: [e for e in xs if t0 <= key(e) < t1]
    res = {'phase': name, 'dur_s': round(dur, 1), 'info': info}
    res['src_fps'] = r1(sum(1 for t in src_t if t0 <= t < t1) / dur)
    caps = [c for c in cap_code if t0 <= c[0] < t1]
    res['cap_fps'] = r1(len(caps) / dur)
    # encoders
    enc = {}
    for d in W(S['EOUT']):
        e = enc.setdefault(d['ctx'], {'frames': 0, 'bytes': 0, 'keys': 0, 'key_t': []})
        e['frames'] += 1
        e['bytes'] += int(d['size'])
        if d['key'] == '1':
            e['keys'] += 1
            e['key_t'].append(d['t'])
    ein_w = collections.defaultdict(list)
    for t, ctx, n in ein_code:
        if t0 <= t < t1:
            ein_w[ctx].append(n)
    dur_ein = collections.defaultdict(list)
    for d in W(S['EINDONE']):
        dur_ein[d['ctx']].append(int(d['dur']))
    layers = []
    for ctx, e in enc.items():
        cfg = ecfg.get(ctx, {})
        ns = [n for n in ein_w.get(ctx, []) if n is not None]
        gaps = [b - a for a, b in zip(ns, ns[1:])]
        layers.append({
            'ctx': ctx, 'codec': cfg.get('codec'), 'size': f"{cfg.get('w')}x{cfg.get('h')}",
            'cfg_fps': cfg.get('fps'), 'cfg_maxrate_kbps': int(cfg.get('maxrate', cfg.get('bitrate', 0)) or 0) // 1000
            if cfg.get('codec') != 'libvpx' else int(cfg.get('bitrate', 0)),
            'gop': cfg.get('gop', cfg.get('kf_max')), 'preset': cfg.get('preset'), 'rc': cfg.get('rc'), 'cq': cfg.get('cq'),
            'enc_fps': r1(e['frames'] / dur), 'mbps': r1(e['bytes'] * 8 / dur / 1e6, 2), 'keyframes': e['keys'],
            'unique_src_per_s': r1(len(set(ns)) / dur),
            'src_skip_hist': dict(collections.Counter(gaps).most_common(4)),
            'encode_ms_med': r1((med(dur_ein.get(ctx, [])) or 0) / 1000, 2),
        })
    layers.sort(key=lambda x: (int(x['size'].split('x')[0]) if x['size'][0].isdigit() else 0, x['mbps'] or 0))
    res['layers'] = layers
    # viewer: decode / upload / swap / present
    res['dec_fps'] = r1(len(W(V['DOUT'])) / dur)
    res['din_mbps'] = r1(sum(int(d['size']) for d in W(V['DIN'])) * 8 / dur / 1e6, 2)
    dsizes = collections.Counter(f"{d['w']}x{d['h']}" for d in W(V['DOUT']))
    res['dec_size'] = dsizes.most_common(1)[0][0] if dsizes else None
    ups = [u for u in up if t0 <= u[0] < t1]
    res['up_fps'] = r1(len(ups) / dur)
    up_n = [u[3] for u in ups if u[3] is not None]
    res['up_unique_per_s'] = r1(len(set(up_n)) / dur)
    res['up_ms_med'] = r1((med([u[4] for u in ups]) or 0) / 1000, 2)
    sws = [s for s in sw if t0 <= s[0] < t1]
    res['swaps_per_s'] = r1(len(sws) / dur)
    readable = [s for s in sws if s[1] is not None]
    res['sw_readable_pct'] = r1(100 * len(readable) / len(sws)) if sws else None
    # presented: swaps whose commit was presented
    shown = []
    discarded = 0
    for t, n, raw, _x in readable:
        p, found = present_of(t)
        if found and p is None:
            discarded += 1
            continue
        shown.append((p if p else t, n))
    first_present = {}
    for p, n in sorted(shown):
        first_present.setdefault(n, p)
    uniq = sorted(first_present.items(), key=lambda kv_: kv_[1])
    res['presented_unique_per_s'] = r1(len(uniq) / dur)
    res['presented_dupes'] = len(shown) - len(uniq)
    res['discarded_commits'] = discarded
    gaps_ms = [(b[1] - a[1]) / 1000 for a, b in zip(uniq, uniq[1:])]
    res['unique_gap_ms_med'] = r1(med(gaps_ms))
    res['unique_gap_ms_p95'] = r1(pct(gaps_ms, 0.95))
    res['unique_gap_ms_max'] = r1(max(gaps_ms)) if gaps_ms else None
    ns = [n for n, _ in uniq]
    jumps = collections.Counter(b - a for a, b in zip(ns, ns[1:]))
    res['present_src_step_hist'] = dict(jumps.most_common(5))
    res['out_of_order'] = sum(v for k, v in jumps.items() if k <= 0)
    # window frame rate (all commits, video or not)
    pres = [c[1] for c in commits if c[1] and t0 <= c[1] < t1]
    res['window_presented_fps'] = r1(len(pres) / dur)
    # latency
    lat_src, lat_cap, lat_up = [], [], []
    for n, p in uniq:
        if n in src_time_of:
            lat_src.append((p - src_time_of[n]) / 1000)
        if n in cap_time_of:
            lat_cap.append((p - cap_time_of[n]) / 1000)
    up_first = {}
    for u in ups:
        if u[3] is not None:
            up_first.setdefault(u[3], u[0])
    for n, t in up_first.items():
        if n in cap_time_of:
            lat_up.append((t - cap_time_of[n]) / 1000)
    res['lat_cap_to_present_ms_med'] = r1(med(lat_cap))
    res['lat_cap_to_present_ms_p95'] = r1(pct(lat_cap, 0.95))
    res['lat_cap_to_upload_ms_med'] = r1(med(lat_up))
    res['lat_cap_to_upload_ms_jitter'] = r1(statistics.pstdev(lat_up)) if len(lat_up) > 2 else None
    res['lat_src_to_present_ms_med'] = r1(med(lat_src))
    # delivery to screen: of the frames the received layer encoded, how many reached the screen
    recv_size = res['dec_size']
    recv_ctx = None
    for L in layers:
        if L['size'] == recv_size:
            if recv_ctx is None or (L['mbps'] or 0) > (next(x for x in layers if x['ctx'] == recv_ctx)['mbps'] or 0):
                recv_ctx = L['ctx']
    if recv_ctx:
        lag = (med(lat_cap) or 0) * 1000
        sent = {n for t, ctx, n in ein_code if ctx == recv_ctx and n is not None and t0 - lag <= t < t1 - lag}
        got_up = set(up_first)
        got_sc = set(first_present)
        res['received_layer'] = recv_size
        res['layer_encoded'] = len(sent)
        res['layer_uploaded_pct'] = r1(100 * len(sent & got_up) / len(sent)) if sent else None
        res['layer_presented_pct'] = r1(100 * len(sent & got_sc) / len(sent)) if sent else None
    res['relay'] = relay_window(t0, t1)
    res['cpu_sender'] = cpu_window('sender', t0, t1)
    res['cpu_viewer'] = cpu_window('viewer', t0, t1)
    # audio
    bursts_v = [b for b in A_VIEW if t0 <= b < t1]
    lv = [r for t, r in LEVELS if t0 <= t < t1]
    res['audio_bursts'] = len(bursts_v)
    res['audio_rms_max'] = r1(max(lv), 4) if lv else None
    a_lat = []
    for b in bursts_v:
        i = bisect.bisect_right(A_CAP, b) - 1
        if i >= 0 and b - A_CAP[i] < 1_500_000:
            a_lat.append((b - A_CAP[i]) / 1000)
    res['audio_lat_ms_med'] = r1(med(a_lat))
    if a_lat and lat_cap:
        res['av_offset_ms'] = r1(med(a_lat) - med(lat_cap))  # + = audio later than video
    return res


results = []
for name, t0, t1, info in phases:
    if only and only not in name:
        continue
    results.append(analyze(name, t0, t1, info))

if out_json:
    with open(out_json, 'w') as f:
        json.dump(results, f, indent=1)


def fmt_layers(ls):
    return '; '.join(f"{L['size']} {L['enc_fps']}fps {L['mbps']}Mb kf{L['keyframes']} u{L['unique_src_per_s']}" for L in ls)


for r in results:
    print(f"== {r['phase']} ({r['dur_s']}s) {json.dumps({k: v for k, v in r['info'].items() if k in ('layout', 'motion', 'x', 'viewerQuality', 'preset')})}")
    print(f"  src {r['src_fps']} | cap {r['cap_fps']} | enc [{fmt_layers(r['layers'])}]")
    print(f"  recv {r.get('received_layer')} dec {r['dec_fps']}/s {r['din_mbps']}Mb | up {r['up_fps']}/s uniq {r['up_unique_per_s']} ({r['up_ms_med']} ms) "
          f"| swaps {r['swaps_per_s']}/s readable {r['sw_readable_pct']}% | presented uniq {r['presented_unique_per_s']}/s dupes {r['presented_dupes']} "
          f"gap med {r['unique_gap_ms_med']} p95 {r['unique_gap_ms_p95']} max {r['unique_gap_ms_max']} | window {r['window_presented_fps']} fps")
    print(f"  steps {r['present_src_step_hist']} | layer frames {r.get('layer_encoded')} uploaded {r.get('layer_uploaded_pct')}% presented {r.get('layer_presented_pct')}%")
    print(f"  latency cap->upload {r['lat_cap_to_upload_ms_med']} (jitter {r['lat_cap_to_upload_ms_jitter']}) cap->present {r['lat_cap_to_present_ms_med']} p95 {r['lat_cap_to_present_ms_p95']} src->present {r['lat_src_to_present_ms_med']}")
    print(f"  relay {r['relay']}")
    print(f"  cpu sender {r['cpu_sender']}")
    print(f"  cpu viewer {r['cpu_viewer']}")
    print(f"  audio bursts {r['audio_bursts']} rms {r['audio_rms_max']} lat {r['audio_lat_ms_med']} av_offset {r.get('av_offset_ms')}")
