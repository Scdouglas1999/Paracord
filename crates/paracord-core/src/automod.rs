//! AutoMod — automatic content rules evaluated on every guild message.
//!
//! A rule is `(trigger, actions, exemptions)`. On send we load the guild's
//! enabled rules, evaluate triggers against the message, and apply the union of
//! the matching rules' actions. `BlockMessage` short-circuits the send with a
//! user-visible reason; the rest run as side effects.
//!
//! Design notes:
//!
//! * **Regex is safe by construction.** Rust's `regex` crate has no backtracking,
//!   so a hostile pattern cannot cause exponential blowup. We still bound the
//!   compiled program size and pattern length so a rule cannot eat unbounded
//!   memory, and compile with a case-insensitive default.
//! * **Rules are validated on write, not on the hot path.** `RuleConfig::parse`
//!   is the single gate: the REST layer calls it before persisting, so a stored
//!   rule that fails to parse is a bug, not user input. On the send path a
//!   malformed rule is skipped and logged rather than failing the message.
//! * **Fail open, never fail closed.** If AutoMod itself errors, the message
//!   sends. A broken filter must not take chat down.

use moka::sync::Cache;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};
use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

use crate::error::CoreError;

/// Maximum characters in a user-supplied regex pattern.
const MAX_PATTERN_LEN: usize = 260;
/// Maximum compiled program size, in bytes, for a user-supplied regex.
const MAX_REGEX_SIZE: usize = 64 * 1024;
/// Maximum keywords in a single keyword rule.
const MAX_KEYWORDS: usize = 200;
/// Maximum patterns in a single regex rule.
///
/// Compiling a regex is far more expensive than matching one, so an uncapped
/// pattern list is a CPU-exhaustion vector even though the matching engine
/// itself is linear-time. Kept deliberately small: a rule needing more than
/// this wants a keyword list.
const MAX_PATTERNS: usize = 20;
/// Bound on the process-wide compiled-pattern cache.
const REGEX_CACHE_CAPACITY: u64 = 1024;
/// Maximum rules a single guild may define.
pub const MAX_RULES_PER_GUILD: i64 = 50;
/// Maximum actions attached to one rule.
///
/// Capped for the same reason keywords and patterns are: every enabled rule is
/// deserialized and walked on every message send, so an uncapped list is a
/// CPU/memory amplifier. There are only three action kinds; a rule needing more
/// than a handful is misconfigured.
pub const MAX_ACTIONS: usize = 8;
/// Maximum characters in an operator-authored block reason. It is echoed
/// verbatim to the blocked sender, so it must not be unbounded.
pub const MAX_BLOCK_REASON_LEN: usize = 400;
/// Excerpt length stored in hit history.
const EXCERPT_LEN: usize = 180;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Trigger discriminants. Persisted as `automod_rules.trigger_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i16)]
pub enum TriggerKind {
    Keyword = 1,
    Regex = 2,
    MentionFlood = 3,
    MessageSpam = 4,
    Link = 5,
}

impl TriggerKind {
    pub fn from_i16(value: i16) -> Option<Self> {
        match value {
            1 => Some(Self::Keyword),
            2 => Some(Self::Regex),
            3 => Some(Self::MentionFlood),
            4 => Some(Self::MessageSpam),
            5 => Some(Self::Link),
            _ => None,
        }
    }

    pub fn as_i16(self) -> i16 {
        self as i16
    }
}

/// Per-trigger configuration, tagged by `trigger_type` on the row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TriggerConfig {
    Keyword {
        /// Matched case-insensitively as substrings.
        keywords: Vec<String>,
        /// When true, a keyword only matches on whole-word boundaries, so
        /// "ass" does not flag "assignment".
        #[serde(default)]
        whole_word: bool,
    },
    Regex {
        patterns: Vec<String>,
    },
    MentionFlood {
        /// Trip when a single message mentions more than this many users.
        max_mentions: u32,
    },
    MessageSpam {
        max_messages: u32,
        window_seconds: u32,
    },
    Link {
        /// Block every URL.
        #[serde(default)]
        block_all: bool,
        /// Block invite links to other Paracord/Discord servers.
        #[serde(default)]
        block_invites: bool,
        /// Hosts that are always allowed when `block_all` is set.
        #[serde(default)]
        allowed_domains: Vec<String>,
    },
}

impl TriggerConfig {
    pub fn kind(&self) -> TriggerKind {
        match self {
            Self::Keyword { .. } => TriggerKind::Keyword,
            Self::Regex { .. } => TriggerKind::Regex,
            Self::MentionFlood { .. } => TriggerKind::MentionFlood,
            Self::MessageSpam { .. } => TriggerKind::MessageSpam,
            Self::Link { .. } => TriggerKind::Link,
        }
    }
}

/// Actions applied when a rule trips.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleAction {
    /// Reject the message. The reason is shown to the author.
    BlockMessage {
        #[serde(default)]
        reason: Option<String>,
    },
    /// Post a moderator alert into a channel.
    AlertChannel { channel_id: String },
    /// Time the member out for `duration_seconds`.
    TimeoutMember { duration_seconds: u32 },
}

/// A parsed, validated rule ready to evaluate.
#[derive(Debug, Clone)]
pub struct RuleConfig {
    pub trigger: TriggerConfig,
    pub actions: Vec<RuleAction>,
}

impl RuleConfig {
    /// The single validation gate. Called by the REST layer before persisting
    /// so invalid rules never reach the database.
    pub fn parse(
        trigger_type: i16,
        trigger_metadata: &str,
        actions_json: &str,
    ) -> Result<Self, CoreError> {
        let kind = TriggerKind::from_i16(trigger_type)
            .ok_or_else(|| CoreError::BadRequest(format!("Unknown trigger type {trigger_type}")))?;

        let trigger: TriggerConfig = serde_json::from_str(trigger_metadata)
            .map_err(|e| CoreError::BadRequest(format!("Invalid trigger configuration: {e}")))?;

        if trigger.kind() != kind {
            return Err(CoreError::BadRequest(
                "Trigger configuration does not match the rule's trigger type".into(),
            ));
        }

        let actions: Vec<RuleAction> = serde_json::from_str(actions_json)
            .map_err(|e| CoreError::BadRequest(format!("Invalid actions: {e}")))?;
        if actions.is_empty() {
            return Err(CoreError::BadRequest(
                "A rule needs at least one action".into(),
            ));
        }

        let config = Self { trigger, actions };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), CoreError> {
        match &self.trigger {
            TriggerConfig::Keyword { keywords, .. } => {
                // Cap the *raw* list first: `evaluate_trigger` iterates what was
                // stored, not the filtered view, so checking only non-blank
                // entries let a caller smuggle in an arbitrarily long list of
                // blanks that still cost work on every message.
                if keywords.len() > MAX_KEYWORDS {
                    return Err(CoreError::BadRequest(format!(
                        "A keyword rule can hold at most {MAX_KEYWORDS} keywords"
                    )));
                }
                let cleaned: Vec<&String> =
                    keywords.iter().filter(|k| !k.trim().is_empty()).collect();
                if cleaned.is_empty() {
                    return Err(CoreError::BadRequest(
                        "Add at least one keyword to this rule".into(),
                    ));
                }
                if cleaned.len() > MAX_KEYWORDS {
                    return Err(CoreError::BadRequest(format!(
                        "A keyword rule can hold at most {MAX_KEYWORDS} keywords"
                    )));
                }
            }
            TriggerConfig::Regex { patterns } => {
                if patterns.len() > MAX_PATTERNS {
                    return Err(CoreError::BadRequest(format!(
                        "A pattern rule can hold at most {MAX_PATTERNS} patterns"
                    )));
                }
                let cleaned: Vec<&String> =
                    patterns.iter().filter(|p| !p.trim().is_empty()).collect();
                if cleaned.is_empty() {
                    return Err(CoreError::BadRequest(
                        "Add at least one pattern to this rule".into(),
                    ));
                }
                if cleaned.len() > MAX_PATTERNS {
                    return Err(CoreError::BadRequest(format!(
                        "A pattern rule can hold at most {MAX_PATTERNS} patterns"
                    )));
                }
                for pattern in cleaned {
                    compile_pattern(pattern)?;
                }
            }
            TriggerConfig::MentionFlood { max_mentions } => {
                if *max_mentions == 0 || *max_mentions > 100 {
                    return Err(CoreError::BadRequest(
                        "Mention limit must be between 1 and 100".into(),
                    ));
                }
            }
            TriggerConfig::MessageSpam {
                max_messages,
                window_seconds,
            } => {
                if *max_messages == 0 || *max_messages > 100 {
                    return Err(CoreError::BadRequest(
                        "Message limit must be between 1 and 100".into(),
                    ));
                }
                if *window_seconds < 2 || *window_seconds > 3600 {
                    return Err(CoreError::BadRequest(
                        "Spam window must be between 2 and 3600 seconds".into(),
                    ));
                }
            }
            TriggerConfig::Link {
                block_all,
                block_invites,
                ..
            } => {
                if !block_all && !block_invites {
                    return Err(CoreError::BadRequest(
                        "Enable link blocking, invite blocking, or both".into(),
                    ));
                }
            }
        }

        if self.actions.len() > MAX_ACTIONS {
            return Err(CoreError::BadRequest(format!(
                "A rule can hold at most {MAX_ACTIONS} actions"
            )));
        }

        for action in &self.actions {
            if let RuleAction::BlockMessage {
                reason: Some(reason),
            } = action
            {
                if reason.chars().count() > MAX_BLOCK_REASON_LEN {
                    return Err(CoreError::BadRequest(format!(
                        "Block reason must be at most {MAX_BLOCK_REASON_LEN} characters"
                    )));
                }
            }
            if let RuleAction::TimeoutMember { duration_seconds } = action {
                if *duration_seconds == 0 || *duration_seconds > 60 * 60 * 24 * 28 {
                    return Err(CoreError::BadRequest(
                        "Timeout must be between 1 second and 28 days".into(),
                    ));
                }
            }
            if let RuleAction::AlertChannel { channel_id } = action {
                if channel_id.parse::<i64>().is_err() {
                    return Err(CoreError::BadRequest("Invalid alert channel".into()));
                }
            }
        }

        Ok(())
    }

    pub fn blocks(&self) -> Option<&str> {
        self.actions.iter().find_map(|a| match a {
            RuleAction::BlockMessage { reason } => {
                Some(reason.as_deref().unwrap_or("Blocked by a server rule"))
            }
            _ => None,
        })
    }
}

/// Compiled-pattern cache.
///
/// Compilation, not matching, is the expensive half of a regex rule (~150 µs
/// for a pattern that fits the size bound). Without this, every message send
/// recompiled every pattern of every enabled rule, and the dry-run endpoint
/// compiled each pattern twice per request — turning an authorized-but-cheap
/// call into seconds of synchronous runtime-thread CPU.
static REGEX_CACHE: LazyLock<Cache<String, Arc<Regex>>> =
    LazyLock::new(|| Cache::builder().max_capacity(REGEX_CACHE_CAPACITY).build());

/// Compile a user-supplied pattern under strict bounds, memoized.
fn compile_pattern(pattern: &str) -> Result<Arc<Regex>, CoreError> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(CoreError::BadRequest(format!(
            "Pattern is too long (max {MAX_PATTERN_LEN} characters)"
        )));
    }
    if let Some(cached) = REGEX_CACHE.get(pattern) {
        return Ok(cached);
    }
    let compiled = RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(MAX_REGEX_SIZE)
        .build()
        .map(Arc::new)
        .map_err(|e| CoreError::BadRequest(format!("Invalid pattern: {e}")))?;
    // Only well-formed patterns are cached; a rejected one is cheap to re-reject.
    REGEX_CACHE.insert(pattern.to_string(), Arc::clone(&compiled));
    Ok(compiled)
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// What a trigger matched, for hit history and moderator alerts.
#[derive(Debug, Clone)]
pub struct TriggerMatch {
    pub excerpt: String,
}

static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:https?://|www\.)[^\s<>\)\]]+").expect("static URL pattern is valid")
});

static INVITE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:discord\.gg|discord(?:app)?\.com/invite|paracord\.gg)/[a-z0-9-]+")
        .expect("static invite pattern is valid")
});

static MENTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@!?(\d+)>").expect("static mention pattern is valid"));

/// Role mentions (`<@&id>`). A mass-ping usually targets roles, not users.
static ROLE_MENTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@&(\d+)>").expect("static role mention pattern is valid"));

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= EXCERPT_LEN {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(EXCERPT_LEN).collect();
    format!("{cut}…")
}

/// Count distinct mention targets in a message body.
///
/// Counts users *and* roles, and treats `@everyone`/`@here` as an automatic
/// flood. Counting only `<@id>` — as this did originally — meant the rule whose
/// entire purpose is stopping mass pings scored zero for the two most common
/// ways to mass ping.
///
/// Ids are normalized by parsing so `<@1>`, `<@01>` and `<@001>` are one target
/// rather than three.
pub fn count_mentions(content: &str) -> usize {
    if mentions_everyone(content) {
        return usize::MAX;
    }
    let mut seen = std::collections::HashSet::new();
    for caps in MENTION_RE.captures_iter(content) {
        if let Some(id) = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
            seen.insert((false, id));
        }
    }
    for caps in ROLE_MENTION_RE.captures_iter(content) {
        if let Some(id) = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
            seen.insert((true, id));
        }
    }
    seen.len()
}

/// Whether the body carries an `@everyone` / `@here` token on a word boundary.
fn mentions_everyone(content: &str) -> bool {
    for token in ["@everyone", "@here"] {
        let mut start = 0usize;
        while let Some(rel) = content[start..].find(token) {
            let at = start + rel;
            let before_ok = content[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_alphanumeric() && c != '_');
            let after_idx = at + token.len();
            let after_ok = content[after_idx..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric() && c != '_');
            if before_ok && after_ok {
                return true;
            }
            start = after_idx;
            if start >= content.len() {
                break;
            }
        }
    }
    false
}

/// Fold text into a comparable form before keyword matching.
///
/// Case-folding alone is not a filter: `bad\u{200b}word`, `ｂａｄｗｏｒｄ`,
/// `𝐛𝐚𝐝𝐰𝐨𝐫𝐝` and `bádword` all read as the banned word to a human and all
/// sailed past a naive `to_lowercase()` comparison.
///
/// This applies **NFKD**, not NFKC. Both map fullwidth and mathematical
/// compatibility forms onto ASCII, but NFKC *composes* a base character and its
/// accent into a single precomposed code point (`a` + U+0301 -> `á`), which is
/// category `Ll`, not `Mn` — so the combining-mark strip below never saw it and
/// every accented substitution (`bádword`, `badwörd`, `baḍword`) defeated the
/// filter outright. NFKD decomposes instead, leaving the accent as a separate
/// `Mn` that is then dropped. Format characters (`Cf`: zero-width space, ZWNJ,
/// word joiner, RTL override) are dropped the same way.
///
/// Homoglyph substitution across scripts (Cyrillic `а` for Latin `a`) is *not*
/// covered; that needs a confusables table and is documented as a limitation.
fn fold_for_match(value: &str) -> String {
    value
        .nfkd()
        .filter(|c| {
            let cat = c.general_category();
            !matches!(
                cat,
                GeneralCategory::Format | GeneralCategory::NonspacingMark
            )
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Does `haystack` (already folded) contain `needle` (already folded)?
///
/// `whole_word` requires the match not be flanked by alphanumerics.
fn folded_contains(haystack: &str, needle: &str, whole_word: bool) -> bool {
    if needle.is_empty() {
        return false;
    }
    if !whole_word {
        return haystack.contains(needle);
    }
    let mut start = 0usize;
    while let Some(found) = haystack[start..].find(needle) {
        let at = start + found;
        let before_ok = haystack[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let after_idx = at + needle.len();
        let after_ok = haystack[after_idx..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        // Advance by ONE character, not by the needle length: skipping the whole
        // needle misses an overlapping occurrence that would have passed the
        // boundary test (keyword "a-a" in "xa-a-a").
        let step = haystack[at..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
        start = at + step;
        if start >= haystack.len() {
            break;
        }
    }
    false
}

fn matches_keyword(content: &str, keyword: &str, whole_word: bool) -> bool {
    folded_contains(
        &fold_for_match(content),
        &fold_for_match(keyword),
        whole_word,
    )
}

fn host_of(url: &str) -> Option<String> {
    let stripped = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host = stripped.split(['/', '?', '#']).next()?;
    let host = host.split('@').next_back()?;
    let host = host.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

/// Evaluate a rule's trigger against message content.
///
/// `recent_message_count` is the author's message count inside the spam window,
/// supplied by the caller so this stays a pure function.
pub fn evaluate_trigger(
    trigger: &TriggerConfig,
    content: &str,
    recent_message_count: Option<i64>,
) -> Option<TriggerMatch> {
    match trigger {
        TriggerConfig::Keyword {
            keywords,
            whole_word,
        } => keywords
            .iter()
            .find(|k| matches_keyword(content, k, *whole_word))
            .map(|k| TriggerMatch {
                excerpt: format!("keyword “{}”", k.trim()),
            }),

        TriggerConfig::Regex { patterns } => {
            for pattern in patterns {
                // A stored pattern that no longer compiles is skipped rather
                // than failing the send.
                let Ok(re) = compile_pattern(pattern) else {
                    tracing::warn!(pattern = %pattern, "automod: skipping uncompilable pattern");
                    continue;
                };
                if let Some(m) = re.find(content) {
                    return Some(TriggerMatch {
                        excerpt: format!("pattern match “{}”", excerpt(m.as_str())),
                    });
                }
            }
            None
        }

        TriggerConfig::MentionFlood { max_mentions } => {
            if mentions_everyone(content) {
                return Some(TriggerMatch {
                    excerpt: "@everyone / @here mention".to_string(),
                });
            }
            let count = count_mentions(content);
            if count > *max_mentions as usize {
                Some(TriggerMatch {
                    excerpt: format!("{count} mentions (limit {max_mentions})"),
                })
            } else {
                None
            }
        }

        TriggerConfig::MessageSpam {
            max_messages,
            window_seconds,
        } => {
            let count = recent_message_count?;
            if count >= i64::from(*max_messages) {
                Some(TriggerMatch {
                    excerpt: format!(
                        "{count} messages in {window_seconds}s (limit {max_messages})"
                    ),
                })
            } else {
                None
            }
        }

        TriggerConfig::Link {
            block_all,
            block_invites,
            allowed_domains,
        } => {
            if *block_invites {
                if let Some(m) = INVITE_RE.find(content) {
                    return Some(TriggerMatch {
                        excerpt: format!("invite link “{}”", excerpt(m.as_str())),
                    });
                }
            }
            if *block_all {
                let allow: Vec<String> = allowed_domains
                    .iter()
                    .map(|d| d.trim().to_lowercase())
                    .filter(|d| !d.is_empty())
                    .collect();
                for m in URL_RE.find_iter(content) {
                    let url = m.as_str();
                    let permitted = host_of(url).is_some_and(|host| {
                        allow
                            .iter()
                            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
                    });
                    if !permitted {
                        return Some(TriggerMatch {
                            excerpt: format!("link “{}”", excerpt(url)),
                        });
                    }
                }
            }
            None
        }
    }
}

/// Does this trigger need the author's recent message count?
pub fn needs_recent_count(trigger: &TriggerConfig) -> Option<u32> {
    match trigger {
        TriggerConfig::MessageSpam { window_seconds, .. } => Some(*window_seconds),
        _ => None,
    }
}

pub fn content_excerpt(content: &str) -> String {
    excerpt(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyword(keywords: &[&str], whole_word: bool) -> TriggerConfig {
        TriggerConfig::Keyword {
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            whole_word,
        }
    }

    #[test]
    fn keyword_substring_matches_anywhere() {
        let t = keyword(&["spam"], false);
        assert!(evaluate_trigger(&t, "this is SPAMmy", None).is_some());
        assert!(evaluate_trigger(&t, "nothing here", None).is_none());
    }

    #[test]
    fn unicode_evasion_does_not_defeat_keyword_matching() {
        // Every one of these read as "badword" to a human and every one of them
        // slipped through a plain to_lowercase() comparison.
        let t = keyword(&["badword"], false);
        for evasion in [
            "bad\u{200b}word", // zero-width space
            "bad\u{200c}word", // ZWNJ
            "bad\u{00ad}word", // soft hyphen
            "bad\u{2060}word", // word joiner
            "bad\u{202e}word", // RTL override
            "ｂａｄｗｏｒｄ",  // fullwidth
            "𝐛𝐚𝐝𝐰𝐨𝐫𝐝",         // math bold
            "BADWORD",
            "BaDwOrD",
        ] {
            assert!(
                evaluate_trigger(&t, evasion, None).is_some(),
                "evasion not caught: {evasion:?}"
            );
        }
    }

    #[test]
    fn diacritic_substitution_does_not_defeat_keyword_matching() {
        // NFKC composed base+mark into a precomposed char that is not `Mn`, so
        // the combining-mark strip never saw it and every one of these
        // delivered. NFKD decomposes first.
        let t = keyword(&["badword"], false);
        for evasion in [
            "bádword",
            "badwörd",
            "baḍword",
            "bådword",
            "baďword",
            "b\u{0301}adword",
        ] {
            assert!(
                evaluate_trigger(&t, evasion, None).is_some(),
                "diacritic evasion not caught: {evasion:?}"
            );
        }
    }

    #[test]
    fn accented_text_does_not_false_positive() {
        // Folding must not turn unrelated accented words into matches.
        let t = keyword(&["resume"], true);
        assert!(
            evaluate_trigger(&t, "please send your résumé", None).is_some(),
            "résumé folds to resume — intended"
        );
        let t2 = keyword(&["cafe"], true);
        assert!(evaluate_trigger(&t2, "a totally unrelated sentence", None).is_none());
    }

    #[test]
    fn folding_does_not_create_false_positives() {
        let t = keyword(&["badword"], false);
        assert!(evaluate_trigger(&t, "a perfectly fine message", None).is_none());
        assert!(
            evaluate_trigger(&t, "badwordy", None).is_some(),
            "substring still matches"
        );
        let whole = keyword(&["badword"], true);
        assert!(
            evaluate_trigger(&whole, "badwordy", None).is_none(),
            "whole-word must still reject an embedded hit"
        );
    }

    #[test]
    fn whole_word_finds_overlapping_occurrences() {
        // The scan used to advance by the needle length, so the standalone
        // occurrence at the end was skipped after the embedded one failed.
        let t = keyword(&["a-a"], true);
        assert!(evaluate_trigger(&t, "xa-a-a", None).is_some());
    }

    #[test]
    fn mention_flood_counts_roles_and_everyone() {
        let t = TriggerConfig::MentionFlood { max_mentions: 2 };
        // Role mentions were previously invisible to the counter.
        assert!(evaluate_trigger(&t, "<@&1> <@&2> <@&3>", None).is_some());
        // @everyone is the canonical mass ping and scored zero before.
        assert!(evaluate_trigger(&t, "hey @everyone look", None).is_some());
        assert!(evaluate_trigger(&t, "hey @here look", None).is_some());
        // Not a mention when embedded in a word.
        assert!(evaluate_trigger(&t, "email me at foo@herefoo", None).is_none());
        // Padded ids are one target, not three.
        assert!(evaluate_trigger(&t, "<@1> <@01> <@001>", None).is_none());
    }

    #[test]
    fn keyword_cap_counts_the_raw_list() {
        // Blank entries still cost work at evaluation time, so they must count.
        let mut keywords: Vec<String> = vec![" ".into(); 500];
        keywords.push("real".into());
        let meta = serde_json::to_string(&TriggerConfig::Keyword {
            keywords,
            whole_word: false,
        })
        .unwrap();
        assert!(RuleConfig::parse(
            TriggerKind::Keyword.as_i16(),
            &meta,
            r#"[{"kind":"block_message"}]"#
        )
        .is_err());
    }

    #[test]
    fn pattern_count_is_capped() {
        let patterns: Vec<String> = (0..MAX_PATTERNS + 1).map(|i| format!("a{i}")).collect();
        let meta = serde_json::to_string(&TriggerConfig::Regex { patterns }).unwrap();
        assert!(RuleConfig::parse(
            TriggerKind::Regex.as_i16(),
            &meta,
            r#"[{"kind":"block_message"}]"#
        )
        .is_err());
    }

    #[test]
    fn whole_word_does_not_match_inside_a_longer_word() {
        let t = keyword(&["ass"], true);
        assert!(
            evaluate_trigger(&t, "the assignment is due", None).is_none(),
            "whole-word must not flag 'assignment'"
        );
        assert!(evaluate_trigger(&t, "don't be an ass!", None).is_some());
    }

    #[test]
    fn whole_word_scans_past_a_non_boundary_hit() {
        // First occurrence is embedded, second is standalone: must still match.
        let t = keyword(&["cat"], true);
        assert!(evaluate_trigger(&t, "concatenate the cat", None).is_some());
    }

    #[test]
    fn mention_flood_counts_distinct_users() {
        let t = TriggerConfig::MentionFlood { max_mentions: 2 };
        assert!(evaluate_trigger(&t, "<@1> <@2>", None).is_none());
        // Same user repeated is not a flood.
        assert!(evaluate_trigger(&t, "<@1> <@1> <@1> <@1>", None).is_none());
        assert!(evaluate_trigger(&t, "<@1> <@2> <@3>", None).is_some());
    }

    #[test]
    fn link_rule_honors_allowed_domains() {
        let t = TriggerConfig::Link {
            block_all: true,
            block_invites: false,
            allowed_domains: vec!["example.com".into()],
        };
        assert!(evaluate_trigger(&t, "see https://example.com/x", None).is_none());
        assert!(evaluate_trigger(&t, "see https://docs.example.com/x", None).is_none());
        assert!(evaluate_trigger(&t, "see https://evil.test/x", None).is_some());
    }

    #[test]
    fn invite_rule_matches_known_invite_hosts() {
        let t = TriggerConfig::Link {
            block_all: false,
            block_invites: true,
            allowed_domains: vec![],
        };
        assert!(evaluate_trigger(&t, "join discord.gg/abc123", None).is_some());
        assert!(evaluate_trigger(&t, "a normal https://example.com link", None).is_none());
    }

    #[test]
    fn spam_trigger_uses_supplied_count() {
        let t = TriggerConfig::MessageSpam {
            max_messages: 5,
            window_seconds: 10,
        };
        assert!(evaluate_trigger(&t, "hi", Some(4)).is_none());
        assert!(evaluate_trigger(&t, "hi", Some(5)).is_some());
        // No count available => cannot evaluate, so no match.
        assert!(evaluate_trigger(&t, "hi", None).is_none());
    }

    #[test]
    fn parse_rejects_mismatched_trigger_type() {
        let err = RuleConfig::parse(
            TriggerKind::Regex.as_i16(),
            r#"{"kind":"keyword","keywords":["x"]}"#,
            r#"[{"kind":"block_message"}]"#,
        );
        assert!(err.is_err(), "keyword config under regex type must fail");
    }

    #[test]
    fn parse_rejects_empty_actions() {
        let err = RuleConfig::parse(
            TriggerKind::Keyword.as_i16(),
            r#"{"kind":"keyword","keywords":["x"]}"#,
            "[]",
        );
        assert!(err.is_err());
    }

    #[test]
    fn parse_rejects_invalid_regex() {
        let err = RuleConfig::parse(
            TriggerKind::Regex.as_i16(),
            r#"{"kind":"regex","patterns":["([unclosed"]}"#,
            r#"[{"kind":"block_message"}]"#,
        );
        assert!(err.is_err());
    }

    #[test]
    fn parse_accepts_a_well_formed_rule_and_reports_blocking() {
        let rule = RuleConfig::parse(
            TriggerKind::Keyword.as_i16(),
            r#"{"kind":"keyword","keywords":["badword"],"whole_word":true}"#,
            r#"[{"kind":"block_message","reason":"No slurs"},{"kind":"timeout_member","duration_seconds":600}]"#,
        )
        .expect("rule should parse");
        assert_eq!(rule.blocks(), Some("No slurs"));
        assert_eq!(rule.actions.len(), 2);
    }

    #[test]
    fn parse_rejects_overlong_timeout() {
        let err = RuleConfig::parse(
            TriggerKind::Keyword.as_i16(),
            r#"{"kind":"keyword","keywords":["x"]}"#,
            r#"[{"kind":"timeout_member","duration_seconds":9999999}]"#,
        );
        assert!(err.is_err());
    }

    #[test]
    fn overlong_patterns_are_rejected() {
        let long = "a".repeat(MAX_PATTERN_LEN + 1);
        assert!(compile_pattern(&long).is_err());
    }
}
