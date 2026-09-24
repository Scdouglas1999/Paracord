mod common;

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use chrono::{Duration, Utc};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tower::ServiceExt;

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

struct People {
    app: TestApp,
    owner: String,
    owner_id: i64,
    member: String,
    member_id: i64,
    guild: i64,
    channel: i64,
}

async fn people(prefix: &str) -> People {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let owner = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        &format!("{prefix}owner"),
        "OwnerPass123!",
    )
    .await
    .unwrap();
    let member = create_authenticated_user_token(
        &app.db,
        &app.jwt_secret,
        &format!("{prefix}member"),
        "MemberPass123!",
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
        Some(json!({"name":"Actions"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild: i64 = guild["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&app.db, member_id, guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&app.db, member_id, guild, guild)
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
    People {
        app,
        owner,
        owner_id,
        member,
        member_id,
        guild,
        channel,
    }
}

async fn send(p: &People, token: &str, content: &str) -> Value {
    let (status, message) = call(
        &p.app,
        token,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": content})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    message
}

fn envelope(n: u32) -> Value {
    json!({
        "version": 2,
        "nonce": format!("bm9uY2U{n}"),
        "ciphertext": format!("Y2lwaGV{n}"),
        "header": json!({"dh":"cHVibGlja2V5", "pn":0, "n":n}).to_string()
    })
}

const EMOJI: &str = "%F0%9F%91%8D";

#[tokio::test]
async fn reaction_list_is_oldest_first_and_rejects_an_unknown_cursor() {
    let p = people("react").await;
    let outsider = create_authenticated_user_token(
        &p.app.db,
        &p.app.jwt_secret,
        "reactother",
        "OtherPass123!",
    )
    .await
    .unwrap();
    let (_, outsider_me) = call(&p.app, &outsider, Method::GET, "/api/v1/users/@me", None).await;
    let outsider_id: i64 = outsider_me["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&p.app.db, outsider_id, p.guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&p.app.db, outsider_id, p.guild, p.guild)
        .await
        .unwrap();

    let message = send(&p, &p.owner, "who reacted").await;
    let message_id = message["id"].as_str().unwrap();
    let path = format!(
        "/api/v1/channels/{}/messages/{message_id}/reactions/{EMOJI}/@me",
        p.channel
    );
    for token in [&p.owner, &p.member, &outsider] {
        let (status, body) = call(&p.app, token, Method::PUT, &path, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    // The list orders by the stored stamp. Pin each row so the test does not
    // depend on three inserts landing in different milliseconds.
    for (user_id, stamp) in [
        (p.owner_id, "2026-09-22 12:00:00.001"),
        (p.member_id, "2026-09-22 12:00:00.002"),
        (outsider_id, "2026-09-22 12:00:00.003"),
    ] {
        sqlx::query("UPDATE reactions SET created_at = $1 WHERE message_id = $2 AND user_id = $3")
            .bind(stamp)
            .bind(message_id.parse::<i64>().unwrap())
            .bind(user_id)
            .execute(&p.app.db)
            .await
            .unwrap();
    }

    let list_path = format!(
        "/api/v1/channels/{}/messages/{message_id}/reactions/{EMOJI}",
        p.channel
    );
    let (status, listed) = call(&p.app, &p.member, Method::GET, &list_path, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let ids: Vec<String> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        ids,
        vec![
            p.owner_id.to_string(),
            p.member_id.to_string(),
            outsider_id.to_string(),
        ]
    );
    assert!(listed[0]["username"].is_string());

    let (status, page) = call(
        &p.app,
        &p.member,
        Method::GET,
        &format!("{list_path}?limit=1&after={}", p.owner_id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert_eq!(page[0]["id"], p.member_id.to_string());

    let (status, missing) = call(
        &p.app,
        &p.member,
        Method::GET,
        &format!("{list_path}?after=1"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");
    assert_eq!(
        missing["message"],
        "bad request: That reaction cursor is not in this list."
    );
}

#[tokio::test]
async fn reminders_move_delete_fire_and_disappear_when_access_is_lost() {
    let p = people("remind").await;
    let message = send(&p, &p.owner, "first line\nsecond").await;
    let message_id = message["id"].as_str().unwrap();
    let path = format!(
        "/api/v1/channels/{}/messages/{message_id}/reminder",
        p.channel
    );
    let first_at = (Utc::now() + Duration::hours(2)).to_rfc3339();
    let (status, created) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &path,
        Some(json!({"remind_at": first_at})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert!(created["fired_at"].is_null());
    assert_eq!(created["preview"], "first line");
    assert_eq!(created["message"]["id"], message_id);
    let reminder_id = created["id"].as_str().unwrap().to_string();

    let moved_at = (Utc::now() + Duration::hours(5)).to_rfc3339();
    let (status, moved) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &path,
        Some(json!({"remind_at": moved_at})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["id"], reminder_id);
    assert_ne!(moved["remind_at"], created["remind_at"]);
    assert!(moved["fired_at"].is_null());

    let (status, past) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &path,
        Some(json!({"remind_at": "2020-01-01T00:00:00Z"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{past}");
    assert_eq!(past["message"], "bad request: Choose a time in the future.");

    let (status, listed) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);

    let mut rx = p.app.event_bus.subscribe_system();
    let fired = paracord_api::routes::reminders::fire_due_reminders(
        &p.app.state,
        Utc::now() + Duration::hours(6),
    )
    .await
    .unwrap();
    assert_eq!(fired, 1);
    let event = rx.try_recv().unwrap();
    assert_eq!(event.event_type, "REMINDER_FIRED");
    assert_eq!(event.payload["id"], reminder_id);
    assert!(event.payload["fired_at"].is_string());
    assert_eq!(
        event.target_user_ids.as_deref(),
        Some([p.member_id].as_slice())
    );

    let (status, after_fire) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after_fire}");
    assert!(after_fire["items"][0]["fired_at"].is_string());

    let (status, _) = call(&p.app, &p.member, Method::DELETE, &path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, empty) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert!(empty["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn lost_access_and_deleted_messages_remove_reminders_without_firing() {
    let p = people("remindloss").await;
    let message = send(&p, &p.owner, "keep this").await;
    let message_id = message["id"].as_str().unwrap();
    let path = format!(
        "/api/v1/channels/{}/messages/{message_id}/reminder",
        p.channel
    );
    let (status, created) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &path,
        Some(json!({"remind_at": (Utc::now() + Duration::minutes(30)).to_rfc3339()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");

    paracord_db::members::remove_member(&p.app.db, p.member_id, p.guild)
        .await
        .unwrap();
    let (status, listed) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(listed["items"].as_array().unwrap().is_empty());

    let mut rx = p.app.event_bus.subscribe_system();
    let fired = paracord_api::routes::reminders::fire_due_reminders(
        &p.app.state,
        Utc::now() + Duration::hours(2),
    )
    .await
    .unwrap();
    assert_eq!(fired, 0);
    assert!(rx.try_recv().is_err());

    paracord_db::members::add_member(&p.app.db, p.member_id, p.guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&p.app.db, p.member_id, p.guild, p.guild)
        .await
        .unwrap();
    let (status, again) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &path,
        Some(json!({"remind_at": (Utc::now() + Duration::minutes(30)).to_rfc3339()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    paracord_db::messages::delete_message(&p.app.db, message_id.parse().unwrap())
        .await
        .unwrap();
    let (_, gone) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert!(gone["items"].as_array().unwrap().is_empty());
}

async fn raw(
    app: &TestApp,
    token: &str,
    method: Method,
    path: &str,
    content_type: Option<String>,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if let Some(content_type) = content_type {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    let response = app
        .app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, bytes.to_vec())
}

async fn upload(p: &People, token: &str, filename: &str, bytes: &[u8]) -> String {
    let boundary = "paracord-forward-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let (status, response) = raw(
        &p.app,
        token,
        Method::POST,
        &format!("/api/v1/channels/{}/attachments", p.channel),
        Some(format!("multipart/form-data; boundary={boundary}")),
        body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&response)
    );
    let json: Value = serde_json::from_slice(&response).unwrap();
    json["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn forward_copies_server_attachments_and_refuses_what_the_sender_cannot_read() {
    let p = people("forward").await;
    let upload_id = upload(&p, &p.owner, "notes.txt", b"forwarded bytes").await;
    let (status, source) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": "the real text", "attachment_ids": [upload_id]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    let source_id: i64 = source["id"].as_str().unwrap().parse().unwrap();

    let forward_body = json!({
        "content": "a note",
        "nonce": "forward-once",
        "forwarded_from": {
            "channel_id": p.channel.to_string(),
            "message_id": source_id.to_string(),
            "author_name": "Not The Author",
            "content": "tampered"
        }
    });
    let (status, forwarded) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(forward_body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{forwarded}");
    assert_eq!(forwarded["content"], "a note");
    assert_eq!(forwarded["forwarded_from"]["content"], "the real text");
    assert_ne!(forwarded["forwarded_from"]["author_name"], "Not The Author");
    assert_eq!(
        forwarded["forwarded_from"]["channel_id"],
        p.channel.to_string()
    );
    assert_eq!(
        forwarded["forwarded_from"]["message_id"],
        source_id.to_string()
    );
    let copies = forwarded["attachments"].as_array().unwrap();
    assert_eq!(copies.len(), 1, "{forwarded}");
    let copy_id = copies[0]["id"].as_str().unwrap().to_string();
    assert_ne!(copy_id, upload_id);
    assert_eq!(copies[0]["filename"], "notes.txt");

    // The copy is a file of its own: readable through its own id, and it
    // outlives the source message.
    let (status, bytes) = raw(
        &p.app,
        &p.member,
        Method::GET,
        &format!("/api/v1/attachments/{copy_id}"),
        None,
        Vec::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"forwarded bytes");

    // Sending the same forward again (a retry) stores nothing new.
    let (status, again) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(forward_body),
    )
    .await;
    assert!(status.is_success(), "{again}");
    assert_eq!(again["id"], forwarded["id"]);
    let linked = paracord_db::attachments::get_message_attachments(
        &p.app.db,
        forwarded["id"].as_str().unwrap().parse().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(linked.len(), 1);

    // Forwarding the forward (no note of its own) points at the original.
    let (status, reforward) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({
            "content": "",
            "forwarded_from": {
                "channel_id": p.channel.to_string(),
                "message_id": source_id.to_string()
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{reforward}");
    let (status, wrapped) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({
            "content": "",
            "forwarded_from": {
                "channel_id": p.channel.to_string(),
                "message_id": reforward["id"]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{wrapped}");
    assert_eq!(
        wrapped["forwarded_from"]["message_id"],
        source_id.to_string()
    );

    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &p.app.db,
        p.channel,
        p.guild,
        0,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    p.app
        .state
        .permission_cache
        .invalidate_channel(p.channel)
        .await;
    let other_channel = paracord_db::channels::create_channel(
        &p.app.db,
        903001,
        p.guild,
        "elsewhere",
        0,
        1,
        None,
        None,
    )
    .await
    .unwrap();
    let (status, denied) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", other_channel.id),
        Some(json!({
            "content": "nope",
            "forwarded_from": {
                "channel_id": p.channel.to_string(),
                "message_id": source_id.to_string()
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    let (_, page) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!("/api/v1/channels/{}/messages", other_channel.id),
        None,
    )
    .await;
    assert!(page.as_array().unwrap().is_empty(), "{page}");
}

#[tokio::test]
async fn dm_forwards_keep_ciphertext_off_the_server_and_refuse_files() {
    let p = people("dmfwd").await;
    let (_, member_me) = call(&p.app, &p.member, Method::GET, "/api/v1/users/@me", None).await;
    let _ = member_me;
    let dm_id = 902001_i64;
    paracord_db::dms::create_dm_channel(&p.app.db, dm_id, p.owner_id, p.member_id)
        .await
        .unwrap();
    let (status, dm_message) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{dm_id}/messages"),
        Some(json!({"content": "", "e2ee": envelope(1)})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{dm_message}");
    let dm_message_id: i64 = dm_message["id"].as_str().unwrap().parse().unwrap();

    let (status, posted) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({
            "content": "",
            "forwarded_from": {
                "channel_id": dm_id.to_string(),
                "message_id": dm_message_id.to_string(),
                "content": "the words I am posting"
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{posted}");
    assert_eq!(
        posted["forwarded_from"]["content"],
        "the words I am posting"
    );
    assert_ne!(posted["forwarded_from"]["content"], "Y2lwaGV1");

    paracord_db::attachments::create_attachment(
        &p.app.db,
        880002,
        Some(dm_message_id),
        "secret.png",
        Some("image/png"),
        4,
        "https://files.example/secret.png",
        None,
        None,
        Some(p.owner_id),
        Some(dm_id),
        None,
        None,
    )
    .await
    .unwrap();
    let (status, rejected) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({
            "content": "note",
            "forwarded_from": {
                "channel_id": dm_id.to_string(),
                "message_id": dm_message_id.to_string(),
                "content": "should not land"
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    assert_eq!(
        rejected["message"],
        "bad request: Attachments from an end-to-end encrypted conversation cannot be forwarded."
    );
    let (_, page) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!("/api/v1/channels/{}/messages", p.channel),
        None,
    )
    .await;
    let leaked = page
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["content"] == "should not land");
    assert!(!leaked);

    // A server message forwarded into the DM carries its attribution, and no
    // plaintext file lands in the encrypted conversation: the client sends
    // those through its encrypted upload path.
    let upload_id = upload(&p, &p.owner, "plan.txt", b"plain bytes").await;
    let (status, guild_message) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": "server words", "attachment_ids": [upload_id]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{guild_message}");
    let (status, into_dm) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{dm_id}/messages"),
        Some(json!({
            "content": "",
            "e2ee": envelope(2),
            "forwarded_from": {
                "channel_id": p.channel.to_string(),
                "message_id": guild_message["id"]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{into_dm}");
    assert_eq!(into_dm["forwarded_from"]["content"], "server words");
    assert!(
        into_dm["attachments"].as_array().unwrap().is_empty(),
        "{into_dm}"
    );
}

/// A forward between two encrypted conversations keeps its attribution inside
/// the encrypted body. A client that still names the source in plaintext (3.2)
/// gets its message delivered, and the instance stores none of the source.
#[tokio::test]
async fn encrypted_to_encrypted_forwards_store_no_attribution() {
    let p = people("sealedfwd").await;
    let source_dm = 904001_i64;
    paracord_db::dms::create_dm_channel(&p.app.db, source_dm, p.owner_id, p.member_id)
        .await
        .unwrap();
    let (status, source) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{source_dm}/messages"),
        Some(json!({"content": "", "e2ee": envelope(1)})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    let source_id = source["id"].as_str().unwrap().to_string();

    let third = create_authenticated_user_token(
        &p.app.db,
        &p.app.jwt_secret,
        "sealedfwdthird",
        "ThirdPass123!",
    )
    .await
    .unwrap();
    let (_, third_me) = call(&p.app, &third, Method::GET, "/api/v1/users/@me", None).await;
    let third_id: i64 = third_me["id"].as_str().unwrap().parse().unwrap();
    let dest_dm = 904002_i64;
    paracord_db::dms::create_dm_channel(&p.app.db, dest_dm, p.owner_id, third_id)
        .await
        .unwrap();
    let dest_group = 904003_i64;
    paracord_db::dms::create_group_dm_channel(
        &p.app.db,
        dest_group,
        Some("Forward group"),
        p.owner_id,
        &[p.member_id, third_id],
    )
    .await
    .unwrap();
    let group_payload = json!({
        "version": 3,
        "nonce": "bm9uY2Uz",
        "ciphertext": "Y2lwaGVyMw",
        "header": json!({
            "kind": "group_sender_key", "v": 3, "sender_id": p.owner_id.to_string(),
            "epoch": 0, "members": "ab", "sig": "c2ln"
        }).to_string()
    });

    for (dest, payload) in [(dest_dm, envelope(2)), (dest_group, group_payload)] {
        let (status, forwarded) = call(
            &p.app,
            &p.owner,
            Method::POST,
            &format!("/api/v1/channels/{dest}/messages"),
            Some(json!({
                "content": "",
                "e2ee": payload,
                "forwarded_from": {
                    "channel_id": source_dm.to_string(),
                    "message_id": source_id,
                    "content": "plaintext a 3.2 client never sends"
                }
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{forwarded}");
        assert!(forwarded["forwarded_from"].is_null(), "{forwarded}");
        assert!(forwarded["content"].is_null(), "{forwarded}");
        let id: i64 = forwarded["id"].as_str().unwrap().parse().unwrap();
        let stored = paracord_db::messages::get_message(&p.app.db, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.forwarded_from, None);
        // The stored body is the ciphertext the client sent, nothing more.
        let body = stored.content.as_deref().unwrap_or("");
        assert!(!body.contains("plaintext a 3.2 client"), "{body}");
        assert!(!body.contains(&source_id), "{body}");

        // What the other side reads carries no trace of the source either.
        let (status, page) = call(
            &p.app,
            &third,
            Method::GET,
            &format!("/api/v1/channels/{dest}/messages"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        let text = page.to_string();
        assert!(!text.contains(&source_id), "{text}");
        assert!(!text.contains(&source_dm.to_string()), "{text}");
        assert!(!text.contains("plaintext a 3.2 client"), "{text}");
    }

    // The forwarder still has to be able to read the source channel: naming
    // someone else's conversation is refused, not silently accepted.
    let (status, denied) = call(
        &p.app,
        &third,
        Method::POST,
        &format!("/api/v1/channels/{dest_dm}/messages"),
        Some(json!({
            "content": "",
            "e2ee": envelope(3),
            "forwarded_from": {
                "channel_id": source_dm.to_string(),
                "message_id": source_id
            }
        })),
    )
    .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "{status} {denied}"
    );
}

#[tokio::test]
async fn role_mentions_reach_holders_only_when_the_role_can_be_mentioned() {
    let p = people("rolemention").await;
    let bystander = create_authenticated_user_token(
        &p.app.db,
        &p.app.jwt_secret,
        "rolementionbystander",
        "BystanderPass123!",
    )
    .await
    .unwrap();
    let (_, bystander_me) = call(&p.app, &bystander, Method::GET, "/api/v1/users/@me", None).await;
    let bystander_id: i64 = bystander_me["id"].as_str().unwrap().parse().unwrap();
    paracord_db::members::add_member(&p.app.db, bystander_id, p.guild)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&p.app.db, bystander_id, p.guild, p.guild)
        .await
        .unwrap();

    let (status, role) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/guilds/{}/roles", p.guild),
        Some(json!({"name": "Design", "mentionable": true})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{role}");
    let role_id: i64 = role["id"].as_str().unwrap().parse().unwrap();
    paracord_db::roles::add_member_role(&p.app.db, p.member_id, p.guild, role_id)
        .await
        .unwrap();

    let (status, posted) = call(
        &p.app,
        &bystander,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": format!("<@&{role_id}> look")})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{posted}");

    let holder = mention_count(&p, p.member_id).await;
    let other = mention_count(&p, bystander_id).await;
    assert_eq!(holder, 1, "the role holder should be mentioned");
    assert_eq!(other, 0, "someone without the role should not be mentioned");
    let (status, attention) = call(
        &p.app,
        &p.member,
        Method::GET,
        &format!(
            "/api/v1/channels/{}/messages/attention?kind=mention&after=0",
            p.channel
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{attention}");
    assert!(attention["message"]["id"].is_string());

    let (status, quiet) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/guilds/{}/roles", p.guild),
        Some(json!({"name": "Quiet", "mentionable": false})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{quiet}");
    let quiet_id: i64 = quiet["id"].as_str().unwrap().parse().unwrap();
    paracord_db::roles::add_member_role(&p.app.db, p.member_id, p.guild, quiet_id)
        .await
        .unwrap();

    let (status, _) = call(
        &p.app,
        &bystander,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": format!("<@&{quiet_id}> secret")})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(mention_count(&p, p.member_id).await, 1);

    let (status, _) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": format!("<@&{quiet_id}> from the owner")})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(mention_count(&p, p.member_id).await, 2);
}

async fn mention_count(p: &People, user_id: i64) -> i32 {
    paracord_db::read_states::get_read_state(&p.app.db, user_id, p.channel)
        .await
        .unwrap()
        .map_or(0, |row| row.mention_count)
}

/// An anonymous post stays anonymous everywhere a reader can reach it: in a
/// forward, in the media gallery, and in a server search by author.
#[tokio::test]
async fn anonymous_posts_stay_anonymous_in_forwards_gallery_and_search() {
    let p = people("anon").await;
    let (status, features) = call(
        &p.app,
        &p.owner,
        Method::PATCH,
        &format!("/api/v1/channels/{}/features", p.channel),
        Some(json!({"anonymous_posting_enabled": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{features}");

    let upload_id = upload(&p, &p.member, "secret.txt", b"who wrote this").await;
    let (status, posted) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({"content": "an anonymous word", "attachment_ids": [upload_id]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{posted}");
    let posted_id = posted["id"].as_str().unwrap().to_string();
    let member_name = "anonmember";

    // Forwarded by the owner, who could see behind the alias: the stored
    // attribution is what every reader of the destination sees, so it is the alias.
    let (status, forwarded) = call(
        &p.app,
        &p.owner,
        Method::POST,
        &format!("/api/v1/channels/{}/messages", p.channel),
        Some(json!({
            "content": "",
            "forwarded_from": {"channel_id": p.channel.to_string(), "message_id": posted_id}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{forwarded}");
    let attribution = &forwarded["forwarded_from"];
    assert_ne!(
        attribution["author_id"],
        p.member_id.to_string(),
        "{attribution}"
    );
    assert!(
        attribution["author_id"]
            .as_str()
            .unwrap()
            .starts_with("anon:"),
        "{attribution}"
    );
    assert_ne!(attribution["author_name"], member_name, "{attribution}");

    // The gallery names the alias, not the member.
    let (status, gallery) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!("/api/v1/channels/{}/attachments", p.channel),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gallery}");
    let items = gallery["items"].as_array().unwrap();
    let theirs: Vec<&Value> = items
        .iter()
        .filter(|item| item["message_id"] == posted_id)
        .collect();
    assert!(!theirs.is_empty(), "{gallery}");
    for item in theirs {
        assert_ne!(item["author"]["id"], p.member_id.to_string(), "{item}");
        assert_ne!(item["author"]["username"], member_name, "{item}");
    }

    // Searching the server by the member does not tie them to the alias.
    let (status, found) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!(
            "/api/v1/guilds/{}/messages/search?author_id={}",
            p.guild, p.member_id
        ),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["total"], 0, "{found}");
}

#[tokio::test]
async fn a_reminder_on_a_hidden_channel_does_not_reveal_whether_the_message_exists() {
    let p = people("remindhide").await;
    let hidden = send(&p, &p.owner, "owner only").await;
    let hidden_id = hidden["id"].as_str().unwrap();
    // Take the member's view of the channel away.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &p.app.db,
        p.channel,
        p.guild,
        0,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    p.app
        .state
        .permission_cache
        .invalidate_channel(p.channel)
        .await;
    let when = (Utc::now() + Duration::hours(1)).to_rfc3339();
    let (real, _) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &format!(
            "/api/v1/channels/{}/messages/{hidden_id}/reminder",
            p.channel
        ),
        Some(json!({"remind_at": when})),
    )
    .await;
    let (made_up, _) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &format!("/api/v1/channels/{}/messages/1/reminder", p.channel),
        Some(json!({"remind_at": when})),
    )
    .await;
    assert_eq!(real, made_up);
    assert_eq!(real, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_destination_servers_automod_reads_a_forwards_quoted_text() {
    let p = people("fwdmod").await;
    let source = send(&p, &p.member, "a triggerword said elsewhere").await;
    let (status, strict) = call(
        &p.app,
        &p.owner,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Strict"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{strict}");
    let strict_id: i64 = strict["id"].as_str().unwrap().parse().unwrap();
    let (_, channels) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!("/api/v1/guilds/{strict_id}/channels"),
        None,
    )
    .await;
    let strict_channel = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["type"] == 0)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    paracord_db::members::add_member(&p.app.db, p.member_id, strict_id)
        .await
        .unwrap();
    paracord_db::roles::add_member_role(&p.app.db, p.member_id, strict_id, strict_id)
        .await
        .unwrap();
    paracord_db::automod::create_rule(
        &p.app.db,
        912001,
        strict_id,
        "No triggerword",
        p.owner_id,
        1,
        1,
        &json!({"kind":"keyword", "keywords":["triggerword"]}).to_string(),
        &json!([{"kind":"block_message", "reason":"Not here"}]).to_string(),
        true,
        "[]",
        "[]",
    )
    .await
    .unwrap();
    // The owner is exempt from AutoMod; a member forwards it.
    let (status, refused) = call(
        &p.app,
        &p.member,
        Method::POST,
        &format!("/api/v1/channels/{strict_channel}/messages"),
        Some(json!({
            "content": "look at this",
            "forwarded_from": {
                "channel_id": p.channel.to_string(),
                "message_id": source["id"].as_str().unwrap()
            }
        })),
    )
    .await;
    assert_ne!(status, StatusCode::CREATED, "{refused}");
    let (_, history) = call(
        &p.app,
        &p.owner,
        Method::GET,
        &format!("/api/v1/channels/{strict_channel}/messages"),
        None,
    )
    .await;
    assert!(!history.to_string().contains("triggerword"), "{history}");
}

#[tokio::test]
async fn one_person_can_keep_a_hundred_reminders_waiting_and_move_any_of_them() {
    let p = people("remindcap").await;
    let when = (Utc::now() + Duration::hours(2)).to_rfc3339();
    let mut ids = Vec::new();
    for n in 0..101 {
        let message = send(&p, &p.owner, &format!("note {n}")).await;
        ids.push(message["id"].as_str().unwrap().to_string());
    }
    for id in &ids[..100] {
        let (status, body) = call(
            &p.app,
            &p.member,
            Method::PUT,
            &format!("/api/v1/channels/{}/messages/{id}/reminder", p.channel),
            Some(json!({"remind_at": when})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &format!(
            "/api/v1/channels/{}/messages/{}/reminder",
            p.channel, ids[100]
        ),
        Some(json!({"remind_at": when})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Moving one that is already waiting is not a new reminder.
    let later = (Utc::now() + Duration::hours(3)).to_rfc3339();
    let (status, body) = call(
        &p.app,
        &p.member,
        Method::PUT,
        &format!(
            "/api/v1/channels/{}/messages/{}/reminder",
            p.channel, ids[0]
        ),
        Some(json!({"remind_at": later})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, listed) = call(
        &p.app,
        &p.member,
        Method::GET,
        "/api/v1/users/@me/reminders",
        None,
    )
    .await;
    assert_eq!(
        listed["items"].as_array().map(Vec::len),
        Some(100),
        "{listed}"
    );
}
