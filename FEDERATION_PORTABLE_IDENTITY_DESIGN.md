# Federated Portable Identity Design (Task 6B-1)

## Goal
Allow users to carry a cryptographically verifiable identity across Paracord servers.

## Identity Format
- Canonical ID: @localpart:server.domain
- Identity bundle includes:
  - canonical id
  - display metadata
  - Ed25519 public identity key
  - signatures by origin server key
  - key version and creation timestamp

## Authentication Flow
1. User requests remote login challenge from destination server.
2. User signs challenge with private identity key.
3. Destination server verifies signature using trusted origin server public keys.
4. Destination server creates a mapped local account record and session.

## Key Rotation
- Bundle includes key version.
- Rotation publishes new signed bundle with previous-key cross-signature.
- Contacts receive "identity key changed" event and must re-verify.

## Trust and Verification
- Fingerprint = SHA-256(public_key) short+full formats.
- UI supports manual fingerprint comparison and QR verification.
- Verification status stored per relationship.

## Portability
- Export format is signed JSON bundle with optional encrypted private material.
- Import verifies signatures, enforces schema + anti-replay timestamp checks.

## Failure Modes
- Unknown origin key: block auth and prompt admin trust onboarding.
- Conflicting mapped identity: require explicit admin reconciliation.
- Stale bundles: reject beyond max skew / expiry.
