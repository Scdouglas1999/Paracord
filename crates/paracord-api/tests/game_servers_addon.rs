//! Game servers add-on against fake game servers on 127.0.0.1: Minecraft Java
//! (TCP), Minecraft Bedrock (UDP), a Valve server with the challenge step and
//! a split player list (UDP), and a plain TCP port. Down after three missed
//! probes and back up again, announced as the game server; one probe shared by
//! every server listing an address; permissions; the ten-server cap; and the
//! local-network switch refusing loopback when it is off.
//!
//! The fakes live on loopback, so each test turns on "Add-ons may reach this
//! instance's local network", as an instance admin with a LAN server would.

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::Context;
use axum::http::{Method, StatusCode};
use axum::Router;
use chrono::Utc;
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_core::feeds::LOCAL_NETWORK_REFUSAL;
use serde_json::{json, Value};

// ── Fake game servers ──────────────────────────────────────────────────────

/// One set of fake servers, on its own thread and runtime so it outlives the
/// test's runtime. `answering` switches every one of them off and on.
#[derive(Clone)]
struct Fakes {
    java: u16,
    bedrock: u16,
    source: u16,
    tcp: u16,
    answering: Arc<AtomicBool>,
    java_hits: Arc<AtomicUsize>,
}

fn varint(out: &mut Vec<u8>, value: i32) {
    let mut value = value as u32;
    loop {
        if value & !0x7f == 0 {
            out.push(value as u8);
            return;
        }
        out.push(((value & 0x7f) as u8) | 0x80);
        value >>= 7;
    }
}

