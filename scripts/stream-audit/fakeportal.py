#!/usr/bin/env python3
"""fakeportal.py: a stand-in org.freedesktop.portal.Desktop ScreenCast on a
private session bus, for the stream audit only.

The app's Linux capture (scap) asks the desktop portal for a screen: it creates
a session, selects sources, starts, and connects to the PipeWire node id the
portal answers with (on its own default PipeWire remote, PIPEWIRE_REMOTE). This
answers every request at once with the synthetic source (pattern.py's node), so
no real portal, picker or screen is involved. Never run it on a real bus.

  PIPEWIRE_REMOTE=<graph> python3 fakeportal.py --node sa-pattern --log portal.log
"""
import argparse
import json
import os
import subprocess
import time

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

XML = '''
<node>
  <interface name="org.freedesktop.portal.ScreenCast">
    <method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    <method name="OpenPipeWireRemote"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
    <property name="AvailableSourceTypes" type="u" access="read"/>
    <property name="AvailableCursorModes" type="u" access="read"/>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--node', default='sa-pattern')
    ap.add_argument('--log', required=True)
    args = ap.parse_args()
    log = open(args.log, 'a', buffering=1)

    def say(msg):
        log.write(f'{time.clock_gettime_ns(time.CLOCK_MONOTONIC) // 1000} {msg}\n')

    def node_info():
        dump = json.loads(subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=10).stdout or '[]')
        for obj in dump:
            props = (obj.get('info') or {}).get('props') or {}
            if obj.get('type') == 'PipeWire:Interface:Node' and props.get('node.name') == args.node:
                return obj['id']
        return None

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
    serial = [0]

    def request_path(sender, options):
        token = options.get('handle_token', f'sa{serial[0]}')
        serial[0] += 1
        return f'/org/freedesktop/portal/desktop/request/{sender[1:].replace(".", "_")}/{token}'

    def respond_later(path, results):
        def fire():
            bus.emit_signal(None, path, 'org.freedesktop.portal.Request', 'Response',
                            GLib.Variant('(ua{sv})', (0, results)))
            say(f'response {path} {list(results.keys())}')
            return False
        # The caller subscribes to the request path after the call returns.
        GLib.timeout_add(300, fire)

    def on_call(conn, sender, path, iface, method, params, invocation):
        p = params.unpack()
        say(f'call {method} from {sender}')
        if method == 'CreateSession':
            opts = p[0]
            req = request_path(sender, opts)
            session = f'/org/freedesktop/portal/desktop/session/{sender[1:].replace(".", "_")}/{opts.get("session_handle_token", "sa")}'
            invocation.return_value(GLib.Variant('(o)', (req,)))
            respond_later(req, {'session_handle': GLib.Variant('s', session)})
        elif method == 'SelectSources':
            req = request_path(sender, p[1])
            say(f'select types={p[1].get("types")} cursor_mode={p[1].get("cursor_mode")} multiple={p[1].get("multiple")}')
            invocation.return_value(GLib.Variant('(o)', (req,)))
            respond_later(req, {})
        elif method == 'Start':
            req = request_path(sender, p[2])
            node = None
            for _ in range(50):
                node = node_info()
                if node is not None:
                    break
                time.sleep(0.1)
            say(f'start -> node {node}')
            invocation.return_value(GLib.Variant('(o)', (req,)))
            if node is None:
                bus.emit_signal(None, req, 'org.freedesktop.portal.Request', 'Response',
                                GLib.Variant('(ua{sv})', (2, {})))
                return
            streams = GLib.Variant('a(ua{sv})', [(node, {'source_type': GLib.Variant('u', 1)})])
            respond_later(req, {'streams': streams})
        else:
            invocation.return_dbus_error('org.freedesktop.portal.Error.NotSupported', f'{method} is not provided by the audit portal')

    def on_get(conn, sender, path, iface, prop):
        return GLib.Variant('u', {'AvailableSourceTypes': 3, 'AvailableCursorModes': 7, 'version': 4}[prop])

    bus.register_object('/org/freedesktop/portal/desktop', info, on_call, on_get, None)
    Gio.bus_own_name_on_connection(bus, 'org.freedesktop.portal.Desktop', Gio.BusNameOwnerFlags.NONE,
                                   lambda *a: say('name acquired'), lambda *a: say('name lost'))
    say(f'fake portal up (pid {os.getpid()}, bus {os.environ.get("DBUS_SESSION_BUS_ADDRESS")})')
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
