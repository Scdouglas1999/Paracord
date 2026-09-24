//! Valve's server queries over UDP: A2S_INFO (name, map, players) and
//! A2S_PLAYER (who is on), including the challenge step servers have required
//! since 2020 and replies split across several datagrams.
//!
//! <https://developer.valvesoftware.com/wiki/Server_queries>

use std::time::{Duration, Instant};

use tokio::net::UdpSocket;

use super::text::{plain_option, plain_text};
use super::wire::{Reader, WireError};

const SINGLE: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
const SPLIT: [u8; 4] = [0xfe, 0xff, 0xff, 0xff];
const A2S_INFO: u8 = 0x54;
const A2S_PLAYER: u8 = 0x55;
const S2C_CHALLENGE: u8 = 0x41;
const S2A_INFO: u8 = 0x49;
const S2A_PLAYER: u8 = 0x44;
const INFO_PAYLOAD: &[u8] = b"Source Engine Query\0";

/// Largest datagram accepted.
pub const MAX_DATAGRAM_BYTES: usize = 4096;
/// Most parts a split reply may have.
pub const MAX_SPLIT_PARTS: u8 = 16;
/// Largest reassembled reply.
pub const MAX_REPLY_BYTES: usize = 32 * 1024;
/// Longest string field read.
const MAX_STRING_BYTES: usize = 512;
/// Player names kept.
pub const MAX_PLAYER_NAMES: usize = 24;
/// How many challenges a server may send before it is given up on.
const MAX_CHALLENGES: usize = 2;

/// What A2S_INFO says.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct A2sInfo {
    pub name: Option<String>,
    pub map: Option<String>,
    pub folder: String,
    pub game: Option<String>,
    pub app_id: u16,
    pub players: u8,
    pub max_players: u8,
    pub bots: u8,
    pub version: Option<String>,
}

/// One reply, reassembled and without its header.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Challenge([u8; 4]),
    Info(A2sInfo),
    Players(Vec<String>),
    /// A reply type this does not read (GoldSrc's obsolete info reply, …).
    Other(u8),
}

pub fn info_request(challenge: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 1 + INFO_PAYLOAD.len() + 4);
    out.extend_from_slice(&SINGLE);
    out.push(A2S_INFO);
    out.extend_from_slice(INFO_PAYLOAD);
    if let Some(challenge) = challenge {
        out.extend_from_slice(&challenge);
    }
    out
}

/// A2S_PLAYER; `[0xff; 4]` asks for a challenge.
pub fn player_request(challenge: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9);
    out.extend_from_slice(&SINGLE);
    out.push(A2S_PLAYER);
    out.extend_from_slice(&challenge);
    out
}

/// One datagram: a whole reply, or one part of a split one.
#[derive(Debug, PartialEq, Eq)]
pub enum Datagram<'a> {
    /// The reply after its `FF FF FF FF` header.
    Single(&'a [u8]),
    Part {
        id: i32,
        total: u8,
        number: u8,
        payload: &'a [u8],
    },
}

/// Read a datagram's header (Source engine split format).
pub fn datagram(bytes: &[u8]) -> Result<Datagram<'_>, WireError> {
    if bytes.len() > MAX_DATAGRAM_BYTES {
        return Err(WireError::Malformed("a reply datagram is too large"));
    }
    let mut reader = Reader::new(bytes);
    let header = reader.array::<4>()?;
    if header == SINGLE {
        return Ok(Datagram::Single(&bytes[4..]));
    }
    if header != SPLIT {
        return Err(WireError::Malformed(
            "the reply is not a Valve server reply",
        ));
    }
    let id = reader.i32_le()?;
    let total = reader.u8()?;
    let number = reader.u8()?;
    let _size = reader.u16_le()?;
    if id < 0 {
        // The top bit marks a bzip2-compressed reply, which only very old
        // engines send.
        return Err(WireError::Malformed("the reply is compressed"));
    }
    if total == 0 || total > MAX_SPLIT_PARTS || number >= total {
        return Err(WireError::Malformed(
            "a split reply has impossible part numbers",
        ));
    }
    let offset = reader.position();
    Ok(Datagram::Part {
        id,
        total,
        number,
        payload: &bytes[offset..],
    })
}

