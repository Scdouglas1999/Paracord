#!/usr/bin/env python3
"""audiorec.py <target node> <log>: record a sink's monitor in a private graph
(PIPEWIRE_REMOTE) and log the onset of every tone burst pattern.py made.

Lines: "BURST t=<CLOCK_MONOTONIC µs of the onset> peak=<0..1>" and, once a
second, "LEVEL t= rms=" so silence (no stream audio at all) is visible too.

The onset time is taken from the buffer's arrival (CLOCK_MONOTONIC when the
appsink gets it) minus the time of the samples after the first loud one. The
pipeline clock is not used: in a graph driven by PipeWire's dummy driver it
drifts against CLOCK_MONOTONIC by about 0.3%. Both ends of the measurement
(the sender's capture sink and the viewer's output) use the same method, so
the delivery latency of a buffer cancels out of the audio latency.
"""
import sys
import time

import numpy as np
import gi

gi.require_version('Gst', '1.0')
from gi.repository import GLib, Gst  # noqa: E402

target, log_path = sys.argv[1], sys.argv[2]
Gst.init(None)
log = open(log_path, 'a', buffering=1)
pipe = Gst.parse_launch(
    f'pipewiresrc target-object={target} do-timestamp=true '
    'stream-properties="props,stream.capture.sink=true,node.name=sa-audiorec" '
    '! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=1 '
    '! appsink name=sink emit-signals=true sync=false max-buffers=200')
sink = pipe.get_by_name('sink')
state = {'quiet_until': 0, 'acc': [], 'last_level': 0}
clock_kind = {}


def mono_us():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000


def on_sample(appsink):
    sample = appsink.emit('pull-sample')
    buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    if not ok:
        return Gst.FlowReturn.OK
    data = np.frombuffer(info.data, dtype=np.float32).copy()
    buf.unmap(info)
    clock = pipe.get_clock()
    if 'name' not in clock_kind and clock is not None:
        clock_kind['name'] = clock.get_name()
        log.write(f'CLOCK name={clock_kind["name"]} now={clock.get_time() // 1000} mono={mono_us()}\n')
    arrival = mono_us()
    loud = np.flatnonzero(np.abs(data) > 0.2)
    if loud.size:
        first = int(loud[0])
        onset = arrival - int((len(data) - first) * 1_000_000 / 48000)
        if onset > state['quiet_until']:
            log.write(f'BURST t={onset} peak={float(np.abs(data).max()):.3f} arrival={arrival} n={len(data)}\n')
        state['quiet_until'] = onset + 500_000
    state['acc'].append(data)
    if arrival - state['last_level'] > 1_000_000:
        allx = np.concatenate(state['acc'])
        log.write(f'LEVEL t={arrival} rms={float(np.sqrt(np.mean(allx * allx))):.5f}\n')
        state['acc'] = []
        state['last_level'] = arrival
    return Gst.FlowReturn.OK


sink.connect('new-sample', on_sample)
pipe.set_state(Gst.State.PLAYING)
log.write(f'REC start t={mono_us()} target={target}\n')
try:
    GLib.MainLoop().run()
except KeyboardInterrupt:
    pass
finally:
    pipe.set_state(Gst.State.NULL)
