#!/bin/bash
# router-ctl mode allow|deny|deny-noupnp|off   switch what the router answers and restart it
# router-ctl write-conf            (used by router-start)
# router-ctl mappings              list the current port mappings
set -euo pipefail
# shellcheck disable=SC1091  # written by router-start at boot
. /run/router/ifaces
case "${1:-}" in
  write-conf)
    mode=$(cat /run/router/mode)
    # allow:        UPnP IGD + NAT-PMP/PCP, mappings for the lan granted
    # deny:         UPnP IGD + NAT-PMP/PCP answer, every mapping refused
    #               (miniupnpd answers a refused UPnP AddPortMapping with 718)
    # deny-noupnp:  UPnP turned off in the router; NAT-PMP/PCP answer and refuse
    # off:          nothing answers (handled by router-start: no daemon)
    rule="allow 1024-65535 ${LAN_NET%/*}/24 1024-65535"
    upnp=yes
    [[ "$mode" == deny || "$mode" == deny-noupnp ]] && rule="deny 0-65535 0.0.0.0/0 0-65535"
    [[ "$mode" == deny-noupnp ]] && upnp=no
    cat > /run/router/miniupnpd.conf <<CONF
ext_ifname=$WAN_IF
listening_ip=$LAN_IF
enable_natpmp=yes
enable_pcp_pmp=yes
enable_upnp=$upnp
secure_mode=yes
system_uptime=yes
notify_interval=60
clean_ruleset_interval=600
uuid=3b5c1e0a-15e1-4d8e-9c1b-5f0c2a7d9e11
# miniupnpd counts 203.0.113.0/24 (TEST-NET-3, the lab's "public" side) and
# 100.64.0.0/10 as reserved and would refuse every mapping. A real router with
# a public address (or one behind carrier-grade NAT, which still maps and
# reports its own wan address) answers, so the lab's router allows it.
ext_allow_private_ipv4=yes
$rule
deny 0-65535 0.0.0.0/0 0-65535
CONF
    ;;
  mode)
    printf '%s\n' "${2:?allow|deny|deny-noupnp|off}" > /run/router/mode
    pkill -TERM -x miniupnpd || true
    # Drop the mappings a stopped daemon leaves in the chains.
    nft flush chain inet filter miniupnpd || true
    nft flush chain inet filter prerouting_miniupnpd || true
    nft flush chain inet filter postrouting_miniupnpd || true
    echo "router: mode $2"
    ;;
  mappings)
    nft list chain inet filter prerouting_miniupnpd
    ;;
  *) echo "usage: router-ctl mode allow|deny|deny-noupnp|off | mappings" >&2; exit 2 ;;
esac
