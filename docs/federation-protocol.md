# Paracord Native Federation Protocol (MVP Draft)

This document defines the MVP federation model for Paracord-to-Paracord interoperability.

## Goals

- Federate text-first features in MVP (invites, memberships, messages, edits/deletes, reactions).
- Keep media federation (voice/stream relay) out of MVP.
- Provide replay-safe, signed server-to-server transport.

## Server Identity

- Every server has a stable `server_name` (DNS-like identifier).
- Every server has one active signing key and optional rotation keys.
- Signing key metadata:
  - `key_id`
  - `algorithm` (`ed25519`)
  - `public_key`
  - `valid_until`

## Event Envelope

All federated events are sent as signed envelopes:

- `event_id` (globally unique)
- `room_id` (federated room namespace)
- `event_type`
- `sender` (fully-qualified actor id)
- `origin_server`
- `origin_ts` (unix ms)
- `depth` (monotonic per room for ordering)
- `state_key` (optional)
- `content` (JSON payload)
- `signatures` (JSON map keyed by server/key_id)

## Transport

- HTTPS JSON APIs between servers.
- Required headers:
  - `X-Paracord-Origin`
  - `X-Paracord-Key-Id`
  - `X-Paracord-Timestamp`
  - `X-Paracord-Signature`
- Signature scope includes method, path, timestamp, and request body hash.
- Inbound validation checks both:
  - transport-hop authenticity (`X-Paracord-*` sender signature)
  - envelope origin authenticity (`signatures` for `origin_server`)
- This allows authenticated relay in non-full-mesh federation topologies.

## Replay and Idempotency

- Reject requests with timestamp skew outside tolerance window.
- Use `event_id` idempotency checks on ingest.
- Persist processed event IDs and drop duplicates.
- Enforce transport-level replay cache keyed by signed request material.
- Use monotonic `depth` values (timestamp-based in MVP) for paginated room sync.

## Federation APIs (MVP)

- `GET /.well-known/paracord/server` (discovery)
- `GET /_paracord/federation/v1/keys`
- `POST /_paracord/federation/v1/event`
- `GET /_paracord/federation/v1/event/{event_id}`
- `POST /_paracord/federation/v1/invite`
- `POST /_paracord/federation/v1/join`
- `POST /_paracord/federation/v1/leave`

## Trust and Safety

- Per-remote-server allow/block list.
- Per-remote-server rate limits.
- Quarantine mode for misbehaving servers.

## Persistence

Use and extend existing federation tables:

- `federation_events`
- `federation_server_keys`

Add support tables for:

- outbound queue
- per-server trust state
- per-event delivery attempts
- transport replay cache

## Deferred Beyond MVP

- Cross-server voice/media relay.
- Rich remote moderation synchronization.
- End-to-end encryption federation.
