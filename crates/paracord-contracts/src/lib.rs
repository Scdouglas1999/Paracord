//! JSON wire types shared by actual HTTP handlers, generated client validation,
//! and OpenAPI. Database rows and client-only state are intentionally separate.

pub mod channel;
pub mod credential;
pub mod emoji;
pub mod guild;
pub mod host;
pub mod invite;
pub mod relationship;
pub mod user;
pub mod voice;

use schemars::{generate::SchemaSettings, JsonSchema, Schema};
use serde_json::{json, Map, Value};

/// Protocol-version tolerance for response fields added after a release.
///
/// Paracord is self-hosted: a new client talks to servers that are older than
/// it. A response schema derived for serialization requires every field this
/// server always sends, so a field added later would make the generated
/// validators reject a whole payload (READY's servers, the server list) from
/// an older server. Each field named here is still always sent by this server;
/// the contract only stops requiring it, and the client reads its absence as
/// the older server's meaning (documented on each field). This is not a
/// fallback: there is one reading of each payload, and a feature that needs
/// the field is off on a server that does not send it.
pub(crate) fn absent_on_older_servers(schema: &mut Schema, fields: &[&str]) {
    if let Some(Value::Array(required)) = schema.get_mut("required") {
        required.retain(|name| !name.as_str().is_some_and(|name| fields.contains(&name)));
    }
}

fn response_schema<T: JsonSchema>() -> Value {
    serde_json::to_value(
        SchemaSettings::draft2020_12()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<T>(),
    )
    .expect("JSON Schema is serializable")
}

fn request_schema<T: JsonSchema>() -> Value {
    serde_json::to_value(
        SchemaSettings::draft2020_12()
            .for_deserialize()
            .into_generator()
            .into_root_schema_for::<T>(),
    )
    .expect("JSON Schema is serializable")
}

