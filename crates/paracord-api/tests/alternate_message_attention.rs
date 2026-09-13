mod common;
use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

async fn call(
    app: &TestApp,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(method, path, body, Some(token)).unwrap(),
    )
    .await
    .unwrap()
}
struct Fixture {
    app: TestApp,
    owner: String,
    member: String,
    owner_id: i64,
    member_id: i64,
    guild: i64,
    channel: i64,
}
async fn setup() -> Fixture {
    setup_with_options(TestAppOptions::default()).await
}
async fn setup_with_options(options: TestAppOptions) -> Fixture {
    let app = build_test_app(options).await.unwrap();
    let owner = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "attentionowner",
        "AttentionOwner123!",
    )
    .await
    .unwrap();
    let member = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        "attentionmember",
        "AttentionMember123!",
    )
    .await
    .unwrap();
    let (_, me) = call(&app, &owner, Method::GET, "/api/v1/users/@me", None).await;
    let (_, other) = call(&app, &member, Method::GET, "/api/v1/users/@me", None).await;
    let owner_id = me["id"].as_str().unwrap().parse().unwrap();
    let member_id = other["id"].as_str().unwrap().parse().unwrap();
    let (status, guild) = call(
        &app,
        &owner,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Attention Space"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild: i64 = guild["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&app.db, member_id, guild)
        .await
        .unwrap();
    let (_, channels) = call(
        &app,
        &owner,
        Method::GET,
        &format!("/api/v1/guilds/{guild}/channels"),
        None,
    )
    .await;
    let channel = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["type"] == 0)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    Fixture {
        app,
        owner,
        member,
        owner_id,
        member_id,
        guild,
        channel,
    }
}

fn id(value: &Value) -> i64 {
    value.as_str().unwrap().parse().unwrap()
}

async fn audience(f: &Fixture, channel_id: i64, message: &Value) -> Vec<i64> {
    paracord_db::messages::get_message_mention_recipients(&f.app.db, channel_id, id(&message["id"]))
        .await
        .unwrap()
}

fn drain_mentions(
    receiver: &mut tokio::sync::broadcast::Receiver<paracord_core::events::ServerEvent>,
) -> Vec<Value> {
    let mut mentions = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        if event.event_type == "MESSAGE_MENTION" {
            mentions.push((*event.payload).clone());
        }
    }
    mentions
}

