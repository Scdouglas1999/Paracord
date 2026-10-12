//! One password (setup spec §3, §9.1, §9.2): the credential a client derives
//! from the password, the server-held wrapped identity, and the requests that
//! create, use, change and recover them.
//!
//! Encodings, fixed for both sides:
//! - "b64url" is RFC 4648 §5 base64url **without** `=` padding.
//! - "hex" is lowercase hexadecimal.
//! - Timestamps are RFC 3339 strings, except `IdentityProof::timestamp`, which
//!   is the Unix-seconds value the existing `/auth/challenge` returns.
//!
//! The schemas deliberately carry no KDF floor or byte-length constraints: the
//! client must answer a server that asks for weaker parameters with its own
//! words (spec §3.2), not with a generic contract failure, and the server
//! checks exact byte lengths itself (spec §3.4).

use std::borrow::Cow;

use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

/// The only KDF this version speaks.
pub const KDF_ALG_SCRYPT: &str = "scrypt";
/// Parameter floor: N = 2^17, r = 8, p = 1 (128 MiB). A client refuses less.
pub const SCRYPT_MIN_LOG_N: u8 = 17;
/// Parameter ceiling: N = 2^20. A client refuses more.
pub const SCRYPT_MAX_LOG_N: u8 = 20;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
/// Work ceiling: N·r·p at most 2^23, the cost of N = 2^20 with r = 8, p = 1.
/// Without it a server could pin a device's memory or CPU with a huge r or p.
/// The client mirrors this as `SCRYPT_MAX_WORK` in
/// `client/src/lib/credential/kdfCore.ts` (a test pins the same numbers).
pub const SCRYPT_MAX_WORK: u64 = 1 << 23;
/// The `wrap_alg` of a v2 wrapped identity:
/// `b64url(iv12 || AES-256-GCM(wrap_key, iv, identity_sk, aad))` with
/// `aad = "paracord/identity/v2|" + public_key_hex`.
pub const WRAP_ALG_V2: &str = "aes256gcm-v2";
/// Credential versions stored in `users.credential_version`.
pub const CREDENTIAL_VERSION_KEY_ONLY: i64 = 0;
pub const CREDENTIAL_VERSION_LEGACY: i64 = 1;
pub const CREDENTIAL_VERSION_ONE_PASSWORD: i64 = 2;

/// scrypt parameters as sent on the wire. Stored per credential as
/// `"scrypt:<log_n>:<r>:<p>"` (see [`KdfParams::to_db_text`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct KdfParams {
    /// Always `"scrypt"`.
    pub alg: String,
    /// log2 of scrypt's N.
    pub log_n: u8,
    pub r: u32,
    pub p: u32,
}

impl KdfParams {
    /// The parameters every new credential uses: scrypt N = 2^17, r = 8, p = 1.
    pub fn default_scrypt() -> Self {
        Self {
            alg: KDF_ALG_SCRYPT.to_string(),
            log_n: SCRYPT_MIN_LOG_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
        }
    }

    /// True when the parameters are scrypt within the floor and ceiling:
    /// N between 2^17 and 2^20, r = 8 or more, p = 1 or more, and N·r·p at
    /// most [`SCRYPT_MAX_WORK`]. This is the one definition of the KDF policy;
    /// the server checks every credential with it.
    pub fn within_policy(&self) -> bool {
        self.alg == KDF_ALG_SCRYPT
            && (SCRYPT_MIN_LOG_N..=SCRYPT_MAX_LOG_N).contains(&self.log_n)
            && self.r >= SCRYPT_R
            && self.p >= SCRYPT_P
            && self.work() <= SCRYPT_MAX_WORK
    }

    /// scrypt's N·r·p, saturating.
    pub fn work(&self) -> u64 {
        (1u64 << self.log_n.min(63))
            .saturating_mul(u64::from(self.r))
            .saturating_mul(u64::from(self.p))
    }

    /// The `users.credential_kdf` spelling: `"scrypt:17:8:1"`.
    pub fn to_db_text(&self) -> String {
        format!("{}:{}:{}:{}", self.alg, self.log_n, self.r, self.p)
    }

