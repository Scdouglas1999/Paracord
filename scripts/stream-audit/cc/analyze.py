#!/usr/bin/env python3
"""Summarize cc-lab scenario directories: analyze.py <dir>... [--json out]

Windows (seconds after the media flow started): together = 10..60 (TCP still
running), alone = 62..75. TCP alone = its seconds 3..10 (before the media).
Without TCP: media 10..60.
"""
import json, re, statistics, sys

def jl(p):
    try: return [json.loads(l) for l in open(p) if l.strip().startswith('{')]
    except FileNotFoundError: return []

def med(xs): return round(statistics.median(xs), 1) if xs else None
def pct(xs, p):
    xs = sorted(xs); return round(xs[min(len(xs) - 1, int(len(xs) * p))], 1) if xs else None

def one(d):
    marks = dict(l.split() for l in open(f'{d}/marks.txt'))
    marks = {k: float(v) for k, v in marks.items()}
    params = open(f'{d}/params.txt').read().split()
    ping = []
    for l in open(f'{d}/ping.txt'):
        m = re.match(r'\[(\d+\.\d+)\].*time=([\d.]+)', l)
        if m: ping.append((float(m[1]), float(m[2])))
    ms = marks['media']
    def pw(a, b): return [r for t, r in ping if a <= t < b]
    sent_total = sum(1 for l in open(f'{d}/ping.txt') if 'icmp_seq' in l)
    send = jl(f'{d}/send.jsonl'); recv = jl(f'{d}/recv.jsonl'); tcp = jl(f'{d}/tcp.jsonl')
    def win(rows, a, b, k): return [r[k] for r in rows if a <= r['t'] < b]
    has_tcp = 'tcp' in marks
    tw = (10, 60)
    out = {
        'cc': params[0], 'mbit': int(params[1]), 'rtt': int(params[2]), 'queue_ms': int(params[3]),
        'loss': float(params[4]), 'offered': float(params[5]), 'tcp': has_tcp,
        'ping_idle': med(pw(marks['idle'], marks.get('tcp', ms))),
        'ping_tcp_alone': med(pw(marks['tcp'] + 3, ms)) if has_tcp else None,
        'ping_together_p50': med(pw(ms + tw[0], ms + tw[1])),
        'ping_together_p95': pct(pw(ms + tw[0], ms + tw[1]), 0.95),
        'tcp_alone_mbps': med(win(tcp, 3, 10, 'mbps')) if has_tcp else None,
        'tcp_together_mbps': round(statistics.mean(win(tcp, 20, 70, 'mbps')), 2) if has_tcp and win(tcp, 20, 70, 'mbps') else None,
        'media_mbps': round(statistics.mean(win(recv, *tw, 'mbps')), 2) if win(recv, *tw, 'mbps') else None,
        'media_lat_p50': med(win(recv, *tw, 'lat_p50')),
        'media_lat_p95': med(win(recv, *tw, 'lat_p95')),
        'media_lat_max': max(win(recv, *tw, 'lat_max'), default=None),
        'media_alone_mbps': round(statistics.mean(win(recv, 62, 75, 'mbps')), 2) if has_tcp and win(recv, 62, 75, 'mbps') else None,
        'ping_media_alone_p50': med(pw(ms + 62, ms + 75)) if has_tcp else None,
        'frames_skipped_pct': None, 'loss_pct': None,
    }
    s = [r for r in send if tw[0] <= r['t'] < tw[1]]
    if s:
        sf = sum(r['sent_frames'] for r in s); sk = sum(r['skipped'] for r in s)
        out['frames_skipped_pct'] = round(100 * sk / max(1, sf + sk), 1)
        out['loss_pct'] = round(100 * sum(r['lost'] for r in s) / max(1, sum(r['sent_pkts'] for r in s)), 2)
        out['cwnd_kb_med'] = med([r['cwnd'] / 1000 for r in s])
    return out

if __name__ == '__main__':
    args = sys.argv[1:]; js = None
    if '--json' in args: i = args.index('--json'); js = args[i + 1]; args = args[:i] + args[i + 2:]
    rows = [one(d) for d in args]
    cols = ['cc', 'mbit', 'rtt', 'queue_ms', 'loss', 'offered', 'ping_idle', 'ping_tcp_alone', 'ping_together_p50', 'ping_together_p95',
            'tcp_alone_mbps', 'tcp_together_mbps', 'media_mbps', 'media_lat_p50', 'media_lat_p95', 'frames_skipped_pct', 'loss_pct', 'cwnd_kb_med', 'media_alone_mbps', 'ping_media_alone_p50']
    print('\t'.join(cols))
    for r in rows: print('\t'.join(str(r.get(c)) for c in cols))
    if js: json.dump(rows, open(js, 'w'), indent=1)
