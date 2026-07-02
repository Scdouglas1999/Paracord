use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};

#[derive(rust_embed::Embed)]
#[folder = "../../client/dist/"]
struct WebAssets;

pub fn router() -> axum::Router {
    axum::Router::new().fallback(serve_embedded)
}

async fn serve_embedded(req: Request<Body>) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if is_reserved_server_path(path) {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Try the exact path first
    if let Some(content) = WebAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime.as_ref().to_string()),
                (header::CACHE_CONTROL, cache_control(path).to_string()),
            ],
            content.data.into_owned(),
        )
            .into_response();
    }

    // SPA fallback: serve index.html for all non-file routes
    match WebAssets::get("index.html") {
        Some(content) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html".to_string()),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
            content.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Web UI not found").into_response(),
    }
}

fn is_reserved_server_path(path: &str) -> bool {
    path == "health"
        || path.starts_with("api/")
        || path.starts_with("_paracord/")
        || path.starts_with("gateway")
        || path.starts_with("livekit")
}

/// Assets with hashes in their filename can be cached aggressively.
fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

#[cfg(test)]
mod tests {
    use super::is_reserved_server_path;

    #[test]
    fn reserves_api_and_realtime_paths_from_spa_fallback() {
        assert!(is_reserved_server_path(
            "api/v1/_paracord/federation/v1/servers"
        ));
        assert!(is_reserved_server_path("_paracord/federation/v1/servers"));
        assert!(is_reserved_server_path("gateway"));
        assert!(is_reserved_server_path("livekit/rtc"));
        assert!(is_reserved_server_path("health"));
        assert!(!is_reserved_server_path("app/admin"));
        assert!(!is_reserved_server_path("assets/index.js"));
    }
}
