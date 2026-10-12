//! `host_preflight` (spec §2.3): can this computer host?

use std::path::Path;
use std::sync::Arc;

use paracord_contracts::host::{HostPreflight, HostPreflightReason};

use crate::runner::{CommandRunner, Invocation};
use crate::state::HostState;

/// The port every invite uses unless it is taken.
pub const DEFAULT_PORT: u16 = 8443;
/// The last port tried (8443..=8463).
pub const LAST_PORT: u16 = 8463;
/// Hosting needs at least this much free space under the host root.
pub const MIN_FREE_BYTES: u64 = 1 << 30;

/// The checks, separated from the machine so the decision table is testable.
pub trait PreflightProbes {
    /// Linux: a systemd user manager answers. Other platforms: `Ok`.
    fn user_services(&self) -> Result<(), String>;
    /// The OS keychain completes a write/read/delete roundtrip.
    fn keychain(&self) -> Result<(), String>;
    /// A Paracord server answers `/health` on `127.0.0.1:<port>`.
    fn existing_server(&self, port: u16) -> bool;
    /// TCP and UDP `0.0.0.0:<port>` are both bindable.
    fn port_free(&self, port: u16) -> bool;
    fn free_bytes(&self, path: &Path) -> std::io::Result<u64>;
}

fn refuse(reason: HostPreflightReason, detail: impl Into<String>) -> HostPreflight {
    HostPreflight {
        ok: false,
        port: None,
        reason: Some(reason),
        detail: Some(detail.into()),
        existing_url: None,
    }
}

/// Run the checks in the spec's order. `already_hosting` is checked before
/// the existing-server probe, because the server this app hosts answers
/// `/health` on its own port too.
pub fn run(probes: &dyn PreflightProbes, state: &HostState, root: &Path) -> HostPreflight {
    if let Err(detail) = probes.user_services() {
        return refuse(HostPreflightReason::NoUserServices, detail);
    }
    if let Err(detail) = probes.keychain() {
        return refuse(HostPreflightReason::NoKeychain, detail);
    }
    if state.enabled {
        return HostPreflight {
            ok: true,
            port: state.port,
            reason: Some(HostPreflightReason::AlreadyHosting),
            detail: None,
            existing_url: None,
        };
    }
    if probes.existing_server(DEFAULT_PORT) {
        return HostPreflight {
            ok: false,
            port: None,
            reason: Some(HostPreflightReason::ExistingServer),
            detail: Some(format!(
                "a Paracord server answers on 127.0.0.1:{DEFAULT_PORT}"
            )),
            existing_url: Some(format!("https://127.0.0.1:{DEFAULT_PORT}")),
        };
    }
    let Some(port) = (DEFAULT_PORT..=LAST_PORT).find(|p| probes.port_free(*p)) else {
        return refuse(
            HostPreflightReason::NoPort,
            format!("ports {DEFAULT_PORT} to {LAST_PORT} are all in use (TCP or UDP)"),
        );
    };
    match probes.free_bytes(root) {
        Ok(free) if free >= MIN_FREE_BYTES => {}
        Ok(free) => {
            return refuse(
                HostPreflightReason::NoSpace,
                format!("{} MB free under {}", free / (1 << 20), root.display()),
            )
        }
        Err(e) => {
            return refuse(
                HostPreflightReason::NoSpace,
                format!(
                    "couldn't read the free space under {} ({e})",
                    root.display()
                ),
            )
        }
    }
    HostPreflight {
        ok: true,
        port: Some(port),
        reason: None,
        detail: None,
        existing_url: None,
    }
}

/// Is `port` bindable for TCP and UDP on all interfaces right now?
pub fn port_bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
        && std::net::UdpSocket::bind(("0.0.0.0", port)).is_ok()
}

/// The real machine.
pub struct SystemProbes {
    pub runner: Arc<dyn CommandRunner>,
}

