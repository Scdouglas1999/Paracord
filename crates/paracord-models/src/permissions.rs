use bitflags::bitflags;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Permissions: i64 {
        const CREATE_INSTANT_INVITE = 1 << 0;
        const KICK_MEMBERS         = 1 << 1;
        const BAN_MEMBERS          = 1 << 2;
        const ADMINISTRATOR        = 1 << 3;
        const MANAGE_CHANNELS      = 1 << 4;
        const MANAGE_GUILD         = 1 << 5;
        const ADD_REACTIONS        = 1 << 6;
        const VIEW_AUDIT_LOG       = 1 << 7;
        const PRIORITY_SPEAKER     = 1 << 8;
        const STREAM               = 1 << 9;
        const VIEW_CHANNEL         = 1 << 10;
        const SEND_MESSAGES        = 1 << 11;
        const SEND_TTS_MESSAGES    = 1 << 12;
        const MANAGE_MESSAGES      = 1 << 13;
        const EMBED_LINKS          = 1 << 14;
        const ATTACH_FILES         = 1 << 15;
        const READ_MESSAGE_HISTORY = 1 << 16;
        const MENTION_EVERYONE     = 1 << 17;
        const USE_EXTERNAL_EMOJIS  = 1 << 18;
        // Bit 19 is intentionally reserved and left unassigned: it mirrors
        // Discord's historical VIEW_GUILD_INSIGHTS slot, which Paracord does not
        // implement. Leaving the gap keeps every other flag bit-compatible with
        // Discord's numbering. Do not reuse bit 19 for an unrelated permission
        // without bumping the wire format, or existing stored bitmasks would be
        // reinterpreted. `Permissions::all()` therefore excludes bit 19.
        const CONNECT              = 1 << 20;
        const SPEAK                = 1 << 21;
        const MUTE_MEMBERS         = 1 << 22;
        const DEAFEN_MEMBERS       = 1 << 23;
        const MOVE_MEMBERS         = 1 << 24;
        const USE_VAD              = 1 << 25;
        const CHANGE_NICKNAME      = 1 << 26;
        const MANAGE_NICKNAMES     = 1 << 27;
        const MANAGE_ROLES         = 1 << 28;
        const MANAGE_WEBHOOKS      = 1 << 29;
        const MANAGE_EMOJIS        = 1 << 30;
    }
}

impl Serialize for Permissions {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.bits())
    }
}

impl<'de> Deserialize<'de> for Permissions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bits = i64::deserialize(deserializer)?;
        Ok(Permissions::from_bits_truncate(bits))
    }
}

impl Default for Permissions {
    fn default() -> Self {
        Self::VIEW_CHANNEL
            | Self::SEND_MESSAGES
            | Self::READ_MESSAGE_HISTORY
            | Self::ADD_REACTIONS
            | Self::CONNECT
            | Self::SPEAK
            | Self::STREAM
            | Self::USE_VAD
            | Self::CHANGE_NICKNAME
    }
}

#[cfg(test)]
mod tests {
    use super::Permissions;

    #[test]
    fn all_bitmask_is_contiguous_except_reserved_bit_19() {
        // Highest defined flag is MANAGE_EMOJIS (bit 30), so every bit 0..=30 is
        // set except bit 19, which is intentionally reserved (see the flag
        // definitions). This guards against accidentally filling the gap or
        // shifting a flag, which would silently reinterpret stored bitmasks.
        let expected = ((1_i64 << 31) - 1) & !(1_i64 << 19);
        assert_eq!(Permissions::all().bits(), expected);
        assert_eq!(Permissions::all().bits(), 0x7FF7_FFFF);
        // The reserved bit must never be part of `all()`.
        assert_eq!(Permissions::all().bits() & (1_i64 << 19), 0);
        // `from_bits_truncate` must drop the reserved bit rather than surface it.
        assert_eq!(
            Permissions::from_bits_truncate(1_i64 << 19),
            Permissions::empty()
        );
    }
}
