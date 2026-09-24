//! Linux: MPRIS over the D-Bus session bus.
//!
//! Every media player on a Linux desktop (Spotify, mpv with its MPRIS script,
//! Rhythmbox, browsers) publishes `org.mpris.MediaPlayer2.<name>` on the
//! session bus; the desktop's own media widget reads the same thing. This
//! reader only ever *reads*: it lists players, reads their properties and
//! listens for `PropertiesChanged` / `Seeked`. It never calls a playback
//! method on a player.
//!
//! Nothing is polled. A player is re-read when it announces a change, when it
//! appears on the bus, and when it seeks.

use std::collections::HashMap;
use std::future::poll_fn;
use std::pin::Pin;
use std::time::Instant;

use zbus::export::futures_core::Stream;
use zbus::fdo::{DBusProxy, PropertiesProxy};
use zbus::message::Type as MessageType;
use zbus::names::{BusName, InterfaceName};
use zbus::zvariant::{OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream};

use super::model::{
    is_paracord_media, pick_active, should_emit, Emitted, PlaybackStatus, PlayerState,
};
use super::{Sink, Update};

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const ROOT_IFACE: &str = "org.mpris.MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPERTIES_IFACE: &str = "org.freedesktop.DBus.Properties";

/// Await the next item of a zbus stream without pulling in a futures crate.
async fn next_item<S: Stream + Unpin>(stream: &mut S) -> Option<S::Item> {
    poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await
}

/// A variant inside `a{sv}` arrives boxed; look through it.
fn unboxed<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unboxed(inner),
        other => other,
    }
}

fn as_text(value: &Value<'_>) -> Option<String> {
    match unboxed(value) {
        Value::Str(text) => Some(text.as_str().to_string()),
        Value::ObjectPath(path) => Some(path.as_str().to_string()),
        _ => None,
    }
}

/// MPRIS says `x` (microseconds), but players send every integer type there is.
fn as_i64(value: &Value<'_>) -> Option<i64> {
    match unboxed(value) {
        Value::I64(v) => Some(*v),
        Value::U64(v) => i64::try_from(*v).ok(),
        Value::I32(v) => Some(i64::from(*v)),
        Value::U32(v) => Some(i64::from(*v)),
        Value::I16(v) => Some(i64::from(*v)),
        Value::U16(v) => Some(i64::from(*v)),
        Value::F64(v) if v.is_finite() => Some(*v as i64),
        _ => None,
    }
}

fn micros_to_ms(value: i64) -> Option<u64> {
    (value >= 0).then_some((value / 1_000) as u64)
}

/// `xesam:artist` is `as`; a few players send a single string.
fn as_text_list(value: &Value<'_>) -> Vec<String> {
    match unboxed(value) {
        Value::Array(items) => items.iter().filter_map(as_text).collect(),
        other => as_text(other).into_iter().collect(),
    }
}

/// The fields of `Metadata` this reader uses: title, artists, length.
pub(crate) struct TrackMetadata {
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub length_ms: Option<u64>,
}

pub(crate) fn parse_metadata(value: &Value<'_>) -> TrackMetadata {
    let mut track = TrackMetadata {
        title: None,
        artists: Vec::new(),
        length_ms: None,
    };
    let Value::Dict(dict) = unboxed(value) else {
        return track;
    };
    for (key, entry) in dict.iter() {
        match as_text(key).as_deref() {
            Some("xesam:title") => track.title = as_text(entry),
            Some("xesam:artist") => track.artists = as_text_list(entry),
            Some("mpris:length") => track.length_ms = as_i64(entry).and_then(micros_to_ms),
            _ => {}
        }
    }
    track
}

/// Whether `pid` is this process or one of its descendants (the webview's
/// web process plays Paracord's own audio).
fn is_own_process(pid: u32, own_pid: u32) -> bool {
    let mut current = pid;
    for _ in 0..16 {
        if current == own_pid {
            return true;
        }
        if current <= 1 {
            return false;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{current}/stat")) else {
            return false;
        };
        // `pid (comm) state ppid …` — comm may contain spaces and parens, so
        // read after the last ')'.
        let Some(parent) = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1))
            .and_then(|ppid| ppid.parse::<u32>().ok())
        else {
            return false;
        };
        current = parent;
    }
    false
}

struct Reader {
    conn: Connection,
    dbus: DBusProxy<'static>,
    own_pid: Option<u32>,
    /// Keyed by the player's unique connection name (`:1.42`), which is what
    /// signals carry as their sender.
    players: HashMap<String, PlayerState>,
    /// Unique name → the `org.mpris.MediaPlayer2.*` name it owns.
    bus_names: HashMap<String, String>,
    seq: u64,
    last: Option<Emitted>,
    sink: Sink,
}

