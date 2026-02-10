use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

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
    /// The user_id currently streaming in this channel, if any.
    /// Only one stream per channel at a time (like Discord Go Live).
    pub active_streamer: Option<i64>,
}

pub struct VoiceManager {
    livekit: Arc<super::livekit::LiveKitConfig>,
    rooms: RwLock<HashMap<i64, VoiceRoom>>,
    /// Maps channel_id -> LiveKit room name
    active_livekit_rooms: Arc<RwLock<HashMap<i64, String>>>,
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
            rooms: RwLock::new(HashMap::new()),
            active_livekit_rooms: Arc::new(RwLock::new(HashMap::new())),
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
        {
            let mut lk_rooms = self.active_livekit_rooms.write().await;
            if let std::collections::hash_map::Entry::Vacant(e) = lk_rooms.entry(channel_id) {
                self.livekit.create_room(&room_name, 99, bitrate).await?;
                e.insert(room_name.clone());
            }
        }

        // Track participant locally
        {
            let mut rooms = self.rooms.write().await;
            let room = rooms.entry(channel_id).or_insert_with(|| VoiceRoom {
                guild_id,
                channel_id,
                participants: HashMap::new(),
                audio_bitrate: bitrate,
                active_streamer: None,
            });
            room.participants.insert(user_id, VoiceParticipant {
                user_id,
                session_id: session_id.to_string(),
                self_mute: false,
                self_deaf: false,
                self_stream: false,
                self_video: false,
                server_mute: false,
                server_deaf: false,
                priority_speaker: false,
            });
        }

        // Generate participant token
        let token = self.livekit.generate_voice_token(
            &room_name,
            user_id,
            username,
            can_speak,
            true,
        )?;

