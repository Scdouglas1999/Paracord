use dashmap::DashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

/// A pending offline task tagged with the generation token it was scheduled under.
struct PendingOffline {
    /// Monotonic token identifying this specific scheduled task.
    generation: u64,
    handle: JoinHandle<()>,
}

/// Manages deferred offline presence transitions to avoid race conditions
/// between connection guard drops and reconnections.
///
/// When a user disconnects, instead of immediately marking them offline,
/// the handler schedules a delayed check via this manager. If the user
/// reconnects within the grace period, the pending offline task is cancelled.
pub struct PresenceManager {
    pending_offlines: Arc<DashMap<i64, PendingOffline>>,
    /// Monotonic source of per-task generation tokens. Each scheduled task gets a
    /// unique token so a stale task can detect it has been superseded and must not
    /// evict the newer handle.
    generation: Arc<AtomicU64>,
    grace_period: Duration,
}

impl PresenceManager {
    pub fn new() -> Self {
        Self {
            pending_offlines: Arc::new(DashMap::new()),
            generation: Arc::new(AtomicU64::new(0)),
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
        let my_generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            task.await;
            // Only remove our own entry. If a reconnect+redisconnect scheduled a
            // newer task while we were between sleep-completion and this point, the
            // map now holds a different generation and we must leave it untouched;
            // otherwise this stale task would delete the live handle, defeating any
            // subsequent cancel_offline and flipping a connected user offline.
            pending.remove_if(&user_id, |_, entry| entry.generation == my_generation);
        });
        self.pending_offlines.insert(
            user_id,
            PendingOffline {
                generation: my_generation,
                handle,
            },
        );
    }

    /// Cancel any pending offline task for `user_id` (e.g. on reconnect).
    pub fn cancel_offline(&self, user_id: i64) {
        if let Some((_, entry)) = self.pending_offlines.remove(&user_id) {
            entry.handle.abort();
        }
    }
}

impl Default for PresenceManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn short_grace() -> PresenceManager {
        let mut pm = PresenceManager::new();
        pm.grace_period = Duration::from_millis(20);
        pm
    }

    /// A stale task that finishes running after a newer task was scheduled must
    /// not evict the newer handle; a subsequent cancel must still be able to abort
    /// the live task, and the newer offline future must never run once cancelled.
    #[tokio::test]
    async fn stale_task_does_not_evict_current_handle() {
        let pm = short_grace();

        let first_ran = Arc::new(AtomicBool::new(false));
        let second_ran = Arc::new(AtomicBool::new(false));

        // First schedule: a fast task so it completes its future/remove promptly.
        {
            let first_ran = first_ran.clone();
            pm.schedule_offline(1, async move {
                first_ran.store(true, Ordering::SeqCst);
            });
        }

        // Reconnect + redisconnect: schedule a new (slow) task for the same user.
        // This cancels the first handle, but the first task's spawned body may still
        // be racing toward its trailing pending.remove(&user_id).
        {
            let second_ran = second_ran.clone();
            pm.schedule_offline(1, async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                second_ran.store(true, Ordering::SeqCst);
            });
        }

        // Let the first (stale) task's grace period elapse and its body finish,
        // giving it every chance to (wrongly) remove the current entry.
        tokio::time::sleep(Duration::from_millis(60)).await;

        // The current (second) handle must still be tracked...
        assert!(
            pm.pending_offlines.contains_key(&1),
            "stale task must not have evicted the current handle"
        );

        // ...and cancel_offline must still be able to abort it.
        pm.cancel_offline(1);
        assert!(!pm.pending_offlines.contains_key(&1));

        // Give the aborted second task's grace/sleep window time to pass; its
        // offline future must never have run because it was cancelled.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            !second_ran.load(Ordering::SeqCst),
            "cancelled offline task must not have flipped the user offline"
        );
    }

    #[tokio::test]
    async fn schedule_runs_future_and_self_removes() {
        let pm = short_grace();
        let ran = Arc::new(AtomicBool::new(false));
        {
            let ran = ran.clone();
            pm.schedule_offline(7, async move {
                ran.store(true, Ordering::SeqCst);
            });
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(ran.load(Ordering::SeqCst), "offline future should have run");
        assert!(
            !pm.pending_offlines.contains_key(&7),
            "completed task should remove its own entry"
        );
    }

    #[tokio::test]
    async fn cancel_prevents_offline() {
        let pm = short_grace();
        let ran = Arc::new(AtomicBool::new(false));
        {
            let ran = ran.clone();
            pm.schedule_offline(9, async move {
                ran.store(true, Ordering::SeqCst);
            });
        }
        pm.cancel_offline(9);
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            !ran.load(Ordering::SeqCst),
            "cancelled task should not run the offline future"
        );
    }
}
