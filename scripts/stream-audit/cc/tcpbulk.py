#!/usr/bin/env python3
"""A competing bulk TCP flow (Cubic), the lab's stand-in for iperf3.
tcpbulk.py server <bind ip> <port>          prints {"t","mbps"} once a second
tcpbulk.py client <ip> <port> <seconds> [cc]
"""
import json, socket, sys, time

def server(ip, port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((ip, int(port))); s.listen(4)
    while True:
        c, _ = s.accept(); start = last = time.monotonic(); n = 0
        while True:
            b = c.recv(1 << 20)
            if not b: break
            n += len(b); now = time.monotonic()
            if now - last >= 1.0:
                print(json.dumps({"side": "tcp", "t": round(now - start, 1), "mbps": round(n * 8 / 1e6 / (now - last), 2)}), flush=True)
                n = 0; last = now
        c.close()

def client(ip, port, seconds, cc="cubic"):
    s = socket.socket(); s.setsockopt(socket.IPPROTO_TCP, socket.TCP_CONGESTION, cc.encode())
    s.connect((ip, int(port))); buf = b"\0" * (256 << 10); end = time.monotonic() + float(seconds)
    while time.monotonic() < end:
        s.sendall(buf)
    s.close()

if __name__ == "__main__":
    {"server": server, "client": client}[sys.argv[1]](*sys.argv[2:])
