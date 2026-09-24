//! The platform-neutral half of the now-playing reader: what a player said,
//! which player counts, and when the web layer needs to hear about it.
//!
//! Each platform backend (MPRIS on Linux, the system media transport controls
//! on Windows) fills in [`PlayerState`]s and calls into here, so the rules are
//! the same everywhere and are tested without a media player.

use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    #[default]
    Stopped,
}

impl PlaybackStatus {
    /// MPRIS `PlaybackStatus` is exactly "Playing", "Paused" or "Stopped".
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn from_mpris(value: &str) -> Self {
        match value {
            "Playing" => Self::Playing,
            "Paused" => Self::Paused,
            _ => Self::Stopped,
        }
    }
}

/// What the web layer receives in `now_playing_changed`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NowPlaying {
    /// The player's own name for itself ("Spotify", "mpv Media Player").
    pub player: String,
    pub title: String,
    /// Every artist the player lists, joined with ", ".
    pub artist: Option<String>,
    pub status: PlaybackStatus,
    /// How far into the track, as of the moment this was sent.
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
}

/// One media player, as the backend last read it.
#[derive(Clone, Debug, Default)]
pub struct PlayerState {
    pub identity: String,
    pub desktop_entry: Option<String>,
    pub status: PlaybackStatus,
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub length_ms: Option<u64>,
    pub position_ms: Option<u64>,
    /// When `position_ms` was read; a playing track is extrapolated from it.
    pub position_read_at: Option<Instant>,
    /// Bumped whenever the track or the playback status changes, so "the most
    /// recently changed player" is a comparison, not a clock read.
    pub changed_seq: u64,
    /// The player is Paracord itself (its webview) or a browser tab showing a
    /// Paracord web client. Those are never "what I'm listening to".
    pub belongs_to_paracord: bool,
}

impl PlayerState {
    /// Where the track is now, extrapolated from the last read while playing.
    pub fn position_at(&self, now: Instant) -> Option<u64> {
        let read = self.position_ms?;
        let position = match (self.status, self.position_read_at) {
            (PlaybackStatus::Playing, Some(at)) => {
                read.saturating_add(now.saturating_duration_since(at).as_millis() as u64)
            }
            _ => read,
        };
        Some(match self.length_ms {
            Some(length) if length > 0 => position.min(length),
            _ => position,
        })
    }

    pub fn now_playing(&self, now: Instant) -> Option<NowPlaying> {
        let title = self.title.as_deref().map(str::trim).unwrap_or_default();
        if title.is_empty() || self.status == PlaybackStatus::Stopped {
            return None;
        }
        let artists: Vec<&str> = self
            .artists
            .iter()
            .map(|artist| artist.trim())
            .filter(|artist| !artist.is_empty())
            .collect();
        Some(NowPlaying {
            player: display_player_name(&self.identity, self.desktop_entry.as_deref()),
            title: title.to_string(),
            artist: (!artists.is_empty()).then(|| artists.join(", ")),
            status: self.status,
            position_ms: self.position_at(now),
            duration_ms: self.length_ms.filter(|length| *length > 0),
        })
    }
}

/// The name people know the player by. MPRIS `Identity` is meant for exactly
/// this; a player that leaves it empty falls back to its desktop entry.
fn display_player_name(identity: &str, desktop_entry: Option<&str>) -> String {
    let identity = identity.trim();
    if !identity.is_empty() {
        return identity.to_string();
    }
    let entry = desktop_entry.map(str::trim).unwrap_or_default();
    let base = entry.rsplit('.').next().unwrap_or(entry);
    let mut chars = base.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "Media player".to_string(),
    }
}

/// The page title every Paracord web client carries. A browser playing a tab
/// with no media-session metadata reports the page title as the track title.
const PARACORD_PAGE_TITLE: &str = "paracord";

