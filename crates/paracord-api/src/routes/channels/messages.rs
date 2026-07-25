use super::*;

#[derive(Deserialize)]
pub struct MessageQuery {
    pub before: Option<i64>,
    pub after: Option<i64>,
    /// Anchor id for `around` pagination: returns roughly `limit/2` messages
    /// before the anchor, the anchor itself, and `limit/2` after it.
    pub around: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct MessageSearchQuery {
    pub q: String,
    pub limit: Option<i64>,
    pub author_id: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
}

#[derive(Deserialize)]
pub struct SummarizeQuery {
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct DmE2eePayloadRequest {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
    pub header: Option<String>,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    pub referenced_message_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub sticker_ids: Vec<String>,
    pub e2ee: Option<DmE2eePayloadRequest>,
    pub nonce: Option<String>,
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
    pub e2ee: Option<DmE2eePayloadRequest>,
}

#[derive(Deserialize)]
pub struct BulkDeleteMessagesRequest {
    pub message_ids: Vec<String>,
}

pub async fn get_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<MessageQuery>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    // before / after / around are mutually exclusive cursors.
    let cursor_count = [
        params.before.is_some(),
        params.after.is_some(),
        params.around.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    if cursor_count > 1 {
        return Err(ApiError::BadRequest(
            "Only one of before, after, or around may be specified".into(),
        ));
    }

    let limit = params.limit.unwrap_or(50).clamp(1, 100);
    let messages = if let Some(anchor) = params.around {
        // Compose two windowed reads around the anchor plus the anchor itself,
        // then merge into a single newest-first page.
        let half = (limit / 2).max(1);
        let older = paracord_db::messages::get_channel_messages(
            &state.db,
            channel_id,
            Some(anchor),
            None,
            half,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let newer = paracord_db::messages::get_channel_messages(
            &state.db,
            channel_id,
            None,
            Some(anchor),
            half,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        let mut combined = older;
        combined.extend(newer);
        if let Some(anchor_msg) = paracord_db::messages::get_message(&state.db, anchor)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        {
            if anchor_msg.channel_id == channel_id {
                combined.push(anchor_msg);
            }
        }
        combined.sort_by_key(|m| std::cmp::Reverse(m.id));
        combined.dedup_by(|a, b| a.id == b.id);
        combined
    } else {
        paracord_db::messages::get_channel_messages(
            &state.db,
            channel_id,
            params.before,
            params.after,
            limit,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    let result = messages_to_json(&state, &messages, auth.user_id).await;

    Ok(Json(json!(result)))
}

pub async fn search_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<MessageSearchQuery>,
) -> Result<Json<Value>, ApiError> {
    if params.q.trim().is_empty() {
        return Err(ApiError::BadRequest("Query must not be empty".into()));
    }
    let author_id = params
        .author_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid author_id filter".into()))
        })
        .transpose()?;
    let after = parse_optional_datetime_param(params.after.as_deref(), false)?;
    let before = parse_optional_datetime_param(params.before.as_deref(), true)?;
    if let (Some(after_dt), Some(before_dt)) = (after.as_ref(), before.as_ref()) {
        if after_dt > before_dt {
            return Err(ApiError::BadRequest(
                "after filter must be earlier than before filter".into(),
            ));
        }
    }
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let messages = if channel.channel_type == 7 {
        // Forum channels store post content in thread children, not the forum
        // parent. Collect the post channel ids and run a single ranked search
        // across all of them so queries behave like a forum-wide search.
        let forum_posts = paracord_db::channels::get_forum_posts(&state.db, channel_id, 0, true)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let post_channel_ids: Vec<i64> = forum_posts
            .into_iter()
            .take(MAX_FORUM_SEARCH_POSTS)
            .map(|post| post.id)
            .collect();

        paracord_db::messages::search_messages_in_channels(
            &state.db,
            &post_channel_ids,
            &params.q,
            limit,
            author_id,
            after,
            before,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    } else {
        paracord_db::messages::search_messages(
            &state.db, channel_id, &params.q, limit, author_id, after, before,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    let result = messages_to_json(&state, &messages, auth.user_id).await;
    Ok(Json(json!(result)))
}

pub async fn summarize_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<SummarizeQuery>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    let limit = params.limit.unwrap_or(150).clamp(20, 500);
    let messages =
        paracord_db::messages::get_channel_messages(&state.db, channel_id, None, None, limit)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if messages.is_empty() {
        return Err(ApiError::BadRequest(
            "No messages are available to summarize".to_string(),
        ));
    }

    let mut author_name_cache: HashMap<i64, String> = HashMap::new();
    let mut transcript_lines = Vec::new();
    let mut contains_e2ee = false;

    for msg in messages.iter().rev() {
        if (msg.flags & MESSAGE_FLAG_DM_E2EE) != 0 {
            contains_e2ee = true;
            continue;
        }
        let content = msg.content.as_deref().map(str::trim).unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        let author_name = if let Some(name) = author_name_cache.get(&msg.author_id) {
            name.clone()
        } else {
            let resolved = paracord_db::users::get_user_by_id(&state.db, msg.author_id)
                .await
                .ok()
                .flatten()
                .map(|u| u.username)
                .unwrap_or_else(|| format!("User {}", msg.author_id));
            author_name_cache.insert(msg.author_id, resolved.clone());
            resolved
        };
        transcript_lines.push(format!("{author_name}: {content}"));
    }

    if contains_e2ee {
        return Err(ApiError::BadRequest(
            "This channel contains end-to-end encrypted messages; use client-side summarization."
                .to_string(),
        ));
    }
    if transcript_lines.is_empty() {
        return Err(ApiError::BadRequest(
            "No text messages are available to summarize".to_string(),
        ));
    }

    let system_prompt = "You summarize chat channels. Produce a concise summary with: \
key topics, decisions, open questions, and action items. Keep it factual and neutral.";
    let user_prompt = format!(
        "Channel: {}\nRecent messages (oldest to newest):\n{}",
        channel.name.as_deref().unwrap_or("channel"),
        transcript_lines.join("\n")
    );
    let (summary, provider, model) =
        crate::ai::summarize_text(&state, system_prompt, &user_prompt).await?;

    Ok(Json(json!({
        "channel_id": channel_id.to_string(),
        "provider": provider,
        "model": model,
        "message_count": transcript_lines.len(),
        "summary": summary,
    })))
}

pub async fn bulk_delete_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<BulkDeleteMessagesRequest>,
) -> Result<Json<Value>, ApiError> {
    if body.message_ids.is_empty() {
        return Err(ApiError::BadRequest(
            "message_ids must contain at least one message".into(),
        ));
    }
    if body.message_ids.len() > MAX_BULK_DELETE_REQUEST_IDS {
        return Err(ApiError::BadRequest(
            "Too many message_ids in one request".into(),
        ));
    }
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_MESSAGES],
    )
    .await?;

    let mut ids = Vec::with_capacity(body.message_ids.len());
    for raw in &body.message_ids {
        ids.push(
            raw.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid message ID".into()))?,
        );
    }
    let deleted = paracord_db::messages::bulk_delete_messages(&state.db, channel_id, &ids)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_id = channel.guild_id();
    let bulk_payload = json!({
        "channel_id": channel_id.to_string(),
        "ids": body.message_ids,
    });
    dispatch_channel_event(&state, &channel, "MESSAGE_DELETE_BULK", bulk_payload).await;
    if let Some(gid) = guild_id {
        audit::log_action(
            &state,
            gid,
            auth.user_id,
            audit::ACTION_MESSAGE_BULK_DELETE,
            None,
            None,
            Some(json!({"channel_id": channel_id.to_string(), "count": deleted})),
        )
        .await;

        mod_log::emit_mod_log(
            &state,
            gid,
            "Messages Bulk Deleted",
            "Multiple messages were removed from a channel.",
            &[
                ("Actor", auth.user_id.to_string()),
                ("Channel", channel_id.to_string()),
                ("Count", deleted.to_string()),
            ],
        )
        .await;
    }
    Ok(Json(json!({ "deleted": deleted })))
}

pub async fn send_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let nonce = body
        .nonce
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let has_nonce = nonce.is_some();
    if let Some(candidate) = nonce.as_ref() {
        if candidate.len() > MAX_MESSAGE_NONCE_LEN {
            return Err(ApiError::BadRequest(
                "Message nonce must be 1-64 characters".into(),
            ));
        }
    }

