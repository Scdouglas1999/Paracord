//! Invite preview (setup-spec §6.1, §6.3): the fields a joining client sees
//! before it has an account, what must stay out of them, and the creation
//! defaults.

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

const USER_FLAG_BOT: i32 = 1 << 1;
const PALETTE: [i64; 11] = [350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226];

async fn call(
    app: &TestApp,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    dispatch_json(&app.app, build_json_request(method, path, body, token)?).await
}

struct Person {
    id: i64,
    username: String,
    token: String,
}

async fn person(app: &TestApp, display_name: &str) -> anyhow::Result<Person> {
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "ivp", "PreviewPass123!").await?;
    let (status, me) = call(app, Some(&token), Method::GET, "/api/v1/users/@me", None).await?;
    assert_eq!(status, StatusCode::OK, "{me}");
    let id: i64 = me["id"].as_str().unwrap().parse()?;
    let username = me["username"].as_str().unwrap().to_string();
    paracord_db::users::update_user(&app.db, id, Some(display_name), None, None).await?;
    Ok(Person {
        id,
        username,
        token,
    })
}

async fn join(app: &TestApp, guild_id: i64, who: &Person) -> anyhow::Result<()> {
    paracord_db::members::add_member(&app.db, who.id, guild_id).await?;
    app.state.member_index.add_member(guild_id, who.id);
    Ok(())
}

