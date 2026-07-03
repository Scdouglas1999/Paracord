// E2EE key distribution relay module.
//
// The relay server NEVER decrypts media. It only relays encrypted sender keys
// between participants via WebSocket signaling. The relay tracks the current
// key epoch per sender so it can deliver stored keys to late joiners.

use crate::signaling::{EncryptedSenderKey, MediaKeyAnnounce, MediaKeyDeliver};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{debug, info};

/// Backstop for the decode-suppression window, in milliseconds.
///
/// A late joiner suppresses decrypt failures until it receives a key from each
/// pending sender. This caps how long that suppression may last if a
/// re-announcement never arrives (e.g. a sender that goes silent), so a
/// genuinely broken stream eventually surfaces errors again.
const DECODE_SUPPRESSION_BACKSTOP_MS: u64 = 5_000;

/// Stored sender key state for one participant in a room.
#[derive(Debug, Clone)]
struct StoredSenderKey {
    /// The user who announced this key.
    sender_user_id: i64,
    /// Current key epoch.
    epoch: u8,
    /// Per-recipient encrypted key blobs (as announced by the sender).
    encrypted_keys: Vec<EncryptedSenderKey>,
}

/// Callback for delivering key material to a specific user.
pub type KeyDeliveryFn = Arc<dyn Fn(i64, MediaKeyDeliver) + Send + Sync>;

/// Notification sent when participants should rotate their keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRotationNotification {
    /// The event that triggered rotation.
    pub reason: KeyRotationReason,
    /// User ID of the participant who joined or left.
    pub user_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum KeyRotationReason {
    /// A new participant joined; all senders should rotate for backward secrecy.
    ParticipantJoined,
    /// A participant left; remaining senders should rotate for forward secrecy.
    ParticipantLeft,
}

/// Signal handed to a joining participant so it can silence spurious decrypt
/// failures during the join-to-decrypt window.
///
/// A late joiner may begin receiving encrypted media from senders whose current
/// sender key was announced *before* the joiner arrived and was therefore not
/// addressed to it. Until each such sender observes the broadcast
/// [`KeyRotationNotification`] and re-announces a key addressed to the joiner,
/// the joiner cannot decrypt that sender's frames. Without this signal the
/// client would surface a burst of decrypt-failure errors for the duration of
/// that window.
///
/// The client should suppress decrypt failures for every sender in
/// `pending_senders` until it receives a key for that sender, or until
/// `suppress_for_ms` elapses as a backstop — whichever comes first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodeSuppressionNotice {
    /// Senders whose current key has not yet been delivered to the joiner and
    /// whose media will therefore be undecryptable until they re-announce.
    pub pending_senders: Vec<i64>,
    /// Upper bound, in milliseconds, on how long to keep suppressing decrypt
    /// failures as a backstop against a re-announcement that never arrives.
    pub suppress_for_ms: u64,
}

impl DecodeSuppressionNotice {
    /// Whether any sender is pending; if not, the joiner has every current key
    /// and need not suppress anything.
    pub fn is_active(&self) -> bool {
        !self.pending_senders.is_empty()
    }
}

/// Outcome of a participant joining a room.
///
/// Bundles the rotation notice to broadcast to existing participants with the
/// decode-suppression notice to hand to the joiner, so the caller can drive both
/// halves of the join without a second pass over relay state.
#[derive(Debug, Clone)]
pub struct ParticipantJoinOutcome {
    /// Rotation notice for existing participants (backward secrecy).
    pub rotation: KeyRotationNotification,
    /// Decode-suppression window for the joining participant.
    pub decode_suppression: DecodeSuppressionNotice,
}

/// Server-side key distributor for an individual room.
///
/// Responsibilities:
/// - Receive `OP_MEDIA_KEY_ANNOUNCE` from senders
/// - Extract per-recipient encrypted keys and deliver `OP_MEDIA_KEY_DELIVER`
/// - Track current key epoch per sender for late-joiner catch-up
/// - On participant join: deliver all stored current keys to the new participant
/// - On participant leave: notify remaining participants to rotate
pub struct KeyDistributor {
    /// Room identifier.
    room_id: String,
    /// Current sender keys indexed by sender user_id.
    sender_keys: DashMap<i64, StoredSenderKey>,
    /// Callback to deliver a key to a specific recipient.
    deliver_fn: KeyDeliveryFn,
}

