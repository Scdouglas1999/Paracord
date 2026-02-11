use serde::{Serialize, Deserialize};
use jsonwebtoken::{encode, Header, Algorithm, EncodingKey};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct LiveKitConfig {
    pub api_key: String,
    pub api_secret: String,
    pub url: String,       // ws://localhost:7880
    pub http_url: String,  // http://localhost:7880
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoGrant {
    #[serde(rename = "roomCreate", skip_serializing_if = "Option::is_none")]
    pub room_create: Option<bool>,
    #[serde(rename = "roomList", skip_serializing_if = "Option::is_none")]
    pub room_list: Option<bool>,
    #[serde(rename = "roomAdmin", skip_serializing_if = "Option::is_none")]
    pub room_admin: Option<bool>,
    #[serde(rename = "roomJoin", skip_serializing_if = "Option::is_none")]
    pub room_join: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(rename = "canPublish", skip_serializing_if = "Option::is_none")]
    pub can_publish: Option<bool>,
    #[serde(rename = "canSubscribe", skip_serializing_if = "Option::is_none")]
    pub can_subscribe: Option<bool>,
    #[serde(rename = "canPublishData", skip_serializing_if = "Option::is_none")]
    pub can_publish_data: Option<bool>,
    #[serde(rename = "canPublishSources", skip_serializing_if = "Option::is_none")]
    pub can_publish_sources: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

impl VideoGrant {
    fn admin() -> Self {
        Self {
            room_create: Some(true),
            room_list: Some(true),
            room_admin: Some(true),
            room_join: None,
            room: None,
            can_publish: None,
            can_subscribe: None,
            can_publish_data: None,
            can_publish_sources: None,
            hidden: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LiveKitClaims {
    pub exp: u64,
    pub iss: String,
    pub sub: String,
    pub name: Option<String>,
    pub video: VideoGrant,
    #[serde(rename = "metadata", skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// Audio bitrate presets for voice channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum AudioBitrate {
    Low,     // 64 kbps
    #[default]
    Medium,  // 96 kbps
    High,    // 128 kbps
}

impl AudioBitrate {
    pub fn kbps(self) -> u32 {
        match self {
            AudioBitrate::Low => 64,
            AudioBitrate::Medium => 96,
            AudioBitrate::High => 128,
        }
    }
}

/// Parsed LiveKit webhook event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookEvent {
    pub event: String,
    pub room: Option<WebhookRoom>,
    pub participant: Option<WebhookParticipant>,
    pub track: Option<WebhookTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookRoom {
    pub name: Option<String>,
    pub sid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookParticipant {
    pub identity: Option<String>,
    pub sid: Option<String>,
    pub name: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTrack {
    pub sid: Option<String>,
    pub source: Option<String>,
    #[serde(rename = "type")]
    pub track_type: Option<String>,
    pub muted: Option<bool>,
}

impl LiveKitConfig {
    /// Generate an admin token for LiveKit API calls.
    fn generate_admin_token(&self, grant: VideoGrant) -> Result<String, anyhow::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let claims = LiveKitClaims {
            exp: now + 300,
            iss: self.api_key.clone(),
            sub: "admin".to_string(),
            name: None,
            video: grant,
            metadata: None,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )?;
        Ok(token)
    }

    /// Generate a token for joining a voice channel.
    ///
    /// `can_publish` controls whether the user can speak (false = listen-only / push-to-talk off).
    /// `can_subscribe` controls whether the user receives audio from others (false = server-deafened).
    pub fn generate_voice_token(
        &self,
        room_name: &str,
        user_id: i64,
        user_name: &str,
        can_publish: bool,
        can_subscribe: bool,
    ) -> Result<String, anyhow::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let metadata = serde_json::json!({
            "user_id": user_id,
            "priority_speaker": false,
        });

        // Only specify can_publish_sources when publishing is allowed.
        // When can_publish is false (listen-only), can_publish_sources must
        // be omitted — otherwise LiveKit treats it as a whitelist that
        // overrides can_publish and allows publishing from those sources.
        let publish_sources = if can_publish {
            Some(vec![
                "microphone".to_string(),
                "screen_share".to_string(),
                "screen_share_audio".to_string(),
            ])
        } else {
            None
        };

        let claims = LiveKitClaims {
            exp: now + 86400,
            iss: self.api_key.clone(),
            sub: user_id.to_string(),
            name: Some(user_name.to_string()),
            video: VideoGrant {
                room_join: Some(true),
                room: Some(room_name.to_string()),
                can_publish: Some(can_publish),
                can_subscribe: Some(can_subscribe),
                can_publish_data: Some(true),
                can_publish_sources: publish_sources,
                room_create: None,
                room_list: None,
                room_admin: None,
                hidden: None,
            },
            metadata: Some(metadata.to_string()),
        };

        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )?;
        Ok(token)
    }

    /// Generate a token for a priority speaker in a voice channel.
    pub fn generate_priority_speaker_token(
        &self,
        room_name: &str,
        user_id: i64,
        user_name: &str,
    ) -> Result<String, anyhow::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let metadata = serde_json::json!({
            "user_id": user_id,
            "priority_speaker": true,
        });

        let claims = LiveKitClaims {
            exp: now + 86400,
            iss: self.api_key.clone(),
            sub: user_id.to_string(),
            name: Some(user_name.to_string()),
            video: VideoGrant {
                room_join: Some(true),
                room: Some(room_name.to_string()),
                can_publish: Some(true),
                can_subscribe: Some(true),
                can_publish_data: Some(true),
                can_publish_sources: Some(vec![
                    "microphone".to_string(),
                    "screen_share".to_string(),
                    "screen_share_audio".to_string(),
                ]),
                room_create: None,
                room_list: None,
                room_admin: None,
                hidden: None,
            },
            metadata: Some(metadata.to_string()),
        };

        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )?;
        Ok(token)
    }

    /// Generate a token for screen sharing/streaming.
    pub fn generate_stream_token(
        &self,
        room_name: &str,
        user_id: i64,
        user_name: &str,
        stream_title: Option<&str>,
    ) -> Result<String, anyhow::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();

        let metadata = serde_json::json!({
            "user_id": user_id,
            "streaming": true,
            "stream_title": stream_title.unwrap_or(""),
        });

        let claims = LiveKitClaims {
            exp: now + 86400,
            iss: self.api_key.clone(),
            sub: user_id.to_string(),
            name: Some(user_name.to_string()),
            video: VideoGrant {
                room_join: Some(true),
                room: Some(room_name.to_string()),
                can_publish: Some(true),
                can_subscribe: Some(true),
                can_publish_data: Some(true),
                can_publish_sources: Some(vec![
                    "microphone".to_string(),
                    "screen_share".to_string(),
                    "screen_share_audio".to_string(),
                ]),
                room_create: None,
                room_list: None,
                room_admin: None,
                hidden: None,
            },
            metadata: Some(metadata.to_string()),
        };

        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )?;
        Ok(token)
    }

    /// Generate a view-only token for watching a stream (cannot publish video/screen).
    pub fn generate_stream_viewer_token(
        &self,
        room_name: &str,
        user_id: i64,
        user_name: &str,
    ) -> Result<String, anyhow::Error> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let claims = LiveKitClaims {
            exp: now + 86400,
            iss: self.api_key.clone(),
            sub: user_id.to_string(),
            name: Some(user_name.to_string()),
            video: VideoGrant {
                room_join: Some(true),
                room: Some(room_name.to_string()),
                can_publish: Some(false),
                can_subscribe: Some(true),
                can_publish_data: Some(true),
                can_publish_sources: None,
                room_create: None,
                room_list: None,
                room_admin: None,
                hidden: None,
            },
            metadata: None,
        };

        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )?;
        Ok(token)
    }

    /// Create a room via LiveKit API.
    pub async fn create_room(
        &self,
        room_name: &str,
        max_participants: u32,
        audio_bitrate: AudioBitrate,
    ) -> Result<(), anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant::admin())?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/CreateRoom", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "name": room_name,
                "max_participants": max_participants,
                "empty_timeout": 300,
                "metadata": serde_json::json!({
                    "audio_bitrate_kbps": audio_bitrate.kbps(),
                }).to_string(),
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to create LiveKit room: {}", err);
        }

        Ok(())
    }

    /// Delete a room via LiveKit API.
    pub async fn delete_room(&self, room_name: &str) -> Result<(), anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant::admin())?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/DeleteRoom", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "room": room_name,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to delete LiveKit room: {}", err);
        }

        Ok(())
    }

    /// List participants in a room.
    pub async fn list_participants(&self, room_name: &str) -> Result<Vec<serde_json::Value>, anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant {
            room_list: Some(true),
            ..VideoGrant::admin()
        })?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/ListParticipants", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "room": room_name,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to list participants: {}", err);
        }

        let body: serde_json::Value = resp.json().await?;
        let participants = body.get("participants")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(participants)
    }

    /// Server-side mute a participant (set their published tracks to muted).
    pub async fn mute_participant(
        &self,
        room_name: &str,
        identity: &str,
        track_sid: &str,
        muted: bool,
    ) -> Result<(), anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant::admin())?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/MutePublishedTrack", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "room": room_name,
                "identity": identity,
                "track_sid": track_sid,
                "muted": muted,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to mute participant: {}", err);
        }

        Ok(())
    }

    /// Update a participant's permissions (e.g., to implement server-side deafen or mute).
    pub async fn update_participant(
        &self,
        room_name: &str,
        identity: &str,
        can_publish: Option<bool>,
        can_subscribe: Option<bool>,
    ) -> Result<(), anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant::admin())?;

        let mut permission = serde_json::Map::new();
        if let Some(v) = can_publish {
            permission.insert("canPublish".to_string(), serde_json::Value::Bool(v));
        }
        if let Some(v) = can_subscribe {
            permission.insert("canSubscribe".to_string(), serde_json::Value::Bool(v));
        }
        permission.insert("canPublishData".to_string(), serde_json::Value::Bool(true));

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/UpdateParticipant", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "room": room_name,
                "identity": identity,
                "permission": permission,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to update participant: {}", err);
        }

        Ok(())
    }

    /// Remove (kick) a participant from a room.
    pub async fn remove_participant(
        &self,
        room_name: &str,
        identity: &str,
    ) -> Result<(), anyhow::Error> {
        let admin_token = self.generate_admin_token(VideoGrant::admin())?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/twirp/livekit.RoomService/RemoveParticipant", self.http_url))
            .header("Authorization", format!("Bearer {}", admin_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "room": room_name,
                "identity": identity,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let err = resp.text().await?;
            anyhow::bail!("Failed to remove participant: {}", err);
        }

        Ok(())
    }

    /// Parse and validate a LiveKit webhook request body.
    /// Returns the parsed event. The caller should verify the webhook
    /// token/signature at the HTTP layer before calling this.
    pub fn parse_webhook_event(&self, body: &str) -> Result<WebhookEvent, anyhow::Error> {
        let event: WebhookEvent = serde_json::from_str(body)?;
        Ok(event)
    }
}
