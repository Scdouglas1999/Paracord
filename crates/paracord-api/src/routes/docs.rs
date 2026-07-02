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

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Paracord HTTP API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Auto-generated from axum route definitions. Includes rate-limit tier metadata.",
        },
        "servers": [
            { "url": "/api/v1", "description": "Primary API base" }
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
    })
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
    use super::route_uses_bearer_auth;

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
