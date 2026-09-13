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
async fn send(f: &Fixture, token: &str, content: String, nonce: &str) -> Value {
    let (status, message) = call(
        &f.app,
        token,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", f.channel),
        Some(json!({"content":content, "nonce":nonce})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    message
}
async fn target(f: &Fixture, token: &str, kind: &str, after: &str) -> (StatusCode, Value) {
    call(
        &f.app,
        token,
        Method::GET,
        &format!(
            "/api/v1/channels/{}/messages/attention?kind={kind}&after={after}",
            f.channel
        ),
        None,
    )
    .await
}
async fn count(f: &Fixture) -> i32 {
    paracord_db::read_states::get_read_state(&f.app.db, f.member_id, f.channel)
        .await
        .unwrap()
        .map_or(0, |row| row.mention_count)
}

#[tokio::test]
async fn targets_the_first_unread_mention_not_the_latest_message_or_someone_elses_mention() {
    let f = setup().await;
    let first = send(
        &f,
        &f.owner,
        format!("<@{}> first <@!{}>", f.member_id, f.member_id),
        "first",
    )
    .await;
    send(&f, &f.owner, format!("<@{}> self", f.owner_id), "self").await;
    let second = send(&f, &f.owner, format!("<@{}> second", f.member_id), "second").await;
    send(&f, &f.owner, "newest ordinary message".into(), "tail").await;
    let (status, result) = target(&f, &f.member, "mention", "0").await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["message"]["id"], first["id"]);
    assert_eq!(result["user_id"], f.member_id.to_string());
    assert_eq!(count(&f).await, 2);
    assert_eq!(
        target(&f, &f.owner, "mention", "0").await.1["message"],
        Value::Null
    );
    let (status, read) = call(
        &f.app,
        &f.member,
        Method::PUT,
        &format!("/api/v1/channels/{}/read", f.channel),
        Some(json!({"last_message_id":first["id"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["mention_count"], 1);
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.1["message"]["id"],
        second["id"]
    );
    assert_eq!(
        target(&f, &f.member, "mention", second["id"].as_str().unwrap())
            .await
            .1["message"],
        Value::Null
    );
}

#[tokio::test]
async fn replay_edit_and_delete_preserve_recipient_identity_without_duplicate_counts() {
    let f = setup().await;
    let content = format!("<@{}> review this", f.member_id);
    let original = send(&f, &f.owner, content.clone(), "stable").await;
    let path = format!(
        "/api/v1/channels/{}/messages/{}",
        f.channel,
        original["id"].as_str().unwrap()
    );
    let (status, _) = call(
        &f.app,
        &f.owner,
        Method::PATCH,
        &path,
        Some(json!({"content":"Edited context"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, replay) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", f.channel),
        Some(json!({"content":content,"nonce":"stable"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["id"], original["id"]);
    assert_eq!(count(&f).await, 1);
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.1["message"]["content"],
        "Edited context"
    );
    assert_eq!(
        call(&f.app, &f.owner, Method::DELETE, &path, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(count(&f).await, 0);
    assert!(target(&f, &f.member, "mention", "0").await.1["message"].is_null());
}

#[tokio::test]
async fn partial_and_stale_acknowledgements_do_not_clear_newer_mentions() {
    let f = setup().await;
    let first = send(&f, &f.owner, format!("<@{}> first", f.member_id), "first").await;
    let second = send(&f, &f.owner, format!("<@{}> second", f.member_id), "second").await;
    let id = first["id"].as_str().unwrap().parse().unwrap();
    paracord_db::read_states::update_read_state(&f.app.db, f.member_id, f.channel, id)
        .await
        .unwrap();
    paracord_db::read_states::update_read_state(&f.app.db, f.member_id, f.channel, 0)
        .await
        .unwrap();
    assert_eq!(count(&f).await, 1);
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.1["message"]["id"],
        second["id"]
    );
}

#[tokio::test]
async fn mass_mentions_require_author_permission_and_deduplicate_direct_mentions() {
    let f = setup().await;
    send(
        &f,
        &f.member,
        "@everyone unauthorized".into(),
        "unprivileged",
    )
    .await;
    assert!(
        paracord_db::read_states::get_read_state(&f.app.db, f.owner_id, f.channel)
            .await
            .unwrap()
            .is_none()
    );
    send(
        &f,
        &f.owner,
        format!("@everyone @here <@{}> approved", f.member_id),
        "approved",
    )
    .await;
    assert_eq!(count(&f).await, 1);
    send(
        &f,
        &f.owner,
        "foo@everyone.com and @everyoneish".into(),
        "not-tokens",
    )
    .await;
    assert_eq!(count(&f).await, 1);
}

#[tokio::test]
async fn role_mentions_capture_only_members_of_the_correct_role_and_guild() {
    let f = setup().await;
    let role = 998_001;
    paracord_db::roles::create_role(&f.app.db, role, f.guild, "Reviewers", 0)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&f.app.db, f.member_id, f.guild, role)
        .await
        .unwrap();
    send(&f, &f.owner, format!("<@&{role}> review"), "role").await;
    assert_eq!(count(&f).await, 1);
    paracord_db::roles::remove_member_role(&f.app.db, f.member_id, f.guild, role)
        .await
        .unwrap();
    // A role change after delivery must not rewrite the original audience.
    assert!(target(&f, &f.member, "mention", "0").await.1["message"].is_object());
    send(&f, &f.owner, format!("<@&{role}> later"), "role-later").await;
    assert_eq!(count(&f).await, 1);
}

#[tokio::test]
async fn unread_target_honors_the_server_cursor_and_never_marks_anything_read() {
    let f = setup().await;
    let first = send(&f, &f.owner, "first".into(), "first").await;
    let second = send(&f, &f.owner, "second".into(), "second").await;
    assert_eq!(
        target(&f, &f.member, "unread", "0").await.1["message"]["id"],
        first["id"]
    );
    assert!(
        paracord_db::read_states::get_read_state(&f.app.db, f.member_id, f.channel)
            .await
            .unwrap()
            .is_none()
    );
    paracord_db::read_states::update_read_state(
        &f.app.db,
        f.member_id,
        f.channel,
        first["id"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        target(&f, &f.member, "unread", "0").await.1["message"]["id"],
        second["id"]
    );
}

#[tokio::test]
async fn revocation_and_history_denial_block_attention_previews() {
    let f = setup().await;
    send(
        &f,
        &f.owner,
        format!("<@{}> private", f.member_id),
        "private",
    )
    .await;
    sqlx::query("DELETE FROM members WHERE user_id = $1 AND guild_id = $2")
        .bind(f.member_id)
        .bind(f.guild)
        .execute(&f.app.db)
        .await
        .unwrap();
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.0,
        StatusCode::FORBIDDEN
    );
    paracord_db::members::add_member(&f.app.db, f.member_id, f.guild)
        .await
        .unwrap();
    sqlx::query("UPDATE roles SET permissions = permissions & $1 WHERE id = $2")
        .bind(!(paracord_models::permissions::Permissions::READ_MESSAGE_HISTORY.bits()))
        .bind(f.guild)
        .execute(&f.app.db)
        .await
        .unwrap();
    paracord_core::permissions::invalidate_user(&f.app.state.permission_cache, f.member_id).await;
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn bad_attention_kind_and_cursors_are_rejected() {
    let f = setup().await;
    for (kind, after) in [
        ("unknown", "0"),
        ("unread", "-1"),
        ("mention", "9223372036854775808"),
        ("mention", "1.2"),
    ] {
        assert_eq!(
            target(&f, &f.member, kind, after).await.0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn a_mention_storage_failure_rolls_back_the_message_and_its_delivery_receipt() {
    let f = setup().await;
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_mention AFTER INSERT ON message_mentions BEGIN SELECT RAISE(ABORT, 'injected mention failure'); END").execute(&f.app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_mention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected mention failure'; END; $$").execute(&f.app.db).await.unwrap();
            sqlx::query("CREATE TRIGGER reject_mention AFTER INSERT ON message_mentions FOR EACH ROW EXECUTE FUNCTION reject_mention()").execute(&f.app.db).await.unwrap();
        }
    }
    let path = format!("/api/v1/channels/{}/messages", f.channel);
    let body = json!({"content":format!("<@{}> atomic", f.member_id),"nonce":"atomic-mention"});
    assert_eq!(
        call(&f.app, &f.owner, Method::POST, &path, Some(body.clone()))
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let (messages,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE channel_id = $1")
        .bind(f.channel)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    let (receipts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM message_delivery_receipts WHERE channel_id = $1")
            .bind(f.channel)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!((messages, receipts, count(&f).await), (0, 0, 0));
    let drop = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_mention",
        paracord_db::DatabaseEngine::Postgres => "DROP TRIGGER reject_mention ON message_mentions",
    };
    sqlx::query(drop).execute(&f.app.db).await.unwrap();
    assert_eq!(
        call(&f.app, &f.owner, Method::POST, &path, Some(body))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(count(&f).await, 1);
}

#[tokio::test]
async fn a_concurrent_new_mention_and_partial_read_keep_the_new_mention_unread() {
    let f = setup_with_options(TestAppOptions {
        database_connections: 3,
        ..TestAppOptions::default()
    })
    .await;
    let first = send(&f, &f.owner, format!("<@{}> first", f.member_id), "first").await;
    let first_id = first["id"].as_str().unwrap().parse().unwrap();
    let (second, read) = tokio::join!(
        send(&f, &f.owner, format!("<@{}> second", f.member_id), "second"),
        paracord_db::read_states::update_read_state(&f.app.db, f.member_id, f.channel, first_id),
    );
    read.unwrap();
    assert_eq!(count(&f).await, 1);
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.1["message"]["id"],
        second["id"]
    );
}

#[tokio::test]
async fn a_hidden_channel_does_not_create_mention_records_for_a_member_who_cannot_view_it() {
    let f = setup().await;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &f.app.db,
        f.channel,
        f.member_id,
        1,
        0,
        paracord_models::permissions::Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    send(
        &f,
        &f.owner,
        format!("@everyone <@{}> hidden", f.member_id),
        "hidden",
    )
    .await;
    assert_eq!(count(&f).await, 0);
    assert_eq!(
        target(&f, &f.member, "mention", "0").await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn mention_events_go_only_to_recorded_recipients_and_do_not_repeat_on_replay() {
    let f = setup().await;
    let mut owner_events = f
        .app
        .event_bus
        .register_session("attention-owner", f.owner_id, &[f.guild])
        .unwrap();
    let mut member_events = f
        .app
        .event_bus
        .register_session("attention-member", f.member_id, &[f.guild])
        .unwrap();
    let content = format!("<@{}> target", f.member_id);
    let message = send(&f, &f.owner, content.clone(), "event").await;
    let mut owner_mentions = 0;
    while let Ok(event) = owner_events.try_recv() {
        if event.event_type == "MESSAGE_MENTION" {
            owner_mentions += 1;
        }
    }
    let mut member_mentions = Vec::new();
    while let Ok(event) = member_events.try_recv() {
        if event.event_type == "MESSAGE_MENTION" {
            member_mentions.push((*event.payload).clone());
        }
    }
    assert_eq!(owner_mentions, 0);
    assert_eq!(member_mentions.len(), 1);
    assert_eq!(member_mentions[0]["channel_id"], f.channel.to_string());
    assert_eq!(member_mentions[0]["message_id"], message["id"]);
    assert_eq!(
        member_mentions[0]["channel_activity"]["last_message_id"],
        message["id"]
    );
    call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", f.channel),
        Some(json!({"content":content,"nonce":"event"})),
    )
    .await;
    while let Ok(event) = member_events.try_recv() {
        assert_ne!(event.event_type, "MESSAGE_MENTION");
    }
}

async fn stored_tail(f: &Fixture, channel: i64) -> Option<i64> {
    paracord_db::channels::get_channel(&f.app.db, channel)
        .await
        .unwrap()
        .unwrap()
        .last_message_id
}

#[tokio::test]
async fn deleting_the_tail_selects_the_surviving_message_and_preserves_read_cursors() {
    let f = setup().await;
    let first = send(&f, &f.owner, "first".into(), "tail-first").await;
    let second = send(&f, &f.owner, "second".into(), "tail-second").await;
    let first_id = first["id"].as_str().unwrap().parse::<i64>().unwrap();
    let second_id = second["id"].as_str().unwrap().parse::<i64>().unwrap();
    paracord_db::read_states::update_read_state(&f.app.db, f.member_id, f.channel, second_id)
        .await
        .unwrap();
    let (status, _) = call(
        &f.app,
        &f.owner,
        Method::DELETE,
        &format!("/api/v1/channels/{}/messages/{second_id}", f.channel),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(stored_tail(&f, f.channel).await, Some(first_id));
    paracord_db::messages::delete_message(&f.app.db, first_id)
        .await
        .unwrap();
    assert_eq!(stored_tail(&f, f.channel).await, None);
    assert_eq!(
        paracord_db::read_states::get_read_state(&f.app.db, f.member_id, f.channel)
            .await
            .unwrap()
            .unwrap()
            .last_message_id,
        second_id
    );
}

#[tokio::test]
async fn bulk_and_retention_deletion_repair_only_the_affected_channels() {
    let f = setup().await;
    let other = f.channel + 123;
    paracord_db::channels::create_channel(
        &f.app.db,
        other,
        f.guild,
        "other-tail",
        0,
        1,
        None,
        None,
    )
    .await
    .unwrap();
    for (id, channel) in [
        (1000, f.channel),
        (1001, f.channel),
        (2000, other),
        (2001, other),
    ] {
        paracord_db::messages::create_message(&f.app.db, id, channel, f.owner_id, "tail", 0, None)
            .await
            .unwrap();
    }
    assert_eq!(
        paracord_db::messages::bulk_delete_messages(&f.app.db, f.channel, &[1001, 2001])
            .await
            .unwrap(),
        1
    );
    assert_eq!(stored_tail(&f, f.channel).await, Some(1000));
    assert_eq!(stored_tail(&f, other).await, Some(2001));
    // The retention helper accepts IDs from multiple channels in arbitrary order.
    assert_eq!(
        paracord_db::messages::delete_messages_by_ids(&f.app.db, &[2001, 1000, 2001, 9999])
            .await
            .unwrap(),
        2
    );
    assert_eq!(stored_tail(&f, f.channel).await, None);
    assert_eq!(stored_tail(&f, other).await, Some(2000));
    assert!(!paracord_db::messages::delete_message_authorized(
        &f.app.db,
        2000,
        other,
        f.member_id,
        false
    )
    .await
    .unwrap());
    assert_eq!(stored_tail(&f, other).await, Some(2000));
}

#[tokio::test]
async fn concurrent_delayed_sends_and_deletion_always_leave_the_actual_maximum() {
    let f = setup_with_options(TestAppOptions {
        database_connections: 3,
        ..TestAppOptions::default()
    })
    .await;
    // Hold two distinct connections at once: a one-connection fixture would
    // silently serialize tokio::join! and fail to exercise database locking.
    let mut first_connection = f.app.db.acquire().await.unwrap();
    let mut second_connection = f.app.db.acquire().await.unwrap();
    for connection in [&mut first_connection, &mut second_connection] {
        let (present,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels WHERE id = $1")
            .bind(f.channel)
            .fetch_one(&mut **connection)
            .await
            .unwrap();
        assert_eq!(present, 1);
    }
    drop(first_connection);
    drop(second_connection);
    for round in 1..=12 {
        let newest = round * 1000 + 900;
        let delayed = round * 1000 + 100;
        paracord_db::messages::create_message(
            &f.app.db, newest, f.channel, f.owner_id, "newest", 0, None,
        )
        .await
        .unwrap();
        let (created, deleted) = tokio::join!(
            paracord_db::messages::create_message(
                &f.app.db,
                delayed,
                f.channel,
                f.owner_id,
                "delayed older send",
                0,
                None
            ),
            paracord_db::messages::delete_message_authorized(
                &f.app.db, newest, f.channel, f.owner_id, false
            ),
        );
        created.unwrap();
        assert!(deleted.unwrap());
        assert_eq!(stored_tail(&f, f.channel).await, Some(delayed));
        let delayed_ids = [delayed];
        let (first, second) = tokio::join!(
            paracord_db::messages::delete_message(&f.app.db, delayed),
            paracord_db::messages::bulk_delete_messages(&f.app.db, f.channel, &delayed_ids),
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(stored_tail(&f, f.channel).await, None);
    }
}

#[tokio::test]
async fn channel_tail_repair_failure_rolls_back_the_deletion_and_its_mentions() {
    let f = setup().await;
    let message = send(
        &f,
        &f.owner,
        format!("<@{}> keep atomically", f.member_id),
        "tail-rollback",
    )
    .await;
    let id = message["id"].as_str().unwrap().parse::<i64>().unwrap();
    match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => {
            sqlx::query("CREATE TRIGGER reject_tail_repair BEFORE UPDATE OF last_message_id ON channels WHEN NEW.last_message_id IS NULL AND OLD.last_message_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected tail failure'); END").execute(&f.app.db).await.unwrap();
        }
        paracord_db::DatabaseEngine::Postgres => {
            sqlx::query("CREATE FUNCTION reject_tail_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.last_message_id IS NULL AND OLD.last_message_id IS NOT NULL THEN RAISE EXCEPTION 'injected tail failure'; END IF; RETURN NEW; END; $$").execute(&f.app.db).await.unwrap();
            sqlx::query("CREATE TRIGGER reject_tail_repair BEFORE UPDATE OF last_message_id ON channels FOR EACH ROW EXECUTE FUNCTION reject_tail_repair()").execute(&f.app.db).await.unwrap();
        }
    }
    assert!(paracord_db::messages::delete_message(&f.app.db, id)
        .await
        .is_err());
    assert_eq!(stored_tail(&f, f.channel).await, Some(id));
    assert!(paracord_db::messages::get_message(&f.app.db, id)
        .await
        .unwrap()
        .is_some());
    assert_eq!(count(&f).await, 1);
    let drop = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => "DROP TRIGGER reject_tail_repair",
        paracord_db::DatabaseEngine::Postgres => "DROP TRIGGER reject_tail_repair ON channels",
    };
    sqlx::query(drop).execute(&f.app.db).await.unwrap();
    paracord_db::messages::delete_message(&f.app.db, id)
        .await
        .unwrap();
    assert_eq!(stored_tail(&f, f.channel).await, None);
    assert_eq!(count(&f).await, 0);
}

#[tokio::test]
async fn activity_revisions_order_deletions_and_late_publication_independently_of_message_ids() {
    let f = setup().await;
    let mut events = f
        .app
        .event_bus
        .register_session("activity-order", f.member_id, &[f.guild])
        .unwrap();
    let first = send(&f, &f.owner, "first activity".into(), "activity-first").await;
    let event = next_activity_event(&mut events).await;
    assert_eq!(event.event_type, "MESSAGE_CREATE");
    assert_eq!(
        event.payload["channel_activity"],
        json!({ "channel_id": f.channel.to_string(), "guild_id": f.guild.to_string(), "last_message_id": first["id"], "revision": "1" })
    );
    let second = send(&f, &f.owner, "second activity".into(), "activity-second").await;
    assert_eq!(
        next_activity_event(&mut events).await.payload["channel_activity"]["revision"],
        "2"
    );
    let (status, _) = call(
        &f.app,
        &f.owner,
        Method::DELETE,
        &format!(
            "/api/v1/channels/{}/messages/{}",
            f.channel,
            second["id"].as_str().unwrap()
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let deleted = next_activity_event(&mut events).await;
    assert_eq!(deleted.event_type, "MESSAGE_DELETE");
    assert_eq!(
        deleted.payload["channel_activity"]["last_message_id"],
        first["id"]
    );
    assert_eq!(deleted.payload["channel_activity"]["revision"], "3");
    let (_, channel) = call(
        &f.app,
        &f.owner,
        Method::GET,
        &format!("/api/v1/channels/{}", f.channel),
        None,
    )
    .await;
    assert_eq!(channel["last_message_id"], first["id"]);
    assert_eq!(channel["message_revision"], "3");
    // Simulate the original create's publication reaching the bus after deletion.
    // Its body keeps its original identity, while channel activity is current.
    f.app
        .event_bus
        .dispatch_message(&f.app.db, "MESSAGE_CREATE", second, Some(f.guild))
        .await;
    let late = next_activity_event(&mut events).await;
    assert_eq!(
        late.payload["channel_activity"]["last_message_id"],
        first["id"]
    );
    assert_eq!(late.payload["channel_activity"]["revision"], "3");
    call(
        &f.app,
        &f.owner,
        Method::DELETE,
        &format!(
            "/api/v1/channels/{}/messages/{}",
            f.channel,
            first["id"].as_str().unwrap()
        ),
        None,
    )
    .await;
    let empty = next_activity_event(&mut events).await;
    assert!(empty.payload["channel_activity"]["last_message_id"].is_null());
    assert_eq!(empty.payload["channel_activity"]["revision"], "4");
}

#[tokio::test]
async fn replay_and_missing_deletion_do_not_advance_activity_and_revision_exhaustion_rolls_back() {
    let f = setup().await;
    let first = send(&f, &f.owner, "once".into(), "activity-replay").await;
    let first_id = first["id"].as_str().unwrap().parse::<i64>().unwrap();
    let (status, _) = call(
        &f.app,
        &f.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", f.channel),
        Some(json!({"content":"once", "nonce":"activity-replay"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!paracord_db::messages::delete_message_authorized(
        &f.app.db,
        first_id,
        f.channel,
        f.member_id,
        false
    )
    .await
    .unwrap());
    paracord_db::messages::delete_message(&f.app.db, 999)
        .await
        .unwrap();
    assert_eq!(
        paracord_db::channels::get_channel(&f.app.db, f.channel)
            .await
            .unwrap()
            .unwrap()
            .message_revision,
        1
    );
    sqlx::query("UPDATE channels SET message_revision = $1 WHERE id = $2")
        .bind(i64::MAX)
        .bind(f.channel)
        .execute(&f.app.db)
        .await
        .unwrap();
    assert!(paracord_db::messages::create_message_with_delivery_nonce(
        &f.app.db,
        1001,
        f.channel,
        f.owner_id,
        "must roll back",
        0,
        None,
        0,
        None,
        None,
        Some("exhausted")
    )
    .await
    .is_err());
    assert!(paracord_db::messages::get_message(&f.app.db, 1001)
        .await
        .unwrap()
        .is_none());
    let channel = paracord_db::channels::get_channel(&f.app.db, f.channel)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(channel.message_revision, i64::MAX);
    assert_eq!(channel.last_message_id, Some(first_id));
    let (receipts,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_delivery_receipts WHERE channel_id = $1 AND nonce = 'exhausted'").bind(f.channel).fetch_one(&f.app.db).await.unwrap();
    assert_eq!(receipts, 0);
}

async fn next_activity_event(
    events: &mut tokio::sync::broadcast::Receiver<paracord_core::events::ServerEvent>,
) -> paracord_core::events::ServerEvent {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if matches!(
                event.event_type.as_str(),
                "MESSAGE_CREATE" | "MESSAGE_DELETE" | "MESSAGE_DELETE_BULK"
            ) {
                return event;
            }
        }
    })
    .await
    .expect("message activity event")
}
