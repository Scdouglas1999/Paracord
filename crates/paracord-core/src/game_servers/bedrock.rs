//! Minecraft: Bedrock Edition status: a RakNet unconnected ping over UDP, and
//! the unconnected pong carrying a `;`-separated server description.
//!
//! <https://wiki.bedrock.dev/servers/raknet-and-mcpe>

use tokio::net::UdpSocket;

use super::text::plain_option;
use super::wire::{Reader, WireError};

/// RakNet's offline-message marker.
pub const MAGIC: [u8; 16] = [
    0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
];
const UNCONNECTED_PING: u8 = 0x01;
const UNCONNECTED_PONG: u8 = 0x1c;
/// Largest pong read; a real one is a few hundred bytes.
pub const MAX_PONG_BYTES: usize = 2048;

/// What a Bedrock server says about itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BedrockStatus {
    pub motd: Option<String>,
    /// The world's name, which Bedrock sends as a second message line.
    pub level: Option<String>,
    pub version: Option<String>,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    pub game_mode: Option<String>,
}

/// An unconnected ping: id, time, magic, client GUID.
pub fn ping(time: i64, client_guid: i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(33);
    out.push(UNCONNECTED_PING);
    out.extend_from_slice(&time.to_be_bytes());
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&client_guid.to_be_bytes());
    out
}

/// An unconnected pong.
pub fn parse_pong(packet: &[u8]) -> Result<BedrockStatus, WireError> {
    if packet.len() > MAX_PONG_BYTES {
        return Err(WireError::Malformed("the reply is too large"));
    }
    let mut reader = Reader::new(packet);
    if reader.u8()? != UNCONNECTED_PONG {
        return Err(WireError::Malformed("the reply is not a RakNet pong"));
    }
    let _time = reader.i64_be()?;
    let _server_guid = reader.i64_be()?;
    if reader.array::<16>()? != MAGIC {
        return Err(WireError::Malformed("the reply lacks the RakNet marker"));
    }
    let length = reader.u16_be()? as usize;
    let text = reader.bytes(length)?;
    let text = String::from_utf8_lossy(text);
    let fields: Vec<&str> = text.split(';').collect();
    // MCPE;motd;protocol;version;online;max;server id;level;game mode;…
    if fields.len() < 6 || !matches!(fields[0], "MCPE" | "MCEE") {
        return Err(WireError::Malformed(
            "the reply is not a Bedrock server description",
        ));
    }
    let number = |raw: &str| raw.trim().parse::<u32>().ok();
    Ok(BedrockStatus {
        motd: plain_option(fields[1]),
        version: plain_option(fields[3]),
        players_online: number(fields[4]),
        players_max: number(fields[5]),
        level: fields.get(7).and_then(|raw| plain_option(raw)),
        game_mode: fields.get(8).and_then(|raw| plain_option(raw)),
    })
}

/// Ping on a connected socket until a pong arrives. The caller bounds the time.
pub async fn query(socket: &UdpSocket) -> Result<(BedrockStatus, std::time::Duration), QueryError> {
    let time = chrono::Utc::now().timestamp_millis();
    let started = std::time::Instant::now();
    socket
        .send(&ping(time, rand::random::<i64>()))
        .await
        .map_err(QueryError::Io)?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = socket.recv(&mut buf).await.map_err(QueryError::Io)?;
        let packet = &buf[..read];
        // Anything that is not a pong is ignored; the deadline ends the wait.
        if packet.first() != Some(&UNCONNECTED_PONG) {
            continue;
        }
        let status = parse_pong(packet).map_err(QueryError::Wire)?;
        return Ok((status, started.elapsed()));
    }
}

