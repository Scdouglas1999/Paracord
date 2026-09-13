use axum::response::Html;
use axum::Json;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

const ROUTER_SOURCE: &str = include_str!("../lib.rs");

fn parse_methods(handler_expr: &str) -> Vec<&'static str> {
    let mut methods = Vec::new();
    for method in ["get", "post", "put", "patch", "delete"] {
        if handler_expr.contains(&format!("{method}(")) {
            methods.push(method);
        }
    }
    if handler_expr.contains("any(") {
        for method in ["get", "post", "put", "patch", "delete"] {
            if !methods.contains(&method) {
                methods.push(method);
            }
        }
    }
    methods
}

fn parse_route_table(src: &str) -> Vec<(String, Vec<&'static str>)> {
    let mut routes = Vec::new();
    let mut idx = 0usize;
    let bytes = src.as_bytes();

    while let Some(rel) = src[idx..].find(".route(") {
        idx += rel + ".route(".len();

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b'"' {
            continue;
        }
        idx += 1;
        let path_start = idx;
        while idx < bytes.len() {
            if bytes[idx] == b'\\' {
                idx += 2;
                continue;
            }
            if bytes[idx] == b'"' {
                break;
            }
            idx += 1;
        }
        if idx >= bytes.len() {
            break;
        }
        let path = src[path_start..idx].to_string();
        idx += 1;

        while idx < bytes.len() && bytes[idx] != b',' {
            idx += 1;
        }
        if idx >= bytes.len() {
            break;
        }
        idx += 1;

        let handler_start = idx;
        let mut depth = 1usize;
        while idx < bytes.len() && depth > 0 {
            match bytes[idx] as char {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            idx += 1;
        }
        if depth != 0 || handler_start >= idx {
            break;
        }
        let handler_expr = &src[handler_start..idx.saturating_sub(1)];
        let methods = parse_methods(handler_expr);
        if !methods.is_empty() {
            routes.push((path, methods));
        }
    }

    routes
}

fn infer_rate_limit_tier(path: &str) -> &'static str {
    if path.contains("/auth/") {
        "auth: 60/min"
    } else if path.contains("/bots/") {
        "bot: 300/min"
    } else {
        "global: 120/s"
    }
}

fn operation_id(method: &str, path: &str) -> String {
    let clean_path = path
        .trim_matches('/')
        .replace('/', "_")
        .replace(['{', '}'], "")
        .replace('-', "_");
    format!("{method}_{clean_path}")
}

fn route_uses_bearer_auth(method: &str, path: &str) -> bool {
    if path.contains("/health") || path.contains("/metrics") {
        return false;
    }

    matches!(
        path,
        "/api/v1/auth/attach-public-key"
            | "/api/v1/auth/logout"
            | "/api/v1/auth/sessions"
            | "/api/v1/auth/sessions/{session_id}"
            | "/api/v1/auth/mfa/setup"
            | "/api/v1/auth/mfa/verify"
            | "/api/v1/auth/mfa/disable"
            | "/api/v1/auth/mfa/status"
    ) || !(path.starts_with("/api/v1/auth/")
        || path.starts_with("/api/v1/webhooks/{webhook_id}/{token}")
        || path.starts_with("/api/v1/interactions/{")
        || path.starts_with("/api/v1/discovery/")
        || path == "/api/docs"
        || path == "/api/docs/openapi.json"
        || (method == "get" && path == "/api/v1/invites/{code}")
        || path == "/api/v1/voice/livekit/webhook")
}

fn build_openapi_spec() -> Value {
    let mut paths_obj = Map::new();
    for (path, methods) in parse_route_table(ROUTER_SOURCE) {
        let mut path_item = Map::new();
        let tier = infer_rate_limit_tier(&path);
        let path_params: Vec<String> = path
            .split('/')
            .filter_map(|seg| {
                if seg.starts_with('{') && seg.ends_with('}') && seg.len() > 2 {
                    Some(seg[1..seg.len() - 1].to_string())
                } else {
                    None
                }
            })
            .collect();

        for method in methods {
            let mut parameters = Vec::new();
            for param in &path_params {
                parameters.push(json!({
                    "name": param,
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" },
                }));
            }

            let mut operation = json!({
                "operationId": operation_id(method, &path),
                "x-contract-coverage": "route-inventory",
                "summary": format!("{} {}", method.to_uppercase(), path),
                "responses": {
                    "200": { "description": "Successful response" },
                    "400": { "description": "Bad request" },
                    "401": { "description": "Unauthorized" },
                    "403": { "description": "Forbidden" },
                    "404": { "description": "Not found" },
                    "429": { "description": "Rate limit exceeded" },
                    "500": { "description": "Internal server error" },
                },
                "x-rate-limit-tier": tier,
            });

            if !parameters.is_empty() {
                operation["parameters"] = Value::Array(parameters);
            }

            if ["post", "put", "patch", "delete"].contains(&method) {
                operation["x-write-limit"] =
                    Value::String("write-tier: 5 req/s per user".to_string());
            }
            if route_uses_bearer_auth(method, &path) {
                operation["security"] = json!([{ "bearerAuth": [] }]);
            }

            path_item.insert(method.to_string(), operation);
        }
        paths_obj.insert(path, Value::Object(path_item));
    }

    let mut spec = json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Paracord HTTP API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Axum route inventory with Rust-derived request and response schemas for contracted operations. x-contract-coverage identifies operations still awaiting typed contracts.",
        },
        "servers": [
            { "url": "/", "description": "This server; paths already include the API prefix" }
        ],
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT"
                }
            }
        },
        "paths": paths_obj
    });
    apply_wire_contracts(&mut spec);
    spec
}

