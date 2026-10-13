# F3 checkpoint: a contact's next DM reaches a new device

Fix package F3 for bug 4.5 in `setup-s15-checkpoint.md` (Medium). Branch
`setup-fix`.

## 1. The bug and its cause

Repro (S15 scenario 4): Friend signs in on a second computer, presses
**Publish new keys for this device**, and Sam sends a DM. It arrives on Friend's
old computer and not the new one. Sam's messages only reach the new computer
after it sends something first.

Cause: there is no device list. An account publishes **one** prekey bundle.
"Publish new keys" (`replace_existing`) replaces that bundle with the new
device's keys. Sam's client, though, already has a Double Ratchet session with
the old computer's keys, and nothing told it the bundle had changed. The server
did send a `USER_UPDATE` to the account's contacts, and Sam's client did
reload the DM list, but nothing in either one changes when a bundle is
replaced. `encryptDmMessageWithSession` kept using the active ratchet and only
fetched a bundle (X3DH) when no session existed. Once the new device sent a
message, Sam's active ratchet became the session that device started, so
replies reached it.

## 2. The fix

**Server: a prekey generation.** New table `prekey_generations(user_id,
generation)`. Its value is a server snowflake, minted when an account publishes
its first signed prekey and again on every whole-bundle replacement. Signed-prekey
rotations, one-time-prekey top-ups and receipt replays leave it unchanged
(`paracord-db/src/prekeys.rs::publish_prekeys`). It is exposed as:
- `prekey_generation` in `GET /users/{id}/keys` (the bundle a sender fetches),
- `recipient.prekey_generation` in `GET /users/@me/dms` (1:1 DMs).
`delete_all_prekeys` removes the row. Accounts that have not published since
this change have no row, and senders behave as before for them.

**Client: each ratchet records what it was started against.** This is in
`signalSessions.ts`, namespace `signal.generation-anchors`:
- a generation this device starts with X3DH records the `prekey_generation` of
  the bundle it fetched (or `null` if the server named none);
- a generation the peer started records the server ID of that first message.
  Both values are server snowflakes, so they can be compared.

When sending, `encryptDmMessageWithSession({ peerPrekeyGeneration })` compares
the active generation's record with the contact's current generation. If the
record is older, or missing, or `null`, it retires *sending* on that generation
(the existing `retireSignalSendingSession`; the ratchet stays for late reads)
and starts a new X3DH session with the current bundle. That happens once.
After it, the new generation's record equals the current one and the normal
ratchet resumes. No extra request is made per message.

**How the sender learns about the new generation, without polling.**
- Event: `PUT /users/@me/keys` already sends the account's contacts a
  `USER_UPDATE`. For a DM recipient, `dispatch.ts` reloads the DM list, which
  now carries the new `prekey_generation`.
- Send: `AccountMessagingRuntime.send` already reloads the DM list before
  queuing (`receiveConversation(channelId, true)`). `prepareIntent` now passes
  the *live* recipient generation (`peerPrekeyGeneration(channelId, peerId)`)
  to `durableDm.prepareIntent`, not one stored when the draft was queued. So
  the check at send time is a vault read plus a comparison.

**Kept as designed.** Messages from before the switch stay unreadable on the
new device ("Encrypted message"). After the new device publishes, the old
device stops receiving new messages from contacts, which matches the documented
model of one device per account (`docs/encryption.md`).

**Not a multi-device fanout.** The task asked for "every current device of the
recipient". The protocol has one bundle per account, so the only current device
is the one holding the published keys. Encrypting one message for several
devices would need a per-device key directory and per-device envelopes. That
is a protocol change, not a fix, and I did not make it. The tests check what is
true in this protocol: the sender moves to the current device.

**Edge cases (all safe, and each ends on the current bundle):**
- A ratchet created before this change has no record. The first send after a
  contact *has* a generation does one extra X3DH.
- A first message the old device sent before the switch, but read by Sam only
  afterwards, has an older server ID, so Sam's reply starts a new session.
  There is a test for this.
- A race between the DM-list generation and the bundle fetch can cause at most
  one more X3DH on the next send.
