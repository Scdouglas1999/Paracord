//! JSON wire types shared by actual HTTP handlers, generated client validation,
//! and OpenAPI. Database rows and client-only state are intentionally separate.

pub mod emoji;
pub mod guild;
pub mod invite;
pub mod relationship;
pub mod user;

use schemars::{generate::SchemaSettings, JsonSchema};
use serde_json::{json, Map, Value};

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
    fn ready_guild_core_is_a_distinct_six_field_contract() {
        let schemas = schemas();
        let core = &schemas["schemas"]["ReadyGuildCore"];
        let properties = core["properties"].as_object().unwrap();
        let mut names: Vec<_> = properties.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "created_at",
                "icon_hash",
                "id",
                "member_count",
                "name",
                "owner_id"
            ]
        );
        let required = core["required"].as_array().unwrap();
        for name in &names {
            assert!(
                required.contains(&json!(name)),
                "missing READY requirement: {name}"
            );
        }
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
            "member_count": 2
        }))
        .is_ok());
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
}
