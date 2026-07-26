//! Availability regression tests for the media transport's own bounds.
//!
//! Two surfaces are covered here: the JSON control plane's identifier cap
//! (which the binary frame path has always enforced and the control plane did
//! not), and pre-auth connection admission — the only place an *unauthenticated*
//! peer makes the server allocate state.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use paracord_transport::admission::{
    AdmissionRefusal, PreAuthAdmission, MAX_PENDING_CONNECTIONS, MAX_PENDING_CONNECTIONS_PER_IP,
};
use paracord_transport::control::{ControlMessage, SessionParticipant, TrackKind};
use paracord_transport::protocol::MAX_IDENTIFIER_LEN;
use paracord_transport::stream::{
    PublishedLayer, PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodec,
};

// ── H6: control-plane identifiers are capped like the binary frame path ─────

fn oversized() -> String {
    // Comfortably inside the 256 KiB control-frame cap, which is exactly the
    // point: the frame cap was never a bound on retained room state.
    "x".repeat(120 * 1024)
}

#[test]
fn oversized_control_identifiers_are_rejected() {
    let huge = oversized();
    let hostile = [
        ControlMessage::SubscribeStream {
            subscription: TrackSubscription {
                stream_id: StreamId::new(huge.clone()),
                track_id: TrackId::new("t"),
                requested_layer: None,
                active_layer: None,
                viewport: None,
            },
        },
        ControlMessage::UnsubscribeStream {
            stream_id: StreamId::new("s"),
            track_id: TrackId::new(huge.clone()),
        },
        ControlMessage::TrackPublish {
            track: PublishedTrack {
                stream_id: StreamId::new(huge.clone()),
                track_id: TrackId::new("t"),
                publisher_user_id: 1,
                kind: TrackKind::Video,
                codec: Some(VideoCodec::Vp9),
                layers: vec![PublishedLayer {
                    layer_id: 0,
                    ssrc: 1,
                    width: Some(320),
                    height: Some(180),
                    max_bitrate_kbps: Some(300),
                    active: true,
                }],
            },
        },
        ControlMessage::TrackLayers {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            layers: Vec::new(),
        },
        ControlMessage::RequestKeyframe {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            layer_id: None,
        },
        ControlMessage::RequestStreamKey {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            recipient_user_id: 2,
        },
        ControlMessage::StreamKeyDeliver {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            sender_user_id: 1,
            epoch: 0,
            ciphertext: Vec::new(),
        },
        ControlMessage::SubscriptionAck {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            layer_id: None,
            active: true,
        },
        ControlMessage::SessionLeave {
            room_id: huge.clone(),
            session_id: "s".to_string(),
        },
        ControlMessage::SessionState {
            participants: vec![SessionParticipant {
                user_id: 1,
                session_id: huge.clone(),
                video_capabilities: Vec::new(),
            }],
        },
        ControlMessage::SessionParticipantJoin {
            participant: SessionParticipant {
                user_id: 1,
                session_id: huge.clone(),
                video_capabilities: Vec::new(),
            },
        },
    ];

    for message in hostile {
        assert!(
            !message.identifiers_within_limits(),
            "an over-long identifier must be refused: {message:?}"
        );
    }
}

#[test]
fn legitimate_control_identifiers_are_accepted() {
    // The cap must not clip anything a real client sends, up to and including an
    // identifier exactly at the limit.
    let at_limit = "a".repeat(MAX_IDENTIFIER_LEN);
    for id in [
        "screen",
        "camera-1",
        "1234567890123456789",
        at_limit.as_str(),
    ] {
        let message = ControlMessage::SubscribeStream {
            subscription: TrackSubscription {
                stream_id: StreamId::new(id),
                track_id: TrackId::new(id),
                requested_layer: Some(2),
                active_layer: None,
                viewport: None,
            },
        };
        assert!(
            message.identifiers_within_limits(),
            "a {}-byte identifier is legitimate and must be accepted",
            id.len()
        );
    }

    // Messages that carry no room-state identifier are unaffected.
    for message in [
        ControlMessage::Ping,
        ControlMessage::Pong,
        ControlMessage::BandwidthFeedback {
            available_kbps: 2500,
        },
        ControlMessage::Auth {
            token: "j".repeat(2048),
        },
    ] {
        assert!(message.identifiers_within_limits());
    }
}

