use super::*;

#[derive(Deserialize)]
pub struct ArchivedThreadsQuery {
    /// Id cursor: return archived threads older than this id (exclusive).
    pub before: Option<i64>,
    /// Page size, clamped to 1..=100 (default 50).
    pub limit: Option<i64>,
}

// ============ Thread endpoints ============

#[derive(Deserialize)]
pub struct CreateThreadRequest {
    pub name: String,
    pub message_id: Option<String>,
    pub auto_archive_duration: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateThreadRequest {
    pub name: Option<String>,
    pub archived: Option<bool>,
    pub locked: Option<bool>,
}

pub async fn create_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateThreadRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.name.trim().is_empty() || body.name.trim().chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "Thread name must be 1-100 characters".into(),
        ));
    }
    if contains_dangerous_markup(&body.name) {
        return Err(ApiError::BadRequest(
            "Thread name contains unsafe markup".into(),
        ));
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Threads can only be created in text or announcement channels
    if parent_channel.channel_type != 0 && parent_channel.channel_type != 5 {
        return Err(ApiError::BadRequest(
            "Threads can only be created in text or announcement channels".into(),
        ));
    }

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;

    let guild_id = parent_channel
        .guild_id()
        .ok_or(ApiError::BadRequest("Cannot create threads in DMs".into()))?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    let can_manage =
        perms.contains(Permissions::MANAGE_MESSAGES) || perms.contains(Permissions::MANAGE_GUILD);
    if !can_manage {
        let now = chrono::Utc::now();
        let feature_settings = paracord_db::channel_features::get_or_default(&state.db, channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let exempt_role_ids = paracord_db::channels::parse_required_role_ids(
            &feature_settings.slowmode_exempt_role_ids,
        );
        let member_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let has_exempt_role = !exempt_role_ids.is_empty()
            && member_roles
                .iter()
                .any(|role| exempt_role_ids.contains(&role.id));
        if !has_exempt_role {
            let base_thread_slowmode =
                i64::from(feature_settings.thread_rate_limit_per_user.max(0));
            let adaptive_extra = if feature_settings.adaptive_slowmode_enabled {
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
            let effective_thread_slowmode = (base_thread_slowmode + adaptive_extra).max(0);
            if effective_thread_slowmode > 0 {
                if let Some(last_created) = paracord_db::channels::get_last_thread_creation_time(
                    &state.db,
                    channel_id,
                    auth.user_id,
                )
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                {
                    let elapsed = now.signed_duration_since(last_created).num_seconds();
                    if elapsed < effective_thread_slowmode {
                        return Err(ApiError::RateLimited(effective_thread_slowmode - elapsed));
                    }
                }
            }
        }
    }

    let auto_archive_duration = body.auto_archive_duration.unwrap_or(1440);
    let starter_message_id = match body.message_id.as_deref() {
        Some(raw_message_id) => {
            let parsed_message_id = raw_message_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid message_id".into()))?;
            let starter_message = paracord_db::messages::get_message(&state.db, parsed_message_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::BadRequest("Starter message not found".into()))?;
            if starter_message.channel_id != channel_id {
                return Err(ApiError::BadRequest(
                    "Starter message must belong to the parent channel".into(),
                ));
            }
            Some(parsed_message_id)
        }
        None => None,
    };

    let thread_id = paracord_util::snowflake::generate(1);
    let thread = paracord_db::channels::create_thread(
        &state.db,
        thread_id,
        guild_id,
        channel_id,
        body.name.trim(),
        auth.user_id,
        auto_archive_duration,
        starter_message_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let thread_json = channel_to_json(&thread);

    state
        .event_bus
        .dispatch("THREAD_CREATE", thread_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(thread_json)))
}

pub async fn get_threads(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let threads = paracord_db::channels::get_channel_threads(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = threads.iter().map(channel_to_json).collect();
    Ok(Json(json!(result)))
}

pub async fn get_archived_threads(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<ArchivedThreadsQuery>,
) -> Result<Json<Value>, ApiError> {
    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let limit = params.limit.unwrap_or(50).clamp(1, 100);
    let threads =
        paracord_db::channels::get_archived_threads(&state.db, channel_id, params.before, limit)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = threads.iter().map(channel_to_json).collect();
    Ok(Json(json!(result)))
}

pub async fn update_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateThreadRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(ref name) = body.name {
        if name.trim().is_empty() || name.trim().chars().count() > 100 {
            return Err(ApiError::BadRequest(
                "Thread name must be 1-100 characters".into(),
            ));
        }
        if contains_dangerous_markup(name) {
            return Err(ApiError::BadRequest(
                "Thread name contains unsafe markup".into(),
            ));
        }
    }

    let thread = paracord_db::channels::get_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if thread.channel_type != 6 {
        return Err(ApiError::BadRequest("Channel is not a thread".into()));
    }
    if thread.parent_id != Some(channel_id) {
        return Err(ApiError::NotFound);
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let is_thread_owner = thread.owner_id == Some(auth.user_id);

    if (body.archived.is_some() || body.locked.is_some()) && !is_thread_owner {
        ensure_channel_permissions(
            &state,
            &parent_channel,
            auth.user_id,
            &[Permissions::MANAGE_CHANNELS],
        )
        .await?;
    }

    if body.name.is_some() && !is_thread_owner {
        ensure_channel_permissions(
            &state,
            &parent_channel,
            auth.user_id,
            &[Permissions::MANAGE_CHANNELS],
        )
        .await?;
    }

    let updated = paracord_db::channels::update_thread(
        &state.db,
        thread_id,
        body.name.as_deref(),
        body.archived,
        body.locked,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let thread_json = channel_to_json(&updated);
    let guild_id = updated.guild_id();

    state
        .event_bus
        .dispatch("THREAD_UPDATE", thread_json.clone(), guild_id);

    Ok(Json(thread_json))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let thread = paracord_db::channels::get_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if thread.channel_type != 6 {
        return Err(ApiError::BadRequest("Channel is not a thread".into()));
    }
    if thread.parent_id != Some(channel_id) {
        return Err(ApiError::NotFound);
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let guild_id = thread.guild_id();

    paracord_db::channels::delete_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "THREAD_DELETE",
        json!({
            "id": thread_id.to_string(),
            "guild_id": guild_id.map(|id| id.to_string()),
            "parent_id": channel_id.to_string(),
        }),
        guild_id,
    );

    Ok(StatusCode::NO_CONTENT)
}
