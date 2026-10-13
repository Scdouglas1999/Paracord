# The lab router's one change to miniupnpd 2.3.9.
#
# With ext_allow_private_ipv4=yes, GetExternalIPAddress blanks a private or
# reserved wan address (the flag test in upnpsoap.c is inverted upstream),
# while NAT-PMP and PCP report it. The lab's "public" side is TEST-NET-3
# (203.0.113.0/24) and its carrier-grade NAT side is 100.64.0.0/10, so UPnP
# would never report either address. Real routers with a public address, or
# behind carrier-grade NAT, do report theirs; so does the lab's after this.
p = "upnpsoap.c"
s = open(p).read()
old = 'syslog(LOG_NOTICE, "private/reserved address %s is not suitable for external IP", ext_ip_addr);\n\t\t\t\text_ip_addr[0] = \'\\0\';'
assert old in s, "miniupnpd source changed; revisit lab-patch.py"
s = s.replace(old, 'syslog(LOG_NOTICE, "lab: reporting the wan address %s", ext_ip_addr);')
open(p, "w").write(s)
