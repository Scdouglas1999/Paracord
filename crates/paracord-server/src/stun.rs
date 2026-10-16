//! What public address this network's traffic arrives from, asked of a STUN
//! server (RFC 8489 Binding), for when the router will not say.
//!
//! The router is always asked first ([`crate::portmap`]): its own report is the
//! best source there is. Some routers answer neither UPnP nor NAT-PMP/PCP, and
//! then the only way to learn the outside address without a web "what is my IP"
//! service is to send one STUN Binding Request to a public STUN server and read
//! the XOR-MAPPED-ADDRESS it sends back. That is a protocol, not a relay: one
//! UDP datagram out, one back, and the server learns nothing it would not see
//! from any packet this network sends.
//!
//! The owner decides whether it happens at all: `[network]
//! external_address_stun_servers` lists the servers, in order, and an empty list
//! turns it off. The answer only names an address; it never says the way in is
//! open (that stays the router's word, or a connection seen from outside).
//!
//! The codec is hand-written (a 20-byte header and one attribute) so it needs no
//! dependency, and it is tested on fixed bytes with no network.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::time::Duration;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The servers asked when the config does not say. Two operators, so one
/// being down does not lose the answer.
pub const DEFAULT_SERVERS: [&str; 2] = ["stun.cloudflare.com:3478", "stun.l.google.com:19302"];

/// Ceiling on one discovery across every listed server.
pub const DISCOVERY_BUDGET: Duration = Duration::from_secs(4);

/// The first retransmission timeout (RFC 8489 §6.2.1 recommends 500 ms).
const INITIAL_RTO: Duration = Duration::from_millis(500);

const MAGIC_COOKIE: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const BINDING_ERROR: u16 = 0x0111;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const ATTR_ERROR_CODE: u16 = 0x0009;
const HEADER_LEN: usize = 20;

/// A Binding Request with no attributes.
pub fn binding_request(transaction_id: &[u8; 12]) -> [u8; HEADER_LEN] {
    let mut packet = [0u8; HEADER_LEN];
    packet[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Message length 0: no attributes.
    packet[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    packet[8..20].copy_from_slice(transaction_id);
    packet
}

/// Why a datagram was not a usable answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StunError {
    /// Shorter than a header, or an attribute runs past the end.
    Truncated,
    /// Not a STUN message (top bits set or no magic cookie).
    NotStun,
    /// A STUN message, but for another request.
    WrongTransaction,
    /// The server answered with an error response.
    ErrorResponse(String),
    /// A message type other than a Binding response.
    UnexpectedType(u16),
    /// A success response with no XOR-MAPPED-ADDRESS.
    NoMappedAddress,
    /// An address family other than IPv4 (1) or IPv6 (2).
    BadFamily(u8),
}

impl std::fmt::Display for StunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StunError::Truncated => write!(f, "the answer was cut short"),
            StunError::NotStun => write!(f, "the answer was not a STUN message"),
            StunError::WrongTransaction => write!(f, "the answer was for another request"),
            StunError::ErrorResponse(reason) => write!(f, "the server said no ({reason})"),
            StunError::UnexpectedType(kind) => write!(f, "unexpected message type {kind:#06x}"),
            StunError::NoMappedAddress => write!(f, "the answer did not include an address"),
            StunError::BadFamily(family) => write!(f, "unknown address family {family}"),
        }
    }
}

