//! Congestion-control lab (stream-fix V6): a media-like QUIC sender and a
//! receiver, run on either side of a shaped link (see `scripts/stream-audit/cc-lab.sh`).
//!
//! ```text
//! cc_lab recv <bind addr>
//! cc_lab send <server addr> <cc> <offered Mb/s> <seconds> [backlog ms]
//! ```
//!
//! The sender sends 60 frames a second at the offered rate (a keyframe four
//! times a delta's size every 2 s), each frame on its own uni stream as the
//! app does, and skips a frame while its oldest unacknowledged frame is older
//! than the backlog limit (the app's sender gate). `<cc>` is `cubic`, `bbr`
//! (quinn's), `blind` (quinn's BBR with loss withheld: the V5 controller) or
//! `media` (`paracord_transport::congestion::MediaCongestion`, what ships).
//! Both sides print one JSON line a second.
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use quinn::congestion::{BbrConfig, Controller, ControllerFactory, ControllerMetrics, CubicConfig};
use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};

const FPS: u64 = 60;
const HEADER: usize = 24;

fn unix_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

fn transport(cc: &str) -> quinn::TransportConfig {
    let mut t = quinn::TransportConfig::default();
    t.max_concurrent_uni_streams(256u32.into());
    t.keep_alive_interval(Some(Duration::from_secs(5)));
    match cc {
        "cubic" => {
            t.congestion_controller_factory(Arc::new(CubicConfig::default()));
        }
        "bbr" => {
            t.congestion_controller_factory(Arc::new(BbrConfig::default()));
        }
        "blind" => {
            t.congestion_controller_factory(Arc::new(LossBlind::default()));
        }
        "media" => {
            let controller = match std::env::var("CC_LAB_QUEUE_MS") {
                Ok(ms) => paracord_transport::congestion::MediaCongestion::with_queue_threshold(
                    Duration::from_millis(ms.parse().expect("CC_LAB_QUEUE_MS")),
                ),
                Err(_) => paracord_transport::congestion::MediaCongestion::default(),
            };
            let controller = match std::env::var("CC_LAB_BETA") {
                Ok(beta) => controller.with_beta(beta.parse().expect("CC_LAB_BETA")),
                Err(_) => controller,
            };
            t.congestion_controller_factory(Arc::new(controller));
        }
        other => panic!("unknown cc {other}"),
    }
    t
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "paracord_transport=debug".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("recv") => recv(args[2].parse()?).await,
        Some("send") => {
            let backlog_ms = args
                .get(6)
                .map(|v| v.parse())
                .transpose()?
                .unwrap_or(500u64);
            send(
                args[2].parse()?,
                &args[3],
                args[4].parse()?,
                args[5].parse()?,
                backlog_ms,
            )
            .await
        }
        _ => {
            eprintln!("usage: cc_lab recv <addr> | send <addr> <cc> <mbps> <secs> [backlog ms]");
            std::process::exit(2)
        }
    }
}

const CERT_PATH: &str = "/tmp/cc_lab_cert.der";

async fn recv(addr: SocketAddr) -> anyhow::Result<()> {
    let cert = paracord_transport::endpoint::generate_media_certificate()?;
    std::fs::write(
        std::env::var("CC_LAB_CERT").unwrap_or_else(|_| CERT_PATH.into()),
        cert.tls.cert_chain[0].as_ref(),
    )?;
    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            cert.tls.cert_chain.clone(),
            cert.tls.private_key.clone_key(),
        )?;
    crypto.alpn_protocols = vec![b"cc-lab".to_vec()];
    let mut config =
        quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(crypto)?));
    config.transport_config(Arc::new(transport("cubic")));
    let endpoint = quinn::Endpoint::server(config, addr)?;
    eprintln!("recv listening on {addr}");
    while let Some(incoming) = endpoint.accept().await {
        let conn = incoming.await?;
        tokio::spawn(serve(conn));
    }
    Ok(())
}

#[derive(Default)]
struct RecvStats {
    frames: u64,
    bytes: u64,
    latencies_us: Vec<u64>,
}

