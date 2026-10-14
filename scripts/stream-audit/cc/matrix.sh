#!/usr/bin/env bash
# matrix.sh <ns dir> <out root> <reps> <cc,cc,...> <config>...
# config = mbit:rtt:queue_ms:loss:offered:tcp(0|1)
set -u
here=$(cd "$(dirname "$0")" && pwd)
ns=$1 root=$2 reps=$3 ccs=$4; shift 4
for cfg in "$@"; do
  IFS=: read -r mbit rtt q loss off tcp <<<"$cfg"
  for r in $(seq 1 "$reps"); do
    for cc in ${ccs//,/ }; do
      out="$root/${mbit}m-${rtt}ms-q${q}-l${loss}-o${off}-t${tcp}/$cc-$r"
      [ -f "$out/params.txt" ] && continue
      echo "$(date +%T) $out"
      "$here/scenario.sh" "$ns" "$out" "$cc" "$mbit" "$rtt" "$q" "$loss" "$off" "$tcp" >/dev/null 2>&1
    done
  done
done
echo done
