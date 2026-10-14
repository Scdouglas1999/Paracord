#!/usr/bin/env bash
# scenario.sh <ns dir> <out dir> <cc> <mbit> <rtt ms> <queue ms> <loss %> <offered Mb/s> [tcp 0|1]
# Timeline (s): 0-5 idle (ping baseline) | 5-15 TCP alone | 15-90 media, TCP
# until 75 | 75-90 media alone. Without TCP: 0-5 idle, 5-65 media.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ns=$1 out=$2 cc=$3 mbit=$4 rtt=$5 qms=$6 loss=$7 offered=$8 tcp=${9:-1}
bin=${CC_LAB_BIN:?set CC_LAB_BIN to the cc_lab example binary}
N="$here/netns.sh"
mkdir -p "$out"
"$N" shape "$ns" "$mbit" "$rtt" "$qms" "$loss" > "$out/shape.txt"
export CC_LAB_CERT=$out/cert.der
"$N" in "$ns" b env CC_LAB_CERT="$CC_LAB_CERT" "$bin" recv 10.9.2.2:4433 > "$out/recv.jsonl" 2>"$out/recv.err" & rp=$!
"$N" in "$ns" b python3 "$here/tcpbulk.py" server 10.9.2.2 5201 > "$out/tcp.jsonl" & tp=$!
sleep 1
"$N" in "$ns" a ping -i 0.1 -D 10.9.2.2 > "$out/ping.txt" & pp=$!
echo "idle $(date +%s.%N)" > "$out/marks.txt"
sleep 5
if [ "$tcp" = 1 ]; then
  echo "tcp $(date +%s.%N)" >> "$out/marks.txt"
  "$N" in "$ns" a python3 "$here/tcpbulk.py" client 10.9.2.2 5201 70 cubic & cp=$!
  sleep 10
  echo "media $(date +%s.%N)" >> "$out/marks.txt"
  "$N" in "$ns" a env CC_LAB_CERT="$CC_LAB_CERT" "$bin" send 10.9.2.2:4433 "$cc" "$offered" 75 > "$out/send.jsonl" 2>"$out/send.err"
  wait $cp 2>/dev/null
else
  echo "media $(date +%s.%N)" >> "$out/marks.txt"
  "$N" in "$ns" a env CC_LAB_CERT="$CC_LAB_CERT" "$bin" send 10.9.2.2:4433 "$cc" "$offered" 60 > "$out/send.jsonl" 2>"$out/send.err"
fi
sleep 1
kill $pp $rp $tp 2>/dev/null; wait 2>/dev/null
echo "$cc $mbit $rtt $qms $loss $offered tcp=$tcp" > "$out/params.txt"
