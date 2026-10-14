#!/usr/bin/env python3
"""lvlrec.py <target node> <log>: RMS of a sink's monitor every 50 ms, stamped with CLOCK_MONOTONIC us at buffer arrival."""
import sys, time
import numpy as np
import gi
gi.require_version('Gst', '1.0')
from gi.repository import GLib, Gst
target, path = sys.argv[1], sys.argv[2]
Gst.init(None)
log = open(path, 'a', buffering=1)
pipe = Gst.parse_launch(
    f'pipewiresrc target-object={target} do-timestamp=true '
    'stream-properties="props,stream.capture.sink=true,node.name=v7-lvlrec" '
    '! audioconvert ! audio/x-raw,format=F32LE,rate=48000,channels=1 '
    '! appsink name=sink emit-signals=true sync=false max-buffers=200')
sink = pipe.get_by_name('sink')
acc = []
def on_sample(s):
    global acc
    sample = s.emit('pull-sample'); buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    if not ok: return Gst.FlowReturn.OK
    data = np.frombuffer(info.data, dtype=np.float32).copy(); buf.unmap(info)
    now = time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000
    acc.append(data)
    total = np.concatenate(acc)
    while len(total) >= 2400:
        chunk, total = total[:2400], total[2400:]
        log.write(f"{now} {float(np.sqrt(np.mean(chunk * chunk))):.4f}\n")
    acc = [total]
    return Gst.FlowReturn.OK
sink.connect('new-sample', on_sample)
pipe.set_state(Gst.State.PLAYING)
GLib.MainLoop().run()
