//! Game servers add-on: whether a community's Minecraft or Valve-game server
//! is up and who is on it.
//!
//! This module speaks the protocols and applies the address policy. The HTTP
//! layer (`paracord-api`'s `routes::game_servers`) owns permissions, storage,
//! the poller and announcements, the same split Feeds uses.
//!
//! Every probe resolves the address first, checks every resolved address with
//! the Feeds policy ([`crate::feeds::address_allowed`], opened to private
//! networks only by the instance admin's "Add-ons may reach this instance's
//! local network"), and then connects only to the addresses it checked.
//!
//! Minecraft `_minecraft._tcp` SRV records are not followed: no DNS resolver
//! that reads SRV records is in the dependency tree. A server published only
//! through an SRV record is added by its real host and port.

pub mod a2s;
pub mod bedrock;
pub mod minecraft;
mod text;
mod wire;

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use tokio::net::{TcpStream, UdpSocket};
use tokio::time::Instant;

use crate::feeds::{address_allowed, FetchError, LOCAL_NETWORK_REFUSAL};
pub use text::{clip, first_line, plain_text, MAX_TEXT_CHARS};
pub use wire::WireError;

/// Longest a probe may take, name lookup included.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often a game server is checked.
pub const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Failed checks in a row before a server that was up counts as down.
pub const DOWN_AFTER_FAILURES: i64 = 3;
/// Game servers one Paracord server may list.
pub const MAX_GAME_SERVERS_PER_GUILD: i64 = 10;
/// Player names kept per game server.
pub const MAX_PLAYER_NAMES: usize = 24;

/// Which protocol a game server speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GameKind {
    MinecraftJava,
    MinecraftBedrock,
    /// Valve's A2S queries: Counter-Strike 2, Team Fortress 2, Garry's Mod,
    /// Rust, Valheim, ARK and most other Steam dedicated servers.
    Source,
    /// Only whether a TCP port accepts connections.
    Tcp,
}

impl GameKind {
    pub const ALL: [GameKind; 4] = [
        GameKind::MinecraftJava,
        GameKind::MinecraftBedrock,
        GameKind::Source,
        GameKind::Tcp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            GameKind::MinecraftJava => "minecraft_java",
            GameKind::MinecraftBedrock => "minecraft_bedrock",
            GameKind::Source => "source",
            GameKind::Tcp => "tcp",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str().eq_ignore_ascii_case(raw.trim()))
    }

    /// The port a bare host means.
    pub fn default_port(self) -> Option<u16> {
        match self {
            GameKind::MinecraftJava => Some(25565),
            GameKind::MinecraftBedrock => Some(19132),
            GameKind::Source => Some(27015),
            GameKind::Tcp => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            GameKind::MinecraftJava => "Minecraft: Java Edition",
            GameKind::MinecraftBedrock => "Minecraft: Bedrock Edition",
            GameKind::Source => "Source / Steam",
            GameKind::Tcp => "Other",
        }
    }
}

/// A game server's address: a host name or IP address, and a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameAddress {
    /// Lowercase; an IPv6 address without brackets.
    pub host: String,
    pub port: u16,
}

impl GameAddress {
    /// Read `host`, `host:port`, `a.b.c.d:port`, `[v6]:port` or a bare IPv6
    /// address. A missing port is the game's default.
    pub fn parse(raw: &str, kind: GameKind) -> Result<Self, ProbeError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(ProbeError::Address("Type the server's address.".into()));
        }
        if raw.contains("://") || raw.contains('/') {
            return Err(ProbeError::Address(
                "Type just the host and port, like play.example.com:25565.".into(),
            ));
        }
        if raw.chars().any(char::is_whitespace) {
            return Err(ProbeError::Address(
                "Remove the gaps from the address.".into(),
            ));
        }
        let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
            let (inside, after) = rest.split_once(']').ok_or_else(|| {
                ProbeError::Address("An IPv6 address in brackets needs its closing ].".into())
            })?;
            let port = match after {
                "" => None,
                _ => Some(after.strip_prefix(':').ok_or_else(|| {
                    ProbeError::Address("Put a colon between the address and the port.".into())
                })?),
            };
            (inside, port)
        } else if raw.matches(':').count() > 1 {
            // A bare IPv6 address.
            (raw, None)
        } else {
            match raw.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (raw, None),
            }
        };
        let port = match port {
            Some(port) => port
                .parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or_else(|| ProbeError::Address("A port is a number from 1 to 65535.".into()))?,
            None => kind.default_port().ok_or_else(|| {
                ProbeError::Address("Add the port, like example.com:7777.".into())
            })?,
        };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if host.parse::<IpAddr>().is_err() && !is_host_name(&host) {
            return Err(ProbeError::Address(
                "That isn't a host name or an IP address.".into(),
            ));
        }
        Ok(Self { host, port })
    }

    /// `host:port`, with an IPv6 host in brackets: what people paste into a game.
    pub fn display(&self) -> String {
        match self.host.parse::<IpAddr>() {
            Ok(IpAddr::V6(_)) => format!("[{}]:{}", self.host, self.port),
            _ => format!("{}:{}", self.host, self.port),
        }
    }

    /// What identifies one probe target: servers listing the same address with
    /// the same protocol share one probe.
    pub fn key(&self, kind: GameKind) -> String {
        format!("{}|{}", kind.as_str(), self.display())
    }
}

