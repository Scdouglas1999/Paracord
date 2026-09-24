//! What a check posts, and when the next check runs. Pure: the same inputs
//! always give the same answer, so every rule here has a unit test.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};

use super::parse::FeedItem;
use super::FeedKind;

/// Cards one subscription posts from one check. The rest become one line.
pub const MAX_CARDS_PER_CHECK: usize = 5;
/// Longest wait after repeated errors.
pub const MAX_BACKOFF: Duration = Duration::hours(1);

/// What one check posts for one subscription.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PostPlan {
    /// Cards to post, oldest first so the channel reads in order.
    pub cards: Vec<FeedItem>,
    /// Cards past the cap, told as "and N more from <source>".
    pub more: usize,
    /// Every key this check saw for the first time.
    pub new_items: Vec<FeedItem>,
}

/// Plan a check. `items` are newest first; `seen` are the keys the
/// subscription already knows.
pub fn plan_posts(kind: FeedKind, items: &[FeedItem], seen: &HashSet<String>) -> PostPlan {
    let new_items: Vec<FeedItem> = items
        .iter()
        .filter(|item| !seen.contains(&item.key))
        .cloned()
        .collect();
    if new_items.is_empty() {
        return PostPlan::default();
    }
    let mut cards = if kind == FeedKind::Jellyfin {
        group_cards(&new_items)
    } else {
        new_items.clone()
    };
    let more = cards.len().saturating_sub(MAX_CARDS_PER_CHECK);
    cards.truncate(MAX_CARDS_PER_CHECK);
    cards.reverse();
    PostPlan {
        cards,
        more,
        new_items,
    }
}

/// Items that share a group (episodes of one series) become one card:
/// "3 new episodes of Severance". The card keeps the newest episode's date
/// and link to the series. Order is newest first, by each group's newest item.
pub fn group_cards(items: &[FeedItem]) -> Vec<FeedItem> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&FeedItem>> = HashMap::new();
    for item in items {
        let key = item
            .group
            .clone()
            .unwrap_or_else(|| format!("item:{}", item.key));
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(item);
    }
    order
        .into_iter()
        .filter_map(|key| {
            let members = groups.remove(&key)?;
            let first = members.first()?;
            if members.len() == 1 {
                let mut card = (*first).clone();
                card.keys = vec![card.key.clone()];
                return Some(card);
            }
            let series = first
                .group_title
                .clone()
                .unwrap_or_else(|| "a series".to_string());
            let mut card = (*first).clone();
            card.title = format!("{} new episodes of {series}", members.len());
            let prefix = format!("{series} · ");
            card.summary = Some(
                members
                    .iter()
                    .rev()
                    .map(|item| {
                        let episode = item.title.strip_prefix(&prefix).unwrap_or(&item.title);
                        episode.replacen(" · ", " ", 1)
                    })
                    .collect::<Vec<_>>()
                    .join(" · "),
            )
            .map(|text| super::parse::truncate_chars(&text, super::parse::SUMMARY_CHARS));
            card.keys = members.iter().map(|item| item.key.clone()).collect();
            card.key = format!("group:{key}:{}", first.key);
            Some(card)
        })
        .collect()
}