    if body.content.trim().is_empty()
        && body.attachment_ids.is_empty()
        && body.sticker_ids.is_empty()
        && body.e2ee.is_none()
    {
        return Err(ApiError::BadRequest(
            "Message must include content or attachments".into(),
        ));
    }
    if body.e2ee.is_none()
        && !body.content.trim().is_empty()
        && contains_dangerous_markup(&body.content)
    {
        return Err(ApiError::BadRequest(
            "Message contains unsafe markup".into(),
        ));
    }
    if body.e2ee.is_none() && !body.content.trim().is_empty() {
        paracord_util::validation::validate_message_content(&body.content).map_err(|_| {
            ApiError::BadRequest("Message content must be 1-2000 characters".into())
        })?;
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;
    let now = chrono::Utc::now();

    if let Some(guild_id) = channel.guild_id() {
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let channel_perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        let can_bypass = channel_perms.contains(Permissions::MANAGE_MESSAGES)
            || channel_perms.contains(Permissions::MANAGE_GUILD);
        if !can_bypass {
            let feature_settings =
                paracord_db::channel_features::get_or_default(&state.db, channel_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            let exempt_role_ids = paracord_db::channels::parse_required_role_ids(
                &feature_settings.slowmode_exempt_role_ids,
            );
            let member_roles =
                paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            let has_exempt_role = !exempt_role_ids.is_empty()
                && member_roles
                    .iter()
                    .any(|role| exempt_role_ids.contains(&role.id));
            if !has_exempt_role {
                let base_slowmode_seconds = i64::from(channel.rate_limit_per_user.max(0));
                let adaptive_extra_seconds = if feature_settings.adaptive_slowmode_enabled {
                    let window_seconds =
                        i64::from(feature_settings.adaptive_slowmode_window_seconds.max(5));
                    let threshold = i64::from(feature_settings.adaptive_slowmode_threshold.max(1));
                    let step_seconds =
                        i64::from(feature_settings.adaptive_slowmode_step_seconds.max(1));
                    let since = now - chrono::Duration::seconds(window_seconds);
                    let recent_count = paracord_db::messages::count_channel_messages_since(
                        &state.db, channel_id, since,
                    )
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
                    if recent_count >= threshold {
                        (recent_count - threshold + 1) * step_seconds
                    } else {
                        0
                    }
                } else {
                    0
                };
                let effective_slowmode_seconds =
                    (base_slowmode_seconds + adaptive_extra_seconds).max(0);
                if effective_slowmode_seconds > 0 {
                    if let Some(last_message_at) =
                        paracord_db::messages::get_last_user_message_time(
                            &state.db,
                            channel_id,
                            auth.user_id,
                        )
                        .await
                        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    {
                        let elapsed = now.signed_duration_since(last_message_at).num_seconds();
                        if elapsed < effective_slowmode_seconds {
                            return Err(ApiError::RateLimited(
                                effective_slowmode_seconds - elapsed,
                            ));
                        }
                    }
                }
            }
        }
    }

    let referenced_message_id = match body.referenced_message_id.as_deref() {
        Some(id) => Some(
            id.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid referenced_message_id".into()))?,
        ),
        None => None,
    };

    let mut attachments = Vec::with_capacity(body.attachment_ids.len());
    for attachment_id in &body.attachment_ids {
        let id = attachment_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid attachment ID".into()))?;
        let attachment = paracord_db::attachments::get_attachment(&state.db, id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::BadRequest("Attachment does not exist".into()))?;
        if attachment.uploader_id != Some(auth.user_id) {
            return Err(ApiError::Forbidden);
        }
        if attachment.upload_channel_id != Some(channel_id) {
            return Err(ApiError::BadRequest(
                "Attachment was uploaded for a different channel".into(),
            ));
        }
        if attachment
            .upload_expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            return Err(ApiError::BadRequest(
                "Attachment upload has expired; re-upload the file".into(),
            ));
        }
        attachments.push(attachment);
    }

    let mut sticker_ids = Vec::with_capacity(body.sticker_ids.len());
    if !body.sticker_ids.is_empty() {
        let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
            "Stickers are only supported in guild channels".into(),
        ))?;
        for raw_sticker_id in &body.sticker_ids {
            let sticker_id = raw_sticker_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid sticker ID".into()))?;
            let sticker = paracord_db::stickers::get_sticker(&state.db, sticker_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::BadRequest("Sticker does not exist".into()))?;
            if sticker.guild_id != guild_id {
                return Err(ApiError::BadRequest(
                    "Sticker does not belong to this guild".into(),
                ));
            }
            sticker_ids.push(sticker_id);
        }
    }

