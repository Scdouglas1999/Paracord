use dashmap::DashMap;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::livekit::AudioBitrate;

#[derive(Debug, Clone)]
pub struct VoiceParticipant {
    pub user_id: i64,
    pub session_id: String,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_stream: bool,
    pub self_video: bool,
    /// Server-imposed mute (moderator action).
    pub server_mute: bool,
    /// Server-imposed deafen (moderator action).
    pub server_deaf: bool,
    /// Whether this user is a priority speaker in the channel.
    pub priority_speaker: bool,
}

#[derive(Debug, Clone)]
pub struct VoiceRoom {
    pub guild_id: i64,
    pub channel_id: i64,
    pub participants: HashMap<i64, VoiceParticipant>,
    pub audio_bitrate: AudioBitrate,
    /// User IDs currently streaming in this channel.
    pub active_streamers: HashSet<i64>,
}

pub struct VoiceManager {
    livekit: Arc<super::livekit::LiveKitConfig>,
    rooms: DashMap<i64, VoiceRoom>,
    /// Maps channel_id -> LiveKit room name
    active_livekit_rooms: DashMap<i64, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VoiceJoinResponse {
    pub token: String,
    pub url: String,
    pub room_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StreamStartResponse {
    pub token: String,
    pub url: String,
    pub room_name: String,
}

impl VoiceManager {
    pub fn new(livekit: Arc<super::livekit::LiveKitConfig>) -> Self {
        Self {
            livekit,
            rooms: DashMap::new(),
            active_livekit_rooms: DashMap::new(),
        }
    }

    /// Join a voice channel - creates LiveKit room if needed, returns token.
    #[allow(clippy::too_many_arguments)]
    pub async fn join_channel(
        &self,
        channel_id: i64,
        guild_id: i64,
        user_id: i64,
        username: &str,
        session_id: &str,
        can_speak: bool,
        bitrate: AudioBitrate,
    ) -> Result<VoiceJoinResponse, anyhow::Error> {
        let room_name = format!("guild_{}_channel_{}", guild_id, channel_id);

        // Create LiveKit room if it doesn't exist
        if self.active_livekit_rooms.get(&channel_id).is_none() {
            self.livekit.create_room(&room_name, 99, bitrate).await?;
            self.active_livekit_rooms
                .entry(channel_id)
                .or_insert_with(|| room_name.clone());
        }

        // Track participant locally
        {
            let mut room = self.rooms.entry(channel_id).or_insert_with(|| VoiceRoom {
                guild_id,
                channel_id,
                participants: HashMap::new(),
                audio_bitrate: bitrate,
                active_streamers: HashSet::new(),
            });
            room.value_mut().participants.insert(
                user_id,
                VoiceParticipant {
                    user_id,
                    session_id: session_id.to_string(),
                    self_mute: false,
                    self_deaf: false,
                    self_stream: false,
                    self_video: false,
                    server_mute: false,
                    server_deaf: false,
                    priority_speaker: false,
                },
            );
        }

        // Generate participant token
        let token = self
            .livekit
            .generate_voice_token(&room_name, user_id, username, can_speak, true)?;

        Ok(VoiceJoinResponse {
            token,
            url: self.livekit.url.clone(),
            room_name,
        })
    }

    /// Start streaming in a voice channel.
    pub async fn start_stream(
        &self,
        channel_id: i64,
        guild_id: i64,
        user_id: i64,
        username: &str,
        stream_title: Option<&str>,
    ) -> Result<StreamStartResponse, anyhow::Error> {
        let room_name = format!("guild_{}_channel_{}", guild_id, channel_id);

        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            room.active_streamers.insert(user_id);

            // Update participant state
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_stream = true;
            }
        }

        let token =
            self.livekit
                .generate_stream_token(&room_name, user_id, username, stream_title)?;

        Ok(StreamStartResponse {
            token,
            url: self.livekit.url.clone(),
            room_name,
        })
    }