fn java_status_packet() -> Vec<u8> {
    let json = json!({
        "version": { "name": "Paper 1.21.1", "protocol": 767 },
        "players": {
            "max": 20,
            "online": 3,
            "sample": [
                { "name": "mira_builds", "id": "4566e69f-c907-48ee-8d71-d7ba5aa00d20" },
                { "name": "\u{a7}ejonas", "id": "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
                { "name": "ade", "id": "3f1e9a20-0000-4000-8000-000000000003" }
            ]
        },
        "description": { "text": "\u{a7}6Lantern SMP", "extra": ["\n", { "text": "Survival" }] }
    })
    .to_string();
    let mut body = Vec::new();
    varint(&mut body, 0);
    varint(&mut body, json.len() as i32);
    body.extend_from_slice(json.as_bytes());
    let mut framed = Vec::new();
    varint(&mut framed, body.len() as i32);
    framed.extend_from_slice(&body);
    framed
}

fn bedrock_pong() -> Vec<u8> {
    let text =
        "MCPE;Riverbend Bedrock;712;1.21.20;2;10;1325386089232;Riverbend;Survival;1;19132;19133;";
    let mut out = vec![0x1c];
    out.extend_from_slice(&7i64.to_be_bytes());
    out.extend_from_slice(&9i64.to_be_bytes());
    out.extend_from_slice(&paracord_core::game_servers::bedrock::MAGIC);
    out.extend_from_slice(&(text.len() as u16).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    out
}

const CHALLENGE: [u8; 4] = [0x11, 0x22, 0x33, 0x44];

fn a2s_info() -> Vec<u8> {
    let mut out = vec![0xff, 0xff, 0xff, 0xff, 0x49, 17];
    out.extend_from_slice(b"Lantern Works TF2\0ctf_2fort\0tf\0Team Fortress\0");
    out.extend_from_slice(&440u16.to_le_bytes());
    out.extend_from_slice(&[4, 24, 0, b'd', b'l', 0, 1]);
    out.extend_from_slice(b"9357393\0");
    out
}

/// The player list, split in two datagrams.
fn a2s_players_split() -> Vec<Vec<u8>> {
    let mut whole = vec![0xff, 0xff, 0xff, 0xff, 0x44, 4];
    for (index, name) in ["Priya", "Tomas", "", "Lena"].iter().enumerate() {
        whole.push(index as u8);
        whole.extend_from_slice(name.as_bytes());
        whole.push(0);
        whole.extend_from_slice(&5i32.to_le_bytes());
        whole.extend_from_slice(&100.0f32.to_le_bytes());
    }
    let (first, second) = whole.split_at(whole.len() / 2);
    [first, second]
        .iter()
        .enumerate()
        .map(|(number, payload)| {
            let mut out = vec![0xfe, 0xff, 0xff, 0xff];
            out.extend_from_slice(&77i32.to_le_bytes());
            out.push(2);
            out.push(number as u8);
            out.extend_from_slice(&1248u16.to_le_bytes());
            out.extend_from_slice(payload);
            out
        })
        .collect()
}

impl Fakes {
    fn start() -> Self {
        let java = std::net::TcpListener::bind("127.0.0.1:0").expect("bind java");
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").expect("bind tcp");
        let bedrock = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind bedrock");
        let source = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind source");
        for listener in [&java, &tcp] {
            listener.set_nonblocking(true).expect("nonblocking");
        }
        for socket in [&bedrock, &source] {
            socket.set_nonblocking(true).expect("nonblocking");
        }
        let fakes = Fakes {
            java: java.local_addr().unwrap().port(),
            bedrock: bedrock.local_addr().unwrap().port(),
            source: source.local_addr().unwrap().port(),
            tcp: tcp.local_addr().unwrap().port(),
            answering: Arc::new(AtomicBool::new(true)),
            java_hits: Arc::new(AtomicUsize::new(0)),
        };
        let served = fakes.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let java = tokio::net::TcpListener::from_std(java).expect("java");
                let tcp = tokio::net::TcpListener::from_std(tcp).expect("tcp");
                let bedrock = tokio::net::UdpSocket::from_std(bedrock).expect("bedrock");
                let source = tokio::net::UdpSocket::from_std(source).expect("source");

                let java_state = served.clone();
                tokio::spawn(async move {
                    while let Ok((mut socket, _)) = java.accept().await {
                        java_state.java_hits.fetch_add(1, Ordering::SeqCst);
                        if !java_state.answering.load(Ordering::SeqCst) {
                            drop(socket);
                            continue;
                        }
                        tokio::spawn(async move {
                            let mut buf = [0u8; 512];
                            let _ = socket.read(&mut buf).await;
                            let _ = socket.write_all(&java_status_packet()).await;
                        });
                    }
                });
                tokio::spawn(async move {
                    // An open port: accepting is the whole answer.
                    while let Ok((socket, _)) = tcp.accept().await {
                        drop(socket);
                    }
                });
                let bedrock_state = served.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    while let Ok((read, peer)) = bedrock.recv_from(&mut buf).await {
                        if bedrock_state.answering.load(Ordering::SeqCst)
                            && read == 33
                            && buf[0] == 0x01
                        {
                            let _ = bedrock.send_to(&bedrock_pong(), peer).await;
                        }
                    }
                });
                let source_state = served.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    while let Ok((read, peer)) = source.recv_from(&mut buf).await {
                        if !source_state.answering.load(Ordering::SeqCst) {
                            continue;
                        }
                        let packet = &buf[..read];
                        let challenge = |offset: usize| packet.get(offset..offset + 4);
                        let mut replies = Vec::new();
                        if packet.get(4) == Some(&0x54) {
                            if challenge(25) == Some(&CHALLENGE[..]) {
                                replies.push(a2s_info());
                            } else {
                                replies.push(
                                    [&[0xff, 0xff, 0xff, 0xff, 0x41][..], &CHALLENGE].concat(),
                                );
                            }
                        } else if packet.get(4) == Some(&0x55) {
                            if challenge(5) == Some(&CHALLENGE[..]) {
                                // Out of order, to exercise reassembly.
                                replies.extend(a2s_players_split().into_iter().rev());
                            } else {
                                replies.push(
                                    [&[0xff, 0xff, 0xff, 0xff, 0x41][..], &CHALLENGE].concat(),
                                );
                            }
                        }
                        for reply in replies {
                            let _ = source.send_to(&reply, peer).await;
                        }
                    }
                });
                std::future::pending::<()>().await;
            });
        });
        fakes
    }

    fn set_answering(&self, answering: bool) {
        self.answering.store(answering, Ordering::SeqCst);
    }
}

