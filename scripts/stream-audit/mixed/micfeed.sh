#!/usr/bin/env bash
# micfeed.sh <graph> <wav>: speech into the app's microphone stream (and nothing else) in a private graph.
G=$1; WAV=$2
PIPEWIRE_REMOTE=$G pw-play --target 0 -P '{ node.name = v7-speech node.autoconnect = false }' "$WAV" &
P=$!
trap 'kill $P 2>/dev/null; exit 0' TERM INT EXIT
while kill -0 $P 2>/dev/null; do
  for ch in FL FR; do
    for port in $(PIPEWIRE_REMOTE=$G pw-link -i | grep -E "^alsa_capture\.paracord-desktop[^:]*:input_$ch$"); do
      PIPEWIRE_REMOTE=$G pw-link "v7-speech:output_$ch" "$port" 2>/dev/null
    done
  done
  sleep 0.1
done
