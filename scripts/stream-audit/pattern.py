#!/usr/bin/env python3
"""pattern.py: the synthetic "screen" a stream-audit sender shares.

A PipeWire Video/Source node (node.name sa-pattern) that the fake portal hands
to the app as the picked screen. Each frame is a scrolling desktop-like page
(text lines, panels, a moving block) with a band of 18 full-width bars between
35% and 65% of the height: bar 0 red, bars 1..16 a 16-bit code (12-bit frame
counter + 4-bit check, MSB first, white = 1), bar 17 blue. probe.c reads the
code back at every stage of the app, so a frame can be followed to the screen.

With --audio, a playback stream (pulse API, so the app's stream-audio router
can move it into its capture sink) carries silence with a 40 ms 1 kHz burst on
every frame whose counter is a multiple of --burst-every; its scheduled time is
logged as ASRC, so audio and video can be lined up at the viewer.

Log lines (CLOCK_MONOTONIC µs): SRC n=<counter> t=<pushed>; ASRC n= t=.

  PIPEWIRE_REMOTE=<graph> python3 pattern.py --w 5120 --h 1440 --fps 60 --log src.log [--audio]
"""
import argparse
import os
import sys
import threading
import time

import numpy as np
import gi

gi.require_version('Gst', '1.0')
from gi.repository import Gst  # noqa: E402

BAND0, BAND1, BARS = 0.35, 0.65, 18


def code_for(n):
    n12 = n & 0xFFF
    check = (((n12 >> 8) + (n12 >> 4) + n12) & 0xF) ^ 0x5
    return (n12 << 4) | check


def backlog(src):
    """Whether the sink is two frames behind: skip this frame rather than
    queue it. Unbounded, a 29.5 MB frame every 16.7 ms filled RAM and swap in
    a minute when the sink fell behind, and set off the OOM killer on the dev
    box. (A leaky appsrc queue instead starved the capture to about one frame
    a second.) A skipped frame's counter is not logged, so it reads as a source
    gap, never as a loss downstream."""
    return src.get_property('current-level-bytes') >= 2 * src.get_property('caps').get_structure(0).get_value('width') \
        * src.get_property('caps').get_structure(0).get_value('height') * 4


def mono_us():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000