    /// Parse the `users.credential_kdf` spelling. Anything else is `None`.
    pub fn from_db_text(raw: &str) -> Option<Self> {
        let mut parts = raw.split(':');
        let alg = parts.next()?;
        let log_n = parts.next()?.parse().ok()?;
        let r = parts.next()?.parse().ok()?;
        let p = parts.next()?.parse().ok()?;
        if parts.next().is_some() || alg != KDF_ALG_SCRYPT {
            return None;
        }
        Some(Self {
            alg: alg.to_string(),
            log_n,
            r,
            p,
        })
    }
}

/// A freshly derived credential: what the server stores in place of a password.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NewCredential {
    /// b64url of 32 random bytes.
    pub salt: String,
    pub kdf: KdfParams,
    /// b64url of the 32-byte HKDF output `paracord/credential/v2/auth`.
    pub auth_key: String,
}

/// A signature over a server challenge, proving possession of the identity key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct IdentityProof {
    /// The nonce `/auth/challenge` issued.
    pub nonce: String,
    /// The timestamp `/auth/challenge` issued (Unix seconds).
    pub timestamp: i64,
    /// hex Ed25519 signature over
    /// `"<purpose>:" + nonce + ":" + timestamp + ":" + origin`, where purpose is
    /// `paracord/credential/v2/register` or `paracord/credential/v2/reset`.
    pub signature: String,
}

/// The identity as the server keeps it: the public key and the private key
/// wrapped under the password-derived wrap key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NewIdentity {
    /// hex of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// b64url of `iv12 || ciphertext+tag` (12 + 48 bytes).
    pub wrapped_key: String,
    /// `"aes256gcm-v2"` ([`WRAP_ALG_V2`]).
    pub wrap_alg: String,
    pub proof: IdentityProof,
}

/// `POST /api/v1/auth/credential/register`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialRegister {
    pub username: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub invite_code: Option<String>,
    pub credential: NewCredential,
    pub identity: NewIdentity,
}

/// `POST /api/v1/auth/credential/params`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialParamsRequest {
    /// Username or email, as typed.
    pub identifier: String,
}

/// `POST /api/v1/auth/credential/params` response.
///
/// On the wire: `{ "version": 1 }` for a legacy (two-password) account, or
/// `{ "version": 2, "kdf": …, "salt": …, "epoch": … }`. Unknown identifiers and
/// key-only accounts get version 2 with the default KDF and a fake salt, so the
/// route does not reveal whether an account exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CredentialParamsWire", into = "CredentialParamsWire")]
pub enum CredentialParams {
    Legacy,
    OnePassword {
        kdf: KdfParams,
        /// b64url of the credential's 32-byte salt.
        salt: String,
        /// Bumped by every password change or reset.
        epoch: i64,
    },
}

#[derive(Serialize, Deserialize)]
struct CredentialParamsWire {
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<KdfParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    epoch: Option<i64>,
}

impl From<CredentialParams> for CredentialParamsWire {
    fn from(params: CredentialParams) -> Self {
        match params {
            CredentialParams::Legacy => Self {
                version: 1,
                kdf: None,
                salt: None,
                epoch: None,
            },
            CredentialParams::OnePassword { kdf, salt, epoch } => Self {
                version: 2,
                kdf: Some(kdf),
                salt: Some(salt),
                epoch: Some(epoch),
            },
        }
    }
}

impl TryFrom<CredentialParamsWire> for CredentialParams {
    type Error = String;

    fn try_from(wire: CredentialParamsWire) -> Result<Self, Self::Error> {
        match wire.version {
            1 => Ok(Self::Legacy),
            2 => match (wire.kdf, wire.salt, wire.epoch) {
                (Some(kdf), Some(salt), Some(epoch)) => Ok(Self::OnePassword { kdf, salt, epoch }),
                _ => Err("credential params version 2 needs kdf, salt and epoch".into()),
            },
            other => Err(format!("unknown credential params version {other}")),
        }
    }
}

