//! The congestion controller every media connection runs (stream-fix V5).
//!
//! Every native video frame rides a reliable QUIC stream, so how fast a frame
//! may go is the congestion controller's call, and media needs one that reads
//! the path's bandwidth, not its random loss:
//!
//! - **Cubic** (quinn's default) halves its window on loss. At 1% random loss
//!   and a 30 ms round trip it held a connection near 8 Mb/s whatever the path
//!   carried; a 44 Mb/s share stalled at 4 frames a second, and every viewer
//!   was stepped down a layer it had the bandwidth for.
//! - **BBR** as quinn ships it (`BbrConfig`, a port of quiche's BBRv1) paces at
//!   the delivery rate it measures, but on any loss it also enters "packet
//!   conservation": its window becomes what is in flight, and it leaves only
//!   after a round trip without a loss. Random loss on both directions of a
//!   media connection keeps it there for good, and a media sender is
//!   app-limited (it has little in flight between frames), so the window
//!   shrank to ~3.5 Mb/s and a keyframe could not get through for seconds.
//!
//! [`MediaCongestion`] is quinn's BBR with loss events withheld from it: BBR's
//! model (bottleneck bandwidth from the delivery rate, round-trip floor,
//! window = gain × bandwidth-delay product, pacing at the measured bandwidth)
//! without the conservation window. A real bottleneck still caps it: past
//! the path's rate the measured delivery rate stops rising, and the window
//! bounds what is queued. Lost packets are still detected and retransmitted
//! by the connection; only the controller's reaction to them is removed.
use std::any::Any;
use std::sync::Arc;
use std::time::Instant;

use quinn::congestion::{BbrConfig, Controller, ControllerFactory, ControllerMetrics};

/// Builds a [`MediaController`] per connection.
#[derive(Debug, Default)]
pub struct MediaCongestion {
    bbr: Arc<BbrConfig>,
}

impl ControllerFactory for MediaCongestion {
    fn build(self: Arc<Self>, now: Instant, current_mtu: u16) -> Box<dyn Controller> {
        Box::new(MediaController {
            bbr: Arc::clone(&self.bbr).build(now, current_mtu),
        })
    }
}

/// quinn's BBR, told about acknowledgements but not about losses.
struct MediaController {
    bbr: Box<dyn Controller>,
}

impl Controller for MediaController {
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
        largest_packet_num_acked: Option<u64>,
    ) {
        self.bbr
            .on_end_acks(now, in_flight, app_limited, largest_packet_num_acked);
    }

    fn on_congestion_event(
        &mut self,
        _now: Instant,
        _sent: Instant,
        _is_persistent_congestion: bool,
        _lost_bytes: u64,
    ) {
        // Withheld: see the module docs. (quinn's BBR reads nothing from this
        // event but the lost bytes, which only feed its conservation window.)
    }

    fn on_mtu_update(&mut self, new_mtu: u16) {
        self.bbr.on_mtu_update(new_mtu);
    }

    fn window(&self) -> u64 {
        self.bbr.window()
    }

    fn metrics(&self) -> ControllerMetrics {
        self.bbr.metrics()
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(MediaController {
            bbr: self.bbr.clone_box(),
        })
    }

    fn initial_window(&self) -> u64 {
        self.bbr.initial_window()
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn losses_do_not_shrink_the_window() {
        let now = Instant::now();
        let mut controller = Arc::new(MediaCongestion::default()).build(now, 1200);
        let before = controller.window();
        for _ in 0..50 {
            controller.on_congestion_event(now, now, false, 12_000);
        }
        assert_eq!(controller.window(), before);
        assert_eq!(controller.initial_window(), before);
    }
}
