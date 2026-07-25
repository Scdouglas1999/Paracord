use std::collections::VecDeque;

use dashmap::DashMap;

use crate::signaling::{SpeakerInfo, SpeakerUpdate};

/// Number of packets in the sliding window for audio level averaging.
/// At 20ms per packet, 5 packets = 100ms window.
const WINDOW_SIZE: usize = 5;

/// Audio level threshold below which a user is considered "speaking".
/// The audio_level byte uses dBov scale where 0 = loudest, 127 = silence.
/// Values below this threshold indicate speech activity.
const SPEAKING_THRESHOLD: u8 = 100;

/// Per-user audio level history for sliding window averaging.
#[allow(dead_code)]
struct AudioLevelHistory {
    levels: VecDeque<u8>,
    room_id: String,
}

impl AudioLevelHistory {
    fn new(room_id: String) -> Self {
        Self {
            levels: VecDeque::with_capacity(WINDOW_SIZE),
            room_id,
        }
    }

    /// Add a new audio level sample and return the current average.
    fn push(&mut self, level: u8) -> u8 {
        if self.levels.len() >= WINDOW_SIZE {
            self.levels.pop_front();
        }
        self.levels.push_back(level);
        self.average()
    }

    /// Compute the average audio level across the window.
    fn average(&self) -> u8 {
        if self.levels.is_empty() {
            return 127; // silence
        }
        let sum: u32 = self.levels.iter().map(|&l| l as u32).sum();
        (sum / self.levels.len() as u32) as u8
    }

    /// Whether the user is currently speaking based on the sliding window average.
    fn is_speaking(&self) -> bool {
        self.average() < SPEAKING_THRESHOLD
    }
}

/// Upper bound on tracked audio-level histories.
///
/// The key is nominally a `user_id`, but the federation ingress path reports
/// levels keyed by the raw `ssrc` off an incoming packet header
/// (`FederationRelay::handle_incoming_federation_packet`), which is
/// remote-controlled and 32 bits wide. Entries are only removed on an explicit
/// `remove_user`, which never fires for a sprayed identifier — so without a cap
/// this map grows toward 2^32 entries from unauthenticated input. A server-wide
/// 8192 comfortably exceeds any real concurrent-speaker count (rooms cap at 50
/// participants) while making the growth bounded.
const MAX_TRACKED_SPEAKERS: usize = 8192;

/// Detects active speakers by analyzing the cleartext audio_level byte
/// from MediaHeader packets.
pub struct SpeakerDetector {
    /// Per-user audio level histories, keyed by user_id.
    histories: DashMap<i64, AudioLevelHistory>,
}

impl SpeakerDetector {
    pub fn new() -> Self {
        Self {
            histories: DashMap::new(),
        }
    }

    /// Report an audio level for a user.
    ///
    /// Reporting for an identifier that is not already tracked is refused once
    /// the map is at [`MAX_TRACKED_SPEAKERS`]; updates to already-tracked
    /// identifiers always proceed, so a saturated map degrades to "no new
    /// speakers detected" rather than unbounded growth. Real participants are
    /// registered long before that ceiling is reachable.
    pub fn report_audio_level(&self, user_id: i64, room_id: &str, level: u8) {
        if let Some(mut entry) = self.histories.get_mut(&user_id) {
            entry.push(level);
            return;
        }
        if self.histories.len() >= MAX_TRACKED_SPEAKERS {
            tracing::debug!(
                user_id,
                room_id,
                "speaker detector at capacity; refusing to track a new identifier"
            );
            return;
        }
        let mut entry = self
            .histories
            .entry(user_id)
            .or_insert_with(|| AudioLevelHistory::new(room_id.to_string()));
        entry.push(level);
    }

    /// Remove tracking for a user (on disconnect).
    pub fn remove_user(&self, user_id: i64) {
        self.histories.remove(&user_id);
    }