async fn serve(conn: quinn::Connection) {
    let stats = Arc::new(Mutex::new(RecvStats::default()));
    let start = Instant::now();
    {
        let stats = stats.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.tick().await;
            loop {
                tick.tick().await;
                let mut s = std::mem::take(&mut *stats.lock().unwrap());
                s.latencies_us.sort_unstable();
                let pct = |p: f64| {
                    s.latencies_us
                        .get(
                            ((s.latencies_us.len() as f64 * p) as usize)
                                .min(s.latencies_us.len().saturating_sub(1)),
                        )
                        .map(|v| *v as f64 / 1000.0)
                        .unwrap_or(0.0)
                };
                println!(
                    "{{\"side\":\"recv\",\"t\":{:.1},\"frames\":{},\"mbps\":{:.2},\"lat_p50\":{:.1},\"lat_p95\":{:.1},\"lat_max\":{:.1}}}",
                    start.elapsed().as_secs_f64(),
                    s.frames,
                    s.bytes as f64 * 8.0 / 1e6,
                    pct(0.5),
                    pct(0.95),
                    s.latencies_us.last().map(|v| *v as f64 / 1000.0).unwrap_or(0.0),
                );
            }
        });
    }
    while let Ok(mut stream) = conn.accept_uni().await {
        let stats = stats.clone();
        tokio::spawn(async move {
            let Ok(data) = stream.read_to_end(64 << 20).await else {
                return;
            };
            if data.len() < HEADER {
                return;
            }
            let sent_ns = u64::from_le_bytes(data[8..16].try_into().unwrap());
            let latency_us = unix_ns().saturating_sub(sent_ns) / 1000;
            let mut s = stats.lock().unwrap();
            s.frames += 1;
            s.bytes += data.len() as u64;
            s.latencies_us.push(latency_us);
        });
    }
}

#[derive(Default)]
struct SendState {
    /// Send time of each frame not yet acknowledged, by frame id.
    outstanding: VecDeque<(u64, Instant)>,
    acked_frames: u64,
    acked_bytes: u64,
    ack_latencies_us: Vec<u64>,
}

