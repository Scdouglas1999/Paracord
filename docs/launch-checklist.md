# Launch Checklist

## Security and Auth

- [ ] `PARACORD_JWT_SECRET` rotated and stored securely.
- [ ] CORS restricted to allowed web origins.
- [ ] Federation disabled unless signing key and trust policy are configured.
- [ ] Admin users validated and least-privilege permissions reviewed.

## Core Product Paths

- [ ] User can register/login on web and desktop.
- [ ] User can create a guild, channels, and invites.
- [ ] Invited users can join and send/receive messages in real time.
- [ ] DM creation and messaging verified end-to-end.
- [ ] Voice join/leave/mute/deafen verified with at least two clients.
- [ ] Streaming verified with quality selection and viewer playback.

## Moderation and Admin

- [ ] Role edits, member updates, bans, and kicks verified.
- [ ] Audit log entries are created for moderation/admin actions.
- [ ] Channel permission overwrites are enforced.

## Operations

- [ ] `/health` and `/metrics` monitored.
- [ ] PostgreSQL backup/restore drill completed.
- [ ] Log retention and alerting baseline configured.
- [ ] Docker image builds reproducibly from current `main`/`master`.

## Federation MVP

- [ ] `.well-known` and federation key endpoints reachable.
- [ ] Inbound federation transport signatures verified (`X-Paracord-*` headers).
- [ ] Federation replay cache blocks duplicated signed requests.
- [ ] Federated event ingest and retrieval tested across two servers.
- [ ] Duplicate event ingestion is deduplicated by `event_id`.
- [ ] Run `scripts/federation_deployed_live_validation.py` against staging/production-like nodes before launch.