/// Whether a player is Paracord itself or a browser tab of a Paracord client.
///
/// `identity` / `desktop_entry` catch the desktop app's own webview (WebKitGTK
/// and WebView2 both register under the application's name); the title rule
/// catches a browser tab whose page title is Paracord's.
pub fn is_paracord_media(identity: &str, desktop_entry: Option<&str>, title: Option<&str>) -> bool {
    let names_paracord = |value: &str| value.to_ascii_lowercase().contains(PARACORD_PAGE_TITLE);
    if names_paracord(identity) || desktop_entry.is_some_and(names_paracord) {
        return true;
    }
    let Some(title) = title.map(|title| title.trim().to_ascii_lowercase()) else {
        return false;
    };
    title == PARACORD_PAGE_TITLE
        || [" - ", " — ", " | ", " · "]
            .iter()
            .any(|sep| title.ends_with(&format!("{sep}{PARACORD_PAGE_TITLE}")))
}

/// The player whose track is shared: a playing one before a paused one, and
/// among equals the one that changed most recently. Stopped players, players
/// with no title, and Paracord's own media never count.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn pick_active<'a, I>(players: I) -> Option<&'a PlayerState>
where
    I: IntoIterator<Item = &'a PlayerState>,
{
    players
        .into_iter()
        .filter(|player| {
            !player.belongs_to_paracord
                && player.status != PlaybackStatus::Stopped
                && player
                    .title
                    .as_deref()
                    .is_some_and(|title| !title.trim().is_empty())
        })
        .max_by_key(|player| (player.status == PlaybackStatus::Playing, player.changed_seq))
}

/// How far a position may drift from where the last one would have got to
/// before it counts as a seek worth telling the web layer about.
const SEEK_TOLERANCE_MS: u64 = 2_000;

/// The last thing sent to the web layer, and when.
#[derive(Clone, Debug)]
pub struct Emitted {
    pub value: Option<NowPlaying>,
    pub at: Instant,
}