impl JsonSchema for CredentialParams {
    fn schema_name() -> Cow<'static, str> {
        "CredentialParams".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let kdf = generator.subschema_for::<KdfParams>();
        json_schema!({
            "oneOf": [
                {
                    "type": "object",
                    "properties": { "version": { "const": 1 } },
                    "required": ["version"]
                },
                {
                    "type": "object",
                    "properties": {
                        "version": { "const": 2 },
                        "kdf": kdf,
                        "salt": { "type": "string" },
                        "epoch": { "type": "integer" }
                    },
                    "required": ["version", "kdf", "salt", "epoch"]
                }
            ]
        })
    }
}

/// `POST /api/v1/auth/credential/login`. The response is the same
/// `LoginResponse` as `/auth/login`, including its MFA ticket branch.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialLoginRequest {
    pub identifier: String,
    /// b64url of the 32-byte auth key.
    pub auth_key: String,
}

/// `POST /api/v1/auth/credential/upgrade`: move a legacy (v1) account to one
/// password (spec §3.11).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialUpgradeRequest {
    /// The legacy sign-in password, which the server checks as today.
    pub current_password: String,
    pub credential: NewCredential,
    pub identity: NewIdentity,
}

/// `PUT /api/v1/users/@me/credential`: change the password (spec §3.7).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ChangeCredentialRequest {
    /// b64url auth key derived from the current password.
    pub current_auth_key: String,
    pub credential: NewCredential,
    /// The same identity, wrapped under the new password's wrap key.
    pub wrapped_key: String,
    #[serde(default)]
    pub mfa_code: Option<String>,
}

/// `POST /api/v1/users/@me/credential/reset`: a new password after signing in
/// with the recovery phrase (spec §3.8). `proof` signs a fresh challenge with
/// purpose `paracord/credential/v2/reset`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResetCredentialRequest {
    pub credential: NewCredential,
    pub wrapped_key: String,
    pub proof: IdentityProof,
    #[serde(default)]
    pub mfa_code: Option<String>,
}

/// `POST /api/v1/auth/reset-password` for a v2 account ("Start over", spec
/// §3.9): the emailed token, a new credential and a brand-new identity.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialEmailResetRequest {
    pub token: String,
    pub credential: NewCredential,
    pub identity: NewIdentity,
}

/// `{ epoch }`: the answer of upgrade, change and reset.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialEpochResponse {
    pub epoch: i64,
}

/// `GET /api/v1/users/@me/key-backup`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct KeyBackup {
    /// hex.
    pub public_key: String,
    /// b64url.
    pub wrapped_key: String,
    pub wrap_alg: String,
    pub epoch: i64,
    /// The person ticked "I wrote it down" for the recovery phrase.
    pub recovery_confirmed: bool,
}

/// The first server a desktop host or a headless install creates at the claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InitialServerTemplate {
    /// Text channels `general`, `clips`, `plans`; voice channels `Lounge`,
    /// `Gaming` (spec §2.7).
    Friends,
}

/// Who can create an account on an instance. The same spelling as the
/// `[auth] registration_mode` config value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    Open,
    InviteOnly,
}

/// The owner and first server a claim creates, without the claim token. The
/// desktop app's `host_claim` command takes this; its Rust side reads the token
/// from the claim file and sends [`CredentialClaimRequest`].
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NewOwnerClaim {
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    pub instance_name: String,
    pub initial_space_name: String,
    #[serde(default)]
    pub initial_space_icon: Option<String>,
    /// The first server's color, 0-359.
    #[schemars(range(min = 0, max = 359))]
    pub initial_space_hue: i16,
    pub initial_space_template: InitialServerTemplate,
    /// Saved with the server when given; otherwise the config file's
    /// `[auth] registration_mode` stands.
    #[serde(default)]
    pub registration_mode: Option<RegistrationMode>,
    pub credential: NewCredential,
    pub identity: NewIdentity,
}

/// `POST /api/v1/setup/credential-claim`: the legacy `ClaimRequest` minus
/// `password`, plus the credential, identity, hue and template. Answers 201
/// with the same `ClaimResponse` as `/setup/claim`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CredentialClaimRequest {
    pub token: String,
    #[serde(flatten)]
    pub owner: NewOwnerClaim,
}

