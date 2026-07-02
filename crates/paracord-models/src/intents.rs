use bitflags::bitflags;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct GatewayIntents: i64 {
        const GUILDS                    = 1 << 0;
        const GUILD_MEMBERS             = 1 << 1;  // privileged
        const GUILD_MODERATION          = 1 << 2;
        const GUILD_EMOJIS_AND_STICKERS = 1 << 3;
        const GUILD_INTEGRATIONS        = 1 << 4;
        const GUILD_WEBHOOKS            = 1 << 5;
        const GUILD_INVITES             = 1 << 6;
        const GUILD_VOICE_STATES        = 1 << 7;
        const GUILD_PRESENCES           = 1 << 8;  // privileged
        const GUILD_MESSAGES            = 1 << 9;
        const GUILD_MESSAGE_REACTIONS   = 1 << 10;
        const GUILD_MESSAGE_TYPING      = 1 << 11;
        const DIRECT_MESSAGES           = 1 << 12;
        const DIRECT_MESSAGE_REACTIONS  = 1 << 13;
        const DIRECT_MESSAGE_TYPING     = 1 << 14;
        const MESSAGE_CONTENT           = 1 << 15; // privileged
        const GUILD_SCHEDULED_EVENTS    = 1 << 16;
    }
}

impl GatewayIntents {
    /// Privileged intents that require explicit approval.
    pub const PRIVILEGED: GatewayIntents = Self::GUILD_MEMBERS
        .union(Self::GUILD_PRESENCES)
        .union(Self::MESSAGE_CONTENT);

    /// All non-privileged intents.
    pub const ALL_NON_PRIVILEGED: GatewayIntents =
        Self::all().difference(Self::PRIVILEGED);

    /// Returns `true` if this intents value contains any privileged intents.
    pub fn has_privileged(self) -> bool {
        self.intersects(Self::PRIVILEGED)
    }

    /// Returns only the privileged intents present in `self`.
    pub fn privileged_bits(self) -> GatewayIntents {
        self.intersection(Self::PRIVILEGED)
    }
}

impl Serialize for GatewayIntents {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.bits())
    }
}

impl<'de> Deserialize<'de> for GatewayIntents {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bits = i64::deserialize(deserializer)?;
        Ok(GatewayIntents::from_bits_truncate(bits))
    }
}

impl Default for GatewayIntents {
    fn default() -> Self {
        Self::ALL_NON_PRIVILEGED
    }
}

/// Returns the gateway intent required to receive a given event, if any.
///
/// Events not listed here are always dispatched (e.g. READY, RESUMED).
pub fn intent_required_for_event(event_name: &str) -> Option<GatewayIntents> {
    use crate::gateway::*;

    match event_name {
        // GUILDS
        EVENT_GUILD_CREATE
        | EVENT_GUILD_UPDATE
        | EVENT_GUILD_DELETE
        | EVENT_CHANNEL_CREATE
        | EVENT_CHANNEL_UPDATE
        | EVENT_CHANNEL_DELETE
        | EVENT_CHANNEL_PINS_UPDATE
        | EVENT_GUILD_ROLE_CREATE
        | EVENT_GUILD_ROLE_UPDATE
        | EVENT_GUILD_ROLE_DELETE => Some(GatewayIntents::GUILDS),

        // GUILD_MEMBERS (privileged)
        EVENT_GUILD_MEMBER_ADD
        | EVENT_GUILD_MEMBER_UPDATE
        | EVENT_GUILD_MEMBER_REMOVE
        | EVENT_GUILD_MEMBERS_CHUNK => Some(GatewayIntents::GUILD_MEMBERS),

        // GUILD_MODERATION
        EVENT_GUILD_BAN_ADD | EVENT_GUILD_BAN_REMOVE => {
            Some(GatewayIntents::GUILD_MODERATION)
        }

        // GUILD_EMOJIS_AND_STICKERS
        EVENT_GUILD_EMOJIS_UPDATE => Some(GatewayIntents::GUILD_EMOJIS_AND_STICKERS),

        // GUILD_INVITES
        EVENT_INVITE_CREATE | EVENT_INVITE_DELETE => {
            Some(GatewayIntents::GUILD_INVITES)
        }

        // GUILD_VOICE_STATES
        EVENT_VOICE_STATE_UPDATE => Some(GatewayIntents::GUILD_VOICE_STATES),

        // GUILD_PRESENCES (privileged)
        EVENT_PRESENCE_UPDATE => Some(GatewayIntents::GUILD_PRESENCES),

        // GUILD_MESSAGES
        EVENT_MESSAGE_CREATE
        | EVENT_MESSAGE_UPDATE
        | EVENT_MESSAGE_DELETE
        | EVENT_MESSAGE_DELETE_BULK => Some(GatewayIntents::GUILD_MESSAGES),

        // GUILD_MESSAGE_REACTIONS
        EVENT_MESSAGE_REACTION_ADD
        | EVENT_MESSAGE_REACTION_REMOVE
        | EVENT_MESSAGE_REACTION_REMOVE_ALL => {
            Some(GatewayIntents::GUILD_MESSAGE_REACTIONS)
        }

        // GUILD_MESSAGE_TYPING
        EVENT_TYPING_START => Some(GatewayIntents::GUILD_MESSAGE_TYPING),

        // Always dispatched (READY, RESUMED, interactions, media, etc.)
        _ => None,
    }
}