fn is_host_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
}

/// Why a probe failed, in words a server owner can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// The address itself is unusable.
    Address(String),
    PrivateNetwork,
    ForbiddenAddress,
    NotFound(String),
    TimedOut,
    Refused,
    /// A TCP server accepted, then hung up before answering.
    Closed,
    Unreachable(String),
    /// Something answered, but not in the game's protocol.
    Reply {
        kind: GameKind,
        detail: String,
    },
}

impl ProbeError {
    /// The address can never be probed as typed: refuse it outright. Every
    /// other error means the server is down right now.
    pub fn is_refusal(&self) -> bool {
        matches!(
            self,
            Self::Address(_) | Self::PrivateNetwork | Self::ForbiddenAddress
        )
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Address(message) => f.write_str(message),
            Self::PrivateNetwork => f.write_str(LOCAL_NETWORK_REFUSAL),
            Self::ForbiddenAddress => f.write_str(&FetchError::ForbiddenAddress.to_string()),
            Self::NotFound(host) => write!(f, "The address {host} could not be found."),
            Self::TimedOut => f.write_str("No answer within 3 seconds."),
            Self::Refused => f.write_str("Nothing is accepting connections on that port."),
            Self::Closed => f.write_str("The server hung up without answering."),
            Self::Unreachable(host) => write!(f, "Couldn't reach {host}."),
            Self::Reply { kind, detail } => write!(
                f,
                "Something answered, but not as a {} server: {detail}.",
                kind.label()
            ),
        }
    }
}

impl std::error::Error for ProbeError {}

impl From<FetchError> for ProbeError {
    fn from(err: FetchError) -> Self {
        match err {
            FetchError::PrivateNetwork => Self::PrivateNetwork,
            _ => Self::ForbiddenAddress,
        }
    }
}

/// What a game server said when it answered.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GameStatus {
    /// The server's own name (Valve server name, first line of a Minecraft
    /// message of the day), for the default display name.
    pub name: Option<String>,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    /// `None` when the protocol does not say who is on.
    pub player_names: Option<Vec<String>>,
    pub map: Option<String>,
    pub version: Option<String>,
    pub motd: Option<String>,
    pub latency_ms: u32,
}

fn millis(duration: Duration) -> u32 {
    duration.as_millis().min(u128::from(u32::MAX)) as u32
}

/// Probe a game server under the instance's address policy, within
/// [`PROBE_TIMEOUT`].
pub async fn probe(
    kind: GameKind,
    address: &GameAddress,
    allow_private: bool,
) -> Result<GameStatus, ProbeError> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let addrs = within(deadline, resolve(address, allow_private)).await??;
    match kind {
        GameKind::MinecraftJava => probe_java(address, &addrs, deadline).await,
        GameKind::MinecraftBedrock => probe_bedrock(address, &addrs, deadline).await,
        GameKind::Source => probe_source(address, &addrs, deadline).await,
        GameKind::Tcp => {
            let started = std::time::Instant::now();
            connect(address, &addrs, deadline).await?;
            Ok(GameStatus {
                latency_ms: millis(started.elapsed()),
                ..GameStatus::default()
            })
        }
    }
}

async fn within<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = T>,
) -> Result<T, ProbeError> {
    tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| ProbeError::TimedOut)
}