#[tokio::test]
async fn webhook_rich_messages_commit_audience_and_target_only_recipients() {
    let f = setup().await;
    let (status, webhook) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/guilds/{}/webhooks", f.guild),
        Some(json!({"name":"Attention Hook","channel_id":f.channel.to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{webhook}");
    let mut member_events = f
        .app
        .event_bus
        .register_session("mentioned", f.member_id, &[f.guild])
        .unwrap();
    let mut author_events = f
        .app
        .event_bus
        .register_session("author", f.owner_id, &[f.guild])
        .unwrap();
    let path = format!(
        "/api/v1/webhooks/{}/{}",
        webhook["id"].as_str().unwrap(),
        webhook["token"].as_str().unwrap()
    );
    let (status, message) = call(&f.app, &f.owner, Method::POST, &path,
        Some(json!({"content":format!("<@{}> @everyone",f.member_id),"embeds":[{"title":"Persist me"}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    assert_eq!(audience(&f, f.channel, &message).await, vec![f.member_id]);
    let stored = paracord_db::messages::get_message_with_embeds(&f.app.db, id(&message["id"]))
        .await
        .unwrap()
        .unwrap();
    assert!(stored.embeds.unwrap().contains("Persist me"));
    let mentions = drain_mentions(&mut member_events);
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0]["message_id"], message["id"]);
    assert_eq!(
        mentions[0]["channel_activity"]["last_message_id"],
        message["id"]
    );
    assert!(drain_mentions(&mut author_events).is_empty());
    let (status, edited) = call(
        &f.app,
        &f.owner,
        Method::PATCH,
        &format!("{path}/messages/{}", message["id"].as_str().unwrap()),
        Some(json!({"content":format!("<@{}> changed",f.owner_id)})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(audience(&f, f.channel, &message).await, vec![f.member_id]);
    assert!(drain_mentions(&mut author_events).is_empty());
    assert!(drain_mentions(&mut member_events).is_empty());
}

#[tokio::test]
async fn callback_and_followup_audiences_respect_bot_install_grants() {
    let f = setup().await;
    let (status, bot) = call(
        &f.app,
        &f.owner,
        Method::POST,
        "/api/v1/bots/applications",
        Some(json!({"name":"AudienceBot","permissions":"3072"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{bot}");
    let app_id = id(&bot["id"]);
    let bot_id = id(&bot["bot_user_id"]);
    let (status, installed) = call(
        &f.app,
        &f.owner,
        Method::POST,
        "/api/v1/oauth2/authorize",
        Some(json!({"application_id":app_id.to_string(),"guild_id":f.guild.to_string()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{installed}");
    let (interaction, token) = paracord_core::interactions::create_interaction(
        &f.app.state,
        app_id,
        bot_id,
        Some(f.guild),
        f.channel,
        f.owner_id,
        2,
        json!({"name":"attention"}),
    )
    .await
    .unwrap();
    let interaction_id = id(&interaction["id"]);
    let token_row =
        paracord_db::interaction_tokens::get_interaction_token(&f.app.db, interaction_id)
            .await
            .unwrap()
            .unwrap();
    let mut owner_events = f
        .app
        .event_bus
        .register_session("bot-owner", f.owner_id, &[f.guild])
        .unwrap();
    let mut member_events = f
        .app
        .event_bus
        .register_session("bot-member", f.member_id, &[f.guild])
        .unwrap();
    let content = format!("<@{}> <@{}> @everyone", f.member_id, bot_id);
    let response = paracord_core::interactions::process_interaction_response(
        &f.app.state,
        interaction_id,
        &token_row,
        4,
        Some(&json!({"content":content,"embeds":[{"title":"callback"}]})),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(audience(&f, f.channel, &response).await, vec![f.member_id]);
    assert_eq!(drain_mentions(&mut member_events).len(), 1);
    assert!(
        drain_mentions(&mut owner_events).is_empty(),
        "bot lacks mass-mention grant"
    );
    let (status, followup) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/interactions/{app_id}/{token}/followup"),
        Some(json!({"content":content,"embeds":[{"title":"followup"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{followup}");
    assert_eq!(audience(&f, f.channel, &followup).await, vec![f.member_id]);
    assert_eq!(drain_mentions(&mut member_events).len(), 1);
    assert!(drain_mentions(&mut owner_events).is_empty());
}

#[tokio::test]
async fn explicit_system_audiences_do_not_parse_evidence_and_cannot_escape_the_guild() {
    let f = setup().await;
    let bot_id = -2;
    paracord_db::users::create_user(&f.app.db, bot_id, "System", 0, "system@test.invalid", "")
        .await
        .unwrap();
    let recipients = paracord_core::message_attention::explicit_mentions(
        &f.app.db,
        f.guild,
        f.channel,
        bot_id,
        &[f.member_id, f.member_id, f.owner_id],
    )
    .await
    .unwrap();
    assert_eq!(recipients.len(), 2);
    assert!(
        paracord_core::message_attention::member_mentions(
            &f.app.db,
            f.channel,
            bot_id,
            "@everyone",
        )
        .await
        .is_err(),
        "synthetic authors have no local member authority"
    );
    assert!(paracord_core::message_attention::explicit_mentions(
        &f.app.db,
        f.guild + 1,
        f.channel,
        bot_id,
        &[f.member_id],
    )
    .await
    .is_err());
    let message_id = paracord_util::snowflake::generate(1);
    let message = paracord_db::messages::create_message_with_payload_mentions(
        &f.app.db,
        message_id,
        f.channel,
        bot_id,
        &format!("quoted <@{}> @everyone", f.owner_id),
        0,
        None,
        0,
        None,
        None,
        &[f.member_id],
    )
    .await
    .unwrap();
    let mut owner_events = f
        .app
        .event_bus
        .register_session("system-owner", f.owner_id, &[f.guild])
        .unwrap();
    let mut member_events = f
        .app
        .event_bus
        .register_session("system-member", f.member_id, &[f.guild])
        .unwrap();
    f.app.event_bus.dispatch_message(&f.app.db,"MESSAGE_CREATE",json!({
        "id":message.id.to_string(),"channel_id":f.channel.to_string(),"content":message.content,
    }),Some(f.guild)).await;
    assert!(drain_mentions(&mut owner_events).is_empty());
    assert_eq!(drain_mentions(&mut member_events).len(), 1);
    sqlx::query("INSERT INTO channel_overwrites (channel_id,target_id,target_type,allow_perms,deny_perms) VALUES ($1,$2,1,0,1024)")
        .bind(f.channel).bind(f.member_id).execute(&f.app.db).await.unwrap();
    assert!(
        paracord_core::message_attention::explicit_mentions(
            &f.app.db,
            f.guild,
            f.channel,
            bot_id,
            &[f.member_id],
        )
        .await
        .unwrap()
        .is_empty(),
        "forwarded recipients must still see the destination"
    );
}

#[tokio::test]
async fn forum_starter_publishes_thread_then_message_then_committed_mention() {
    let f = setup().await;
    let (status, forum) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/guilds/{}/channels", f.guild),
        Some(json!({"name":"topics","channel_type":7})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{forum}");
    let mut events = f
        .app
        .event_bus
        .register_session("forum-member", f.member_id, &[f.guild])
        .unwrap();
    let (status, post) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!(
            "/api/v1/channels/{}/forum/posts",
            forum["id"].as_str().unwrap()
        ),
        Some(json!({"name":"Discuss","content":format!("<@{}> topic",f.member_id)})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{post}");
    let mut kinds = Vec::new();
    let mut message_id = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "MESSAGE_MENTION" {
            message_id = Some(id(&event.payload["message_id"]));
        }
        kinds.push(event.event_type.clone());
    }
    assert_eq!(
        kinds,
        vec!["THREAD_CREATE", "MESSAGE_CREATE", "MESSAGE_MENTION"]
    );
    assert_eq!(
        paracord_db::messages::get_message_mention_recipients(
            &f.app.db,
            id(&post["id"]),
            message_id.unwrap(),
        )
        .await
        .unwrap(),
        vec![f.member_id]
    );
}

#[tokio::test]
async fn scheduled_receipts_recover_without_rechecking_new_send_authority_or_republishing() {
    let f = setup().await;
    let scheduled = paracord_db::scheduled_messages::create_scheduled_message(
        &f.app.db,
        paracord_util::snowflake::generate(1),
        f.channel,
        f.owner_id,
        Some(&format!("<@{}> scheduled", f.member_id)),
        None,
        None,
        None,
        chrono::Utc::now(),
    )
    .await
    .unwrap();
    assert!(
        !paracord_db::scheduled_messages::reconcile_committed_delivery(&f.app.db, &scheduled)
            .await
            .unwrap()
    );
    let message = paracord_core::message::create_message_with_options(
        &f.app.db,
        paracord_util::snowflake::generate(1),
        f.channel,
        f.owner_id,
        scheduled.content.as_deref().unwrap(),
        paracord_core::message::CreateMessageOptions {
            nonce: Some(scheduled.delivery_nonce()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // A committed schedule is historical even if posting authority changes
    // before its interrupted worker resumes.
    paracord_db::members::set_member_timeout(
        &f.app.db,
        f.owner_id,
        f.guild,
        Some(chrono::Utc::now() + chrono::Duration::minutes(5)),
    )
    .await
    .unwrap();
    assert!(
        paracord_db::scheduled_messages::reconcile_committed_delivery(&f.app.db, &scheduled)
            .await
            .unwrap()
    );
    let recovered = paracord_db::scheduled_messages::get_scheduled_message(&f.app.db, scheduled.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered.status,
        paracord_db::scheduled_messages::STATUS_SENT
    );
    assert_eq!(recovered.delivered_message_id, Some(message.id));
    assert_eq!(
        paracord_db::messages::get_message_mention_recipients(&f.app.db, f.channel, message.id)
            .await
            .unwrap(),
        vec![f.member_id]
    );
}

#[tokio::test]
async fn approving_quarantine_preserves_the_original_audience_instead_of_reparsing_text() {
    let f = setup().await;
    let report_id = paracord_util::snowflake::generate(1);
    paracord_db::audit_log::create_entry(&f.app.db,report_id,f.guild,f.owner_id,90,None,None,
        Some(&json!({
            "report_kind":"automod_quarantine","reported_user_id":f.owner_id.to_string(),
            "original_content":format!("<@{}> @everyone",f.member_id),
            "original_channel_id":f.channel.to_string(),"original_mention_user_ids":[],"status":"open"
        })),
    ).await.unwrap();
    let (status, report) = call(
        &f.app,
        &f.owner,
        Method::PATCH,
        &format!("/api/v1/guilds/{}/reports/{report_id}", f.guild),
        Some(json!({"action":"approve"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let message_id = id(&report["changes"]["approved_message_id"]);
    assert!(paracord_db::messages::get_message_mention_recipients(
        &f.app.db, f.channel, message_id
    )
    .await
    .unwrap()
    .is_empty());
}

#[tokio::test]
async fn crossposts_keep_source_recipients_without_granting_the_author_destination_membership() {
    let f = setup().await;
    let (status, source) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/guilds/{}/channels", f.guild),
        Some(json!({"name":"announcements","channel_type":5})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    let (status, target_guild) = call(
        &f.app,
        &f.member,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Follower"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{target_guild}");
    let target_guild = id(&target_guild["id"]);
    let (_, channels) = call(
        &f.app,
        &f.member,
        Method::GET,
        &format!("/api/v1/guilds/{target_guild}/channels"),
        None,
    )
    .await;
    let target_channel = id(&channels
        .as_array()
        .unwrap()
        .iter()
        .find(|ch| ch["type"] == 0)
        .unwrap()["id"]);
    assert!(
        paracord_db::members::get_member(&f.app.db, f.owner_id, target_guild)
            .await
            .unwrap()
            .is_none()
    );
    paracord_db::channel_follows::create_follow(
        &f.app.db,
        id(&source["id"]),
        target_channel,
        target_guild,
    )
    .await
    .unwrap();
    let mut events = f
        .app
        .event_bus
        .register_session("crosspost-member", f.member_id, &[f.guild, target_guild])
        .unwrap();
    let (status, message) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!(
            "/api/v1/channels/{}/messages",
            source["id"].as_str().unwrap()
        ),
        Some(json!({"content":format!("<@{}> @everyone update",f.member_id)})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    let crosspost_id = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.event_type == "MESSAGE_MENTION"
                && event.payload["channel_id"] == target_channel.to_string()
            {
                break id(&event.payload["message_id"]);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        paracord_db::messages::get_message_mention_recipients(
            &f.app.db,
            target_channel,
            crosspost_id
        )
        .await
        .unwrap(),
        vec![f.member_id]
    );
}

#[tokio::test]
async fn federation_uses_explicit_canonical_identities_and_never_interprets_remote_numeric_mentions(
) {
    let mut f = setup().await;
    f.app.state.federation_service = Some(paracord_federation::FederationService::new(
        paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local-server".into(),
            domain: "local.example".into(),
            key_id: "ed25519:test".into(),
            signing_key: None,
            allow_discovery: false,
        },
    ));
    let channel = paracord_db::channels::get_channel(&f.app.db, f.channel)
        .await
        .unwrap()
        .unwrap();
    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$message:remote.example".into(),
        room_id: format!("!{}:local.example", f.guild),
        event_type: "m.message".into(),
        sender: "@remote:remote.example".into(),
        origin_server: "remote.example".into(),
        origin_ts: 0,
        depth: 0,
        state_key: None,
        signatures: json!({}),
        content: json!({"body":format!("<@{}> @everyone",f.member_id)}),
    };
    assert!(
        paracord_api::routes::federation::resolve_federated_message_mentions(
            &f.app.state,
            &envelope,
            &channel,
            999,
        )
        .await
        .unwrap()
        .is_empty()
    );
    let member_username = paracord_db::users::get_user_by_id(&f.app.db, f.member_id)
        .await
        .unwrap()
        .unwrap()
        .username;
    envelope.content["m.mentions"] = json!({"user_ids":[format!("@{member_username}:local.example"),"@unmapped:remote.example"]});
    assert_eq!(
        paracord_api::routes::federation::resolve_federated_message_mentions(
            &f.app.state,
            &envelope,
            &channel,
            999,
        )
        .await
        .unwrap(),
        vec![f.member_id]
    );
    assert!(paracord_db::federation::get_remote_user_mapping(
        &f.app.db,
        "@unmapped:remote.example"
    )
    .await
    .unwrap()
    .is_none());
    paracord_db::federation::upsert_remote_user_mapping(
        &f.app.db,
        "@mapped:remote.example",
        "remote.example",
        f.member_id,
    )
    .await
    .unwrap();
    envelope.content["m.mentions"] = json!({"user_ids":["@mapped:remote.example"]});
    assert_eq!(
        paracord_api::routes::federation::resolve_federated_message_mentions(
            &f.app.state,
            &envelope,
            &channel,
            999,
        )
        .await
        .unwrap(),
        vec![f.member_id]
    );
    envelope.content["m.mentions"] = json!({"user_ids":[f.member_id.to_string()]});
    assert!(
        paracord_api::routes::federation::resolve_federated_message_mentions(
            &f.app.state,
            &envelope,
            &channel,
            999,
        )
        .await
        .is_err()
    );
}
