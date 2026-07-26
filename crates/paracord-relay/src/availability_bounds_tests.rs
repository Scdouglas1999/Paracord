//! Availability regression tests for the relay's resource bounds.
//!
//! Every case here is a *bound*, not a behaviour: one media peer — authenticated
//! but hostile — must not be able to convert a trickle of ingress into unbounded
//! server memory or allocation. Each test drives the same primitive an attacker
//! would (a wire field the peer chooses freely) and asserts the ceiling holds,
//! then asserts a legitimate 50-participant call still fits comfortably inside
//! it. None of them allocates at attack scale; the point is the invariant.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::mpsc;

use paracord_transport::control::{ControlMessage, TrackKind};
use paracord_transport::protocol::{MediaHeader, TrackType, MAX_IDENTIFIER_LEN};
use paracord_transport::stream::{
    PublishedLayer, PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodec,
};

use crate::bandwidth::{BandwidthEstimator, MAX_TRACKED_SSRCS_PER_PUBLISHER};
use crate::participant::MediaParticipant;
use crate::relay::{
    accept_control_frame, BridgedKeyframeStreams, ConnectionHandle, RelayForwarder,
    MAX_BRIDGED_KEYFRAME_SSRCS, MAX_CACHED_SSRCS_PER_SENDER,
};
use crate::room::{MediaRoomManager, GET_ROOM_CLONES};
use crate::speaker::SpeakerDetector;

/// A realistic full room: 50 participants, all mutually subscribed.
const FULL_ROOM_PARTICIPANTS: i64 = 50;

/// SSRCs a real publisher has live at once: microphone plus a three-rung
/// simulcast ladder for camera and another for screen share.
const REALISTIC_LIVE_SSRCS: usize = 7;

fn audio_header(ssrc: u32) -> MediaHeader {
    MediaHeader {
        version: 1,
        track_type: TrackType::Audio,
        simulcast_layer: 0,
        sequence: 1,
        timestamp: 123,
        ssrc,
        audio_level: 100,
        key_epoch: 1,
        payload_length: 0,
        codec: 0,
    }
}

fn bridged_handle(user_id: i64, room_id: &str) -> ConnectionHandle {
    let (tx, _out_rx) = mpsc::channel::<Bytes>(8);
    let (_in_tx, rx) = mpsc::channel::<Bytes>(8);
    ConnectionHandle::new_bridged(user_id, room_id.to_string(), tx, rx, None)
}

fn simulcast_track(publisher: i64, stream: &str, track: &str) -> PublishedTrack {
    PublishedTrack {
        stream_id: StreamId::new(stream),
        track_id: TrackId::new(track),
        publisher_user_id: publisher,
        kind: TrackKind::Video,
        codec: Some(VideoCodec::Vp9),
        layers: vec![
            PublishedLayer {
                layer_id: 0,
                ssrc: 900,
                width: Some(320),
                height: Some(180),
                max_bitrate_kbps: Some(300),
                active: false,
            },
            PublishedLayer {
                layer_id: 1,
                ssrc: 901,
                width: Some(640),
                height: Some(360),
                max_bitrate_kbps: Some(1200),
                active: false,
            },
            PublishedLayer {
                layer_id: 2,
                ssrc: 902,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(3000),
                active: true,
            },
        ],
    }
}

/// Build a 50-participant room with everyone subscribed to everyone, plus a
/// registered relay connection per participant.
fn full_room() -> (Arc<MediaRoomManager>, Arc<RelayForwarder>, String) {
    let mgr = MediaRoomManager::new();
    for uid in 1..=FULL_ROOM_PARTICIPANTS {
        let mut participant = MediaParticipant::new(uid, format!("sess-{uid}"));
        for other in 1..=FULL_ROOM_PARTICIPANTS {
            if other != uid {
                participant.subscribe(other);
            }
        }
        mgr.join_room(1, 100, participant).unwrap();
    }
    let room_id = mgr.get_or_create_room(1, 100);
    let mgr = Arc::new(mgr);
    let forwarder = Arc::new(RelayForwarder::new(
        Arc::clone(&mgr),
        Arc::new(SpeakerDetector::new()),
    ));
    for uid in 1..=FULL_ROOM_PARTICIPANTS {
        forwarder.add_connection(bridged_handle(uid, &room_id));
    }
    (mgr, forwarder, room_id)
}

// ── H5: the fan-out plan cache is keyed by an attacker-chosen SSRC ──────────