async fn send(
    server: SocketAddr,
    cc: &str,
    mbps: f64,
    seconds: u64,
    backlog_ms: u64,
) -> anyhow::Result<()> {
    let cert = std::fs::read(std::env::var("CC_LAB_CERT").unwrap_or_else(|_| CERT_PATH.into()))?;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(rustls::pki_types::CertificateDer::from(cert))?;
    let mut crypto = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    crypto.alpn_protocols = vec![b"cc-lab".to_vec()];
    let mut config = quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(crypto)?));
    config.transport_config(Arc::new(transport(cc)));
    let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse()?)?;
    endpoint.set_default_client_config(config);
    let conn = endpoint.connect(server, "localhost")?.await?;

    let delta_bytes = (mbps * 1e6 / 8.0 / (FPS as f64 + 3.0 / 2.0)) as usize;
    let state = Arc::new(Mutex::new(SendState::default()));
    let start = Instant::now();
    let mut next = tokio::time::Instant::now();
    let mut frame_id = 0u64;
    let (mut sent_frames, mut skipped, mut sent_bytes) = (0u64, 0u64, 0u64);
    let mut last_report = Instant::now();
    let mut last_stats = conn.stats();
    while start.elapsed() < Duration::from_secs(seconds) {
        next += Duration::from_micros(1_000_000 / FPS);
        tokio::time::sleep_until(next).await;
        frame_id += 1;
        let size = if frame_id % (2 * FPS) == 1 {
            delta_bytes * 4
        } else {
            delta_bytes
        }
        .max(HEADER);
        let backlogged = state
            .lock()
            .unwrap()
            .outstanding
            .front()
            .is_some_and(|(_, at)| at.elapsed() > Duration::from_millis(backlog_ms));
        if backlogged {
            skipped += 1;
        } else {
            sent_frames += 1;
            sent_bytes += size as u64;
            let mut payload = vec![0u8; size];
            payload[0..8].copy_from_slice(&frame_id.to_le_bytes());
            payload[8..16].copy_from_slice(&unix_ns().to_le_bytes());
            let sent_at = Instant::now();
            state
                .lock()
                .unwrap()
                .outstanding
                .push_back((frame_id, sent_at));
            let conn = conn.clone();
            let state = state.clone();
            tokio::spawn(async move {
                let Ok(mut stream) = conn.open_uni().await else {
                    return;
                };
                if stream.write_all(&payload).await.is_err() {
                    return;
                }
                let _ = stream.finish();
                let _ = stream.stopped().await;
                let mut s = state.lock().unwrap();
                s.outstanding.retain(|(id, _)| *id != frame_id);
                s.acked_frames += 1;
                s.acked_bytes += payload.len() as u64;
                s.ack_latencies_us
                    .push(sent_at.elapsed().as_micros() as u64);
            });
        }
        if last_report.elapsed() >= Duration::from_secs(1) {
            let elapsed = last_report.elapsed().as_secs_f64();
            last_report = Instant::now();
            let stats = conn.stats();
            let mut s = state.lock().unwrap();
            let mut lat = std::mem::take(&mut s.ack_latencies_us);
            lat.sort_unstable();
            let p95 = lat
                .get((lat.len() as f64 * 0.95) as usize)
                .map(|v| *v as f64 / 1000.0)
                .unwrap_or(0.0);
            let oldest = s
                .outstanding
                .front()
                .map(|(_, at)| at.elapsed().as_millis())
                .unwrap_or(0);
            println!(
                "{{\"side\":\"send\",\"t\":{:.1},\"cc\":\"{cc}\",\"sent_frames\":{sent_frames},\"skipped\":{skipped},\"offered_mbps\":{:.2},\"acked_mbps\":{:.2},\"ack_p95\":{p95:.1},\"oldest_ms\":{oldest},\"outstanding\":{},\"rtt_ms\":{:.1},\"cwnd\":{},\"lost\":{},\"sent_pkts\":{},\"cong_events\":{}}}",
                start.elapsed().as_secs_f64(),
                sent_bytes as f64 * 8.0 / 1e6 / elapsed,
                s.acked_bytes as f64 * 8.0 / 1e6 / elapsed,
                s.outstanding.len(),
                stats.path.rtt.as_secs_f64() * 1000.0,
                stats.path.cwnd,
                stats.path.lost_packets - last_stats.path.lost_packets,
                stats.path.sent_packets - last_stats.path.sent_packets,
                stats.path.congestion_events - last_stats.path.congestion_events,
            );
            s.acked_bytes = 0;
            s.acked_frames = 0;
            drop(s);
            last_stats = stats;
            sent_frames = 0;
            skipped = 0;
            sent_bytes = 0;
        }
    }
    conn.close(0u32.into(), b"done");
    endpoint.wait_idle().await;
    Ok(())
}

/// The V5 controller, kept here for comparison: quinn's BBR with every loss
/// event withheld.
#[derive(Debug, Default)]
struct LossBlind {
    bbr: Arc<BbrConfig>,
}

impl ControllerFactory for LossBlind {
    fn build(self: Arc<Self>, now: Instant, mtu: u16) -> Box<dyn Controller> {
        Box::new(LossBlindController {
            bbr: Arc::clone(&self.bbr).build(now, mtu),
        })
    }
}

struct LossBlindController {
    bbr: Box<dyn Controller>,
}

impl Controller for LossBlindController {
    fn on_sent(&mut self, now: Instant, bytes: u64, last_packet_number: u64) {
        self.bbr.on_sent(now, bytes, last_packet_number);
    }
    fn on_ack(
        &mut self,
        now: Instant,
        sent: Instant,
        bytes: u64,
        app_limited: bool,
        rtt: &quinn_proto::RttEstimator,
    ) {
        self.bbr.on_ack(now, sent, bytes, app_limited, rtt);
    }
    fn on_end_acks(
        &mut self,
        now: Instant,
        in_flight: u64,
        app_limited: bool,
        largest: Option<u64>,
    ) {
        self.bbr.on_end_acks(now, in_flight, app_limited, largest);
    }
    fn on_congestion_event(&mut self, _: Instant, _: Instant, _: bool, _: u64) {}
    fn on_mtu_update(&mut self, mtu: u16) {
        self.bbr.on_mtu_update(mtu);
    }
    fn window(&self) -> u64 {
        self.bbr.window()
    }
    fn metrics(&self) -> ControllerMetrics {
        self.bbr.metrics()
    }
    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(LossBlindController {
            bbr: self.bbr.clone_box(),
        })
    }
    fn initial_window(&self) -> u64 {
        self.bbr.initial_window()
    }
    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any> {
        self
    }
}
