//! The one hardened HTTP fetcher every add-on uses to reach the outside world.
//!
//! Server owners are not instance admins, and this server faces the internet,
//! so an address a server owner types must never become a way to reach the
//! machines around the instance. Every request:
//!
//! - is `http` or `https`, nothing else;
//! - resolves its host first and refuses the whole request if any address is
//!   loopback, private (RFC 1918, IPv6 unique-local), CGNAT, link-local,
//!   multicast, unspecified or otherwise reserved;
//! - connects to exactly the addresses that passed (no second lookup at
//!   connect time for a rebinding answer to slip into);
//! - follows at most three redirects, checking every hop the same way;
//! - gives up after 10 seconds in total and after 2 MB of body.
//!
//! Private-network targets become reachable only when the instance admin turns
//! on "Add-ons may reach this instance's local network". Link-local, multicast
//! and reserved addresses stay closed even then (link-local is where cloud
//! metadata services live).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};

/// Total time for one fetch, redirects and body included.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest body a fetch reads.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Redirects followed before giving up.
pub const MAX_REDIRECTS: usize = 3;

/// The server setting that opens private-network targets to add-ons.
pub const LOCAL_NETWORK_SETTING: &str = "addons_local_network";

/// What the refusal of a private address says, word for word.
pub const LOCAL_NETWORK_REFUSAL: &str = "That address is on a private network. Add-ons may reach \
     this instance's local network only when the instance admin turns on \"Add-ons may reach this \
     instance's local network\".";

pub fn user_agent() -> String {
    format!("Paracord/{} (+feeds)", env!("CARGO_PKG_VERSION"))
}

/// Where an address sits, as far as add-ons are concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressClass {
    /// On the internet.
    Public,
    /// Loopback, RFC 1918, IPv6 unique-local or CGNAT: the instance's own
    /// network. Reachable only with the admin setting on.
    Private,
    /// Link-local, multicast, unspecified, documentation, benchmarking and
    /// other reserved ranges. Never reachable.
    Forbidden,
}

pub fn classify(ip: IpAddr) -> AddressClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(ip: Ipv4Addr) -> AddressClass {
    let [a, b, c, _] = ip.octets();
    match (a, b, c) {
        // "This network" and the unspecified address.
        (0, _, _) => AddressClass::Forbidden,
        (127, _, _) | (10, _, _) => AddressClass::Private,
        (172, 16..=31, _) | (192, 168, _) => AddressClass::Private,
        // Carrier-grade NAT (also where tailnets live).
        (100, 64..=127, _) => AddressClass::Private,
        (169, 254, _) => AddressClass::Forbidden,
        // IETF protocol assignments and the three documentation ranges.
        (192, 0, 0) | (192, 0, 2) | (198, 51, 100) | (203, 0, 113) => AddressClass::Forbidden,
        // Benchmarking.
        (198, 18..=19, _) => AddressClass::Forbidden,
        // Multicast, reserved and broadcast.
        (224..=255, _, _) => AddressClass::Forbidden,
        _ => AddressClass::Public,
    }
}

fn classify_v6(ip: Ipv6Addr) -> AddressClass {
    if ip.is_unspecified() {
        return AddressClass::Forbidden;
    }
    if ip.is_loopback() {
        return AddressClass::Private;
    }
    let segments = ip.segments();
    let octets = ip.octets();
    // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible
    // (::a.b.c.d) forms reach the IPv4 address they carry.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    if segments[..6] == [0; 6] {
        return classify_v4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    // NAT64 well-known prefix 64:ff9b::/96 translates to the embedded IPv4.
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return classify_v4(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    // Local-use NAT64 64:ff9b:1::/48.
    if segments[0] == 0x64 && segments[1] == 0xff9b && segments[2] == 1 {
        return AddressClass::Forbidden;
    }
    // 6to4 2002::/16 carries an IPv4 address in bits 16..48.
    if segments[0] == 0x2002 {
        return classify_v4(Ipv4Addr::new(octets[2], octets[3], octets[4], octets[5]));
    }
    // Teredo 2001::/32 tunnels to an obfuscated IPv4 address.
    if segments[0] == 0x2001 && segments[1] == 0 {
        return AddressClass::Forbidden;
    }
    // Documentation 2001:db8::/32.
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return AddressClass::Forbidden;
    }
    // Discard-only 100::/64.
    if segments[..4] == [0x100, 0, 0, 0] {
        return AddressClass::Forbidden;
    }
    match segments[0] {
        // Unique-local fc00::/7.
        s if s & 0xfe00 == 0xfc00 => AddressClass::Private,
        // Link-local fe80::/10 and the retired site-local fec0::/10.
        s if s & 0xffc0 == 0xfe80 || s & 0xffc0 == 0xfec0 => AddressClass::Forbidden,
        // Multicast ff00::/8.
        s if s & 0xff00 == 0xff00 => AddressClass::Forbidden,
        _ => AddressClass::Public,
    }
}

