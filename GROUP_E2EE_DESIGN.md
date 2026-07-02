# Group E2EE Design (Task 6A-1)

## Scope
- Add end-to-end encryption for group DM channels using per-sender sender keys.
- Keep the server blind to plaintext content and key material.

## Cryptographic Model
- Identity: existing Ed25519 identity keys remain trust anchors.
- Session bootstrap: per-recipient X3DH with recipient prekeys.
- Sender key payload: random symmetric key per sender per group + epoch counter.
- Message encryption: sender key AEAD (AES-GCM) with nonce + associated data (channel_id, message_id, epoch).

## Key Distribution Protocol
1. Sender creates/rotates sender key for a group DM channel.
2. Sender encrypts that sender key separately for each recipient using existing Signal session.
3. Client posts encrypted sender-key envelopes to server endpoint.
4. Server stores opaque envelopes indexed by (channel_id, sender_id, recipient_id, epoch).
5. Recipients fetch pending envelopes, decrypt locally, and cache sender keys.

## Rotation Rules
- Rotate on membership change (recipient add/remove).
- Rotate after configurable message count threshold.
- Rotate on explicit user action ("Reset encryption").

## Forward Secrecy and Recovery
- Sender key compromise affects only current sender key epoch.
- Historical epochs are retained client-side only as needed to decrypt history.
- Membership changes force epoch increment to prevent ex-members decrypting new traffic.

## Server/API Requirements
- POST /api/v1/channels/{channel_id}/e2ee/sender-keys (store envelopes)
- GET /api/v1/channels/{channel_id}/e2ee/sender-keys?since_epoch=
- POST /api/v1/channels/{channel_id}/e2ee/sender-keys/ack
- Server validates channel membership but not envelope content.

## UX
- Security indicator in group DM header: "Encrypted" / "Needs key sync".
- Key reset action available to channel owner/moderators.
- Verification panel shows peer identity fingerprints and verification state.

## Compatibility
- DM v2 remains unchanged.
- Group DM plaintext sending disabled when E2EE capability is enabled.
- Legacy fallback is opt-in and explicitly warned.