/// When a source is checked next.
///
/// `errors` is the number of failed checks in a row, counting this one when
/// it failed. Each failure doubles the wait, up to an hour. `jitter` in 0..1
/// spreads checks out so feeds added together do not fire together.
pub fn next_check(kind: FeedKind, now: DateTime<Utc>, errors: i64, jitter: f64) -> DateTime<Utc> {
    let base = kind.interval();
    let mut wait = base;
    for _ in 0..errors.clamp(0, 16) {
        wait = (wait * 2).min(MAX_BACKOFF);
    }
    if errors > 0 && wait < base {
        wait = base;
    }
    let spread = (base.num_milliseconds() as f64 * 0.1 * jitter.clamp(0.0, 1.0)) as i64;
    now + wait + Duration::milliseconds(spread)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str) -> FeedItem {
        FeedItem {
            key: key.to_string(),
            title: format!("Title {key}"),
            ..FeedItem::default()
        }
    }

    #[test]
    fn only_unseen_items_post_oldest_first() {
        let items = vec![item("c"), item("b"), item("a")];
        let seen: HashSet<String> = ["a".to_string()].into();
        let plan = plan_posts(FeedKind::Rss, &items, &seen);
        let keys: Vec<&str> = plan.cards.iter().map(|card| card.key.as_str()).collect();
        assert_eq!(keys, vec!["b", "c"]);
        assert_eq!(plan.more, 0);
        assert_eq!(plan.new_items.len(), 2);
    }

    #[test]
    fn a_second_check_with_the_same_items_posts_nothing() {
        let items = vec![item("b"), item("a")];
        let seen: HashSet<String> = ["a".to_string(), "b".to_string()].into();
        assert_eq!(
            plan_posts(FeedKind::Rss, &items, &seen),
            PostPlan::default()
        );
    }

    #[test]
    fn at_most_five_cards_and_the_rest_are_counted() {
        let items: Vec<FeedItem> = (0..12).rev().map(|n| item(&format!("k{n}"))).collect();
        let plan = plan_posts(FeedKind::Rss, &items, &HashSet::new());
        assert_eq!(plan.cards.len(), 5);
        assert_eq!(plan.more, 7);
        // The five newest, oldest of them first.
        let keys: Vec<&str> = plan.cards.iter().map(|card| card.key.as_str()).collect();
        assert_eq!(keys, vec!["k7", "k8", "k9", "k10", "k11"]);
        assert_eq!(plan.new_items.len(), 12);
    }

    #[test]
    fn episodes_of_one_series_become_one_card() {
        let mut items = Vec::new();
        for (key, series, title) in [
            ("e3", Some("sev"), "Severance · S2E3"),
            ("m1", None, "Arrival (2016)"),
            ("e2", Some("sev"), "Severance · S2E2"),
            ("e1", Some("sev"), "Severance · S2E1"),
        ] {
            items.push(FeedItem {
                key: key.to_string(),
                title: title.to_string(),
                group: series.map(str::to_string),
                group_title: series.map(|_| "Severance".to_string()),
                ..FeedItem::default()
            });
        }
        let plan = plan_posts(FeedKind::Jellyfin, &items, &HashSet::new());
        assert_eq!(plan.cards.len(), 2);
        // Cards are ordered by each group's newest item. The series' newest
        // episode (e3) is the newest item, so its card posts last.
        assert_eq!(plan.cards[0].title, "Arrival (2016)");
        assert_eq!(plan.cards[1].title, "3 new episodes of Severance");
        assert_eq!(plan.cards[1].keys, vec!["e3", "e2", "e1"]);
        assert_eq!(plan.cards[1].summary.as_deref(), Some("S2E1 · S2E2 · S2E3"));
    }

    #[test]
    fn errors_back_off_to_an_hour() {
        let now = Utc::now();
        let normal = next_check(FeedKind::Rss, now, 0, 0.0);
        assert_eq!(normal - now, Duration::minutes(10));
        assert_eq!(
            next_check(FeedKind::Rss, now, 1, 0.0) - now,
            Duration::minutes(20)
        );
        assert_eq!(
            next_check(FeedKind::Rss, now, 2, 0.0) - now,
            Duration::minutes(40)
        );
        assert_eq!(
            next_check(FeedKind::Rss, now, 3, 0.0) - now,
            Duration::hours(1)
        );
        assert_eq!(
            next_check(FeedKind::Rss, now, 12, 0.0) - now,
            Duration::hours(1)
        );
        assert_eq!(
            next_check(FeedKind::Twitch, now, 0, 0.0) - now,
            Duration::minutes(2)
        );
        assert_eq!(
            next_check(FeedKind::Jellyfin, now, 0, 0.0) - now,
            Duration::minutes(5)
        );
    }

    #[test]
    fn jitter_spreads_by_up_to_a_tenth() {
        let now = Utc::now();
        let late = next_check(FeedKind::Rss, now, 0, 1.0) - now;
        assert_eq!(late, Duration::minutes(11));
    }
}