impl KeyDistributor {
    /// Create a new key distributor for a room.
    pub fn new(room_id: String, deliver_fn: KeyDeliveryFn) -> Self {
        Self {
            room_id,
            sender_keys: DashMap::new(),
            deliver_fn,
        }
    }

    /// Handle an incoming `OP_MEDIA_KEY_ANNOUNCE` from a sender.
    ///
    /// Stores the announcement for late-joiner delivery and forwards
    /// each per-recipient encrypted key as `OP_MEDIA_KEY_DELIVER`.
    pub fn handle_key_announce(&self, announce: MediaKeyAnnounce) {
        let sender_id = announce.user_id;
        let epoch = announce.epoch;

        info!(
            room = %self.room_id,
            sender = sender_id,
            epoch = epoch,
            recipients = announce.encrypted_keys.len(),
            "processing key announcement"
        );

        // Store the announcement for late joiners.
        self.sender_keys.insert(
            sender_id,
            StoredSenderKey {
                sender_user_id: sender_id,
                epoch,
                encrypted_keys: announce.encrypted_keys.clone(),
            },
        );

        // Deliver each per-recipient encrypted key.
        for encrypted_key in &announce.encrypted_keys {
            let deliver = MediaKeyDeliver {
                sender_user_id: sender_id,
                epoch,
                ciphertext: encrypted_key.ciphertext.clone(),
            };
            debug!(
                room = %self.room_id,
                sender = sender_id,
                recipient = encrypted_key.recipient_user_id,
                epoch = epoch,
                "delivering sender key"
            );
            (self.deliver_fn)(encrypted_key.recipient_user_id, deliver);
        }
    }

    /// Handle a new participant joining the room.
    ///
    /// 1. Delivers every stored current sender key already addressed to the new
    ///    participant so it can decrypt those senders immediately.
    /// 2. Computes the join-to-decrypt window: senders whose stored key predates
    ///    the joiner (and so is not addressed to it). The joiner may receive
    ///    undecryptable media from these senders until they observe the
    ///    broadcast rotation notice and re-announce keys addressed to the joiner.
    /// 3. Returns both the rotation notice to broadcast to existing participants
    ///    (backward secrecy) and a [`DecodeSuppressionNotice`] the caller hands
    ///    to the joiner so it can silence decrypt failures for the pending
    ///    senders until their keys arrive.
    pub fn handle_participant_join(&self, new_user_id: i64) -> ParticipantJoinOutcome {
        info!(
            room = %self.room_id,
            user = new_user_id,
            "participant joined, delivering stored keys"
        );

        // Senders whose current key is not addressed to the joiner. The joiner
        // must suppress decrypt failures for these until a re-announcement lands.
        let mut pending_senders = Vec::new();

        for entry in self.sender_keys.iter() {
            let stored = entry.value();
            // A participant never decrypts its own media, so its own stored key
            // is neither delivered to it nor a source of decrypt failures.
            if stored.sender_user_id == new_user_id {
                continue;
            }
            // Look for an encrypted key blob addressed to the new user.
            if let Some(ek) = stored
                .encrypted_keys
                .iter()
                .find(|ek| ek.recipient_user_id == new_user_id)
            {
                let deliver = MediaKeyDeliver {
                    sender_user_id: stored.sender_user_id,
                    epoch: stored.epoch,
                    ciphertext: ek.ciphertext.clone(),
                };
                debug!(
                    room = %self.room_id,
                    sender = stored.sender_user_id,
                    recipient = new_user_id,
                    epoch = stored.epoch,
                    "delivering stored key to late joiner"
                );
                (self.deliver_fn)(new_user_id, deliver);
            } else {
                // No key addressed to the joiner yet: this sender opens a
                // join-to-decrypt window until it re-announces.
                pending_senders.push(stored.sender_user_id);
            }
        }

        pending_senders.sort_unstable();

        if !pending_senders.is_empty() {
            debug!(
                room = %self.room_id,
                user = new_user_id,
                pending = pending_senders.len(),
                "late joiner has a decode-suppression window until keys re-announce"
            );
        }

        ParticipantJoinOutcome {
            rotation: KeyRotationNotification {
                reason: KeyRotationReason::ParticipantJoined,
                user_id: new_user_id,
            },
            decode_suppression: DecodeSuppressionNotice {
                pending_senders,
                suppress_for_ms: DECODE_SUPPRESSION_BACKSTOP_MS,
            },
        }
    }

