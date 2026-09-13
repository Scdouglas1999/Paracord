mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::json;

#[tokio::test]
async fn realtime_voice_receipt_preserves_current_call_and_rejects_delayed_commands(
) -> anyhow::Result<()> {
    let ctx = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &ctx.db,
        &ctx.jwt_secret,
        "voicereceipt",
        "VoiceTestPass123!",
    )
    .await?;
    let user_id = paracord_core::auth::validate_token(&token, &ctx.jwt_secret)?.sub;
    let guild_id = paracord_util::snowflake::generate(1);
    paracord_core::guild::create_guild_full(&ctx.db, guild_id, "Receipt test", user_id, None)
        .await?;
    let channel_id = paracord_db::channels::get_guild_channels(&ctx.db, guild_id)
        .await?
        .into_iter()
        .find(|channel| channel.channel_type == 2)
        .unwrap()
        .id;
    paracord_db::voice_states::upsert_voice_state(
        &ctx.db,
        user_id,
        Some(guild_id),
        channel_id,
        "call-two",
    )
    .await?;
    ctx.state
        .voice
        .join_room(guild_id, channel_id, user_id, "call-two")
        .await;
    for (receipt, channel, expected) in [
        (Some("call-one"), Some(channel_id), StatusCode::CONFLICT),
        (Some("call-one"), None, StatusCode::CONFLICT),
        (Some("call-two"), Some(channel_id), StatusCode::OK),
        (None, Some(channel_id), StatusCode::OK), // Explicit old-client compatibility.
    ] {
        let mut payload = json!({"guild_id": guild_id.to_string(), "channel_id": channel.map(|id| id.to_string()), "self_mute": true});
        if let Some(receipt) = receipt {
            payload["session_id"] = json!(receipt);
        }
        let request = build_json_request(
            Method::POST,
            "/api/v2/rt/commands",
            Some(
                json!({"command_id": uuid::Uuid::new_v4().to_string(), "type":"voice_state_update", "payload":payload}),
            ),
            Some(&token),
        )?;
        let (status, body) = dispatch_json(&ctx.app, request).await?;
        assert_eq!(status, expected, "{body}");
        let current =
            paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, Some(guild_id))
                .await?
                .unwrap();
        assert_eq!(
            current.session_id, "call-two",
            "status commands must preserve the join receipt"
        );
    }
    let request = build_json_request(
        Method::POST,
        "/api/v2/rt/commands",
        Some(
            json!({"command_id":"matching-leave", "type":"voice_state_update", "payload":{"guild_id":guild_id.to_string(),"channel_id":null,"session_id":"call-two"}}),
        ),
        Some(&token),
    )?;
    assert_eq!(dispatch_json(&ctx.app, request).await?.0, StatusCode::OK);
    assert!(
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, Some(guild_id))
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn realtime_voice_receipt_is_checked_after_acquiring_membership_gate() -> anyhow::Result<()> {
    let ctx = build_test_app(TestAppOptions::default()).await?;
    let token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "voicegate", "VoiceTestPass123!")
            .await?;
    let user_id = paracord_core::auth::validate_token(&token, &ctx.jwt_secret)?.sub;
    let guild_id = paracord_util::snowflake::generate(1);
    paracord_core::guild::create_guild_full(&ctx.db, guild_id, "Gate test", user_id, None).await?;
    let channel_id = paracord_db::channels::get_guild_channels(&ctx.db, guild_id)
        .await?
        .into_iter()
        .find(|channel| channel.channel_type == 2)
        .unwrap()
        .id;
    paracord_db::voice_states::upsert_voice_state(
        &ctx.db,
        user_id,
        Some(guild_id),
        channel_id,
        "call-one",
    )
    .await?;
    let guard = ctx.state.voice.lock_membership(user_id).await;
    let request = build_json_request(
        Method::POST,
        "/api/v2/rt/commands",
        Some(
            json!({"command_id":"delayed-leave", "type":"voice_state_update", "payload":{"guild_id":guild_id.to_string(),"channel_id":null,"session_id":"call-one"}}),
        ),
        Some(&token),
    )?;
    let app = ctx.app.clone();
    let pending = tokio::spawn(async move { dispatch_json(&app, request).await });
    tokio::task::yield_now().await;
    assert!(!pending.is_finished());
    paracord_db::voice_states::upsert_voice_state(
        &ctx.db,
        user_id,
        Some(guild_id),
        channel_id,
        "call-two",
    )
    .await?;
    drop(guard);
    assert_eq!(pending.await??.0, StatusCode::CONFLICT);
    assert_eq!(
        paracord_db::voice_states::get_user_voice_session(&ctx.db, user_id, Some(guild_id))
            .await?
            .unwrap()
            .session_id,
        "call-two"
    );
    Ok(())
}
