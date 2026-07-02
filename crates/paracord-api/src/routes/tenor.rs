use axum::{
    extract::{Query, State},
    Json,
};
use futures_util::TryStreamExt;
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use crate::error::ApiError;

const TENOR_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const TENOR_RESPONSE_BODY_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct TenorSearchQuery {
    pub q: String,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
pub struct TenorTrendingQuery {
    pub limit: Option<u32>,
}

pub async fn search(
    State(state): State<AppState>,
    Query(params): Query<TenorSearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let api_key = state
        .config
        .tenor_api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| ApiError::ServiceUnavailable("Tenor API key not configured".to_string()))?;

    let limit = params.limit.unwrap_or(20).min(50);

    let client = tenor_http_client()?;
    let resp = client
        .get("https://tenor.googleapis.com/v2/search")
        .query(&[
            ("key", api_key),
            ("q", &params.q),
            ("limit", &limit.to_string()),
            ("media_filter", "gif,tinygif"),
            ("contentfilter", "medium"),
        ])
        .send()
        .await
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("Tenor API request failed")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(ApiError::Internal(anyhow::anyhow!(
            "Tenor API returned status {status}"
        )));
    }

    let body = read_tenor_json_response(resp).await?;

    Ok(Json(body))
}

pub async fn trending(
    State(state): State<AppState>,
    Query(params): Query<TenorTrendingQuery>,
) -> Result<Json<Value>, ApiError> {
    let api_key = state
        .config
        .tenor_api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| ApiError::ServiceUnavailable("Tenor API key not configured".to_string()))?;

    let limit = params.limit.unwrap_or(20).min(50);

    let client = tenor_http_client()?;
    let resp = client
        .get("https://tenor.googleapis.com/v2/featured")
        .query(&[
            ("key", api_key),
            ("limit", &limit.to_string()),
            ("media_filter", "gif,tinygif"),
            ("contentfilter", "medium"),
        ])
        .send()
        .await
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("Tenor API request failed")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(ApiError::Internal(anyhow::anyhow!(
            "Tenor API returned status {status}"
        )));
    }

    let body = read_tenor_json_response(resp).await?;

    Ok(Json(body))
}

fn tenor_http_client() -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(TENOR_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("failed to build Tenor client: {e}")))
}

async fn read_tenor_json_response(resp: reqwest::Response) -> Result<Value, ApiError> {
    if resp
        .content_length()
        .is_some_and(|len| len > u64::try_from(TENOR_RESPONSE_BODY_LIMIT).unwrap_or(u64::MAX))
    {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "Tenor response exceeded size limit"
        )));
    }

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    loop {
        let chunk = match stream.try_next().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                return Err(ApiError::Internal(anyhow::anyhow!(
                    "Failed to read Tenor response"
                )));
            }
        };
        if body.len().saturating_add(chunk.len()) > TENOR_RESPONSE_BODY_LIMIT {
            return Err(ApiError::Internal(anyhow::anyhow!(
                "Tenor response exceeded size limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Failed to parse Tenor response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::tenor_http_client;

    #[test]
    fn tenor_http_client_builds_with_release_hardening() {
        let _ = tenor_http_client().expect("Tenor HTTP client should build");
    }
}
