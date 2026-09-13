//! AutoMod enforcement — the send-path side of `crate::automod`.
//!
//! Split from the pure rule engine so the engine stays trivially testable and
//! this module owns all the database and side-effect work.

use chrono::Utc;
use paracord_db::DbPool;
use serde_json::json;

use crate::automod::{
    self, content_excerpt, needs_recent_count, RuleAction, RuleConfig, TriggerKind,
};
use crate::error::CoreError;
use crate::permissions;
use paracord_models::permissions::Permissions;

/// Outcome of running a guild's AutoMod rules over one message.
#[derive(Debug, Default)]
pub struct AutomodVerdict {
    /// When set, the message must be rejected with this reason.
    pub blocked_reason: Option<String>,
    /// Non-blocking side effects to apply after the message is stored.
    pub alerts: Vec<AutomodAlert>,
    /// Timeouts to apply once the triggering message has been handled.
    ///
    /// Deliberately *not* applied during evaluation: the send path rejects
    /// messages from timed-out members, so timing the author out mid-evaluation
    /// would bounce the very message that tripped the rule with a confusing
    /// "you are timed out" error — even for a rule the operator configured as
    /// non-blocking. Applying it afterwards means the triggering message is
    /// handled exactly as configured and the timeout takes effect from the next
    /// one on.
    pub timeouts: Vec<TimeoutRequest>,
}

#[derive(Debug, Clone)]
pub struct TimeoutRequest {
    pub user_id: i64,
    pub guild_id: i64,
    pub duration_seconds: u32,
}

#[derive(Debug, Clone)]
pub struct AutomodAlert {
    pub channel_id: i64,
    pub rule_name: String,
    pub user_id: i64,
    pub matched_excerpt: String,
}

#[derive(Debug, Default)]
pub struct PreparedAutomod {
    pub verdict: AutomodVerdict,
    pub hits: Vec<paracord_db::automod::AutomodHitRow>,
}

impl PreparedAutomod {
    pub async fn persist_hits(&self, pool: &DbPool) -> Result<(), CoreError> {
        if self.hits.is_empty() {
            return Ok(());
        }
        let mut transaction = pool.begin().await.map_err(paracord_db::DbError::from)?;
        for hit in &self.hits {
            paracord_db::automod::record_hit_in_connection(&mut transaction, hit).await?;
        }
        transaction
            .commit()
            .await
            .map_err(paracord_db::DbError::from)?;
        Ok(())
    }
}

fn parse_id_list(raw: &str) -> Result<Vec<i64>, CoreError> {
    let ids: Vec<String> = serde_json::from_str(raw)
        .map_err(|e| CoreError::Internal(format!("Invalid stored AutoMod exemptions: {e}")))?;
    ids.into_iter()
        .map(|value| {
            value.parse::<i64>().map_err(|e| {
                CoreError::Internal(format!("Invalid stored AutoMod exemption ID: {e}"))
            })
        })
        .collect()
}

/// Evaluate rules and durably record their hits. Evaluation/persistence errors
/// must reach the caller rather than silently allowing unfiltered content.
pub async fn evaluate_message(
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    author_perms: Permissions,
) -> Result<AutomodVerdict, CoreError> {
    let prepared =
        prepare_message_evaluation(pool, guild_id, channel_id, author_id, content, author_perms)
            .await?;
    prepared.persist_hits(pool).await?;
    Ok(prepared.verdict)
}

