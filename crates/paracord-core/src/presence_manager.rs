use dashmap::DashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

/// Manages deferred offline presence transitions to avoid race conditions
/// between connection guard drops and reconnections.
///
/// When a user disconnects, instead of immediately marking them offline,
/// the handler schedules a delayed check via this manager. If the user
/// reconnects within the grace period, the pending offline task is cancelled.
pub struct PresenceManager {
    pending_offlines: Arc<DashMap<i64, JoinHandle<()>>>,
    grace_period: Duration,
}

impl PresenceManager {
    pub fn new() -> Self {
        Self {
            pending_offlines: Arc::new(DashMap::new()),
            grace_period: Duration::from_millis(1500),
        }
    }

    /// Schedule a deferred offline check for `user_id`.
    ///
    /// Any previously pending offline task for the same user is cancelled first.
    /// After `grace_period` elapses, the provided future runs (which should
    /// re-check connection count and mark offline only if still 0).
    pub fn schedule_offline<F>(&self, user_id: i64, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.cancel_offline(user_id);
        let pending = self.pending_offlines.clone();
        let delay = self.grace_period;
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            task.await;
            pending.remove(&user_id);
        });
        self.pending_offlines.insert(user_id, handle);
    }

    /// Cancel any pending offline task for `user_id` (e.g. on reconnect).
    pub fn cancel_offline(&self, user_id: i64) {
        if let Some((_, handle)) = self.pending_offlines.remove(&user_id) {
            handle.abort();
        }
    }
}

impl Default for PresenceManager {
    fn default() -> Self {
        Self::new()
    }
}