impl Reader {
    async fn get_all(
        &self,
        unique: &str,
        iface: &'static str,
    ) -> zbus::Result<HashMap<String, OwnedValue>> {
        let proxy = PropertiesProxy::builder(&self.conn)
            .destination(unique.to_string())?
            .path(MPRIS_PATH)?
            .build()
            .await?;
        Ok(proxy
            .get_all(InterfaceName::from_static_str_unchecked(iface))
            .await?)
    }

    async fn add_player(&mut self, bus_name: &str) {
        let unique = match self
            .dbus
            .get_name_owner(BusName::try_from(bus_name.to_string()).expect("mpris bus name"))
            .await
        {
            Ok(owner) => owner.to_string(),
            Err(err) => {
                tracing::debug!(bus_name, %err, "mpris player vanished before it could be read");
                return;
            }
        };
        self.bus_names.insert(unique.clone(), bus_name.to_string());
        self.refresh(&unique, true).await;
    }

    /// Re-read one player. `with_identity` re-reads the root interface too
    /// (its `Identity` and `DesktopEntry` do not change while it runs).
    async fn refresh(&mut self, unique: &str, with_identity: bool) {
        if !self.bus_names.contains_key(unique) {
            return;
        }
        let mut state = self.players.get(unique).cloned().unwrap_or_default();
        if with_identity || !self.players.contains_key(unique) {
            match self.get_all(unique, ROOT_IFACE).await {
                Ok(root) => {
                    state.identity = root
                        .get("Identity")
                        .and_then(|v| as_text(v))
                        .unwrap_or_default();
                    state.desktop_entry = root.get("DesktopEntry").and_then(|v| as_text(v));
                }
                Err(err) => tracing::debug!(unique, %err, "mpris root properties unreadable"),
            }
            if let Some(own_pid) = self.own_pid {
                if let Ok(pid) = self
                    .dbus
                    .get_connection_unix_process_id(
                        BusName::try_from(unique.to_string()).expect("unique name"),
                    )
                    .await
                {
                    state.belongs_to_paracord |= is_own_process(pid, own_pid);
                }
            }
        }
        let player = match self.get_all(unique, PLAYER_IFACE).await {
            Ok(player) => player,
            Err(err) => {
                tracing::debug!(unique, %err, "mpris player properties unreadable");
                return;
            }
        };
        let status = player
            .get("PlaybackStatus")
            .and_then(|v| as_text(v))
            .map(|v| PlaybackStatus::from_mpris(&v))
            .unwrap_or_default();
        let track = player
            .get("Metadata")
            .map(|v| parse_metadata(v))
            .unwrap_or(TrackMetadata {
                title: None,
                artists: Vec::new(),
                length_ms: None,
            });
        if status != state.status || track.title != state.title || track.artists != state.artists {
            self.seq += 1;
            state.changed_seq = self.seq;
        }
        state.status = status;
        state.title = track.title;
        state.artists = track.artists;
        state.length_ms = track.length_ms;
        state.position_ms = player
            .get("Position")
            .and_then(|v| as_i64(v))
            .and_then(micros_to_ms);
        state.position_read_at = Some(Instant::now());
        state.belongs_to_paracord |= is_paracord_media(
            &state.identity,
            state.desktop_entry.as_deref(),
            state.title.as_deref(),
        );
        self.players.insert(unique.to_string(), state);
    }

    fn remove_player(&mut self, unique: &str) {
        self.bus_names.remove(unique);
        self.players.remove(unique);
    }

    fn publish(&mut self) {
        let now = Instant::now();
        let next = pick_active(self.players.values()).and_then(|player| player.now_playing(now));
        if should_emit(self.last.as_ref(), &next, now) {
            (self.sink)(Update::Track(next.clone()));
            self.last = Some(Emitted {
                value: next,
                at: now,
            });
        }
    }
}

