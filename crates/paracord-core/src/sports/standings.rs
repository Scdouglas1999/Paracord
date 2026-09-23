//! League standings from ESPN's standings document.
//!
//! The document is a tree: league, then conference, then division, with the
//! table on whichever nodes carry `standings.entries`. Each of those nodes is
//! one group here, in feed order, and rows keep ESPN's own order, which is
//! already the table's order. The columns depend on the sport; a column no
//! row has a value for is left out.

use serde::Serialize;
use serde_json::Value;

use super::espn::{hex_color, int_field, sanitize_logo, str_field};
use super::models::RosterTeam;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StandingsColumn {
    /// ESPN stat type, e.g. `winpercent`.
    pub key: String,
    /// Short heading, e.g. `PCT`.
    pub label: String,
    /// What the heading means, for a tooltip or a screen reader.
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StandingsRow {
    pub team: RosterTeam,
    /// One per column, in column order. Empty when the feed has no value.
    pub values: Vec<String>,
    pub seed: Option<i32>,
    /// ESPN's clinch mark, e.g. `x`, `y`, `z`, `e`. `None` when there is none.
    pub clincher: Option<String>,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StandingsGroup {
    pub name: String,
    /// The conference a division sits in, when the feed nests them.
    pub parent: Option<String>,
    pub rows: Vec<StandingsRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeagueStandings {
    pub league: String,
    pub label: String,
    pub season: Option<String>,
    pub fetched_at: String,
    /// True when the last refresh failed and this is the last good table.
    pub stale: bool,
    pub columns: Vec<StandingsColumn>,
    pub groups: Vec<StandingsGroup>,
}

/// The parsed table before it is stamped with a time and favorites.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedStandings {
    pub season: Option<String>,
    pub columns: Vec<StandingsColumn>,
    pub groups: Vec<StandingsGroup>,
}

type ColumnSpec = (&'static str, &'static str, &'static str);

const FOOTBALL: &[ColumnSpec] = &[
    ("wins", "W", "Wins"),
    ("losses", "L", "Losses"),
    ("ties", "T", "Ties"),
    ("winpercent", "PCT", "Winning percentage"),
    ("pointsfor", "PF", "Points for"),
    ("pointsagainst", "PA", "Points against"),
    ("pointdifferential", "DIFF", "Point differential"),
    ("streak", "STRK", "Streak"),
];
const BASEBALL: &[ColumnSpec] = &[
    ("wins", "W", "Wins"),
    ("losses", "L", "Losses"),
    ("winpercent", "PCT", "Winning percentage"),
    ("gamesbehind", "GB", "Games behind"),
    ("lasttengames", "L10", "Last ten games"),
    ("streak", "STRK", "Streak"),
    ("pointdifferential", "DIFF", "Run differential"),
];
const BASKETBALL: &[ColumnSpec] = &[
    ("wins", "W", "Wins"),
    ("losses", "L", "Losses"),
    ("winpercent", "PCT", "Winning percentage"),
    ("gamesbehind", "GB", "Games behind"),
    ("streak", "STRK", "Streak"),
];
const HOCKEY: &[ColumnSpec] = &[
    ("gamesplayed", "GP", "Games played"),
    ("wins", "W", "Wins"),
    ("losses", "L", "Losses"),
    ("otlosses", "OTL", "Overtime losses"),
    ("points", "PTS", "Points"),
    ("pointdifferential", "DIFF", "Goal differential"),
    ("streak", "STRK", "Streak"),
];
const SOCCER: &[ColumnSpec] = &[
    ("gamesplayed", "GP", "Games played"),
    ("wins", "W", "Wins"),
    ("ties", "D", "Draws"),
    ("losses", "L", "Losses"),
    ("pointdifferential", "GD", "Goal difference"),
    ("points", "P", "Points"),
];
const OTHER: &[ColumnSpec] = &[
    ("wins", "W", "Wins"),
    ("losses", "L", "Losses"),
    ("ties", "T", "Ties"),
    ("winpercent", "PCT", "Winning percentage"),
    ("points", "PTS", "Points"),
];

fn column_specs(league: &str) -> &'static [ColumnSpec] {
    match league.split('/').next().unwrap_or("") {
        "football" => FOOTBALL,
        "baseball" => BASEBALL,
        "basketball" => BASKETBALL,
        "hockey" => HOCKEY,
        "soccer" => SOCCER,
        _ => OTHER,
    }
}

pub(crate) fn standings_url(host: &str, league: &str) -> String {
    format!("https://{host}/apis/v2/sports/{league}/standings?level=3")
}

pub(crate) fn parse_standings(json: &str, league: &str) -> Result<ParsedStandings, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|_| "invalid standings json".to_string())?;
    if !root.is_object() {
        return Err("invalid standings json".to_string());
    }
    let specs = column_specs(league);
    let mut groups = Vec::new();
    let mut season = None;
    collect(&root, None, true, specs, &mut groups, &mut season);

    let used: Vec<bool> = (0..specs.len())
        .map(|index| {
            groups.iter().any(|group: &StandingsGroup| {
                group.rows.iter().any(|row| !row.values[index].is_empty())
            })
        })
        .collect();
    let columns = specs
        .iter()
        .zip(&used)
        .filter(|(_, used)| **used)
        .map(|((key, label, title), _)| StandingsColumn {
            key: (*key).to_string(),
            label: (*label).to_string(),
            title: (*title).to_string(),
        })
        .collect();
    for group in &mut groups {
        for row in &mut group.rows {
            let mut index = 0;
            row.values.retain(|_| {
                let keep = used[index];
                index += 1;
                keep
            });
        }
    }
    Ok(ParsedStandings {
        season,
        columns,
        groups,
    })
}