    /// Get the current speaker update for a room.
    pub fn get_speaker_update(&self, room_user_ids: &[i64]) -> SpeakerUpdate {
        let speakers: Vec<SpeakerInfo> = room_user_ids
            .iter()
            .filter_map(|&uid| {
                self.histories.get(&uid).map(|hist| SpeakerInfo {
                    user_id: uid,
                    audio_level: hist.average(),
                    speaking: hist.is_speaking(),
                })
            })
            .collect();

        SpeakerUpdate { speakers }
    }

    /// Check if a specific user is currently speaking.
    pub fn is_speaking(&self, user_id: i64) -> bool {
        self.histories
            .get(&user_id)
            .map(|h| h.is_speaking())
            .unwrap_or(false)
    }

    /// Get the average audio level for a user.
    pub fn get_audio_level(&self, user_id: i64) -> u8 {
        self.histories
            .get(&user_id)
            .map(|h| h.average())
            .unwrap_or(127)
    }
}

impl Default for SpeakerDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_not_speaking() {
        let detector = SpeakerDetector::new();
        // 127 = silence
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 127);
        }
        assert!(!detector.is_speaking(1));
        assert_eq!(detector.get_audio_level(1), 127);
    }

    #[test]
    fn loud_audio_is_speaking() {
        let detector = SpeakerDetector::new();
        // 30 = loud audio (well below threshold of 100)
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 30);
        }
        assert!(detector.is_speaking(1));
        assert_eq!(detector.get_audio_level(1), 30);
    }

    #[test]
    fn threshold_boundary() {
        let detector = SpeakerDetector::new();
        // Exactly at threshold should NOT be speaking (threshold is <100)
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 100);
        }
        assert!(!detector.is_speaking(1));

        // Just below threshold should be speaking
        let detector2 = SpeakerDetector::new();
        for _ in 0..5 {
            detector2.report_audio_level(1, "room1", 99);
        }
        assert!(detector2.is_speaking(1));
    }

    #[test]
    fn sliding_window_average() {
        let detector = SpeakerDetector::new();
        // Push values that should average to ~50
        detector.report_audio_level(1, "room1", 40);
        detector.report_audio_level(1, "room1", 50);
        detector.report_audio_level(1, "room1", 60);
        detector.report_audio_level(1, "room1", 40);
        detector.report_audio_level(1, "room1", 60);
        // Average = (40+50+60+40+60)/5 = 250/5 = 50
        assert_eq!(detector.get_audio_level(1), 50);
        assert!(detector.is_speaking(1));
    }

    #[test]
    fn window_rolls_over() {
        let detector = SpeakerDetector::new();
        // Fill window with loud audio
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 20);
        }
        assert!(detector.is_speaking(1));

        // Now push silence to replace the window
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 127);
        }
        assert!(!detector.is_speaking(1));
    }

    #[test]
    fn unknown_user_defaults() {
        let detector = SpeakerDetector::new();
        assert!(!detector.is_speaking(999));
        assert_eq!(detector.get_audio_level(999), 127);
    }

    #[test]
    fn remove_user() {
        let detector = SpeakerDetector::new();
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 30);
        }
        assert!(detector.is_speaking(1));
        detector.remove_user(1);
        assert!(!detector.is_speaking(1));
    }

    #[test]
    fn speaker_update_for_room() {
        let detector = SpeakerDetector::new();
        // User 1: speaking
        for _ in 0..5 {
            detector.report_audio_level(1, "room1", 30);
        }
        // User 2: silent
        for _ in 0..5 {
            detector.report_audio_level(2, "room1", 127);
        }

        let update = detector.get_speaker_update(&[1, 2, 3]);
        assert_eq!(update.speakers.len(), 2); // user 3 has no history

        let s1 = update.speakers.iter().find(|s| s.user_id == 1).unwrap();
        assert!(s1.speaking);
        assert_eq!(s1.audio_level, 30);

        let s2 = update.speakers.iter().find(|s| s.user_id == 2).unwrap();
        assert!(!s2.speaking);
        assert_eq!(s2.audio_level, 127);
    }
}
