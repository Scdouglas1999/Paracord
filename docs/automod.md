# AutoMod

AutoMod checks every message in a space before it is stored. It exists so a
community can enforce its own rules without a moderator reading every line.

**Where:** Space Settings → **AutoMod**. Requires `MANAGE_GUILD`.

Nothing is filtered until you add a rule. A new space has none.

## How a rule works

A rule is three things:

1. **A trigger** — what to look for.
2. **One or more actions** — what to do when it matches.
3. **Exemptions** — roles and channels the rule never applies to.

Every enabled rule is evaluated against each message. If several rules match,
all of their actions apply; if any of them blocks, the message is blocked.

Members who can manage the space (`ADMINISTRATOR` or `MANAGE_GUILD`) are never
filtered by that space's own rules.

## Triggers

| Trigger | Configuration | Notes |
|---|---|---|
| **Keywords** | A list of words or phrases | Case-insensitive. Turn on **whole words only** so `ass` doesn't flag `assignment`. Max 200 per rule. |
| **Pattern** | One regular expression per line | Case-insensitive. Invalid patterns are rejected when you save, not at send time. |
| **Links & invites** | Block invites, block all links, or both | With **block all links**, listed domains stay allowed — and subdomains of an allowed domain are allowed too (`example.com` permits `docs.example.com`). |
| **Mention flood** | Maximum mentions per message | Counts **distinct** users, so pinging one person five times is not a flood. |
| **Message spam** | *N* messages within *S* seconds | Counted per member, in the channel that triggered it. |

### Test before you enable

The rule editor has a dry-run box. Paste a message, press **Test**, and it
reports whether the rule would fire and exactly what matched. Nothing is stored
and no action is taken. Use it especially for patterns.

## Actions

**Block the message** — it is never stored. The sender sees the reason you
wrote, so write something that tells them what to change ("Links are limited to
#resources" beats "Blocked").

**Time the member out** — stops them sending for the duration you set (1 minute
to 28 days). The timeout is applied *after* the triggering message is handled:
if the rule doesn't also block, that message still posts and the timeout starts
from the next one.

**Alert a channel** — posts a moderator-facing notice naming the rule, the
member, and what matched. Point it at a private staff channel.

Combining is normal: *block + timeout* for serious violations, *alert only* when
you want to watch a pattern before enforcing it.

## Exemptions

Per rule, you can exempt:

- **Roles** — moderators, trusted contributors, bots you run.
- **Channels** — a `#memes` or `#links` channel where the rule shouldn't apply.

## Reviewing what it did

**Recent activity** under Space Settings → AutoMod lists every automated action:
the rule, when it fired, what matched, which actions ran, and an excerpt of the
offending content. Rule create/update/delete also lands in the space audit log.

## Starting points

The settings page offers three one-click presets:

- **Block space invites** — stops drive-by advertising.
- **Stop mention spam** — blocks messages pinging more than five people.
- **Slow down flooding** — 5-minute timeout after 8 messages in 10 seconds.

## Scope and behavior

- AutoMod covers **human messages sent through the REST API**, and **webhook
  executions** whose creator does not hold `MANAGE_GUILD` (a webhook acts with
  its creator's authority, and privileged members are never filtered). Bot
  messages and scheduled delivery are operator-authored and not filtered.
- Evaluation **fails open**. If a rule can't be parsed or evaluation errors, the
  message is delivered and the problem is logged — a broken filter never takes
  chat down.
- Patterns use Rust's `regex` crate, which has no backtracking, so a hostile
  pattern cannot cause exponential blowup. Pattern length and compiled size are
  bounded on top of that.
- A space is capped at 50 rules.

## API

All endpoints require `MANAGE_GUILD`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/guilds/{guild_id}/automod/rules` | List rules |
| `POST` | `/api/v1/guilds/{guild_id}/automod/rules` | Create a rule |
| `PATCH` | `/api/v1/guilds/{guild_id}/automod/rules/{rule_id}` | Update a rule |
| `DELETE` | `/api/v1/guilds/{guild_id}/automod/rules/{rule_id}` | Delete a rule |
| `GET` | `/api/v1/guilds/{guild_id}/automod/hits` | Recent automated actions |
| `POST` | `/api/v1/guilds/{guild_id}/automod/test` | Dry-run a trigger |

Creating a keyword rule:

```jsonc
POST /api/v1/guilds/{guild_id}/automod/rules
{
  "name": "No advertising",
  "trigger_type": 1,
  "trigger_metadata": {
    "kind": "keyword",
    "keywords": ["buy followers", "free nitro"],
    "whole_word": true
  },
  "actions": [
    { "kind": "block_message", "reason": "Advertising isn't allowed here." },
    { "kind": "timeout_member", "duration_seconds": 600 }
  ],
  "exempt_role_ids": ["123456789"],
  "exempt_channel_ids": []
}
```

Trigger type ids: `1` keyword, `2` regex, `3` mention flood, `4` message spam,
`5` link. `trigger_metadata.kind` must agree with `trigger_type`.

A blocked message returns **403** with code `AUTOMOD_BLOCKED`; the `message`
field is the reason the operator configured, suitable to show the sender.