/// Collects the parts of one split reply.
#[derive(Debug, Default)]
pub struct Assembler {
    id: Option<i32>,
    parts: Vec<Option<Vec<u8>>>,
    bytes: usize,
}

impl Assembler {
    /// Add a datagram. Returns the whole reply (after its header) once it is
    /// complete.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, WireError> {
        match datagram(bytes)? {
            Datagram::Single(payload) => Ok(Some(payload.to_vec())),
            Datagram::Part {
                id,
                total,
                number,
                payload,
            } => {
                match self.id {
                    None => {
                        self.id = Some(id);
                        self.parts = vec![None; usize::from(total)];
                    }
                    // A part of some other, older reply.
                    Some(current) if current != id => return Ok(None),
                    Some(_) if self.parts.len() != usize::from(total) => {
                        return Err(WireError::Malformed("a split reply changed its part count"));
                    }
                    Some(_) => {}
                }
                let slot = &mut self.parts[usize::from(number)];
                if slot.is_none() {
                    self.bytes += payload.len();
                    if self.bytes > MAX_REPLY_BYTES {
                        return Err(WireError::Malformed("the reply is larger than 32 KB"));
                    }
                    *slot = Some(payload.to_vec());
                }
                if self.parts.iter().any(Option::is_none) {
                    return Ok(None);
                }
                let whole: Vec<u8> = self.parts.iter().flatten().flatten().copied().collect();
                *self = Self::default();
                match whole.strip_prefix(&SINGLE) {
                    Some(payload) => Ok(Some(payload.to_vec())),
                    None => Err(WireError::Malformed(
                        "a split reply does not start with a header",
                    )),
                }
            }
        }
    }
}

/// A whole reply, after its `FF FF FF FF` header.
pub fn parse_reply(payload: &[u8]) -> Result<Reply, WireError> {
    let mut reader = Reader::new(payload);
    match reader.u8()? {
        S2C_CHALLENGE => Ok(Reply::Challenge(reader.array()?)),
        S2A_INFO => parse_info(&mut reader).map(Reply::Info),
        S2A_PLAYER => parse_players(&mut reader).map(Reply::Players),
        other => Ok(Reply::Other(other)),
    }
}

fn parse_info(reader: &mut Reader<'_>) -> Result<A2sInfo, WireError> {
    let _protocol = reader.u8()?;
    let name = reader.cstring(MAX_STRING_BYTES)?;
    let map = reader.cstring(MAX_STRING_BYTES)?;
    let folder = reader.cstring(MAX_STRING_BYTES)?;
    let game = reader.cstring(MAX_STRING_BYTES)?;
    let app_id = reader.u16_le()?;
    let players = reader.u8()?;
    let max_players = reader.u8()?;
    let bots = reader.u8()?;
    let _server_type = reader.u8()?;
    let _environment = reader.u8()?;
    let _visibility = reader.u8()?;
    let _vac = reader.u8()?;
    if app_id == 2400 {
        // The Ship: mode, witnesses, duration.
        reader.bytes(3)?;
    }
    let version = reader.cstring(MAX_STRING_BYTES)?;
    // The extra data flag and what follows (port, Steam id, keywords) are not used.
    Ok(A2sInfo {
        name: plain_option(&name),
        map: plain_option(&map),
        folder: plain_text(&folder),
        game: plain_option(&game),
        app_id,
        players,
        max_players,
        bots,
        version: plain_option(&version),
    })
}

fn parse_players(reader: &mut Reader<'_>) -> Result<Vec<String>, WireError> {
    let count = reader.u8()?;
    let mut names = Vec::new();
    for _ in 0..count {
        let _index = reader.u8()?;
        let name = reader.cstring(MAX_STRING_BYTES)?;
        let _score = reader.i32_le()?;
        let _duration = reader.f32_le()?;
        // A player still connecting has no name yet.
        if let Some(name) = plain_option(&name) {
            if names.len() < MAX_PLAYER_NAMES {
                names.push(super::text::clip(&name, 32));
            }
        }
    }
    Ok(names)
}

#[derive(Debug)]
pub enum QueryError {
    Io(std::io::Error),
    Wire(WireError),
}

