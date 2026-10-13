#!/usr/bin/env python3
"""gpucheck.py <client root pid> <wayland-info output file>: assert, from /proc
and /sys, that the nested compositor and the client both run on the NVIDIA GPU.

A run on the wrong GPU is the trap earlier passes fell into: KWin's virtual
backend renders on the first DRM device libdrm lists (the AMD iGPU on the dev
box), and the client's EGL follows the compositor. Numbers from such a run
say nothing about the owner's machine, so the gate fails instead.

Checks:
- the compositor's main device (wayland-info, linux-dmabuf feedback) is an
  NVIDIA DRM node;
- every process of the client tree that holds a DRM node holds only NVIDIA
  nodes;
- WebKit's web process and at least one other client process (the UI
  process) have NVIDIA's EGL driver (libnvidia-eglcore) mapped.

Prints one line per process and a verdict; exits 1 on any failed check.
"""
import os
import re
import sys

root, wayland_info = int(sys.argv[1]), sys.argv[2]


def nvidia_nodes():
    nodes = {}
    for name in os.listdir('/sys/class/drm'):
        if not re.fullmatch(r'(renderD|card)\d+', name):
            continue
        try:
            vendor = open(f'/sys/class/drm/{name}/device/vendor').read().strip()
            rdev = os.stat(f'/dev/dri/{name}').st_rdev
        except OSError:
            continue
        nodes[name] = (vendor == '0x10de', rdev)
    return nodes


def tree(pid):
    kids = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                ppid = int(open(f'/proc/{name}/stat').read().rsplit(')', 1)[1].split()[1])
            except OSError:
                continue
            kids.setdefault(ppid, []).append(int(name))
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        out.append(p)
        todo += kids.get(p, [])
    return out


nodes = nvidia_nodes()
if not any(is_nv for is_nv, _ in nodes.values()):
    print('[gpu] FAIL: no NVIDIA DRM node on this machine')
    sys.exit(1)
failures = []

# The compositor.
info = open(wayland_info, errors='replace').read()
m = re.search(r'main device: 0x([0-9A-Fa-f]+)', info)
if not m:
    failures.append('the compositor reported no main device (wayland-info)')
else:
    dev = int(m[1], 16)
    hit = [n for n, (is_nv, rdev) in nodes.items() if rdev == dev]
    nv = [n for n in hit if nodes[n][0]]
    print(f'[gpu] compositor main device 0x{dev:X} = {",".join(hit) or "?"}')
    if not nv:
        failures.append(f'the compositor renders on {",".join(hit) or hex(dev)}, not on NVIDIA')

# The client.
eglcore_ui, eglcore_web, webs = False, False, 0
for pid in tree(root):
    try:
        comm = open(f'/proc/{pid}/comm').read().strip()
        fds = os.listdir(f'/proc/{pid}/fd')
        maps = open(f'/proc/{pid}/maps').read()
    except OSError:
        continue
    held = set()
    for fd in fds:
        try:
            target = os.readlink(f'/proc/{pid}/fd/{fd}')
        except OSError:
            continue
        if target.startswith('/dev/dri/'):
            held.add(target[len('/dev/dri/'):])
    eglcore = 'libnvidia-eglcore' in maps
    mesa = 'libEGL_mesa' in maps or 'libgallium' in maps
    print(f'[gpu] {pid} {comm}: nodes {",".join(sorted(held)) or "-"}'
          f'{" nvidia-egl" if eglcore else ""}{" mesa" if mesa else ""}')
    wrong = [n for n in held if n in nodes and not nodes[n][0]]
    if wrong:
        failures.append(f'{comm} ({pid}) holds a non-NVIDIA DRM node: {",".join(wrong)}')
    if comm.startswith('WebKitWebProces'):
        webs += 1
        eglcore_web |= eglcore
    elif comm not in ('bwrap', 'timeout', 'env', 'xdg-dbus-proxy') and not comm.startswith('WebKit'):
        eglcore_ui |= eglcore
if not webs:
    failures.append('no WebKitWebProcess in the client tree')
elif not eglcore_web:
    failures.append("WebKit's web process did not load NVIDIA's EGL")
if not eglcore_ui:
    failures.append("the UI process did not load NVIDIA's EGL")

for f in failures:
    print(f'[gpu] FAIL: {f}')
print('[gpu] verdict: ' + ('FAIL' if failures else 'PASS (compositor and client on NVIDIA)'))
sys.exit(1 if failures else 0)
