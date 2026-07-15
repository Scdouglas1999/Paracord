mod common;

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Minimal 1x1 PNG.
const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

async fn dispatch_multipart(
    app: &axum::Router,
    path: &str,
    field_name: &str,
    filename: &str,
    content_type: &str,
    data: &[u8],
    token: &str,
) -> anyhow::Result<(StatusCode, Value)> {
    let boundary = "----paracord-avatar-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))?;

    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let body_bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body_bytes)
            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&body_bytes) }))
    };
    Ok((status, payload))
}

#[tokio::test]
async fn roles_visibility_allowed_roles_round_trip() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "owner",
        "OwnerPass123!",
    )
    .await?;

    let (status, created) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Roles Space" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let guild_id = created["id"].as_str().expect("guild id").to_string();

    let (status, role) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "VIP" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{role}");
    let role_id = role["id"].as_str().expect("role id").to_string();

    let (status, updated) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({
                "visibility": "roles",
                "allowed_roles": [role_id],
            })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["visibility"], "roles");
    assert_eq!(updated["allowed_roles"], json!([role_id]));

    let (status, fetched) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}"),
            None,
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{fetched}");
    assert_eq!(fetched["allowed_roles"], json!([role_id]));

    Ok(())
}

#[tokio::test]
async fn roles_visibility_cannot_be_enabled_without_effective_roles() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "visibility-owner",
        "OwnerPass123!",
    )
    .await?;
    let (status, created) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "No Roles Gate" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let guild_id = created["id"].as_str().expect("guild id");

    let (status, rejected) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "visibility": "roles" })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "empty role gate opened: {rejected}"
    );
    Ok(())
}

#[tokio::test]
async fn presence_status_settings_round_trip() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "presence",
        "PresencePass123!",
    )
    .await?;

    let (status, patched) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({
                "status": "dnd",
                "custom_status": "heads down",
            })),
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["status"], "dnd");
    assert_eq!(patched["custom_status"], "heads down");

    let (status, got) = dispatch_json(
        &test_app.app,
        build_json_request(
            Method::GET,
            "/api/v1/users/@me/settings",
            None,
            Some(&token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{got}");
    assert_eq!(got["status"], "dnd");
    assert_eq!(got["custom_status"], "heads down");

    Ok(())
}

#[tokio::test]
async fn avatar_upload_stores_api_path() -> anyhow::Result<()> {
    let test_app = build_test_app(TestAppOptions::default()).await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "avatar",
        "AvatarPass123!",
    )
    .await?;

    let (status, uploaded) = dispatch_multipart(
        &test_app.app,
        "/api/v1/users/@me/avatar",
        "avatar",
        "avatar.png",
        "image/png",
        TINY_PNG,
        &token,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    let avatar_hash = uploaded["avatar_hash"]
        .as_str()
        .expect("avatar_hash")
        .to_string();
    assert!(
        avatar_hash.starts_with("/api/v1/users/") && avatar_hash.ends_with("/avatar"),
        "expected API path avatar_hash, got {avatar_hash}"
    );

    let (status, me) = dispatch_json(
        &test_app.app,
        build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token))?,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["avatar_hash"], avatar_hash);

    Ok(())
}
