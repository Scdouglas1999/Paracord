# Sports

Sports is a scoreboard for one server. The person who runs that server turns it
on, picks the leagues, and everyone in the server sees the same games. The
scores come from ESPN's public scoreboard. The server fetches them and
remembers them for a short while. Phones and computers in the server never
talk to ESPN.

## Turn it on

Open the server's settings and go to **Add-ons**. Turn on **Sports**. The
sidebar gains a Sports page. Until you change the list, the page follows the
NFL and Major League Baseball.

## Leagues and favorite teams

Add a league from the list, or type one ESPN uses in a scoreboard address if
it isn't listed (for example `soccer/eng.2`). You can follow up to 12.

Favorite teams are picked from a league's full list. They are shown first, and
the Favorites view shows only them. You can pick up to 24.

## The Sports page and a game

The Sports page lists the games for the leagues you follow. Live games come
first. Open a game for the situation on the field, the score quarter by
quarter or inning by inning, and who scored.

You can look at another day, from two weeks back through two weeks ahead. The
page you get when you don't pick a day is today.

## Pin a game to a channel

On a game, someone who can manage channels can pin it to a text channel. The
channel shows that game above the messages, for everyone in the server.

While the game is on, Sports posts into the channel:

- each score
- halftime
- the end of regulation
- the final

It does not post at the end of every quarter or inning. The message is from
**Sports**, with a Bot mark, and the text is the whole update. A touchdown
reads like this:

```
Touchdown — Chiefs 14, Colts 7 · 8:41 2nd · K.Walker 4 yd run
```

Halftime and the final are shorter: `Halftime — Colts 20, Chiefs 17` and
`Final — Chiefs 33, Colts 30 (OT)`.

A server's text channels are stored as ordinary text, so Sports can write
them. A direct message or a group conversation is encrypted on the members'
devices. Sports cannot write a readable message there, and it will say so on
the pin instead of posting.

A server can pin up to 32 games. A pin drops off once the game has been over
for a few hours, or when the server stops following that league.

## Where the scores come from

ESPN publishes a public scoreboard. The server asks ESPN for it. Members do
not.

What gets sent is the league, such as `football/nfl`, and, when someone opens
a game or a channel is waiting on one, that game's number. Names, messages,
and the rest of the server are not sent.

The server keeps the answer for a few seconds while a game is on, and longer
when nothing is live, so it isn't fetched on every look. A day other than
today is kept for a few minutes.

## Settings

In **Add-ons**, under Sports:

- **Show live games on the server's front page.** A short list. When nothing
  is live, it shows the next games to start.
- **Layout.** Cards put several games across the page. List keeps one game on
  each row.
- **Default view.** All, Live, or Favorites.

## Trying it without a live game

You can replay a finished game so the scoreboard moves without waiting for a
real one. Set these before you start the server:

```bash
PARACORD_SPORTS_REPLAY=football/nfl/401872945,baseball/mlb/401817029
PARACORD_SPORTS_REPLAY_SPEED=30
PARACORD_SPORTS_REPLAY_START=2026-09-21T00:30:00Z
```

The first is which games to replay. The second is how fast: 30 means thirty
seconds of the game pass for each real second. If you leave it out, the speed
is 6. The third is where in the game to begin. Leave it out to start before
the opening play.

This is off unless you set it. It is for trying the page, not for a server
people rely on for the real score.
