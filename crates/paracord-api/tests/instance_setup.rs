//! First-owner claim: the bootstrap path an unclaimed instance must take.
//!
//! Every test here runs against SQLite by default and against a real
//! PostgreSQL server when `PARACORD_TEST_POSTGRES_URL` is set, because the
//! setup row, the seal migration and the claim's rollback all touch engine
//! behavior (`rows_affected` on a conditional UPDATE, `CASE`-typed inserts,
//! cascading deletes) that in-memory SQLite cannot prove on its own.

mod common;

use axum::http::{Method, StatusCode};
use chrono::Utc;
use common::{build_json_request, build_test_app, dispatch_json, TestApp, TestAppOptions};
use serde_json::{json, Value};

const CLAIM_TOKEN: &str = "TESTCLAIMTOKEN0123456789ABCDEFGHJKMNPQRSTVWXYZ234567";
const OWNER_PASSWORD: &str = "Ownerpass123!";
const MEMBER_PASSWORD: &str = "Memberpass123!";

/// A migrated but unclaimed instance, with the bootstrap token provisioned the
/// way server startup provisions it.
async fn pending_app() -> anyhow::Result<TestApp> {
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await?;
    provision_token(&app, CLAIM_TOKEN).await?;
    Ok(app)
}

async fn provision_token(app: &TestApp, token: &str) -> anyhow::Result<()> {
    let hash = paracord_core::instance_setup::hash_claim_token(token);
    let stored = paracord_db::instance_setup::set_claim_token(
        &app.db,
        &hash,
        paracord_db::instance_setup::TOKEN_SOURCE_CONFIG,
        Utc::now(),
    )
    .await?;
    assert!(stored, "a pending instance must accept a claim token");
    Ok(())
}

fn claim_body(token: &str) -> Value {
    json!({
        "token": token,
        "username": "owner",
        "email": "owner@example.com",
        "password": OWNER_PASSWORD,
        "instance_name": "Riverside",
        "initial_space_name": "The Lounge",
    })
}

async fn setup_status(app: &TestApp) -> anyhow::Result<Value> {
    let (status, body) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, "/api/v1/setup/status", None, None)?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    Ok(body)
}

async fn user_count(app: &TestApp) -> anyhow::Result<i64> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Pending instance
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fresh_instance_reports_setup_required_and_refuses_registration() -> anyhow::Result<()> {
    let app = pending_app().await?;

    let status = setup_status(&app).await?;
    assert_eq!(status["setup_required"], json!(true));
    // Nothing about the bootstrap credential may reach an anonymous caller.
    assert!(status.get("instance_name").is_none());
    let serialized = status.to_string();
    assert!(!serialized.contains(CLAIM_TOKEN));
    assert!(!serialized.to_lowercase().contains("token"));

    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": "stranger@example.com",
                "username": "stranger",
                "password": MEMBER_PASSWORD,
            })),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(body["code"], json!("CONFLICT"));
    let message = body["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("has not been set up"),
        "unexpected message: {message}"
    );

    assert_eq!(user_count(&app).await?, 0, "no account may be created");
    Ok(())
}

#[tokio::test]
async fn wrong_token_is_rejected_and_eventually_rate_limited() -> anyhow::Result<()> {
    let app = pending_app().await?;

    // The guard locks at five failures; the first four must answer 401 so a
    // genuine typo is distinguishable from a throttle.
    for attempt in 0..4 {
        let (code, _) = dispatch_json(
            &app.app,
            build_json_request(
                Method::POST,
                "/api/v1/setup/claim",
                Some(claim_body(
                    "WRONGTOKENWRONGTOKENWRONGTOKENWRONGTOKENWRONGTOKEN00",
                )),
                None,
            )?,
        )
        .await?;
        assert_eq!(code, StatusCode::UNAUTHORIZED, "attempt {attempt}");
    }

    // Fifth failure arms the lockout; the sixth request is refused before the
    // token is even compared.
    let (code, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(
                "WRONGTOKENWRONGTOKENWRONGTOKENWRONGTOKENWRONGTOKEN00",
            )),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::UNAUTHORIZED);

    let (code, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(
        code,
        StatusCode::TOO_MANY_REQUESTS,
        "a locked guard must refuse even the correct token"
    );

    // A rejected attempt is recorded for the operator to find.
    let events = paracord_db::security_events::list_events(&app.db, None, None, 50).await?;
    assert!(
        events
            .iter()
            .any(|e| e.action == "instance.setup.claim.rejected"),
        "a rejected claim must be audited"
    );

    assert!(paracord_db::instance_setup::is_pending(&app.db).await?);
    assert_eq!(user_count(&app).await?, 0);
    Ok(())
}

