//! The per-session event queue is a memory bound, not just a tuning knob.
//!
//! `EventBus::register_session` creates one `tokio::sync::broadcast` channel per
//! gateway connection, and that channel allocates its entire ring up front.
//! Measured on this `ServerEvent` (80 bytes) each slot costs ~105 bytes, so the
//! depth multiplies straight into resident memory at the gateway's connection
//! cap:
//!
//! | depth | per session | at 2000 connections |
//! |-------|-------------|---------------------|
//! | 4096  | ~420 KiB    | ~840 MB             |
//! | 1024  | ~104 KiB    | ~208 MB             |
//!
//! That is allocated whether or not a single event is ever queued, which is why
//! the default is bounded here rather than left at the broadcast channel's
//! historical 4096.

use std::sync::Arc;

use paracord_core::events::{
    default_event_bus_capacity, EventBus, ServerEvent, DEFAULT_EVENT_BUS_CAPACITY,
};

fn event() -> ServerEvent {
    ServerEvent {
        event_type: "TEST".to_string(),
        payload: Arc::new(serde_json::json!({})),
        guild_id: None,
        target_user_ids: None,
        serialized_payload: None,
    }
}

/// The number that actually determines the gateway's floor memory usage. Raising
/// it costs ~105 bytes per slot per connection, so it does not move without a
/// deliberate decision.
#[test]
fn default_per_session_queue_depth_stays_bounded() {
    // Assert on the depth a bus actually hands out, not the constant, so the
    // check covers `Default` and the env override together.
    let depth = EventBus::default().capacity();
    assert_eq!(depth, DEFAULT_EVENT_BUS_CAPACITY);
    assert_eq!(default_event_bus_capacity(), DEFAULT_EVENT_BUS_CAPACITY);
    assert!(
        depth <= 1024,
        "per-session queue depth {depth} reserves ~{} KiB per connection before a \
         single event is queued; at a 2000-connection cap that is ~{} MB of empty \
         ring buffer",
        depth * 105 / 1024,
        depth * 105 * 2000 / 1024 / 1024,
    );
}

/// Depth still has to be deep enough to be useful: it must comfortably exceed
/// the gateway's `MAX_REPLAY_EVENTS` (100), past which a client that falls behind
/// has to re-IDENTIFY on its next RESUME anyway.
#[test]
fn default_queue_is_far_deeper_than_the_replay_window() {
    const GATEWAY_MAX_REPLAY_EVENTS: usize = 100;
    let depth = EventBus::default().capacity();
    assert!(
        depth >= GATEWAY_MAX_REPLAY_EVENTS * 8,
        "queue depth {depth} must stay well above the replay window so a briefly \
         slow client is not forced to reconnect"
    );
}

/// A session queued exactly to its depth still receives every event; nothing is
/// dropped short of the bound.
#[test]
fn a_session_receives_a_full_queue_without_lagging() {
    let depth = 256;
    let bus = EventBus::new(depth);
    let mut rx = bus.register_session("full", 1, &[]).expect("register");

    for _ in 0..depth {
        bus.publish(event());
    }

    for i in 0..depth {
        assert!(
            rx.try_recv().is_ok(),
            "event {i} of a queue filled exactly to its depth must be delivered"
        );
    }
    assert!(rx.try_recv().is_err(), "queue should now be empty");
}

/// Past the bound the receiver lags, which the gateway turns into a 1013 close
/// so the client reconnects and re-fetches. That behaviour is unchanged by the
/// depth reduction — only how much memory is reserved to reach it.
#[test]
fn a_session_lags_once_it_overruns_its_queue() {
    let depth = 256;
    let bus = EventBus::new(depth);
    let mut rx = bus.register_session("overrun", 1, &[]).expect("register");

    for _ in 0..(depth + 1) {
        bus.publish(event());
    }

    assert!(
        matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
        ),
        "overrunning the queue must surface as Lagged, not silent loss"
    );
}
