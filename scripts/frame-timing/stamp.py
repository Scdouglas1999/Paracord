#!/usr/bin/env python3
"""stamp.py <out>: copy stdin to <out>, each line prefixed "[t=<CLOCK_MONOTONIC µs>] ".

The client's stderr goes through this so page marks (FRMARK lines) carry the
same clock as the CPU samples and the frame trace, even in a phase that
presents no frames (`idle`).
"""
import sys
import time

with open(sys.argv[1], 'w', buffering=1) as out:
    for line in sys.stdin.buffer:
        t = time.monotonic_ns() // 1000
        out.write(f'[t={t}] ' + line.decode('utf-8', 'replace'))