#[test]
fn recipient_cache_is_bounded_per_sender_under_ssrc_rotation() {
    let (_mgr, forwarder, room_id) = full_room();

    // `header.ssrc` is a raw 32-bit wire field. A sender rotating it on every
    // datagram used to insert one fan-out plan (up to 50 connection handles)
    // per packet, evicted only when that sender disconnected.
    for ssrc in 0..(MAX_CACHED_SSRCS_PER_SENDER as u32 * 20) {
        let _ = forwarder.recipient_snapshot(1, &room_id, &audio_header(ssrc));
    }

    assert!(
        forwarder.cached_plan_count(1) <= MAX_CACHED_SSRCS_PER_SENDER,
        "rotating ssrc must not grow the cache past {MAX_CACHED_SSRCS_PER_SENDER}, got {}",
        forwarder.cached_plan_count(1)
    );

    // The bound is per sender, so one hostile publisher never evicts another's
    // plans (which would turn every other call's hot path into a rebuild).
    for ssrc in 0..(MAX_CACHED_SSRCS_PER_SENDER as u32 * 20) {
        let _ = forwarder.recipient_snapshot(2, &room_id, &audio_header(ssrc));
    }
    assert!(forwarder.cached_plan_count(1) <= MAX_CACHED_SSRCS_PER_SENDER);
    assert!(forwarder.cached_plan_count(2) <= MAX_CACHED_SSRCS_PER_SENDER);
}

#[test]
fn recipient_cache_still_serves_a_realistic_publisher_from_cache() {
    // The bound must not cost a legitimate publisher its cache: microphone plus
    // two three-rung simulcast ladders is well inside it, so every packet after
    // the first per ssrc is still a cache hit (no room rebuild).
    const { assert!(REALISTIC_LIVE_SSRCS < MAX_CACHED_SSRCS_PER_SENDER) };
    let (_mgr, forwarder, room_id) = full_room();

    let live: Vec<u32> = (0..REALISTIC_LIVE_SSRCS as u32).collect();
    let first: Vec<_> = live
        .iter()
        .map(|ssrc| forwarder.recipient_snapshot(1, &room_id, &audio_header(*ssrc)))
        .collect();
    // Many packets per ssrc, interleaved exactly as a real publisher sends them.
    for _ in 0..64 {
        for (index, ssrc) in live.iter().enumerate() {
            let again = forwarder.recipient_snapshot(1, &room_id, &audio_header(*ssrc));
            assert!(
                Arc::ptr_eq(&first[index], &again),
                "a realistic publisher's ssrc set must stay cached, not thrash"
            );
            assert_eq!(again.recipients.len(), FULL_ROOM_PARTICIPANTS as usize - 1);
        }
    }
    assert_eq!(forwarder.cached_plan_count(1), REALISTIC_LIVE_SSRCS);
}

#[test]
fn ingress_loss_estimator_is_bounded_per_publisher_under_ssrc_rotation() {
    let estimator = BandwidthEstimator::new();
    let now = Instant::now();
    for ssrc in 0..(MAX_TRACKED_SSRCS_PER_PUBLISHER as u32 * 20) {
        estimator.record_ingress_at(7, ssrc, 1, 1200, now);
    }
    assert!(
        estimator.tracked_ssrc_count(7) <= MAX_TRACKED_SSRCS_PER_PUBLISHER,
        "per-SSRC sequence state must stay bounded, got {}",
        estimator.tracked_ssrc_count(7)
    );
}

#[test]
fn ingress_loss_estimator_still_tracks_a_realistic_publisher_exactly() {
    // The bound must not perturb a real ladder's loss estimate: seven live
    // SSRCs stay resident, so a genuine gap is still scored as loss.
    let estimator = BandwidthEstimator::new();
    let now = Instant::now();
    for ssrc in 0..REALISTIC_LIVE_SSRCS as u32 {
        estimator.record_ingress_at(7, ssrc, 1, 1200, now);
        // seq 2 skipped => exactly one lost packet per ssrc.
        estimator.record_ingress_at(7, ssrc, 3, 1200, now);
    }
    assert_eq!(estimator.tracked_ssrc_count(7), REALISTIC_LIVE_SSRCS);
    assert!(
        estimator.windowed_ingress_loss_at(7, now) > 0.0,
        "a real sequence gap must still register as loss"
    );
}

#[test]
fn relay_forgets_a_departed_senders_cached_plans() {
    let (_mgr, forwarder, room_id) = full_room();
    for ssrc in 0..8u32 {
        let _ = forwarder.recipient_snapshot(1, &room_id, &audio_header(ssrc));
    }
    assert_eq!(forwarder.cached_plan_count(1), 8);
    forwarder.remove_connection(1);
    assert_eq!(forwarder.cached_plan_count(1), 0);
}

// ── H6: control-plane identifiers are capped, and never deep-clone the room ──

fn frame(message: &ControlMessage) -> Vec<u8> {
    serde_json::to_vec(message).unwrap()
}