/// Embed each complete JSON Schema beneath its own component. Local `$defs`
/// references must be rebased; otherwise a nested settings enum would resolve
/// against the OpenAPI document root and Swagger clients could not use it.
fn rebase_schema_refs(value: &mut Value, component: &str) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get_mut("$ref") {
                if let Some(local) = reference.strip_prefix('#') {
                    *reference = format!("#/components/schemas/{component}{local}");
                }
            }
            for nested in map.values_mut() {
                rebase_schema_refs(nested, component);
            }
        }
        Value::Array(values) => {
            for nested in values {
                rebase_schema_refs(nested, component);
            }
        }
        _ => {}
    }
}

fn apply_wire_contracts(spec: &mut Value) {
    let mut schemas = paracord_contracts::schemas()["schemas"].clone();
    for (name, schema) in schemas.as_object_mut().expect("contract schemas") {
        schema.as_object_mut().expect("schema object").remove("$id");
        rebase_schema_refs(schema, name);
    }
    spec["components"]["schemas"] = schemas;
    // These are the actual handler wire types. Route-presence and response
    // contract tests make drift visible instead of silently inventing a route.
    // `response`/`request` are Option so 204 deletes and multipart uploads can
    // still publish their typed success response.
    for (path, method, status, response, request) in [
        ("/api/v1/users/@me", "get", "200", Some("CurrentUser"), None),
        (
            "/api/v1/users/@me",
            "patch",
            "200",
            Some("UpdatedCurrentUser"),
            Some("UpdateMeRequest"),
        ),
        ("/api/v1/users/@me", "delete", "204", None, None),
        // The request is multipart/form-data, not JSON.
        (
            "/api/v1/users/@me/avatar",
            "post",
            "200",
            Some("UpdatedCurrentUser"),
            None,
        ),
        (
            "/api/v1/users/{user_id}/profile",
            "get",
            "200",
            Some("PublicUserProfile"),
            None,
        ),
        (
            "/api/v1/users/@me/settings",
            "get",
            "200",
            Some("UserSettingsResponse"),
            None,
        ),
        (
            "/api/v1/users/@me/settings",
            "patch",
            "200",
            Some("UserSettingsResponse"),
            Some("UpdateSettingsRequest"),
        ),
        (
            "/api/v1/users/@me/password",
            "put",
            "204",
            None,
            Some("ChangePasswordRequest"),
        ),
        (
            "/api/v1/users/@me/email",
            "put",
            "204",
            None,
            Some("ChangeEmailRequest"),
        ),
        (
            "/api/v1/users/@me/relationships",
            "get",
            "200",
            Some("RelationshipList"),
            None,
        ),
        (
            "/api/v1/users/@me/relationships",
            "post",
            "204",
            None,
            Some("CreateRelationshipRequest"),
        ),
        (
            "/api/v1/users/@me/relationships/{user_id}",
            "put",
            "204",
            None,
            None,
        ),
        (
            "/api/v1/users/@me/relationships/{user_id}",
            "delete",
            "204",
            None,
            None,
        ),
        (
            "/api/v1/channels/{channel_id}/invites",
            "post",
            "201",
            Some("GuildInvite"),
            Some("CreateInviteRequest"),
        ),
        (
            "/api/v1/invites/{code}",
            "get",
            "200",
            Some("InvitePreview"),
            None,
        ),
        ("/api/v1/invites/{code}", "delete", "204", None, None),
        (
            "/api/v1/guilds/{guild_id}/invites",
            "get",
            "200",
            Some("GuildInviteList"),
            None,
        ),
        (
            "/api/v1/guilds/{guild_id}/emojis",
            "get",
            "200",
            Some("GuildEmojiList"),
            None,
        ),
        // The request is multipart/form-data, not JSON.
        (
            "/api/v1/guilds/{guild_id}/emojis",
            "post",
            "201",
            Some("GuildEmoji"),
            None,
        ),
        (
            "/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
            "patch",
            "200",
            Some("GuildEmoji"),
            Some("UpdateEmojiRequest"),
        ),
        (
            "/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
            "delete",
            "204",
            None,
            None,
        ),
        (
            "/api/v1/users/@me/guilds",
            "get",
            "200",
            Some("GuildSummaryList"),
            None,
        ),
        (
            "/api/v1/guilds",
            "post",
            "201",
            Some("GuildDetail"),
            Some("CreateGuildRequest"),
        ),
        (
            "/api/v1/guilds/{guild_id}",
            "get",
            "200",
            Some("GuildDetail"),
            None,
        ),
        (
            "/api/v1/guilds/{guild_id}",
            "patch",
            "200",
            Some("GuildDetail"),
            Some("UpdateGuildRequest"),
        ),
        (
            "/api/v1/guilds/{guild_id}/members/@me",
            "put",
            "200",
            Some("GuildDetail"),
            None,
        ),
        (
            "/api/v1/guilds/{guild_id}/owner",
            "post",
            "200",
            Some("OwnershipTransferResponse"),
            Some("TransferOwnershipRequest"),
        ),
    ] {
        let operation = spec["paths"][path]
            .get_mut(method)
            .unwrap_or_else(|| panic!("Contracted route missing: {method} {path}"));
        // GETs carry no request body; a typed request or a bodyless GET both
        // qualify as request coverage. Multipart uploads and bodyless 204
        // operations only assert their success response.
        operation["x-contract-coverage"] = json!(if request.is_some() || method == "get" {
            "request-and-success-response"
        } else {
            "success-response"
        });
        operation["responses"]
            .as_object_mut()
            .expect("responses")
            .remove("200");
        if let Some(response) = response {
            operation["responses"][status] = json!({
                "description": "Successful response",
                "content": { "application/json": { "schema": { "$ref": format!("#/components/schemas/{response}") } } },
            });
        } else {
            operation["responses"][status] = json!({
                "description": "Successful response; no response body",
            });
        }
        if let Some(request) = request {
            operation["requestBody"] = json!({
                "required": true,
                "content": { "application/json": { "schema": { "$ref": format!("#/components/schemas/{request}") } } },
            });
            operation["responses"]["422"] = json!({
                "description": "JSON body does not match the request type",
                "content": { "text/plain": { "schema": { "type": "string" } } },
            });
        }
    }
    // `POST /invites/{code}` accepts an optional JSON body.
    let accept = &mut spec["paths"]["/api/v1/invites/{code}"]["post"];
    accept["x-contract-coverage"] = json!("request-and-success-response");
    accept["responses"]
        .as_object_mut()
        .expect("accept invite responses")
        .remove("200");
    accept["responses"]["200"] = json!({
        "description": "Successful response",
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/InviteAcceptResponse" } } },
    });
    accept["requestBody"] = json!({
        "required": false,
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/AcceptInviteRequest" } } },
    });
    let delete = &mut spec["paths"]["/api/v1/guilds/{guild_id}"]["delete"];
    delete["x-contract-coverage"] = json!("success-response");
    delete["responses"]
        .as_object_mut()
        .expect("delete responses")
        .remove("200");
    delete["responses"]["204"] = json!({ "description": "Space deleted; no response body" });
}