    // AutoMod. Scoped to human sends through the REST API — the operator-authored
    // paths (bots, webhooks, scheduled delivery) are deliberately not filtered.
    // Runs before creation so a blocked message is never persisted.
    let automod = if let Some(guild_id) = channel.guild_id() {
        run_automod(&state, guild_id, channel_id, auth.user_id, &body.content).await?
    } else {
        paracord_core::automod_enforce::AutomodVerdict::default()
    };

    let msg_id = paracord_util::snowflake::generate(1);

    let dm_e2ee = body
        .e2ee
        .map(|payload| paracord_core::message::DmE2eePayload {
            version: payload.version,
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
            header: payload.header,
        });

    let msg = paracord_core::message::create_message_with_options(
        &state.db,
        msg_id,
        channel_id,
        auth.user_id,
        &body.content,
        paracord_core::message::CreateMessageOptions {
            message_type: 0,
            reference_id: referenced_message_id,
            allow_empty_content: !body.attachment_ids.is_empty() || !body.sticker_ids.is_empty(),
            dm_e2ee,
            nonce,
        },
    )
    .await?;
    let created_new = !has_nonce || msg.id == msg_id;
    for attachment in &attachments {
        if attachment.message_id == Some(msg.id) {
            continue;
        }
        if attachment.message_id.is_some() {
            return Err(ApiError::BadRequest("Attachment is already linked".into()));
        }
        let attached = paracord_db::attachments::attach_to_message(
            &state.db,
            attachment.id,
            msg.id,
            auth.user_id,
            channel_id,
            now.clone(),
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !attached {
            let current_attachment =
                paracord_db::attachments::get_attachment(&state.db, attachment.id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if current_attachment
                .as_ref()
                .is_some_and(|current| current.message_id == Some(msg.id))
            {
                continue;
            }
            return Err(ApiError::BadRequest(
                "Attachment is missing or already linked".into(),
            ));
        }
    }
    if created_new && !sticker_ids.is_empty() {
        paracord_db::stickers::attach_stickers_to_message(&state.db, msg.id, &sticker_ids)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    // Increment thread message count if the channel is a thread
    if created_new && channel.channel_type == 6 {
        let _ = paracord_db::channels::increment_thread_message_count(&state.db, channel_id).await;
    }

    let guild_id = channel.guild_id();
    if created_new && guild_id.is_some() {
        let features = paracord_db::channel_features::get_or_default(&state.db, channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if features.anonymous_posting_enabled {
            let alias = paracord_db::anonymous_messages::get_or_create_alias(
                &state.db,
                channel_id,
                auth.user_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            paracord_db::anonymous_messages::attach_anonymous_message(
                &state.db,
                msg.id,
                channel_id,
                auth.user_id,
                &alias.alias,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        }
    }
    if created_new {
        if let Some(gid) = guild_id {
            if let Err(err) =
                crate::routes::economy::award_message_xp(&state, gid, auth.user_id, &body.content)
                    .await
            {
                tracing::warn!(
                    channel_id,
                    guild_id = gid,
                    user_id = auth.user_id,
                    error = %err,
                    "failed to apply message XP progression"
                );
            }
        }
    }
    let msg_json = message_to_json(&state, &msg, auth.user_id).await;

    if created_new {
        dispatch_channel_event(&state, &channel, "MESSAGE_CREATE", msg_json.clone()).await;

        if !automod.alerts.is_empty() {
            if let Some(gid) = guild_id {
                dispatch_automod_alerts(&state, gid, automod.alerts).await;
            }
        }
        // Applied after the triggering message is stored so the author's own
        // message posts as configured; the timeout starts from the next send.
        if !automod.timeouts.is_empty() {
            paracord_core::automod_enforce::apply_timeouts(&state.db, &automod.timeouts).await;
        }

        // Mention count increment for @user, @everyone, @here
        if !body.content.is_empty() {
            let mentioned_user_ids = parse_mentions(&body.content);
            let mut all_mentioned: Vec<i64> = mentioned_user_ids
                .into_iter()
                .filter(|&uid| uid != auth.user_id)
                .collect();
            if contains_mass_mention(&body.content) {
                if let Some(gid) = guild_id {
                    // Only fan out @everyone/@here to the whole guild when the author
                    // actually holds MENTION_EVERYONE in this channel. Otherwise the
                    // text is still delivered unchanged, but the mass-mention side
                    // effect (incrementing every member's mention count) is skipped.
                    let can_mention_everyone = match paracord_db::guilds::get_guild(&state.db, gid)
                        .await
                    {
                        Ok(Some(guild)) => paracord_core::permissions::compute_channel_permissions(
                            &state.db,
                            gid,
                            channel_id,
                            guild.owner_id,
                            auth.user_id,
                        )
                        .await
                        .map(|perms| perms.contains(Permissions::MENTION_EVERYONE))
                        .unwrap_or(false),
                        _ => false,
                    };
                    if can_mention_everyone {
                        if let Ok(member_ids) =
                            paracord_db::members::get_guild_member_user_ids(&state.db, gid).await
                        {
                            for mid in member_ids {
                                if mid != auth.user_id && !all_mentioned.contains(&mid) {
                                    all_mentioned.push(mid);
                                }
                            }
                        }
                    }
                }
            }
            for uid in all_mentioned {
                let _ =
                    paracord_db::read_states::increment_mention_count(&state.db, uid, channel_id)
                        .await;
            }
        }

        // OpenGraph link preview fetching (non-blocking background task)
        if !body.content.is_empty() {
            crate::opengraph::spawn_opengraph_task(
                state.clone(),
                msg.id,
                channel_id,
                guild_id,
                body.content.clone(),
            );
        }

        // Federation: forward message to peer servers (non-blocking)
        if let Some(gid) = guild_id {
            if paracord_federation::is_enabled() {
                let fed_state = state.clone();
                let fed_content = json!(body.content);
                let fed_msg_id = msg.id;
                let fed_author = auth.user_id;
                let fed_ts = msg.created_at.timestamp_millis();
                tokio::spawn(async move {
                    federation_forward_message(
                        &fed_state,
                        fed_msg_id,
                        channel_id,
                        gid,
                        fed_author,
                        &fed_content,
                        fed_ts,
                    )
                    .await;
                });
            }
        }

        // Announcement channel crosspost: copy message to all follower target channels
        if channel.channel_type == 5 {
            let crosspost_state = state.clone();
            let crosspost_content = body.content.clone();
            let crosspost_author = auth.user_id;
            let crosspost_ref_id = msg.id;
            tokio::spawn(async move {
                if let Ok(follows) = paracord_db::channel_follows::get_follows_for_channel(
                    &crosspost_state.db,
                    channel_id,
                )
                .await
                {
                    for follow in follows {
                        let cross_id = paracord_util::snowflake::generate(1);
                        let cross_msg = paracord_db::messages::create_message(
                            &crosspost_state.db,
                            cross_id,
                            follow.target_channel_id,
                            crosspost_author,
                            &crosspost_content,
                            0,
                            Some(crosspost_ref_id),
                        )
                        .await;
                        if let Ok(cross_msg) = cross_msg {
                            let cross_json =
                                message_to_json(&crosspost_state, &cross_msg, crosspost_author)
                                    .await;
                            crosspost_state.event_bus.dispatch(
                                "MESSAGE_CREATE",
                                cross_json,
                                Some(follow.target_guild_id),
                            );
                        }
                    }
                }
            });
        }
    }

    Ok((
        if created_new {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(msg_json),
    ))
}

pub async fn edit_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, ApiError> {
    if body.e2ee.is_none() {
        paracord_util::validation::validate_message_content(&body.content).map_err(|_| {
            ApiError::BadRequest("Message content must be 1-2000 characters".into())
        })?;
    }
    if body.e2ee.is_none() && contains_dangerous_markup(&body.content) {
        return Err(ApiError::BadRequest(
            "Message contains unsafe markup".into(),
        ));
    }
    let dm_e2ee = body
        .e2ee
        .map(|payload| paracord_core::message::DmE2eePayload {
            version: payload.version,
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
            header: payload.header,
        });
    // AutoMod must run on edits too. Filtering only `send_message` left a
    // trivial bypass: post innocuous text, then edit it to the banned content —
    // permanently, with no hit recorded.
    let edit_guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.guild_id());
    let edit_automod = if let Some(gid) = edit_guild_id {
        run_automod(&state, gid, channel_id, auth.user_id, &body.content).await?
    } else {
        paracord_core::automod_enforce::AutomodVerdict::default()
    };

    let updated = paracord_core::message::edit_message_with_options(
        &state.db,
        channel_id,
        message_id,
        auth.user_id,
        &body.content,
        dm_e2ee,
    )
    .await?;

    if let Some(gid) = edit_guild_id {
        if !edit_automod.alerts.is_empty() {
            dispatch_automod_alerts(&state, gid, edit_automod.alerts).await;
        }
        if !edit_automod.timeouts.is_empty() {
            paracord_core::automod_enforce::apply_timeouts(&state.db, &edit_automod.timeouts).await;
        }
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.as_ref().and_then(|c| c.guild_id());

    let msg_json = message_to_json(&state, &updated, auth.user_id).await;

    if let Some(channel) = channel.as_ref() {
        dispatch_channel_event(&state, channel, "MESSAGE_UPDATE", msg_json.clone()).await;
    }

    if let Some(gid) = guild_id {
        audit::log_action(
            &state,
            gid,
            auth.user_id,
            audit::ACTION_MESSAGE_EDIT,
            Some(message_id),
            None,
            Some(json!({
                "channel_id": channel_id.to_string(),
                "edited_at": updated.edited_at.map(|t| t.to_rfc3339()),
            })),
        )
        .await;

        mod_log::emit_mod_log(
            &state,
            gid,
            "Message Edited",
            "A message was edited by a moderator.",
            &[
                ("Actor", auth.user_id.to_string()),
                ("Channel", channel_id.to_string()),
                ("Message", message_id.to_string()),
            ],
        )
        .await;

        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
                "body": body.content,
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.message.edit",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(message_id.to_string()),
                )
                .await;
            });
        }
    }

    Ok(Json(msg_json))
}

pub async fn get_edit_history(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    let msg = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if msg.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    let history = paracord_db::messages::get_edit_history(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = history
        .iter()
        .map(|h| {
            json!({
                "id": h.id.to_string(),
                "message_id": h.message_id.to_string(),
                "content": h.content,
                "edited_at": h.edited_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

pub async fn delete_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::message::delete_message(&state.db, message_id, channel_id, auth.user_id).await?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.as_ref().and_then(|c| c.guild_id());

    let delete_payload =
        json!({"id": message_id.to_string(), "channel_id": channel_id.to_string()});
    if let Some(channel) = channel.as_ref() {
        dispatch_channel_event(&state, channel, "MESSAGE_DELETE", delete_payload).await;
    }

    if let Some(gid) = guild_id {
        audit::log_action(
            &state,
            gid,
            auth.user_id,
            audit::ACTION_MESSAGE_DELETE,
            Some(message_id),
            None,
            Some(json!({"channel_id": channel_id.to_string()})),
        )
        .await;

        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.message.delete",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(message_id.to_string()),
                )
                .await;
            });
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// AutoMod
// ---------------------------------------------------------------------------

/// Evaluate the space's AutoMod rules against an outgoing message.
///
/// Returns the alerts to post once the message is stored. A blocking rule is
/// surfaced as `ApiError::AutomodBlocked`, which the client renders as the
/// operator's own reason text.
async fn run_automod(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
) -> Result<paracord_core::automod_enforce::AutomodVerdict, ApiError> {
    use paracord_core::automod_enforce::AutomodVerdict;
    if content.trim().is_empty() {
        return Ok(AutomodVerdict::default());
    }

    // Permissions were already computed for the send check; recompute here so
    // the helper stays self-contained (the result is cached by paracord-core).
    let guild = match paracord_db::guilds::get_guild(&state.db, guild_id).await {
        Ok(Some(guild)) => guild,
        _ => return Ok(AutomodVerdict::default()),
    };
    let perms = match paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        author_id,
    )
    .await
    {
        Ok(perms) => perms,
        Err(_) => return Ok(AutomodVerdict::default()),
    };

    let mut verdict = paracord_core::automod_enforce::evaluate_message(
        &state.db, guild_id, channel_id, author_id, content, perms,
    )
    .await;

    if let Some(reason) = verdict.blocked_reason.take() {
        // The message is rejected, so nothing downstream runs the side effects —
        // apply them here. Alerts matter *most* for blocked content: dropping
        // them would notify moderators about everything except what was actually
        // stopped.
        paracord_core::automod_enforce::apply_timeouts(&state.db, &verdict.timeouts).await;
        dispatch_automod_alerts(state, guild_id, std::mem::take(&mut verdict.alerts)).await;
        return Err(ApiError::AutomodBlocked(reason));
    }
    Ok(verdict)
}

/// Post AutoMod moderator alerts.
///
/// Best-effort: a failed alert never affects the message that triggered it.
///
/// Three things here are deliberate and were security-relevant to get right:
///
/// * The target channel is re-checked against the rule's own space. The write
///   path must not trust that the stored rule was validated, and a channel can
///   move or be deleted after the rule was authored.
/// * The alert is authored by the AutoMod system user, never by the member who
///   tripped the rule. Attributing it to them forges authorship and would let
///   them delete the alert about themselves.
/// * The rule name and matched excerpt are operator- and offender-influenced
///   text going into a message body, so they are stripped of markup and
///   length-bounded rather than interpolated raw.
async fn dispatch_automod_alerts(
    state: &AppState,
    guild_id: i64,
    alerts: Vec<paracord_core::automod_enforce::AutomodAlert>,
) {
    if alerts.is_empty() {
        return;
    }
    crate::routes::mod_log::ensure_mod_log_bot(state).await;

    for alert in alerts {
        let alert_channel =
            match paracord_db::channels::get_channel(&state.db, alert.channel_id).await {
                Ok(Some(channel)) => channel,
                _ => {
                    tracing::warn!(
                        channel_id = alert.channel_id,
                        "automod: alert channel no longer exists"
                    );
                    continue;
                }
            };
        if alert_channel.guild_id() != Some(guild_id) {
            tracing::warn!(
                channel_id = alert.channel_id,
                guild_id,
                "automod: refusing to post an alert outside the rule's space"
            );
            continue;
        }

        let username = paracord_db::users::get_user_by_id(&state.db, alert.user_id)
            .await
            .ok()
            .flatten()
            .map(|u| u.username)
            .unwrap_or_else(|| alert.user_id.to_string());

        let body = paracord_core::automod_enforce::alert_message(&alert, &username);

        let alert_id = paracord_util::snowflake::generate(1);
        match paracord_db::messages::create_message(
            &state.db,
            alert_id,
            alert.channel_id,
            crate::routes::mod_log::MOD_LOG_BOT_ID,
            &body,
            0,
            None,
        )
        .await
        {
            Ok(row) => {
                let payload =
                    message_to_json(state, &row, crate::routes::mod_log::MOD_LOG_BOT_ID).await;
                dispatch_channel_event(state, &alert_channel, "MESSAGE_CREATE", payload).await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "automod: failed to post alert");
            }
        }
    }
}