#[test]
fn control_plane_rejects_over_long_identifiers() {
    // The binary frame path length-prefixes ids with a u8 and refuses anything
    // over MAX_IDENTIFIER_LEN. The JSON control plane bounded them only by the
    // 256 KiB frame cap, so ~120 KB ids fit — and are retained as room-state
    // HashMap keys and re-broadcast to every participant.
    let huge = "x".repeat(120 * 1024);
    let hostile = ControlMessage::SubscribeStream {
        subscription: TrackSubscription {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            requested_layer: None,
            active_layer: None,
            viewport: None,
        },
    };
    let body = frame(&hostile);
    assert!(
        body.len() < 256 * 1024,
        "the attack fits inside the frame cap, which is why the cap is not enough"
    );
    assert!(
        accept_control_frame(1, "1:100", &body).is_none(),
        "an over-long stream_id must be refused before it reaches room state"
    );

    // Every id-bearing variant is covered, not just the subscribe path.
    for message in [
        ControlMessage::ReceiverReport {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            active_layer: None,
            viewport: None,
            estimated_bitrate_kbps: 1,
            packet_loss_ppm: 0,
        },
        ControlMessage::TrackUnpublish {
            stream_id: StreamId::new("s"),
            track_id: TrackId::new(huge.clone()),
        },
        ControlMessage::StreamKeyAnnounce {
            stream_id: StreamId::new(huge.clone()),
            track_id: TrackId::new("t"),
            codec: None,
            epoch: 0,
            encrypted_keys: Vec::new(),
        },
        ControlMessage::SessionJoin {
            room_id: huge.clone(),
            session_id: "s".to_string(),
            video_capabilities: Vec::new(),
        },
    ] {
        assert!(
            accept_control_frame(1, "1:100", &frame(&message)).is_none(),
            "over-long identifier must be refused: {message:?}"
        );
    }
}

#[test]
fn control_plane_accepts_identifiers_a_real_client_sends() {
    // Real ids are short (a snowflake-ish stream id and a track name); the cap
    // must not clip anything a legitimate client sends, including one exactly
    // at the limit.
    for id in ["screen", "camera", &"a".repeat(MAX_IDENTIFIER_LEN)] {
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
            accept_control_frame(1, "1:100", &frame(&message)).is_some(),
            "a legitimate identifier of {} bytes must be accepted",
            id.len()
        );
    }
}

#[tokio::test]
async fn control_messages_never_deep_clone_the_room() {
    // `get_room` clones every participant, published track, subscription and
    // stored key ciphertext. A ReceiverReport used to trigger two of those, so
    // ~10 KB/s of control ingress became gigabytes per second of allocation in
    // a busy room. The control path must read the room in place instead.
    let (mgr, forwarder, room_id) = full_room();
    let track = simulcast_track(1, "stream-1", "screen");
    mgr.publish_track(&room_id, 1, track.clone()).unwrap();
    for viewer in 2..=FULL_ROOM_PARTICIPANTS {
        mgr.subscribe_track(
            &room_id,
            viewer,
            TrackSubscription {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
                requested_layer: None,
                active_layer: None,
                viewport: None,
            },
        )
        .unwrap();
    }
    // A sampled downlink is what lets relay-driven layer selection run at all;
    // without it the expensive branch is skipped and the test proves nothing.
    forwarder.record_downlink_sample_for_test(2, 12_500, Duration::from_millis(20), Instant::now());

    GET_ROOM_CLONES.store(0, Ordering::Relaxed);
    for _ in 0..32 {
        forwarder
            .handle_control_message(
                2,
                &room_id,
                ControlMessage::ReceiverReport {
                    stream_id: track.stream_id.clone(),
                    track_id: track.track_id.clone(),
                    active_layer: Some(2),
                    viewport: None,
                    estimated_bitrate_kbps: 5_000,
                    packet_loss_ppm: 0,
                },
            )
            .await;
    }
    assert_eq!(
        GET_ROOM_CLONES.load(Ordering::Relaxed),
        0,
        "ReceiverReport must not deep-clone the room"
    );

    // The other peer-reachable control paths are held to the same rule.
    GET_ROOM_CLONES.store(0, Ordering::Relaxed);
    forwarder
        .broadcast_control_in_room(&room_id, Some(1), &ControlMessage::Ping)
        .await;
    forwarder.run_layer_selection(2, &room_id).await;
    forwarder
        .handle_control_message(
            3,
            &room_id,
            ControlMessage::SubscribeStream {
                subscription: TrackSubscription {
                    stream_id: track.stream_id.clone(),
                    track_id: track.track_id.clone(),
                    requested_layer: Some(1),
                    active_layer: None,
                    viewport: None,
                },
            },
        )
        .await;
    forwarder
        .handle_control_message(
            1,
            &room_id,
            ControlMessage::TrackLayers {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
                layers: track.layers.clone(),
            },
        )
        .await;
    forwarder
        .send_initial_track_state(&bridged_handle(4, &room_id))
        .await;
    assert_eq!(
        GET_ROOM_CLONES.load(Ordering::Relaxed),
        0,
        "no peer-reachable control path may deep-clone the room"
    );
}

