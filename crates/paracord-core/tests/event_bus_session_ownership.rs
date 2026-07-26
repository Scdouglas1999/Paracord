//! Regression coverage for event-bus session-id ownership.
//!
//! The session-id keyspace is shared by the WebSocket gateway and the SSE
//! transport, and ids are disclosed to co-members (READY publishes every visible
//! voice state's `session_id`). `register_session` used to be a blind
//! `sessions.insert`, so anyone who learned another user's id could re-point it
//! at their own receiver — and because `user_sessions` still listed the id under
//! the original owner, the victim's user-targeted events (DM `MESSAGE_CREATE`
//! included) were then delivered to the claimant.

use std::sync::Arc;

use paracord_core::events::{EventBus, ServerEvent};

fn test_event(guild_id: Option<i64>, target_user_ids: Option<Vec<i64>>) -> ServerEvent {
    ServerEvent {
        event_type: "MESSAGE_CREATE".to_string(),
        payload: Arc::new(serde_json::json!({ "content": "private" })),
        guild_id,
        target_user_ids,
        serialized_payload: None,
    }
}

const VICTIM: i64 = 1001;
const ATTACKER: i64 = 2002;

#[test]
fn a_session_id_cannot_be_claimed_by_another_user() {
    let bus = EventBus::new(16);
    let _victim_rx = bus
        .register_session("victim-session", VICTIM, &[])
        .expect("victim registers their own session");

    assert!(
        bus.register_session("victim-session", ATTACKER, &[])
            .is_none(),
        "registering a session id owned by another user must be refused"
    );
}

#[test]
fn a_refused_claim_does_not_divert_the_owners_targeted_events() {
    let bus = EventBus::new(16);
    let mut victim_rx = bus
        .register_session("victim-session", VICTIM, &[])
        .expect("victim registers their own session");

    // The attacker knows the victim's session id and tries to take it over.
    assert!(bus
        .register_session("victim-session", ATTACKER, &[])
        .is_none());

    // A DM addressed to the victim must still reach the victim's own receiver.
    bus.publish(test_event(None, Some(vec![VICTIM])));
    let delivered = victim_rx.try_recv().expect("victim receives their own DM");
    assert_eq!(delivered.event_type, "MESSAGE_CREATE");

    // And nothing is routed to the attacker: their claim never registered, so
    // they hold no receiver at all.
    bus.publish(test_event(None, Some(vec![ATTACKER])));
    assert!(
        victim_rx.try_recv().is_err(),
        "an event targeted at the attacker must not land in the victim's stream"
    );
}

#[test]
fn an_unclaimed_id_cannot_be_squatted_ahead_of_its_owner() {
    let bus = EventBus::new(16);

    // The attacker claims an id before the victim has registered it (the
    // vacant-branch squat: the id is known because it is published in READY).
    let _attacker_rx = bus
        .register_session("victim-session", ATTACKER, &[])
        .expect("first registration of a free id succeeds");

    // The victim must not be locked out of a *different* id of their own, and
    // must not be able to be silently attached to the squatter's channel.
    assert!(
        bus.register_session("victim-session", VICTIM, &[])
            .is_none(),
        "the squatted id must not be handed to a second user"
    );
    let mut victim_rx = bus
        .register_session("victim-session-2", VICTIM, &[])
        .expect("the victim can still register an id of their own");

    bus.publish(test_event(None, Some(vec![VICTIM])));
    assert!(
        victim_rx.try_recv().is_ok(),
        "the victim's own session keeps receiving their targeted events"
    );
}

#[test]
fn the_same_user_may_reattach_to_their_own_session_id() {
    let bus = EventBus::new(16);
    let first = bus
        .register_session("s", VICTIM, &[10])
        .expect("initial registration");
    drop(first);

    // Gateway RESUME / SSE reconnect: the same user re-registers the same id.
    let mut second = bus
        .register_session("s", VICTIM, &[20])
        .expect("re-attaching to your own session id must be allowed");

    bus.publish(test_event(Some(20), None));
    assert!(
        second.try_recv().is_ok(),
        "the re-attached session receives its current guild's events"
    );

    // The replaced registration's guild set must not linger in the index.
    bus.publish(test_event(Some(10), None));
    assert!(
        second.try_recv().is_err(),
        "the previous registration's guild must not still route to this session"
    );
}
