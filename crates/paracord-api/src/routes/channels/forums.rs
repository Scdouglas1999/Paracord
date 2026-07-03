use super::*;

fn forum_tag_to_json(tag: &paracord_db::channels::ForumTagRow) -> Value {
    json!({
        "id": tag.id.to_string(),
        "channel_id": tag.channel_id.to_string(),
        "name": tag.name,
        "emoji": tag.emoji,
        "moderated": tag.moderated,
        "position": tag.position,
        "created_at": tag.created_at.to_rfc3339(),
    })
}

#[derive(Deserialize)]
pub struct ForumPostQuery {
    pub sort_order: Option<i32>,
    pub include_archived: Option<bool>,
}

#[derive(Deserialize)]
pub struct CreateForumPostRequest {
    pub name: String,
    pub content: Option<String>,
    pub applied_tag_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct CreateForumTagRequest {
    pub name: String,
    pub emoji: Option<String>,
    pub moderated: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateForumSortOrderRequest {
    pub sort_order: i32,
}

pub async fn get_forum_posts(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ForumPostQuery>,
) -> Result<Json<Value>, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let sort_order = query
        .sort_order
        .unwrap_or(forum_channel.default_sort_order.unwrap_or(0));
    let include_archived = query.include_archived.unwrap_or(false);

    let posts =
        paracord_db::channels::get_forum_posts(&state.db, channel_id, sort_order, include_archived)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let tags = paracord_db::channels::get_forum_tags(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "posts": posts.iter().map(channel_to_json).collect::<Vec<Value>>(),
        "tags": tags.iter().map(forum_tag_to_json).collect::<Vec<Value>>(),
        "sort_order": sort_order,
    })))
}

pub async fn create_forum_post(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateForumPostRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "Post title must be 1-100 characters".into(),
        ));
    }
    if contains_dangerous_markup(name) {
        return Err(ApiError::BadRequest(
            "Post title contains unsafe markup".into(),
        ));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;

    let guild_id = forum_channel.guild_id().ok_or(ApiError::BadRequest(
        "Cannot create forum posts in DMs".into(),
    ))?;

    let applied_tags = match body.applied_tag_ids {
        Some(tags) => {
            let parsed = parse_role_id_strings(&tags)?
                .into_iter()
                .map(|id| id.to_string())
                .collect::<Vec<String>>();
            Some(
                serde_json::to_string(&parsed)
                    .map_err(|_| ApiError::BadRequest("Invalid applied_tag_ids".into()))?,
            )
        }
        None => None,
    };

    let post_id = paracord_util::snowflake::generate(1);
    let post = paracord_db::channels::create_forum_post(
        &state.db,
        post_id,
        guild_id,
        channel_id,
        name,
        auth.user_id,
        applied_tags.as_deref(),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if let Some(content) = body
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let message_id = paracord_util::snowflake::generate(1);
        let _ = paracord_db::messages::create_message(
            &state.db,
            message_id,
            post.id,
            auth.user_id,
            content,
            0,
            None,
        )
        .await;
        let _ = paracord_db::channels::increment_thread_message_count(&state.db, post.id).await;
    }

    let post_json = channel_to_json(&post);
    state
        .event_bus
        .dispatch("THREAD_CREATE", post_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(post_json)))
}

pub async fn create_forum_tag(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateForumTagRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 30 {
        return Err(ApiError::BadRequest(
            "Tag name must be 1-30 characters".into(),
        ));
    }
    if contains_dangerous_markup(name) {
        return Err(ApiError::BadRequest(
            "Tag name contains unsafe markup".into(),
        ));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let tag = paracord_db::channels::create_forum_tag(
        &state.db,
        paracord_util::snowflake::generate(1),
        channel_id,
        name,
        body.emoji.as_deref(),
        body.moderated.unwrap_or(false),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(forum_tag_to_json(&tag))))
}

pub async fn list_forum_tags(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let tags = paracord_db::channels::get_forum_tags(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(tags
        .iter()
        .map(forum_tag_to_json)
        .collect::<Vec<Value>>())))
}

pub async fn delete_forum_tag(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, tag_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let deleted = paracord_db::channels::delete_forum_tag(&state.db, tag_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !deleted {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_forum_sort_order(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateForumSortOrderRequest>,
) -> Result<StatusCode, ApiError> {
    if body.sort_order != 0 && body.sort_order != 1 {
        return Err(ApiError::BadRequest("sort_order must be 0 or 1".into()));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    paracord_db::channels::update_forum_sort_order(&state.db, channel_id, body.sort_order)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}