// ── Test context ───────────────────────────────────────────────────────────

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    test_app: TestApp,
    guild_id: String,
    channel_id: String,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        Self::with_owner("gsowner").await
    }

    async fn with_owner(prefix: &str) -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            prefix,
            "IntegrationPass123!",
        )
        .await?;
        let mut ctx = Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            test_app,
            guild_id: String::new(),
            channel_id: String::new(),
        };
        ctx.guild_id = ctx.create_guild("Lantern Works").await?;
        ctx.channel_id = ctx.create_channel(&ctx.guild_id, "status").await?;
        paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "true").await?;
        ctx.enable(&ctx.guild_id).await?;
        Ok(ctx)
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<String> {
        let (status, guild) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild: {guild}");
        Ok(guild["id"].as_str().context("guild id")?.to_string())
    }

    async fn enable(&self, guild_id: &str) -> anyhow::Result<()> {
        let (status, body) = self
            .request(
                Method::PUT,
                &format!("/api/v1/guilds/{guild_id}/game-servers/settings"),
                Some(json!({ "enabled": true })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "enable: {body}");
        Ok(())
    }

    async fn request_as(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_as(method, path, body, &self.token).await
    }

    async fn create_channel(&self, guild_id: &str, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({
                    "name": name,
                    "channel_type": 0,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "channel: {payload}");
        Ok(payload["id"].as_str().context("channel id")?.to_string())
    }

    fn path(&self) -> String {
        format!("/api/v1/guilds/{}/game-servers", self.guild_id)
    }

    async fn add(&self, body: Value) -> anyhow::Result<(StatusCode, Value)> {
        self.request(Method::POST, &self.path(), Some(body)).await
    }

    async fn add_ok(&self, body: Value) -> anyhow::Result<Value> {
        let (status, created) = self.add(body).await?;
        assert_eq!(status, StatusCode::CREATED, "add: {created}");
        Ok(created)
    }

    async fn list(&self) -> anyhow::Result<Value> {
        let (status, body) = self.request(Method::GET, &self.path(), None).await?;
        assert_eq!(status, StatusCode::OK, "list: {body}");
        Ok(body)
    }

    /// Make every target due and run one poller pass.
    async fn poll(&self) -> anyhow::Result<()> {
        sqlx::query("UPDATE game_server_targets SET next_check_at = $1")
            .bind("2000-01-01 00:00:00")
            .execute(&self.db)
            .await?;
        paracord_api::routes::game_servers_poll::poll_due_at(&self.test_app.state, Utc::now())
            .await;
        Ok(())
    }

    async fn messages(&self) -> anyhow::Result<Vec<Value>> {
        let (status, body) = self
            .request(
                Method::GET,
                &format!("/api/v1/channels/{}/messages?limit=50", self.channel_id),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "messages: {body}");
        let mut messages = body.as_array().cloned().unwrap_or_default();
        messages.sort_by_key(|message| {
            message["id"]
                .as_str()
                .and_then(|id| id.parse::<i64>().ok())
                .unwrap_or_default()
        });
        Ok(messages)
    }

    async fn member(&self, prefix: &str) -> anyhow::Result<String> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let (_, me) = self
            .request_as(Method::GET, "/api/v1/users/@me", None, &token)
            .await?;
        let uid = me["id"].as_str().context("uid")?.parse::<i64>()?;
        let guild = self.guild_id.parse::<i64>()?;
        paracord_db::members::add_member(&self.db, uid, guild).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild, guild).await?;
        Ok(token)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn every_protocol_reads_its_fake_server() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();

    let (status, preview) = ctx
        .request(
            Method::POST,
            &format!("{}/preview", ctx.path()),
            Some(
                json!({ "kind": "minecraft_java", "address": format!("127.0.0.1:{}", fakes.java) }),
            ),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["online"], true);
    assert_eq!(preview["name"], "Lantern SMP");
    assert_eq!(preview["players_online"], 3);

    let java = ctx
        .add_ok(json!({ "kind": "minecraft_java", "address": format!("127.0.0.1:{}", fakes.java) }))
        .await?;
    assert_eq!(
        java["name"], "Lantern SMP",
        "the server's own name by default"
    );
    assert_eq!(java["address"], format!("127.0.0.1:{}", fakes.java));
    assert_eq!(java["status"]["state"], "up");
    assert_eq!(java["status"]["players_max"], 20);
    assert_eq!(java["status"]["version"], "Paper 1.21.1");
    assert_eq!(java["status"]["motd"], "Lantern SMP\nSurvival");
    assert_eq!(
        java["status"]["player_names"],
        json!(["mira_builds", "jonas", "ade"])
    );

    let bedrock = ctx
        .add_ok(json!({
            "kind": "minecraft_bedrock",
            "address": format!("127.0.0.1:{}", fakes.bedrock),
            "name": "Riverbend",
        }))
        .await?;
    assert_eq!(bedrock["name"], "Riverbend");
    assert_eq!(bedrock["status"]["state"], "up");
    assert_eq!(bedrock["status"]["players_online"], 2);
    assert_eq!(bedrock["status"]["map"], "Riverbend");
    assert_eq!(bedrock["status"]["player_names"], Value::Null);

    let source = ctx
        .add_ok(json!({ "kind": "source", "address": format!("127.0.0.1:{}", fakes.source) }))
        .await?;
    assert_eq!(source["name"], "Lantern Works TF2");
    assert_eq!(source["status"]["state"], "up");
    assert_eq!(source["status"]["map"], "ctf_2fort");
    assert_eq!(source["status"]["players_online"], 4);
    assert_eq!(source["status"]["players_max"], 24);
    assert_eq!(
        source["status"]["player_names"],
        json!(["Priya", "Tomas", "Lena"]),
        "challenge followed, split reply reassembled, the unnamed player skipped"
    );

    let tcp = ctx
        .add_ok(json!({ "kind": "tcp", "address": format!("127.0.0.1:{}", fakes.tcp), "name": "Satisfactory" }))
        .await?;
    assert_eq!(tcp["status"]["state"], "up");
    assert!(tcp["status"]["latency_ms"].is_number());

    let list = ctx.list().await?;
    assert_eq!(list["enabled"], true);
    assert_eq!(list["can_manage"], true);
    assert_eq!(list["limit"], 10);
    assert_eq!(list["servers"].as_array().map(Vec::len), Some(4));
    Ok(())
}

