//! How much a live game deserves the top of the board (0–100), and why.
//!
//! Every point maps to a tag or an obvious fact (late, close, scoring chance).
//! Ported from JellyTV `GameHeat` — the rules are the product.

use chrono::{DateTime, Utc};

use super::models::Game;

pub(crate) fn apply(game: &mut Game, now: DateTime<Utc>) {
    game.tags.clear();
    game.heat = 0;

    if game.state == "pre" {
        let until = game.start.signed_duration_since(now);
        if until <= chrono::Duration::minutes(15) && until >= chrono::Duration::minutes(-10) {
            game.heat = 10;
            game.tags.push("STARTING SOON".to_string());
        }
        return;
    }

    if game.state != "in" {
        return;
    }

    let mut heat: i32 = 20;
    let margin = (i64::from(game.home.score.unwrap_or(0))
        - i64::from(game.away.score.unwrap_or(0)))
    .unsigned_abs();

    match game.sport.as_str() {
        "football" => {
            if game.period >= 5 {
                heat += 40;
                game.tags.push("OVERTIME".to_string());
            } else if game.period == 4 && margin <= 8 {
                heat += 35;
                if game.clock_seconds <= 120.0 {
                    heat += 10;
                    game.tags.push("TWO-MINUTE DRILL".to_string());
                }
                game.tags.push("ONE-SCORE GAME".to_string());
            } else if game.period >= 3 && margin >= 21 {
                heat -= 15;
            }

            if game.red_zone {
                heat += 20;
                game.tags.insert(0, "RED ZONE".to_string());
            }
        }
        "basketball" => {
            let regulation = if game.league.to_ascii_lowercase().contains("ncaa") {
                2
            } else {
                4
            };
            if game.period > regulation {
                heat += 40;
                game.tags.push("OVERTIME".to_string());
            } else if game.period == regulation && game.clock_seconds <= 300.0 && margin <= 6 {
                heat += 40;
                game.tags.push("CLUTCH TIME".to_string());
            } else if game.period >= regulation - 1 && margin >= 20 {
                heat -= 15;
            }
        }
        "baseball" => {
            if game.period >= 10 {
                heat += 40;
                game.tags.push("EXTRA INNINGS".to_string());
            } else if game.period >= 7 && margin <= 2 {
                heat += 30;
                game.tags.push("LATE & CLOSE".to_string());
            } else if game.period >= 6 && margin >= 7 {
                heat -= 15;
            }

            if game.on_first && game.on_second && game.on_third {
                heat += 20;
                game.tags.insert(0, "BASES LOADED".to_string());
            } else if game.on_second || game.on_third {
                heat += 8;
            }
        }
        "hockey" => {
            if game.period >= 4 {
                heat += 40;
                game.tags.push("OVERTIME".to_string());
            } else if game.period == 3 && margin <= 1 {
                heat += 30;
                game.tags.push("ONE-GOAL GAME".to_string());
            }
        }
        "soccer" => {
            if game.period >= 3 {
                heat += 40;
                game.tags.push("EXTRA TIME".to_string());
            } else if game.clock_seconds >= 75.0 * 60.0 && margin <= 1 {
                heat += 30;
                game.tags.push("LATE DRAMA".to_string());
            }
        }
        _ => {}
    }

    if let Some(pct) = game.home_win_pct {
        if (0.25..=0.75).contains(&pct) {
            heat += 10;
        }
    }

    if game.last_play_score > 0 {
        heat += 10;
    }

    game.heat = heat.clamp(0, 100);
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone, Utc};

    use super::super::models::{Game, Team};
    use super::apply;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 20, 20, 0, 0).unwrap()
    }

    fn live(sport: &str, period: i32, clock: f64, home: i32, away: i32) -> Game {
        Game {
            sport: sport.to_string(),
            state: "in".to_string(),
            period,
            clock_seconds: clock,
            home: Team {
                score: Some(home),
                ..Team::default()
            },
            away: Team {
                score: Some(away),
                ..Team::default()
            },
            ..Game::default()
        }
    }

    fn heated(mut game: Game) -> Game {
        apply(&mut game, now());
        game
    }

    fn tag_text(game: &Game) -> Vec<&str> {
        game.tags.iter().map(String::as_str).collect()
    }

    #[test]
    fn late_one_score_red_zone_football_outranks_a_blowout() {
        let mut thriller = live("football", 4, 95.0, 24, 27);
        thriller.red_zone = true;
        let blowout = live("football", 4, 95.0, 3, 34);

        let thriller = heated(thriller);
        let blowout = heated(blowout);

        assert_eq!(
            tag_text(&thriller),
            ["RED ZONE", "TWO-MINUTE DRILL", "ONE-SCORE GAME"]
        );
        assert!(blowout.tags.is_empty());
        assert!(thriller.heat > blowout.heat + 40);
    }

    #[test]
    fn early_close_game_is_warm_not_hot() {
        let game = heated(live("football", 1, 600.0, 7, 7));
        assert!(game.tags.is_empty());
        assert!((1..=40).contains(&game.heat));
    }

    #[test]
    fn sport_specific_moments_are_tagged() {
        let mut bases = live("baseball", 8, 0.0, 3, 4);
        bases.on_first = true;
        bases.on_second = true;
        bases.on_third = true;
        assert_eq!(tag_text(&heated(bases)), ["BASES LOADED", "LATE & CLOSE"]);

        assert_eq!(
            tag_text(&heated(live("hockey", 4, 200.0, 2, 2))),
            ["OVERTIME"]
        );
        assert_eq!(
            tag_text(&heated(live("basketball", 4, 120.0, 101, 99))),
            ["CLUTCH TIME"]
        );
        assert_eq!(
            tag_text(&heated(live("soccer", 2, 80.0 * 60.0, 1, 1))),
            ["LATE DRAMA"]
        );
    }

    #[test]
    fn college_basketball_treats_period_three_as_overtime() {
        let mut game = live("basketball", 3, 60.0, 40, 40);
        game.league = "NCAAM".to_string();
        assert_eq!(tag_text(&heated(game)), ["OVERTIME"]);
    }

    #[test]
    fn only_live_or_imminent_games_carry_heat() {
        let soon = Game {
            state: "pre".to_string(),
            start: now() + chrono::Duration::minutes(10),
            ..Game::default()
        };
        let later = Game {
            state: "pre".to_string(),
            start: now() + chrono::Duration::hours(3),
            ..Game::default()
        };
        let mut final_game = live("football", 4, 0.0, 20, 17);
        final_game.state = "post".to_string();

        assert_eq!(tag_text(&heated(soon)), ["STARTING SOON"]);
        assert_eq!(heated(later).heat, 0);
        assert_eq!(heated(final_game).heat, 0);
    }

    #[test]
    fn heat_is_recomputed_from_scratch_and_clamped() {
        let mut game = live("football", 5, 30.0, 30, 30);
        game.red_zone = true;
        game.home_win_pct = Some(0.5);
        game.last_play_score = 3;

        apply(&mut game, now());
        apply(&mut game, now());

        assert_eq!(tag_text(&game), ["RED ZONE", "OVERTIME"]);
        assert_eq!(game.heat, 100);
    }
}