/// Whether an address may be reached under a policy.
pub fn address_allowed(ip: IpAddr, allow_private: bool) -> Result<(), FetchError> {
    match classify(ip) {
        AddressClass::Public => Ok(()),
        AddressClass::Private if allow_private => Ok(()),
        AddressClass::Private => Err(FetchError::PrivateNetwork),
        AddressClass::Forbidden => Err(FetchError::ForbiddenAddress),
    }
}

/// Why a fetch failed, in words a server owner can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    InvalidUrl,
    Scheme,
    PrivateNetwork,
    ForbiddenAddress,
    NotFound(String),
    TooManyRedirects,
    TimedOut,
    TooLarge,
    Connect(String),
    Status(u16),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl => f.write_str("That isn't a web address."),
            Self::Scheme => f.write_str("Only http and https addresses can be used."),
            Self::PrivateNetwork => f.write_str(LOCAL_NETWORK_REFUSAL),
            Self::ForbiddenAddress => f.write_str(
                "That address is a link-local, multicast or reserved address, which add-ons never reach.",
            ),
            Self::NotFound(host) => write!(f, "The address {host} could not be found."),
            Self::TooManyRedirects => f.write_str("The address redirected more than 3 times."),
            Self::TimedOut => f.write_str("The address took longer than 10 seconds to answer."),
            Self::TooLarge => f.write_str("The address sent back more than 2 MB."),
            Self::Connect(host) => write!(f, "Couldn't connect to {host}."),
            Self::Status(code) => write!(f, "The address returned {code}."),
        }
    }
}

impl std::error::Error for FetchError {}

/// One request through the fetcher.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(HeaderName, String)>,
    pub body: Option<Vec<u8>>,
}

impl FetchRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: Method::GET,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post_form(url: impl Into<String>, form: &[(&str, &str)]) -> Self {
        let body = form
            .iter()
            .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
            .collect::<Vec<_>>()
            .join("&");
        Self {
            method: Method::POST,
            url: url.into(),
            headers: vec![(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded".to_string(),
            )],
            body: Some(body.into_bytes()),
        }
    }

    pub fn header(mut self, name: HeaderName, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    /// Where the body came from after redirects.
    pub url: Url,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl FetchResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The fetcher, carrying the instance's policy for private addresses.
#[derive(Debug, Clone, Copy)]
pub struct SafeFetcher {
    allow_private: bool,
}

impl SafeFetcher {
    pub fn new(allow_private: bool) -> Self {
        Self { allow_private }
    }

    /// The fetcher under the instance admin's current setting.
    pub async fn for_instance(pool: &paracord_db::DbPool) -> Self {
        Self::new(local_network_allowed(pool).await)
    }

    pub fn allows_private(&self) -> bool {
        self.allow_private
    }

    /// Fetch under the policy. Any status comes back as a response; only a
    /// refused, unreachable, slow or oversized request is an error.
    pub async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        match tokio::time::timeout(FETCH_TIMEOUT, self.fetch_inner(request)).await {
            Ok(result) => result,
            Err(_) => Err(FetchError::TimedOut),
        }
    }

    async fn fetch_inner(&self, request: FetchRequest) -> Result<FetchResponse, FetchError> {
        let mut url = Url::parse(request.url.trim()).map_err(|_| FetchError::InvalidUrl)?;
        let mut method = request.method.clone();
        let mut body = request.body.clone();
        let mut redirects = 0usize;
        loop {
            let pinned = self.vet(&url).await?;
            let host = url.host_str().ok_or(FetchError::InvalidUrl)?.to_string();
            let mut builder = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(FETCH_TIMEOUT)
                .connect_timeout(FETCH_TIMEOUT)
                .user_agent(user_agent());
            if let Some(addrs) = &pinned {
                builder = builder.resolve_to_addrs(&host, addrs);
            }
            let client = builder
                .build()
                .map_err(|_| FetchError::Connect(host.clone()))?;
            let mut outgoing = client.request(method.clone(), url.clone());
            for (name, value) in &request.headers {
                if let Ok(value) = HeaderValue::from_str(value) {
                    outgoing = outgoing.header(name.clone(), value);
                }
            }
            if let Some(bytes) = &body {
                outgoing = outgoing.body(bytes.clone());
            }
            let response = outgoing.send().await.map_err(|err| {
                if err.is_timeout() {
                    FetchError::TimedOut
                } else {
                    FetchError::Connect(host.clone())
                }
            })?;
            let status = response.status();
            if status.is_redirection() && status != reqwest::StatusCode::NOT_MODIFIED {
                if redirects >= MAX_REDIRECTS {
                    return Err(FetchError::TooManyRedirects);
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(FetchError::Status(status.as_u16()))?;
                url = url.join(location).map_err(|_| FetchError::InvalidUrl)?;
                redirects += 1;
                // 303, and 301/302 after a POST, continue as GET.
                if status == reqwest::StatusCode::SEE_OTHER
                    || (method == Method::POST && matches!(status.as_u16(), 301 | 302))
                {
                    method = Method::GET;
                    body = None;
                }
                continue;
            }
            let headers = response.headers().clone();
            let final_url = response.url().clone();
            let body = read_capped(response).await?;
            return Ok(FetchResponse {
                status: status.as_u16(),
                url: final_url,
                headers,
                body,
            });
        }
    }

    /// Check a URL against the policy. `Some(addrs)` are the resolved
    /// addresses to connect to; `None` means the host is an IP literal that
    /// has already been checked.
    pub async fn vet(&self, url: &Url) -> Result<Option<Vec<SocketAddr>>, FetchError> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(FetchError::Scheme);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(FetchError::InvalidUrl);
        }
        let host = url.host_str().ok_or(FetchError::InvalidUrl)?;
        let port = url.port_or_known_default().ok_or(FetchError::InvalidUrl)?;
        if let Some(ip) = literal_ip(host) {
            address_allowed(ip, self.allow_private)?;
            return Ok(None);
        }
        let lookup = format!("{host}:{port}");
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host(lookup)
            .await
            .map_err(|_| FetchError::NotFound(host.to_string()))?
            .collect();
        if addrs.is_empty() {
            return Err(FetchError::NotFound(host.to_string()));
        }
        // One bad answer refuses the request: a name that resolves to a public
        // and a private address is exactly what a rebinding attack looks like.
        for addr in &addrs {
            address_allowed(addr.ip(), self.allow_private)?;
        }
        Ok(Some(addrs))
    }
}