#[tokio::test]
async fn a_server_that_is_not_answering_can_still_be_added() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let closed = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = closed.local_addr()?.port();
    drop(closed);

    let (status, preview) = ctx
        .request(
            Method::POST,
            &format!("{}/preview", ctx.path()),
            Some(json!({ "kind": "tcp", "address": format!("127.0.0.1:{port}") })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["online"], false);
    assert_eq!(
        preview["error"],
        "Nothing is accepting connections on that port."
    );

    let added = ctx
        .add_ok(json!({ "kind": "tcp", "address": format!("127.0.0.1:{port}") }))
        .await?;
    assert_eq!(added["name"], format!("127.0.0.1:{port}"));
    assert_eq!(added["status"]["state"], "down");
    assert_eq!(
        added["status"]["error"],
        "Nothing is accepting connections on that port."
    );
    Ok(())
}

#[tokio::test]
async fn down_after_three_missed_checks_and_back_up_are_announced_once() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    let created = ctx
        .add_ok(json!({
            "kind": "minecraft_java",
            "address": format!("127.0.0.1:{}", fakes.java),
            "name": "Lantern SMP",
            "announce_channel_id": ctx.channel_id,
        }))
        .await?;
    assert_eq!(created["announce_channel_id"], ctx.channel_id.as_str());
    ctx.poll().await?;
    assert!(ctx.messages().await?.is_empty(), "no change, no post");

    fakes.set_answering(false);
    ctx.poll().await?;
    ctx.poll().await?;
    let list = ctx.list().await?;
    assert_eq!(
        list["servers"][0]["status"]["state"], "up",
        "two missed checks are not an outage"
    );
    assert!(ctx.messages().await?.is_empty());

    ctx.poll().await?;
    let list = ctx.list().await?;
    assert_eq!(list["servers"][0]["status"]["state"], "down");
    assert_eq!(list["servers"][0]["status"]["players_online"], Value::Null);
    assert!(list["servers"][0]["status"]["last_seen_online"].is_string());
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0]["content"],
        "Lantern SMP is down. It hasn't answered the last 3 checks."
    );
    assert_eq!(messages[0]["author"]["username"], "Lantern SMP");
    assert_eq!(messages[0]["author"]["bot"], true);
    assert_eq!(messages[0]["feed"]["kind"], "game_server");
    assert_eq!(messages[0]["feed"]["name"], "Lantern SMP");

    ctx.poll().await?;
    assert_eq!(ctx.messages().await?.len(), 1, "down is said once");

    fakes.set_answering(true);
    ctx.poll().await?;
    let messages = ctx.messages().await?;
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[1]["content"],
        "Lantern SMP is back up, with 3 of 20 players online."
    );
    ctx.poll().await?;
    assert_eq!(ctx.messages().await?.len(), 2, "up is said once");

    // Announcements are not front-page news.
    let (status, feed) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/guilds/{}/feed", ctx.guild_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{feed}");
    assert!(!feed.to_string().contains("Lantern SMP is"), "{feed}");
    Ok(())
}

