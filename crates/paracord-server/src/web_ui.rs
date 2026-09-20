use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::path::Path;

pub(crate) fn is_reserved_server_path(path: &str) -> bool {
    path == "health"
        || path == "api"
        || path.starts_with("api/")
        || path == "_paracord"
        || path.starts_with("_paracord/")
        || path.starts_with("gateway")
        || path.starts_with("livekit")
}

pub(crate) fn external_router(dir: &Path) -> axum::Router {
    let index = tower_http::services::ServeFile::new(dir.join("index.html"));
    let assets = tower_http::services::ServeDir::new(dir).fallback(index);
    axum::Router::new()
        .fallback_service(assets)
        .layer(axum::middleware::from_fn(reserve_server_routes))
        .layer(axum::middleware::from_fn(
            paracord_api::security_headers_middleware,
        ))
}

async fn reserve_server_routes(req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD)
        || is_reserved_server_path(req.uri().path().trim_start_matches('/'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn external_ui_serves_deep_links_without_masking_api_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>Paracord</html>").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = external_router(dir.path());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        for path in ["/", "/login", "/app/templates", "/app/guilds/1/channels/2"] {
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.text().await.unwrap(), "<html>Paracord</html>");
        }
        for path in [
            "/api",
            "/api/v1/missing",
            "/_paracord/missing",
            "/gateway",
            "/health",
        ] {
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(response.text().await.unwrap().is_empty());
        }
        assert_eq!(
            client
                .post(format!("{base}/login"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }
}