- If the old device starts a *new* conversation after the switch, it would be
  treated as current. That is rare, and the old device is outside the model.

**Copy** (`MessagingRecoveryNotice.tsx`, the 4.5 (L) note):
- "Your recovery phrase restored the identity…" is now "This device restored
  the identity…". It was shown after a password sign-in that used the key
  backup. The fresh-machine regex still matches.
- "stops receiving new conversations" is now "stops receiving new messages".
- "your contacts pick them up on their next message" is now true and stays.

## 3. Files

| File | Change |
|---|---|
| `crates/paracord-db/migrations/20261014000001_prekey_generations.sql`, `crates/paracord-db/migrations_pg/20261014000001_prekey_generations.sql` | **new migration (outside the plan's S0-only rule, §3; flagged for the orchestrator)**. One new table, so `users` is not touched |
| `crates/paracord-db/src/prekeys.rs` | mint on first signed prekey / replacement; `get_prekey_generation`; delete with the rest |
| `crates/paracord-db/src/migrate_export.rs` | `prekey_generations` in `MIGRATION_TABLE_ORDER` |
| `crates/paracord-db/src/dms.rs` | `recipient_prekey_generation` (LEFT JOIN) |
| `crates/paracord-api/src/routes/keys.rs` | `prekey_generation` in the peer bundle |
| `crates/paracord-api/src/routes/dms.rs` | `recipient.prekey_generation` in the DM list |
| `crates/paracord-api/tests/prekey_publication.rs` | new test `prekey_generation_advances_only_when_a_device_replaces_the_bundle` |
| `client/src/lib/crypto/signalSessions.ts` | generation anchors, staleness check, `assertPrekeyGeneration` |
| `client/src/lib/crypto/signalSessions.test.ts` | new: five scenarios with real X3DH and Double Ratchet across three device stores |
| `client/src/lib/messages/durableDm.ts`, `accountMessagingRuntime.ts` (+ `.journal.test.ts`) | live generation passed in at prepare time; runtime test |
| `client/src/api/keys.ts`, `client/src/types/channel.types.ts` | optional `prekey_generation` fields |
| `client/src/components/message/MessagingRecoveryNotice.tsx` (+ test) | the copy above |
| `client/scripts/live-drive.mjs` | one step added: "second device receives the next DM without sending first" |
| `docs/encryption.md` | one paragraph under "Recovery phrase and new devices" (S14's file; additive) |

## 4. Gates

- `cargo test -p paracord-api --test prekey_publication`: 13/13 on SQLite and
  on PostgreSQL 16 (throwaway container on :55740, since stopped).
- `cargo fmt --all -- --check` clean; `cargo clippy -p paracord-db -p
  paracord-api --all-targets -- -D warnings` clean; `cargo test -p paracord-db`
  212/212 (the export test `migration_table_order_matches_schema` caught the new
  table, so it is listed in `MIGRATION_TABLE_ORDER`); `cargo test -p
  paracord-api` all binaries green.
- Client: `tsc --noEmit` clean; eslint clean on the touched files; `vitest run`
  4892/4894. The 2 failures are not F3's: `lib/host/settingsView.test.ts` is
  F4's untracked in-progress file, and `CallSheet.test.tsx` "a short drag
  springs back" is a timing test that passes 6/6 when run alone. Tokens and
  motion-lint pass.
- Live: `live-env --port 18740 --data .live-env-f3` (debug server with this
  tree's embedded UI), `live-drive` **29/29 PASS**, including the new step:
  "generation 368195793112272896 → 368196983300558848; ada's next DM decrypts
  on grace-2 before grace-2 sends anything". Screenshots:
  `09b-offer-fresh-keys--grace-2.png` and
  `09c-next-dm-on-new-device--grace-2.png` (the old DM shows "Encrypted message",
  the new one shows as text) in the session scratchpad `f3-live/`. The instance
  was stopped, and `.live-env-f3` and the copied binary were deleted.

## 5. Open

- The migration needs the orchestrator's sign-off (plan §3).
- Group DMs were not changed. Their sender keys are wrapped with
  identity-key envelopes, not prekeys, so they do not have this problem in the
  same form. Not verified live here.