fn openapi_cache() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(build_openapi_spec)
}

pub async fn openapi_spec() -> Json<Value> {
    Json(openapi_cache().clone())
}

pub async fn swagger_ui() -> Html<String> {
    Html(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Paracord API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    html, body { margin: 0; padding: 0; background: #0b0f16; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      tryItOutEnabled: true,
      persistAuthorization: true
    });
  </script>
</body>
</html>"#
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::{build_openapi_spec, route_uses_bearer_auth};
    use serde_json::{json, Value};

    #[test]
    fn guild_contracts_have_actual_statuses_types_and_resolvable_references() {
        let spec = build_openapi_spec();
        assert_eq!(spec["servers"][0]["url"], "/");
        assert_eq!(
            spec["paths"]["/api/v1/guilds"]["post"]["responses"]["201"]["content"]
                ["application/json"]["schema"]["$ref"],
            "#/components/schemas/GuildDetail"
        );
        assert!(spec["paths"]["/api/v1/guilds"]["post"]["responses"]
            .get("200")
            .is_none());
        assert_eq!(
            spec["paths"]["/api/v1/guilds"]["post"]["requestBody"]["required"],
            true
        );
        assert!(spec["components"]["schemas"]["GuildSummary"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("member_count")));

        // The expanded domains publish their real wire types and statuses.
        for (path, method, status, schema) in [
            ("/api/v1/users/@me", "get", "200", "CurrentUser"),
            ("/api/v1/users/@me", "patch", "200", "UpdatedCurrentUser"),
            (
                "/api/v1/users/{user_id}/profile",
                "get",
                "200",
                "PublicUserProfile",
            ),
            (
                "/api/v1/users/@me/settings",
                "get",
                "200",
                "UserSettingsResponse",
            ),
            (
                "/api/v1/users/@me/relationships",
                "get",
                "200",
                "RelationshipList",
            ),
            (
                "/api/v1/channels/{channel_id}/invites",
                "post",
                "201",
                "GuildInvite",
            ),
            ("/api/v1/invites/{code}", "get", "200", "InvitePreview"),
            (
                "/api/v1/invites/{code}",
                "post",
                "200",
                "InviteAcceptResponse",
            ),
            (
                "/api/v1/guilds/{guild_id}/invites",
                "get",
                "200",
                "GuildInviteList",
            ),
            (
                "/api/v1/guilds/{guild_id}/emojis",
                "get",
                "200",
                "GuildEmojiList",
            ),
            (
                "/api/v1/guilds/{guild_id}/emojis",
                "post",
                "201",
                "GuildEmoji",
            ),
            (
                "/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
                "patch",
                "200",
                "GuildEmoji",
            ),
        ] {
            let operation = &spec["paths"][path][method];
            assert_eq!(
                operation["responses"][status]["content"]["application/json"]["schema"]["$ref"],
                format!("#/components/schemas/{schema}"),
                "{method} {path} should answer {status} with {schema}"
            );
            assert!(
                operation["responses"].get("200").is_none() || status == "200",
                "{method} {path} kept a stale 200 response"
            );
        }

        // Typed request bodies resolve to their request schemas.
        for (path, method, schema) in [
            ("/api/v1/users/@me", "patch", "UpdateMeRequest"),
            (
                "/api/v1/users/@me/settings",
                "patch",
                "UpdateSettingsRequest",
            ),
            (
                "/api/v1/users/@me/relationships",
                "post",
                "CreateRelationshipRequest",
            ),
            (
                "/api/v1/channels/{channel_id}/invites",
                "post",
                "CreateInviteRequest",
            ),
            (
                "/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
                "patch",
                "UpdateEmojiRequest",
            ),
        ] {
            let operation = &spec["paths"][path][method];
            assert_eq!(
                operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
                format!("#/components/schemas/{schema}"),
                "{method} {path} should accept {schema}"
            );
        }

        // Multipart uploads and the optional accept-invite body must not claim
        // required JSON request bodies.
        assert!(spec["paths"]["/api/v1/guilds/{guild_id}/emojis"]["post"]
            .get("requestBody")
            .is_none());
        assert_eq!(
            spec["paths"]["/api/v1/invites/{code}"]["post"]["requestBody"]["required"],
            false
        );
        fn check(value: &Value, root: &Value) {
            match value {
                Value::Object(map) => {
                    if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                        assert!(
                            root.pointer(reference.strip_prefix('#').expect("local reference"))
                                .is_some(),
                            "unresolved schema {reference}"
                        );
                    }
                    for child in map.values() {
                        check(child, root);
                    }
                }
                Value::Array(values) => {
                    for child in values {
                        check(child, root);
                    }
                }
                _ => {}
            }
        }
        check(&spec, &spec);
    }

    #[test]
    fn openapi_marks_public_routes_without_bearer_auth() {
        assert!(!route_uses_bearer_auth("get", "/health"));
        assert!(!route_uses_bearer_auth("post", "/api/v1/auth/login"));
        assert!(!route_uses_bearer_auth(
            "post",
            "/api/v1/auth/forgot-password"
        ));
        assert!(!route_uses_bearer_auth(
            "post",
            "/api/v1/webhooks/{webhook_id}/{token}"
        ));
        assert!(!route_uses_bearer_auth(
            "post",
            "/api/v1/interactions/{interaction_id}/{token}/callback"
        ));
        assert!(!route_uses_bearer_auth(
            "post",
            "/api/v1/voice/livekit/webhook"
        ));
    }

    #[test]
    fn openapi_marks_protected_routes_with_bearer_auth() {
        assert!(route_uses_bearer_auth("get", "/api/v1/users/@me"));
        assert!(route_uses_bearer_auth("post", "/api/v1/auth/logout"));
        assert!(route_uses_bearer_auth("get", "/api/v1/auth/sessions"));
        assert!(route_uses_bearer_auth("post", "/api/v1/auth/mfa/setup"));
        assert!(route_uses_bearer_auth(
            "post",
            "/api/v1/channels/{channel_id}/messages"
        ));
    }
}