/// Read the session bus until the connection fails. Returns only on failure.
pub(crate) async fn run(conn: Connection, own_pid: Option<u32>, sink: Sink) -> zbus::Result<()> {
    let dbus = DBusProxy::new(&conn).await?;
    let mut owners = dbus.receive_name_owner_changed().await?;
    let changed_rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface(PROPERTIES_IFACE)?
        .member("PropertiesChanged")?
        .path(MPRIS_PATH)?
        .build();
    let mut changed = MessageStream::for_match_rule(changed_rule, &conn, Some(64)).await?;
    let seeked_rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface(PLAYER_IFACE)?
        .member("Seeked")?
        .path(MPRIS_PATH)?
        .build();
    let mut seeked = MessageStream::for_match_rule(seeked_rule, &conn, Some(16)).await?;

    let mut reader = Reader {
        conn: conn.clone(),
        dbus: dbus.clone(),
        own_pid,
        players: HashMap::new(),
        bus_names: HashMap::new(),
        seq: 0,
        last: None,
        sink,
    };
    for name in dbus.list_names().await? {
        if name.as_str().starts_with(MPRIS_PREFIX) {
            reader.add_player(name.as_str()).await;
        }
    }
    reader.publish();

    loop {
        tokio::select! {
            signal = next_item(&mut owners) => {
                let Some(signal) = signal else {
                    return Err(zbus::Error::Failure("the session bus stopped reporting players".into()));
                };
                let Ok(args) = signal.args() else { continue };
                let name = args.name().as_str().to_string();
                if !name.starts_with(MPRIS_PREFIX) {
                    continue;
                }
                if let Some(old) = args.old_owner().as_ref() {
                    reader.remove_player(old.as_str());
                }
                if args.new_owner().is_some() {
                    reader.add_player(&name).await;
                }
                reader.publish();
            }
            message = next_item(&mut changed) => {
                let Some(message) = message else {
                    return Err(zbus::Error::Failure("the session bus stopped delivering player changes".into()));
                };
                let message = message?;
                let Some(sender) = message.header().sender().map(|s| s.to_string()) else { continue };
                reader.refresh(&sender, false).await;
                reader.publish();
            }
            message = next_item(&mut seeked) => {
                let Some(message) = message else {
                    return Err(zbus::Error::Failure("the session bus stopped delivering seeks".into()));
                };
                let message = message?;
                let Some(sender) = message.header().sender().map(|s| s.to_string()) else { continue };
                reader.refresh(&sender, false).await;
                reader.publish();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use zbus::object_server::SignalEmitter;

    use crate::now_playing::model::NowPlaying;

    #[test]
    fn metadata_reads_title_artists_and_length_in_any_integer_type() {
        let mut dict: HashMap<&str, Value<'_>> = HashMap::new();
        dict.insert("xesam:title", Value::new("Windowlicker"));
        dict.insert("xesam:artist", Value::new(vec!["Aphex Twin"]));
        dict.insert("mpris:length", Value::new(367_000_000u64));
        let track = parse_metadata(&Value::from(dict));
        assert_eq!(track.title.as_deref(), Some("Windowlicker"));
        assert_eq!(track.artists, vec!["Aphex Twin".to_string()]);
        assert_eq!(track.length_ms, Some(367_000));

        let mut dict: HashMap<&str, Value<'_>> = HashMap::new();
        dict.insert("xesam:artist", Value::new("Solo"));
        dict.insert("mpris:length", Value::new(-5i64));
        let track = parse_metadata(&Value::from(dict));
        assert!(track.title.is_none());
        assert_eq!(track.artists, vec!["Solo".to_string()]);
        assert_eq!(track.length_ms, None, "a negative length is no length");
    }

    #[test]
    fn this_process_counts_as_its_own_descendant() {
        let own = std::process::id();
        assert!(is_own_process(own, own));
        assert!(!is_own_process(1, own));
    }

    // ── A fake player on a private bus ─────────────────────────────────────

    struct FakeRoot {
        identity: String,
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2")]
    impl FakeRoot {
        #[zbus(property)]
        fn identity(&self) -> String {
            self.identity.clone()
        }
        #[zbus(property)]
        fn desktop_entry(&self) -> String {
            self.identity.to_ascii_lowercase()
        }
    }

    struct FakePlayer {
        status: String,
        title: String,
        artist: String,
        position_us: i64,
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl FakePlayer {
        #[zbus(property)]
        fn playback_status(&self) -> String {
            self.status.clone()
        }
        #[zbus(property)]
        fn metadata(&self) -> HashMap<String, OwnedValue> {
            let mut map = HashMap::new();
            map.insert(
                "xesam:title".to_string(),
                OwnedValue::try_from(Value::new(self.title.as_str())).unwrap(),
            );
            map.insert(
                "xesam:artist".to_string(),
                OwnedValue::try_from(Value::new(vec![self.artist.as_str()])).unwrap(),
            );
            map.insert("mpris:length".to_string(), OwnedValue::from(240_000_000i64));
            map
        }
        #[zbus(property(emits_changed_signal = "false"))]
        fn position(&self) -> i64 {
            self.position_us
        }
        #[zbus(signal)]
        async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;
    }

    struct PrivateBus(Child);

    impl Drop for PrivateBus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A throwaway `dbus-daemon` of our own, so the test never touches the
    /// desktop's session bus or the media players on it.
    fn private_bus() -> (PrivateBus, String) {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is installed (the Linux desktop build requires D-Bus)");
        let stdout = child.stdout.take().expect("stdout");
        let mut address = String::new();
        BufReader::new(stdout)
            .read_line(&mut address)
            .expect("bus address");
        (PrivateBus(child), address.trim().to_string())
    }

    async fn fake_player(address: &str, name: &str, identity: &str, title: &str) -> Connection {
        zbus::connection::Builder::address(address)
            .unwrap()
            .name(format!("{MPRIS_PREFIX}{name}"))
            .unwrap()
            .serve_at(
                MPRIS_PATH,
                FakeRoot {
                    identity: identity.to_string(),
                },
            )
            .unwrap()
            .serve_at(
                MPRIS_PATH,
                FakePlayer {
                    status: "Playing".into(),
                    title: title.into(),
                    artist: "Test Artist".into(),
                    position_us: 30_000_000,
                },
            )
            .unwrap()
            .build()
            .await
            .expect("fake player on the private bus")
    }

    async fn next_track(rx: &mut mpsc::UnboundedReceiver<Update>) -> Option<NowPlaying> {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("an update within 5s")
            .expect("reader alive")
        {
            Update::Track(track) => track,
            Update::Failed(err) => panic!("reader failed: {err}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reads_a_player_follows_its_changes_and_ignores_paracord() {
        let (_bus, address) = private_bus();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |update| {
            let _ = tx.send(update);
        });

        // A player already running when sharing is turned on.
        let player = fake_player(&address, "fakeplayer", "Fake Player", "First Song").await;
        let reader_conn = zbus::connection::Builder::address(address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap();
        let reader = tokio::spawn(run(reader_conn, None, sink));

        let track = next_track(&mut rx)
            .await
            .expect("the running player is read");
        assert_eq!(track.player, "Fake Player");
        assert_eq!(track.title, "First Song");
        assert_eq!(track.artist.as_deref(), Some("Test Artist"));
        assert_eq!(track.status, PlaybackStatus::Playing);
        assert_eq!(track.duration_ms, Some(240_000));
        assert!(track.position_ms.unwrap() >= 30_000);

        // A track change arrives through PropertiesChanged, not a poll.
        let iface = player
            .object_server()
            .interface::<_, FakePlayer>(MPRIS_PATH)
            .await
            .unwrap();
        iface.get_mut().await.title = "Second Song".into();
        iface
            .get()
            .await
            .metadata_changed(iface.signal_emitter())
            .await
            .unwrap();
        let track = next_track(&mut rx).await.expect("still playing");
        assert_eq!(track.title, "Second Song");

        // Paracord's own webview starts playing: it is not what I'm listening to.
        let own = fake_player(&address, "paracord", "Paracord", "Voice call").await;
        // A seek on the real player: news, because the position jumped.
        iface.get_mut().await.position_us = 200_000_000;
        FakePlayer::seeked(iface.signal_emitter(), 200_000_000)
            .await
            .unwrap();
        let track = next_track(&mut rx).await.expect("still playing");
        assert_eq!(
            track.player, "Fake Player",
            "Paracord's own media is ignored"
        );
        assert!(track.position_ms.unwrap() >= 200_000);

        // Pause.
        iface.get_mut().await.status = "Paused".into();
        iface
            .get()
            .await
            .playback_status_changed(iface.signal_emitter())
            .await
            .unwrap();
        let track = next_track(&mut rx).await.expect("paused is still a track");
        assert_eq!(track.status, PlaybackStatus::Paused);

        // The player quits: nothing is playing (Paracord's own player remains).
        drop(iface);
        drop(player);
        assert_eq!(next_track(&mut rx).await, None);

        drop(own);
        reader.abort();
    }

    /// Read-only smoke test against the desktop's real session bus: whatever
    /// players are running there are listed and read (never controlled).
    /// Prints only the player name and status. Run by hand:
    /// `cargo test -p paracord-desktop --lib now_playing -- --ignored`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "reads the real session bus"]
    async fn reads_the_real_session_bus_read_only() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |update| {
            let _ = tx.send(update);
        });
        let conn = Connection::session().await.expect("session bus");
        let reader = tokio::spawn(run(conn, Some(std::process::id()), sink));
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("the reader reports within 5s")
            .expect("reader alive");
        match first {
            Update::Track(Some(track)) => println!(
                "active player: {} ({:?}), title present: {}, length known: {}",
                track.player,
                track.status,
                !track.title.is_empty(),
                track.duration_ms.is_some()
            ),
            Update::Track(None) => println!("no player is playing or paused"),
            Update::Failed(err) => panic!("reader failed: {err}"),
        }
        assert!(!reader.is_finished(), "the reader keeps listening");
        reader.abort();
    }
}