#[tokio::test]
async fn pending_instance_without_a_token_refuses_to_be_claimed() -> anyhow::Result<()> {
    // No `provision_token`: a server whose startup never minted a token must
    // say so rather than accept an arbitrary string.
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await?;

    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    let message = body["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("no setup claim token"),
        "unexpected message: {message}"
    );
    assert_eq!(user_count(&app).await?, 0);
    Ok(())
}

// ---------------------------------------------------------------------------
// The claim itself
// ---------------------------------------------------------------------------

#[tokio::test]
async fn correct_token_creates_the_owner_and_the_first_space() -> anyhow::Result<()> {
    let app = pending_app().await?;

    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED, "claim failed: {body}");

    // Same session shape registration returns, so the client lands signed in.
    assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
    assert_eq!(body["user"]["username"], json!("owner"));
    assert_eq!(body["instance_name"], json!("Riverside"));
    assert_eq!(body["space"]["name"], json!("The Lounge"));

    let owner_id: i64 = body["user"]["id"].as_str().unwrap().parse()?;
    let owner = paracord_db::users::get_user_by_id(&app.db, owner_id)
        .await?
        .expect("owner row");
    assert!(
        paracord_core::is_admin(owner.flags),
        "the claiming account must own the instance"
    );

    // The first space exists, is owned by the claimer, and was seeded with the
    // same default channels every other space gets.
    let space_id: i64 = body["space"]["id"].as_str().unwrap().parse()?;
    let space = paracord_db::guilds::get_guild(&app.db, space_id)
        .await?
        .expect("space row");
    assert_eq!(space.owner_id, owner_id);
    let channels = paracord_db::channels::get_guild_channels(&app.db, space_id).await?;
    assert!(
        channels
            .iter()
            .any(|c| c.name.as_deref() == Some("general")),
        "default text channel missing: {:?}",
        channels.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        paracord_db::members::get_member_count(&app.db, space_id).await?,
        1
    );

    // Setup is complete and the bootstrap credential is spent.
    let row = paracord_db::instance_setup::get(&app.db).await?;
    assert!(!row.is_pending());
    assert_eq!(row.claimed_by_user_id, Some(owner_id));
    assert_eq!(row.instance_name.as_deref(), Some("Riverside"));
    assert_eq!(
        row.completed_via.as_deref(),
        Some(paracord_db::instance_setup::COMPLETED_VIA_CLAIM)
    );
    assert!(row.claim_token_hash.is_none(), "token must be single use");

    let status = setup_status(&app).await?;
    assert_eq!(status["setup_required"], json!(false));
    assert_eq!(status["instance_name"], json!("Riverside"));

    // The claim is audited against the account it created.
    let events = paracord_db::security_events::list_events(&app.db, None, None, 50).await?;
    assert!(events.iter().any(|e| e.action == "instance.setup.claimed"));
    Ok(())
}

#[tokio::test]
async fn a_second_claim_is_refused_and_ordinary_members_are_not_owners() -> anyhow::Result<()> {
    let app = pending_app().await?;
    let (code, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED);

    // Replaying the same token against a claimed instance is a conflict, not a
    // second owner.
    let mut second = claim_body(CLAIM_TOKEN);
    second["username"] = json!("usurper");
    second["email"] = json!("usurper@example.com");
    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, "/api/v1/setup/claim", Some(second), None)?,
    )
    .await?;
    assert_eq!(code, StatusCode::CONFLICT);
    assert!(body["message"]
        .as_str()
        .unwrap_or_default()
        .contains("already been set up"));

    // Registration reopens once setup is complete, and the account it creates
    // is a community member, not a second operator.
    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": "member@example.com",
                "username": "member",
                "password": MEMBER_PASSWORD,
            })),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED, "registration failed: {body}");
    let member_id: i64 = body["user"]["id"].as_str().unwrap().parse()?;
    let member = paracord_db::users::get_user_by_id(&app.db, member_id)
        .await?
        .expect("member row");
    assert!(
        !paracord_core::is_admin(member.flags),
        "a member who joins after setup must not be an administrator"
    );
    Ok(())
}

