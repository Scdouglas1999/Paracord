#!/usr/bin/env python3
"""Seed a Paracord instance with a small, populated fixture community.

Used to produce the README screenshots: a fresh instance only ever shows empty
states, which do not represent the product. Everything here goes through the
public REST API exactly as a real client would, so what ends up on screen is the
real thing rather than hand-written database rows.

Usage:
    python3 scripts/seed-demo-community.py
    PARACORD_BASE=https://127.0.0.1:8443 python3 scripts/seed-demo-community.py

Requires: requests, pillow. Point it at a *throwaway* instance — the first
account it registers becomes the server owner.
"""
import io
import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.cookiejar import DefaultCookiePolicy

try:
    import requests
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - operator feedback only
    sys.exit("this script needs `requests` and `pillow` installed")

BASE = os.environ.get("PARACORD_BASE", "https://127.0.0.1:8443").rstrip("/")
API = f"{BASE}/api/v1"
PASSWORD = os.environ.get("PARACORD_DEMO_PASSWORD", "Emerald-Commons-2026!")
OUT_PATH = os.environ.get("PARACORD_DEMO_OUT", "demo-seed.json")

S = requests.Session()
S.verify = False
requests.packages.urllib3.disable_warnings()
# Every call authenticates with an explicit bearer token. Keeping the auth
# cookies the server sets would make one session look like a single browser
# acting for ten different people, which the CSRF layer rightly rejects.
S.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))


def req(method, path, token=None, expect=(200, 201, 204), **kw):
    url = path if path.startswith("http") else f"{API}{path}"
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for _ in range(6):
        r = S.request(method, url, headers=headers, timeout=30, **kw)
        if r.status_code == 429:
            time.sleep(min(float(r.headers.get("retry-after", 2)), 10))
            continue
        break
    if expect and r.status_code not in expect:
        raise SystemExit(f"{method} {url} -> {r.status_code}\n{r.text[:600]}")
    if r.status_code == 204 or not r.text:
        return {}
    try:
        return r.json()
    except ValueError:
        return {}


# --------------------------------------------------------------------------
# People
# --------------------------------------------------------------------------
PALETTE = [
    ("#24b78b", "#0d2a21"), ("#7c6cf5", "#1a1630"), ("#e0894a", "#2e1d0f"),
    ("#4aa8e0", "#0f2230"), ("#e05a8a", "#2e1220"), ("#8ac24a", "#1d2a0f"),
    ("#c24ac2", "#2a0f2a"), ("#4ac2b0", "#0f2a26"), ("#e0c14a", "#2a250f"),
    ("#5a7ae0", "#12182e"),
]

PEOPLE = [
    ("mira",  "Mira Chen",       "Maintainer"),
    ("ade",   "Ade Okafor",      "Engineering"),
    ("jonas", "Jonas Weber",     "Engineering"),
    ("priya", "Priya Raman",     "Design"),
    ("tomas", "Tomas Ferreira",  "Design"),
    ("sofia", "Sofia Marchetti", "Community"),
    ("ken",   "Ken Nakamura",    "Engineering"),
    ("lena",  "Lena Petrova",    "Community"),
    ("diego", "Diego Alvarez",   "Community"),
    ("yara",  "Yara Haddad",     "Design"),
]

FONT_CANDIDATES = (
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)


