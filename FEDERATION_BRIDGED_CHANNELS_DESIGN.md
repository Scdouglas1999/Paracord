# Federated Bridged Channels Design (Task 6B-2)

## Goal
Allow a single logical channel/space to be shared across trusted federated servers.

## Core Concepts
- Room namespace: canonical room_id used by all participants.
- Local mapping: each server maps remote room/channel identifiers to local ids.
- Event stream: append-only signed envelopes with depth ordering.

## Synchronization
- Events are signed by origin server.
- Peers persist events idempotently by event_id.
- Catch-up uses per-peer per-room depth cursors.
- Outbound fanout retries with durable queue and backoff.

## Conflict Resolution
- Message create: event_id uniqueness + causal depth ordering.
- Edits/deletes: last-write-wins by origin_ts, ties resolved by event_id lexical order.
- Membership/state changes are state events keyed by (event_type, state_key).

## Permissions Model
- Local ACLs map remote identities to local members.
- Minimum effective permission = intersection(local policy, remote asserted capability).
- Moderation actions can be local-only or federated-propagated.

## Files/Attachments
- Attachment metadata federates inside event content.
- File bytes fetched via short-lived signed federation token endpoints.
- Optional local caching with TTL and size caps.

## Safety
- Replay protection via transport signature cache.
- Content size and depth limits for inbound events.
- Per-peer ingest and user-creation rate limits.

## Operational Requirements
- Protocol versions advertised in well-known and negotiated per request.
- Peer trust state supports allow/block/quarantine modes.
- Discovery and moderation lists are optional overlays on trust policy.
