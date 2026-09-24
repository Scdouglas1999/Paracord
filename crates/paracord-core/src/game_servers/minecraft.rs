//! Minecraft: Java Edition Server List Ping, the status exchange the game's
//! own server list uses: a handshake asking for the status state, a status
//! request, and one reply holding a JSON document.
//!
//! <https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping>

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::text::{plain_option, plain_text};
use super::wire::{peek_varint, write_varint, Reader, WireError};

/// The protocol version the handshake names (1.21). Status replies do not
/// depend on it.
pub const PROTOCOL_VERSION: i32 = 767;
/// Largest status packet read. The JSON carries a base64 favicon, which is
/// what makes real replies tens of kilobytes.
pub const MAX_PACKET_BYTES: usize = 256 * 1024;
/// Player names kept from the sample.
pub const MAX_PLAYER_NAMES: usize = 24;

/// What a Java server says about itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JavaStatus {
    pub version: Option<String>,
    pub motd: Option<String>,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    /// `None` when the server does not list who is on.
    pub player_names: Option<Vec<String>>,
}

/// The handshake (next state: status) and the status request, framed.
pub fn status_request(host: &str, port: u16) -> Vec<u8> {
    let mut handshake = Vec::with_capacity(host.len() + 16);
    write_varint(&mut handshake, 0x00);
    write_varint(&mut handshake, PROTOCOL_VERSION);
    write_varint(&mut handshake, host.len() as i32);
    handshake.extend_from_slice(host.as_bytes());
    handshake.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake, 1);

    let mut out = Vec::with_capacity(handshake.len() + 8);
    write_varint(&mut out, handshake.len() as i32);
    out.extend_from_slice(&handshake);
    // The status request: length 1, packet id 0.
    out.extend_from_slice(&[0x01, 0x00]);
    out
}

/// Where the first packet in `buf` ends, once all of it has arrived:
/// `Ok(None)` while more bytes are needed.
pub fn complete_packet(buf: &[u8]) -> Result<Option<std::ops::Range<usize>>, WireError> {
    let Some((length, width)) = peek_varint(buf)? else {
        return Ok(None);
    };
    if length <= 0 {
        return Err(WireError::Malformed("the reply has an empty packet"));
    }
    let length = length as usize;
    if length > MAX_PACKET_BYTES {
        return Err(WireError::Malformed("the reply is larger than 256 KB"));
    }
    if buf.len() < width + length {
        return Ok(None);
    }
    Ok(Some(width..width + length))
}

/// A status response packet, without its length prefix.
pub fn parse_status_packet(packet: &[u8]) -> Result<JavaStatus, WireError> {
    let mut reader = Reader::new(packet);
    if reader.varint()? != 0x00 {
        return Err(WireError::Malformed("the reply is not a status response"));
    }
    let length = reader.varint()?;
    if length < 0 {
        return Err(WireError::Malformed("the reply has a negative length"));
    }
    let json = reader.bytes(length as usize)?;
    let json = std::str::from_utf8(json)
        .map_err(|_| WireError::Malformed("the status is not valid text"))?;
    parse_status_json(json)
}

/// The status JSON.
pub fn parse_status_json(json: &str) -> Result<JavaStatus, WireError> {
    let value: Value = serde_json::from_str(json)
        .map_err(|_| WireError::Malformed("the status is not valid JSON"))?;
    if !value.is_object() {
        return Err(WireError::Malformed("the status is not a JSON object"));
    }
    let version = value
        .pointer("/version/name")
        .and_then(Value::as_str)
        .and_then(plain_option);
    let players = value.get("players");
    let count = |key: &str| {
        players
            .and_then(|players| players.get(key))
            .and_then(Value::as_u64)
            .map(|count| count.min(u64::from(u32::MAX)) as u32)
    };
    let players_online = count("online");
    let players_max = count("max");

    let mut motd_raw = String::new();
    if let Some(description) = value.get("description") {
        chat_text(description, &mut motd_raw, 0);
    }
    let motd = plain_option(&motd_raw);

    let sample = players
        .and_then(|players| players.get("sample"))
        .and_then(Value::as_array);
    let player_names = match (sample, players_online) {
        (_, Some(0)) => Some(Vec::new()),
        (Some(sample), _) => {
            let names: Vec<String> = sample
                .iter()
                .filter(|entry| {
                    entry.get("id").and_then(Value::as_str)
                        != Some("00000000-0000-0000-0000-000000000000")
                })
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .map(plain_text)
                .filter(|name| is_player_name(name))
                .take(MAX_PLAYER_NAMES)
                .collect();
            // Servers often fill the sample with lines of text instead of
            // people; when none of it looks like a player, nobody is named.
            Some(names).filter(|names| !names.is_empty())
        }
        (None, _) => None,
    };

    Ok(JavaStatus {
        version,
        motd,
        players_online,
        players_max,
        player_names,
    })
}

