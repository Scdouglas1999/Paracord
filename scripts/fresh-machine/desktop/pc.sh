#!/bin/bash
# In-container helper for the fresh-machine gate (runs as root via docker exec).
#
#   pc wait-boot                  wait for systemd to finish booting
#   pc session-start              sign sam in: start user@1000 (keyring unlocked by pc-keyring)
#   pc session-stop               sign sam out: stop user@1000 (kills the app and the service)
#   pc sam <cmd...>               run a command as sam inside the session environment
#   pc driver-start               tauri-driver in sam's session, published on <container ip>:4444
#   pc driver-stop
#   pc shot <file.png>            screenshot of the whole X display
#   pc windows                    visible X windows: id x y w h title
#   pc click-at <x> <y>           a real pointer click on the X display
#   pc choose-file <title> <path> answer a GTK file chooser by typing the path
#   pc type-text <text> / pc key <keysym...>   real keyboard input
#   pc host-root                  print the host root (Tauri app_local_data_dir/host)
#   pc unit-active                systemctl --user is-active paracord-host
#   pc keychain-list              Secret Service items labeled for Paracord (attributes only)
#   pc db-header                  first 16 bytes of the server database, hex
#   pc db-open-without-key        try sqlite3 on the database without a key (must fail)
#   pc db-messages                decrypt the DB with the keychain key, print message rows as JSON
#   pc db-grep <text>             count occurrences of <text> in the raw DB/WAL files
set -euo pipefail
SAM_ENV=(XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus DISPLAY=:99 HOME=/home/sam USER=sam LOGNAME=sam)
HOST_ROOT=/home/sam/.local/share/com.paracord.desktop/host

# setpriv, not runuser/su: those open a PAM session, and a PAM session would
# sign sam in (logind starts user@1000) while the harness only wants to look.
# The live database: host.json's config_path (a restore activates a generation
# under restores/) or the default config, then its [database] url.
db_path() {
  local cfg
  cfg=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("config_path") or "")' "$HOST_ROOT/../host.json" 2>/dev/null || true)
  [[ -n "$cfg" ]] || cfg="$HOST_ROOT/config/paracord.toml"
  sed -n 's|^url *= *"sqlite://\([^?"]*\).*|\1|p' "$cfg" | head -1
}

sam() { setpriv --reuid=1000 --regid=1000 --init-groups env -i PATH=/usr/local/bin:/usr/bin "${SAM_ENV[@]}" "$@"; }

case "${1:-}" in
  wait-boot)
    for _ in $(seq 1 300); do
      s=$(systemctl is-system-running 2>/dev/null || true)
      [[ "$s" == running || "$s" == degraded ]] && exit 0
      sleep 0.1
    done
    echo "systemd did not finish booting ($s)" >&2; exit 1 ;;
  session-start)
    systemctl start pc-session.service
    for _ in $(seq 1 200); do systemctl is-active --quiet user@1000.service && break; sleep 0.05; done
    for _ in $(seq 1 200); do [[ -S /run/user/1000/bus ]] && break; sleep 0.05; done
    [[ -S /run/user/1000/bus ]] || { echo "no session bus" >&2; exit 1; }
    # default.target is reached only after pc-keyring unlocked the keyring.
    for _ in $(seq 1 200); do
      s=$(sam systemctl --user is-system-running 2>/dev/null || true)
      [[ "$s" == running || "$s" == degraded ]] && exit 0
      sleep 0.1
    done
    echo "user session did not come up ($s)" >&2; exit 1 ;;
  session-stop)
    # The session ends; logind (KillUserProcesses=yes, UserStopDelaySec=0)
    # stops user@1000 and everything of sam's with it.
    systemctl stop pc-session.service
    # logind stops user@1000 after the session is gone; wait until it is
    # fully inactive and nothing of sam's is left (it can take a moment while
    # the service shuts down and releases its router mapping).
    for _ in $(seq 1 300); do
      st=$(systemctl show -p ActiveState --value user@1000.service 2>/dev/null || echo inactive)
      [[ "$st" == inactive || "$st" == failed ]] && ! pgrep -u sam >/dev/null && exit 0
      sleep 0.1
    done
    echo "sign-out did not finish: user@1000 is $st; left: $(pgrep -a -u sam | tr '\n' ';')" >&2; exit 1 ;;
  sam) shift; sam "$@" ;;
  driver-start)
    # tauri-driver (loopback 4440, WebKitWebDriver on 4441) in sam's session,
    # so signing out ends it and the app with it; socat publishes it on the
    # container's address, port 4444, for the harness on the Docker host.
    sam systemctl --user stop pc-driver.service pc-driver-proxy.service >/dev/null 2>&1 || true
    sam systemctl --user reset-failed pc-driver.service pc-driver-proxy.service >/dev/null 2>&1 || true
    sam systemd-run --user --unit=pc-driver --collect \
      --setenv=DISPLAY=:99 --setenv=GDK_BACKEND=x11 --setenv=LIBGL_ALWAYS_SOFTWARE=1 \
      --setenv=WEBKIT_DISABLE_COMPOSITING_MODE=1 --setenv=GDK_GL=disable \
      --setenv=PATH=/opt/paracord:/usr/local/bin:/usr/bin \
      /opt/paracord/tauri-driver --port 4440 --native-port 4441 --native-driver /usr/bin/WebKitWebDriver
    addr=$(ip -4 -o addr show dev eth0 | awk '{split($4,a,"/"); print a[1]}')
    sam systemd-run --user --unit=pc-driver-proxy --collect \
      /usr/bin/socat "TCP-LISTEN:4444,bind=$addr,fork,reuseaddr" TCP:127.0.0.1:4440
    # WebKitWebDriver answers only requests whose Host is loopback (the harness sends Host: localhost).
    for _ in $(seq 1 100); do curl -fsS -H "Host: localhost" "http://$addr:4444/status" 2>/dev/null | grep -q "\"ready\":true" && exit 0; sleep 0.1; done
    echo "tauri-driver did not answer" >&2; exit 1 ;;
  driver-stop) sam systemctl --user stop pc-driver.service pc-driver-proxy.service >/dev/null 2>&1 || true ;;
  shot) sam import -window root "$2" ;;
  windows)
    # Every mapped top-level window: id, geometry, title (native dialogs included).
    for w in $(sam xdotool search --onlyvisible --name '.' 2>/dev/null); do
      eval "$(sam xdotool getwindowgeometry --shell "$w")"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$w" "$X" "$Y" "$WIDTH" "$HEIGHT" "$(sam xdotool getwindowname "$w")"
    done ;;
  click-at) sam xdotool mousemove --sync "$2" "$3" click 1 ;;
  choose-file)
    # A person in the GTK file chooser: Ctrl+L, type the path, Enter.
    w=$(sam xdotool search --sync --onlyvisible --name "$2" | head -1)
    sam xdotool windowfocus --sync "$w"
    sam xdotool key --window "$w" ctrl+l
    sleep 0.3
    sam xdotool type --window "$w" --delay 15 -- "$3"
    sleep 0.3
    sam xdotool key --window "$w" Return ;;
  type-text) sam xdotool type --delay 20 -- "$2" ;;
  key) shift; sam xdotool key "$@" ;;
  host-root) echo "$HOST_ROOT" ;;
  unit-active) sam systemctl --user is-active paracord-host.service ;;
  keychain-list)
    sam python3 - <<'PY'
