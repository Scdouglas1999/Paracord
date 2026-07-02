use crate::protocol::{FederatedEvent, ServerInfo};
use crate::signing;
use crate::transport;
use crate::{
    FederationError, FederationEventEnvelope, FederationServerKey, FEDERATION_PROTOCOL_DEFAULT,
    FEDERATION_PROTOCOL_VERSION_V1,
};
use ed25519_dalek::SigningKey;
use reqwest::Client;
use std::net::IpAddr;
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RETRIES: u32 = 3;
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);
const MAX_DOWNLOAD_REDIRECTS: usize = 3;

#[derive(Debug, Clone)]
struct TransportSigner {
    origin: String,
    key_id: String,
    signing_key: SigningKey,
}

/// HTTP client for server-to-server federation requests.
#[derive(Debug, Clone)]
pub struct FederationClient {
    http: Client,
    transport_signer: Option<TransportSigner>,
}

impl FederationClient {
    pub fn new() -> Result<Self, FederationError> {
        Self::new_with_signer(None, None, None)
    }

    pub fn new_signed(
        origin: String,
        key_id: String,
        signing_key: SigningKey,
    ) -> Result<Self, FederationError> {
        Self::new_with_signer(Some(origin), Some(key_id), Some(signing_key))
    }

    fn new_with_signer(
        origin: Option<String>,
        key_id: Option<String>,
        signing_key: Option<SigningKey>,
    ) -> Result<Self, FederationError> {
        let http = ssrf_checked_http_client("Paracord-Federation/0.4", DEFAULT_TIMEOUT)?;

        let transport_signer = match (origin, key_id, signing_key) {
            (Some(origin), Some(key_id), Some(signing_key)) => Some(TransportSigner {
                origin,
                key_id,
                signing_key,
            }),
            _ => None,
        };

        Ok(Self {
            http,
            transport_signer,
        })
    }

    /// Discover a remote server's federation info via its `.well-known` endpoint.
    pub async fn fetch_server_info(&self, base_url: &str) -> Result<ServerInfo, FederationError> {
        let url = format!(
            "{}/.well-known/paracord/server",
            base_url.trim_end_matches('/')
        );
        let resp = self.get_with_retry(&url).await?;
        let info: ServerInfo = resp
            .json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid server info: {e}")))?;
        Ok(info)
    }

    /// Fetch the public keys of a remote server.
    pub async fn fetch_server_keys(
        &self,
        federation_endpoint: &str,
    ) -> Result<FederationKeysResponse, FederationError> {
        let url = format!("{}/keys", federation_endpoint.trim_end_matches('/'));
        let resp = self.get_with_retry(&url).await?;
        let keys: FederationKeysResponse = resp
            .json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid keys response: {e}")))?;
        Ok(keys)
    }

