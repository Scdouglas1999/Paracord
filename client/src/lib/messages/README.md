# Account-owned delivered-message mutations

## Production account runtime

`accountMessagingRuntime.ts` owns separate local and Signal lanes for one explicit
server/account. Ordinary server drafts and plain-channel delivery use a
nonextractable AES-GCM device key persisted in IndexedDB, independent of Signal
identity enrollment. This key is device-bound: identity recovery words do not
recover it, and it does not protect data from running same-origin code. Missing
keys over existing ciphertext reject instead of creating a replacement key.
Storage failure keeps composer text in memory and prevents send acceptance;
there is no plaintext persistence fallback.

The identity lane opens only with the enrolled identity, verifies or migrates
owned published prekeys, and uses the shared Signal cipher for send/receive/edit
and delete retirement. Ambiguous legacy session/trust records remain untouched;
an explicit per-conversation new-session decision is required. `AppProviders`
owns runtime lifecycle; `MessageInput`/`useMessageDraft` persist and submit encrypted
drafts, `messageStore` projects durable receipts and delegates DM receive/edit/delete,
and gateway `READY` invokes enrollment through this runtime. Those production paths
no longer invoke the legacy unscoped prekey/session writers or plaintext queue.
Group encryption, encrypted attachment producers, upload ownership, and combined
recovery UI verification remain required before claiming the full program complete.
Unsupported group sends, encrypted attachments and encrypted scheduling fail closed.

The runtime binds each vault to an authenticated database-history epoch. Only
the original in-memory lease can adopt first-ever drafts before its initial
handshake. Reloaded unknown-history records and changed-history records pause
for review. `preservePreviousHistoryForReview()` preserves exact old local
records in encrypted history archives and copies text into recovery drafts
before retiring active addresses and allowing fresh ordinary messages. It does
not reset Signal keys or resend old requests. `copyRecoveryDraft()` performs an
explicit revision-checked copy into a current draft, retaining the recovery
record. Open composer text is also held for review across history replacement.

`draftController(channelId)` serializes encrypted writes and exposes visible
loading/saving/error state. `capture()` waits for persistence. Passing that draft
revision to `send()` uses `acceptEncryptedDraft`: a device-vault handoff journal
and destination-vault acceptance receipt preserve the original nonce if the app
closes between outbox acceptance and composer clearing. Staged handoffs never
automatically resume. The destination commits intent and acceptance together;
clearing only the submitted revision preserves newer typing. Submission receipts
are deliberately retained; safe garbage collection/export is not implemented.

`observeDeleted()` accepts only an authenticated account-owned gateway deletion.
It persists a local tombstone and, when unlocked, an identity generation barrier.
Before the next encrypted send, unattempted followers can return to intents while
attempted dependent messages stay blocked for delivery resolution. The gateway
must await this persistence before considering the event processed; storage
failure cannot advance its durable event checkpoint. On unlock, local deletion
observations are applied to the identity lane before drivers start and again
before preparation/HTTP, so deletions observed by a locked peer window also fence
an already unlocked sender. Receipt
projection filters deletion tombstones so late create/edit replies cannot
resurrect a deleted row. Browser notifications refresh peer-tab projections;
all writers still arbitrate through account Web Locks.

`ingestEncryptedMessage()` journals the complete encrypted envelope (with empty
transport plaintext) in the device vault before the gateway may checkpoint it.
A locked identity does not prevent this commit. On enrollment the shared Signal
reader processes retained envelopes, including a starter whose server row was
subsequently deleted. Failed decrypts stay retained for recovery; a successful
identity transaction precedes journal removal. New envelopes arriving during a
drain request another pass. An aborted identity/history cannot retire the journal.
During history review, current-epoch envelopes and deletions use separate held
namespaces, adopted only by the explicit local review action; old tombstones never
hide IDs reused in the current server history.

