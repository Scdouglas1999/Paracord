use crate::error::ApiError;
use futures_util::TryStreamExt;
use paracord_core::AppState;
use serde_json::{json, Value};
use std::time::Duration;

const AI_RESPONSE_BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
struct AiRuntimeConfig {
    provider: String,
    base_url: String,
    api_key: Option<String>,
    model: String,
    timeout: Duration,
}

fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com"),
        "anthropic" => Some("https://api.anthropic.com"),
        "ollama" => Some("http://127.0.0.1:11434"),
        "openai_compatible" => None,
        _ => None,
    }
}

fn default_model(provider: &str) -> &'static str {
    match provider {
        "openai" => "gpt-4o-mini",
        "anthropic" => "claude-3-5-haiku-latest",
        "ollama" => "llama3.1",
        "openai_compatible" => "gpt-4o-mini",
        _ => "gpt-4o-mini",
    }
}

fn ai_config_from_state(state: &AppState) -> Result<AiRuntimeConfig, ApiError> {
    let provider = state
        .config
        .ai_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("AI provider is not configured on this server".to_string())
        })?;

    let base_url = state
        .config
        .ai_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| default_base_url(&provider).map(str::to_string))
        .ok_or_else(|| {
            ApiError::ServiceUnavailable(format!(
                "AI base URL is required for provider '{}'",
                provider
            ))
        })
        .and_then(validate_ai_base_url)?;

    let model = state
        .config
        .ai_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_model(&provider))
        .to_string();

    let timeout = Duration::from_secs(state.config.ai_timeout_seconds.clamp(5, 120));
    Ok(AiRuntimeConfig {
        provider,
        base_url,
        api_key: state.config.ai_api_key.clone(),
        model,
        timeout,
    })
}

fn validate_ai_base_url(base_url: String) -> Result<String, ApiError> {
    let parsed = url::Url::parse(&base_url).map_err(|_| {
        ApiError::ServiceUnavailable("AI base URL must be an absolute HTTP(S) URL".to_string())
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::ServiceUnavailable(
            "AI base URL must use HTTP(S)".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ApiError::ServiceUnavailable(
            "AI base URL must not contain credentials".to_string(),
        ));
    }
    Ok(base_url.trim_end_matches('/').to_string())
}

fn ai_http_client(config: &AiRuntimeConfig) -> Result<reqwest::Client, ApiError> {
    reqwest::Client::builder()
        .timeout(config.timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))
}

async fn read_ai_json_response(response: reqwest::Response) -> Result<Value, ApiError> {
    if response
        .content_length()
        .is_some_and(|len| len > u64::try_from(AI_RESPONSE_BODY_LIMIT).unwrap_or(u64::MAX))
    {
        return Err(ApiError::ServiceUnavailable(
            "AI response exceeded size limit".to_string(),
        ));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = match stream.try_next().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                return Err(ApiError::ServiceUnavailable(format!(
                    "AI response read failed: {err}"
                )));
            }
        };
        if body.len().saturating_add(chunk.len()) > AI_RESPONSE_BODY_LIMIT {
            return Err(ApiError::ServiceUnavailable(
                "AI response exceeded size limit".to_string(),
            ));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|e| ApiError::ServiceUnavailable(format!("AI response parse failed: {e}")))
}

async fn call_openai_like(
    config: &AiRuntimeConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, ApiError> {
    let client = ai_http_client(config)?;
    let endpoint = format!("{}/v1/chat/completions", config.base_url);
    let mut request = client.post(endpoint).json(&json!({
        "model": config.model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
    }));
    if let Some(key) = config.api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("AI request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::ServiceUnavailable(format!(
            "AI provider returned {}",
            response.status()
        )));
    }
    let payload = read_ai_json_response(response).await?;
    let content = payload
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("AI provider returned an empty summary".to_string())
        })?;
    Ok(content.to_string())
}

async fn call_anthropic(
    config: &AiRuntimeConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, ApiError> {
    let api_key = config.api_key.as_deref().ok_or_else(|| {
        ApiError::ServiceUnavailable("Anthropic provider requires ai.api_key".to_string())
    })?;
    let client = ai_http_client(config)?;
    let endpoint = format!("{}/v1/messages", config.base_url);
    let response = client
        .post(endpoint)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": config.model,
            "max_tokens": 512,
            "temperature": 0.2,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": user_prompt }
            ],
        }))
        .send()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("AI request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::ServiceUnavailable(format!(
            "AI provider returned {}",
            response.status()
        )));
    }
    let payload = read_ai_json_response(response).await?;
    let content = payload
        .get("content")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("AI provider returned an empty summary".to_string())
        })?;
    Ok(content.to_string())
}

async fn call_ollama(
    config: &AiRuntimeConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, ApiError> {
    let client = ai_http_client(config)?;
    let endpoint = format!("{}/api/chat", config.base_url);
    let response = client
        .post(endpoint)
        .json(&json!({
            "model": config.model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ]
        }))
        .send()
        .await
        .map_err(|e| ApiError::ServiceUnavailable(format!("AI request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::ServiceUnavailable(format!(
            "AI provider returned {}",
            response.status()
        )));
    }
    let payload = read_ai_json_response(response).await?;
    let content = payload
        .get("message")
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("AI provider returned an empty summary".to_string())
        })?;
    Ok(content.to_string())
}

pub async fn summarize_text(
    state: &AppState,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<(String, String, String), ApiError> {
    let config = ai_config_from_state(state)?;
    let summary = match config.provider.as_str() {
        "openai" | "openai_compatible" => {
            call_openai_like(&config, system_prompt, user_prompt).await?
        }
        "anthropic" => call_anthropic(&config, system_prompt, user_prompt).await?,
        "ollama" => call_ollama(&config, system_prompt, user_prompt).await?,
        provider => {
            return Err(ApiError::ServiceUnavailable(format!(
                "Unsupported AI provider '{}'",
                provider
            )))
        }
    };
    Ok((summary, config.provider, config.model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ai_base_url_scheme_and_credentials() {
        assert_eq!(
            validate_ai_base_url("https://api.example.com/".to_string()).unwrap(),
            "https://api.example.com"
        );
        assert!(validate_ai_base_url("file:///tmp/model".to_string()).is_err());
        assert!(validate_ai_base_url("https://token@example.com".to_string()).is_err());
        assert!(validate_ai_base_url("/relative".to_string()).is_err());
    }

    #[test]
    fn ai_http_client_builds_with_release_hardening() {
        let config = AiRuntimeConfig {
            provider: "openai".to_string(),
            base_url: "https://api.openai.com".to_string(),
            api_key: None,
            model: "gpt-4o-mini".to_string(),
            timeout: Duration::from_secs(10),
        };
        let _ = ai_http_client(&config).expect("AI HTTP client should build");
    }
}