#[tokio::test]
async fn claim_reuses_the_registration_password_rules() -> anyhow::Result<()> {
    let app = pending_app().await?;

    // Long enough for the advertised minimum, but missing the character classes
    // the server also enforces. The claim page must reject it for the same
    // reason, with the same message, as the registration page.
    let mut weak = claim_body(CLAIM_TOKEN);
    weak["password"] = json!("alllowercase");
    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, "/api/v1/setup/claim", Some(weak), None)?,
    )
    .await?;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(body["message"]
        .as_str()
        .unwrap_or_default()
        .contains("Password"));
    assert_eq!(user_count(&app).await?, 0);
    assert!(paracord_db::instance_setup::is_pending(&app.db).await?);

    // The page's published rules come from the server, unauthenticated.
    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            "/api/v1/setup/password-requirements",
            None,
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["min_length"], json!(10));
    assert_eq!(body["max_length"], json!(128));
    assert_eq!(body["requires_symbol"], json!(true));
    assert_eq!(body["requires_uppercase"], json!(true));
    assert_eq!(body["requires_digit"], json!(true));

    // ...and the token still works afterwards: a rejected attempt must not burn
    // the operator's one bootstrap credential.
    let (code, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED);
    Ok(())
}

#[tokio::test]
async fn a_failure_after_the_owner_exists_leaves_no_account_behind() -> anyhow::Result<()> {
    let app = pending_app().await?;

    // The space icon is validated inside space creation — after the owner row
    // has already committed. That is the real ordering, so it is the honest way
    // to prove the compensating rollback rather than a test-only hook.
    let mut body = claim_body(CLAIM_TOKEN);
    body["initial_space_icon"] = json!("x".repeat(256 * 1024 + 1));
    let (code, response) = dispatch_json(
        &app.app,
        build_json_request(Method::POST, "/api/v1/setup/claim", Some(body), None)?,
    )
    .await?;
    assert_eq!(code, StatusCode::BAD_REQUEST, "unexpected: {response}");

    assert_eq!(
        user_count(&app).await?,
        0,
        "a failed claim must not leave a half-built owner behind"
    );
    let (spaces,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM spaces")
        .fetch_one(&app.db)
        .await?;
    assert_eq!(spaces, 0);

    let row = paracord_db::instance_setup::get(&app.db).await?;
    assert!(
        row.is_pending(),
        "setup must stay open after a failed claim"
    );
    assert!(
        row.claim_token_hash.is_some(),
        "the bootstrap token must survive a failed claim so the operator can retry"
    );

    // The retry produces a genuine administrator, which is only true if the
    // rolled-back attempt also released the first-admin slot it consumed.
    let (code, response) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED, "retry failed: {response}");
    let owner_id: i64 = response["user"]["id"].as_str().unwrap().parse()?;
    let owner = paracord_db::users::get_user_by_id(&app.db, owner_id)
        .await?
        .expect("owner row");
    assert!(
        paracord_core::is_admin(owner.flags),
        "the retried claim must still produce an administrator"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Durability: upgrades, owner deletion, restarts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_migration_seals_a_populated_database_as_complete() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await?;

    // Rewind to a pre-`instance_setup` database that already has members, then
    // replay the migration exactly as an upgrade would.
    sqlx::query("DROP TABLE instance_setup")
        .execute(&app.db)
        .await?;
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 20260912000001")
        .execute(&app.db)
        .await?;
    let password_hash = paracord_core::auth::hash_password(OWNER_PASSWORD)?;
    paracord_db::users::create_user_as_first_admin(
        &app.db,
        4242,
        "existingowner",
        0,
        "existing@example.com",
        &password_hash,
        paracord_core::USER_FLAG_ADMIN,
    )
    .await?;

    paracord_db::run_migrations(&app.db).await?;

    let row = paracord_db::instance_setup::get(&app.db).await?;
    assert!(
        !row.is_pending(),
        "an installation that already has users must never be asked to set itself up again"
    );
    assert_eq!(
        row.completed_via.as_deref(),
        Some(paracord_db::instance_setup::COMPLETED_VIA_MIGRATION)
    );
    assert!(row.claim_token_hash.is_none());

    // And the upgraded server keeps behaving exactly as it did before.
    let (code, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/auth/register",
            Some(json!({
                "email": "member@example.com",
                "username": "member",
                "password": MEMBER_PASSWORD,
            })),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED);
    Ok(())
}

#[tokio::test]
async fn deleting_the_owner_does_not_reopen_setup() -> anyhow::Result<()> {
    let app = pending_app().await?;
    let (code, body) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/setup/claim",
            Some(claim_body(CLAIM_TOKEN)),
            None,
        )?,
    )
    .await?;
    assert_eq!(code, StatusCode::CREATED);
    let owner_id: i64 = body["user"]["id"].as_str().unwrap().parse()?;

    // An owner cannot be deleted while they still own a space, so hand the
    // space over the way an operator winding the account down would.
    let space_id: i64 = body["space"]["id"].as_str().unwrap().parse()?;
    paracord_db::guilds::delete_guild(&app.db, space_id).await?;
    paracord_db::users::delete_user(&app.db, owner_id).await?;

    let row = paracord_db::instance_setup::get(&app.db).await?;
    assert!(
        !row.is_pending(),
        "removing the owner must not hand the instance to the next stranger"
    );
    assert_eq!(setup_status(&app).await?["setup_required"], json!(false));

    // And no restart can re-arm a bootstrap credential on a claimed instance.
    let rearmed = paracord_db::instance_setup::set_claim_token(
        &app.db,
        "deadbeef",
        paracord_db::instance_setup::TOKEN_SOURCE_GENERATED,
        Utc::now(),
    )
    .await?;
    assert!(!rearmed);
    assert!(paracord_db::instance_setup::get(&app.db)
        .await?
        .claim_token_hash
        .is_none());
    Ok(())
}

