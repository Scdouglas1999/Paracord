//! Who may create an account on this instance.
//!
//! Two answers: anyone who can reach the server, or only people holding a live
//! invite to one of its servers. A freshly generated config writes
//! `invite_only`; a config that predates the setting has no key and keeps the
//! behaviour it always had, which is open.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    /// Anyone who can reach the server can create an account.
    #[default]
    Open,
    /// An account can only be created with a live invite to a server here.
    InviteOnly,
}

impl RegistrationMode {
    /// The value stored in `server_settings` and written to the config file.
    pub fn as_str(self) -> &'static str {
        match self {
            RegistrationMode::Open => "open",
            RegistrationMode::InviteOnly => "invite_only",
        }
    }

    /// Parse the stored / configured spelling. Anything else is `None`, so a
    /// typo is reported rather than quietly read as one of the two.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "open" => Some(RegistrationMode::Open),
            "invite_only" => Some(RegistrationMode::InviteOnly),
            _ => None,
        }
    }
}

/// What a refused invite-less registration is told.
pub const INVITE_REQUIRED_MESSAGE: &str =
    "This server is invite-only. Ask the person who runs it for an invite link.";

/// What a registration carrying a dead invite is told.
pub const INVITE_NOT_USABLE_MESSAGE: &str =
    "That invite has expired or has been used up. Ask the person who sent it for a new invite link.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_both_spellings_and_rejects_anything_else() {
        for mode in [RegistrationMode::Open, RegistrationMode::InviteOnly] {
            assert_eq!(RegistrationMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(
            RegistrationMode::parse(" Invite_Only "),
            Some(RegistrationMode::InviteOnly)
        );
        assert_eq!(RegistrationMode::parse("invite"), None);
        assert_eq!(RegistrationMode::parse(""), None);
    }

    #[test]
    fn serializes_in_snake_case() {
        assert_eq!(
            serde_json::to_value(RegistrationMode::InviteOnly).unwrap(),
            serde_json::json!("invite_only")
        );
    }
}