/// Wait for the next whole reply on a connected socket.
async fn receive(socket: &UdpSocket, assembler: &mut Assembler) -> Result<Vec<u8>, QueryError> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = socket.recv(&mut buf).await.map_err(QueryError::Io)?;
        if let Some(reply) = assembler.push(&buf[..read]).map_err(QueryError::Wire)? {
            return Ok(reply);
        }
    }
}

/// Send `request(challenge)` and follow challenges until `accept` takes a
/// reply. Returns what it took and the last round trip's time.
async fn exchange<T>(
    socket: &UdpSocket,
    request: impl Fn(Option<[u8; 4]>) -> Vec<u8>,
    accept: impl Fn(Reply) -> Option<T>,
) -> Result<(T, Duration), QueryError> {
    let mut assembler = Assembler::default();
    let mut sent_at = Instant::now();
    socket.send(&request(None)).await.map_err(QueryError::Io)?;
    let mut challenges = 0;
    loop {
        let payload = receive(socket, &mut assembler).await?;
        match parse_reply(&payload).map_err(QueryError::Wire)? {
            Reply::Challenge(challenge) => {
                challenges += 1;
                if challenges > MAX_CHALLENGES {
                    return Err(QueryError::Wire(WireError::Malformed(
                        "the server kept asking for a new challenge",
                    )));
                }
                sent_at = Instant::now();
                socket
                    .send(&request(Some(challenge)))
                    .await
                    .map_err(QueryError::Io)?;
            }
            reply => {
                if let Some(taken) = accept(reply) {
                    return Ok((taken, sent_at.elapsed()));
                }
            }
        }
    }
}

/// A2S_INFO. The caller bounds the time.
pub async fn query_info(socket: &UdpSocket) -> Result<(A2sInfo, Duration), QueryError> {
    exchange(socket, info_request, |reply| match reply {
        Reply::Info(info) => Some(info),
        _ => None,
    })
    .await
}