    /// Send a federation event envelope to a remote server.
    pub async fn post_event(
        &self,
        federation_endpoint: &str,
        envelope: &FederationEventEnvelope,
    ) -> Result<PostEventResponse, FederationError> {
        let url = format!("{}/event", federation_endpoint.trim_end_matches('/'));
        let body_bytes =
            serde_json::to_vec(envelope).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body_bytes).await?;
        let body: PostEventResponse = resp
            .json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid event response: {e}")))?;
        Ok(body)
    }

    /// Send a federated event (higher-level type) to a remote server by
    /// converting it into the envelope format expected by the ingest endpoint.
    pub async fn send_event(
        &self,
        federation_endpoint: &str,
        event: &FederatedEvent,
    ) -> Result<PostEventResponse, FederationError> {
        let envelope = FederationEventEnvelope {
            event_id: event.event_id.clone(),
            room_id: event.room_id.clone().unwrap_or_default(),
            event_type: event.event_type.clone(),
            sender: event.sender.clone(),
            origin_server: event.origin_server.clone(),
            origin_ts: event.origin_ts,
            content: event.content.clone(),
            depth: 0,
            state_key: None,
            signatures: event.signatures.clone(),
        };
        self.post_event(federation_endpoint, &envelope).await
    }

    /// Fetch a specific event by ID from a remote server.
    pub async fn fetch_event(
        &self,
        federation_endpoint: &str,
        event_id: &str,
        read_token: Option<&str>,
    ) -> Result<FederationEventEnvelope, FederationError> {
        let url = format!(
            "{}/event/{}",
            federation_endpoint.trim_end_matches('/'),
            event_id
        );
        let mut extra_headers: Vec<(&str, String)> = Vec::new();
        if let Some(token) = read_token {
            extra_headers.push(("x-paracord-federation-token", token.to_string()));
        }
        let resp = self
            .get_with_retry_with_headers(&url, &extra_headers)
            .await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid event response: {e}")))
    }

    /// Fetch messages/events from a remote server for a given room, paginated.
    pub async fn fetch_messages(
        &self,
        federation_endpoint: &str,
        room_id: &str,
        since_depth: i64,
        limit: i64,
    ) -> Result<Vec<FederationEventEnvelope>, FederationError> {
        let url = format!(
            "{}/events?room_id={}&since_depth={}&limit={}",
            federation_endpoint.trim_end_matches('/'),
            room_id,
            since_depth,
            limit
        );
        let resp = self.get_with_retry_with_headers(&url, &[]).await?;
        let events: FederationEventsResponse = resp
            .json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid events response: {e}")))?;
        Ok(events.events)
    }

    pub async fn send_invite(
        &self,
        federation_endpoint: &str,
        payload: &FederationInviteRequest,
    ) -> Result<FederationInviteResponse, FederationError> {
        let url = format!("{}/invite", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid invite response: {e}")))
    }

    pub async fn send_join(
        &self,
        federation_endpoint: &str,
        payload: &FederationJoinRequest,
    ) -> Result<FederationJoinResponse, FederationError> {
        let url = format!("{}/join", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid join response: {e}")))
    }

    pub async fn send_leave(
        &self,
        federation_endpoint: &str,
        payload: &FederationLeaveRequest,
    ) -> Result<FederationLeaveResponse, FederationError> {
        let url = format!("{}/leave", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid leave response: {e}")))
    }

    pub async fn request_media_token(
        &self,
        federation_endpoint: &str,
        payload: &FederationMediaTokenRequest,
    ) -> Result<FederationMediaTokenResponse, FederationError> {
        let url = format!("{}/media/token", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid media token response: {e}")))
    }

    pub async fn relay_media_action(
        &self,
        federation_endpoint: &str,
        payload: &FederationMediaRelayRequest,
    ) -> Result<FederationMediaRelayResponse, FederationError> {
        let url = format!("{}/media/relay", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid media relay response: {e}")))
    }

    pub async fn request_file_token(
        &self,
        federation_endpoint: &str,
        payload: &FederationFileTokenRequest,
    ) -> Result<FederationFileTokenResponse, FederationError> {
        let url = format!("{}/file/token", federation_endpoint.trim_end_matches('/'));
        let body = serde_json::to_vec(payload).map_err(|e| FederationError::Http(e.to_string()))?;
        let resp = self.post_with_retry(&url, body).await?;
        resp.json()
            .await
            .map_err(|e| FederationError::RemoteError(format!("invalid file token response: {e}")))
    }

    pub async fn download_federated_file(
        &self,
        download_url: &str,
    ) -> Result<(Vec<u8>, Option<String>, Option<String>), FederationError> {
        // Manual redirects allow every hop to receive the same async DNS
        // validation before reqwest opens a connection.
        let download_client = ssrf_checked_http_client("Paracord-Federation/0.4", DEFAULT_TIMEOUT)?;

        let mut current_url = download_url.to_string();
        let mut redirects = 0usize;
        let resp = loop {
            validate_ssrf_safe_url(&current_url)?;
            resolve_and_check_dns(&current_url).await?;

            let resp = download_client
                .get(&current_url)
                .send()
                .await
                .map_err(|e| FederationError::Http(e.to_string()))?;

            if resp.status().is_redirection() {
                if redirects >= MAX_DOWNLOAD_REDIRECTS {
                    return Err(FederationError::Http(format!(
                        "SSRF protection: too many redirects (max {})",
                        MAX_DOWNLOAD_REDIRECTS
                    )));
                }

                let location = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        FederationError::Http(
                            "SSRF protection: redirect response missing Location header"
                                .to_string(),
                        )
                    })?;
                let base = url::Url::parse(&current_url).map_err(|e| {
                    FederationError::Http(format!(
                        "SSRF protection: invalid redirect base URL: {e}"
                    ))
                })?;
                current_url = base
                    .join(location)
                    .map_err(|e| {
                        FederationError::Http(format!(
                            "SSRF protection: invalid redirect target: {e}"
                        ))
                    })?
                    .to_string();
                redirects += 1;
                continue;
            }

            break resp;
        };

        if !resp.status().is_success() {
            return Err(FederationError::RemoteError(format!(
                "download from {} returned {}",
                current_url,
                resp.status()
            )));
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let filename = resp
            .headers()
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split("filename=\"")
                    .nth(1)
                    .and_then(|s| s.strip_suffix('"'))
                    .map(str::to_string)
            });
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| FederationError::Http(e.to_string()))?;
        Ok((bytes.to_vec(), content_type, filename))
    }

    /// GET request with exponential backoff retry.
    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, FederationError> {
        self.get_with_retry_with_headers(url, &[]).await
    }

    async fn get_with_retry_with_headers(
        &self,
        url: &str,
        extra_headers: &[(&str, String)],
    ) -> Result<reqwest::Response, FederationError> {
        validate_public_federation_url_with_dns(url).await?;
        let mut last_err = FederationError::Http("no attempts made".to_string());
        for attempt in 0..MAX_RETRIES {
            let path = transport::request_path_from_url(url);
            for protocol_version in [FEDERATION_PROTOCOL_DEFAULT, FEDERATION_PROTOCOL_VERSION_V1] {
                let mut request = self.http.get(url);
                request = self.with_transport_signature_headers(
                    request,
                    "GET",
                    &path,
                    &[],
                    protocol_version,
                );
                for (key, value) in extra_headers {
                    request = request.header(*key, value);
                }

                match request.send().await {
                    Ok(resp) if resp.status().is_success() => return Ok(resp),
                    Ok(resp)
                        if resp.status() == reqwest::StatusCode::UPGRADE_REQUIRED
                            && protocol_version != FEDERATION_PROTOCOL_VERSION_V1 =>
                    {
                        continue;
                    }
                    Ok(resp) if resp.status().is_server_error() => {
                        last_err = FederationError::RemoteError(format!(
                            "server error {} from {}",
                            resp.status(),
                            url
                        ));
                        break;
                    }
                    Ok(resp) => {
                        return Err(FederationError::RemoteError(format!(
                            "request to {} returned {}",
                            url,
                            resp.status()
                        )));
                    }
                    Err(e) => {
                        last_err = FederationError::Http(e.to_string());
                        break;
                    }
                }
            }
            if attempt + 1 < MAX_RETRIES {
                let delay = RETRY_BASE_DELAY * 2u32.pow(attempt);
                tokio::time::sleep(delay).await;
            }
        }
        Err(last_err)
    }

    /// POST request with exponential backoff retry.
    async fn post_with_retry(
        &self,
        url: &str,
        body_bytes: Vec<u8>,
    ) -> Result<reqwest::Response, FederationError> {
        validate_public_federation_url_with_dns(url).await?;
        let mut last_err = FederationError::Http("no attempts made".to_string());
        for attempt in 0..MAX_RETRIES {
            let path = transport::request_path_from_url(url);
            for protocol_version in [FEDERATION_PROTOCOL_DEFAULT, FEDERATION_PROTOCOL_VERSION_V1] {
                let mut request = self
                    .http
                    .post(url)
                    .header("content-type", "application/json")
                    .body(body_bytes.clone());
                request = self.with_transport_signature_headers(
                    request,
                    "POST",
                    &path,
                    &body_bytes,
                    protocol_version,
                );

                match request.send().await {
                    Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 202 => {
                        return Ok(resp);
                    }
                    Ok(resp)
                        if resp.status() == reqwest::StatusCode::UPGRADE_REQUIRED
                            && protocol_version != FEDERATION_PROTOCOL_VERSION_V1 =>
                    {
                        continue;
                    }
                    Ok(resp) if resp.status().is_server_error() => {
                        last_err = FederationError::RemoteError(format!(
                            "server error {} from {}",
                            resp.status(),
                            url
                        ));
                        break;
                    }
                    Ok(resp) => {
                        return Err(FederationError::RemoteError(format!(
                            "request to {} returned {}",
                            url,
                            resp.status()
                        )));
                    }
                    Err(e) => {
                        last_err = FederationError::Http(e.to_string());
                        break;
                    }
                }
            }
            if attempt + 1 < MAX_RETRIES {
                let delay = RETRY_BASE_DELAY * 2u32.pow(attempt);
                tokio::time::sleep(delay).await;
            }
        }
        Err(last_err)
    }

    fn with_transport_signature_headers(
        &self,
        request: reqwest::RequestBuilder,
        method: &str,
        path: &str,
        body_bytes: &[u8],
        protocol_version: &str,
    ) -> reqwest::RequestBuilder {
        let Some(signer) = &self.transport_signer else {
            return request.header("X-Paracord-Fed-Version", protocol_version);
        };
        let timestamp_ms = chrono::Utc::now().timestamp_millis();
        let canonical =
            transport::canonical_transport_bytes_with_body(method, path, timestamp_ms, body_bytes);
        let signature = signing::sign(&signer.signing_key, &canonical);
        request
            .header("X-Paracord-Origin", signer.origin.as_str())
            .header("X-Paracord-Key-Id", signer.key_id.as_str())
            .header("X-Paracord-Timestamp", timestamp_ms.to_string())
            .header("X-Paracord-Signature", signature)
            .header("X-Paracord-Fed-Version", protocol_version)
    }
}

