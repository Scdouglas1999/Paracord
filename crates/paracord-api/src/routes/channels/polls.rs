use super::*;

#[derive(Deserialize)]
pub struct CreatePollOptionRequest {
    pub text: String,
    pub emoji: Option<String>,
}

#[derive(Deserialize)]
pub struct CreatePollRequest {
    pub question: String,
    pub options: Vec<CreatePollOptionRequest>,
    pub allow_multiselect: Option<bool>,
    pub expires_in_minutes: Option<i64>,
}

pub async fn create_poll(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreatePollRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let question = body.question.trim();
    if question.is_empty() || question.chars().count() > MAX_POLL_QUESTION_LEN {
        return Err(ApiError::BadRequest(
            "Poll question must be between 1 and 300 characters".into(),
        ));
    }
    if contains_dangerous_markup(question) {
        return Err(ApiError::BadRequest(
            "Poll question contains unsafe markup".into(),
        ));
    }
    if body.options.len() < 2 || body.options.len() > MAX_POLL_OPTIONS {
        return Err(ApiError::BadRequest(
            "Polls must include between 2 and 10 options".into(),
        ));
    }

    let mut options = Vec::with_capacity(body.options.len());
    for option in &body.options {
        let text = option.text.trim();
        if text.is_empty() || text.chars().count() > MAX_POLL_OPTION_LEN {
            return Err(ApiError::BadRequest(
                "Poll options must be between 1 and 100 characters".into(),
            ));
        }
        if contains_dangerous_markup(text) {
            return Err(ApiError::BadRequest(
                "Poll options contain unsafe markup".into(),
            ));
        }
        options.push(paracord_db::polls::CreatePollOption {
            text: text.to_string(),
            emoji: option.emoji.clone(),
        });
    }

    let expires_at = match body.expires_in_minutes {
        Some(minutes) => {
            if !(1..=MAX_POLL_DURATION_MINUTES).contains(&minutes) {
                return Err(ApiError::BadRequest(
                    "Poll duration must be between 1 minute and 14 days".into(),
                ));
            }
            Some(chrono::Utc::now() + chrono::Duration::minutes(minutes))
        }
        None => None,
    };

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

    let message_id = paracord_util::snowflake::generate(1);
    let msg = paracord_core::message::create_message_with_type(
        &state.db,
        message_id,
        channel_id,
        auth.user_id,
        question,
        20,
        None,
    )
    .await?;

    let poll_id = paracord_util::snowflake::generate(1);
    paracord_db::polls::create_poll(
        &state.db,
        poll_id,
        msg.id,
        channel_id,
        question,
        &options,
        body.allow_multiselect.unwrap_or(false),
        expires_at,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let msg_json = message_to_json(&state, &msg, auth.user_id).await;
    dispatch_channel_event(&state, &channel, "MESSAGE_CREATE", msg_json.clone()).await;

    Ok((StatusCode::CREATED, Json(msg_json)))
}

pub async fn get_poll(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    Ok(Json(poll_to_json(&poll)))
}

pub async fn add_poll_vote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id, option_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
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

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }
    if poll
        .poll
        .expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now())
    {
        return Err(ApiError::BadRequest("Poll voting has expired".into()));
    }
    if !poll.options.iter().any(|opt| opt.id == option_id) {
        return Err(ApiError::BadRequest("Invalid poll option".into()));
    }

    paracord_db::polls::add_vote(&state.db, poll_id, option_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let updated = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let poll_json = poll_to_json(&updated);

    let event_payload = json!({
        "channel_id": channel_id.to_string(),
        "poll_id": poll_id.to_string(),
        "option_id": option_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "poll": poll_json,
    });
    dispatch_channel_event(&state, &channel, "POLL_VOTE_ADD", event_payload).await;

    Ok(Json(poll_to_json(&updated)))
}

pub async fn remove_poll_vote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id, option_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
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

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }
    if !poll.options.iter().any(|opt| opt.id == option_id) {
        return Err(ApiError::BadRequest("Invalid poll option".into()));
    }

    paracord_db::polls::remove_vote(&state.db, poll_id, option_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let updated = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let poll_json = poll_to_json(&updated);

    let event_payload = json!({
        "channel_id": channel_id.to_string(),
        "poll_id": poll_id.to_string(),
        "option_id": option_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "poll": poll_json,
    });
    dispatch_channel_event(&state, &channel, "POLL_VOTE_REMOVE", event_payload).await;

    Ok(Json(poll_to_json(&updated)))
}