/// Read the address a Binding success response reports, after checking it
/// answers `transaction_id`.
pub fn parse_binding_response(
    packet: &[u8],
    transaction_id: &[u8; 12],
) -> Result<SocketAddr, StunError> {
    if packet.len() < HEADER_LEN {
        return Err(StunError::Truncated);
    }
    let kind = u16::from_be_bytes([packet[0], packet[1]]);
    let length = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    let cookie = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    if kind & 0xC000 != 0 || cookie != MAGIC_COOKIE {
        return Err(StunError::NotStun);
    }
    if &packet[8..20] != transaction_id {
        return Err(StunError::WrongTransaction);
    }
    let body = packet
        .get(HEADER_LEN..HEADER_LEN + length)
        .ok_or(StunError::Truncated)?;

    let mut offset = 0;
    let mut mapped: Option<SocketAddr> = None;
    let mut error: Option<String> = None;
    while offset + 4 <= body.len() {
        let attr = u16::from_be_bytes([body[offset], body[offset + 1]]);
        let len = usize::from(u16::from_be_bytes([body[offset + 2], body[offset + 3]]));
        let value = body
            .get(offset + 4..offset + 4 + len)
            .ok_or(StunError::Truncated)?;
        match attr {
            ATTR_XOR_MAPPED_ADDRESS if mapped.is_none() => {
                mapped = Some(decode_xor_address(value, transaction_id)?);
            }
            ATTR_ERROR_CODE if value.len() >= 4 => {
                let code = u16::from(value[2] & 0x07) * 100 + u16::from(value[3]);
                let phrase = String::from_utf8_lossy(&value[4..]).trim().to_string();
                error = Some(format!("{code} {phrase}").trim().to_string());
            }
            _ => {}
        }
        // Attributes are padded to a multiple of four bytes.
        offset += 4 + len.div_ceil(4) * 4;
    }

    match kind {
        BINDING_SUCCESS => mapped.ok_or(StunError::NoMappedAddress),
        BINDING_ERROR => Err(StunError::ErrorResponse(
            error.unwrap_or_else(|| "no reason given".to_string()),
        )),
        other => Err(StunError::UnexpectedType(other)),
    }
}

fn decode_xor_address(value: &[u8], transaction_id: &[u8; 12]) -> Result<SocketAddr, StunError> {
    if value.len() < 4 {
        return Err(StunError::Truncated);
    }
    let family = value[1];
    let cookie = MAGIC_COOKIE.to_be_bytes();
    let port = u16::from_be_bytes([value[2], value[3]]) ^ (MAGIC_COOKIE >> 16) as u16;
    match family {
        0x01 => {
            let raw = value.get(4..8).ok_or(StunError::Truncated)?;
            let mut octets = [0u8; 4];
            for (i, byte) in octets.iter_mut().enumerate() {
                *byte = raw[i] ^ cookie[i];
            }
            Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(octets)), port))
        }
        0x02 => {
            let raw = value.get(4..20).ok_or(StunError::Truncated)?;
            let mut key = [0u8; 16];
            key[..4].copy_from_slice(&cookie);
            key[4..].copy_from_slice(transaction_id);
            let mut octets = [0u8; 16];
            for (i, byte) in octets.iter_mut().enumerate() {
                *byte = raw[i] ^ key[i];
            }
            Ok(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port))
        }
        other => Err(StunError::BadFamily(other)),
    }
}

/// The answer a discovery produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub ip: IpAddr,
    /// The server that answered, as configured (`host:port`).
    pub server: String,
}

/// Asks what public address this network's traffic comes from. Behind a trait
/// so the reachability state machine is tested without a network.
pub trait PublicAddressProbe: Send + Sync {
    /// `local`: this computer's address on the interface the server listens
    /// on, which the question is sent from, so the answer is about the path
    /// friends would use rather than a VPN or a container bridge.
    fn discover(&self, local: Option<IpAddr>) -> BoxFuture<'_, Result<Observed, String>>;
}

/// The real probe: the configured servers, in order, under one budget.
pub struct StunProbe {
    servers: Vec<String>,
    budget: Duration,
}

impl StunProbe {
    /// `None` when the list is empty: discovery is off.
    pub fn new(servers: &[String]) -> Option<Self> {
        let servers: Vec<String> = servers
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        (!servers.is_empty()).then_some(Self {
            servers,
            budget: DISCOVERY_BUDGET,
        })
    }
}

