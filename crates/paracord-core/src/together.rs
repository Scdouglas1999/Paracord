//! Watch together and Listen together: one shared playback session per voice
//! channel.
//!
//! The server is the only authority on what is playing, where, and whether it
//! is paused. Every change goes through [`TogetherManager`], which bumps a
//! monotonic `revision`, and publishes the whole state:
//!
//! * `TOGETHER_SESSION_UPDATE` (full state) to the people in the call, and
//! * `TOGETHER_ACTIVITY_UPDATE` (a slim summary) guild-wide, carrying the
//!   channel id so the gateway only delivers it to people who can see that
//!   voice channel (sidebar row, server page "Live now").
//!
//! Clients never trust each other's players. They compute the expected
//! position from `position_ms + (server_now - position_at) * rate` using their
//! own estimate of the server clock (`server_time_ms` on every payload and on
//! the gateway heartbeat ACK) and correct their local player towards it.
//!
//! Sessions live in memory. They end when someone stops them or when the call
//! has been empty for a short grace period (so a brief reconnect of everyone
//! does not lose the queue). Nothing survives a restart.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::AppState;

/// Full state, sent only to the people in the call.
pub const EVENT_TOGETHER_SESSION_UPDATE: &str = "TOGETHER_SESSION_UPDATE";
/// Slim summary for everyone in the server who can see the voice channel.
pub const EVENT_TOGETHER_ACTIVITY_UPDATE: &str = "TOGETHER_ACTIVITY_UPDATE";

/// Longest queue a session holds.
pub const MAX_QUEUE_ITEMS: usize = 100;
/// How long an empty call keeps its session before it ends.
pub const DEFAULT_EMPTY_GRACE: Duration = Duration::from_secs(30);
/// Safety sweep: re-check every session's call against the voice states even
/// when no voice event arrived (a lagged bus, a leave path that published
/// nothing).
const RECONCILE_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TogetherKind {
    Watch,
    Listen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControllerPolicy {
    /// Anyone in the call can play, pause, seek and change the queue.
    Everyone,
    /// Only the person who started the session can.
    Starter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemSource {
    /// A YouTube video id, played through the IFrame Player API on each device.
    Youtube,
    /// A direct `http(s)` media URL played by the browser's `<video>`/`<audio>`.
    Url,
    /// An attachment id; each viewer downloads it with their own permissions.
    Attachment,
}

/// A validated item ready to be queued. The API layer resolves titles and
/// checks sources; the engine only orders and plays them.
#[derive(Debug, Clone)]
pub struct NewItem {
    pub source: ItemSource,
    pub reference: String,
    pub title: String,
    pub duration_ms: Option<u64>,
    pub thumbnail: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TogetherItem {
    pub id: i64,
    pub source: ItemSource,
    pub reference: String,
    pub title: String,
    pub duration_ms: Option<u64>,
    pub thumbnail: Option<String>,
    pub content_type: Option<String>,
    pub added_by: i64,
}

impl TogetherItem {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "source": self.source,
            "ref": self.reference,
            "title": self.title,
            "duration_ms": self.duration_ms,
            "thumbnail": self.thumbnail,
            "content_type": self.content_type,
            "added_by": self.added_by.to_string(),
        })
    }
}

/// What a request asked the playback to do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Control {
    Play,
    Pause,
    Seek {
        position_ms: u64,
    },
    /// Jump to a queued item, or to the next one when `None`.
    Skip {
        to_item_id: Option<i64>,
    },
    /// A client's player reached the end of `item_id`. Idempotent: only the
    /// first report for the current item advances the queue, and it is allowed
    /// for everyone in the call even when controls are locked, since it is the
    /// media ending rather than a person choosing.
    Ended {
        item_id: i64,
    },
}

/// The change an update carries, for the in-call toast ("Priya paused").
#[derive(Debug, Clone, PartialEq)]
pub struct TogetherAction {
    pub action_type: &'static str,
    pub user_id: Option<i64>,
    pub position_ms: Option<u64>,
    pub item_id: Option<i64>,
}