/// Resolve and check every address. One refused address refuses the lot: a
/// name answering with a public and a private address is what DNS rebinding
/// looks like.
pub async fn resolve(
    address: &GameAddress,
    allow_private: bool,
) -> Result<Vec<SocketAddr>, ProbeError> {
    if let Ok(ip) = address.host.parse::<IpAddr>() {
        address_allowed(ip, allow_private)?;
        return Ok(vec![SocketAddr::new(ip, address.port)]);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((address.host.as_str(), address.port))
        .await
        .map_err(|_| ProbeError::NotFound(address.host.clone()))?
        .collect();
    if addrs.is_empty() {
        return Err(ProbeError::NotFound(address.host.clone()));
    }
    for addr in &addrs {
        address_allowed(addr.ip(), allow_private)?;
    }
    Ok(addrs)
}

fn io_error(address: &GameAddress, err: &std::io::Error) -> ProbeError {
    match err.kind() {
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset => {
            ProbeError::Refused
        }
        std::io::ErrorKind::TimedOut => ProbeError::TimedOut,
        _ => ProbeError::Unreachable(address.host.clone()),
    }
}

/// Connect to the first checked address that accepts.
async fn connect(
    address: &GameAddress,
    addrs: &[SocketAddr],
    deadline: Instant,
) -> Result<TcpStream, ProbeError> {
    let mut last = ProbeError::Unreachable(address.host.clone());
    for addr in addrs {
        match within(deadline, TcpStream::connect(addr)).await? {
            Ok(stream) => return Ok(stream),
            Err(err) => last = io_error(address, &err),
        }
    }
    Err(last)
}

/// A UDP socket connected to the first checked address, IPv4 first: an
/// instance without IPv6 routing would otherwise wait out every probe.
async fn udp(address: &GameAddress, addrs: &[SocketAddr]) -> Result<UdpSocket, ProbeError> {
    let target = addrs
        .iter()
        .find(|addr| addr.is_ipv4())
        .or_else(|| addrs.first())
        .copied()
        .ok_or_else(|| ProbeError::NotFound(address.host.clone()))?;
    let local: SocketAddr = if target.is_ipv4() {
        "0.0.0.0:0".parse().expect("any v4")
    } else {
        "[::]:0".parse().expect("any v6")
    };
    let socket = UdpSocket::bind(local)
        .await
        .map_err(|err| io_error(address, &err))?;
    socket
        .connect(target)
        .await
        .map_err(|err| io_error(address, &err))?;
    Ok(socket)
}

fn reply_error(kind: GameKind, err: WireError) -> ProbeError {
    ProbeError::Reply {
        kind,
        detail: err.to_string(),
    }
}

async fn probe_java(
    address: &GameAddress,
    addrs: &[SocketAddr],
    deadline: Instant,
) -> Result<GameStatus, ProbeError> {
    let mut stream = connect(address, addrs, deadline).await?;
    let (status, latency) = within(
        deadline,
        minecraft::query(&mut stream, &address.host, address.port),
    )
    .await?
    .map_err(|err| match err {
        // Connected, so a reset now is the server hanging up, not a closed port.
        minecraft::QueryError::Io(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
            ) =>
        {
            ProbeError::Closed
        }
        minecraft::QueryError::Io(err) => io_error(address, &err),

        minecraft::QueryError::Wire(err) => reply_error(GameKind::MinecraftJava, err),
    })?;
    Ok(GameStatus {
        name: status
            .motd
            .as_deref()
            .map(|motd| first_line(motd).to_string()),
        players_online: status.players_online,
        players_max: status.players_max,
        player_names: status.player_names,
        map: None,
        version: status.version,
        motd: status.motd,
        latency_ms: millis(latency),
    })
}

async fn probe_bedrock(
    address: &GameAddress,
    addrs: &[SocketAddr],
    deadline: Instant,
) -> Result<GameStatus, ProbeError> {
    let socket = udp(address, addrs).await?;
    let (status, latency) = within(deadline, bedrock::query(&socket))
        .await?
        .map_err(|err| match err {
            bedrock::QueryError::Io(err) => io_error(address, &err),
            bedrock::QueryError::Wire(err) => reply_error(GameKind::MinecraftBedrock, err),
        })?;
    Ok(GameStatus {
        name: status.motd.clone(),
        players_online: status.players_online,
        players_max: status.players_max,
        player_names: None,
        map: status.level,
        version: status.version,
        motd: status.motd,
        latency_ms: millis(latency),
    })
}

async fn probe_source(
    address: &GameAddress,
    addrs: &[SocketAddr],
    deadline: Instant,
) -> Result<GameStatus, ProbeError> {
    let socket = udp(address, addrs).await?;
    let source_error = |err| match err {
        a2s::QueryError::Io(err) => io_error(address, &err),
        a2s::QueryError::Wire(err) => reply_error(GameKind::Source, err),
    };
    let (info, latency) = within(deadline, a2s::query_info(&socket))
        .await?
        .map_err(source_error)?;
    // Who is on is a second exchange in whatever time is left. A server that
    // does not answer it (many hide their players) is still up.
    let player_names = match within(deadline, a2s::query_players(&socket)).await {
        Ok(Ok(names)) => Some(names),
        _ => None,
    };
    Ok(GameStatus {
        name: info.name,
        players_online: Some(u32::from(info.players)),
        players_max: Some(u32::from(info.max_players)),
        player_names: player_names.filter(|names| !names.is_empty() || info.players == 0),
        map: info.map,
        version: info.version,
        motd: info.game,
        latency_ms: millis(latency),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str, kind: GameKind) -> Result<GameAddress, ProbeError> {
        GameAddress::parse(raw, kind)
    }

    #[test]
    fn addresses_take_the_game_default_port() {
        let java = parse("Play.Example.com", GameKind::MinecraftJava).unwrap();
        assert_eq!(java.host, "play.example.com");
        assert_eq!(java.port, 25565);
        assert_eq!(java.display(), "play.example.com:25565");
        assert_eq!(
            parse("mc.example.com.", GameKind::MinecraftBedrock)
                .unwrap()
                .display(),
            "mc.example.com:19132"
        );
        assert_eq!(
            parse("203.0.113.9", GameKind::Source).unwrap().display(),
            "203.0.113.9:27015"
        );
        assert!(
            parse("example.com", GameKind::Tcp).is_err(),
            "tcp needs a port"
        );
        assert_eq!(parse("example.com:7777", GameKind::Tcp).unwrap().port, 7777);
    }

    #[test]
    fn ipv6_addresses_with_and_without_brackets() {
        let bracketed = parse("[2001:DB8::1]:27016", GameKind::Source).unwrap();
        assert_eq!(bracketed.host, "2001:db8::1");
        assert_eq!(bracketed.port, 27016);
        assert_eq!(bracketed.display(), "[2001:db8::1]:27016");
        let bare = parse("2001:db8::1", GameKind::MinecraftJava).unwrap();
        assert_eq!(bare.port, 25565);
        assert_eq!(
            bracketed.key(GameKind::Source),
            "source|[2001:db8::1]:27016"
        );
    }

    #[test]
    fn nonsense_addresses_are_refused_in_words() {
        for raw in [
            "",
            "   ",
            "http://example.com",
            "example.com/path",
            "exa mple.com",
            "example.com:0",
            "example.com:70000",
            "example.com:port",
            "[2001:db8::1",
            "[2001:db8::1]27015",
            "-bad-.example.com",
            "a..b",
            "bad!host",
        ] {
            let err = parse(raw, GameKind::MinecraftJava).unwrap_err();
            assert!(err.is_refusal(), "{raw}");
            assert!(!err.to_string().is_empty());
        }
        let long = format!("{}.com", "a".repeat(64));
        assert!(parse(&long, GameKind::MinecraftJava).is_err());
    }

    #[tokio::test]
    async fn private_and_reserved_addresses_are_refused_before_any_packet() {
        let loopback = parse("127.0.0.1:25565", GameKind::MinecraftJava).unwrap();
        assert_eq!(
            probe(GameKind::MinecraftJava, &loopback, false).await,
            Err(ProbeError::PrivateNetwork)
        );
        let named = parse("localhost:25565", GameKind::MinecraftJava).unwrap();
        assert_eq!(
            probe(GameKind::MinecraftJava, &named, false).await,
            Err(ProbeError::PrivateNetwork)
        );
        let metadata = parse("169.254.169.254:80", GameKind::Tcp).unwrap();
        assert_eq!(
            probe(GameKind::Tcp, &metadata, true).await,
            Err(ProbeError::ForbiddenAddress)
        );
        let mapped = parse("[::ffff:10.0.0.1]:27015", GameKind::Source).unwrap();
        assert_eq!(
            probe(GameKind::Source, &mapped, false).await,
            Err(ProbeError::PrivateNetwork)
        );
    }

    #[tokio::test]
    async fn a_closed_port_reads_as_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let address = parse(&format!("127.0.0.1:{port}"), GameKind::Tcp).unwrap();
        assert_eq!(
            probe(GameKind::Tcp, &address, true).await,
            Err(ProbeError::Refused)
        );
    }

    #[tokio::test]
    async fn a_silent_udp_server_times_out_in_three_seconds() {
        let silent = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = silent.local_addr().unwrap().port();
        let address = parse(&format!("127.0.0.1:{port}"), GameKind::Source).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            probe(GameKind::Source, &address, true).await,
            Err(ProbeError::TimedOut)
        );
        let took = started.elapsed();
        assert!(
            took >= PROBE_TIMEOUT && took < PROBE_TIMEOUT + Duration::from_secs(1),
            "{took:?}"
        );
        drop(silent);
    }
}