// ── H7: pre-auth QUIC connection state is bounded, globally and per IP ──────

fn ip(last: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(203, 0, 113, last))
}

#[test]
fn pre_auth_admission_enforces_the_per_ip_ceiling() {
    let admission = Arc::new(PreAuthAdmission::new());
    let attacker = ip(9);

    let mut held = Vec::new();
    for _ in 0..MAX_PENDING_CONNECTIONS_PER_IP {
        held.push(
            admission
                .try_admit(attacker)
                .expect("slots up to the per-IP ceiling are admitted"),
        );
    }
    assert_eq!(
        admission.try_admit(attacker).err(),
        Some(AdmissionRefusal::PerIpLimit)
    );

    // One host at its ceiling must never starve everyone else — this is what
    // keeps the per-IP bound from being a denial of service in itself.
    let other = admission
        .try_admit(ip(10))
        .expect("a different source IP is still admitted");
    drop(other);

    // Releasing a slot re-opens capacity for that IP immediately.
    held.pop();
    assert!(admission.try_admit(attacker).is_ok());
}

#[test]
fn pre_auth_admission_enforces_the_global_ceiling() {
    // Small explicit limits: the real ceilings are asserted separately, and this
    // must not actually allocate at attack scale.
    let admission = Arc::new(PreAuthAdmission::with_limits(4, 4));
    let mut held = Vec::new();
    for index in 0..4u8 {
        held.push(admission.try_admit(ip(index)).expect("under the ceiling"));
    }
    assert_eq!(admission.pending(), 4);
    assert_eq!(
        admission.try_admit(ip(99)).err(),
        Some(AdmissionRefusal::GlobalLimit),
        "a distinct source IP must not slip past the global ceiling"
    );

    held.clear();
    assert_eq!(admission.pending(), 0);
    assert!(admission.try_admit(ip(99)).is_ok());
}

#[test]
fn pre_auth_slots_are_released_when_the_guard_drops() {
    // A slot is held only until the connection authenticates. If it were leaked
    // the ceiling would degrade into a permanent lockout after enough churn —
    // worse than the unbounded state it replaced.
    let admission = Arc::new(PreAuthAdmission::new());
    for _ in 0..(MAX_PENDING_CONNECTIONS * 8) {
        let permit = admission.try_admit(ip(1)).expect("slot is reusable");
        drop(permit);
    }
    assert_eq!(admission.pending(), 0);
    assert_eq!(
        admission.tracked_ips(),
        0,
        "the per-IP map must not retain departed peers"
    );
}

#[test]
fn pre_auth_ceiling_clears_a_full_room_reconnecting_at_once() {
    // The worst legitimate burst is every member of a full 50-participant room
    // reconnecting simultaneously (server restart, network blip). Each holds a
    // slot for about one round trip, so the ceiling must clear 50 outright.
    const FULL_ROOM: usize = 50;
    // The global ceiling must clear a full room's simultaneous rejoin.
    const { assert!(MAX_PENDING_CONNECTIONS >= FULL_ROOM) };

    let admission = Arc::new(PreAuthAdmission::new());
    let mut held = Vec::new();
    for index in 0..FULL_ROOM {
        // Distinct clients on distinct addresses, as a real room is.
        let addr = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, index as u16));
        held.push(
            admission
                .try_admit(addr)
                .expect("a full room's simultaneous rejoin must be admitted"),
        );
    }
    assert_eq!(admission.pending(), FULL_ROOM);
}