/// A Minecraft account name: 2 to 16 letters, digits or underscores, with the
/// `.` or `*` Bedrock players carry on Java servers.
fn is_player_name(name: &str) -> bool {
    let bare = name.strip_prefix(['.', '*']).unwrap_or(name);
    (2..=16).contains(&bare.len())
        && bare
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Flatten a chat component (a string, a list, or `{text, extra}`) into text.
fn chat_text(value: &Value, out: &mut String, depth: usize) {
    if depth > 32 || out.len() > 8 * 1024 {
        return;
    }
    match value {
        Value::String(text) => out.push_str(text),
        Value::Array(items) => {
            for item in items {
                chat_text(item, out, depth + 1);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text") {
                chat_text(text, out, depth + 1);
            }
            if let Some(extra) = map.get("extra") {
                chat_text(extra, out, depth + 1);
            }
        }
        _ => {}
    }
}

/// Run the exchange on a connected stream. Returns the status and how long
/// the server took to answer the request.
pub async fn query(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
) -> Result<(JavaStatus, std::time::Duration), QueryError> {
    let started = std::time::Instant::now();
    stream
        .write_all(&status_request(host, port))
        .await
        .map_err(QueryError::Io)?;
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let mut latency = None;
    loop {
        match complete_packet(&buf).map_err(QueryError::Wire)? {
            Some(range) => {
                let status = parse_status_packet(&buf[range]).map_err(QueryError::Wire)?;
                return Ok((status, latency.unwrap_or_else(|| started.elapsed())));
            }
            None => {
                let read = stream.read(&mut chunk).await.map_err(QueryError::Io)?;
                if read == 0 && buf.is_empty() {
                    // Hung up without a byte: not a reply at all.
                    return Err(QueryError::Io(std::io::ErrorKind::ConnectionAborted.into()));
                }
                if read == 0 {
                    return Err(QueryError::Wire(WireError::Truncated));
                }
                latency.get_or_insert_with(|| started.elapsed());
                // `complete_packet` refuses a length over the cap, so this
                // only grows up to one packet plus one chunk.
                if buf.len() + read > MAX_PACKET_BYTES + 16 {
                    return Err(QueryError::Wire(WireError::Malformed(
                        "the reply is larger than 256 KB",
                    )));
                }
                buf.extend_from_slice(&chunk[..read]);
            }
        }
    }
}

/// How the exchange failed.
#[derive(Debug)]
pub enum QueryError {
    Io(std::io::Error),
    Wire(WireError),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A status reply as a Paper 1.21 server sends it, favicon left out.
    const PAPER_STATUS: &str = r#"{"version":{"name":"Paper 1.21.1","protocol":767},"enforcesSecureChat":true,"description":{"text":"","extra":[{"text":"Lantern ","color":"gold","bold":true},{"text":"SMP","color":"aqua"},"\n",{"text":"§7Survival · since 2024"}]},"players":{"max":20,"online":3,"sample":[{"name":"mira_builds","id":"4566e69f-c907-48ee-8d71-d7ba5aa00d20"},{"name":"§ejonas","id":"069a79f4-44e9-4726-a5be-fca90e38aaf5"},{"name":".BedrockKen","id":"00000000-0000-0000-0009-01f4a2b3c4d5"}]}}"#;

    fn packet(json: &str) -> Vec<u8> {
        let mut body = Vec::new();
        write_varint(&mut body, 0);
        write_varint(&mut body, json.len() as i32);
        body.extend_from_slice(json.as_bytes());
        let mut framed = Vec::new();
        write_varint(&mut framed, body.len() as i32);
        framed.extend_from_slice(&body);
        framed
    }

    #[test]
    fn the_request_is_a_handshake_then_a_status_request() {
        let request = status_request("mc.example.com", 25565);
        let mut reader = Reader::new(&request);
        let length = reader.varint().unwrap() as usize;
        let start = reader.position();
        assert_eq!(reader.varint(), Ok(0));
        assert_eq!(reader.varint(), Ok(PROTOCOL_VERSION));
        assert_eq!(reader.varint(), Ok(14));
        assert_eq!(reader.bytes(14).unwrap(), b"mc.example.com");
        assert_eq!(reader.u16_be(), Ok(25565));
        assert_eq!(reader.varint(), Ok(1));
        assert_eq!(reader.position() - start, length);
        assert_eq!(reader.bytes(2).unwrap(), &[0x01, 0x00]);
        assert_eq!(reader.remaining(), 0);
    }

    #[test]
    fn a_paper_status_reads_as_plain_text() {
        let framed = packet(PAPER_STATUS);
        let range = complete_packet(&framed).unwrap().expect("complete");
        let status = parse_status_packet(&framed[range]).unwrap();
        assert_eq!(status.version.as_deref(), Some("Paper 1.21.1"));
        assert_eq!(
            status.motd.as_deref(),
            Some("Lantern SMP\nSurvival · since 2024")
        );
        assert_eq!(status.players_online, Some(3));
        assert_eq!(status.players_max, Some(20));
        assert_eq!(
            status.player_names,
            Some(vec![
                "mira_builds".to_string(),
                "jonas".to_string(),
                ".BedrockKen".to_string()
            ])
        );
    }

    #[test]
    fn a_plain_string_description_and_a_hidden_sample() {
        let status = parse_status_json(
            r#"{"version":{"name":"1.8.9"},"description":"§aA §lvanilla§r server","players":{"max":50,"online":7}}"#,
        )
        .unwrap();
        assert_eq!(status.motd.as_deref(), Some("A vanilla server"));
        assert_eq!(status.player_names, None, "seven on, none named");
        let empty =
            parse_status_json(r#"{"description":"x","players":{"max":5,"online":0}}"#).unwrap();
        assert_eq!(empty.player_names, Some(Vec::new()));
    }

    #[test]
    fn a_sample_of_decorative_lines_names_nobody() {
        let status = parse_status_json(
            r#"{"description":"x","players":{"max":500,"online":120,"sample":[{"name":"§6Welcome to the network!","id":"00000000-0000-0000-0000-000000000000"},{"name":"§7play.example.net","id":"1f0c1e2d-0000-4000-8000-000000000001"}]}}"#,
        )
        .unwrap();
        assert_eq!(status.player_names, None);
    }

    #[test]
    fn partial_frames_wait_and_oversized_frames_are_refused() {
        let framed = packet(PAPER_STATUS);
        for cut in 0..framed.len() {
            assert_eq!(complete_packet(&framed[..cut]), Ok(None), "cut at {cut}");
        }
        let mut huge = Vec::new();
        write_varint(&mut huge, (MAX_PACKET_BYTES + 1) as i32);
        assert!(matches!(
            complete_packet(&huge),
            Err(WireError::Malformed(_))
        ));
        let mut negative = Vec::new();
        write_varint(&mut negative, -5);
        assert!(complete_packet(&negative).is_err());
    }

    #[test]
    fn truncated_and_lying_packets_are_errors_not_panics() {
        let framed = packet(PAPER_STATUS);
        let range = complete_packet(&framed).unwrap().unwrap();
        let body = &framed[range];
        for cut in 0..body.len() {
            assert!(parse_status_packet(&body[..cut]).is_err(), "cut at {cut}");
        }
        // A string length far beyond the packet.
        let mut lying = Vec::new();
        write_varint(&mut lying, 0);
        write_varint(&mut lying, i32::MAX);
        lying.extend_from_slice(b"{}");
        assert_eq!(parse_status_packet(&lying), Err(WireError::Truncated));
        // A negative string length.
        let mut negative = Vec::new();
        write_varint(&mut negative, 0);
        write_varint(&mut negative, -1);
        assert!(parse_status_packet(&negative).is_err());
        // Not JSON, not an object, not a status packet.
        assert!(parse_status_json("not json").is_err());
        assert!(parse_status_json("[1,2]").is_err());
        assert!(parse_status_packet(&[0x01, 0x00]).is_err());
    }

    #[test]
    fn deeply_nested_chat_does_not_recurse_forever() {
        let mut json = String::from(r#"{"description":"#);
        for _ in 0..40 {
            json.push_str(r#"{"text":"a","extra":["#);
        }
        for _ in 0..40 {
            json.push_str("]}");
        }
        json.push('}');
        let status = parse_status_json(&json).unwrap();
        assert!(status.motd.unwrap().len() <= 17);
    }

    #[test]
    fn recorded_hypixel_and_cubecraft_replies_read() {
        let hypixel = include_bytes!("fixtures/java-hypixel.bin");
        for cut in 0..hypixel.len() {
            assert_eq!(complete_packet(&hypixel[..cut]), Ok(None), "cut at {cut}");
        }
        let range = complete_packet(hypixel).unwrap().expect("complete");
        assert_eq!(range.end, hypixel.len());
        let status = parse_status_packet(&hypixel[range]).unwrap();
        assert_eq!(status.version.as_deref(), Some("Requires MC 1.8 / 1.21"));
        assert_eq!(status.players_online, Some(24649));
        assert_eq!(status.players_max, Some(200_000));
        assert_eq!(status.player_names, None, "an empty sample names nobody");
        let motd = status.motd.unwrap();
        assert!(motd.starts_with("Hypixel Network [1.8/26.3]\n"), "{motd}");
        assert!(!motd.contains('\u{a7}'));

        let cubecraft = include_bytes!("fixtures/java-cubecraft.bin");
        let range = complete_packet(cubecraft).unwrap().expect("complete");
        let status = parse_status_packet(&cubecraft[range]).unwrap();
        assert_eq!(status.version.as_deref(), Some("CubeCraft"));
        assert_eq!(status.players_online, Some(911));
        assert_eq!(
            status.player_names, None,
            "decorative lines are not players"
        );
        let motd = status.motd.unwrap();
        assert!(
            motd.contains("C\u{1d1c}\u{299}\u{1d07}C\u{280}\u{1d00}\u{a730}\u{1d1b}"),
            "{motd}"
        );
        assert!(motd.contains("BEDWARS"), "{motd}");
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..2000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let len = (state % 96) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|index| (state.rotate_left(index as u32 % 64) & 0xff) as u8)
                .collect();
            let _ = complete_packet(&bytes);
            let _ = parse_status_packet(&bytes);
        }
    }
}
