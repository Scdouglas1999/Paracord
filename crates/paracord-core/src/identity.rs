use chrono::{DateTime, Utc};
use paracord_db::DbPool;
use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// Version of the identity bundle format.
const BUNDLE_VERSION: u32 = 2;

/// Maximum number of messages that can be exported.
const MAX_EXPORT_MESSAGES: i64 = 50_000;

// ── Export types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityBundle {
    pub version: u32,
    pub exported_at: DateTime<Utc>,
    pub origin_server: String,
    pub user: UserExport,
    pub settings: Option<UserSettingsExport>,
    #[serde(default)]
    pub messages: Vec<MessageExport>,
    #[serde(default)]
    pub attachments: Vec<AttachmentExport>,
    #[serde(default)]
    pub relationships: Vec<RelationshipExport>,
    #[serde(default)]
    pub guilds: Vec<GuildMembershipExport>,
    pub prekeys: Option<PrekeyExport>,
    /// ed25519 signature of the canonical JSON payload (everything except this field).
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserExport {
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub bio: Option<String>,
    pub public_key: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettingsExport {
    pub theme: String,
    pub locale: String,
    pub message_display: String,
    pub custom_css: Option<String>,
    pub crypto_auth_enabled: bool,
    #[serde(default = "default_presence_status")]
    pub presence_status: String,
    #[serde(default)]
    pub custom_status: Option<String>,
    pub notifications: serde_json::Value,
    pub keybinds: serde_json::Value,
    pub updated_at: DateTime<Utc>,
}

fn default_presence_status() -> String {
    "online".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageExport {
    pub id: String,
    pub channel_id: String,
    pub content: Option<String>,
    pub message_type: i16,
    pub flags: i32,
    pub pinned: bool,
    pub reference_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentExport {
    pub id: String,
    pub message_id: Option<String>,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: i32,
    pub url: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub content_hash: Option<String>,
    pub uploaded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationshipExport {
    pub target_username: String,
    pub target_discriminator: i16,
    pub rel_type: i16,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildMembershipExport {
    pub guild_name: String,
    pub guild_id: String,
    pub nick: Option<String>,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedPrekeyExport {
    pub id: String,
    pub public_key: String,
    pub signature: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneTimePrekeyExport {
    pub id: String,
    pub public_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrekeyExport {
    pub signed_prekey: Option<SignedPrekeyExport>,
    #[serde(default)]
    pub one_time_prekeys: Vec<OneTimePrekeyExport>,
}

/// Result of an identity import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub profile_updated: bool,
    pub settings_imported: bool,
    pub messages_imported: u64,
    pub prekeys_imported: u64,
    pub attachments_noted: u64,
    pub relationships_found: u64,
    pub guilds_noted: u64,
    pub warnings: Vec<String>,
}

// ── Signable payload ───────────────────────────────────────────────────────

/// Build the canonical JSON payload for signing (the bundle without the signature field).
#[derive(Serialize)]
struct SignablePayload<'a> {
    version: u32,
    exported_at: &'a DateTime<Utc>,
    origin_server: &'a str,
    user: &'a UserExport,
    settings: &'a Option<UserSettingsExport>,
    messages: &'a [MessageExport],
    attachments: &'a [AttachmentExport],
    relationships: &'a [RelationshipExport],
    guilds: &'a [GuildMembershipExport],
    prekeys: &'a Option<PrekeyExport>,
}

#[derive(Serialize)]
struct SignablePayloadV1<'a> {
    version: u32,
    exported_at: &'a DateTime<Utc>,
    origin_server: &'a str,
    user: &'a UserExport,
    messages: &'a [MessageExport],
    relationships: &'a [RelationshipExport],
    guilds: &'a [GuildMembershipExport],
}

fn build_signable_bytes(bundle: &IdentityBundle) -> Vec<u8> {
    if bundle.version <= 1 {
        let payload = SignablePayloadV1 {
            version: bundle.version,
            exported_at: &bundle.exported_at,
            origin_server: &bundle.origin_server,
            user: &bundle.user,
            messages: &bundle.messages,
            relationships: &bundle.relationships,
            guilds: &bundle.guilds,
        };
        return serde_json::to_vec(&payload).unwrap_or_default();
    }

    let payload = SignablePayload {
        version: bundle.version,
        exported_at: &bundle.exported_at,
        origin_server: &bundle.origin_server,
        user: &bundle.user,
        settings: &bundle.settings,
        messages: &bundle.messages,
        attachments: &bundle.attachments,
        relationships: &bundle.relationships,
        guilds: &bundle.guilds,
        prekeys: &bundle.prekeys,
    };
    serde_json::to_vec(&payload).unwrap_or_default()
}

// ── Export ──────────────────────────────────────────────────────────────────

pub async fn export_identity(
    pool: &DbPool,
    user_id: i64,
    include_messages: bool,
    origin_server: &str,
    signing_key: &ed25519_dalek::SigningKey,
) -> Result<IdentityBundle, CoreError> {
    // Fetch user
    let user = paracord_db::users::get_user_by_id(pool, user_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let user_export = UserExport {
        username: user.username,
        display_name: user.display_name,
        avatar_hash: user.avatar_hash,
        bio: user.bio,
        public_key: user.public_key,
        created_at: user.created_at,
    };

    let settings = paracord_db::users::get_user_settings(pool, user_id)
        .await?
        .map(|row| UserSettingsExport {
            theme: row.theme,
            locale: row.locale,
            message_display: row.message_display,
            custom_css: row.custom_css,
            crypto_auth_enabled: row.crypto_auth_enabled,
            presence_status: row.presence_status,
            custom_status: row.custom_status,
            notifications: row.notifications,
            keybinds: row.keybinds,
            updated_at: row.updated_at,
        });

    // Fetch messages if requested
    let messages = if include_messages {
        let msg_rows =
            paracord_db::messages::list_messages_by_author(pool, user_id, MAX_EXPORT_MESSAGES)
                .await?;
        msg_rows
            .into_iter()
            .map(|m| MessageExport {
                id: m.id.to_string(),
                channel_id: m.channel_id.to_string(),
                content: m.content,
                message_type: m.message_type,
                flags: m.flags,
                pinned: m.pinned,
                reference_id: m.reference_id.map(|id| id.to_string()),
                created_at: m.created_at,
                edited_at: m.edited_at,
            })
            .collect()
    } else {
        vec![]
    };

    let attachments = if messages.is_empty() {
        Vec::new()
    } else {
        let message_ids: Vec<i64> = messages
            .iter()
            .filter_map(|msg| msg.id.parse::<i64>().ok())
            .collect();
        let attachment_rows =
            paracord_db::attachments::get_attachments_for_message_ids(pool, &message_ids, 50_000)
                .await?;
        attachment_rows
            .into_iter()
            .map(|row| AttachmentExport {
                id: row.id.to_string(),
                message_id: row.message_id.map(|id| id.to_string()),
                filename: row.filename,
                content_type: row.content_type,
                size: row.size,
                url: row.url,
                width: row.width,
                height: row.height,
                content_hash: row.content_hash,
                uploaded_at: row.upload_created_at,
            })
            .collect()
    };

    // Fetch relationships
    let rel_rows = paracord_db::relationships::get_relationships(pool, user_id).await?;
    let relationships: Vec<RelationshipExport> = rel_rows
        .into_iter()
        .map(|r| RelationshipExport {
            target_username: r.target_username,
            target_discriminator: r.target_discriminator,
            rel_type: r.rel_type,
            created_at: r.created_at,
        })
        .collect();

    // Fetch guild memberships
    let guild_rows =
        paracord_db::guilds::get_user_guilds(pool, paracord_models::id::UserId(user_id)).await?;
    let mut guilds = Vec::new();
    for g in guild_rows {
        let member = paracord_db::members::get_member(pool, user_id, g.id).await?;
        guilds.push(GuildMembershipExport {
            guild_name: g.name,
            guild_id: g.id.to_string(),
            nick: member.as_ref().and_then(|m| m.nick.clone()),
            joined_at: member.map(|m| m.joined_at).unwrap_or(g.created_at),
        });
    }

    let signed_prekey = paracord_db::prekeys::get_signed_prekey(pool, user_id)
        .await?
        .map(|row| SignedPrekeyExport {
            id: row.id.to_string(),
            public_key: row.public_key,
            signature: row.signature,
            created_at: row.created_at,
        });
    let one_time_prekeys = paracord_db::prekeys::list_one_time_prekeys(pool, user_id)
        .await?
        .into_iter()
        .map(|row| OneTimePrekeyExport {
            id: row.id.to_string(),
            public_key: row.public_key,
            created_at: row.created_at,
        })
        .collect::<Vec<_>>();
    let prekeys = Some(PrekeyExport {
        signed_prekey,
        one_time_prekeys,
    });

    // Build unsigned bundle and sign it
    let now = Utc::now();
    let mut bundle = IdentityBundle {
        version: BUNDLE_VERSION,
        exported_at: now,
        origin_server: origin_server.to_string(),
        user: user_export,
        settings,
        messages,
        attachments,
        relationships,
        guilds,
        prekeys,
        signature: String::new(), // placeholder
    };

    let signable = build_signable_bytes(&bundle);
    bundle.signature = paracord_federation::signing::sign(signing_key, &signable);

    Ok(bundle)
}

// ── Verify ─────────────────────────────────────────────────────────────────

pub fn verify_identity_bundle(
    bundle: &IdentityBundle,
    server_public_key_hex: &str,
) -> Result<(), CoreError> {
    if bundle.version != 1 && bundle.version != BUNDLE_VERSION {
        return Err(CoreError::BadRequest(format!(
            "unsupported bundle version: {}",
            bundle.version
        )));
    }

    let signable = build_signable_bytes(bundle);
    paracord_federation::signing::verify(&signable, &bundle.signature, server_public_key_hex)
        .map_err(|_| CoreError::BadRequest("invalid bundle signature".to_string()))
}

// ── Subject binding ──────────────────────────────────────────────────────────

/// Verify that the bundle's subject identity belongs to `target_user_id`.
///
/// The server signature only proves which server issued the bundle, not that
/// the importing account is the bundle's subject. Without this check any account
/// could import another same-server account's bundle and have that account's
/// settings (custom CSS/theme) and prekeys written into its own record. Binding
/// is enforced on the long-term public key when the bundle carries one, and
/// falls back to the username only for legacy bundles that have no crypto
/// identity. Cross-server imports still require this binding in addition to the
/// origin-server signature verified separately.
pub async fn verify_subject_binding(
    pool: &DbPool,
    bundle: &IdentityBundle,
    target_user_id: i64,
) -> Result<(), CoreError> {
    let target = paracord_db::users::get_user_by_id(pool, target_user_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    match bundle.user.public_key.as_deref() {
        Some(bundle_pk) => {
            // Cryptographic identity binding: the importing account must own the
            // exact long-term public key the bundle was issued for.
            match target.public_key.as_deref() {
                Some(target_pk) if target_pk == bundle_pk => Ok(()),
                _ => Err(CoreError::Forbidden),
            }
        }
        None => {
            // Legacy bundle without a crypto identity: fall back to username.
            if bundle.user.username == target.username {
                Ok(())
            } else {
                Err(CoreError::Forbidden)
            }
        }
    }
}

// ── Import ─────────────────────────────────────────────────────────────────

pub async fn import_identity(
    pool: &DbPool,
    bundle: &IdentityBundle,
    target_user_id: i64,
) -> Result<ImportResult, CoreError> {
    // Bind the bundle's subject to the importing account before writing anything.
    verify_subject_binding(pool, bundle, target_user_id).await?;

    let mut warnings = Vec::new();

    // 1. Update user profile with exported data
    let profile_updated = {
        let display_name = bundle.user.display_name.as_deref();
        let bio = bundle.user.bio.as_deref();
        let avatar = bundle.user.avatar_hash.as_deref();
        let result =
            paracord_db::users::update_user(pool, target_user_id, display_name, bio, avatar).await;
        match result {
            Ok(_) => true,
            Err(e) => {
                warnings.push(format!("failed to update profile: {}", e));
                false
            }
        }
    };

    // 1b. Import user settings snapshot when available.
    let settings_imported = if let Some(settings) = &bundle.settings {
        match paracord_db::users::upsert_user_settings(
            pool,
            target_user_id,
            &settings.theme,
            &settings.locale,
            &settings.message_display,
            settings.custom_css.as_deref(),
            Some(settings.crypto_auth_enabled),
            Some(settings.presence_status.as_str()),
            Some(settings.custom_status.as_deref()),
            Some(&settings.notifications),
            Some(&settings.keybinds),
        )
        .await
        {
            Ok(_) => true,
            Err(e) => {
                warnings.push(format!("failed to import settings: {}", e));
                false
            }
        }
    } else {
        false
    };

    // 2. Import messages as attributed records (mark as imported via flags)
    let mut messages_imported: u64 = 0;
    const IMPORTED_FLAG: i32 = 1 << 4; // bit 4 = imported message
    for msg in &bundle.messages {
        let msg_id = paracord_util::snowflake::generate(0);
        let channel_id: i64 = match msg.channel_id.parse() {
            Ok(id) => id,
            Err(_) => {
                warnings.push(format!(
                    "skipping message with invalid channel_id: {}",
                    msg.channel_id
                ));
                continue;
            }
        };
        let content = msg.content.as_deref().unwrap_or("");
        let flags = msg.flags | IMPORTED_FLAG;
        let result = paracord_db::messages::create_message_with_meta(
            pool,
            msg_id,
            channel_id,
            target_user_id,
            content,
            msg.message_type,
            None, // reference_id - don't preserve cross-server references
            flags,
            None,
            None,
        )
        .await;
        match result {
            Ok(_) => messages_imported += 1,
            Err(_) => {
                // Channel may not exist on this server - that's expected
            }
        }
    }

    // 2b. Import prekeys for E2EE continuity.
    let mut prekeys_imported: u64 = 0;
    if let Some(prekeys) = &bundle.prekeys {
        if let Some(spk) = &prekeys.signed_prekey {
            let signed_id = spk
                .id
                .parse::<i64>()
                .unwrap_or_else(|_| paracord_util::snowflake::generate(0));
            match paracord_db::prekeys::upsert_signed_prekey(
                pool,
                signed_id,
                target_user_id,
                &spk.public_key,
                &spk.signature,
            )
            .await
            {
                Ok(_) => prekeys_imported += 1,
                Err(e) => warnings.push(format!("failed to import signed prekey: {}", e)),
            }
        }

        let one_time = prekeys
            .one_time_prekeys
            .iter()
            .map(|opk| {
                (
                    opk.id
                        .parse::<i64>()
                        .unwrap_or_else(|_| paracord_util::snowflake::generate(0)),
                    opk.public_key.clone(),
                )
            })
            .collect::<Vec<_>>();
        if !one_time.is_empty() {
            match paracord_db::prekeys::upload_one_time_prekeys(pool, target_user_id, &one_time)
                .await
            {
                Ok(inserted) => prekeys_imported += inserted,
                Err(e) => warnings.push(format!("failed to import one-time prekeys: {}", e)),
            }
        }
    }

    let attachments_noted = bundle.attachments.len() as u64;
    if attachments_noted > 0 {
        warnings.push(
            "attachment metadata imported; binary files must be restored separately".to_string(),
        );
    }

    // 3. Note relationships (we can't re-create them without the target user existing)
    let relationships_found = bundle.relationships.len() as u64;
    if !bundle.relationships.is_empty() {
        warnings.push(format!(
            "{} relationships noted but cannot be automatically re-established (users must exist on this server)",
            relationships_found
        ));
    }

    // 4. Note guild memberships
    let guilds_noted = bundle.guilds.len() as u64;
    if !bundle.guilds.is_empty() {
        warnings.push(format!(
            "{} guild memberships noted from origin server (join guilds manually via invite)",
            guilds_noted
        ));
    }

    Ok(ImportResult {
        profile_updated,
        settings_imported,
        messages_imported,
        prekeys_imported,
        attachments_noted,
        relationships_found,
        guilds_noted,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_pool() -> DbPool {
        let pool = paracord_db::create_pool("sqlite::memory:", 1)
            .await
            .expect("create in-memory pool");
        paracord_db::run_migrations(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn bundle_for(username: &str, public_key: Option<&str>) -> IdentityBundle {
        IdentityBundle {
            version: BUNDLE_VERSION,
            exported_at: Utc::now(),
            origin_server: "example.test".to_string(),
            user: UserExport {
                username: username.to_string(),
                display_name: None,
                avatar_hash: None,
                bio: None,
                public_key: public_key.map(|s| s.to_string()),
                created_at: Utc::now(),
            },
            settings: None,
            messages: vec![],
            attachments: vec![],
            relationships: vec![],
            guilds: vec![],
            prekeys: None,
            signature: String::new(),
        }
    }

    #[tokio::test]
    async fn subject_binding_rejects_public_key_mismatch() {
        let pool = mem_pool().await;
        // Attacker account owns pk_importer.
        paracord_db::users::create_user(&pool, 2, "attacker", 2, "a@x", "h")
            .await
            .unwrap();
        paracord_db::users::update_user_public_key(&pool, 2, "pk_importer")
            .await
            .unwrap();

        // Bundle is the victim's identity (pk_victim), signed by the shared server.
        let bundle = bundle_for("victim", Some("pk_victim"));

        let err = verify_subject_binding(&pool, &bundle, 2).await.unwrap_err();
        assert!(matches!(err, CoreError::Forbidden));

        // import_identity must reject too and write nothing.
        let err = import_identity(&pool, &bundle, 2).await.unwrap_err();
        assert!(matches!(err, CoreError::Forbidden));
    }

    #[tokio::test]
    async fn subject_binding_accepts_matching_public_key() {
        let pool = mem_pool().await;
        paracord_db::users::create_user(&pool, 1, "victim", 1, "v@x", "h")
            .await
            .unwrap();
        paracord_db::users::update_user_public_key(&pool, 1, "pk_victim")
            .await
            .unwrap();

        let bundle = bundle_for("victim", Some("pk_victim"));
        verify_subject_binding(&pool, &bundle, 1).await.unwrap();
        // Full import path succeeds for the rightful owner.
        import_identity(&pool, &bundle, 1).await.unwrap();
    }

    #[tokio::test]
    async fn subject_binding_legacy_falls_back_to_username() {
        let pool = mem_pool().await;
        paracord_db::users::create_user(&pool, 3, "legacy", 3, "l@x", "h")
            .await
            .unwrap();

        // No public key on either side -> username must match.
        let ok = bundle_for("legacy", None);
        verify_subject_binding(&pool, &ok, 3).await.unwrap();

        let bad = bundle_for("someone-else", None);
        let err = verify_subject_binding(&pool, &bad, 3).await.unwrap_err();
        assert!(matches!(err, CoreError::Forbidden));
    }

    #[tokio::test]
    async fn subject_binding_rejects_keyed_bundle_for_keyless_account() {
        let pool = mem_pool().await;
        // Account has no crypto identity yet but the bundle claims one.
        paracord_db::users::create_user(&pool, 4, "victim", 4, "v4@x", "h")
            .await
            .unwrap();

        let bundle = bundle_for("victim", Some("pk_victim"));
        let err = verify_subject_binding(&pool, &bundle, 4).await.unwrap_err();
        assert!(matches!(err, CoreError::Forbidden));
    }
}
