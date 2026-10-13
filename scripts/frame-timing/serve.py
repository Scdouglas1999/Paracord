#!/usr/bin/env python3
"""serve.py <port> <query> [marklog]: serve this directory for the frame-timing gate.

- `/` redirects to `/frame-test.html?<query>`, so a desktop build whose devUrl
  is `http://localhost:<port>` opens the test page with the run's parameters.
- `POST /mark` appends "[mark t=<CLOCK_MONOTONIC µs>] <body>" to marklog, for a
  browser that has neither WebKit message handlers nor Tauri's IPC.
"""
import functools
import os
import socket
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

port, query = int(sys.argv[1]), sys.argv[2]
marklog = sys.argv[3] if len(sys.argv) > 3 else None
root = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', f'/frame-test.html?{query}')
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        t = time.monotonic_ns() // 1000
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8', 'replace')
        if marklog:
            with open(marklog, 'a') as f:
                f.write(f'[mark t={t}] {body}\n')
        self.send_response(204)
        self.end_headers()


class Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


Server(('::', port), functools.partial(Handler, directory=root)).serve_forever()