#[tokio::test]
async fn servers_listing_the_same_address_share_one_probe() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    let address = format!("127.0.0.1:{}", fakes.java);
    ctx.add_ok(json!({ "kind": "minecraft_java", "address": address }))
        .await?;
    let other = ctx.create_guild("Second Server").await?;
    ctx.enable(&other).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{other}/game-servers"),
            Some(json!({ "kind": "minecraft_java", "address": address })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let targets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_server_targets")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(targets, 1);

    let before = fakes.java_hits.load(Ordering::SeqCst);
    ctx.poll().await?;
    assert_eq!(fakes.java_hits.load(Ordering::SeqCst) - before, 1);

    // Removing one keeps the shared target; removing both drops it.
    let first = ctx.list().await?["servers"][0]["id"]
        .as_str()
        .context("id")?
        .to_string();
    let (status, _) = ctx
        .request(Method::DELETE, &format!("{}/{first}", ctx.path()), None)
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let targets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_server_targets")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(targets, 1);
    let second = body["id"].as_str().context("id")?;
    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/guilds/{other}/game-servers/{second}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let targets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_server_targets")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(targets, 0);
    Ok(())
}

#[tokio::test]
async fn private_addresses_are_refused_while_the_switch_is_off() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "false").await?;
    for (kind, address) in [
        ("minecraft_java", format!("127.0.0.1:{}", fakes.java)),
        ("minecraft_bedrock", format!("localhost:{}", fakes.bedrock)),
        ("source", "192.168.1.20".to_string()),
        ("tcp", "[::1]:22".to_string()),
    ] {
        let (status, body) = ctx.add(json!({ "kind": kind, "address": address })).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{kind} {address}: {body}");
        assert!(
            body.to_string()
                .contains(&LOCAL_NETWORK_REFUSAL.replace('"', "\\\"")),
            "{body}"
        );
    }
    // Link-local stays closed even with the switch on.
    paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "true").await?;
    let (status, body) = ctx
        .add(json!({ "kind": "tcp", "address": "169.254.169.254:80" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("never reach"), "{body}");
    let (status, body) = ctx
        .add(json!({ "kind": "tcp", "address": "example.com" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("Add the port"), "{body}");

    // A listing added while the switch was on stops answering when it goes off.
    let added = ctx
        .add_ok(json!({ "kind": "minecraft_java", "address": format!("127.0.0.1:{}", fakes.java) }))
        .await?;
    assert_eq!(added["status"]["state"], "up");
    paracord_db::server_settings::set_setting(&ctx.db, "addons_local_network", "false").await?;
    ctx.poll().await?;
    assert_eq!(fakes.java_hits.load(Ordering::SeqCst), 1, "no packet sent");
    let list = ctx.list().await?;
    assert_eq!(list["servers"][0]["status"]["error"], LOCAL_NETWORK_REFUSAL);
    Ok(())
}

#[tokio::test]
async fn members_read_managers_write() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    ctx.add_ok(json!({
        "kind": "minecraft_java",
        "address": format!("127.0.0.1:{}", fakes.java),
        "announce_channel_id": ctx.channel_id,
    }))
    .await?;
    let member = ctx.member("gsmember").await?;
    let (status, list) = ctx
        .request_as(Method::GET, &ctx.path(), None, &member)
        .await?;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["can_manage"], false);
    assert_eq!(list["servers"][0]["status"]["state"], "up");
    assert!(
        list["servers"][0].get("announce_channel_id").is_none(),
        "announcement settings are for managers"
    );
    let (status, _) = ctx
        .request_as(
            Method::POST,
            &ctx.path(),
            Some(json!({ "kind": "tcp", "address": "example.com:80" })),
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = ctx
        .request_as(
            Method::PUT,
            &format!("{}/settings", ctx.path()),
            Some(json!({ "enabled": false })),
            &member,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Someone outside the server sees nothing.
    let stranger =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "gsstranger", "Stranger123!")
            .await?;
    let (status, _) = ctx
        .request_as(Method::GET, &ctx.path(), None, &stranger)
        .await?;
    assert!(status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND);

    // Off: members see an empty list, the manager keeps theirs.
    let (status, _) = ctx
        .request(
            Method::PUT,
            &format!("{}/settings", ctx.path()),
            Some(json!({ "enabled": false })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = ctx
        .request_as(Method::GET, &ctx.path(), None, &member)
        .await?;
    assert_eq!(list["enabled"], false);
    assert_eq!(list["servers"], json!([]));
    assert_eq!(
        ctx.list().await?["servers"].as_array().map(Vec::len),
        Some(1)
    );
    let (status, body) = ctx
        .add(json!({ "kind": "tcp", "address": "example.com:80" }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("not turned on"), "{body}");
    Ok(())
}

#[tokio::test]
async fn editing_moves_names_and_stops_announcing() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    let created = ctx
        .add_ok(json!({
            "kind": "minecraft_java",
            "address": format!("127.0.0.1:{}", fakes.java),
            "announce_channel_id": ctx.channel_id,
        }))
        .await?;
    let id = created["id"].as_str().context("id")?;
    let (status, updated) = ctx
        .request(
            Method::PATCH,
            &format!("{}/{id}", ctx.path()),
            Some(json!({ "name": "The SMP", "announce_channel_id": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "The SMP");
    assert_eq!(updated["announce_channel_id"], Value::Null);

    let (status, moved) = ctx
        .request(
            Method::PATCH,
            &format!("{}/{id}", ctx.path()),
            Some(json!({ "kind": "source", "address": format!("127.0.0.1:{}", fakes.source) })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["kind"], "source");
    assert_eq!(moved["status"]["map"], "ctf_2fort");
    assert_eq!(moved["name"], "The SMP", "the name stays");
    let targets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_server_targets")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(targets, 1, "the old target is gone");

    let (status, body) = ctx
        .request(
            Method::PATCH,
            &format!("{}/{id}", ctx.path()),
            Some(json!({ "name": "<b>" })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_server_lists_at_most_ten() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let fakes = Fakes::start();
    for index in 0..10 {
        ctx.add_ok(json!({
            "kind": "tcp",
            "address": format!("127.0.0.1:{}", fakes.tcp),
            "name": format!("Server {index}"),
        }))
        .await?;
    }
    let (status, body) = ctx
        .add(json!({ "kind": "tcp", "address": format!("127.0.0.1:{}", fakes.tcp) }))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.to_string().contains("at most 10"), "{body}");
    Ok(())
}

#[tokio::test]
async fn the_home_page_can_list_the_widget() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, body) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{}", ctx.guild_id),
            Some(json!({ "hub_settings": { "widgets": [
                { "id": "game_servers", "enabled": true },
                { "id": "coming_up", "enabled": false }
            ] } })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}
