#!/usr/bin/env bash
# uplinkstep.sh <loss %> [rate]: inside the lab's private network namespace,
# 15 ms of delay on every leg to and from the relay's UDP port
# ($SA_RELAY_UDP, default 18811), and <loss %> random loss plus, with [rate]
# (e.g. 10mbit), a rate limit on the SENDER's uplink only: an HTB class at
# that rate whose leaf is a ~100 ms drop-tail queue (a home router's uplink).
# Without [rate] the uplink class runs at 10 Gb/s.
#
# The first call attaches the uplink band to a tree whose other legs already
# have their delay (the lab's legs.sh, run before the share), or builds the
# whole tree (flushing whatever netem held); later calls change the rate and
# loss in place. The sender is found from
# $SA_RUN/sender/app.pid (campaign --net-cmd).
set -eu
loss=$1 rate=${2:-10000mbit}
relay=${SA_RELAY_UDP:-18811}
mbit=${rate%mbit}
pkts=$(( mbit * 1000000 / 8 / 10 / 1400 )); [ "$pkts" -lt 20 ] && pkts=20; [ "$pkts" -gt 20000 ] && pkts=20000
# SA_UPLINK_SHAPER=netem: the uplink is netem's own rate limiter (no HTB).
shaper=${SA_UPLINK_SHAPER:-htb}
if tc qdisc show dev lo | grep -q "netem 21:"; then
  if [ "$shaper" = netem ]; then
    tc qdisc change dev lo parent 1:2 handle 21: netem delay 15ms loss "${loss}%" rate "$rate" limit "$pkts"
  else
    tc class change dev lo parent 20: classid 20:1 htb rate "$rate" ceil "$rate" burst 15k cburst 15k quantum 1514
    tc qdisc change dev lo parent 20:1 handle 21: netem delay 15ms loss "${loss}%" limit "$pkts"
  fi
  exit 0
fi
tree() { local p; for p in $(pgrep -P "$1"); do tree "$p"; done; echo "$1"; }
pids=$(tree "$(cat "${SA_RUN:?set SA_RUN to the run dir}/sender/app.pid")")
ports=$(ss -uapnH | while read -r _ _ _ local _ users; do
  for p in $pids; do case $users in *"pid=$p,"*) echo "${local##*:}";; esac; done
done | sort -u)
[ -n "$ports" ] || { echo "uplinkstep: no UDP socket of the sender found" >&2; exit 1; }
# A tree with the other legs' delay already in place (the lab built it before
# the share started, so nothing in flight is flushed now): attach the uplink
# band to it.
if tc qdisc show dev lo | grep -q "netem 30:"; then
  if [ "$shaper" = netem ]; then
    tc qdisc add dev lo parent 1:2 handle 21: netem delay 15ms loss "${loss}%" rate "$rate" limit "$pkts"
  else
    tc qdisc add dev lo parent 1:2 handle 20: htb default 1
    tc class add dev lo parent 20: classid 20:1 htb rate "$rate" ceil "$rate" burst 15k cburst 15k quantum 1514
    tc qdisc add dev lo parent 20:1 handle 21: netem delay 15ms loss "${loss}%" limit "$pkts"
  fi
  for p in $ports; do
    tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 17 0xff \
      match ip sport "$p" 0xffff match ip dport "$relay" 0xffff flowid 1:2
  done
  exit 0
fi
# wire-sized packets through the shaper (quinn sends UDP GSO batches, which
# lo would otherwise carry as one 64 KB packet)
ethtool -K lo tx-udp-segmentation off gso off tso off >/dev/null 2>&1 || true
tc qdisc del dev lo root 2>/dev/null || true
tc qdisc add dev lo root handle 1: prio bands 3 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
if [ "$shaper" = netem ]; then
  tc qdisc add dev lo parent 1:2 handle 21: netem delay 15ms loss "${loss}%" rate "$rate" limit "$pkts"
else
  tc qdisc add dev lo parent 1:2 handle 20: htb default 1
  tc class add dev lo parent 20: classid 20:1 htb rate "$rate" ceil "$rate" burst 15k cburst 15k quantum 1514
  tc qdisc add dev lo parent 20:1 handle 21: netem delay 15ms loss "${loss}%" limit "$pkts"
fi
tc qdisc add dev lo parent 1:3 handle 30: netem delay 15ms limit "${SA_OTHER_LEGS_LIMIT:-1000}"
for p in $ports; do
  tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 17 0xff \
    match ip sport "$p" 0xffff match ip dport "$relay" 0xffff flowid 1:2
done
tc filter add dev lo parent 1:0 protocol ip prio 2 u32 match ip protocol 17 0xff match ip sport "$relay" 0xffff flowid 1:3
tc filter add dev lo parent 1:0 protocol ip prio 3 u32 match ip protocol 17 0xff match ip dport "$relay" 0xffff flowid 1:3
