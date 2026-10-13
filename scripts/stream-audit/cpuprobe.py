#!/usr/bin/env python3
"""cpuprobe.py <root pid> <out>: every 0.5 s, the CPU ticks of every process in
<root pid>'s tree, and of every thread of the root's app process.

Lines: "<CLOCK_MONOTONIC µs> P <pid> <comm> <ticks>" per process and
"<µs> T <tid> <comm> <ticks>" per thread of the first paracord-desktop process.
Ticks are utime+stime (USER_HZ, 100 per second).
"""
import os
import sys
import time

root, out_path = int(sys.argv[1]), sys.argv[2]


def stat(path):
    try:
        with open(path) as f:
            raw = f.read()
    except OSError:
        return None
    head, tail = raw.rsplit(')', 1)
    comm = head.split('(', 1)[1].replace(' ', '_')
    fields = tail.split()
    return comm, int(fields[1]), int(fields[11]) + int(fields[12])


def tree():
    kids = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            s = stat(f'/proc/{name}/stat')
            if s:
                kids.setdefault(s[1], []).append((int(name), s[0], s[2]))
    r = stat(f'/proc/{root}/stat')
    if r is None:
        return None
    out, todo = [(root, r[0], r[2])], [root]
    while todo:
        for pid, comm, ticks in kids.get(todo.pop(), []):
            out.append((pid, comm, ticks))
            todo.append(pid)
    return out


with open(out_path, 'w', buffering=1) as out:
    app = None
    while True:
        procs = tree()
        if procs is None:
            break
        t = time.monotonic_ns() // 1000
        lines = [f'{t} P {pid} {comm} {ticks}' for pid, comm, ticks in procs]
        if app is None:
            app = next((pid for pid, comm, _ in procs if comm.startswith('paracord-deskto')), None)
        if app is not None:
            try:
                for tid in os.listdir(f'/proc/{app}/task'):
                    s = stat(f'/proc/{app}/task/{tid}/stat')
                    if s:
                        lines.append(f'{t} T {tid} {s[0]} {s[2]}')
            except OSError:
                pass
        out.write('\n'.join(lines) + '\n')
        time.sleep(0.5)