    /// Stop streaming in a voice channel.
    pub async fn stop_stream(&self, channel_id: i64, user_id: i64) {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            room.active_streamers.remove(&user_id);
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_stream = false;
            }
        }
    }

    /// Get active streamers in a channel.
    pub async fn get_active_streamers(&self, channel_id: i64) -> Vec<i64> {
        self.rooms
            .get(&channel_id)
            .map(|r| r.active_streamers.iter().copied().collect())
            .unwrap_or_default()
    }

    pub async fn join_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        session_id: &str,
    ) -> Vec<VoiceParticipant> {
        let mut room = self.rooms.entry(channel_id).or_insert_with(|| VoiceRoom {
            guild_id,
            channel_id,
            participants: HashMap::new(),
            audio_bitrate: AudioBitrate::default(),
            active_streamers: HashSet::new(),
        });

        room.value_mut().participants.insert(
            user_id,
            VoiceParticipant {
                user_id,
                session_id: session_id.to_string(),
                self_mute: false,
                self_deaf: false,
                self_stream: false,
                self_video: false,
                server_mute: false,
                server_deaf: false,
                priority_speaker: false,
            },
        );

        room.value().participants.values().cloned().collect()
    }

    pub async fn leave_room(&self, channel_id: i64, user_id: i64) -> Option<Vec<VoiceParticipant>> {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            room.participants.remove(&user_id);

            // Clear active stream state if the leaver was streaming
            room.active_streamers.remove(&user_id);

            if room.participants.is_empty() {
                drop(room);
                self.rooms.remove(&channel_id);
                return Some(vec![]);
            }
            return Some(room.participants.values().cloned().collect());
        }
        None
    }

    /// Clean up LiveKit room when the voice channel is empty.
    pub async fn cleanup_room(&self, channel_id: i64) -> Result<(), anyhow::Error> {
        if let Some((_, room_name)) = self.active_livekit_rooms.remove(&channel_id) {
            self.livekit.delete_room(&room_name).await?;
        }
        Ok(())
    }

    /// Check whether a specific participant is currently tracked in a room (local state).
    pub async fn is_participant_in_room(&self, channel_id: i64, user_id: i64) -> bool {
        self.rooms
            .get(&channel_id)
            .map(|r| r.participants.contains_key(&user_id))
            .unwrap_or(false)
    }

    /// Check whether a specific participant is actually connected in the LiveKit room.
    /// Queries the LiveKit server directly — this is the ground truth for connection status.
    ///
    /// `guild_id` is optional and used as a deterministic fallback when
    /// in-memory room tracking has been lost (e.g. after process restart).
    pub async fn is_participant_in_livekit_room(
        &self,
        channel_id: i64,
        guild_id: Option<i64>,
        user_id: i64,
    ) -> Option<bool> {
        let tracked_room_name = self
            .active_livekit_rooms
            .get(&channel_id)
            .map(|name| name.value().clone());
        let room_name = if let Some(name) = tracked_room_name {
            name
        } else if let Some(gid) = guild_id {
            format!("guild_{}_channel_{}", gid, channel_id)
        } else {
            match self.rooms.get(&channel_id) {
                Some(room) => format!("guild_{}_channel_{}", room.guild_id, channel_id),
                None => return Some(false),
            }
        };
        match self.livekit.list_participants(&room_name).await {
            Ok(participants) => {
                let user_id_str = user_id.to_string();
                Some(participants.iter().any(|p| {
                    p.get("identity")
                        .and_then(|v| v.as_str())
                        .map(|id| id == user_id_str)
                        .unwrap_or(false)
                }))
            }
            Err(err) => {
                tracing::warn!(
                    channel_id,
                    user_id,
                    room_name = %room_name,
                    error = %err,
                    "LiveKit participant check failed; presence is UNKNOWN. \
                     Skipping cleanup decisions for this participant until LiveKit is reachable."
                );
                None
            }
        }
    }

    pub async fn get_room_participants(&self, channel_id: i64) -> Vec<VoiceParticipant> {
        self.rooms
            .get(&channel_id)
            .map(|r| r.participants.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Server-side mute a user via LiveKit API.
    /// Sets `server_mute` locally and revokes publish permission on the LiveKit side.
    pub async fn server_mute_user(
        &self,
        channel_id: i64,
        user_id: i64,
        muted: bool,
    ) -> Result<(), anyhow::Error> {
        let room_name = self
            .rooms
            .get(&channel_id)
            .map(|room| format!("guild_{}_channel_{}", room.guild_id, channel_id))
            .ok_or_else(|| anyhow::anyhow!("Voice room not found for channel {}", channel_id))?;

        // Update local state
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.server_mute = muted;
            }
        }

        // Update LiveKit permissions
        let identity = user_id.to_string();
        self.livekit
            .update_participant(
                &room_name,
                &identity,
                Some(!muted), // can_publish = !muted
                None,
            )
            .await?;

        Ok(())
    }

    /// Server-side deafen a user via LiveKit API.
    /// Sets `server_deaf` locally and revokes subscribe permission on the LiveKit side.
    pub async fn server_deafen_user(
        &self,
        channel_id: i64,
        user_id: i64,
        deafened: bool,
    ) -> Result<(), anyhow::Error> {
        let room_name = self
            .rooms
            .get(&channel_id)
            .map(|room| format!("guild_{}_channel_{}", room.guild_id, channel_id))
            .ok_or_else(|| anyhow::anyhow!("Voice room not found for channel {}", channel_id))?;

        // Update local state
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.server_deaf = deafened;
                // Server deafen implies server mute
                if deafened {
                    p.server_mute = true;
                }
            }
        }

        // Update LiveKit permissions
        let identity = user_id.to_string();
        self.livekit
            .update_participant(
                &room_name,
                &identity,
                Some(!deafened), // can_publish = !deafened (deafen implies mute)
                Some(!deafened), // can_subscribe = !deafened
            )
            .await?;

        Ok(())
    }

    /// Set a user as priority speaker. Regenerates their token with priority metadata.
    pub async fn set_priority_speaker(
        &self,
        channel_id: i64,
        guild_id: i64,
        user_id: i64,
        username: &str,
        priority: bool,
    ) -> Result<Option<String>, anyhow::Error> {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.priority_speaker = priority;
            }
        }

        if priority {
            let room_name = format!("guild_{}_channel_{}", guild_id, channel_id);
            let token = self
                .livekit
                .generate_priority_speaker_token(&room_name, user_id, username)?;
            Ok(Some(token))
        } else {
            Ok(None)
        }
    }

    /// Update self-mute state for a participant.
    pub async fn update_self_mute(&self, channel_id: i64, user_id: i64, muted: bool) {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_mute = muted;
            }
        }
    }

    /// Update self-deaf state for a participant.
    pub async fn update_self_deaf(&self, channel_id: i64, user_id: i64, deafened: bool) {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_deaf = deafened;
                // Self-deafen implies self-mute
                if deafened {
                    p.self_mute = true;
                }
            }
        }
    }

    /// Check whether a participant is currently streaming in a channel.
    pub async fn get_participant_stream_state(&self, channel_id: i64, user_id: i64) -> bool {
        if let Some(room) = self.rooms.get(&channel_id) {
            room.participants
                .get(&user_id)
                .map(|p| p.self_stream)
                .unwrap_or(false)
        } else {
            false
        }
    }

    /// Update self-video state for a participant.
    pub async fn update_self_video(&self, channel_id: i64, user_id: i64, video: bool) {
        if let Some(mut room) = self.rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_video = video;
            }
        }
    }

    /// Check whether a participant has video enabled in a channel.
    pub async fn get_participant_video_state(&self, channel_id: i64, user_id: i64) -> bool {
        if let Some(room) = self.rooms.get(&channel_id) {
            room.participants
                .get(&user_id)
                .map(|p| p.self_video)
                .unwrap_or(false)
        } else {
            false
        }
    }

    /// Get the LiveKit room name for a channel, if active.
    pub async fn get_room_name(&self, channel_id: i64) -> Option<String> {
        self.active_livekit_rooms
            .get(&channel_id)
            .map(|room| room.value().clone())
    }
}
