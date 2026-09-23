//! Which score lines to post for a pinned game.
//!
//! Pure: the same cursor and the same detail always produce the same lines.
//! The caller posts them and stores the cursor. A second pass with that cursor
//! posts nothing.

use super::models::{GameDetail, ScoringPlay, Team};

/// What the pin remembers between passes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnounceCursor {
    pub announce: bool,
    /// Last scoring play already posted. Plays after it in the feed's order are new.
    pub through: Option<String>,
    pub halftime: bool,
    pub regulation: bool,
    pub final_score: bool,
    /// Set when the channel cannot take readable text. `"encrypted"` is the only value.
    pub blocked: Option<String>,
}

impl Default for AnnounceCursor {
    fn default() -> Self {
        Self {
            announce: true,
            through: None,
            halftime: false,
            regulation: false,
            final_score: false,
            blocked: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreKind {
    Scoring,
    Halftime,
    Regulation,
    Final,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreUpdate {
    pub kind: ScoreKind,
    pub play_id: Option<String>,
    pub content: String,
}

/// The slice of a game detail the lines are built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreSnapshot {
    pub state: String,
    pub detail: String,
    pub period: i32,
    pub kind: String,
    pub home_id: String,
    pub away_id: String,
    pub home_name: String,
    pub away_name: String,
    pub home_score: i32,
    pub away_score: i32,
    pub plays: Vec<ScorePlay>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScorePlay {
    pub id: String,
    pub text: String,
    pub type_text: String,
    pub period: Option<i32>,
    pub period_label: Option<String>,
    pub clock: Option<String>,
    pub team_id: String,
    pub home_score: i32,
    pub away_score: i32,
}

impl ScoreSnapshot {
    pub fn from_detail(detail: &GameDetail) -> Self {
        let game = &detail.game;
        let home_score = game.home.score.unwrap_or(0);
        let away_score = game.away.score.unwrap_or(0);
        Self {
            state: game.state.clone(),
            detail: game.detail.clone(),
            period: game.period,
            kind: detail.kind.clone(),
            home_id: game.home.id.clone(),
            away_id: game.away.id.clone(),
            home_name: team_name(&game.home, "Home"),
            away_name: team_name(&game.away, "Away"),
            home_score,
            away_score,
            plays: detail
                .scoring_plays
                .iter()
                .map(|play| score_play(play, home_score, away_score))
                .collect(),
        }
    }
}

fn team_name(team: &Team, fallback: &str) -> String {
    let short = team.short_name.trim();
    if !short.is_empty() {
        return short.to_string();
    }
    let abbr = team.abbr.trim();
    if !abbr.is_empty() {
        return abbr.to_string();
    }
    fallback.to_string()
}

fn score_play(play: &ScoringPlay, home_score: i32, away_score: i32) -> ScorePlay {
    ScorePlay {
        id: play.id.clone(),
        text: play.text.trim().to_string(),
        type_text: play.type_text.clone(),
        period: play.period,
        period_label: play.period_label.clone(),
        clock: play.clock.clone(),
        team_id: play.team_id.clone(),
        home_score: play.home_score.unwrap_or(home_score),
        away_score: play.away_score.unwrap_or(away_score),
    }
}

/// New lines, plus the cursor to store after they have been posted.
pub fn plan_score_updates(
    previous: &AnnounceCursor,
    detail: &ScoreSnapshot,
) -> (Vec<ScoreUpdate>, AnnounceCursor) {
    if !previous.announce || previous.blocked.is_some() || previous.final_score {
        return (Vec::new(), previous.clone());
    }
    let mut next = previous.clone();
    let mut messages = Vec::new();
    let start = match previous.through.as_deref() {
        None => 0,
        Some(id) => match detail.plays.iter().position(|play| play.id == id) {
            Some(index) => index + 1,
            None => detail.plays.len(),
        },
    };
    for play in detail.plays.iter().skip(start) {
        messages.push(ScoreUpdate {
            kind: ScoreKind::Scoring,
            play_id: Some(play.id.clone()),
            content: scoring_line(detail, play),
        });
        next.through = Some(play.id.clone());
    }
    if !next.halftime && is_halftime(detail) {
        messages.push(ScoreUpdate {
            kind: ScoreKind::Halftime,
            play_id: None,
            content: status_line("Halftime", detail, false),
        });
        next.halftime = true;
    }
    if !next.regulation && is_end_of_regulation(detail) {
        messages.push(ScoreUpdate {
            kind: ScoreKind::Regulation,
            play_id: None,
            content: status_line("End of regulation", detail, false),
        });
        next.regulation = true;
    }
    if detail.state.eq_ignore_ascii_case("post") {
        messages.push(ScoreUpdate {
            kind: ScoreKind::Final,
            play_id: None,
            content: status_line("Final", detail, went_overtime(detail)),
        });
        next.final_score = true;
    }
    (messages, next)
}

fn is_halftime(detail: &ScoreSnapshot) -> bool {
    !detail.state.eq_ignore_ascii_case("post")
        && detail.detail.to_ascii_lowercase().contains("halftime")
}

fn is_end_of_regulation(detail: &ScoreSnapshot) -> bool {
    if detail.state.eq_ignore_ascii_case("post") {
        return false;
    }
    let text = detail.detail.to_ascii_lowercase();
    text.contains("end of regulation") || (detail.kind == "football" && detail.period >= 5)
}

fn went_overtime(detail: &ScoreSnapshot) -> bool {
    if detail.kind == "football" && detail.period >= 5 {
        return true;
    }
    let text = detail.detail.to_ascii_lowercase();
    text.contains("overtime")
        || text.contains("/ot")
        || text.split_whitespace().any(|word| {
            let word = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '/');
            word == "ot" || word == "final/ot"
        })
}

fn scoring_line(detail: &ScoreSnapshot, play: &ScorePlay) -> String {
    let (first_name, first_score, second_name, second_score) = if play.team_id == detail.home_id {
        (
            detail.home_name.as_str(),
            play.home_score,
            detail.away_name.as_str(),
            play.away_score,
        )
    } else if play.team_id == detail.away_id {
        (
            detail.away_name.as_str(),
            play.away_score,
            detail.home_name.as_str(),
            play.home_score,
        )
    } else if play.home_score >= play.away_score {
        (
            detail.home_name.as_str(),
            play.home_score,
            detail.away_name.as_str(),
            play.away_score,
        )
    } else {
        (
            detail.away_name.as_str(),
            play.away_score,
            detail.home_name.as_str(),
            play.home_score,
        )
    };
    let when = when_clause(play.clock.as_deref().unwrap_or(""), &period_name(play));
    sentence(
        play_label(&play.type_text, &play.text),
        &score_pair(first_name, first_score, second_name, second_score),
        &when,
        &play.text,
        "",
    )
}

fn status_line(label: &str, detail: &ScoreSnapshot, overtime: bool) -> String {
    let (first_name, first_score, second_name, second_score) =
        if detail.away_score > detail.home_score {
            (
                detail.away_name.as_str(),
                detail.away_score,
                detail.home_name.as_str(),
                detail.home_score,
            )
        } else {
            (
                detail.home_name.as_str(),
                detail.home_score,
                detail.away_name.as_str(),
                detail.away_score,
            )
        };
    let suffix = if overtime { " (OT)" } else { "" };
    sentence(
        label,
        &score_pair(first_name, first_score, second_name, second_score),
        "",
        "",
        suffix,
    )
}

fn sentence(label: &str, scores: &str, when: &str, text: &str, suffix: &str) -> String {
    let mut line = format!("{label} — {scores}{suffix}");
    if !when.is_empty() {
        line.push_str(" · ");
        line.push_str(when);
    }
    if !text.is_empty() {
        line.push_str(" · ");
        line.push_str(text);
    }
    line
}

fn score_pair(first_name: &str, first_score: i32, second_name: &str, second_score: i32) -> String {
    format!("{first_name} {first_score}, {second_name} {second_score}")
}

fn when_clause(clock: &str, period: &str) -> String {
    match (clock.is_empty(), period.is_empty()) {
        (true, true) => String::new(),
        (false, true) => clock.to_string(),
        (true, false) => period.to_string(),
        (false, false) => format!("{clock} {period}"),
    }
}

fn period_name(play: &ScorePlay) -> String {
    if let Some(label) = play.period_label.as_deref().filter(|text| !text.is_empty()) {
        return label.to_string();
    }
    match play.period {
        Some(1) => "1st".to_string(),
        Some(2) => "2nd".to_string(),
        Some(3) => "3rd".to_string(),
        Some(number) if number >= 5 => "OT".to_string(),
        Some(number) => format!("{number}th"),
        None => String::new(),
    }
}

fn play_label(type_text: &str, text: &str) -> &'static str {
    let source = if type_text.trim().is_empty() {
        text
    } else {
        type_text
    };
    let lower = source.to_ascii_lowercase();
    if lower.contains("safety") {
        "Safety"
    } else if lower.contains("field goal") {
        "Field goal"
    } else if lower.contains("two-point") || lower.contains("two point") {
        "Two-point"
    } else if lower.contains("extra point") {
        "Extra point"
    } else if lower.contains("touchdown") {
        "Touchdown"
    } else if lower.contains("home run") {
        "Home run"
    } else {
        "Score"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(state: &str, detail: &str, period: i32, home: i32, away: i32) -> ScoreSnapshot {
        ScoreSnapshot {
            state: state.to_string(),
            detail: detail.to_string(),
            period,
            kind: "football".to_string(),
            home_id: "12".to_string(),
            away_id: "11".to_string(),
            home_name: "Chiefs".to_string(),
            away_name: "Colts".to_string(),
            home_score: home,
            away_score: away,
            plays: Vec::new(),
        }
    }

    fn touchdown(id: &str, home: i32, away: i32) -> ScorePlay {
        ScorePlay {
            id: id.to_string(),
            text: "K.Walker 4 yd run".to_string(),
            type_text: "Rushing Touchdown".to_string(),
            period: Some(2),
            period_label: Some("2nd".to_string()),
            clock: Some("8:41".to_string()),
            team_id: "12".to_string(),
            home_score: home,
            away_score: away,
        }
    }

    #[test]
    fn a_scoring_play_is_posted_once() {
        let mut detail = snap("in", "8:41 - 2nd", 2, 14, 7);
        detail.plays.push(touchdown("9001", 14, 7));
        let (lines, cursor) = plan_score_updates(&AnnounceCursor::default(), &detail);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0].content,
            "Touchdown — Chiefs 14, Colts 7 · 8:41 2nd · K.Walker 4 yd run"
        );
        assert_eq!(lines[0].play_id.as_deref(), Some("9001"));
        assert_eq!(cursor.through.as_deref(), Some("9001"));
        let (again, _) = plan_score_updates(&cursor, &detail);
        assert!(again.is_empty());
    }

    #[test]
    fn a_later_scoring_play_is_the_only_new_line() {
        let mut detail = snap("in", "3:12 - 3rd", 3, 21, 7);
        detail.plays.push(touchdown("1", 7, 0));
        detail.plays.push(touchdown("2", 14, 7));
        let (_, cursor) = plan_score_updates(&AnnounceCursor::default(), &detail);
        detail.plays.push(ScorePlay {
            id: "3".to_string(),
            text: "Butker 38 yd field goal".to_string(),
            type_text: "Field Goal".to_string(),
            period: Some(3),
            period_label: Some("3rd".to_string()),
            clock: Some("3:12".to_string()),
            team_id: "12".to_string(),
            home_score: 17,
            away_score: 7,
        });
        let (lines, cursor) = plan_score_updates(&cursor, &detail);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0].content,
            "Field goal — Chiefs 17, Colts 7 · 3:12 3rd · Butker 38 yd field goal"
        );
        assert_eq!(cursor.through.as_deref(), Some("3"));
    }

    #[test]
    fn a_missing_play_id_does_not_replay_the_list() {
        let mut detail = snap("in", "8:41 - 2nd", 2, 14, 7);
        detail.plays.push(touchdown("9001", 14, 7));
        let cursor = AnnounceCursor {
            through: Some("gone".to_string()),
            ..AnnounceCursor::default()
        };
        let (lines, next) = plan_score_updates(&cursor, &detail);
        assert!(lines.is_empty());
        assert_eq!(next.through.as_deref(), Some("gone"));
    }

    #[test]
    fn the_team_that_scored_is_named_first() {
        let mut detail = snap("in", "Top 4th", 4, 14, 10);
        detail.kind = "baseball".to_string();
        detail.plays.push(ScorePlay {
            id: "hr".to_string(),
            text: "Walker homered to left".to_string(),
            type_text: "Home Run".to_string(),
            period: Some(4),
            period_label: Some("Top 4th".to_string()),
            clock: None,
            team_id: "11".to_string(),
            home_score: 14,
            away_score: 10,
        });
        let (lines, _) = plan_score_updates(&AnnounceCursor::default(), &detail);
        assert_eq!(
            lines[0].content,
            "Home run — Colts 10, Chiefs 14 · Top 4th · Walker homered to left"
        );
    }

    #[test]
    fn halftime_is_posted_once_and_a_quarter_break_is_not() {
        let cursor = AnnounceCursor::default();
        let quiet = snap("in", "End of 1st", 1, 7, 0);
        let (lines, cursor) = plan_score_updates(&cursor, &quiet);
        assert!(lines.is_empty());
        let mut inning = snap("in", "End of 5th", 5, 3, 2);
        inning.kind = "baseball".to_string();
        let (lines, _) = plan_score_updates(&cursor, &inning);
        assert!(lines.is_empty());

        let half = snap("in", "Halftime", 2, 17, 20);
        let (lines, cursor) = plan_score_updates(&cursor, &half);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].content, "Halftime — Colts 20, Chiefs 17");
        assert!(cursor.halftime);
        let (again, _) = plan_score_updates(&cursor, &half);
        assert!(again.is_empty());
    }

    #[test]
    fn overtime_posts_the_end_of_regulation_once() {
        let ot = snap("in", "15:00 - OT", 5, 20, 20);
        let (lines, cursor) = plan_score_updates(&AnnounceCursor::default(), &ot);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].kind, ScoreKind::Regulation);
        assert_eq!(lines[0].content, "End of regulation — Chiefs 20, Colts 20");
        let (again, _) = plan_score_updates(&cursor, &ot);
        assert!(again.is_empty());
    }

    #[test]
    fn the_final_is_posted_once_and_stops_the_pin() {
        let mut done = snap("post", "Final", 4, 24, 17);
        done.plays.push(touchdown("9", 7, 0));
        let (lines, cursor) = plan_score_updates(&AnnounceCursor::default(), &done);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].content, "Final — Chiefs 24, Colts 17");
        assert!(cursor.final_score);
        done.plays.push(touchdown("10", 14, 0));
        let (again, _) = plan_score_updates(&cursor, &done);
        assert!(again.is_empty());

        let overtime = snap("post", "Final/OT", 5, 33, 30);
        let (lines, _) = plan_score_updates(&AnnounceCursor::default(), &overtime);
        assert_eq!(lines[0].content, "Final — Chiefs 33, Colts 30 (OT)");
    }

    #[test]
    fn announce_off_and_an_encrypted_channel_post_nothing() {
        let mut detail = snap("in", "8:41 - 2nd", 2, 14, 7);
        detail.plays.push(touchdown("9001", 14, 7));
        let off = AnnounceCursor {
            announce: false,
            ..AnnounceCursor::default()
        };
        assert!(plan_score_updates(&off, &detail).0.is_empty());
        let blocked = AnnounceCursor {
            blocked: Some("encrypted".to_string()),
            ..AnnounceCursor::default()
        };
        let (lines, cursor) = plan_score_updates(&blocked, &detail);
        assert!(lines.is_empty());
        assert_eq!(cursor.blocked.as_deref(), Some("encrypted"));
    }
}