        Ok(VoiceJoinResponse {
            token,
            url: self.livekit.url.clone(),
            room_name,
        })
    }

    /// Start streaming in a voice channel.
    /// Only one stream per channel at a time. Returns error if someone is already streaming.
    pub async fn start_stream(
        &self,
        channel_id: i64,
        guild_id: i64,
        user_id: i64,
        username: &str,
        stream_title: Option<&str>,
    ) -> Result<StreamStartResponse, anyhow::Error> {
        let room_name = format!("guild_{}_channel_{}", guild_id, channel_id);

        // Enforce one stream per channel
        {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(&channel_id) {
                if let Some(existing) = room.active_streamer {
                    if existing != user_id {
                        anyhow::bail!(
                            "Channel already has an active stream from user {}",
                            existing
                        );
                    }
                }
                room.active_streamer = Some(user_id);

                // Update participant state
                if let Some(p) = room.participants.get_mut(&user_id) {
                    p.self_stream = true;
                }
            }
        }

        let token = self.livekit.generate_stream_token(
            &room_name,
            user_id,
            username,
            stream_title,
        )?;

        Ok(StreamStartResponse {
            token,
            url: self.livekit.url.clone(),
            room_name,
        })
    }

    /// Stop streaming in a voice channel.
    pub async fn stop_stream(&self, channel_id: i64, user_id: i64) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(&channel_id) {
            if room.active_streamer == Some(user_id) {
                room.active_streamer = None;
            }
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_stream = false;
            }
        }
    }

    /// Get the active streamer in a channel, if any.
    pub async fn get_active_streamer(&self, channel_id: i64) -> Option<i64> {
        let rooms = self.rooms.read().await;
        rooms.get(&channel_id).and_then(|r| r.active_streamer)
    }

    pub async fn join_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        session_id: &str,
    ) -> Vec<VoiceParticipant> {
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(channel_id).or_insert_with(|| VoiceRoom {
            guild_id,
            channel_id,
            participants: HashMap::new(),
            audio_bitrate: AudioBitrate::default(),
            active_streamer: None,
        });

        room.participants.insert(user_id, VoiceParticipant {
            user_id,
            session_id: session_id.to_string(),
            self_mute: false,
            self_deaf: false,
            self_stream: false,
            self_video: false,
            server_mute: false,
            server_deaf: false,
            priority_speaker: false,
        });

        room.participants.values().cloned().collect()
    }

    pub async fn leave_room(&self, channel_id: i64, user_id: i64) -> Option<Vec<VoiceParticipant>> {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(&channel_id) {
            room.participants.remove(&user_id);

            // Clear active streamer if the leaver was streaming
            if room.active_streamer == Some(user_id) {
                room.active_streamer = None;
            }

            if room.participants.is_empty() {
                rooms.remove(&channel_id);
                return Some(vec![]);
            }
            return Some(room.participants.values().cloned().collect());
        }
        None
    }

    /// Clean up LiveKit room when the voice channel is empty.
    pub async fn cleanup_room(&self, channel_id: i64) -> Result<(), anyhow::Error> {
        let mut lk_rooms = self.active_livekit_rooms.write().await;
        if let Some(room_name) = lk_rooms.remove(&channel_id) {
            self.livekit.delete_room(&room_name).await?;
        }
        Ok(())
    }

    pub async fn get_room_participants(&self, channel_id: i64) -> Vec<VoiceParticipant> {
        let rooms = self.rooms.read().await;
        rooms.get(&channel_id)
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
        let room_name = {
            let rooms = self.rooms.read().await;
            let room = rooms.get(&channel_id)
                .ok_or_else(|| anyhow::anyhow!("Voice room not found for channel {}", channel_id))?;
            format!("guild_{}_channel_{}", room.guild_id, channel_id)
        };

        // Update local state
        {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(&channel_id) {
                if let Some(p) = room.participants.get_mut(&user_id) {
                    p.server_mute = muted;
                }
            }
        }

        // Update LiveKit permissions
        let identity = user_id.to_string();
        self.livekit.update_participant(
            &room_name,
            &identity,
            Some(!muted), // can_publish = !muted
            None,
        ).await?;

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
        let room_name = {
            let rooms = self.rooms.read().await;
            let room = rooms.get(&channel_id)
                .ok_or_else(|| anyhow::anyhow!("Voice room not found for channel {}", channel_id))?;
            format!("guild_{}_channel_{}", room.guild_id, channel_id)
        };

        // Update local state
        {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(&channel_id) {
                if let Some(p) = room.participants.get_mut(&user_id) {
                    p.server_deaf = deafened;
                    // Server deafen implies server mute
                    if deafened {
                        p.server_mute = true;
                    }
                }
            }
        }

        // Update LiveKit permissions
        let identity = user_id.to_string();
        self.livekit.update_participant(
            &room_name,
            &identity,
            Some(!deafened), // can_publish = !deafened (deafen implies mute)
            Some(!deafened), // can_subscribe = !deafened
        ).await?;

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
        {
            let mut rooms = self.rooms.write().await;
            if let Some(room) = rooms.get_mut(&channel_id) {
                if let Some(p) = room.participants.get_mut(&user_id) {
                    p.priority_speaker = priority;
                }
            }
        }

        if priority {
            let room_name = format!("guild_{}_channel_{}", guild_id, channel_id);
            let token = self.livekit.generate_priority_speaker_token(
                &room_name,
                user_id,
                username,
            )?;
            Ok(Some(token))
        } else {
            Ok(None)
        }
    }

    /// Update self-mute state for a participant.
    pub async fn update_self_mute(&self, channel_id: i64, user_id: i64, muted: bool) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_mute = muted;
            }
        }
    }

    /// Update self-deaf state for a participant.
    pub async fn update_self_deaf(&self, channel_id: i64, user_id: i64, deafened: bool) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(&channel_id) {
            if let Some(p) = room.participants.get_mut(&user_id) {
                p.self_deaf = deafened;
                // Self-deafen implies self-mute
                if deafened {
                    p.self_mute = true;
                }
            }
        }
    }

    /// Get the LiveKit room name for a channel, if active.
    pub async fn get_room_name(&self, channel_id: i64) -> Option<String> {
        let lk_rooms = self.active_livekit_rooms.read().await;
        lk_rooms.get(&channel_id).cloned()
    }
}