#[derive(Debug)]
pub enum QueryError {
    Io(std::io::Error),
    Wire(WireError),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pong as Bedrock Dedicated Server 1.21 sends it.
    fn bds_pong() -> Vec<u8> {
        let text = "MCPE;Lantern Works Bedrock;712;1.21.20;4;10;13253860892328930865;Riverbend;Survival;1;19132;19133;";
        let mut out = vec![UNCONNECTED_PONG];
        out.extend_from_slice(&1_727_000_000_000i64.to_be_bytes());
        out.extend_from_slice(&0x3c2a_11f0_9e1d_7a55i64.to_be_bytes());
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&(text.len() as u16).to_be_bytes());
        out.extend_from_slice(text.as_bytes());
        out
    }

    #[test]
    fn the_ping_is_33_bytes_with_the_marker() {
        let packet = ping(42, 7);
        assert_eq!(packet.len(), 33);
        assert_eq!(packet[0], UNCONNECTED_PING);
        assert_eq!(&packet[9..25], &MAGIC);
    }

    #[test]
    fn a_dedicated_server_pong_reads() {
        let status = parse_pong(&bds_pong()).unwrap();
        assert_eq!(status.motd.as_deref(), Some("Lantern Works Bedrock"));
        assert_eq!(status.level.as_deref(), Some("Riverbend"));
        assert_eq!(status.version.as_deref(), Some("1.21.20"));
        assert_eq!(status.players_online, Some(4));
        assert_eq!(status.players_max, Some(10));
        assert_eq!(status.game_mode.as_deref(), Some("Survival"));
    }

    #[test]
    fn every_truncation_is_an_error() {
        let pong = bds_pong();
        for cut in 0..pong.len() {
            assert!(parse_pong(&pong[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn a_wrong_marker_a_lying_length_and_an_oversized_reply_are_refused() {
        let mut wrong_magic = bds_pong();
        wrong_magic[20] ^= 0xff;
        assert!(parse_pong(&wrong_magic).is_err());

        let mut lying = bds_pong();
        lying[33] = 0xff;
        lying[34] = 0xff;
        assert_eq!(parse_pong(&lying), Err(WireError::Truncated));

        let mut oversized = bds_pong();
        oversized.resize(MAX_PONG_BYTES + 1, b'a');
        assert!(parse_pong(&oversized).is_err());

        let mut not_minecraft = vec![UNCONNECTED_PONG];
        not_minecraft.extend_from_slice(&[0; 16]);
        not_minecraft.extend_from_slice(&MAGIC);
        not_minecraft.extend_from_slice(&5u16.to_be_bytes());
        not_minecraft.extend_from_slice(b"hello");
        assert!(parse_pong(&not_minecraft).is_err());
    }

    #[test]
    fn recorded_cubecraft_and_hive_pongs_read() {
        let cubecraft = parse_pong(include_bytes!("fixtures/bedrock-cubecraft.bin")).unwrap();
        assert_eq!(
            cubecraft.motd.as_deref(),
            Some("BEDWARS UPDATE: NEW ITEMS & MAPS")
        );
        assert_eq!(cubecraft.version.as_deref(), Some("1.26.50"));
        assert_eq!(cubecraft.players_online, Some(10939));
        assert_eq!(cubecraft.players_max, Some(55000));
        let hive = parse_pong(include_bytes!("fixtures/bedrock-hive.bin")).unwrap();
        assert_eq!(hive.motd.as_deref(), Some("BEDWARS SEASON 5: WILD WEST"));
        assert_eq!(hive.level.as_deref(), Some("Hive Games"));
        assert_eq!(hive.players_max, Some(100_001));
        let recorded = include_bytes!("fixtures/bedrock-hive.bin");
        for cut in 0..recorded.len() {
            assert!(parse_pong(&recorded[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        for _ in 0..2000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let mut bytes = bds_pong();
            let index = (state % bytes.len() as u64) as usize;
            bytes[index] = (state >> 8) as u8;
            bytes.truncate((state >> 16) as usize % (bytes.len() + 1));
            let _ = parse_pong(&bytes);
        }
    }
}
