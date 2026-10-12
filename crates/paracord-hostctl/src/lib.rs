//! "Paracord on this computer": the desktop app's control over the server it
//! hosts (docs/setup-spec.md §2.2–§2.6, §2.8–§2.10).
//!
//! - [`service`]: the background service per OS — a systemd user unit, a
//!   per-user Scheduled Task, a LaunchAgent — with install / start / stop /
//!   enable / disable / remove / status.
//! - [`preflight`]: can this computer host (user services, keychain, an
//!   existing server, a free port, disk space)?
//! - [`host::Host`]: setup rows 1, 2, 4 and 5 with progress events, the claim
//!   and escrow calls of row 3, supervision at launch, the update procedure
//!   with `.previous` and the pre-update backup, restore, and Settings actions.
//!
//! The library never installs anything by itself; the only callers are the
//! Tauri commands in `client/src-tauri/src/host.rs` and the live integration
//! test (`tests/live_service.rs`, run only with `PARACORD_HOSTCTL_LIVE=1`).

pub mod config;
pub mod control;
pub mod firewall;
pub mod fsutil;
pub mod host;
pub mod keychain;
pub mod layout;
pub mod logs;
pub mod preflight;
pub mod runner;
pub mod service;
pub mod sidecar;
pub mod state;

pub use host::{bundled_sidecar, Host, HostInfo, HostLaunch, HostParts, Timing, UpdateOutcome};
pub use layout::HostLayout;
pub use service::{ServiceNames, ServiceSpec, ServiceState, ServiceStatus};
pub use state::HostState;