/// Who enforces the password rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PasswordRulesEnforcedBy {
    /// One password: the server never sees it, so the client checks it.
    Client,
    /// Legacy accounts: the server checks the password it receives.
    Server,
}

/// Servers from before one password send no `enforced_by`; the rules they send
/// are then enforced by the server.
fn password_requirements_absent_on_older_servers(schema: &mut Schema) {
    crate::absent_on_older_servers(schema, &["enforced_by"]);
}

/// `GET /api/v1/setup/password-requirements` (spec §3.4).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(transform = password_requirements_absent_on_older_servers)]
pub struct PasswordRequirements {
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub min_length: u32,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub max_length: u32,
    pub requires_uppercase: bool,
    pub requires_lowercase: bool,
    pub requires_digit: bool,
    pub requires_symbol: bool,
    /// `"utf8_bytes"`.
    pub length_unit: String,
    pub enforced_by: PasswordRulesEnforcedBy,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn params_are_numbered_on_the_wire() {
        assert_eq!(
            serde_json::to_value(CredentialParams::Legacy).unwrap(),
            json!({ "version": 1 })
        );
        let v2 = CredentialParams::OnePassword {
            kdf: KdfParams::default_scrypt(),
            salt: "s".into(),
            epoch: 3,
        };
        let wire = serde_json::to_value(&v2).unwrap();
        assert_eq!(
            wire,
            json!({
                "version": 2,
                "kdf": { "alg": "scrypt", "log_n": 17, "r": 8, "p": 1 },
                "salt": "s",
                "epoch": 3
            })
        );
        assert_eq!(
            serde_json::from_value::<CredentialParams>(wire).unwrap(),
            v2
        );
        assert!(serde_json::from_value::<CredentialParams>(json!({ "version": 2 })).is_err());
        assert!(serde_json::from_value::<CredentialParams>(json!({ "version": 3 })).is_err());
        assert!(serde_json::from_value::<CredentialParams>(json!({ "version": "2" })).is_err());
    }

    #[test]
    fn kdf_text_round_trips_and_policy_holds() {
        let kdf = KdfParams::default_scrypt();
        assert_eq!(kdf.to_db_text(), "scrypt:17:8:1");
        assert_eq!(KdfParams::from_db_text("scrypt:17:8:1"), Some(kdf.clone()));
        assert!(kdf.within_policy());
        assert!(KdfParams::from_db_text("scrypt:20:8:1")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:16:8:1")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:21:8:1")
            .unwrap()
            .within_policy());
        // The work ceiling: N·r·p ≤ 2^23.
        assert_eq!(SCRYPT_MAX_WORK, 1 << 23);
        assert!(KdfParams::from_db_text("scrypt:17:64:1")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:17:64:2")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:20:16:1")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:17:8:4294967295")
            .unwrap()
            .within_policy());
        assert!(!KdfParams::from_db_text("scrypt:17:7:1")
            .unwrap()
            .within_policy());
        assert_eq!(KdfParams::from_db_text("argon2id:1:2:3"), None);
        assert_eq!(KdfParams::from_db_text("scrypt:17:8"), None);
        assert_eq!(KdfParams::from_db_text("scrypt:17:8:1:9"), None);
    }

    #[test]
    fn claim_request_flattens_the_owner() {
        let request: CredentialClaimRequest = serde_json::from_value(json!({
            "token": "t",
            "username": "sam",
            "instance_name": "Friday Night Crew",
            "initial_space_name": "Friday Night Crew",
            "initial_space_hue": 150,
            "initial_space_template": "friends",
            "credential": {
                "salt": "s", "auth_key": "a",
                "kdf": { "alg": "scrypt", "log_n": 17, "r": 8, "p": 1 }
            },
            "identity": {
                "public_key": "00", "wrapped_key": "w", "wrap_alg": "aes256gcm-v2",
                "proof": { "nonce": "n", "timestamp": 1, "signature": "00" }
            }
        }))
        .unwrap();
        assert_eq!(request.owner.initial_space_hue, 150);
        assert_eq!(
            request.owner.initial_space_template,
            InitialServerTemplate::Friends
        );
        assert_eq!(request.owner.email, None);
    }
}
