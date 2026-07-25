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

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::error::CoreError;

/// Maximum characters in a user-supplied regex pattern.
const MAX_PATTERN_LEN: usize = 260;
/// Maximum compiled program size, in bytes, for a user-supplied regex.
const MAX_REGEX_SIZE: usize = 64 * 1024;
/// Maximum keywords in a single keyword rule.
const MAX_KEYWORDS: usize = 200;
/// Maximum rules a single guild may define.
pub const MAX_RULES_PER_GUILD: i64 = 50;
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
                let cleaned: Vec<&String> =
                    patterns.iter().filter(|p| !p.trim().is_empty()).collect();
                if cleaned.is_empty() {
                    return Err(CoreError::BadRequest(
                        "Add at least one pattern to this rule".into(),
                    ));
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

        for action in &self.actions {
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

/// Compile a user-supplied pattern under strict bounds.
fn compile_pattern(pattern: &str) -> Result<Regex, CoreError> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(CoreError::BadRequest(format!(
            "Pattern is too long (max {MAX_PATTERN_LEN} characters)"
        )));
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(MAX_REGEX_SIZE)
        .build()
        .map_err(|e| CoreError::BadRequest(format!("Invalid pattern: {e}")))
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

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= EXCERPT_LEN {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(EXCERPT_LEN).collect();
    format!("{cut}…")
}

/// Count distinct user mentions in a message body.
pub fn count_mentions(content: &str) -> usize {
    let mut seen = std::collections::HashSet::new();
    for caps in MENTION_RE.captures_iter(content) {
        if let Some(id) = caps.get(1) {
            seen.insert(id.as_str().to_string());
        }
    }
    seen.len()
}

fn matches_keyword(content: &str, keyword: &str, whole_word: bool) -> bool {
    let haystack = content.to_lowercase();
    let needle = keyword.trim().to_lowercase();
    if needle.is_empty() {
        return false;
    }
    if !whole_word {
        return haystack.contains(&needle);
    }
    // Whole-word: the match must not be flanked by alphanumerics, so "ass"
    // does not fire on "assignment" but does on "ass!" or "an ass".
    let mut start = 0usize;
    while let Some(found) = haystack[start..].find(&needle) {
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
        start = at + needle.len();
        if start >= haystack.len() {
            break;
        }
    }
    false
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