Gateway dispatch returns `void | Promise<void>`. `READY` and `RESUMED` wait for
the account's fixed recovery fence. Every `MESSAGE_CREATE`, `MESSAGE_UPDATE` and
`MESSAGE_DELETE`, including ordinary channel messages, waits for the exact
mutation revision and authoritative body or tombstone to commit. A revision gap
uses the retained recovery feed before processing encrypted envelopes.
`MESSAGE_DELETE_BULK` awaits exact per-message revisions serially. Non-message
events can stay synchronous. Duplicate durable records resolve. Account/history
cancellation, malformed owned envelopes, and persistence failure reject: the
connection manager reconnects from its last successful WS/SSE checkpoint. A
transport pause fences runtime continuations and sender drivers independently
of the longer-lived unlocked identity. See [the recovery contract](../../../../docs/message-recovery.md)
for retention gaps, current-state audits, and ciphertext-only archived revisions.
Recovery cannot restore plaintext without its private keys; an identity vault
from an older database history remains explicitly blocked.

`createAccountDeliveredMutations(session, { onChange, onError })` constructs the
service using one verified `openAccountVault` session. It captures that session's
REST client, identity, encrypted storage and cancellation lifetime. The
production account runtime calls this service; it does not own UI state.

## Runtime integration

- Create one service per account runtime and call `start()`. `stop()` permanently
  cancels that instance; construct a new service after unlock/re-authentication.
  The service also stops on its vault session's abort. All prepared work survives
  encrypted storage close/reload. `drain()` supports explicit controlled runs.
- Capture `DeliveredMessageTarget` from an account-owned server message and
  verified conversation metadata, including the real author, exact message ID
  and `plain` or one-to-one `dm` encryption metadata. Do not infer ownership from
  the currently selected server. This author-edit/delete service intentionally
  rejects another author's message; moderation mutations use a separate action.
- `edit(target, content, expectedRevision)` and
  `delete(target, expectedRevision)` commit intent before resolving. Pass `null`
  when there is no pending delivered mutation, otherwise its current revision.
  A stale editor rejects. Delete intent cannot be replaced by another edit.
- `snapshot()` returns ordered pending/failed mutations, completed receipts in
  sequence order, and deletion tombstone IDs (`JSON.stringify([channelId,
  messageId])`). `retry(id, revision)` retains all immutable bytes and server
  Retry-After deadlines. Draft content remains available to the copy UI on
  failure; no record is silently evicted.
- `onChange` means re-read the account's snapshot. The runtime owns cross-tab
  invalidation/refresh and must reconcile receipts with the message history
  journal, server edit order and session generation. Never insert an old receipt
  over a newer edit/delete. Snapshot projection masks old message receipts after
  a durable tombstone. The service never performs a create-message POST.
- Send `observeDeleted({channelId, messageId})` only an authenticated deletion
  event captured for this account. It persists a tombstone, completes a pending
  deletion, or retains a failed edit draft. Late PATCH acknowledgments re-read
  it before committing a receipt. Broader gateway integration must also resolve
  affected outbound crypto dependencies before allowing dependent sends; a UI
  tombstone alone does not perform that cross-domain reconciliation.
- A message still in the creation outbox belongs to `DurableDelivery`'s prepared
  edit/discard protocol, even if a gateway echo already supplied a server ID.
  Hand it to this service once creation acknowledgment has removed that record.
  Older delivered server messages need no creation nonce or local send receipt.

## Crypto and delivery invariants

The mutation driver shares the account's `paracord:delivery:` Web Lock with
`DurableDelivery`. Network attempts therefore serialize across both services and
browser tabs. New user intent uses only the vault lock and can commit during HTTP.
Attempts/backoff commit before network work. Newer intent defeats a late success
or failure. A superseded immutable PATCH stays saved until its edit-resolution
endpoint confirms it applied, canceled or its target was deleted; only then can
replacement ciphertext be prepared. A deletion similarly resolves any preceding
uncertain edit first.

`createDurableDm.prepareDeliveredEdit` uses the existing account-owned cipher and
an independent X3DH generation, archived and retired for sending. Preparation
commits the request, plaintext cache and crypto state atomically. Normal sends
cannot depend on reading the edited body. Editing or deleting an older initial
message also retires current sending state and restores unattempted eager
followers to intents without changing their order or latest draft. Attempted
followers fail closed until their delivery is resolved. Deletion retirement
commits before deletion HTTP and is not repeated on receipt replay. Missing keys,
trust changes and storage failures are surfaced; there is no legacy crypto or
plaintext-storage fallback. Group DMs and encrypted attachments require their
own account-owned producer adapters before this service can support them.

