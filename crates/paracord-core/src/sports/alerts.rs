//! Which alerts to send when a favorite team's game changes.
//!
//! Pure, like the channel announcer it borrows its sentences from. The caller
//! keeps one [`AlertCursor`] per game and replaces it with the one returned.
//! A cursor seen for the first time mid-game starts at the current score, so a
//! restart does not replay every score of the night.

use super::announce::{plan_score_updates, AnnounceCursor, ScoreKind, ScoreSnapshot};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AlertCursor {
    /// Last scoring play already alerted.
    pub through: Option<String>,
    pub final_sent: bool,
    /// Score and state the last planned detail showed. The caller skips the
    /// detail fetch while the board still matches it.
    pub synced: Option<(i32, i32, String)>,
}

impl AlertCursor {
    /// A game that has not started. Every score from the first one on is new.
    pub fn pregame() -> Self {
        Self::default()
    }

    /// Whether the board has moved since this cursor last looked at the detail.
    pub fn board_moved(&self, home: i32, away: i32, state: &str) -> bool {
        match &self.synced {
            None => true,
            Some((synced_home, synced_away, synced_state)) => {
                *synced_home != home
                    || *synced_away != away
                    || !synced_state.eq_ignore_ascii_case(state)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertKind {
    Score,
    Final,
}

impl AlertKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AlertKind::Score => "score",
            AlertKind::Final => "final",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreAlert {
    pub kind: AlertKind,
    /// The same sentence a pinned channel gets, e.g. `Touchdown — Chiefs 14, Colts 7 · 8:41 2nd`.
    pub content: String,
    /// Team that scored. `None` for the final, or when the feed did not say.
    pub team_id: Option<String>,
}

/// Alerts for `snapshot`, plus the cursor to keep. `previous` of `None` means
/// this game has not been seen before.
pub fn plan_alerts(
    previous: Option<&AlertCursor>,
    snapshot: &ScoreSnapshot,
) -> (Vec<ScoreAlert>, AlertCursor) {
    let synced = Some((
        snapshot.home_score,
        snapshot.away_score,
        snapshot.state.clone(),
    ));
    let Some(previous) = previous else {
        return (
            Vec::new(),
            AlertCursor {
                through: snapshot.plays.last().map(|play| play.id.clone()),
                final_sent: snapshot.state.eq_ignore_ascii_case("post"),
                synced,
            },
        );
    };
    let announce = AnnounceCursor {
        announce: true,
        through: previous.through.clone(),
        halftime: true,
        regulation: true,
        final_score: previous.final_sent,
        blocked: None,
    };
    let (lines, next) = plan_score_updates(&announce, snapshot);
    let alerts = lines
        .into_iter()
        .filter_map(|line| match line.kind {
            ScoreKind::Scoring => Some(ScoreAlert {
                kind: AlertKind::Score,
                team_id: line.play_id.as_deref().and_then(|id| {
                    snapshot
                        .plays
                        .iter()
                        .find(|play| play.id == id)
                        .map(|play| play.team_id.clone())
                        .filter(|team| !team.is_empty())
                }),
                content: line.content,
            }),
            ScoreKind::Final => Some(ScoreAlert {
                kind: AlertKind::Final,
                content: line.content,
                team_id: None,
            }),
            ScoreKind::Halftime | ScoreKind::Regulation => None,
        })
        .collect();
    (
        alerts,
        AlertCursor {
            through: next.through,
            final_sent: next.final_score,
            synced,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::super::announce::ScorePlay;
    use super::*;

    fn play(id: &str, team: &str, home: i32, away: i32) -> ScorePlay {
        ScorePlay {
            id: id.to_string(),
            text: format!("play {id}"),
            type_text: "Touchdown".to_string(),
            period: Some(1),
            period_label: None,
            clock: Some("5:00".to_string()),
            team_id: team.to_string(),
            home_score: home,
            away_score: away,
        }
    }

    fn snapshot(state: &str, detail: &str, plays: Vec<ScorePlay>) -> ScoreSnapshot {
        let (home, away) = plays
            .last()
            .map(|play| (play.home_score, play.away_score))
            .unwrap_or((0, 0));
        ScoreSnapshot {
            state: state.to_string(),
            detail: detail.to_string(),
            period: 2,
            kind: "football".to_string(),
            home_id: "12".to_string(),
            away_id: "11".to_string(),
            home_name: "Chiefs".to_string(),
            away_name: "Colts".to_string(),
            home_score: home,
            away_score: away,
            plays,
        }
    }

    #[test]
    fn a_game_first_seen_mid_game_starts_at_the_current_score() {
        let live = snapshot(
            "in",
            "8:41 - 2nd",
            vec![play("1", "12", 7, 0), play("2", "11", 7, 7)],
        );
        let (alerts, cursor) = plan_alerts(None, &live);
        assert!(alerts.is_empty());
        assert_eq!(cursor.through.as_deref(), Some("2"));
        assert!(!cursor.final_sent);
        assert!(!cursor.board_moved(7, 7, "in"));
        assert!(cursor.board_moved(14, 7, "in"));
        assert!(cursor.board_moved(7, 7, "post"));
    }

    #[test]
    fn a_game_first_seen_after_the_final_says_nothing() {
        let done = snapshot("post", "Final", vec![play("1", "12", 7, 0)]);
        let (alerts, cursor) = plan_alerts(None, &done);
        assert!(alerts.is_empty());
        assert!(cursor.final_sent);
        let (again, _) = plan_alerts(Some(&cursor), &done);
        assert!(again.is_empty());
    }

    #[test]
    fn new_scores_alert_once_with_the_scoring_team_and_skip_halftime() {
        let cursor = AlertCursor::pregame();
        let first = snapshot("in", "Halftime", vec![play("1", "12", 7, 0)]);
        let (alerts, cursor) = plan_alerts(Some(&cursor), &first);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::Score);
        assert_eq!(alerts[0].team_id.as_deref(), Some("12"));
        assert!(alerts[0]
            .content
            .starts_with("Touchdown — Chiefs 7, Colts 0"));

        let (repeat, cursor) = plan_alerts(Some(&cursor), &first);
        assert!(repeat.is_empty());

        let second = snapshot(
            "in",
            "3:00 - 3rd",
            vec![play("1", "12", 7, 0), play("2", "11", 7, 7)],
        );
        let (alerts, cursor) = plan_alerts(Some(&cursor), &second);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].team_id.as_deref(), Some("11"));

        let done = snapshot(
            "post",
            "Final",
            vec![play("1", "12", 7, 0), play("2", "11", 7, 7)],
        );
        let (alerts, cursor) = plan_alerts(Some(&cursor), &done);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::Final);
        assert!(alerts[0].team_id.is_none());
        assert!(cursor.final_sent);
        let (after, _) = plan_alerts(Some(&cursor), &done);
        assert!(after.is_empty());
    }
}
