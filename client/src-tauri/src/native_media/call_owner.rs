use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Records cancellation before the async start handler reaches its first poll.
/// IDs are unique per adapter instance and start is invoked once per instance.
#[derive(Default)]
pub struct CallOwnership {
    inner: Mutex<Ownership>,
    pub transition: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Ownership {
    requested: Option<String>,
    starting: HashSet<String>,
    canceled: HashSet<String>,
    actions: HashMap<&'static str, (u64, Arc<AtomicBool>)>,
}

impl CallOwnership {
    pub fn begin(&self, id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "media ownership lock poisoned")?;
        if state.canceled.remove(id) {
            return Err("native call was canceled before connect".into());
        }
        for (_, flag) in state.actions.values() {
            flag.store(true, Ordering::SeqCst);
        }
        state.actions.clear();
        state.requested = Some(id.to_owned());
        state.starting.insert(id.to_owned());
        Ok(())
    }

    pub fn finish_start(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.starting.remove(id);
            state.canceled.remove(id);
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            if state.starting.contains(id) || state.requested.as_deref() != Some(id) {
                state.canceled.insert(id.to_owned());
            }
            if state.requested.as_deref() == Some(id) {
                for (_, flag) in state.actions.values() {
                    flag.store(true, Ordering::SeqCst);
                }
                state.actions.clear();
                state.requested = None;
            }
        }
    }

    /// Revoke the prior action before waiting for the hardware transition lock.
    /// The capture worker uses the same flag, so a pending native prompt/open
    /// cannot publish after a stop, replacement action, or call cancellation.
    pub fn action(
        &self,
        id: &str,
        feature: &'static str,
        revision: u64,
    ) -> Result<Arc<AtomicBool>, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "media ownership lock poisoned")?;
        if state.requested.as_deref() != Some(id) || state.canceled.contains(id) {
            return Err("native call ownership expired".into());
        }
        if revision == 0
            || state
                .actions
                .get(feature)
                .is_some_and(|(old, _)| *old >= revision)
        {
            return Err("native capture action was superseded".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        if let Some((_, previous)) = state.actions.insert(feature, (revision, flag.clone())) {
            previous.store(true, Ordering::SeqCst);
        }
        Ok(flag)
    }

    pub fn current_action(
        &self,
        id: &str,
        feature: &'static str,
        revision: u64,
    ) -> Result<Arc<AtomicBool>, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "media ownership lock poisoned")?;
        if state.requested.as_deref() != Some(id) {
            return Err("native call ownership expired".into());
        }
        state
            .actions
            .get(feature)
            .filter(|(current, flag)| *current == revision && !flag.load(Ordering::SeqCst))
            .map(|(_, flag)| flag.clone())
            .ok_or_else(|| "native capture action was superseded".into())
    }

    pub fn check_action(&self, id: &str, canceled: &AtomicBool) -> Result<(), String> {
        self.check(id)?;
        if canceled.load(Ordering::SeqCst) {
            Err("native capture action was canceled".into())
        } else {
            Ok(())
        }
    }

    pub fn check(&self, id: &str) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "media ownership lock poisoned")?;
        if state.requested.as_deref() == Some(id) && !state.canceled.contains(id) {
            Ok(())
        } else {
            Err("native call ownership expired".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canceled_start_cannot_claim_the_replacement() {
        let ownership = CallOwnership::default();
        ownership.cancel("old");
        ownership.begin("new").unwrap();
        assert!(ownership.begin("old").is_err());
        ownership.check("new").unwrap();
    }

    #[test]
    fn stop_supersedes_pending_permission_and_out_of_order_start() {
        let ownership = CallOwnership::default();
        ownership.begin("call").unwrap();
        let camera = ownership.action("call", "camera", 1).unwrap();
        let stop = ownership.action("call", "camera", 3).unwrap();
        assert!(camera.load(Ordering::SeqCst));
        assert!(ownership.action("call", "camera", 2).is_err());
        ownership.check_action("call", &stop).unwrap();
        ownership.cancel("call");
        assert!(stop.load(Ordering::SeqCst));
    }

    #[test]
    fn replacement_cancels_workers_without_waiting_for_transition() {
        let ownership = CallOwnership::default();
        ownership.begin("old").unwrap();
        let capture = ownership.action("old", "screen", 1).unwrap();
        ownership.begin("new").unwrap();
        assert!(capture.load(Ordering::SeqCst));
        ownership.action("new", "screen", 1).unwrap();
        assert!(ownership.action("old", "screen", 9).is_err());
    }

    #[test]
    fn late_connect_and_old_stop_preserve_new_owner() {
        let ownership = CallOwnership::default();
        ownership.begin("old").unwrap();
        ownership.begin("new").unwrap();
        ownership.cancel("old");
        assert!(ownership.check("old").is_err());
        ownership.finish_start("old");
        ownership.check("new").unwrap();
    }
}