## Deletion HTTP contract

The request `DELETE /channels/{channelId}/messages/{messageId}` with JSON
`{"delete_nonce":"UUID"}` requires HTTP 200 and:

```json
{
  "channel_id": "10",
  "message_id": "100",
  "actor_id": "42",
  "delete_nonce": "UUID",
  "state": "deleted",
  "delete_replayed": false
}
```

The deletion and receipt commit atomically. The receipt binds the nonce to the
actor/channel/message; retargeting it returns 409. Legacy DELETE without this
body may continue returning 204; 204 is not accepted for this durable protocol.

Before each deletion attempt, including reload, the client calls
`POST /channels/{channelId}/messages/{messageId}/deletions/{deleteNonce}/resolve`
without a body. HTTP 200 must echo all four identity fields above and a `state`
of `deleted` or `pending`. Only a matching committed receipt proves `deleted`.
`pending` requires an extant target and current delete authorization; the client
then sends its original DELETE. Matching receipt replay requires current channel
visibility, but does not require renewed delete permission. Resolution does not
cancel or seal a pending deletion.

Missing target with no receipt is an unproven 404; lost channel visibility/auth
returns 403/401. Neither becomes a fabricated success. Definitive 403/404/409 and
protocol failures preserve failed mutation intent for recovery; network/429/5xx
use persisted backoff. If a trusted gateway deletion already proves absence,
`observeDeleted` can complete local intent independently. No endpoint may expose
a target or receipt from a channel the requester cannot view.

## Verification

Focused unit tests cover immutable replay, superseding edits, in-flight delete,
storage failure, logout, Retry-After, stale/foreign ownership, cross-driver
serialization, and tombstones. `e2e/delivered-mutations.spec.ts` uses real Web
Crypto, IndexedDB and Web Locks with controlled HTTP for encrypted reload,
independent follower decryption, crypto rollback, deletion receipt recovery and
cross-tab serialization. These are not the production two-user/two-server UI
acceptance scenarios; those remain required with the coordinated cutover.

## Authoritative recovery feed (integration in progress)

`messageRecovery.ts` validates and durably consumes
`GET /channels/{id}/messages/recovery?after=<decimal>&through=<fixed decimal>&limit=100&known_ids=<IDs>`.
Every reply binds `database_history_epoch`, `channel_id`, `after`, `through`,
`floor`, `next`, `complete`, and `projection_head`. Changes have unique exact
per-message revisions and `kind: create|update|delete`. An `archived_message`
contains the immutable encrypted envelope and routing metadata with `content:''`;
it is only for ratchet catch-up. It must never be displayed as a historical body.
`states` explicitly binds each changed or requested ID to its current message
and `message_revision`, or to absence proven at `projection_head`.

A recovery run keeps its original `through` even when a page observes a later
projection head. All envelopes and target states commit atomically with the page
cursor in the device vault. Failed storage or account/history cancellation does
not advance that cursor. A reload continues an unfinished fixed fence. Known
IDs are checked in batches of 100 without moving the fence. Later authoritative
states must be held or version-filtered until the buffered live lane reaches
them; archived envelopes never authorize plaintext projection. A same-history
tombstone cannot be replaced by a present row.

A bound HTTP 409 `MESSAGE_RECOVERY_GAP` reports `floor`, `head` and
`reason: before_migration|retention`; it is a recovery requirement, not proof that
missing encrypted generations can be reconstructed. An unproven 404 is a
failure. The current server retention is 2048 body mutations per channel.
Production handshake, sender, receipt and ratchet-only inbox integration is
still required before this module provides authoritative recovery guarantees.

On runtime open, already-existing creation receipts are marked observed rather
than inserted into the current history window. Fresh delivery acknowledgments
still project. This prevents a saved creation receipt from surviving a latest
HTTP page omission as a fabricated new message; authoritative recovery remains
necessary for ratchet gaps and missed mutations.