/// Deterministic source for checked-in JSON Schema and generated TypeScript.
/// Each entry is an independent complete schema, with local `$defs` references.
/// Request and response generation deliberately use different Serde contracts.
pub fn schemas() -> Value {
    let mut schemas = Map::new();
    schemas.insert(
        "GuildSummary".into(),
        response_schema::<guild::GuildSummary>(),
    );
    schemas.insert(
        "GuildSummaryList".into(),
        response_schema::<Vec<guild::GuildSummary>>(),
    );
    schemas.insert(
        "GuildDetail".into(),
        response_schema::<guild::GuildDetail>(),
    );
    schemas.insert(
        "ReadyGuildCore".into(),
        response_schema::<guild::ReadyGuildCore>(),
    );
    schemas.insert(
        "CreateGuildRequest".into(),
        request_schema::<guild::CreateGuildRequest>(),
    );
    schemas.insert(
        "UpdateGuildRequest".into(),
        request_schema::<guild::UpdateGuildRequest>(),
    );
    schemas.insert(
        "TransferOwnershipRequest".into(),
        request_schema::<guild::TransferOwnershipRequest>(),
    );
    schemas.insert(
        "OwnershipTransferResponse".into(),
        response_schema::<guild::OwnershipTransferResponse>(),
    );
    schemas.insert("CurrentUser".into(), response_schema::<user::CurrentUser>());
    schemas.insert(
        "UpdatedCurrentUser".into(),
        response_schema::<user::UpdatedCurrentUser>(),
    );
    schemas.insert(
        "PublicUserProfile".into(),
        response_schema::<user::PublicUserProfile>(),
    );
    schemas.insert(
        "UserSettingsResponse".into(),
        response_schema::<user::UserSettingsResponse>(),
    );
    schemas.insert(
        "UpdateMeRequest".into(),
        request_schema::<user::UpdateMeRequest>(),
    );
    schemas.insert(
        "UpdateSettingsRequest".into(),
        request_schema::<user::UpdateSettingsRequest>(),
    );
    schemas.insert(
        "ChangePasswordRequest".into(),
        request_schema::<user::ChangePasswordRequest>(),
    );
    schemas.insert(
        "ChangeEmailRequest".into(),
        request_schema::<user::ChangeEmailRequest>(),
    );
    schemas.insert(
        "RelationshipList".into(),
        response_schema::<Vec<relationship::Relationship>>(),
    );
    schemas.insert(
        "CreateRelationshipRequest".into(),
        request_schema::<relationship::CreateRelationshipRequest>(),
    );
    schemas.insert(
        "GuildInvite".into(),
        response_schema::<invite::GuildInvite>(),
    );
    schemas.insert(
        "GuildInviteList".into(),
        response_schema::<Vec<invite::GuildInvite>>(),
    );
    schemas.insert(
        "InvitePreview".into(),
        response_schema::<invite::InvitePreview>(),
    );
    schemas.insert(
        "InviteAcceptResponse".into(),
        response_schema::<invite::InviteAcceptResponse>(),
    );
    schemas.insert(
        "CreateInviteRequest".into(),
        request_schema::<invite::CreateInviteRequest>(),
    );
    schemas.insert(
        "AcceptInviteRequest".into(),
        request_schema::<invite::AcceptInviteRequest>(),
    );
    schemas.insert("GuildEmoji".into(), response_schema::<emoji::GuildEmoji>());
    schemas.insert(
        "GuildEmojiList".into(),
        response_schema::<Vec<emoji::GuildEmoji>>(),
    );
    schemas.insert(
        "UpdateEmojiRequest".into(),
        request_schema::<emoji::UpdateEmojiRequest>(),
    );
    schemas.insert(
        "ChannelPreview".into(),
        response_schema::<channel::ChannelPreview>(),
    );
    schemas.insert(
        "ChannelPreviewList".into(),
        response_schema::<Vec<channel::ChannelPreview>>(),
    );
    schemas.insert(
        "VoiceStateSnapshot".into(),
        response_schema::<voice::VoiceStateSnapshot>(),
    );
    schemas.insert(
        "UpdateVoiceModeRequest".into(),
        request_schema::<voice::UpdateVoiceModeRequest>(),
    );
    schemas.insert(
        "VoiceModeResponse".into(),
        response_schema::<voice::VoiceModeResponse>(),
    );
    schemas.insert(
        "StartVoiceViewRequest".into(),
        request_schema::<voice::StartVoiceViewRequest>(),
    );
    schemas.insert(
        "VoiceViewSession".into(),
        response_schema::<voice::VoiceViewSession>(),
    );
    schemas.insert(
        "VoiceWatchers".into(),
        response_schema::<voice::VoiceWatchers>(),
    );
    // First-run setup: one password (spec §3, §9.1).
    schemas.insert(
        "CredentialParamsRequest".into(),
        request_schema::<credential::CredentialParamsRequest>(),
    );
    schemas.insert(
        "CredentialParams".into(),
        response_schema::<credential::CredentialParams>(),
    );
    schemas.insert(
        "CredentialRegister".into(),
        request_schema::<credential::CredentialRegister>(),
    );
    schemas.insert(
        "CredentialLoginRequest".into(),
        request_schema::<credential::CredentialLoginRequest>(),
    );
    schemas.insert(
        "CredentialUpgradeRequest".into(),
        request_schema::<credential::CredentialUpgradeRequest>(),
    );
    schemas.insert(
        "ChangeCredentialRequest".into(),
        request_schema::<credential::ChangeCredentialRequest>(),
    );
    schemas.insert(
        "ResetCredentialRequest".into(),
        request_schema::<credential::ResetCredentialRequest>(),
    );
    schemas.insert(
        "CredentialEmailResetRequest".into(),
        request_schema::<credential::CredentialEmailResetRequest>(),
    );
    schemas.insert(
        "CredentialEpochResponse".into(),
        response_schema::<credential::CredentialEpochResponse>(),
    );
    schemas.insert(
        "KeyBackup".into(),
        response_schema::<credential::KeyBackup>(),
    );
    schemas.insert(
        "NewOwnerClaim".into(),
        request_schema::<credential::NewOwnerClaim>(),
    );
    schemas.insert(
        "CredentialClaimRequest".into(),
        request_schema::<credential::CredentialClaimRequest>(),
    );
    schemas.insert(
        "PasswordRequirements".into(),
        response_schema::<credential::PasswordRequirements>(),
    );
    // First-run setup: hosting and instance status (spec §2, §4, §5, §9.5).
    schemas.insert("HostStatus".into(), response_schema::<host::HostStatus>());
    schemas.insert(
        "InstanceStatusUpdate".into(),
        response_schema::<host::InstanceStatusUpdate>(),
    );
    schemas.insert(
        "StorageKeyEscrowRequest".into(),
        request_schema::<host::StorageKeyEscrowRequest>(),
    );
    schemas.insert(
        "UpdateBackupsRequest".into(),
        request_schema::<host::UpdateBackupsRequest>(),
    );
    schemas.insert(
        "BackupNowResponse".into(),
        response_schema::<host::BackupNowResponse>(),
    );
    schemas.insert(
        "HostPreflight".into(),
        response_schema::<host::HostPreflight>(),
    );
    schemas.insert(
        "HostProgress".into(),
        response_schema::<host::HostProgress>(),
    );
    for (name, schema) in &mut schemas {
        schema["title"] = json!(name);
        schema["$id"] = json!(format!("urn:paracord:contract:{name}"));
    }
    json!({ "schema_version": 1, "schemas": schemas })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_nulls_are_required_but_request_options_can_be_omitted() {
        let schemas = schemas();
        let summary = &schemas["schemas"]["GuildSummary"];
        let required = summary["required"].as_array().unwrap();
        for name in [
            "member_count",
            "description",
            "icon_hash",
            "hub_settings",
            "bot_settings",
        ] {
            assert!(
                required.contains(&json!(name)),
                "missing response requirement: {name}"
            );
        }
        let request = &schemas["schemas"]["CreateGuildRequest"];
        assert_eq!(request["required"], json!(["name"]));
        assert!(
            serde_json::from_value::<guild::CreateGuildRequest>(json!({"name":"Space"})).is_ok()
        );
    }

    #[test]
    fn channel_preview_nulls_are_present_and_ids_are_decimal() {
        let schemas = schemas();
        let preview = &schemas["schemas"]["ChannelPreview"];
        let required = preview["required"].as_array().unwrap();
        for name in [
            "author_name",
            "content",
            "media",
            "encrypted",
            "truncated",
            "attachment_count",
        ] {
            assert!(
                required.contains(&json!(name)),
                "missing preview requirement: {name}"
            );
        }
        assert_eq!(
            preview["properties"]["channel_id"]["pattern"],
            json!("^[0-9]+$")
        );
        assert!(serde_json::from_value::<channel::ChannelPreview>(json!({
            "channel_id": "1",
            "message_id": "2",
            "message_type": 0,
            "author_id": "anon:1:Quiet Fox",
            "author_kind": "anonymous",
            "author_name": "Quiet Fox",
            "content": null,
            "truncated": false,
            "encrypted": true,
            "created_at": "2026-09-29T12:00:00+00:00",
            "media": null,
            "attachment_count": 0,
            "has_sticker": false
        }))
        .is_ok());
    }

    #[test]
    fn voice_contracts_require_the_glass_fields_and_accept_real_payloads() {
        let schemas = schemas();
        let snapshot = &schemas["schemas"]["VoiceStateSnapshot"];
        let required = snapshot["required"].as_array().unwrap();
        for name in ["user_id", "channel_id", "self_stream", "self_video"] {
            assert!(required.contains(&json!(name)), "missing: {name}");
        }
        // The Glass and Index fields are always sent, but servers from before
        // them leave them out, so the contract accepts their absence.
        for name in [
            "session_id",
            "username",
            "speaking",
            "request_to_speak_at",
            "mode",
            "self_stream_started_at",
            "joined_at",
        ] {
            assert!(
                !required.contains(&json!(name)),
                "should be optional: {name}"
            );
        }
        assert!(serde_json::from_value::<voice::VoiceStateSnapshot>(json!({
            "user_id": "1", "channel_id": "2", "guild_id": "3",
            "self_mute": false, "self_deaf": false, "self_stream": true,
            "self_video": false, "suppress": false, "mute": false, "deaf": false,
            "mode": "listen", "self_stream_started_at": "2026-09-29T12:00:00+00:00",
            "joined_at": "2026-09-29T11:48:00+00:00",
            "username": "sean", "avatar_hash": null
        }))
        .is_ok());
        // An older server's voice state: no mode, no stream start, no join time.
        let older: voice::VoiceStateSnapshot = serde_json::from_value(json!({
            "user_id": "1", "channel_id": "2", "guild_id": "3",
            "self_mute": false, "self_deaf": false, "self_stream": false,
            "self_video": false, "suppress": false
        }))
        .unwrap();
        assert_eq!(older.mode, voice::VoiceMode::Joined);
        assert_eq!(older.joined_at, None);
        assert_eq!(older.self_stream_started_at, None);
        let sent = serde_json::to_value(&older).unwrap();
        for name in ["mode", "self_stream_started_at", "joined_at"] {
            assert!(sent.get(name).is_some(), "always serialized: {name}");
        }
        assert!(
            serde_json::from_value::<voice::UpdateVoiceModeRequest>(json!({"mode": "full"}))
                .is_err(),
            "only joined and listen exist"
        );
        let request = &schemas["schemas"]["StartVoiceViewRequest"];
        assert_eq!(request["required"], json!(["kind", "user_id"]));
        let view = &schemas["schemas"]["VoiceViewSession"];
        for name in ["session_id", "media", "via_membership"] {
            assert!(view["required"].as_array().unwrap().contains(&json!(name)));
        }
        let watchers = &schemas["schemas"]["VoiceWatchers"];
        assert_eq!(
            watchers["required"],
            json!(["guild_id", "channel_id", "streams"])
        );
    }

    #[test]
    fn detail_and_summary_have_distinct_contracts() {
        let schemas = schemas();
        assert!(schemas["schemas"]["GuildSummary"]["properties"]
            .get("feature_flags")
            .is_none());
        assert!(schemas["schemas"]["GuildDetail"]["properties"]
            .get("feature_flags")
            .is_some());
        assert_eq!(
            schemas["schemas"]["GuildSummary"]["properties"]["member_count"]["minimum"],
            0
        );
    }

    #[test]
    fn ready_guild_core_is_a_distinct_seven_field_contract() {
        let schemas = schemas();
        let core = &schemas["schemas"]["ReadyGuildCore"];
        let properties = core["properties"].as_object().unwrap();
        let mut names: Vec<_> = properties.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "created_at",
                "hue",
                "icon_hash",
                "id",
                "member_count",
                "name",
                "owner_id"
            ]
        );
        let required = core["required"].as_array().unwrap();
        for name in names.iter().filter(|name| **name != "hue") {
            assert!(
                required.contains(&json!(name)),
                "missing READY requirement: {name}"
            );
        }
        assert!(
            !required.contains(&json!("hue")),
            "a server from before colors sends no hue"
        );
        // The READY projection intentionally omits the REST settings surface.
        for name in [
            "description",
            "visibility",
            "allowed_roles",
            "discovery_tags",
            "hub_settings",
            "bot_settings",
            "banner_hash",
            "system_channel_id",
            "vanity_url_code",
            "feature_flags",
        ] {
            assert!(properties.get(name).is_none(), "unexpected field: {name}");
        }
        assert_eq!(
            core["properties"]["icon_hash"]["type"],
            json!(["string", "null"])
        );
        assert!(serde_json::from_value::<guild::ReadyGuildCore>(json!({
            "id": "1",
            "owner_id": "2",
            "name": "Space",
            "icon_hash": null,
            "created_at": "2026-09-12T12:00:00+00:00",
            "member_count": 2,
            "hue": null
        }))
        .is_ok());
    }

    #[test]
    fn hue_is_an_optional_nullable_wheel_angle_and_a_clearable_patch() {
        let schemas = schemas();
        for name in ["GuildSummary", "GuildDetail", "ReadyGuildCore"] {
            let schema = &schemas["schemas"][name];
            let hue = &schema["properties"]["hue"];
            assert_eq!(hue["type"], json!(["integer", "null"]), "{name}");
            assert_eq!(hue["minimum"], json!(0), "{name}");
            assert_eq!(hue["maximum"], json!(359), "{name}");
            // Always sent by this server, but optional in the contract: a
            // server from before colors leaves it out (absent reads as null).
            assert!(
                !schema["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("hue")),
                "{name} accepts a payload without hue"
            );
        }
        let older: guild::ReadyGuildCore = serde_json::from_value(json!({
            "id": "1", "owner_id": "2", "name": "Space", "icon_hash": null,
            "created_at": "2026-09-12T12:00:00+00:00", "member_count": 2
        }))
        .unwrap();
        assert_eq!(older.hue, None);
        assert!(
            serde_json::to_value(&older).unwrap().get("hue").is_some(),
            "this server always sends hue, null included"
        );
        assert!(!schemas["schemas"]["GuildSummary"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("banner_hash")));
        let request = &schemas["schemas"]["UpdateGuildRequest"];
        assert!(!request["required"]
            .as_array()
            .is_some_and(|required| required.contains(&json!("hue"))));
        let absent: guild::UpdateGuildRequest = serde_json::from_value(json!({})).unwrap();
        assert_eq!(absent.hue, None, "absent leaves the hue unchanged");
        let cleared: guild::UpdateGuildRequest =
            serde_json::from_value(json!({ "hue": null })).unwrap();
        assert_eq!(cleared.hue, Some(None), "null clears it");
        let set: guild::UpdateGuildRequest = serde_json::from_value(json!({ "hue": 214 })).unwrap();
        assert_eq!(set.hue, Some(Some(214)));
    }

    #[test]
    fn ready_guild_core_bounds_counts_and_nonempty_text() {
        let schemas = schemas();
        let properties = &schemas["schemas"]["ReadyGuildCore"]["properties"];
        assert_eq!(properties["member_count"]["type"], json!("integer"));
        assert_eq!(properties["member_count"]["minimum"], json!(0));
        assert_eq!(properties["member_count"]["maximum"], json!(4294967295u64));
        for name in ["id", "owner_id", "name"] {
            assert_eq!(properties[name]["minLength"], json!(1), "{name}");
            assert_eq!(properties[name]["pattern"], json!("\\S"), "{name}");
        }
        assert_eq!(properties["created_at"]["type"], json!("string"));
        assert_eq!(properties["created_at"]["minLength"], json!(1));
    }

    #[test]
    fn first_run_contracts_are_exported_with_their_wire_shapes() {
        let schemas = schemas();
        let params = &schemas["schemas"]["CredentialParams"];
        let variants = params["oneOf"].as_array().unwrap();
        assert_eq!(variants[0]["properties"]["version"]["const"], json!(1));
        assert_eq!(variants[1]["properties"]["version"]["const"], json!(2));
        assert_eq!(
            variants[1]["required"],
            json!(["version", "kdf", "salt", "epoch"])
        );

        let backup = &schemas["schemas"]["KeyBackup"];
        let required = backup["required"].as_array().unwrap();
        for name in [
            "public_key",
            "wrapped_key",
            "wrap_alg",
            "epoch",
            "recovery_confirmed",
        ] {
            assert!(required.contains(&json!(name)), "KeyBackup: {name}");
        }

        let claim = &schemas["schemas"]["CredentialClaimRequest"];
        let claim_properties = claim["properties"].as_object().unwrap();
        for name in [
            "token",
            "username",
            "credential",
            "identity",
            "initial_space_hue",
            "initial_space_template",
        ] {
            assert!(claim_properties.contains_key(name), "claim: {name}");
        }
        assert!(
            !claim_properties.contains_key("password"),
            "the credential claim never carries a password"
        );

        let status = &schemas["schemas"]["HostStatus"];
        for name in [
            "version",
            "started_at",
            "setup_required",
            "storage",
            "reachability",
            "backups",
            "tls",
        ] {
            assert!(
                status["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(name)),
                "HostStatus: {name}"
            );
        }

        // Older servers: the invite card's new fields may be absent.
        let preview = &schemas["schemas"]["InvitePreview"];
        let required = preview["required"].as_array().unwrap();
        for name in ["faces", "expires_at", "instance"] {
            assert!(!required.contains(&json!(name)), "optional: {name}");
            assert!(preview["properties"].get(name).is_some(), "present: {name}");
        }
        assert!(required.contains(&json!("code")));
        let older: invite::InviteGuildPreview = serde_json::from_value(json!({
            "id": "1", "name": "Space", "icon_hash": null, "member_count": 2
        }))
        .unwrap();
        assert_eq!(older.hue, None);
        assert_eq!(older.online_count, 0);

        let requirements = &schemas["schemas"]["PasswordRequirements"];
        assert!(!requirements["required"]
            .as_array()
            .unwrap()
            .contains(&json!("enforced_by")));

        let settings = &schemas["schemas"]["UpdateSettingsRequest"];
        assert!(settings["properties"].get("link_previews").is_some());
    }
}