/// A2S_PLAYER. The caller bounds the time.
pub async fn query_players(socket: &UdpSocket) -> Result<Vec<String>, QueryError> {
    exchange(
        socket,
        |challenge| player_request(challenge.unwrap_or([0xff; 4])),
        |reply| match reply {
            Reply::Players(names) => Some(names),
            _ => None,
        },
    )
    .await
    .map(|(names, _)| names)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An A2S_INFO reply as a Team Fortress 2 server sends it, extra data
    /// (game port and Steam id) included.
    fn tf2_info() -> Vec<u8> {
        let mut out = SINGLE.to_vec();
        out.push(S2A_INFO);
        out.push(17);
        out.extend_from_slice(b"Lantern Works | 2Fort 24/7\0");
        out.extend_from_slice(b"ctf_2fort\0");
        out.extend_from_slice(b"tf\0");
        out.extend_from_slice(b"Team Fortress\0");
        out.extend_from_slice(&440u16.to_le_bytes());
        out.extend_from_slice(&[12, 24, 2, b'd', b'l', 0, 1]);
        out.extend_from_slice(b"9357393\0");
        out.push(0xb1);
        out.extend_from_slice(&27015u16.to_le_bytes());
        out.extend_from_slice(&90_071_996_842_377_216u64.to_le_bytes());
        out.extend_from_slice(b"cp,increased_maxplayers\0");
        out.extend_from_slice(&440u64.to_le_bytes());
        out
    }

    fn players_reply(names: &[&str]) -> Vec<u8> {
        let mut out = SINGLE.to_vec();
        out.push(S2A_PLAYER);
        out.push(names.len() as u8);
        for (index, name) in names.iter().enumerate() {
            out.push(index as u8);
            out.extend_from_slice(name.as_bytes());
            out.push(0);
            out.extend_from_slice(&(index as i32 * 3).to_le_bytes());
            out.extend_from_slice(&(612.5f32).to_le_bytes());
        }
        out
    }

    fn whole(bytes: &[u8]) -> Result<Reply, WireError> {
        let mut assembler = Assembler::default();
        let payload = assembler.push(bytes)?.expect("single");
        parse_reply(&payload)
    }

    #[test]
    fn requests_have_the_documented_bytes() {
        assert_eq!(
            info_request(None),
            b"\xff\xff\xff\xffTSource Engine Query\0".to_vec()
        );
        assert_eq!(
            info_request(Some([1, 2, 3, 4])),
            b"\xff\xff\xff\xffTSource Engine Query\0\x01\x02\x03\x04".to_vec()
        );
        assert_eq!(
            player_request([0xff; 4]),
            b"\xff\xff\xff\xffU\xff\xff\xff\xff".to_vec()
        );
    }

    #[test]
    fn a_tf2_info_reply_reads() {
        let Reply::Info(info) = whole(&tf2_info()).unwrap() else {
            panic!("not info");
        };
        assert_eq!(info.name.as_deref(), Some("Lantern Works | 2Fort 24/7"));
        assert_eq!(info.map.as_deref(), Some("ctf_2fort"));
        assert_eq!(info.folder, "tf");
        assert_eq!(info.game.as_deref(), Some("Team Fortress"));
        assert_eq!(info.app_id, 440);
        assert_eq!((info.players, info.max_players, info.bots), (12, 24, 2));
        assert_eq!(info.version.as_deref(), Some("9357393"));
    }

    #[test]
    fn a_challenge_reads() {
        assert_eq!(
            whole(b"\xff\xff\xff\xffA\x0a\x0b\x0c\x0d").unwrap(),
            Reply::Challenge([0x0a, 0x0b, 0x0c, 0x0d])
        );
        assert_eq!(
            whole(b"\xff\xff\xff\xffA\x0a\x0b"),
            Err(WireError::Truncated)
        );
    }

    #[test]
    fn players_read_and_unnamed_ones_are_skipped() {
        let reply = players_reply(&["Mira", "", "jonas \u{2605}", "Ade"]);
        assert_eq!(
            whole(&reply).unwrap(),
            Reply::Players(vec![
                "Mira".to_string(),
                "jonas \u{2605}".to_string(),
                "Ade".to_string()
            ])
        );
    }

    #[test]
    fn a_player_count_the_body_cannot_hold_is_an_error() {
        let mut reply = players_reply(&["Mira", "Ade"]);
        reply[5] = 200;
        assert_eq!(whole(&reply), Err(WireError::Truncated));
    }

    #[test]
    fn every_truncation_of_info_is_an_error() {
        let info = tf2_info();
        // Everything up to the version's terminator is required; the extra
        // data after it is optional.
        let required = info
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == 0)
            .map(|(index, _)| index)
            .nth(5)
            .expect("version terminator");
        for cut in 0..=required {
            assert!(
                whole(&info[..cut]).map(|reply| matches!(reply, Reply::Info(_))) != Ok(true),
                "cut at {cut} read as info"
            );
        }
    }

    #[test]
    fn an_unterminated_or_oversized_string_is_refused() {
        let mut info = SINGLE.to_vec();
        info.push(S2A_INFO);
        info.push(17);
        info.extend(std::iter::repeat_n(b'a', 1000));
        info.push(0);
        assert!(matches!(whole(&info), Err(WireError::Malformed(_))));
        let oversized = vec![0xffu8; MAX_DATAGRAM_BYTES + 1];
        assert!(matches!(datagram(&oversized), Err(WireError::Malformed(_))));
    }

    fn split(id: i32, total: u8, number: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = SPLIT.to_vec();
        out.extend_from_slice(&id.to_le_bytes());
        out.push(total);
        out.push(number);
        out.extend_from_slice(&1248u16.to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn split_replies_reassemble_in_any_order() {
        let names: Vec<String> = (0..40).map(|index| format!("player_{index:02}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let reply = players_reply(&refs);
        let (first, rest) = reply.split_at(300);
        let (second, third) = rest.split_at(300);
        let mut assembler = Assembler::default();
        assert_eq!(assembler.push(&split(7, 3, 2, third)), Ok(None));
        // A stray part of another reply is ignored.
        assert_eq!(assembler.push(&split(9, 2, 0, b"junk")), Ok(None));
        assert_eq!(assembler.push(&split(7, 3, 0, first)), Ok(None));
        // A duplicate is harmless.
        assert_eq!(assembler.push(&split(7, 3, 0, first)), Ok(None));
        let payload = assembler
            .push(&split(7, 3, 1, second))
            .unwrap()
            .expect("complete");
        let Reply::Players(parsed) = parse_reply(&payload).unwrap() else {
            panic!("not players");
        };
        assert_eq!(parsed.len(), MAX_PLAYER_NAMES);
        assert_eq!(parsed[0], "player_00");
    }

    #[test]
    fn impossible_split_headers_are_refused() {
        let mut assembler = Assembler::default();
        assert!(
            assembler.push(&split(-5, 2, 0, b"x")).is_err(),
            "compressed"
        );
        assert!(assembler.push(&split(1, 0, 0, b"x")).is_err(), "no parts");
        assert!(
            assembler.push(&split(1, 2, 2, b"x")).is_err(),
            "part past total"
        );
        assert!(
            assembler
                .push(&split(1, MAX_SPLIT_PARTS + 1, 0, b"x"))
                .is_err(),
            "too many parts"
        );
        let mut changing = Assembler::default();
        assert_eq!(changing.push(&split(3, 2, 0, b"\xff\xff")), Ok(None));
        assert!(changing.push(&split(3, 3, 1, b"x")).is_err());
        let mut headless = Assembler::default();
        assert_eq!(headless.push(&split(4, 2, 0, b"ab")), Ok(None));
        assert!(headless.push(&split(4, 2, 1, b"cd")).is_err());
    }

    #[test]
    fn a_split_reply_over_the_size_cap_is_refused() {
        let mut assembler = Assembler::default();
        let chunk = vec![0u8; MAX_DATAGRAM_BYTES - 12];
        let mut result = Ok(None);
        for number in 0..MAX_SPLIT_PARTS {
            result = assembler.push(&split(5, MAX_SPLIT_PARTS, number, &chunk));
            if result.is_err() {
                break;
            }
        }
        assert!(matches!(result, Err(WireError::Malformed(_))));
    }

    #[test]
    fn a_recorded_goldsrc_exchange_reads() {
        // A Counter-Strike 1.6 server answers with GoldSrc's obsolete reply
        // first and the current one after it; the obsolete one is skipped.
        assert_eq!(
            whole(include_bytes!("fixtures/a2s-goldsrc-obsolete-info.bin")).unwrap(),
            Reply::Other(b'm')
        );
        let Reply::Info(info) = whole(include_bytes!("fixtures/a2s-goldsrc-info.bin")).unwrap()
        else {
            panic!("not info");
        };
        assert_eq!(
            info.name.as_deref(),
            Some("cs.cs2.ro -[SteamVIP,Revive,Skins,Levels,BATTLEPASS]")
        );
        assert_eq!(info.map.as_deref(), Some("css_mirage"));
        assert_eq!(info.folder, "cstrike");
        assert_eq!(info.app_id, 10);
        assert_eq!((info.players, info.max_players, info.bots), (24, 32, 0));
        assert_eq!(info.version.as_deref(), Some("1.1.2.7/Stdio"));
        assert_eq!(
            whole(include_bytes!("fixtures/a2s-challenge.bin")).unwrap(),
            Reply::Challenge([0x96, 0x1e, 0xf2, 0xfe])
        );
        let recorded = include_bytes!("fixtures/a2s-goldsrc-info.bin");
        for cut in 0..recorded.len() - 4 {
            assert!(
                whole(&recorded[..cut]).map(|reply| matches!(reply, Reply::Info(_))) != Ok(true),
                "cut at {cut} read as info"
            );
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut state: u64 = 0xdead_beef_cafe_f00d;
        let samples = [tf2_info(), players_reply(&["a", "bb", "ccc"])];
        for round in 0..4000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let mut bytes = samples[round % 2].clone();
            let index = (state % bytes.len() as u64) as usize;
            bytes[index] = (state >> 8) as u8;
            bytes.truncate((state >> 16) as usize % (bytes.len() + 1));
            let mut assembler = Assembler::default();
            if let Ok(Some(payload)) = assembler.push(&bytes) {
                let _ = parse_reply(&payload);
            }
        }
    }
}
