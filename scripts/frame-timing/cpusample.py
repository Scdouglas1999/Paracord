#!/usr/bin/env python3
"""cpusample.py <root pid> <out>: every 0.5 s, "<CLOCK_MONOTONIC µs> <ticks>",
where ticks is utime+stime of <root pid> and all its descendants (the UI
process, WebKit's web and network processes, bwrap and the like).

Processes that exited take their ticks with them, so a phase is only
comparable to the same phase of another run.
"""
import os
import sys
import time

root, out_path = int(sys.argv[1]), sys.argv[2]


def children():
    kids = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open(f'/proc/{name}/stat') as f:
                fields = f.read().rsplit(')', 1)[1].split()
        except OSError:
            continue
        kids.setdefault(int(fields[1]), []).append((int(name), int(fields[11]) + int(fields[12])))
    return kids


def tree_ticks():
    kids = children()
    total, todo = 0, [root]
    try:
        with open(f'/proc/{root}/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        total += int(fields[11]) + int(fields[12])
    except OSError:
        return None
    while todo:
        for pid, ticks in kids.get(todo.pop(), []):
            total += ticks
            todo.append(pid)
    return total


with open(out_path, 'w', buffering=1) as out:
    while True:
        ticks = tree_ticks()
        if ticks is None:
            break
        out.write(f'{time.monotonic_ns() // 1000} {ticks}\n')
        time.sleep(0.5)