/// Build an HTTP client for requests whose URL is protected by the federation
/// SSRF validators. Redirects are disabled so each next hop can be explicitly
/// validated before any connection is opened.
pub fn ssrf_checked_http_client(
    user_agent: &'static str,
    timeout: Duration,
) -> Result<Client, FederationError> {
    Client::builder()
        .timeout(timeout)
        .user_agent(user_agent)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| FederationError::Http(e.to_string()))
}

impl Default for FederationClient {
    fn default() -> Self {
        Self::new().expect("failed to create federation HTTP client")
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationKeysResponse {
    pub server_name: String,
    pub keys: Vec<FederationServerKey>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PostEventResponse {
    pub event_id: String,
    pub inserted: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct FederationEventsResponse {
    events: Vec<FederationEventEnvelope>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationInviteRequest {
    pub origin_server: String,
    pub room_id: String,
    pub sender: String,
    pub max_age_seconds: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationJoinRequest {
    pub origin_server: String,
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationLeaveRequest {
    pub origin_server: String,
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationMediaTokenRequest {
    pub origin_server: String,
    pub channel_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationMediaRelayRequest {
    pub origin_server: String,
    pub channel_id: String,
    pub user_id: String,
    pub action: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationInviteResponse {
    pub accepted: bool,
    pub room_id: String,
    pub guild_id: String,
    pub guild_name: String,
    pub default_channel_id: Option<String>,
    pub join_endpoint: String,
    pub expires_in_seconds: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationJoinResponse {
    pub joined: bool,
    pub room_id: String,
    pub guild_id: String,
    pub local_user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationLeaveResponse {
    pub left: bool,
    pub room_id: String,
    pub guild_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationMediaTokenResponse {
    pub token: String,
    pub url: String,
    pub room_name: String,
    pub session_id: String,
    pub local_user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationMediaRelayResponse {
    pub ok: bool,
    pub action: String,
    pub token: Option<String>,
    pub room_name: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationFileTokenRequest {
    pub origin_server: String,
    pub attachment_id: String,
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederationFileTokenResponse {
    pub token: String,
    pub download_url: String,
    pub expires_in_seconds: i64,
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/// Validates that a URL is safe to request (not targeting private/internal networks).
/// This prevents SSRF attacks where a compromised federation partner returns a
/// download URL pointing at internal services (AWS metadata, databases, etc.).
pub fn validate_ssrf_safe_url(url_str: &str) -> Result<(), FederationError> {
    let parsed = url::Url::parse(url_str).map_err(|e| {
        FederationError::Http(format!("SSRF protection: invalid download URL: {e}"))
    })?;

    // Only HTTPS is allowed — block http://, file://, ftp://, etc.
    if parsed.scheme() != "https" {
        return Err(FederationError::Http(format!(
            "SSRF protection: only https:// URLs allowed, got scheme '{}'",
            parsed.scheme()
        )));
    }

    // Use the typed Host enum for robust IP detection (avoids IPv6 string parsing issues)
    match parsed.host() {
        None => {
            return Err(FederationError::Http(
                "SSRF protection: URL has no host".to_string(),
            ));
        }
        Some(url::Host::Ipv4(v4)) => {
            if is_private_ip(&IpAddr::V4(v4)) {
                return Err(FederationError::Http(format!(
                    "SSRF protection: private/reserved IP address '{v4}' is not allowed"
                )));
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if is_private_ip(&IpAddr::V6(v6)) {
                return Err(FederationError::Http(format!(
                    "SSRF protection: private/reserved IP address '{v6}' is not allowed"
                )));
            }
        }
        Some(url::Host::Domain(domain)) => {
            // Block known dangerous hostnames
            let blocked_hosts = ["localhost", "metadata.google.internal"];
            let lower = domain.to_ascii_lowercase();
            for blocked in &blocked_hosts {
                if lower == *blocked || lower.ends_with(&format!(".{}", blocked)) {
                    return Err(FederationError::Http(format!(
                        "SSRF protection: blocked host '{domain}'"
                    )));
                }
            }
        }
    }

    // Port whitelist: only 443 (default HTTPS). Since the scheme is enforced
    // to https://, allowing port 80 serves no legitimate purpose.
    let port = parsed.port().unwrap_or(443);
    if port != 443 {
        return Err(FederationError::Http(format!(
            "SSRF protection: non-standard port {port} is not allowed"
        )));
    }

    Ok(())
}

/// Validates federation peer URLs before server-to-server discovery or RPCs.
///
/// Unlike file downloads, federation RPCs may run on non-standard ports or
/// plain HTTP in development deployments. The important SSRF invariant is that
/// the target host must not be local, private, link-local, or otherwise
/// reserved unless an operator explicitly opts into private federation URLs.
pub fn validate_public_federation_url(url_str: &str) -> Result<(), FederationError> {
    if private_federation_urls_allowed() {
        return Ok(());
    }

    let parsed = url::Url::parse(url_str)
        .map_err(|e| FederationError::Http(format!("SSRF protection: invalid URL: {e}")))?;

    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(FederationError::Http(format!(
            "SSRF protection: unsupported federation URL scheme '{}'",
            parsed.scheme()
        )));
    }

    validate_url_host_is_public(&parsed)
}

/// Validates a federation URL and resolves DNS so private-address hostnames are
/// rejected before reqwest opens a connection.
pub async fn validate_public_federation_url_with_dns(url_str: &str) -> Result<(), FederationError> {
    if private_federation_urls_allowed() {
        return Ok(());
    }
    validate_public_federation_url(url_str)?;
    resolve_and_check_dns(url_str).await
}

fn private_federation_urls_allowed() -> bool {
    std::env::var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS")
        .ok()
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn validate_url_host_is_public(parsed: &url::Url) -> Result<(), FederationError> {
    match parsed.host() {
        None => Err(FederationError::Http(
            "SSRF protection: URL has no host".to_string(),
        )),
        Some(url::Host::Ipv4(v4)) => {
            if is_private_ip(&IpAddr::V4(v4)) {
                Err(FederationError::Http(format!(
                    "SSRF protection: private/reserved IP address '{v4}' is not allowed"
                )))
            } else {
                Ok(())
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if is_private_ip(&IpAddr::V6(v6)) {
                Err(FederationError::Http(format!(
                    "SSRF protection: private/reserved IP address '{v6}' is not allowed"
                )))
            } else {
                Ok(())
            }
        }
        Some(url::Host::Domain(domain)) => {
            let lower = domain.to_ascii_lowercase();
            let blocked_hosts = [
                "localhost",
                "metadata.google.internal",
                "metadata",
                "local",
                "home.arpa",
            ];
            if blocked_hosts
                .iter()
                .any(|blocked| lower == *blocked || lower.ends_with(&format!(".{blocked}")))
            {
                return Err(FederationError::Http(format!(
                    "SSRF protection: blocked host '{domain}'"
                )));
            }
            Ok(())
        }
    }
}

/// Resolves the hostname in the URL via DNS and checks that all returned IP
/// addresses are public. This mitigates DNS rebinding attacks where an attacker
/// controls a domain that resolves to an internal IP after initial validation.
///
/// Note: there is an inherent TOCTOU gap between this check and the actual TCP
/// connection made by reqwest. DNS rebinding with very low TTL can still slip
/// through. This is a known residual risk; a complete fix requires resolving
/// and connecting in a single step (e.g. via a custom `reqwest::dns::Resolve`).
async fn resolve_and_check_dns(url_str: &str) -> Result<(), FederationError> {
    let parsed = url::Url::parse(url_str)
        .map_err(|e| FederationError::Http(format!("DNS check: invalid URL: {e}")))?;

    // Only domains need DNS resolution; raw IPs are already checked by validate_ssrf_safe_url
    if let Some(url::Host::Domain(domain)) = parsed.host() {
        let port = parsed.port().unwrap_or(443);
        let lookup = format!("{domain}:{port}");
        let addrs = tokio::net::lookup_host(&lookup).await.map_err(|e| {
            FederationError::Http(format!(
                "SSRF protection: DNS resolution failed for '{domain}': {e}"
            ))
        })?;
        for addr in addrs {
            if is_private_ip(&addr.ip()) {
                return Err(FederationError::Http(format!(
                    "SSRF protection: domain '{domain}' resolves to private IP {}",
                    addr.ip()
                )));
            }
        }
    }
    Ok(())
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // 10.0.0.0/8
            o[0] == 10
            // 172.16.0.0/12
            || (o[0] == 172 && (16..=31).contains(&o[1]))
            // 192.168.0.0/16
            || (o[0] == 192 && o[1] == 168)
            // 127.0.0.0/8 (loopback)
            || o[0] == 127
            // 169.254.0.0/16 (link-local / AWS metadata)
            || (o[0] == 169 && o[1] == 254)
            // 100.64.0.0/10 (Carrier-grade NAT)
            || (o[0] == 100 && (64..=127).contains(&o[1]))
            // 192.0.0.0/24 (IETF protocol assignments), except not needed for public federation
            || (o[0] == 192 && o[1] == 0 && o[2] == 0)
            // TEST-NET documentation ranges
            || (o[0] == 192 && o[1] == 0 && o[2] == 2)
            || (o[0] == 198 && o[1] == 51 && o[2] == 100)
            || (o[0] == 203 && o[1] == 0 && o[2] == 113)
            // 224.0.0.0/4 (multicast)
            || (224..=239).contains(&o[0])
            // 0.0.0.0/8
            || o[0] == 0
            // 240.0.0.0/4 (reserved / broadcast)
            || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded IPv4
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(&IpAddr::V4(v4));
            }
            // ::1 loopback
            v6.is_loopback()
            // fc00::/7 (unique local)
            || (v6.segments()[0] & 0xfe00) == 0xfc00
            // fe80::/10 (link-local)
            || (v6.segments()[0] & 0xffc0) == 0xfe80
            // 2001:db8::/32 (documentation)
            || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
            // ff00::/8 (multicast)
            || (v6.segments()[0] & 0xff00) == 0xff00
            // :: unspecified
            || v6.is_unspecified()
        }
    }
}

#[cfg(test)]
mod ssrf_tests {
    use super::{ssrf_checked_http_client, validate_public_federation_url, validate_ssrf_safe_url};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn blocks_localhost() {
        assert!(validate_ssrf_safe_url("https://localhost/file").is_err());
        assert!(validate_ssrf_safe_url("https://127.0.0.1/file").is_err());
    }

    #[tokio::test]
    async fn ssrf_checked_http_client_does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hit_redirect_target = Arc::new(AtomicBool::new(false));
        let hit_redirect_target_clone = hit_redirect_target.clone();

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let hit_redirect_target = hit_redirect_target_clone.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let response = if request.starts_with("GET /redirect ") {
                        "HTTP/1.1 302 Found\r\nLocation: /target\r\nContent-Length: 0\r\n\r\n"
                    } else {
                        hit_redirect_target.store(true, Ordering::SeqCst);
                        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });

        let client = ssrf_checked_http_client("Paracord-Test/1.0", Duration::from_secs(2))
            .expect("client should build");
        let response = client
            .get(format!("http://{addr}/redirect"))
            .send()
            .await
            .expect("redirect response should be returned");

        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!hit_redirect_target.load(Ordering::SeqCst));
        server.abort();
    }

    #[test]
    fn blocks_aws_metadata() {
        assert!(validate_ssrf_safe_url("https://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn blocks_private_ip_ranges() {
        assert!(validate_ssrf_safe_url("https://10.0.0.1/file").is_err());
        assert!(validate_ssrf_safe_url("https://192.168.1.1/file").is_err());
        assert!(validate_ssrf_safe_url("https://172.16.0.1/file").is_err());
        assert!(validate_ssrf_safe_url("https://172.31.255.255/file").is_err());
    }

    #[test]
    fn blocks_carrier_grade_nat() {
        assert!(validate_ssrf_safe_url("https://100.64.0.1/file").is_err());
        assert!(validate_ssrf_safe_url("https://100.127.255.255/file").is_err());
    }

    #[test]
    fn blocks_http_scheme() {
        assert!(validate_ssrf_safe_url("http://example.com/file").is_err());
    }

    #[test]
    fn blocks_file_scheme() {
        assert!(validate_ssrf_safe_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn blocks_non_standard_ports() {
        assert!(validate_ssrf_safe_url("https://example.com:8080/file").is_err());
        assert!(validate_ssrf_safe_url("https://example.com:6379/file").is_err());
    }

    #[test]
    fn blocks_google_metadata() {
        assert!(
            validate_ssrf_safe_url("https://metadata.google.internal/computeMetadata/v1/").is_err()
        );
    }

    #[test]
    fn blocks_ipv6_loopback() {
        assert!(validate_ssrf_safe_url("https://[::1]/file").is_err());
    }

    #[test]
    fn blocks_ipv6_link_local() {
        assert!(validate_ssrf_safe_url("https://[fe80::1]/file").is_err());
    }

    #[test]
    fn blocks_ipv6_unique_local() {
        assert!(validate_ssrf_safe_url("https://[fc00::1]/file").is_err());
        assert!(validate_ssrf_safe_url("https://[fd00::1]/file").is_err());
    }

    #[test]
    fn blocks_reserved_ip_range() {
        assert!(validate_ssrf_safe_url("https://240.0.0.1/file").is_err());
        assert!(validate_ssrf_safe_url("https://255.255.255.255/file").is_err());
    }

    #[test]
    fn blocks_zero_ip() {
        assert!(validate_ssrf_safe_url("https://0.0.0.0/file").is_err());
    }

    #[test]
    fn allows_public_https() {
        assert!(validate_ssrf_safe_url("https://cdn.example.com/files/abc123").is_ok());
        assert!(validate_ssrf_safe_url(
            "https://federation.partner.org/v1/file/download?token=abc"
        )
        .is_ok());
    }

    #[test]
    fn allows_standard_ports() {
        assert!(validate_ssrf_safe_url("https://cdn.example.com:443/file").is_ok());
    }

    #[test]
    fn blocks_port_80_on_https() {
        // Port 80 is the HTTP port; since we enforce https:// scheme only,
        // there is no legitimate reason to allow port 80.
        assert!(validate_ssrf_safe_url("https://cdn.example.com:80/file").is_err());
    }

    #[test]
    fn blocks_empty_and_garbage() {
        assert!(validate_ssrf_safe_url("").is_err());
        assert!(validate_ssrf_safe_url("not-a-url").is_err());
    }

    #[test]
    fn allows_public_ip() {
        assert!(validate_ssrf_safe_url("https://8.8.8.8/file").is_ok());
        assert!(validate_ssrf_safe_url("https://1.1.1.1/file").is_ok());
    }

    #[test]
    fn federation_rpc_urls_block_private_targets() {
        assert!(
            validate_public_federation_url("http://127.0.0.1:8090/_paracord/federation/v1")
                .is_err()
        );
        assert!(
            validate_public_federation_url("https://10.0.0.5/_paracord/federation/v1").is_err()
        );
        assert!(validate_public_federation_url("https://metadata.google.internal/").is_err());
    }

    #[test]
    fn federation_rpc_urls_allow_public_http_or_https() {
        assert!(validate_public_federation_url(
            "https://federation.example.com/_paracord/federation/v1"
        )
        .is_ok());
        assert!(validate_public_federation_url(
            "http://federation.example.com:8090/_paracord/federation/v1"
        )
        .is_ok());
    }

    #[test]
    fn blocks_172_outside_private_range_is_allowed() {
        // 172.15.x.x is NOT in the 172.16-31 private range
        assert!(validate_ssrf_safe_url("https://172.15.0.1/file").is_ok());
        // 172.32.x.x is NOT in the 172.16-31 private range
        assert!(validate_ssrf_safe_url("https://172.32.0.1/file").is_ok());
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6_loopback() {
        // ::ffff:127.0.0.1 is an IPv4-mapped IPv6 address for loopback
        assert!(validate_ssrf_safe_url("https://[::ffff:127.0.0.1]/file").is_err());
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6_metadata() {
        // ::ffff:169.254.169.254 targets the AWS metadata endpoint
        assert!(validate_ssrf_safe_url("https://[::ffff:169.254.169.254]/file").is_err());
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6_private() {
        assert!(validate_ssrf_safe_url("https://[::ffff:10.0.0.1]/file").is_err());
        assert!(validate_ssrf_safe_url("https://[::ffff:192.168.1.1]/file").is_err());
        assert!(validate_ssrf_safe_url("https://[::ffff:172.16.0.1]/file").is_err());
    }

    #[test]
    fn allows_ipv4_mapped_ipv6_public() {
        assert!(validate_ssrf_safe_url("https://[::ffff:8.8.8.8]/file").is_ok());
    }

    #[test]
    fn blocks_ipv6_unspecified() {
        assert!(validate_ssrf_safe_url("https://[::]/file").is_err());
    }
}