/// A guild with one text channel, owned by `owner`; returns (guild, channel) ids.
async fn guild_of(app: &TestApp, owner: &Person) -> anyhow::Result<(i64, i64)> {
    let (status, guild) = call(
        app,
        Some(&owner.token),
        Method::POST,
        "/api/v1/guilds",
        Some(json!({ "name": "Preview Guild", "icon": Value::Null })),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild_id: i64 = guild["id"].as_str().unwrap().parse()?;
    let (status, channel) = call(
        app,
        Some(&owner.token),
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({ "name": "general", "channel_type": 0, "parent_id": Value::Null, "required_role_ids": Value::Null })),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    Ok((guild_id, channel["id"].as_str().unwrap().parse()?))
}

async fn invite(
    app: &TestApp,
    owner: &Person,
    channel_id: i64,
    body: Value,
) -> anyhow::Result<Value> {
    let (status, invite) = call(
        app,
        Some(&owner.token),
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/invites"),
        Some(body),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{invite}");
    Ok(invite)
}

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[tokio::test]
async fn preview_carries_faces_counts_hue_expiry_and_the_instance_block() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = person(&app, "Olive Ownername").await?;
    let (guild_id, channel_id) = guild_of(&app, &owner).await?;
    paracord_db::guilds::set_space_hue(
        &app.db,
        paracord_models::id::GuildId::from(guild_id),
        Some(214),
    )
    .await?;

    // Joined in this order, so the newest is Dax; Xbot is a bot and joined last.
    let aria = person(&app, "Aria Anderson").await?;
    let bea = person(&app, "Bea Bellamy").await?;
    let cai = person(&app, "Cai Calloway").await?;
    let dax = person(&app, "\u{1F469}\u{1F3FD}\u{200D}\u{1F680} Dax Dalton").await?;
    let bot = person(&app, "Xbot Exampleton").await?;
    paracord_db::users::update_user_flags(&app.db, bot.id, USER_FLAG_BOT).await?;
    for who in [&aria, &bea, &cai, &dax, &bot] {
        join(&app, guild_id, who).await?;
    }
    // Online: Aria and the owner. The bot is online too: it counts as online, but never shows as a face.
    for id in [aria.id, owner.id, bot.id] {
        app.state.online_users.insert(id);
    }

    let code = invite(
        &app,
        &owner,
        channel_id,
        json!({ "max_uses": 5, "max_age": 3600 }),
    )
    .await?["code"]
        .as_str()
        .unwrap()
        .to_string();

    // Public: no token.
    let (status, preview) = call(
        &app,
        None,
        Method::GET,
        &format!("/api/v1/invites/{code}"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");

    assert_eq!(
        keys(&preview),
        ["code", "expires_at", "faces", "guild", "instance"]
    );
    assert_eq!(
        keys(&preview["guild"]),
        [
            "hue",
            "icon_hash",
            "id",
            "member_count",
            "name",
            "online_count"
        ]
    );
    assert_eq!(preview["guild"]["hue"], 214);
    assert_eq!(preview["guild"]["member_count"], 6);
    assert_eq!(preview["guild"]["online_count"], 3, "{preview}"); // presence counts bots, like member_count

    // Online first (newest first), then the newest of the rest, never a bot.
    let faces = preview["faces"].as_array().unwrap();
    let initials: Vec<&str> = faces
        .iter()
        .map(|face| face["initial"].as_str().unwrap())
        .collect();
    assert_eq!(initials, ["A", "O", "\u{1F469}\u{1F3FD}\u{200D}\u{1F680}"]);
    for (face, who) in faces.iter().zip([aria.id, owner.id, dax.id]) {
        assert_eq!(keys(face), ["hue", "initial"]);
        let expected = PALETTE[((who.unsigned_abs() % 1_000_000_000) % 11) as usize];
        assert_eq!(face["hue"], expected);
    }

    // Expiry is the creation time plus max_age.
    let expires = chrono::DateTime::parse_from_rfc3339(preview["expires_at"].as_str().unwrap())?;
    let until = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds();
    assert!((3590..=3600).contains(&until), "expires in {until}s");

    let instance = &preview["instance"];
    assert_eq!(
        keys(instance),
        [
            "credential_version",
            "name",
            "registration_mode",
            "require_email",
            "version"
        ]
    );
    assert_eq!(instance["version"], env!("CARGO_PKG_VERSION"));
    assert!(instance["name"].as_str().is_some_and(|n| !n.is_empty()));
    assert!(matches!(
        instance["registration_mode"].as_str(),
        Some("open" | "invite_only")
    ));

    // Nothing that names a person or points at one: no usernames, no display
    // names, no ids of any member, not even the inviter's.
    let wire = preview.to_string();
    for who in [&owner, &aria, &bea, &cai, &dax, &bot] {
        assert!(!wire.contains(&who.username), "username leaked: {wire}");
        assert!(
            !wire.contains(&who.id.to_string()),
            "user id leaked: {wire}"
        );
    }
    for name in [
        "Ownername",
        "Anderson",
        "Bellamy",
        "Calloway",
        "Dalton",
        "Xbot",
    ] {
        assert!(!wire.contains(name), "{name} leaked: {wire}");
    }
    // The only ids on the card are the guild's.
    assert!(wire.contains(&guild_id.to_string()));
    assert!(!wire.contains(&channel_id.to_string()), "channel id leaked");
    Ok(())
}

#[tokio::test]
async fn preview_of_an_empty_corner_and_a_never_expiring_invite() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = person(&app, "Solo").await?;
    let (_, channel_id) = guild_of(&app, &owner).await?;
    let code = invite(
        &app,
        &owner,
        channel_id,
        json!({ "max_uses": 0, "max_age": 0 }),
    )
    .await?["code"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, preview) = call(
        &app,
        None,
        Method::GET,
        &format!("/api/v1/invites/{code}"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    // `expires_at` is present and null; one member, so one face; nobody online.
    assert!(preview["expires_at"].is_null());
    assert_eq!(preview["faces"].as_array().unwrap().len(), 1);
    assert_eq!(preview["faces"][0]["initial"], "S");
    assert_eq!(preview["guild"]["online_count"], 0);
    Ok(())
}

#[tokio::test]
async fn invites_default_to_seven_days_and_twenty_five_uses() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let owner = person(&app, "Defaults").await?;
    let (_, channel_id) = guild_of(&app, &owner).await?;
    let created = invite(&app, &owner, channel_id, json!({})).await?;
    assert_eq!(created["max_age"], 604_800);
    assert_eq!(created["max_uses"], 25);
    // Explicit values still win, including 0 for "never" and "unlimited".
    let explicit = invite(
        &app,
        &owner,
        channel_id,
        json!({ "max_age": 0, "max_uses": 0 }),
    )
    .await?;
    assert_eq!(explicit["max_age"], 0);
    assert_eq!(explicit["max_uses"], 0);
    Ok(())
}