#[tokio::test]
async fn the_token_hash_survives_a_restart() -> anyhow::Result<()> {
    // A file-backed database so the pool can be rebuilt the way a restart
    // rebuilds it, against the same bytes on disk.
    let dir = tempfile::tempdir()?;
    let url = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("restart.sqlite").display()
    );
    if std::env::var("PARACORD_TEST_POSTGRES_URL").is_ok_and(|v| !v.trim().is_empty()) {
        // The PostgreSQL run covers persistence through its own server; this
        // case exists for the default in-memory SQLite configuration.
        return Ok(());
    }

    let pool = paracord_db::create_pool(&url, 1).await?;
    paracord_db::run_migrations(&pool).await?;
    let hash = paracord_core::instance_setup::hash_claim_token(CLAIM_TOKEN);
    assert!(
        paracord_db::instance_setup::set_claim_token(
            &pool,
            &hash,
            paracord_db::instance_setup::TOKEN_SOURCE_GENERATED,
            Utc::now(),
        )
        .await?
    );
    pool.close().await;

    let reopened = paracord_db::create_pool(&url, 1).await?;
    let row = paracord_db::instance_setup::get(&reopened).await?;
    assert!(row.is_pending());
    assert_eq!(row.claim_token_hash.as_deref(), Some(hash.as_str()));
    assert_eq!(
        row.claim_token_source.as_deref(),
        Some(paracord_db::instance_setup::TOKEN_SOURCE_GENERATED)
    );
    assert!(
        paracord_core::instance_setup::claim_token_matches(CLAIM_TOKEN, &hash),
        "the stored hash must still verify the token the operator was shown"
    );
    reopened.close().await;
    Ok(())
}