    /// Handle a participant leaving the room.
    ///
    /// 1. Removes their stored sender key.
    /// 2. Returns a rotation notification for remaining participants (forward secrecy).
    pub fn handle_participant_leave(&self, leaving_user_id: i64) -> KeyRotationNotification {
        info!(
            room = %self.room_id,
            user = leaving_user_id,
            "participant left, removing stored key"
        );

        self.sender_keys.remove(&leaving_user_id);

        KeyRotationNotification {
            reason: KeyRotationReason::ParticipantLeft,
            user_id: leaving_user_id,
        }
    }

    /// Get the current epoch for a given sender, if known.
    pub fn current_epoch(&self, sender_user_id: i64) -> Option<u8> {
        self.sender_keys
            .get(&sender_user_id)
            .map(|entry| entry.epoch)
    }

    /// Get the number of stored sender keys (active senders in the room).
    pub fn sender_count(&self) -> usize {
        self.sender_keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Log of `(recipient_user_id, delivered payload)` captured during a test.
    type DeliveredKeys = Arc<Mutex<Vec<(i64, MediaKeyDeliver)>>>;

    /// Collects delivered keys for test assertions.
    fn mock_delivery() -> (KeyDeliveryFn, DeliveredKeys) {
        let delivered: DeliveredKeys = Arc::new(Mutex::new(Vec::new()));
        let delivered_clone = delivered.clone();
        let f: KeyDeliveryFn = Arc::new(move |user_id, deliver| {
            delivered_clone.lock().unwrap().push((user_id, deliver));
        });
        (f, delivered)
    }

    #[test]
    fn announce_delivers_to_recipients() {
        let (deliver_fn, delivered) = mock_delivery();
        let dist = KeyDistributor::new("room1".into(), deliver_fn);

        let announce = MediaKeyAnnounce {
            user_id: 100,
            epoch: 1,
            encrypted_keys: vec![
                EncryptedSenderKey {
                    recipient_user_id: 200,
                    ciphertext: vec![0xAA, 0xBB],
                },
                EncryptedSenderKey {
                    recipient_user_id: 300,
                    ciphertext: vec![0xCC, 0xDD],
                },
            ],
        };

        dist.handle_key_announce(announce);

        let msgs = delivered.lock().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].0, 200);
        assert_eq!(msgs[0].1.sender_user_id, 100);
        assert_eq!(msgs[0].1.epoch, 1);
        assert_eq!(msgs[0].1.ciphertext, vec![0xAA, 0xBB]);
        assert_eq!(msgs[1].0, 300);
        assert_eq!(msgs[1].1.ciphertext, vec![0xCC, 0xDD]);
    }

    #[test]
    fn late_joiner_receives_stored_keys() {
        let (deliver_fn, delivered) = mock_delivery();
        let dist = KeyDistributor::new("room1".into(), deliver_fn);

        // Sender 100 announces key for recipients 200 and 400 (the late joiner).
        let announce = MediaKeyAnnounce {
            user_id: 100,
            epoch: 3,
            encrypted_keys: vec![
                EncryptedSenderKey {
                    recipient_user_id: 200,
                    ciphertext: vec![0x11],
                },
                EncryptedSenderKey {
                    recipient_user_id: 400,
                    ciphertext: vec![0x22],
                },
            ],
        };
        dist.handle_key_announce(announce);

        // Clear initial deliveries.
        delivered.lock().unwrap().clear();

        // User 400 joins late.
        let outcome = dist.handle_participant_join(400);
        assert!(matches!(
            outcome.rotation.reason,
            KeyRotationReason::ParticipantJoined
        ));
        assert_eq!(outcome.rotation.user_id, 400);
        // Sender 100's key was already addressed to 400, so nothing is pending.
        assert!(!outcome.decode_suppression.is_active());
        assert!(outcome.decode_suppression.pending_senders.is_empty());

        let msgs = delivered.lock().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].0, 400);
        assert_eq!(msgs[0].1.sender_user_id, 100);
        assert_eq!(msgs[0].1.epoch, 3);
        assert_eq!(msgs[0].1.ciphertext, vec![0x22]);
    }

    #[test]
    fn late_joiner_without_addressed_key_gets_decode_suppression() {
        let (deliver_fn, delivered) = mock_delivery();
        let dist = KeyDistributor::new("room1".into(), deliver_fn);

        // Senders 100 and 200 announce keys addressed only to each other,
        // before user 900 joins. Sender 900 also has a stale self-key.
        dist.handle_key_announce(MediaKeyAnnounce {
            user_id: 100,
            epoch: 2,
            encrypted_keys: vec![EncryptedSenderKey {
                recipient_user_id: 200,
                ciphertext: vec![0x11],
            }],
        });
        dist.handle_key_announce(MediaKeyAnnounce {
            user_id: 200,
            epoch: 2,
            encrypted_keys: vec![EncryptedSenderKey {
                recipient_user_id: 100,
                ciphertext: vec![0x22],
            }],
        });
        dist.handle_key_announce(MediaKeyAnnounce {
            user_id: 900,
            epoch: 1,
            encrypted_keys: vec![EncryptedSenderKey {
                recipient_user_id: 100,
                ciphertext: vec![0x99],
            }],
        });
        delivered.lock().unwrap().clear();

        let outcome = dist.handle_participant_join(900);

        // Nothing is delivered to 900: no stored key is addressed to it.
        assert!(delivered.lock().unwrap().is_empty());

        // The joiner must suppress decrypt failures for both foreign senders,
        // but not for its own stale self-key.
        assert!(outcome.decode_suppression.is_active());
        assert_eq!(
            outcome.decode_suppression.pending_senders,
            vec![100, 200],
            "pending senders are sorted and exclude the joiner itself"
        );
        assert_eq!(
            outcome.decode_suppression.suppress_for_ms,
            DECODE_SUPPRESSION_BACKSTOP_MS
        );
    }

    #[test]
    fn participant_leave_removes_stored_key() {
        let (deliver_fn, _delivered) = mock_delivery();
        let dist = KeyDistributor::new("room1".into(), deliver_fn);

        let announce = MediaKeyAnnounce {
            user_id: 100,
            epoch: 1,
            encrypted_keys: vec![EncryptedSenderKey {
                recipient_user_id: 200,
                ciphertext: vec![0x01],
            }],
        };
        dist.handle_key_announce(announce);
        assert_eq!(dist.sender_count(), 1);

        let notification = dist.handle_participant_leave(100);
        assert!(matches!(
            notification.reason,
            KeyRotationReason::ParticipantLeft
        ));
        assert_eq!(dist.sender_count(), 0);
    }

    #[test]
    fn epoch_tracking() {
        let (deliver_fn, _delivered) = mock_delivery();
        let dist = KeyDistributor::new("room1".into(), deliver_fn);

        assert_eq!(dist.current_epoch(100), None);

        dist.handle_key_announce(MediaKeyAnnounce {
            user_id: 100,
            epoch: 1,
            encrypted_keys: vec![],
        });
        assert_eq!(dist.current_epoch(100), Some(1));

        // Re-announce with higher epoch.
        dist.handle_key_announce(MediaKeyAnnounce {
            user_id: 100,
            epoch: 5,
            encrypted_keys: vec![],
        });
        assert_eq!(dist.current_epoch(100), Some(5));
    }
}