import subprocess, json
out = subprocess.run(["secret-tool", "search", "--all", "--unlock", "service", "Paracord"], capture_output=True, text=True)
items = []
cur = None
for line in (out.stdout + out.stderr).splitlines():
    line = line.strip()
    if line.startswith("["):
        cur = {}; items.append(cur)
    elif cur is not None and line.startswith("attribute."):
        k, _, v = line.partition(" = "); cur[k[len("attribute."):]] = v
    elif cur is not None and line.startswith("label = "):
        cur["label"] = line[len("label = "):]
print(json.dumps(items))
PY
    ;;
  db-path) db_path ;;
  db-header) head -c 16 "$(db_path)" | od -An -tx1 | tr -d ' \n'; echo ;;
  db-open-without-key)
    if out=$(sqlite3 "file:$(db_path)?mode=ro" 'SELECT count(*) FROM sqlite_master;' 2>&1); then
      echo "OPENED: $out"; exit 1
    else
      echo "REFUSED: $out"
    fi ;;
  db-messages)
    # The storage key from sam's keychain -> HKDF subkey (paracord_util::at_rest::derive_sqlite_key_hex)
    # -> SQLCipher. The key never leaves the container; only rows are printed.
    acct=$("$0" keychain-list | python3 -c 'import json,sys; print(next((i["username"] for i in json.load(sys.stdin) if i.get("username","").startswith("host-storage-key:")), ""))')
    [[ -n "$acct" ]] || { echo "no host-storage-key in the keychain" >&2; exit 1; }
    master=$(sam secret-tool lookup service Paracord username "$acct")
    hexkey=$(python3 - "$master" <<'PY'
import sys, base64, binascii
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
raw = sys.argv[1].strip()   # paracord_util::at_rest::format_master_key: "hex:<64 hex>"
if raw.startswith("hex:"):
    key = bytes.fromhex(raw[4:])
elif raw.startswith("base64:"):
    key = base64.b64decode(raw[7:])
else:
    key = bytes.fromhex(raw)
assert len(key) == 32, len(key)
sub = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"paracord-at-rest-v1", info=b"sqlite").derive(key)
print(sub.hex())
PY
)
    tmp=$(mktemp -d); db=$(db_path); cp "$db"* "$tmp"/
    sqlcipher "$tmp/paracord.db" <<SQL
PRAGMA key = "x'$hexkey'";
.mode json
SELECT CAST(id AS TEXT) AS id, CAST(channel_id AS TEXT) AS channel_id, CAST(author_id AS TEXT) AS author_id, message_type, length(content) AS content_len, substr(content,1,160) AS content_head, CASE WHEN e2ee_header IS NULL THEN 0 ELSE 1 END AS has_e2ee_header FROM messages ORDER BY id DESC LIMIT ${2:-10};
SQL
    rm -rf "$tmp" ;;
  db-grep)
    n=0
    for f in "$(db_path)"*; do c=$(grep -c -a -F -- "$2" "$f" || true); n=$((n + c)); done
    echo "$n" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
