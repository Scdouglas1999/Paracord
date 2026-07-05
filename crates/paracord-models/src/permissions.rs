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
        // Baseline @everyone / default "Member" role permissions. Tuned for
        // Discord parity so ordinary members can participate without an owner
        // hand-granting each capability: they can create invites, attach files,
        // embed links, and use external emojis in addition to the core
        // read/send/react/voice set.
        //
        // MENTION_EVERYONE is DELIBERATELY EXCLUDED: with auto_join_public_spaces,
        // a fresh account can join a public space instantly, so a default
        // @everyone mass-ping is cheap abuse. Owners can still grant
        // MENTION_EVERYONE explicitly to a role when they want it.
        Self::VIEW_CHANNEL
            | Self::SEND_MESSAGES
            | Self::READ_MESSAGE_HISTORY
            | Self::ADD_REACTIONS
            | Self::CREATE_INSTANT_INVITE
            | Self::EMBED_LINKS
            | Self::ATTACH_FILES
            | Self::USE_EXTERNAL_EMOJIS
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

    #[test]
    fn default_grants_discord_parity_member_permissions() {
        let d = Permissions::default();

        // Core member capabilities.
        assert!(d.contains(Permissions::VIEW_CHANNEL));
        assert!(d.contains(Permissions::SEND_MESSAGES));
        assert!(d.contains(Permissions::READ_MESSAGE_HISTORY));
        assert!(d.contains(Permissions::ADD_REACTIONS));

        // Discord-parity additions: ordinary members must be able to invite,
        // attach files, embed links, and use external emojis out of the box.
        assert!(d.contains(Permissions::CREATE_INSTANT_INVITE));
        assert!(d.contains(Permissions::ATTACH_FILES));
        assert!(d.contains(Permissions::EMBED_LINKS));
        assert!(d.contains(Permissions::USE_EXTERNAL_EMOJIS));
    }

    #[test]
    fn default_excludes_privileged_and_mass_ping_permissions() {
        let d = Permissions::default();

        // MENTION_EVERYONE is intentionally NOT a default (mass-ping abuse is too
        // cheap when public spaces auto-join). Owners grant it explicitly.
        assert!(!d.contains(Permissions::MENTION_EVERYONE));

        // No administrative / management bits leak into the baseline role.
        assert!(!d.contains(Permissions::ADMINISTRATOR));
        assert!(!d.contains(Permissions::MANAGE_CHANNELS));
        assert!(!d.contains(Permissions::MANAGE_GUILD));
        assert!(!d.contains(Permissions::MANAGE_MESSAGES));
        assert!(!d.contains(Permissions::MANAGE_ROLES));
        assert!(!d.contains(Permissions::MANAGE_WEBHOOKS));
        assert!(!d.contains(Permissions::MANAGE_EMOJIS));
        assert!(!d.contains(Permissions::MANAGE_NICKNAMES));
    }
}