fn collect(
    node: &Value,
    parent: Option<&str>,
    root: bool,
    specs: &[ColumnSpec],
    groups: &mut Vec<StandingsGroup>,
    season: &mut Option<String>,
) {
    let name = str_field(node, "name").unwrap_or_default();
    if let Some(table) = node.get("standings").filter(|value| value.is_object()) {
        if season.is_none() {
            *season = str_field(table, "seasonDisplayName").filter(|text| !text.is_empty());
        }
        let rows: Vec<StandingsRow> = table
            .get("entries")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| row(entry, specs))
                    .collect()
            })
            .unwrap_or_default();
        if !rows.is_empty() {
            groups.push(StandingsGroup {
                name: name.clone(),
                parent: parent.map(str::to_string),
                rows,
            });
        }
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        let next_parent = if root { None } else { Some(name.as_str()) };
        for child in children {
            collect(child, next_parent, false, specs, groups, season);
        }
    }
}

fn row(entry: &Value, specs: &[ColumnSpec]) -> Option<StandingsRow> {
    let info = entry.get("team").filter(|value| value.is_object())?;
    let id = str_field(info, "id").filter(|id| !id.is_empty())?;
    let name = str_field(info, "displayName").unwrap_or_default();
    let short_name = str_field(info, "shortDisplayName")
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| name.clone());
    let logo = info
        .get("logos")
        .and_then(Value::as_array)
        .and_then(|logos| logos.first())
        .and_then(|logo| str_field(logo, "href"))
        .map(|href| sanitize_logo(&href))
        .unwrap_or_default();
    let stats: Vec<&Value> = entry
        .get("stats")
        .and_then(Value::as_array)
        .map(|stats| stats.iter().collect())
        .unwrap_or_default();
    let stat = |kind: &str| -> Option<&Value> {
        stats
            .iter()
            .copied()
            .find(|stat| str_field(stat, "type").is_some_and(|value| value == kind))
    };
    let display = |kind: &str| -> String {
        stat(kind)
            .and_then(|stat| str_field(stat, "displayValue"))
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    };
    let values = specs.iter().map(|(key, _, _)| display(key)).collect();
    let seed = stat("playoffseed")
        .and_then(|stat| int_field(stat, "value"))
        .filter(|seed| *seed > 0);
    let clincher =
        Some(display("clincher")).filter(|mark| !mark.is_empty() && mark.chars().count() <= 3);
    Some(StandingsRow {
        team: RosterTeam {
            id,
            abbr: str_field(info, "abbreviation").unwrap_or_default(),
            name,
            short_name,
            logo,
            color: hex_color(info, "color"),
            alt_color: hex_color(info, "alternateColor"),
        },
        values,
        seed,
        clincher,
        favorite: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NFL: &str = include_str!("fixtures/nfl_standings.json");
    const MLB: &str = include_str!("fixtures/mlb_standings.json");
    const SOCCER: &str = include_str!("fixtures/soccer_standings.json");

    fn column_index(parsed: &ParsedStandings, key: &str) -> usize {
        parsed
            .columns
            .iter()
            .position(|column| column.key == key)
            .unwrap_or_else(|| panic!("no {key} column"))
    }

    #[test]
    fn nfl_divisions_sit_under_their_conference() {
        let parsed = parse_standings(NFL, "football/nfl").expect("nfl");
        assert_eq!(parsed.groups.len(), 8);
        assert_eq!(parsed.groups[0].name, "AFC East");
        assert_eq!(
            parsed.groups[0].parent.as_deref(),
            Some("American Football Conference")
        );
        assert!(parsed.groups.iter().all(|group| group.rows.len() == 4));
        assert_eq!(parsed.season.as_deref(), Some("2026"));
        let labels: Vec<&str> = parsed.columns.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["W", "L", "T", "PCT", "PF", "PA", "DIFF", "STRK"]);
        let bills = &parsed.groups[0].rows[0];
        assert_eq!(bills.team.abbr, "BUF");
        assert!(bills.team.logo.starts_with("https://a.espncdn.com/"));
        assert_eq!(bills.values.len(), parsed.columns.len());
        assert_eq!(
            bills.values[column_index(&parsed, "pointdifferential")],
            "+15"
        );
        assert_eq!(bills.seed, Some(2));
    }

    #[test]
    fn mlb_keeps_feed_order_and_the_clinch_mark() {
        let parsed = parse_standings(MLB, "baseball/mlb").expect("mlb");
        assert_eq!(parsed.groups.len(), 6);
        assert_eq!(parsed.groups[0].name, "American League East");
        assert_eq!(parsed.groups[0].parent.as_deref(), Some("American League"));
        let labels: Vec<&str> = parsed.columns.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["W", "L", "PCT", "GB", "L10", "STRK", "DIFF"]);
        let first = &parsed.groups[0].rows[0];
        assert_eq!(first.team.abbr, "TB");
        assert_eq!(first.values[column_index(&parsed, "gamesbehind")], "-");
        assert_eq!(first.clincher.as_deref(), Some("z"));
    }

    #[test]
    fn a_single_table_league_has_one_group_and_soccer_columns() {
        let parsed = parse_standings(SOCCER, "soccer/eng.1").expect("soccer");
        assert_eq!(parsed.groups.len(), 1);
        assert!(parsed.groups[0].parent.is_none());
        assert_eq!(parsed.groups[0].rows.len(), 20);
        let labels: Vec<&str> = parsed.columns.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["GP", "W", "D", "L", "GD", "P"]);
    }

    #[test]
    fn a_column_nobody_has_is_dropped_and_junk_is_an_error() {
        let body = r#"{"name":"L","children":[{"name":"G","standings":{"entries":[
            {"team":{"id":"1","abbreviation":"A","displayName":"Alpha"},"stats":[{"type":"wins","displayValue":"3"}]},
            {"team":{"displayName":"No id"},"stats":[]}
        ]}}]}"#;
        let parsed = parse_standings(body, "football/nfl").expect("minimal");
        assert_eq!(parsed.columns.len(), 1);
        assert_eq!(parsed.columns[0].label, "W");
        assert_eq!(parsed.groups[0].rows.len(), 1);
        assert_eq!(parsed.groups[0].rows[0].values, ["3"]);
        assert!(parse_standings("not json", "football/nfl").is_err());
        assert!(parse_standings("[]", "football/nfl").is_err());
    }
}
