#!/usr/bin/env bash
# Three private network namespaces in a private user namespace (no root; the
# host network is untouched): A (sender, 10.9.1.1) -- R (router) -- B
# (receiver, 10.9.2.2). The bottleneck is R's egress toward B, a router queue,
# so the senders feel no local socket backpressure.
#   netns.sh up <dir> | in <dir> a|r|b <cmd...> | shape <dir> <mbit> <rtt ms> <queue ms> <loss %> | down <dir>
# shape: R -> B is an HTB class at <mbit> whose leaf is a drop-tail netem queue
# of <queue ms> at that rate (1514-byte packets) with <loss %> random loss;
# R -> A (the return path) delays everything by the whole round trip and drops
# <loss %> too.
set -euo pipefail
cmd=$1; d=$2; shift 2
nsx() { local p=$1; shift; nsenter --preserve-credentials -t "$(cat "$d/$p.pid")" -U -n -- "$@"; }
case $cmd in
up)
  mkdir -p "$d"
  nohup unshare -rn sleep infinity >/dev/null 2>&1 & echo $! > "$d/a.pid"; sleep 0.3
  # nsenter and unshare exec, so $! is the sleep holding each namespace
  for n in r b; do
    nohup nsenter --preserve-credentials -t "$(cat "$d/a.pid")" -U -- unshare -n sleep infinity >/dev/null 2>&1 &
    echo $! > "$d/$n.pid"; sleep 0.3
  done
  for n in a r b; do nsx $n ip link set lo up; done
  nsx a ip link add a0 type veth peer name r0 netns "$(cat "$d/r.pid")"
  nsx r ip link add r1 type veth peer name b0 netns "$(cat "$d/b.pid")"
  nsx a ip addr add 10.9.1.1/24 dev a0; nsx a ip link set a0 up
  nsx r ip addr add 10.9.1.2/24 dev r0; nsx r ip link set r0 up
  nsx r ip addr add 10.9.2.1/24 dev r1; nsx r ip link set r1 up
  nsx b ip addr add 10.9.2.2/24 dev b0; nsx b ip link set b0 up
  nsx a ip route add default via 10.9.1.2
  nsx b ip route add default via 10.9.2.1
  nsx r sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  # wire-sized packets through the shaper: no TSO/GSO/UDP-GSO super-packets, no GRO
  for x in a:a0 r:r0 r:r1 b:b0; do
    nsx "${x%%:*}" ethtool -K "${x##*:}" gro off gso off tso off tx-udp-segmentation off >/dev/null
  done
  for n in a b; do nsx $n sh -c 'echo "0 2147483647" > /proc/sys/net/ipv4/ping_group_range' 2>/dev/null || true; done
  echo "a=$(cat "$d/a.pid") r=$(cat "$d/r.pid") b=$(cat "$d/b.pid")";;
in) side=$1; shift; exec nsenter --preserve-credentials -t "$(cat "$d/$side.pid")" -U -n -- "$@";;
shape)
  mbit=$1 rtt=$2 qms=$3 loss=$4
  pkts=$(( mbit * 1000000 / 8 * qms / 1000 / 1514 )); [ $pkts -lt 10 ] && pkts=10
  nsx r tc qdisc del dev r1 root 2>/dev/null || true
  nsx r tc qdisc del dev r0 root 2>/dev/null || true
  nsx r tc qdisc add dev r1 root handle 1: htb default 10
  nsx r tc class add dev r1 parent 1: classid 1:10 htb rate ${mbit}mbit ceil ${mbit}mbit burst 15k cburst 15k quantum 1514
  nsx r tc qdisc add dev r1 parent 1:10 handle 10: netem loss ${loss}% limit $pkts
  nsx r tc qdisc add dev r0 root netem delay ${rtt}ms loss ${loss}% limit 100000
  echo "shaped: ${mbit} Mb/s, rtt ${rtt} ms, queue ${qms} ms (${pkts} packets), loss ${loss}%";;
stats) nsx r tc -s qdisc show dev r1;;
down)
  for n in b r a; do kill "$(cat "$d/$n.pid")" 2>/dev/null || true; rm -f "$d/$n.pid"; done;;
esac