impl PreflightProbes for SystemProbes {
    fn user_services(&self) -> Result<(), String> {
        if !cfg!(target_os = "linux") {
            return Ok(());
        }
        match self.runner.run(&Invocation::new(
            "systemctl",
            ["--user", "show-environment"],
        )) {
            Ok(output) if output.success() => Ok(()),
            Ok(output) => Err(output.describe_failure("systemctl --user")),
            Err(e) => Err(e.to_string()),
        }
    }

    fn keychain(&self) -> Result<(), String> {
        crate::keychain::probe(crate::keychain::KEYCHAIN_SERVICE)
    }

    fn existing_server(&self, port: u16) -> bool {
        crate::control::existing_server_answers(port)
    }

    fn port_free(&self, port: u16) -> bool {
        port_bindable(port)
    }

    fn free_bytes(&self, path: &Path) -> std::io::Result<u64> {
        crate::fsutil::free_space(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        user_services: Result<(), String>,
        keychain: Result<(), String>,
        existing: bool,
        taken: Vec<u16>,
        free: u64,
        asked_ports: RefCell<Vec<u16>>,
    }

    impl Default for Fake {
        fn default() -> Self {
            Self {
                user_services: Ok(()),
                keychain: Ok(()),
                existing: false,
                taken: vec![],
                free: 50 << 30,
                asked_ports: RefCell::default(),
            }
        }
    }

    impl PreflightProbes for Fake {
        fn user_services(&self) -> Result<(), String> {
            self.user_services.clone()
        }
        fn keychain(&self) -> Result<(), String> {
            self.keychain.clone()
        }
        fn existing_server(&self, _: u16) -> bool {
            self.existing
        }
        fn port_free(&self, port: u16) -> bool {
            self.asked_ports.borrow_mut().push(port);
            !self.taken.contains(&port)
        }
        fn free_bytes(&self, _: &Path) -> std::io::Result<u64> {
            Ok(self.free)
        }
    }

    fn run_with(fake: &Fake, state: &HostState) -> HostPreflight {
        run(fake, state, Path::new("/h"))
    }

    #[test]
    fn a_ready_computer_gets_8443() {
        let result = run_with(&Fake::default(), &HostState::default());
        assert_eq!(
            result,
            HostPreflight {
                ok: true,
                port: Some(8443),
                reason: None,
                detail: None,
                existing_url: None
            }
        );
    }

    #[test]
    fn each_refusal_has_its_reason() {
        let state = HostState::default();
        let r = run_with(
            &Fake {
                user_services: Err("no bus".into()),
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(
            (r.ok, r.reason),
            (false, Some(HostPreflightReason::NoUserServices))
        );
        let r = run_with(
            &Fake {
                keychain: Err("locked".into()),
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(
            (r.ok, r.reason, r.detail.as_deref()),
            (false, Some(HostPreflightReason::NoKeychain), Some("locked"))
        );
        let r = run_with(
            &Fake {
                existing: true,
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(r.reason, Some(HostPreflightReason::ExistingServer));
        assert_eq!(r.existing_url.as_deref(), Some("https://127.0.0.1:8443"));
        let r = run_with(
            &Fake {
                taken: (8443..=8463).collect(),
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(r.reason, Some(HostPreflightReason::NoPort));
        let r = run_with(
            &Fake {
                free: (1 << 30) - 1,
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(r.reason, Some(HostPreflightReason::NoSpace));
    }

    #[test]
    fn a_taken_8443_moves_to_the_next_free_port() {
        let fake = Fake {
            taken: vec![8443, 8444],
            ..Fake::default()
        };
        assert_eq!(run_with(&fake, &HostState::default()).port, Some(8445));
        assert_eq!(*fake.asked_ports.borrow(), [8443, 8444, 8445]);
    }

    #[test]
    fn already_hosting_never_blocks_even_though_our_server_answers() {
        let state = HostState {
            enabled: true,
            port: Some(8450),
            ..HostState::default()
        };
        let r = run_with(
            &Fake {
                existing: true,
                taken: vec![8450],
                ..Fake::default()
            },
            &state,
        );
        assert_eq!(
            r,
            HostPreflight {
                ok: true,
                port: Some(8450),
                reason: Some(HostPreflightReason::AlreadyHosting),
                detail: None,
                existing_url: None
            }
        );
    }
}
