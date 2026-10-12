//! Link previews are a per-user setting plus a server gate (setup spec §8.3):
//! the server fetches a link only when `[link_previews] enabled` and the
//! author's own `link_previews` are both on.

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::json;

#[tokio::test]
async fn link_previews_setting_round_trips_and_gates_the_fetch() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "previews", "Correct-Horse-1")
            .await?;

    // Never changed: on, and the server offers them.
    let (status, me) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{me}");
    let user_id: i64 = me["id"].as_str().expect("id").parse()?;

    let (status, settings) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            "/api/v1/users/@me/settings",
            None,
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["link_previews"], true);
    assert_eq!(settings["link_previews_available"], true);
    assert!(paracord_api::opengraph::previews_allowed(&app.state, user_id).await?);

    // Off: stored, echoed, and the fetch is refused for this author.
    let (status, settings) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({ "link_previews": false })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["link_previews"], false);
    assert!(!paracord_api::opengraph::previews_allowed(&app.state, user_id).await?);

    // An unrelated PATCH leaves it off.
    let (_, settings) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({ "theme": "dark" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(settings["link_previews"], false);

    // Back on.
    let (_, settings) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({ "link_previews": true })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(settings["link_previews"], true);
    assert!(paracord_api::opengraph::previews_allowed(&app.state, user_id).await?);

    // The server gate wins over a person who has them on.
    let mut gated = app.state.clone();
    gated.config.link_previews_enabled = false;
    assert!(!paracord_api::opengraph::previews_allowed(&gated, user_id).await?);
    Ok(())
}

#[tokio::test]
async fn a_patch_before_any_settings_row_creates_one_with_previews_off() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "previews2", "Correct-Horse-1")
            .await?;
    let (status, settings) = dispatch_json(
        &app.app,
        build_json_request(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({ "link_previews": false })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["link_previews"], false);
    Ok(())
}
