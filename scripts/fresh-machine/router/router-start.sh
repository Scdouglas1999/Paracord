#!/bin/bash
# Router boot: find the lan/wan interfaces by address, turn on forwarding and
# masquerade, then keep miniupnpd running in the mode router-ctl last chose.
# Env: LAN_IP (e.g. 192.168.50.1), WAN_IP (e.g. 203.0.113.1), WAN_GW (docker
# gateway on the wan side), UPNP_MODE (allow | deny | off),.
set -euo pipefail
: "${LAN_IP:?}" "${WAN_IP:?}" "${UPNP_MODE:=allow}"

iface_of() { ip -4 -o addr show | awk -v ip="$1" '{split($4,a,"/"); if (a[1]==ip) print $2}'; }
for _ in $(seq 1 50); do
  LAN_IF=$(iface_of "$LAN_IP"); WAN_IF=$(iface_of "$WAN_IP")
  [[ -n "$LAN_IF" && -n "$WAN_IF" ]] && break
  sleep 0.2
done
[[ -n "${LAN_IF:-}" && -n "${WAN_IF:-}" ]] || { echo "router: lan ($LAN_IP) or wan ($WAN_IP) interface missing" >&2; ip addr >&2; exit 1; }
LAN_NET=$(ip -4 -o addr show dev "$LAN_IF" | awk '{print $4}')
echo "router: lan $LAN_IF $LAN_NET, wan $WAN_IF $WAN_IP"
mkdir -p /run/router
printf 'LAN_IF=%s\nWAN_IF=%s\nLAN_NET=%s\nWAN_IP=%s\n' "$LAN_IF" "$WAN_IF" "$LAN_NET" "$WAN_IP" > /run/router/ifaces
printf '%s\n' "$UPNP_MODE" > /run/router/mode

# The default route leaves through the wan side.
if [[ -n "${WAN_GW:-}" ]]; then ip route replace default via "$WAN_GW" dev "$WAN_IF"; fi

# nftables: miniupnpd's own structure (table inet filter: forward policy drop
# jumping to its chain, nat prerouting/postrouting jumping to its chains),
# plus what a home router does anyway: lan -> wan forwarded and masqueraded,
# replies let back in. Nothing else from the wan side gets in unless
# miniupnpd mapped it.
/etc/miniupnpd/nft-scripts/nft_init.sh
nft add rule inet filter forward ct state established,related accept
nft add rule inet filter forward iifname "$LAN_IF" oifname "$WAN_IF" accept
nft add rule inet filter postrouting ip saddr "$LAN_NET" oifname "$WAN_IF" masquerade

/usr/local/bin/router-ctl write-conf
trap 'pkill -TERM -x miniupnpd; exit 0' TERM INT
while true; do
  if [[ "$(cat /run/router/mode)" == off ]]; then sleep 0.5; continue; fi
  /usr/local/bin/router-ctl write-conf
  echo "router: miniupnpd starting, mode $(cat /run/router/mode)"
  miniupnpd -d -f /run/router/miniupnpd.conf &
  wait $! || true
  sleep 0.3
done