def background(w, h):
    """A tall page (2h) that scrolls: text-like rows, panels, gradients."""
    from PIL import Image, ImageDraw, ImageFont
    tall = 2 * h
    img = Image.new('RGB', (w, tall), (22, 26, 30))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('DejaVuSansMono.ttf', max(12, h // 60))
    except OSError:
        font = ImageFont.load_default()
    step = max(16, h // 45)
    palette = [(200, 210, 220), (120, 200, 160), (230, 170, 90), (150, 170, 240), (240, 120, 130)]
    words = 'let frame = encoder.encode(capture.next()); // stream audit paracord native media 0123456789'.split()
    y, i = 0, 0
    while y < tall:
        x = (i * 37) % (w // 6)
        line = ' '.join(words[(i + k) % len(words)] for k in range(3 + i % 9))
        d.text((40 + x, y), f'{i:05d}  {line}', fill=palette[i % len(palette)], font=font)
        if i % 23 == 0:
            d.rectangle([w // 2, y, w // 2 + w // 5, y + step * 3], fill=(40 + i % 60, 60, 90))
        y += step
        i += 1
    arr = np.asarray(img, dtype=np.uint8)
    # A soft horizontal gradient so the page is not flat.
    grad = np.linspace(0, 40, w, dtype=np.float32)[None, :, None]
    arr = np.clip(arr.astype(np.float32) + grad, 0, 255).astype(np.uint8)
    bgrx = np.empty((tall, w, 4), dtype=np.uint8)
    bgrx[..., 0] = arr[..., 2]
    bgrx[..., 1] = arr[..., 1]
    bgrx[..., 2] = arr[..., 0]
    bgrx[..., 3] = 255
    return bgrx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--w', type=int, default=5120)
    ap.add_argument('--h', type=int, default=1440)
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--log', required=True)
    ap.add_argument('--node', default='sa-pattern')
    ap.add_argument('--audio', action='store_true')
    ap.add_argument('--burst-every', type=int, default=120)
    ap.add_argument('--scroll', type=int, default=3, help='page scroll per frame, px')
    ap.add_argument('--prerender', type=int, default=0,
                    help='cycle N pre-rendered scroll positions, built from shared GStreamer '
                         'memories (no per-frame pixel copies in Python): holds 60 fps at '
                         '5120x1440 on a loaded machine. The page then repeats every N frames.')
    args = ap.parse_args()

    Gst.init(None)
    W, H, fps = args.w, args.h, args.fps
    log = open(args.log, 'a', buffering=1)
    log.write(f'PATTERN t={mono_us()} w={W} h={H} fps={fps} pid={os.getpid()}\n')

    fr = f'{int(fps * 1000)}/1000'
    video = Gst.parse_launch(
        f'appsrc name=src is-live=true format=time do-timestamp=false '
        f'caps=video/x-raw,format=BGRx,width={W},height={H},framerate={fr} '
        f'! pipewiresink name=sink mode=provide sync=false client-name={args.node} '
        f'stream-properties="props,node.name={args.node},node.description=stream-audit-pattern,media.class=Video/Source"')
    src = video.get_by_name('src')
    video.set_state(Gst.State.PLAYING)

    bg = background(W, H)
    rows = [int(H * (BAND0 + (BAND1 - BAND0) * k / BARS)) for k in range(BARS + 1)]
    red = np.array([0, 0, 255, 255], np.uint8)
    blue = np.array([255, 0, 0, 255], np.uint8)
    white = np.array([255, 255, 255, 255], np.uint8)
    black = np.array([0, 0, 0, 255], np.uint8)
    frame = np.empty((H, W, 4), np.uint8)
    for k, color in ((0, red), (BARS - 1, blue)):
        frame[rows[k]:rows[k + 1]] = color
    box = max(32, H // 7)

    pre = None
    if args.prerender > 0:
        # Per position k the page above and below the band (with the moving
        # block), and per bar a white and a black slab, as bytes; a frame is
        # written into one of a ring of buffers by C copies (Gst.Buffer.fill),
        # with no per-frame pixel work in Python.
        def rows_bytes(a):
            return np.ascontiguousarray(a).tobytes()
        tops, bottoms = [], []
        for k in range(args.prerender):
            off = (k * args.scroll) % H
            page = bg[off:off + H].copy()
            bx = int((k * 9) % max(1, W - box))
            page[H // 8:H // 8 + box, bx:bx + box] = (40, 140, 240, 255)
            tops.append(rows_bytes(page[:rows[0]]))
            bottoms.append(rows_bytes(page[rows[-1]:]))
        stride = W * 4
        slabs = [(rows_bytes(np.broadcast_to(white, (rows[k + 2] - rows[k + 1], W, 4))),
                  rows_bytes(np.broadcast_to(black, (rows[k + 2] - rows[k + 1], W, 4)))) for k in range(16)]
        red_slab = rows_bytes(np.broadcast_to(red, (rows[1] - rows[0], W, 4)))
        blue_slab = rows_bytes(np.broadcast_to(blue, (rows[-1] - rows[-2], W, 4)))
        ring = [Gst.Buffer.new_allocate(None, H * stride, None) for _ in range(8)]
        pre = (tops, bottoms, slabs, red_slab, blue_slab, ring, stride)

    t0 = mono_us() + 200_000
    if args.audio:
        threading.Thread(target=audio_thread, args=(t0, fps, args.burst_every, log), daemon=True).start()

    n = 0
    period = 1_000_000 / fps
    try:
        while True:
            if pre is not None:
                tops, bottoms, slabs, red_slab, blue_slab, ring, stride = pre
                due = t0 + n * period
                wait = due - mono_us()
                if wait > 0:
                    time.sleep(wait / 1e6)
                k = n % len(tops)
                code = code_for(n)
                buf = ring[n % len(ring)]
                if buf.fill(0, tops[k]) != len(tops[k]):
                    # Still held downstream (not writable): a fresh buffer.
                    buf = Gst.Buffer.new_allocate(None, H * stride, None)
                    ring[n % len(ring)] = buf
                    buf.fill(0, tops[k])
                buf.fill(rows[0] * stride, red_slab)
                for b in range(16):
                    buf.fill(rows[b + 1] * stride, slabs[b][0 if (code >> (15 - b)) & 1 else 1])
                buf.fill(rows[-2] * stride, blue_slab)
                buf.fill(rows[-1] * stride, bottoms[k])
                buf.pts = int(n * period * 1000)
                buf.duration = int(period * 1000)
                t = mono_us()
                if not backlog(src):
                    src.emit('push-buffer', buf)
                    log.write(f'SRC n={n} t={t} due={int(due)}\n')
                n += 1
                continue
            due = t0 + n * period
            wait = due - mono_us()
            if wait > 0:
                time.sleep(wait / 1e6)
            off = (n * args.scroll) % H
            frame[:rows[0]] = bg[off:off + rows[0]]
            frame[rows[-1]:] = bg[off + rows[-1]:off + H]
            bx = int((n * 9) % max(1, W - box))
            frame[H // 8:H // 8 + box, bx:bx + box] = (40, 140, 240, 255)
            code = code_for(n)
            for k in range(16):
                frame[rows[k + 1]:rows[k + 2]] = white if (code >> (15 - k)) & 1 else black
            buf = Gst.Buffer.new_wrapped(frame.tobytes())
            buf.pts = int(n * period * 1000)
            buf.duration = int(period * 1000)
            t = mono_us()
            if not backlog(src):
                src.emit('push-buffer', buf)
                log.write(f'SRC n={n} t={t} due={int(due)}\n')
            n += 1
    except KeyboardInterrupt:
        pass
    finally:
        video.set_state(Gst.State.NULL)


def audio_thread(t0, fps, every, log):
    rate, block = 48000, 480  # 10 ms blocks
    pipe = Gst.parse_launch(
        'appsrc name=a is-live=true format=time caps=audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved '
        '! pulsesink name=out client-name=sa-pattern-audio buffer-time=40000 latency-time=10000 sync=false '
        'stream-properties="props,application.name=sa-pattern-audio"')
    a = pipe.get_by_name('a')
    pipe.set_state(Gst.State.PLAYING)
    burst_len = int(0.040 * rate)
    tone = (0.5 * np.sin(2 * np.pi * 1000 * np.arange(burst_len) / rate)).astype(np.float32)
    period_us = 1_000_000 / fps
    next_burst_n = 0
    sample = 0
    while True:
        due = t0 + sample * 1_000_000 / rate
        wait = due - mono_us()
        if wait > 0:
            time.sleep(wait / 1e6)
        blk = np.zeros((block, 2), np.float32)
        # Bursts that overlap this block.
        while True:
            burst_t = t0 + next_burst_n * period_us
            bs = int(round((burst_t - t0) * rate / 1_000_000))
            if bs >= sample + block:
                break
            if bs + burst_len > sample:
                if bs >= sample:
                    log.write(f'ASRC n={next_burst_n} t={int(burst_t)}\n')
                lo = max(bs, sample)
                hi = min(bs + burst_len, sample + block)
                blk[lo - sample:hi - sample, 0] = tone[lo - bs:hi - bs]
                blk[lo - sample:hi - sample, 1] = tone[lo - bs:hi - bs]
            if bs + burst_len <= sample + block:
                next_burst_n += every
            else:
                break
        buf = Gst.Buffer.new_wrapped(blk.tobytes())
        a.emit('push-buffer', buf)
        sample += block


if __name__ == '__main__':
    sys.exit(main())