/// An IP literal host as the URL parser normalized it. The parser already
/// turned decimal, octal and hex IPv4 spellings (`2130706433`, `0177.0.0.1`,
/// `0x7f.1`) into dotted form, and IPv6 hosts arrive in brackets.
fn literal_ip(host: &str) -> Option<IpAddr> {
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    trimmed.parse::<IpAddr>().ok()
}

async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, FetchError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(FetchError::TooLarge);
    }
    let mut body = Vec::new();
    loop {
        let chunk = response.chunk().await.map_err(|err| {
            if err.is_timeout() {
                FetchError::TimedOut
            } else {
                FetchError::Connect(
                    response
                        .url()
                        .host_str()
                        .unwrap_or("the address")
                        .to_string(),
                )
            }
        })?;
        let Some(chunk) = chunk else {
            break;
        };
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(FetchError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The instance admin's "Add-ons may reach this instance's local network".
pub async fn local_network_allowed(pool: &paracord_db::DbPool) -> bool {
    matches!(
        paracord_db::server_settings::get_setting(pool, LOCAL_NETWORK_SETTING).await,
        Ok(Some(value)) if value == "true"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("ip")
    }

    #[test]
    fn ipv4_ranges_are_classified() {
        for public in [
            "8.8.8.8",
            "1.1.1.1",
            "140.82.112.3",
            "100.63.255.255",
            "172.32.0.1",
        ] {
            assert_eq!(classify(ip(public)), AddressClass::Public, "{public}");
        }
        for private in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.20",
            "100.64.0.1",
            "100.127.255.255",
        ] {
            assert_eq!(classify(ip(private)), AddressClass::Private, "{private}");
        }
        for forbidden in [
            "0.0.0.0",
            "0.1.2.3",
            "169.254.169.254",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.2.1",
            "198.51.100.7",
            "203.0.113.9",
            "198.18.0.1",
            "192.0.0.8",
        ] {
            assert_eq!(
                classify(ip(forbidden)),
                AddressClass::Forbidden,
                "{forbidden}"
            );
        }
    }

    #[test]
    fn ipv6_ranges_are_classified() {
        for public in ["2606:4700::1111", "2a00:1450:4001::200e"] {
            assert_eq!(classify(ip(public)), AddressClass::Public, "{public}");
        }
        for private in ["::1", "fc00::1", "fd12:3456:789a::1"] {
            assert_eq!(classify(ip(private)), AddressClass::Private, "{private}");
        }
        for forbidden in [
            "::",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",
            "100::1",
            "64:ff9b:1::1",
        ] {
            assert_eq!(
                classify(ip(forbidden)),
                AddressClass::Forbidden,
                "{forbidden}"
            );
        }
    }

    #[test]
    fn ipv6_forms_that_carry_ipv4_are_judged_by_the_ipv4() {
        assert_eq!(classify(ip("::ffff:127.0.0.1")), AddressClass::Private);
        assert_eq!(classify(ip("::ffff:10.1.2.3")), AddressClass::Private);
        assert_eq!(
            classify(ip("::ffff:169.254.169.254")),
            AddressClass::Forbidden
        );
        assert_eq!(classify(ip("::ffff:8.8.8.8")), AddressClass::Public);
        assert_eq!(classify(ip("::127.0.0.1")), AddressClass::Private);
        assert_eq!(classify(ip("64:ff9b::7f00:1")), AddressClass::Private);
        assert_eq!(classify(ip("64:ff9b::808:808")), AddressClass::Public);
        assert_eq!(classify(ip("2002:7f00:0001::1")), AddressClass::Private);
        assert_eq!(classify(ip("2002:a9fe:a9fe::1")), AddressClass::Forbidden);
    }

    #[test]
    fn the_local_network_setting_opens_private_but_never_forbidden() {
        assert_eq!(
            address_allowed(ip("192.168.1.2"), false),
            Err(FetchError::PrivateNetwork)
        );
        assert_eq!(address_allowed(ip("192.168.1.2"), true), Ok(()));
        assert_eq!(address_allowed(ip("127.0.0.1"), true), Ok(()));
        assert_eq!(
            address_allowed(ip("169.254.169.254"), true),
            Err(FetchError::ForbiddenAddress)
        );
        assert_eq!(
            address_allowed(ip("::"), true),
            Err(FetchError::ForbiddenAddress)
        );
    }

    #[tokio::test]
    async fn decimal_octal_and_hex_spellings_of_loopback_are_refused() {
        let fetcher = SafeFetcher::new(false);
        for spelled in [
            "http://2130706433/",
            "http://0177.0.0.1/",
            "http://0x7f.0.0.1/",
            "http://0x7f.1/",
            "http://127.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::1]:8080/",
            "http://[0:0:0:0:0:ffff:7f00:1]/",
            "http://017700000001/",
        ] {
            let url = Url::parse(spelled).expect("url");
            assert_eq!(
                fetcher.vet(&url).await,
                Err(FetchError::PrivateNetwork),
                "{spelled} should be refused"
            );
        }
        let metadata = Url::parse("http://0xA9FEA9FE/latest/meta-data").expect("url");
        assert_eq!(
            fetcher.vet(&metadata).await,
            Err(FetchError::ForbiddenAddress)
        );
    }

    #[tokio::test]
    async fn only_http_and_https_are_fetched() {
        let fetcher = SafeFetcher::new(true);
        for url in [
            "file:///etc/passwd",
            "gopher://example.com/",
            "ftp://example.com/x",
        ] {
            let url = Url::parse(url).expect("url");
            assert_eq!(fetcher.vet(&url).await, Err(FetchError::Scheme));
        }
        let with_credentials = Url::parse("https://user:pass@example.com/").expect("url");
        assert_eq!(
            fetcher.vet(&with_credentials).await,
            Err(FetchError::InvalidUrl)
        );
    }

    #[tokio::test]
    async fn localhost_names_resolve_and_are_refused() {
        let fetcher = SafeFetcher::new(false);
        let url = Url::parse("http://localhost:9/").expect("url");
        assert_eq!(fetcher.vet(&url).await, Err(FetchError::PrivateNetwork));
    }

    #[tokio::test]
    async fn a_redirect_to_loopback_is_refused_at_the_hop() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // A tiny server on loopback that redirects to another loopback port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        });
        // With private targets allowed the first hop connects, and so would the
        // redirect; with them refused not even the first hop does.
        let refused = SafeFetcher::new(false)
            .fetch(FetchRequest::get(format!("http://127.0.0.1:{port}/start")))
            .await;
        assert_eq!(refused.unwrap_err(), FetchError::PrivateNetwork);

        // A redirect from an allowed address to a forbidden one stops at the hop.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 301 Moved\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        });
        let hop = SafeFetcher::new(true)
            .fetch(FetchRequest::get(format!("http://127.0.0.1:{port}/start")))
            .await;
        assert_eq!(hop.unwrap_err(), FetchError::ForbiddenAddress);
    }

    #[tokio::test]
    async fn redirects_stop_after_three() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        let result = SafeFetcher::new(true)
            .fetch(FetchRequest::get(format!("http://127.0.0.1:{port}/")))
            .await;
        assert_eq!(result.unwrap_err(), FetchError::TooManyRedirects);
    }

    #[tokio::test]
    async fn a_body_over_two_megabytes_is_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                    .await;
                let chunk = vec![b'a'; 64 * 1024];
                for _ in 0..40 {
                    if socket.write_all(&chunk).await.is_err() {
                        break;
                    }
                }
            }
        });
        let result = SafeFetcher::new(true)
            .fetch(FetchRequest::get(format!("http://127.0.0.1:{port}/big")))
            .await;
        assert_eq!(result.unwrap_err(), FetchError::TooLarge);
    }
}