impl PublicAddressProbe for StunProbe {
    fn discover(&self, local: Option<IpAddr>) -> BoxFuture<'_, Result<Observed, String>> {
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + self.budget;
            let mut reasons: Vec<String> = Vec::new();
            for server in &self.servers {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    reasons.push(format!(
                        "{server}: not asked, the {}s budget was spent",
                        self.budget.as_secs()
                    ));
                    continue;
                }
                match tokio::time::timeout(remaining, ask(server, local)).await {
                    Ok(Ok(ip)) => {
                        return Ok(Observed {
                            ip,
                            server: server.clone(),
                        })
                    }
                    Ok(Err(reason)) => reasons.push(format!("{server}: {reason}")),
                    Err(_) => reasons.push(format!("{server}: no answer in time")),
                }
            }
            Err(reasons.join("; "))
        })
    }
}

/// One server: resolve it to IPv4, send the request from `local`, retransmit
/// at a doubling interval until an answer for this transaction arrives.
async fn ask(server: &str, local: Option<IpAddr>) -> Result<IpAddr, String> {
    let target = tokio::net::lookup_host(server)
        .await
        .map_err(|err| format!("could not look up the server ({err})"))?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| "the server has no IPv4 address".to_string())?;
    let bind_ip = match local {
        Some(ip @ IpAddr::V4(_)) => ip,
        _ => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    };
    let socket = tokio::net::UdpSocket::bind(SocketAddr::new(bind_ip, 0))
        .await
        .map_err(|err| format!("could not open a socket on {bind_ip} ({err})"))?;
    let transaction_id: [u8; 12] = rand::random();
    let request = binding_request(&transaction_id);
    let mut buf = [0u8; 576];
    let mut rto = INITIAL_RTO;
    let mut last_problem: Option<String> = None;
    loop {
        socket
            .send_to(&request, target)
            .await
            .map_err(|err| format!("could not send to {target} ({err})"))?;
        let wait_until = tokio::time::Instant::now() + rto;
        loop {
            let received = tokio::time::timeout_at(wait_until, socket.recv_from(&mut buf)).await;
            let (len, from) = match received {
                Err(_) => break,
                Ok(Err(err)) => return Err(format!("could not read the answer ({err})")),
                Ok(Ok(got)) => got,
            };
            if from != target {
                continue;
            }
            match parse_binding_response(&buf[..len], &transaction_id) {
                Ok(mapped) => return Ok(mapped.ip()),
                // A stray or late datagram for another request: keep waiting.
                Err(StunError::WrongTransaction | StunError::NotStun) => {
                    last_problem = Some("answers that were not for this request".into());
                }
                Err(err) => return Err(err.to_string()),
            }
        }
        rto = (rto * 2).min(Duration::from_secs(2));
        if let Some(problem) = last_problem.as_deref() {
            tracing::debug!(target: "paracord::stun", server, problem, "retrying");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: [u8; 12] = [
        0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
    ];

    /// RFC 5769 §2.2: the sample IPv4 response, which maps to 192.0.2.1:32853.
    /// Trimmed to the header and XOR-MAPPED-ADDRESS (the SOFTWARE, INTEGRITY and
    /// FINGERPRINT attributes that follow are skipped by length either way).
    fn rfc5769_ipv4_response() -> Vec<u8> {
        let mut packet = vec![
            0x01, 0x01, 0x00, 0x0c, // Binding success, 12 bytes of attributes
            0x21, 0x12, 0xa4, 0x42, // magic cookie
        ];
        packet.extend_from_slice(&TXID);
        packet.extend_from_slice(&[
            0x00, 0x20, 0x00, 0x08, // XOR-MAPPED-ADDRESS, 8 bytes
            0x00, 0x01, 0xa1, 0x47, // IPv4, x-port
            0xe1, 0x12, 0xa6, 0x43, // x-address
        ]);
        packet
    }

    #[test]
    fn the_request_is_a_bare_binding_request() {
        let packet = binding_request(&TXID);
        assert_eq!(&packet[0..4], &[0x00, 0x01, 0x00, 0x00]);
        assert_eq!(&packet[4..8], &[0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(&packet[8..], &TXID);
    }

    #[test]
    fn decodes_the_rfc5769_ipv4_sample() {
        let mapped = parse_binding_response(&rfc5769_ipv4_response(), &TXID).unwrap();
        assert_eq!(mapped, "192.0.2.1:32853".parse().unwrap());
    }

    #[test]
    fn decodes_the_rfc5769_ipv6_sample() {
        // RFC 5769 §2.3: 2001:db8:1234:5678:11:2233:4455:6677 port 32853.
        let mut packet = vec![0x01, 0x01, 0x00, 0x18, 0x21, 0x12, 0xa4, 0x42];
        packet.extend_from_slice(&TXID);
        packet.extend_from_slice(&[
            0x00, 0x20, 0x00, 0x14, 0x00, 0x02, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3,
            0xf1, 0x79, 0xbc, 0x25, 0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9,
        ]);
        let mapped = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(
            mapped,
            "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                .parse()
                .unwrap()
        );
    }

    #[test]
    fn an_answer_to_another_request_is_rejected() {
        let mut other = TXID;
        other[11] ^= 0xff;
        assert_eq!(
            parse_binding_response(&rfc5769_ipv4_response(), &other),
            Err(StunError::WrongTransaction)
        );
    }

    #[test]
    fn short_foreign_and_empty_answers_are_rejected() {
        let good = rfc5769_ipv4_response();
        assert_eq!(
            parse_binding_response(&good[..12], &TXID),
            Err(StunError::Truncated)
        );
        // Length says more than arrived.
        assert_eq!(
            parse_binding_response(&good[..good.len() - 2], &TXID),
            Err(StunError::Truncated)
        );
        let mut no_cookie = good.clone();
        no_cookie[4] = 0;
        assert_eq!(
            parse_binding_response(&no_cookie, &TXID),
            Err(StunError::NotStun)
        );
        // A success with no address in it.
        let mut empty = good[..HEADER_LEN].to_vec();
        empty[3] = 0;
        assert_eq!(
            parse_binding_response(&empty, &TXID),
            Err(StunError::NoMappedAddress)
        );
    }

    #[test]
    fn an_error_response_carries_its_reason() {
        let mut packet = vec![0x01, 0x11, 0x00, 0x10, 0x21, 0x12, 0xa4, 0x42];
        packet.extend_from_slice(&TXID);
        // ERROR-CODE 400 "Bad", padded to 8 bytes of value.
        packet.extend_from_slice(&[
            0x00, 0x09, 0x00, 0x07, 0x00, 0x00, 0x04, 0x00, b'B', b'a', b'd', 0x00,
        ]);
        packet.extend_from_slice(&[0x80, 0x22, 0x00, 0x00]); // SOFTWARE, empty
        assert_eq!(
            parse_binding_response(&packet, &TXID),
            Err(StunError::ErrorResponse("400 Bad".into()))
        );
    }

    #[test]
    fn unknown_attributes_before_the_address_are_skipped_with_padding() {
        let mut packet = vec![0x01, 0x01, 0x00, 0x14, 0x21, 0x12, 0xa4, 0x42];
        packet.extend_from_slice(&TXID);
        // SOFTWARE "abcde" (5 bytes, padded to 8), then the address.
        packet.extend_from_slice(&[
            0x80, 0x22, 0x00, 0x05, b'a', b'b', b'c', b'd', b'e', 0, 0, 0,
        ]);
        packet.extend_from_slice(&[
            0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43,
        ]);
        // Length field: 12 + 12 = 24 = 0x18.
        packet[3] = 0x18;
        let mapped = parse_binding_response(&packet, &TXID).unwrap();
        assert_eq!(mapped, "192.0.2.1:32853".parse().unwrap());
    }

    #[test]
    fn an_empty_server_list_turns_discovery_off() {
        assert!(StunProbe::new(&[]).is_none());
        assert!(StunProbe::new(&["  ".to_string()]).is_none());
        assert!(StunProbe::new(&["stun.example.net:3478".to_string()]).is_some());
    }
}