impl TogetherAction {
    fn by(action_type: &'static str, user_id: i64) -> Self {
        Self {
            action_type,
            user_id: Some(user_id),
            position_ms: None,
            item_id: None,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "type": self.action_type,
            "user_id": self.user_id.map(|id| id.to_string()),
            "position_ms": self.position_ms,
            "item_id": self.item_id.map(|id| id.to_string()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TogetherError {
    NoSession,
    AlreadyRunning,
    ControlsLocked,
    ItemNotFound,
    QueueFull,
    Invalid(String),
}

impl std::fmt::Display for TogetherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TogetherError::NoSession => write!(f, "Nothing is playing together in this call"),
            TogetherError::AlreadyRunning => {
                write!(f, "Something is already playing together in this call")
            }
            TogetherError::ControlsLocked => {
                write!(f, "Only the person who started this can control it")
            }
            TogetherError::ItemNotFound => write!(f, "That item is no longer in the queue"),
            TogetherError::QueueFull => {
                write!(f, "The queue is full ({MAX_QUEUE_ITEMS} items)")
            }
            TogetherError::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for TogetherError {}

#[derive(Debug, Clone)]
pub struct TogetherSession {
    pub session_id: i64,
    pub channel_id: i64,
    pub guild_id: Option<i64>,
    pub kind: TogetherKind,
    pub controller_policy: ControllerPolicy,
    pub started_by: i64,
    pub started_at: i64,
    pub items: Vec<TogetherItem>,
    /// Index of the playing item. `items.len()` means nothing is current: the
    /// queue ran out (or was emptied) and the next added item starts.
    pub current_index: usize,
    pub playing: bool,
    pub position_ms: u64,
    /// Server wall-clock time (ms since the Unix epoch) `position_ms` was true.
    pub position_at: i64,
    pub rate: f64,
    pub revision: u64,
    /// Who the server last saw in the call; newcomers are sent the state.
    participants: HashSet<i64>,
    /// When the call was first seen empty, while the grace period runs.
    empty_since: Option<i64>,
}

impl TogetherSession {
    pub fn new(
        session_id: i64,
        channel_id: i64,
        guild_id: Option<i64>,
        kind: TogetherKind,
        controller_policy: ControllerPolicy,
        started_by: i64,
        items: Vec<TogetherItem>,
        now_ms: i64,
    ) -> Self {
        Self {
            session_id,
            channel_id,
            guild_id,
            kind,
            controller_policy,
            started_by,
            started_at: now_ms,
            items,
            current_index: 0,
            playing: true,
            position_ms: 0,
            position_at: now_ms,
            rate: 1.0,
            revision: 0,
            participants: HashSet::new(),
            empty_since: None,
        }
    }

    pub fn current_item(&self) -> Option<&TogetherItem> {
        self.items.get(self.current_index)
    }

    pub fn can_control(&self, user_id: i64) -> bool {
        match self.controller_policy {
            ControllerPolicy::Everyone => true,
            ControllerPolicy::Starter => user_id == self.started_by,
        }
    }

    /// Where playback is at `now_ms` by the server's clock.
    pub fn position_at_time(&self, now_ms: i64) -> u64 {
        let mut position = self.position_ms;
        if self.playing && self.current_item().is_some() {
            let elapsed = (now_ms - self.position_at).max(0) as f64 * self.rate;
            position = position.saturating_add(elapsed as u64);
        }
        match self.current_item().and_then(|item| item.duration_ms) {
            Some(duration) => position.min(duration),
            None => position,
        }
    }

    /// Fold elapsed play time into `position_ms` so a state change starts from
    /// where playback really is.
    fn rebase(&mut self, now_ms: i64) {
        self.position_ms = self.position_at_time(now_ms);
        self.position_at = now_ms;
    }

    fn start_item(&mut self, index: usize, now_ms: i64) {
        self.current_index = index;
        self.position_ms = 0;
        self.position_at = now_ms;
        self.playing = index < self.items.len();
    }

    /// Apply a playback control. Returns `None` when nothing changed (a
    /// duplicate "ended" report), so no revision is spent and nothing is sent.
    pub fn apply_control(
        &mut self,
        user_id: i64,
        control: Control,
        now_ms: i64,
    ) -> Result<Option<TogetherAction>, TogetherError> {
        if let Control::Ended { item_id } = control {
            if self.current_item().map(|item| item.id) != Some(item_id) {
                return Ok(None);
            }
            let next = self.current_index + 1;
            self.start_item(next, now_ms);
            let mut action = TogetherAction::by("ended", user_id);
            action.item_id = Some(item_id);
            return Ok(Some(action));
        }
        if !self.can_control(user_id) {
            return Err(TogetherError::ControlsLocked);
        }
        let action = match control {
            Control::Play => {
                if self.current_item().is_none() {
                    return Err(TogetherError::Invalid("The queue is empty".into()));
                }
                self.rebase(now_ms);
                self.playing = true;
                let mut action = TogetherAction::by("play", user_id);
                action.position_ms = Some(self.position_ms);
                action
            }
            Control::Pause => {
                self.rebase(now_ms);
                self.playing = false;
                let mut action = TogetherAction::by("pause", user_id);
                action.position_ms = Some(self.position_ms);
                action
            }
            Control::Seek { position_ms } => {
                let Some(item) = self.current_item() else {
                    return Err(TogetherError::Invalid("The queue is empty".into()));
                };
                let position_ms = match item.duration_ms {
                    Some(duration) => position_ms.min(duration),
                    None => position_ms,
                };
                self.position_ms = position_ms;
                self.position_at = now_ms;
                let mut action = TogetherAction::by("seek", user_id);
                action.position_ms = Some(position_ms);
                action
            }
            Control::Skip { to_item_id } => {
                let index = match to_item_id {
                    Some(item_id) => self
                        .items
                        .iter()
                        .position(|item| item.id == item_id)
                        .ok_or(TogetherError::ItemNotFound)?,
                    None => {
                        let next = self.current_index + 1;
                        if next >= self.items.len() {
                            return Err(TogetherError::Invalid(
                                "Nothing else is in the queue".into(),
                            ));
                        }
                        next
                    }
                };
                self.start_item(index, now_ms);
                let mut action = TogetherAction::by("skip", user_id);
                action.item_id = Some(self.items[index].id);
                action
            }
            Control::Ended { .. } => unreachable!("handled above"),
        };
        Ok(Some(action))
    }

    pub fn add_items(
        &mut self,
        user_id: i64,
        items: Vec<TogetherItem>,
        now_ms: i64,
    ) -> Result<TogetherAction, TogetherError> {
        if !self.can_control(user_id) {
            return Err(TogetherError::ControlsLocked);
        }
        if items.is_empty() {
            return Err(TogetherError::Invalid("Nothing to add".into()));
        }
        if self.items.len() + items.len() > MAX_QUEUE_ITEMS {
            return Err(TogetherError::QueueFull);
        }
        let first_id = items[0].id;
        let was_idle = self.current_item().is_none();
        self.items.extend(items);
        if was_idle {
            // Nothing was current: the first new item starts, jukebox style.
            let index = self.current_index;
            self.start_item(index, now_ms);
        }
        let mut action = TogetherAction::by("add", user_id);
        action.item_id = Some(first_id);
        Ok(action)
    }

    pub fn remove_item(
        &mut self,
        user_id: i64,
        item_id: i64,
        now_ms: i64,
    ) -> Result<TogetherAction, TogetherError> {
        if !self.can_control(user_id) {
            return Err(TogetherError::ControlsLocked);
        }
        let index = self
            .items
            .iter()
            .position(|item| item.id == item_id)
            .ok_or(TogetherError::ItemNotFound)?;
        self.items.remove(index);
        if index < self.current_index {
            self.current_index -= 1;
        } else if index == self.current_index {
            // The playing item went; whatever moved into its place starts, and
            // playback continues only if it was already going.
            let was_playing = self.playing;
            self.start_item(index, now_ms);
            self.playing = was_playing && self.current_item().is_some();
        }
        let mut action = TogetherAction::by("remove", user_id);
        action.item_id = Some(item_id);
        Ok(action)
    }

    pub fn move_item(
        &mut self,
        user_id: i64,
        item_id: i64,
        to_index: usize,
    ) -> Result<TogetherAction, TogetherError> {
        if !self.can_control(user_id) {
            return Err(TogetherError::ControlsLocked);
        }
        let from = self
            .items
            .iter()
            .position(|item| item.id == item_id)
            .ok_or(TogetherError::ItemNotFound)?;
        let current_id = self.current_item().map(|item| item.id);
        let item = self.items.remove(from);
        let to_index = to_index.min(self.items.len());
        self.items.insert(to_index, item);
        self.current_index = match current_id {
            Some(id) => self
                .items
                .iter()
                .position(|item| item.id == id)
                .unwrap_or(self.items.len()),
            None => self.items.len(),
        };
        let mut action = TogetherAction::by("reorder", user_id);
        action.item_id = Some(item_id);
        Ok(action)
    }

    pub fn set_policy(
        &mut self,
        user_id: i64,
        policy: ControllerPolicy,
    ) -> Result<TogetherAction, TogetherError> {
        if user_id != self.started_by {
            return Err(TogetherError::Invalid(
                "Only the person who started this can change who controls it".into(),
            ));
        }
        self.controller_policy = policy;
        Ok(TogetherAction::by("policy", user_id))
    }

    pub fn to_json(&self, now_ms: i64) -> Value {
        json!({
            "session_id": self.session_id.to_string(),
            "channel_id": self.channel_id.to_string(),
            "guild_id": self.guild_id.map(|id| id.to_string()),
            "kind": self.kind,
            "controller_policy": self.controller_policy,
            "started_by": self.started_by.to_string(),
            "started_at": self.started_at,
            "items": self.items.iter().map(TogetherItem::to_json).collect::<Vec<_>>(),
            "current_index": self.current_index,
            "playing": self.playing,
            "position_ms": self.position_ms,
            "position_at": self.position_at,
            "rate": self.rate,
            "revision": self.revision,
            "server_time_ms": now_ms,
        })
    }

    /// The slim summary the sidebar and "Live now" draw.
    pub fn activity_json(&self) -> Value {
        let current = self.current_item();
        json!({
            "session_id": self.session_id.to_string(),
            "kind": self.kind,
            "started_by": self.started_by.to_string(),
            "playing": self.playing,
            "title": current.map(|item| item.title.clone()),
            "source": current.map(|item| item.source),
            "thumbnail": current.and_then(|item| item.thumbnail.clone()),
            "content_type": current.and_then(|item| item.content_type.clone()),
            "item_count": self.items.len(),
        })
    }
}

/// All live sessions, keyed by voice channel id.
pub struct TogetherManager {
    sessions: Mutex<HashMap<i64, TogetherSession>>,
    revision: AtomicU64,
    empty_grace_ms: AtomicU64,
    watcher_started: AtomicBool,
}

impl Default for TogetherManager {
    fn default() -> Self {
        Self::new()
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl TogetherManager {
    pub fn new() -> Self {
        // Revisions start at the wall clock (in microsecond-sized steps) so a
        // client that kept a revision across a server restart does not drop
        // every update of the new process as stale.
        let seed = (now_ms().max(0) as u64).saturating_mul(1000);
        Self {
            sessions: Mutex::new(HashMap::new()),
            revision: AtomicU64::new(seed),
            empty_grace_ms: AtomicU64::new(DEFAULT_EMPTY_GRACE.as_millis() as u64),
            watcher_started: AtomicBool::new(false),
        }
    }

    /// How long an empty call keeps its session. Tests shorten it.
    pub fn set_empty_grace(&self, grace: Duration) {
        self.empty_grace_ms
            .store(grace.as_millis() as u64, Ordering::Relaxed);
    }

    fn empty_grace(&self) -> Duration {
        Duration::from_millis(self.empty_grace_ms.load(Ordering::Relaxed))
    }

    fn next_revision(&self) -> u64 {
        self.revision.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The revision a "nothing is playing" answer carries: anything published
    /// after it is newer.
    pub fn current_revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, TogetherSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self, channel_id: i64) -> Option<TogetherSession> {
        self.lock().get(&channel_id).cloned()
    }

    /// Slim summaries of every session in a guild, as `(channel_id, revision,
    /// activity)`.
    pub fn guild_activities(&self, guild_id: i64) -> Vec<(i64, u64, Value)> {
        self.lock()
            .values()
            .filter(|session| session.guild_id == Some(guild_id))
            .map(|session| {
                (
                    session.channel_id,
                    session.revision,
                    session.activity_json(),
                )
            })
            .collect()
    }

    fn channel_ids(&self) -> Vec<i64> {
        self.lock().keys().copied().collect()
    }
}

/// Publish a session's state (or its end, when `session` is `None`).
///
/// Called with the session map locked so events leave in revision order.
fn publish(
    state: &AppState,
    channel_id: i64,
    guild_id: Option<i64>,
    revision: u64,
    session: Option<&TogetherSession>,
    action: Option<&TogetherAction>,
    recipients: Vec<i64>,
) {
    let now = now_ms();
    if !recipients.is_empty() {
        state.event_bus.dispatch_to_users(
            EVENT_TOGETHER_SESSION_UPDATE,
            json!({
                "channel_id": channel_id.to_string(),
                "guild_id": guild_id.map(|id| id.to_string()),
                "revision": revision,
                "server_time_ms": now,
                "session": session.map(|session| session.to_json(now)),
                "action": action.map(TogetherAction::to_json),
            }),
            recipients,
        );
    }
    if let Some(guild_id) = guild_id {
        // Guild-scoped with a `channel_id`: the gateway delivers it only to
        // sessions that may view this voice channel.
        state.event_bus.dispatch(
            EVENT_TOGETHER_ACTIVITY_UPDATE,
            json!({
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "revision": revision,
                "activity": session.map(TogetherSession::activity_json),
            }),
            Some(guild_id),
        );
    }
}

/// Who is in the call right now, by the voice states.
pub async fn channel_participants(
    state: &AppState,
    channel_id: i64,
) -> Result<HashSet<i64>, crate::error::CoreError> {
    Ok(
        paracord_db::voice_states::get_channel_voice_states(&state.db, channel_id)
            .await?
            .into_iter()
            .map(|row| row.user_id)
            .collect(),
    )
}

/// Start a session in `channel_id`. The caller has already checked that
/// `user_id` is in that call.
pub async fn start(
    state: &AppState,
    channel_id: i64,
    guild_id: Option<i64>,
    user_id: i64,
    kind: TogetherKind,
    controller_policy: ControllerPolicy,
    items: Vec<NewItem>,
) -> Result<Value, TogetherError> {
    if items.is_empty() {
        return Err(TogetherError::Invalid("Add something to play first".into()));
    }
    if items.len() > MAX_QUEUE_ITEMS {
        return Err(TogetherError::QueueFull);
    }
    ensure_watcher(state);
    let participants = channel_participants(state, channel_id)
        .await
        .map_err(|error| TogetherError::Invalid(error.to_string()))?;
    let manager = &state.together;
    let now = now_ms();
    let mut sessions = manager.lock();
    if sessions.contains_key(&channel_id) {
        return Err(TogetherError::AlreadyRunning);
    }
    let items = items
        .into_iter()
        .map(|item| materialize(item, user_id))
        .collect();
    let mut session = TogetherSession::new(
        paracord_util::snowflake::generate(1),
        channel_id,
        guild_id,
        kind,
        controller_policy,
        user_id,
        items,
        now,
    );
    session.revision = manager.next_revision();
    session.participants = participants.clone();
    let action = TogetherAction::by("start", user_id);
    publish(
        state,
        channel_id,
        guild_id,
        session.revision,
        Some(&session),
        Some(&action),
        participants.into_iter().collect(),
    );
    let body = session.to_json(now);
    sessions.insert(channel_id, session);
    Ok(body)
}

fn materialize(item: NewItem, added_by: i64) -> TogetherItem {
    TogetherItem {
        id: paracord_util::snowflake::generate(1),
        source: item.source,
        reference: item.reference,
        title: item.title,
        duration_ms: item.duration_ms,
        thumbnail: item.thumbnail,
        content_type: item.content_type,
        added_by,
    }
}

/// Apply `change` to the channel's session, then publish it. A change that
/// returns `Ok(None)` changed nothing and publishes nothing.
async fn mutate<F>(state: &AppState, channel_id: i64, change: F) -> Result<Value, TogetherError>
where
    F: FnOnce(&mut TogetherSession, i64) -> Result<Option<TogetherAction>, TogetherError>,
{
    let participants = channel_participants(state, channel_id)
        .await
        .map_err(|error| TogetherError::Invalid(error.to_string()))?;
    let manager = &state.together;
    let now = now_ms();
    let mut sessions = manager.lock();
    let session = sessions
        .get_mut(&channel_id)
        .ok_or(TogetherError::NoSession)?;
    let Some(action) = change(session, now)? else {
        return Ok(session.to_json(now));
    };
    session.revision = manager.next_revision();
    publish(
        state,
        channel_id,
        session.guild_id,
        session.revision,
        Some(session),
        Some(&action),
        participants.into_iter().collect(),
    );
    Ok(session.to_json(now))
}

pub async fn control(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    control: Control,
) -> Result<Value, TogetherError> {
    mutate(state, channel_id, |session, now| {
        session.apply_control(user_id, control, now)
    })
    .await
}

pub async fn add_items(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    items: Vec<NewItem>,
) -> Result<Value, TogetherError> {
    let items: Vec<TogetherItem> = items
        .into_iter()
        .map(|item| materialize(item, user_id))
        .collect();
    mutate(state, channel_id, |session, now| {
        session.add_items(user_id, items, now).map(Some)
    })
    .await
}

pub async fn remove_item(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    item_id: i64,
) -> Result<Value, TogetherError> {
    mutate(state, channel_id, |session, now| {
        session.remove_item(user_id, item_id, now).map(Some)
    })
    .await
}

pub async fn move_item(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    item_id: i64,
    to_index: usize,
) -> Result<Value, TogetherError> {
    mutate(state, channel_id, |session, _| {
        session.move_item(user_id, item_id, to_index).map(Some)
    })
    .await
}

pub async fn set_policy(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    policy: ControllerPolicy,
) -> Result<Value, TogetherError> {
    mutate(state, channel_id, |session, _| {
        session.set_policy(user_id, policy).map(Some)
    })
    .await
}

/// "Stop for everyone".
pub async fn stop(state: &AppState, channel_id: i64, user_id: i64) -> Result<(), TogetherError> {
    let participants = channel_participants(state, channel_id)
        .await
        .map_err(|error| TogetherError::Invalid(error.to_string()))?;
    let manager = &state.together;
    let mut sessions = manager.lock();
    let session = sessions.get(&channel_id).ok_or(TogetherError::NoSession)?;
    if !session.can_control(user_id) {
        return Err(TogetherError::ControlsLocked);
    }
    let guild_id = session.guild_id;
    sessions.remove(&channel_id);
    let revision = manager.next_revision();
    publish(
        state,
        channel_id,
        guild_id,
        revision,
        None,
        Some(&TogetherAction::by("stop", user_id)),
        participants.into_iter().collect(),
    );
    Ok(())
}

/// Start the voice-state watcher once per process, on first use.
fn ensure_watcher(state: &AppState) {
    if state.together.watcher_started.swap(true, Ordering::SeqCst) {
        return;
    }
    // Subscribe before spawning so no voice event published after this call
    // can be missed.
    let mut events = state.event_bus.subscribe_system();
    let state = state.clone();
    tokio::spawn(async move {
        let mut sweep = tokio::time::interval(RECONCILE_INTERVAL);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => {
                        if event.event_type != "VOICE_STATE_UPDATE" {
                            continue;
                        }
                        for key in ["channel_id", "prior_channel_id"] {
                            let channel_id = event
                                .payload
                                .get(key)
                                .and_then(Value::as_str)
                                .and_then(|raw| raw.parse::<i64>().ok());
                            if let Some(channel_id) = channel_id {
                                if state.together.lock().contains_key(&channel_id) {
                                    reconcile(&state, channel_id).await;
                                }
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        for channel_id in state.together.channel_ids() {
                            reconcile(&state, channel_id).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                _ = sweep.tick() => {
                    for channel_id in state.together.channel_ids() {
                        reconcile(&state, channel_id).await;
                    }
                }
            }
        }
    });
}

/// Bring a session in line with who is in its call: hand newcomers the state,
/// release a lock whose owner left, and end the session once the call has been
/// empty for the grace period.
pub async fn reconcile(state: &AppState, channel_id: i64) {
    let participants = match channel_participants(state, channel_id).await {
        Ok(participants) => participants,
        Err(error) => {
            tracing::warn!(channel_id, %error, "together: could not read the call's voice states");
            return;
        }
    };
    let manager = &state.together;
    let grace = manager.empty_grace();
    let now = now_ms();
    let mut sessions = manager.lock();
    let Some(session) = sessions.get_mut(&channel_id) else {
        return;
    };

    if participants.is_empty() {
        let empty_since = *session.empty_since.get_or_insert(now);
        session.participants.clear();
        if now - empty_since < grace.as_millis() as i64 {
            let state = state.clone();
            let session_id = session.session_id;
            drop(sessions);
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                expire_if_still_empty(&state, channel_id, session_id).await;
            });
            return;
        }
        end_emptied_session(state, &mut sessions, channel_id);
        return;
    }

    session.empty_since = None;
    let newcomers: Vec<i64> = participants
        .difference(&session.participants)
        .copied()
        .collect();
    session.participants = participants.clone();

    if session.controller_policy == ControllerPolicy::Starter
        && !participants.contains(&session.started_by)
    {
        // Nobody could control a locked session whose owner left the call.
        session.controller_policy = ControllerPolicy::Everyone;
        session.revision = manager.next_revision();
        let action = TogetherAction {
            action_type: "unlocked",
            user_id: Some(session.started_by),
            position_ms: None,
            item_id: None,
        };
        publish(
            state,
            channel_id,
            session.guild_id,
            session.revision,
            Some(session),
            Some(&action),
            participants.into_iter().collect(),
        );
        return;
    }

    if !newcomers.is_empty() {
        // Late joiners jump straight to the current position. Same revision:
        // nothing changed for anyone else.
        let now = now_ms();
        state.event_bus.dispatch_to_users(
            EVENT_TOGETHER_SESSION_UPDATE,
            json!({
                "channel_id": channel_id.to_string(),
                "guild_id": session.guild_id.map(|id| id.to_string()),
                "revision": session.revision,
                "server_time_ms": now,
                "session": session.to_json(now),
                "action": Value::Null,
            }),
            newcomers,
        );
    }
}

/// The grace period after the call emptied has run out: end the session
/// unless someone came back (or it already ended and a new one started).
async fn expire_if_still_empty(state: &AppState, channel_id: i64, session_id: i64) {
    let Ok(participants) = channel_participants(state, channel_id).await else {
        return;
    };
    if !participants.is_empty() {
        // Someone is back; the next reconcile clears the empty mark.
        return;
    }
    let grace = state.together.empty_grace().as_millis() as i64;
    let mut sessions = state.together.lock();
    let Some(session) = sessions.get(&channel_id) else {
        return;
    };
    let expired = session
        .empty_since
        .is_some_and(|since| now_ms() - since >= grace);
    if session.session_id == session_id && expired {
        end_emptied_session(state, &mut sessions, channel_id);
    }
}

fn end_emptied_session(
    state: &AppState,
    sessions: &mut HashMap<i64, TogetherSession>,
    channel_id: i64,
) {
    let Some(session) = sessions.remove(&channel_id) else {
        return;
    };
    let revision = state.together.next_revision();
    publish(
        state,
        channel_id,
        session.guild_id,
        revision,
        None,
        Some(&TogetherAction {
            action_type: "call_ended",
            user_id: None,
            position_ms: None,
            item_id: None,
        }),
        Vec::new(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: i64, duration_ms: Option<u64>) -> TogetherItem {
        TogetherItem {
            id,
            source: ItemSource::Url,
            reference: format!("https://example.com/{id}.mp4"),
            title: format!("{id}.mp4"),
            duration_ms,
            thumbnail: None,
            content_type: Some("video/mp4".into()),
            added_by: 1,
        }
    }

    fn session(policy: ControllerPolicy, items: Vec<TogetherItem>) -> TogetherSession {
        TogetherSession::new(
            10,
            20,
            Some(30),
            TogetherKind::Watch,
            policy,
            1,
            items,
            1_000,
        )
    }

    #[test]
    fn position_advances_only_while_playing() {
        let mut s = session(ControllerPolicy::Everyone, vec![item(1, None)]);
        assert_eq!(s.position_at_time(3_500), 2_500);
        s.apply_control(1, Control::Pause, 3_500).unwrap();
        assert!(!s.playing);
        assert_eq!(s.position_ms, 2_500);
        assert_eq!(s.position_at_time(10_000), 2_500);
        s.apply_control(1, Control::Play, 10_000).unwrap();
        assert_eq!(s.position_at_time(11_000), 3_500);
    }

    #[test]
    fn position_stops_at_a_known_duration() {
        let s = session(ControllerPolicy::Everyone, vec![item(1, Some(2_000))]);
        assert_eq!(s.position_at_time(60_000), 2_000);
    }

    #[test]
    fn seek_keeps_the_play_state() {
        let mut s = session(ControllerPolicy::Everyone, vec![item(1, None)]);
        let action = s
            .apply_control(
                2,
                Control::Seek {
                    position_ms: 760_000,
                },
                5_000,
            )
            .unwrap()
            .unwrap();
        assert_eq!(action.action_type, "seek");
        assert_eq!(action.position_ms, Some(760_000));
        assert!(s.playing);
        assert_eq!(s.position_at_time(6_000), 761_000);
    }

    #[test]
    fn locked_controls_refuse_everyone_but_the_starter() {
        let mut s = session(
            ControllerPolicy::Starter,
            vec![item(1, None), item(2, None)],
        );
        assert_eq!(
            s.apply_control(2, Control::Pause, 2_000),
            Err(TogetherError::ControlsLocked)
        );
        assert_eq!(
            s.add_items(2, vec![item(3, None)], 2_000),
            Err(TogetherError::ControlsLocked)
        );
        assert!(s.apply_control(1, Control::Pause, 2_000).is_ok());
        // The media ending is not a person choosing: anyone may report it.
        assert!(s
            .apply_control(2, Control::Ended { item_id: 1 }, 3_000)
            .unwrap()
            .is_some());
        assert_eq!(s.current_index, 1);
    }

    #[test]
    fn a_repeated_ended_report_changes_nothing() {
        let mut s = session(
            ControllerPolicy::Everyone,
            vec![item(1, None), item(2, None)],
        );
        assert!(s
            .apply_control(1, Control::Ended { item_id: 1 }, 2_000)
            .unwrap()
            .is_some());
        assert!(s
            .apply_control(2, Control::Ended { item_id: 1 }, 2_001)
            .unwrap()
            .is_none());
        assert_eq!(s.current_item().unwrap().id, 2);
    }

    #[test]
    fn the_queue_running_out_leaves_nothing_current_until_something_is_added() {
        let mut s = session(ControllerPolicy::Everyone, vec![item(1, None)]);
        s.apply_control(1, Control::Ended { item_id: 1 }, 2_000)
            .unwrap();
        assert!(s.current_item().is_none());
        assert!(!s.playing);
        s.add_items(1, vec![item(2, None)], 3_000).unwrap();
        assert_eq!(s.current_item().unwrap().id, 2);
        assert!(s.playing);
        assert_eq!(s.position_at_time(4_000), 1_000);
    }

    #[test]
    fn skip_moves_to_the_next_or_a_chosen_item() {
        let mut s = session(
            ControllerPolicy::Everyone,
            vec![item(1, None), item(2, None), item(3, None)],
        );
        s.apply_control(1, Control::Skip { to_item_id: None }, 2_000)
            .unwrap();
        assert_eq!(s.current_item().unwrap().id, 2);
        assert_eq!(s.position_ms, 0);
        s.apply_control(
            1,
            Control::Skip {
                to_item_id: Some(1),
            },
            2_000,
        )
        .unwrap();
        assert_eq!(s.current_item().unwrap().id, 1);
        assert_eq!(
            s.apply_control(
                1,
                Control::Skip {
                    to_item_id: Some(99)
                },
                2_000
            ),
            Err(TogetherError::ItemNotFound)
        );
    }

    #[test]
    fn removing_and_moving_keep_the_current_item() {
        let mut s = session(
            ControllerPolicy::Everyone,
            vec![item(1, None), item(2, None), item(3, None)],
        );
        s.apply_control(
            1,
            Control::Skip {
                to_item_id: Some(2),
            },
            2_000,
        )
        .unwrap();
        s.remove_item(1, 1, 2_000).unwrap();
        assert_eq!(s.current_item().unwrap().id, 2);
        s.move_item(1, 3, 0).unwrap();
        assert_eq!(s.items.iter().map(|i| i.id).collect::<Vec<_>>(), vec![3, 2]);
        assert_eq!(s.current_item().unwrap().id, 2);
        // Removing the playing item starts whatever takes its place.
        s.remove_item(1, 2, 5_000).unwrap();
        assert!(s.current_item().is_none());
        assert!(!s.playing);
    }

    #[test]
    fn only_the_starter_changes_the_policy() {
        let mut s = session(ControllerPolicy::Everyone, vec![item(1, None)]);
        assert!(s.set_policy(2, ControllerPolicy::Starter).is_err());
        assert!(s.set_policy(1, ControllerPolicy::Starter).is_ok());
        assert_eq!(s.controller_policy, ControllerPolicy::Starter);
    }

    #[test]
    fn the_queue_is_capped() {
        let mut s = session(ControllerPolicy::Everyone, vec![item(1, None)]);
        let many = (2..=(MAX_QUEUE_ITEMS as i64 + 1))
            .map(|id| item(id, None))
            .collect();
        assert_eq!(s.add_items(1, many, 2_000), Err(TogetherError::QueueFull));
    }

    #[test]
    fn revisions_increase_and_start_from_the_clock() {
        let manager = TogetherManager::new();
        let first = manager.next_revision();
        let second = manager.next_revision();
        assert!(second > first);
        assert!(first > 1_000_000_000_000_000);
        // Stays exactly representable as a JavaScript number.
        assert!(second < (1u64 << 53));
    }
}