/// Read-only evaluation. A message edit commits these hits only if it applies.
pub async fn prepare_message_evaluation(
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    author_perms: Permissions,
) -> Result<PreparedAutomod, CoreError> {
    // Members who can manage the space are never filtered by its own rules.
    if author_perms.contains(Permissions::ADMINISTRATOR)
        || author_perms.contains(Permissions::MANAGE_GUILD)
    {
        return Ok(PreparedAutomod::default());
    }

    let rules = paracord_db::automod::list_enabled_rules(pool, guild_id).await?;
    if rules.is_empty() {
        return Ok(PreparedAutomod::default());
    }

    // Member roles are only needed if some rule declares role exemptions.
    let mut member_role_ids: Option<Vec<i64>> = None;

    let mut prepared = PreparedAutomod::default();
    let verdict = &mut prepared.verdict;

    for row in rules {
        if parse_id_list(&row.exempt_channel_ids)?.contains(&channel_id) {
            continue;
        }

        let exempt_roles = parse_id_list(&row.exempt_role_ids)?;
        if !exempt_roles.is_empty() {
            if member_role_ids.is_none() {
                let roles = paracord_db::roles::get_member_roles(pool, author_id, guild_id).await?;
                member_role_ids = Some(roles.iter().map(|r| r.id).collect());
            }
            let has_exempt_role = member_role_ids
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|id| exempt_roles.contains(id)));
            if has_exempt_role {
                continue;
            }
        }

        let config = RuleConfig::parse(row.trigger_type, &row.trigger_metadata, &row.actions)
            .map_err(|e| {
                CoreError::Internal(format!("Invalid stored AutoMod rule {}: {e}", row.id))
            })?;

        // Spam triggers need the author's recent message count in this channel.
        let recent_count = match needs_recent_count(&config.trigger) {
            Some(window_seconds) => {
                let since = Utc::now() - chrono::Duration::seconds(i64::from(window_seconds));
                Some(
                    paracord_db::messages::count_user_messages_since(
                        pool, channel_id, author_id, since,
                    )
                    .await?,
                )
            }
            None => None,
        };

        let Some(hit) = automod::evaluate_trigger(&config.trigger, content, recent_count) else {
            continue;
        };

        let mut actions_taken: Vec<String> = Vec::new();

        if let Some(reason) = config.blocks() {
            actions_taken.push("block_message".into());
            if verdict.blocked_reason.is_none() {
                verdict.blocked_reason = Some(reason.to_string());
            }
        }

        for action in &config.actions {
            match action {
                RuleAction::BlockMessage { .. } => {}
                RuleAction::AlertChannel { channel_id: target } => {
                    if let Ok(target_id) = target.parse::<i64>() {
                        actions_taken.push("alert_channel".into());
                        verdict.alerts.push(AutomodAlert {
                            channel_id: target_id,
                            rule_name: row.name.clone(),
                            user_id: author_id,
                            matched_excerpt: hit.excerpt.clone(),
                        });
                    }
                }
                RuleAction::TimeoutMember { duration_seconds } => {
                    // Queued, not applied here — see `AutomodVerdict::timeouts`.
                    actions_taken.push("timeout_member".into());
                    verdict.timeouts.push(TimeoutRequest {
                        user_id: author_id,
                        guild_id,
                        duration_seconds: *duration_seconds,
                    });
                }
            }
        }

        prepared.hits.push(paracord_db::automod::AutomodHitRow {
            id: paracord_util::snowflake::generate(1),
            guild_id,
            rule_id: row.id,
            rule_name: row.name.clone(),
            user_id: author_id,
            channel_id,
            trigger_type: row.trigger_type,
            actions_taken: serde_json::to_string(&actions_taken)
                .map_err(|e| CoreError::Internal(e.to_string()))?,
            matched_excerpt: Some(hit.excerpt.clone()),
            content_excerpt: Some(content_excerpt(content)),
            created_at: Utc::now(),
        });

        tracing::info!(
            guild_id,
            channel_id,
            author_id,
            rule_id = row.id,
            rule = %row.name,
            trigger = ?TriggerKind::from_i16(row.trigger_type),
            matched = %hit.excerpt,
            "automod: rule triggered"
        );
    }

    Ok(prepared)
}

/// Apply queued timeouts. Best effort: a failure is logged, never fatal to the
/// message that triggered it.
///
/// Only the longest timeout per member is applied. `set_member_timeout` writes
/// an absolute instant, so applying several in sequence would let the *last*
/// rule win — and since rules evaluate oldest-first, a message tripping both a
/// 28-day rule and a newer 60-second rule would end up timed out for a minute.
pub async fn apply_timeouts(pool: &DbPool, timeouts: &[TimeoutRequest]) {
    let mut longest: std::collections::HashMap<(i64, i64), u32> = std::collections::HashMap::new();
    for request in timeouts {
        let slot = longest
            .entry((request.user_id, request.guild_id))
            .or_insert(0);
        *slot = (*slot).max(request.duration_seconds);
    }
    let timeouts: Vec<TimeoutRequest> = longest
        .into_iter()
        .map(|((user_id, guild_id), duration_seconds)| TimeoutRequest {
            user_id,
            guild_id,
            duration_seconds,
        })
        .collect();

    for request in &timeouts {
        let until = Utc::now() + chrono::Duration::seconds(i64::from(request.duration_seconds));
        if let Err(err) = paracord_db::members::set_member_timeout(
            pool,
            request.user_id,
            request.guild_id,
            Some(until),
        )
        .await
        {
            tracing::warn!(
                user_id = request.user_id,
                guild_id = request.guild_id,
                error = %err,
                "automod: failed to time out member"
            );
        }
    }
}

/// Longest span of operator/offender text allowed into an alert body.
const ALERT_FIELD_LEN: usize = 120;

/// Flatten untrusted text for inclusion in a message body.
///
/// The rule name is operator-authored and the matched excerpt is *offender*-
/// authored; both land in a real message. Strip characters that would let
/// either forge structure — markdown emphasis, links, mentions, code fences,
/// and newlines — and bound the length so an alert cannot exceed the message
/// size invariant the normal send path enforces.
fn sanitize_alert_field(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_control() {
                ' '
            } else {
                match c {
                    '*' | '_' | '`' | '~' | '|' | '<' | '>' | '[' | ']' | '(' | ')' | '@' | '#'
                    | '\\' => ' ',
                    other => other,
                }
            }
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() <= ALERT_FIELD_LEN {
        return trimmed;
    }
    let cut: String = trimmed.chars().take(ALERT_FIELD_LEN).collect();
    format!("{cut}…")
}

/// Build the moderator-facing alert body for a triggered rule.
pub fn alert_message(alert: &AutomodAlert, username: &str) -> String {
    format!(
        "**AutoMod** · rule “{}” triggered by {} — {}",
        sanitize_alert_field(&alert.rule_name),
        sanitize_alert_field(username),
        sanitize_alert_field(&alert.matched_excerpt),
    )
}

/// Structured payload for the audit log when AutoMod acts.
pub fn audit_changes(alert: &AutomodAlert) -> serde_json::Value {
    json!({
        "rule": alert.rule_name,
        "matched": alert.matched_excerpt,
    })
}

/// Convenience wrapper mirroring `permissions::compute_channel_permissions` so
/// callers that already have permissions do not recompute them.
pub async fn channel_permissions(
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    owner_id: i64,
    user_id: i64,
) -> Result<Permissions, CoreError> {
    permissions::compute_channel_permissions(pool, guild_id, channel_id, owner_id, user_id).await
}