#[tokio::test]
async fn subscribe_stream_still_registers_a_subscription_after_the_borrow_refactor() {
    // Guard the functional side of the no-clone refactor: the control paths must
    // still see and mutate live room state.
    let (mgr, forwarder, room_id) = full_room();
    let track = simulcast_track(1, "stream-1", "screen");
    mgr.publish_track(&room_id, 1, track.clone()).unwrap();
    forwarder
        .handle_control_message(
            2,
            &room_id,
            ControlMessage::SubscribeStream {
                subscription: TrackSubscription {
                    stream_id: track.stream_id.clone(),
                    track_id: track.track_id.clone(),
                    requested_layer: Some(1),
                    active_layer: None,
                    viewport: None,
                },
            },
        )
        .await;
    let registered = mgr
        .with_room(&room_id, |room| {
            room.participants
                .get(&2)
                .map(|p| p.track_subscriptions.len())
                .unwrap_or(0)
        })
        .unwrap();
    assert_eq!(registered, 1, "the subscription must reach room state");
}

// ── M1: a superseded media connection must not stay alive ───────────────────

/// Establish a raw QUIC loopback pair, returning `(server_conn, client_conn)`.
/// Two loopback sockets, one connection — the point is observable close state,
/// not scale.
async fn quinn_pair() -> (quinn::Connection, quinn::Connection) {
    use paracord_transport::endpoint::{
        certificate_hash, generate_self_signed_cert, MediaEndpoint,
    };
    let tls = generate_self_signed_cert().unwrap();
    let cert_hash = certificate_hash(&tls.cert_chain[0]);
    let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
    let server_addr = server.local_addr().unwrap();
    let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    let client_connecting = client
        .connect_pinned(server_addr, "localhost", &cert_hash)
        .unwrap();
    let server_incoming = server.accept().await.expect("server should accept");
    let server_conn = server_incoming.accept().unwrap().await.unwrap();
    let client_conn = client_connecting.await.unwrap();
    std::mem::forget(server);
    std::mem::forget(client);
    (server_conn, client_conn)
}

#[tokio::test]
async fn replacing_a_users_connection_closes_the_displaced_one() {
    // The connections map is keyed by user id, so a reconnect displaces the old
    // handle. Left open, that connection kept its QUIC state, its datagram
    // receive buffer and its forwarding/control/bandwidth tasks running —
    // unreachable but fully allocated — so one authenticated user could pin an
    // unbounded number of them by reconnecting in a loop.
    let (first_conn, _first_client) = quinn_pair().await;
    let (second_conn, _second_client) = quinn_pair().await;
    let (_mgr, forwarder, room_id) = full_room();

    let first = ConnectionHandle::new(1, room_id.clone(), first_conn);
    forwarder.add_connection(first.clone());
    assert!(first.is_alive());

    forwarder.add_connection(ConnectionHandle::new(1, room_id.clone(), second_conn));
    assert!(
        !first.is_alive(),
        "a superseded connection must be closed, not merely unrouted"
    );
    assert_eq!(
        forwarder.connection_count(),
        FULL_ROOM_PARTICIPANTS as usize,
        "the map still holds exactly one connection per user"
    );
}

// ── M2: bridged keyframe stream bookkeeping is keyed by a wire field ────────

#[tokio::test]
async fn bridged_keyframe_stream_map_is_bounded_by_ssrc() {
    let mut streams = BridgedKeyframeStreams::default();
    // Each entry also owns up to MAX_BRIDGED_KEYFRAME_STREAMS spawned tasks, so
    // an unbounded map is unbounded tasks as well as unbounded memory.
    for ssrc in 0..(MAX_BRIDGED_KEYFRAME_SSRCS as u32 * 20) {
        let task = tokio::spawn(async { std::future::pending::<()>().await });
        streams.track(ssrc, task.abort_handle(), MAX_BRIDGED_KEYFRAME_SSRCS);
    }
    assert!(
        streams.per_ssrc.len() <= MAX_BRIDGED_KEYFRAME_SSRCS,
        "publisher-chosen ssrc must not grow the viewer's keyframe map, got {}",
        streams.per_ssrc.len()
    );

    // A realistic viewer (a handful of tracks × layers) keeps every entry.
    let mut realistic = BridgedKeyframeStreams::default();
    for ssrc in 0..REALISTIC_LIVE_SSRCS as u32 {
        let task = tokio::spawn(async { std::future::pending::<()>().await });
        realistic.track(ssrc, task.abort_handle(), MAX_BRIDGED_KEYFRAME_SSRCS);
    }
    assert_eq!(realistic.per_ssrc.len(), REALISTIC_LIVE_SSRCS);
}
