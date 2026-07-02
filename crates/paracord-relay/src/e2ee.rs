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
    /// 1. Delivers all stored current sender keys to the new participant.
    /// 2. Returns a rotation notification that should be broadcast to existing
    ///    participants so they rotate their keys (backward secrecy).
    pub fn handle_participant_join(&self, new_user_id: i64) -> KeyRotationNotification {
        info!(
            room = %self.room_id,
            user = new_user_id,
            "participant joined, delivering stored keys"
        );

        // Deliver all stored sender keys to the new joiner.
        // The sender keys are encrypted per-recipient, so we look for entries
        // that include the new user. If no entry exists for the new user
        // (keys were encrypted before they joined), senders will re-announce
        // after receiving the rotation notification.
        for entry in self.sender_keys.iter() {
            let stored = entry.value();
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
            }
        }

        KeyRotationNotification {
            reason: KeyRotationReason::ParticipantJoined,
            user_id: new_user_id,
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

    /// Collects delivered keys for test assertions.
    fn mock_delivery() -> (KeyDeliveryFn, Arc<Mutex<Vec<(i64, MediaKeyDeliver)>>>) {
        let delivered: Arc<Mutex<Vec<(i64, MediaKeyDeliver)>>> = Arc::new(Mutex::new(Vec::new()));
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
        let notification = dist.handle_participant_join(400);
        assert!(matches!(
            notification.reason,
            KeyRotationReason::ParticipantJoined
        ));
        assert_eq!(notification.user_id, 400);

        let msgs = delivered.lock().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].0, 400);
        assert_eq!(msgs[0].1.sender_user_id, 100);
        assert_eq!(msgs[0].1.epoch, 3);
        assert_eq!(msgs[0].1.ciphertext, vec![0x22]);
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