/// Whether `next` is news compared with what was last sent.
///
/// Any change of player, track, artist, status or length is. A position that
/// merely advanced with the clock is not; one that jumped (a seek, a restart
/// of the same track) is.
pub fn should_emit(last: Option<&Emitted>, next: &Option<NowPlaying>, now: Instant) -> bool {
    let Some(last) = last else {
        return true;
    };
    match (&last.value, next) {
        (None, None) => false,
        (Some(prev), Some(next)) => {
            if prev.player != next.player
                || prev.title != next.title
                || prev.artist != next.artist
                || prev.status != next.status
                || prev.duration_ms != next.duration_ms
            {
                return true;
            }
            match (prev.position_ms, next.position_ms) {
                (Some(prev_pos), Some(next_pos)) => {
                    let expected = if prev.status == PlaybackStatus::Playing {
                        prev_pos.saturating_add(
                            now.saturating_duration_since(last.at).as_millis() as u64
                        )
                    } else {
                        prev_pos
                    };
                    expected.abs_diff(next_pos) > SEEK_TOLERANCE_MS
                }
                (None, None) => false,
                _ => true,
            }
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn player(identity: &str, status: PlaybackStatus, title: &str, seq: u64) -> PlayerState {
        PlayerState {
            identity: identity.to_string(),
            status,
            title: Some(title.to_string()),
            artists: vec!["Artist".to_string()],
            changed_seq: seq,
            ..PlayerState::default()
        }
    }

    #[test]
    fn a_playing_player_beats_a_more_recent_paused_one() {
        let players = [
            player("Spotify", PlaybackStatus::Playing, "A", 1),
            player("mpv", PlaybackStatus::Paused, "B", 5),
        ];
        assert_eq!(pick_active(&players).unwrap().identity, "Spotify");
    }

    #[test]
    fn among_playing_players_the_most_recently_changed_wins() {
        let players = [
            player("Spotify", PlaybackStatus::Playing, "A", 1),
            player("mpv", PlaybackStatus::Playing, "B", 7),
        ];
        assert_eq!(pick_active(&players).unwrap().identity, "mpv");
    }

    #[test]
    fn stopped_untitled_and_paracord_players_never_count() {
        let mut own = player("Paracord", PlaybackStatus::Playing, "Voice", 9);
        own.belongs_to_paracord = true;
        let players = [
            player("Spotify", PlaybackStatus::Stopped, "A", 3),
            player("mpv", PlaybackStatus::Playing, "  ", 4),
            own,
        ];
        assert!(pick_active(&players).is_none());
    }

    #[test]
    fn paracord_media_is_recognized_by_name_and_by_page_title() {
        assert!(is_paracord_media("Paracord", None, Some("anything")));
        assert!(is_paracord_media("", Some("paracord-desktop"), None));
        assert!(is_paracord_media(
            "Mozilla Firefox",
            Some("firefox"),
            Some("Paracord")
        ));
        assert!(is_paracord_media(
            "Chromium",
            None,
            Some("#general - Paracord")
        ));
        assert!(!is_paracord_media(
            "Spotify",
            Some("spotify"),
            Some("Paranoid Android")
        ));
        assert!(!is_paracord_media(
            "Mozilla Firefox",
            Some("firefox"),
            Some("Lo-fi beats")
        ));
    }

    #[test]
    fn now_playing_joins_artists_and_extrapolates_position() {
        let start = Instant::now();
        let state = PlayerState {
            identity: "Spotify".into(),
            status: PlaybackStatus::Playing,
            title: Some("Windowlicker".into()),
            artists: vec!["Aphex Twin".into(), " ".into(), "Richard D. James".into()],
            length_ms: Some(367_000),
            position_ms: Some(10_000),
            position_read_at: Some(start),
            ..PlayerState::default()
        };
        let now = state.now_playing(start + Duration::from_secs(5)).unwrap();
        assert_eq!(now.artist.as_deref(), Some("Aphex Twin, Richard D. James"));
        assert_eq!(now.position_ms, Some(15_000));
        assert_eq!(now.duration_ms, Some(367_000));

        let paused = PlayerState {
            status: PlaybackStatus::Paused,
            ..state.clone()
        };
        assert_eq!(
            paused
                .now_playing(start + Duration::from_secs(5))
                .unwrap()
                .position_ms,
            Some(10_000),
            "a paused track does not advance"
        );
        let ended = state
            .now_playing(start + Duration::from_secs(3600))
            .unwrap();
        assert_eq!(ended.position_ms, Some(367_000), "clamped to the length");
    }

    #[test]
    fn an_empty_identity_falls_back_to_the_desktop_entry() {
        let state = PlayerState {
            desktop_entry: Some("org.gnome.Rhythmbox3".into()),
            status: PlaybackStatus::Playing,
            title: Some("x".into()),
            ..PlayerState::default()
        };
        assert_eq!(
            state.now_playing(Instant::now()).unwrap().player,
            "Rhythmbox3"
        );
    }

    #[test]
    fn position_advancing_with_the_clock_is_not_news_but_a_seek_is() {
        let start = Instant::now();
        let track = |position_ms| NowPlaying {
            player: "mpv".into(),
            title: "A".into(),
            artist: None,
            status: PlaybackStatus::Playing,
            position_ms: Some(position_ms),
            duration_ms: Some(200_000),
        };
        let last = Emitted {
            value: Some(track(10_000)),
            at: start,
        };
        let later = start + Duration::from_secs(30);
        assert!(!should_emit(Some(&last), &Some(track(40_500)), later));
        assert!(should_emit(Some(&last), &Some(track(90_000)), later));
        assert!(should_emit(Some(&last), &None, later));
        let mut other = track(40_000);
        other.title = "B".into();
        assert!(should_emit(Some(&last), &Some(other), later));
        assert!(
            should_emit(None, &None, later),
            "the first reading is always sent"
        );
        let idle = Emitted {
            value: None,
            at: start,
        };
        assert!(!should_emit(Some(&idle), &None, later));
    }
}