def avatar_png(display_name, idx):
    fg, bg = PALETTE[idx % len(PALETTE)]
    size = 256
    img = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(img)
    initials = "".join(p[0] for p in display_name.split()[:2]).upper()
    font = None
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            font = ImageFont.truetype(path, 104)
            break
    if font is None:
        font = ImageFont.load_default()
    box = d.textbbox((0, 0), initials, font=font)
    d.text(
        ((size - (box[2] - box[0])) / 2 - box[0],
         (size - (box[3] - box[1])) / 2 - box[1]),
        initials, font=font, fill=fg,
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def register(username, display_name, idx):
    body = {
        "email": f"{username}@commons.test",
        "username": username,
        "password": PASSWORD,
        "display_name": display_name,
    }
    r = req("POST", "/auth/register", json=body, expect=(200, 201, 400, 409))
    if "token" not in r:
        r = req("POST", "/auth/login",
                json={"email": f"{username}@commons.test", "password": PASSWORD})
    token = r["token"]
    req("POST", "/users/@me/avatar", token=token,
        files={"image": (f"{username}.png", avatar_png(display_name, idx), "image/png")},
        expect=(200, 201))
    return {"id": str(r["user"]["id"]), "token": token, "name": display_name}


print("registering people ...")
U = {}
for i, (uname, disp, _role) in enumerate(PEOPLE):
    U[uname] = register(uname, disp, i)
    print(f"  {disp}")

owner = U["mira"]
OT = owner["token"]
OUT = {}

# --------------------------------------------------------------------------
# Space, roles, members
# --------------------------------------------------------------------------
print("creating space ...")
guild = req("POST", "/guilds", token=OT, json={"name": "Emerald Commons"})
GID = str(guild["id"])
OUT["guild_id"] = GID
req("PATCH", f"/guilds/{GID}", token=OT, json={
    "description": "A small, self-hosted home for the people who build and run "
                   "Paracord. Design, engineering, release notes, and the "
                   "occasional Friday listening room.",
}, expect=(200, 204))

# A new space ships with a default text and voice channel; this fixture builds
# its own categorised set, so the defaults are removed to avoid duplicates.
default_channels = [str(c["id"]) for c in req("GET", f"/guilds/{GID}/channels", token=OT)]

ROLES = {}
for name, color in [("Maintainer", 0x24B78B), ("Engineering", 0x5A7AE0),
                    ("Design", 0xC24AC2), ("Community", 0xE0894A)]:
    r = req("POST", f"/guilds/{GID}/roles", token=OT,
            json={"name": name, "color": color, "hoist": True,
                  "mentionable": True, "permissions": 0})
    ROLES[name] = str(r["id"])

print("inviting members ...")
inv = req("POST", f"/channels/{default_channels[0]}/invites", token=OT,
          json={"max_uses": 0, "max_age": 0})
for uname, _disp, role in PEOPLE[1:]:
    req("POST", f"/invites/{inv['code']}", token=U[uname]["token"], json={},
        expect=(200, 201, 204, 400, 409))
    req("PATCH", f"/guilds/{GID}/members/{U[uname]['id']}", token=OT,
        json={"roles": [ROLES[role]]}, expect=(200, 204, 400))
req("PATCH", f"/guilds/{GID}/members/{owner['id']}", token=OT,
    json={"roles": [ROLES["Maintainer"]]}, expect=(200, 204, 400))

print("creating channels ...")
TEXT, VOICE, CATEGORY, ANNOUNCEMENT, FORUM = 0, 2, 4, 5, 7


def mkchan(name, ctype, parent=None):
    body = {"name": name, "channel_type": ctype}
    if parent:
        body["parent_id"] = int(parent)
    return str(req("POST", f"/guilds/{GID}/channels", token=OT, json=body)["id"])


cat_welcome = mkchan("Welcome", CATEGORY)
ch_announce = mkchan("announcements", ANNOUNCEMENT, cat_welcome)
ch_intro = mkchan("introductions", TEXT, cat_welcome)
cat_floor = mkchan("The Floor", CATEGORY)
ch_general = mkchan("general", TEXT, cat_floor)
ch_design = mkchan("design", TEXT, cat_floor)
ch_eng = mkchan("engineering", TEXT, cat_floor)
ch_show = mkchan("showcase", TEXT, cat_floor)
cat_rooms = mkchan("Rooms", CATEGORY)
vc_studio = mkchan("Studio", VOICE, cat_rooms)
vc_focus = mkchan("Focus Room", VOICE, cat_rooms)
vc_office = mkchan("Office Hours", VOICE, cat_rooms)
cat_help = mkchan("Help", CATEGORY)
ch_forum = mkchan("support", FORUM, cat_help)

for cid in default_channels:
    req("DELETE", f"/channels/{cid}", token=OT, expect=(200, 204, 404))

for cid, topic in [
    (ch_general, "Anything and everything. Be decent to each other."),
    (ch_design, "Emerald Commons design system — tokens, layout, motion."),
    (ch_eng, "Server, client, transport. Bring stack traces."),
    (ch_show, "Show what you built or what you are running."),
    (ch_announce, "Releases and things worth reading."),
]:
    req("PATCH", f"/channels/{cid}", token=OT, json={"topic": topic},
        expect=(200, 204, 400, 404))

OUT.update(dict(general=ch_general, design=ch_design, engineering=ch_eng,
                announcements=ch_announce, forum=ch_forum, showcase=ch_show,
                introductions=ch_intro, studio=vc_studio, focus=vc_focus,
                office=vc_office))

# --------------------------------------------------------------------------
# Conversation
# --------------------------------------------------------------------------
print("writing conversation ...")


def say(channel, who, content, reply_to=None):
    body = {"content": content}
    if reply_to:
        body["referenced_message_id"] = str(reply_to)
    r = req("POST", f"/channels/{channel}/messages", token=U[who]["token"],
            json=body, expect=(200, 201))
    time.sleep(0.06)
    return str(r["id"])


def react(channel, mid, who, emoji):
    req("PUT", f"/channels/{channel}/messages/{mid}/reactions/"
               f"{urllib.parse.quote(emoji, safe='')}/@me",
        token=U[who]["token"], expect=(200, 201, 204, 400, 404))


def pin(channel, mid):
    req("PUT", f"/channels/{channel}/pins/{mid}", token=OT,
        expect=(200, 201, 204, 400, 404))


a1 = say(ch_announce, "mira", """**Paracord 2.0.0 is out.**

This is the release where the client stops being a list of servers and starts
being one place. Home now ranks what actually needs you — mentions, unread DMs,
and live rooms — instead of making you sweep every space by hand.

Highlights:
- Native QUIC voice and video are the default path; LiveKit is opt-in
- Rooms open on who is around, not on an empty channel list
- Themes, density, and accent colors moved into Appearance
- A long security pass across auth, uploads, federation, and the media layer

Full notes are in the repo. Upgrading is a restart — migrations run on boot.""")
pin(ch_announce, a1)
for w in ("ade", "priya", "sofia", "ken", "lena", "diego", "yara", "tomas"):
    react(ch_announce, a1, w, "🎉")
for w in ("jonas", "priya", "ken"):
    react(ch_announce, a1, w, "🚀")

a2 = say(ch_announce, "mira",
         "Office hours moved to Thursdays 15:00 UTC in **Office Hours**. "
         "Drop questions in #support ahead of time and I will work through "
         "them live.")
for w in ("sofia", "lena", "diego"):
    react(ch_announce, a2, w, "👍")

g1 = say(ch_general, "sofia",
         "morning all — coffee is in, the 2.0 upgrade on our instance went "
         "clean overnight ☕")
pin(ch_general, g1)
g2 = say(ch_general, "ade",
         "same here. 40-odd migrations, no downtime past the restart. the pg "
         "path is genuinely boring now, which is the highest compliment I have "
         "for a migration.")
react(ch_general, g2, "mira", "😄")
react(ch_general, g2, "jonas", "💯")

g3 = say(ch_general, "priya",
         "the new Home is doing the thing I hoped it would — I opened it and "
         "immediately knew where to go instead of clicking through four spaces")
for w in ("mira", "tomas", "yara"):
    react(ch_general, g3, w, "🙌")

g4 = say(ch_general, "ken",
         "small thing that made my week: the health view actually tells you "
         "what to fix. mine flagged that my backup dir was on the same disk as "
         "the db and I had genuinely never noticed.")
react(ch_general, g4, "mira", "👀")

g5 = say(ch_general, "diego",
         "is anyone running this behind caddy? trying to work out whether I "
         "need to forward UDP separately for voice")
r1 = say(ch_general, "jonas",
         "yes — caddy terminates TLS for the HTTP side, but native media is "
         "QUIC on UDP 8443, so that one has to reach the server directly. "
         "forward both TCP and UDP on 8443 and it just works.", reply_to=g5)
react(ch_general, r1, "diego", "🙏")
say(ch_general, "diego", "that was exactly it, thank you — voice is up", reply_to=r1)

g6 = say(ch_general, "lena",
         "we hit 60 people in the space this week and the member list is still "
         "instant. what is the ceiling here realistically?")
say(ch_general, "mira",
    "sqlite is comfortable into the low hundreds of active people on modest "
    "hardware. past that, move to postgres — the offline `migrate-to-postgres` "
    "command does a dry run first and verifies row counts, so it is a "
    "low-drama afternoon rather than a migration project.", reply_to=g6)

g7 = say(ch_general, "yara",
         "unrelated but the AMOLED theme on an OLED panel is *so* nice at "
         "night. genuinely black.")
for w in ("priya", "tomas", "sofia", "ken"):
    react(ch_general, g7, w, "🌙")

e1 = say(ch_eng, "ade", """finally tracked down the reconnect stutter. the
gateway was replaying from the resume point *before* re-subscribing the guild
scopes, so the first few events after a resume landed with nowhere to go.

fix is two lines, but the test is the interesting part — it asserts ordering,
not just delivery:

```rust
// Subscribe before replay, or the replayed window fans out to zero sessions.
let sub = bus.subscribe_guild(guild_id, session.clone());
session.replay_from(resume_seq).await?;
assert_eq!(sub.recv().await?.seq, resume_seq + 1);
```""")
for w in ("mira", "jonas", "ken"):
    react(ch_eng, e1, w, "🔥")
pin(ch_eng, e1)

e2 = say(ch_eng, "jonas",
         "that explains the report from last week where someone lost about two "
         "seconds of messages on a train handover. nice find.")
say(ch_eng, "ken",
    "worth adding to the resume smoke script so it cannot come back quietly.",
    reply_to=e2)

e3 = say(ch_eng, "mira",
         "one more from the media side — the encoder now refuses to reuse an "
         "AES-GCM nonce instead of quietly wrapping the counter. it throws. a "
         "stream that dies loudly is worth far more than one that keeps going "
         "and leaks keystream.")
for w in ("ade", "jonas", "ken"):
    react(ch_eng, e3, w, "🔒")

thread = req("POST", f"/channels/{ch_eng}/threads", token=U["jonas"]["token"],
             json={"name": "resume ordering — follow-ups", "message_id": e1},
             expect=(200, 201))
TID = str(thread["id"])
say(TID, "jonas", "splitting the follow-ups out so the channel stays readable.")
say(TID, "ken",
    "added the ordering assertion to `release_gateway_resume_smoke.py` — it now "
    "fails if the subscribe/replay order flips back.")
say(TID, "ade", "perfect. that is the one I actually wanted guarded.")
say(TID, "mira", "closing this out then — thanks both.")

d1 = say(ch_design, "priya",
         "pushed the density pass. the gap between message groups was doing the "
         "work of a divider, so the dividers came out. it reads quieter without "
         "losing the grouping.")
for w in ("mira", "tomas", "yara", "sofia"):
    react(ch_design, d1, w, "✨")
d2 = say(ch_design, "tomas",
         "agree on the dividers. one note — at compact density the avatar column "
         "still holds full-size spacing, so compact is not actually much tighter "
         "than cozy.")
say(ch_design, "priya", "good catch, that is a token I missed. fixing.", reply_to=d2)
d3 = say(ch_design, "yara",
         "accent colors are landing well with the people I have shown it to. the "
         "emerald default reads as calm rather than corporate, which was the "
         "whole point.")
react(ch_design, d3, "priya", "❤️")

say(ch_intro, "lena",
    "hi — Lena, I run a 200-person community for a mapping project. moved us off "
    "a hosted service last month and have not looked back.")
say(ch_intro, "diego",
    "Diego, sysadmin by day. I mostly care about backups and boring upgrades. so "
    "far so good.")
say(ch_intro, "yara",
    "Yara, design. I am here for the theming system and I intend to abuse it.")

s1 = say(ch_show, "ken",
         "our instance runs on a mini PC in a cupboard. 14 months uptime, 60 "
         "people, sqlite, a nightly rsync of the data dir. that is the entire "
         "operation.")
for w in ("mira", "sofia", "diego", "lena", "ade"):
    react(ch_show, s1, w, "👏")

# --------------------------------------------------------------------------
# Poll, friends, events
# --------------------------------------------------------------------------
print("creating poll ...")
poll_message = req("POST", f"/channels/{ch_general}/polls", token=OT, json={
    "question": "Friday listening room — what are we putting on?",
    "options": [
        {"text": "Ambient / focus", "emoji": "🎧"},
        {"text": "Something with drums", "emoji": "🥁"},
        {"text": "Dealer's choice", "emoji": "🎲"},
    ],
    "allow_multiselect": False,
    "expires_in_minutes": 60 * 24 * 3,
}, expect=(200, 201))
# The endpoint returns the message that carries the poll, not the poll itself.
poll = poll_message.get("poll") or {}
if not poll.get("options"):
    raise SystemExit(f"poll create returned no options: {poll_message}")
poll_id = str(poll["id"])
options = [str(o["id"]) for o in poll["options"]]
for idx, voters in {0: ["priya", "yara", "tomas", "sofia", "lena"],
                    1: ["ade", "jonas"], 2: ["ken", "diego"]}.items():
    for who in voters:
        req("PUT", f"/channels/{ch_general}/polls/{poll_id}/votes/{options[idx]}",
            token=U[who]["token"], expect=(200, 201, 204, 400, 404))

print("adding friends ...")
for who in ("priya", "ade", "sofia", "jonas", "lena"):
    req("POST", "/users/@me/relationships", token=OT, json={"username": who},
        expect=(200, 201, 204, 400, 409))
    req("PUT", f"/users/@me/relationships/{owner['id']}", token=U[who]["token"],
        json={}, expect=(200, 201, 204, 400, 409))

print("creating events ...")
now = datetime.now(timezone.utc)
for name, desc, start, chan in [
    ("Office Hours",
     "Bring upgrade questions, deployment questions, or anything from #support.",
     now + timedelta(days=2, hours=3), vc_office),
    ("Design review — density pass",
     "Walking through the compact/cozy spacing changes before they ship.",
     now + timedelta(days=4, hours=1), vc_studio),
    ("Friday listening room", "No agenda. Music and whoever shows up.",
     now + timedelta(days=5, hours=6), vc_studio),
]:
    req("POST", f"/guilds/{GID}/events", token=OT, json={
        "name": name, "description": desc,
        "scheduled_start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scheduled_end": (start + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "entity_type": 2, "channel_id": chan,
    }, expect=(200, 201, 400))

OUT["owner_email"] = "mira@commons.test"
OUT["password"] = PASSWORD
OUT["users"] = {k: v["id"] for k, v in U.items()}
with open(OUT_PATH, "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, indent=2)
print(f"\nseed complete -> {OUT_PATH}")
