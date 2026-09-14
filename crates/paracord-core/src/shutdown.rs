//! The process-wide shutdown signal.
//!
//! Two kinds of task need to hear that the server is going away, and they need
//! to hear it differently.
//!
//! Background workers park on a bare [`Notify`] inside a `select!` loop, and a
//! single `notify_waiters()` wakes all of them at once. That is enough for a
//! worker, because a worker is always parked on the signal when it is idle.
//!
//! A *connection* handler is not. An SSE stream or a gateway session arms its
//! wait only when it loops round, and a browser can open a new one during the
//! drain — so an edge-triggered `Notify` alone loses the signal for exactly the
//! connections that hold the process open. This type latches: once triggered it
//! stays triggered, [`is_shutting_down`](ShutdownSignal::is_shutting_down)
//! answers `true` forever after, and [`notified`](ShutdownSignal::notified)
//! returns immediately rather than waiting for a second trigger that will never
//! come.
//!
//! `notified()` is cancel-safe, so it can sit in a `select!` arm that is
//! rebuilt on every iteration.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

/// A latched "the server is shutting down" signal, cloneable and shared.
#[derive(Clone)]
pub struct ShutdownSignal {
    latched: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownSignal {
    pub fn new() -> Self {
        Self {
            latched: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// The bare `Notify` background workers park on.
    ///
    /// Kept so the worker signatures (`shutdown: Arc<Notify>`) stay as they
    /// are: they are woken by the same `notify_waiters()` [`trigger`] fires.
    ///
    /// [`trigger`]: ShutdownSignal::trigger
    pub fn notify_handle(&self) -> Arc<Notify> {
        Arc::clone(&self.notify)
    }

    /// Latch the signal and wake everything currently waiting on it.
    ///
    /// Idempotent: calling it twice wakes any newcomers and changes nothing
    /// else.
    pub fn trigger(&self) {
        self.latched.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Whether shutdown has been signalled. Never returns to `false`.
    pub fn is_shutting_down(&self) -> bool {
        self.latched.load(Ordering::SeqCst)
    }

    /// Resolve when shutdown is signalled — immediately if it already was.
    ///
    /// Cancel-safe: dropping the future (a losing `select!` arm) neither
    /// consumes nor loses the signal, because the latch, not the wakeup, is
    /// what is actually being observed.
    pub async fn notified(&self) {
        if self.is_shutting_down() {
            return;
        }
        let waiter = self.notify.notified();
        tokio::pin!(waiter);
        // Register as a waiter *before* re-reading the latch, so a trigger
        // racing this call either sets the latch we are about to read or wakes
        // the waiter we have just armed. Without `enable()` the registration
        // happens on first poll, which is after the check — the one ordering
        // that can miss the signal entirely.
        waiter.as_mut().enable();
        if self.is_shutting_down() {
            return;
        }
        waiter.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notified_returns_immediately_once_latched() {
        let signal = ShutdownSignal::new();
        signal.trigger();
        // A connection that armed its wait *after* the trigger — the SSE stream
        // a browser opened mid-drain — must not hang forever.
        tokio::time::timeout(std::time::Duration::from_millis(100), signal.notified())
            .await
            .expect("a latched signal resolves without a second trigger");
        assert!(signal.is_shutting_down());
    }

    #[tokio::test]
    async fn notified_wakes_a_waiter_armed_before_the_trigger() {
        let signal = ShutdownSignal::new();
        let waiter = {
            let signal = signal.clone();
            tokio::spawn(async move { signal.notified().await })
        };
        tokio::task::yield_now().await;
        signal.trigger();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("waiter woke within the deadline")
            .expect("waiter task did not panic");
    }

    #[tokio::test]
    async fn a_losing_select_arm_does_not_consume_the_signal() {
        let signal = ShutdownSignal::new();
        // Loop the way a stream's tail does: a fresh `notified()` each pass.
        for _ in 0..3 {
            tokio::select! {
                _ = signal.notified() => panic!("not signalled yet"),
                _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
            }
        }
        signal.trigger();
        tokio::select! {
            _ = signal.notified() => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                panic!("a rebuilt select arm missed the signal");
            }
        }
    }

    #[test]
    fn workers_keep_their_bare_notify() {
        let signal = ShutdownSignal::new();
        let handle = signal.notify_handle();
        assert!(Arc::ptr_eq(&handle, &signal.notify));
    }
}
