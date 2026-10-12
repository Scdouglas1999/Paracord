//! "Paracord on this computer": setup orchestration (spec §2.6), supervision
//! and update (§2.8), Settings actions (§2.9) and restore (§4.8), on top of
//! the service managers, the control channel and the host binary.
//!
//! Everything here blocks (process runs, HTTP, polling sleeps); callers run it
//! on a worker thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use paracord_contracts::credential::NewOwnerClaim;
use paracord_contracts::host::{
    BackupNowResponse, HostPreflight, HostProgress, HostProgressState, HostSetupStep, HostStatus,
    KeySource, Reachability, ReachabilityState,
};
use serde::{Deserialize, Serialize};

use crate::config::HostConfig;
use crate::control::{EscrowOutcome, HostApi, LoopbackHost};
use crate::firewall::{self, FirewallOutcome};
use crate::fsutil;
use crate::layout::{self, HostLayout};
use crate::logs;
use crate::preflight::{self, PreflightProbes, SystemProbes, DEFAULT_PORT, LAST_PORT};
use crate::runner::{CommandRunner, SystemRunner};
use crate::service::{
    self, ServiceManager, ServiceNames, ServiceSpec, ServiceState, ServiceStatus,
    EXIT_STORAGE_KEY_UNAVAILABLE,
};
use crate::sidecar;
use crate::state::{steps, HostState, UpdateRecord};

/// Polling budgets (spec §2.6, §2.8). Tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// `/health` poll interval while starting.
    pub health_poll: Duration,
    /// Row 1 `start`: how long the server gets to answer `/health`.
    pub start_timeout: Duration,
    /// After an update.
    pub update_timeout: Duration,
    /// Row 4: status poll interval while the router is being asked.
    pub reach_poll: Duration,
    pub reach_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            health_poll: Duration::from_millis(250),
            start_timeout: Duration::from_secs(30),
            update_timeout: Duration::from_secs(60),
            reach_poll: Duration::from_secs(1),
            reach_timeout: Duration::from_secs(15),
        }
    }
}

/// Builds the control client for a configured server.
pub type ApiFactory = Box<dyn Fn(u16, &HostConfig, &Path) -> Box<dyn HostApi> + Send + Sync>;
/// Deletes a keychain entry (service, account).
pub type KeychainDelete = Box<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

/// Everything outside this crate's logic, injectable for tests.
pub struct HostParts {
    pub layout: HostLayout,
    /// `app_local_data_dir()/host.json`.
    pub state_path: PathBuf,
    /// The binary bundled with the app (`current_exe().parent()/paracord-host`).
    pub sidecar: PathBuf,
    pub names: ServiceNames,
    pub runner: Arc<dyn CommandRunner>,
    pub manager: Box<dyn ServiceManager>,
    pub api: ApiFactory,
    pub keychain_delete: KeychainDelete,
    /// Windows: add the firewall rule during row 1.
    pub manage_firewall: bool,
    pub timing: Timing,
}

pub struct Host {
    parts: HostParts,
}

/// The bundled host binary next to the running app executable.
pub fn bundled_sidecar() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("couldn't find the app's own executable")?;
    let dir = exe
        .parent()
        .context("the app's executable has no directory")?;
    Ok(dir.join(layout::host_binary_name()))
}

/// What `host_info` returns: `host.json` plus the live service state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostInfo {
    pub enabled: bool,
    pub port: Option<u16>,
    pub autostart: bool,
    pub installed_version: Option<String>,
    pub completed_steps: Vec<String>,
    /// `None` when not hosting, or when the service manager couldn't be asked
    /// (`service_error` says why).
    pub service: Option<ServiceStatus>,
    pub service_error: Option<String>,
    /// `https://127.0.0.1:<port>`: the host's own home server entry.
    pub home_url: Option<String>,
    /// Exit 78: why the server couldn't open its storage key (spec §2.8).
    pub storage_key_problem: Option<String>,
    /// An update that didn't come up; the app shows the banner.
    pub update_failure: Option<UpdateRecord>,
    /// A version whose update was undone; not retried automatically.
    pub held_version: Option<String>,
}

/// What `host_on_launch` did about the bundled binary (spec §2.8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateOutcome {
    /// Nothing to do.
    None,
    Updated {
        from: String,
        to: String,
    },
    /// The new binary did not answer `/health`; nothing was reverted.
    Failed {
        from: String,
        to: String,
        detail: String,
    },
    /// The update couldn't begin (no backup, server not running, bundled
    /// binary unreadable). Nothing was changed.
    NotStarted {
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostLaunch {
    pub info: HostInfo,
    pub update: UpdateOutcome,
    /// Set when autostart tried to start the server and it didn't come up.
    pub start_error: Option<String>,
}

/// A step that finished.
struct Done {
    state: HostProgressState,
    detail: Option<String>,
    code: Option<String>,
}

impl Done {
    fn ok() -> Self {
        Self {
            state: HostProgressState::Ok,
            detail: None,
            code: None,
        }
    }
}

/// A step that failed: `code` for the UI's chips, `detail` the spec's words.
#[derive(Debug)]
struct Failure {
    code: &'static str,
    detail: String,
}

fn failure(code: &'static str, detail: impl Into<String>) -> Failure {
    Failure {
        code,
        detail: detail.into(),
    }
}

/// Why waiting for `/health` ended without it.
enum NotUp {
    StorageKey(String),
    Timeout,
}

fn step_name(step: HostSetupStep) -> &'static str {
    match step {
        HostSetupStep::Install => steps::INSTALL,
        HostSetupStep::Init => steps::INIT,
        HostSetupStep::Service => steps::SERVICE,
        HostSetupStep::Start => steps::START,
        HostSetupStep::Storage => steps::STORAGE,
        HostSetupStep::Reach => steps::REACH,
        HostSetupStep::Backup => steps::BACKUP,
    }
}

/// Row 4's line for a reachability answer (spec §5.4), and whether it is ok.
pub fn reach_copy(reach: &Reachability) -> (HostProgressState, String) {
    let ip = reach
        .external_ip
        .as_deref()
        .unwrap_or("your public address");
    match reach.state {
        ReachabilityState::Open => (
            HostProgressState::Ok,
            format!("Your router opened the way. Friends can reach you at {ip}."),
        ),
        ReachabilityState::Direct => (
            HostProgressState::Ok,
            format!(
                "This computer has its own public address ({ip}). Friends can reach it if your firewall allows port {}.",
                reach.port
            ),
        ),
        ReachabilityState::Refused => (
            HostProgressState::Warn,
            "Your router didn't allow it, so for now only people on your home network can join.".into(),
        ),
        ReachabilityState::NoAnswer | ReachabilityState::Asking => (
            HostProgressState::Warn,
            "Your router didn't answer, so for now only people on your home network can join.".into(),
        ),
        ReachabilityState::SharedAddress => (
            HostProgressState::Warn,
            "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join.".into(),
        ),
        ReachabilityState::FirewallBlocked => (
            HostProgressState::Warn,
            "Windows Firewall is blocking friends.".into(),
        ),
        ReachabilityState::Off => (
            HostProgressState::Warn,
            "Paracord isn't asking your router to let friends in.".into(),
        ),
    }
}

fn reach_code(state: ReachabilityState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Row 2 passes only on what the running server reports (spec §2.6).
pub fn storage_ok(status: &HostStatus) -> bool {
    status.storage.sqlite_encrypted
        && status.storage.files_encrypted
        && status.storage.key_source == Some(KeySource::Keychain)
}

impl Host {
    pub fn new(parts: HostParts) -> Self {
        Self { parts }
    }

    /// The real machine: this platform's service manager, the loopback
    /// client, the OS keychain, production names.
    pub fn system(app_local_data_dir: &Path, sidecar: PathBuf) -> Result<Self> {
        Self::system_named(app_local_data_dir, sidecar, ServiceNames::production())
    }

    /// [`Host::system`] with other service names (the live integration test).
    pub fn system_named(
        app_local_data_dir: &Path,
        sidecar: PathBuf,
        names: ServiceNames,
    ) -> Result<Self> {
        let layout = HostLayout::for_app_dir(app_local_data_dir);
        let runner: Arc<dyn CommandRunner> = Arc::new(SystemRunner);
        let manager =
            service::platform_manager(names.clone(), runner.clone(), &layout.config_dir())?;
        Ok(Self::new(HostParts {
            state_path: layout::state_file(app_local_data_dir),
            layout,
            sidecar,
            names,
            runner,
            manager,
            api: Box::new(|port, config, claim_file| {
                Box::new(LoopbackHost::new(
                    port,
                    &config.cert_path,
                    &config.control_token_file,
                    claim_file,
                ))
            }),
            keychain_delete: Box::new(crate::keychain::delete),
            manage_firewall: cfg!(windows),
            timing: Timing::default(),
        }))
    }

    /// Never touch the firewall (the live test, which must not raise a UAC
    /// prompt or add a rule under the production name).
    pub fn without_firewall(mut self) -> Self {
        self.parts.manage_firewall = false;
        self
    }

    pub fn layout(&self) -> &HostLayout {
        &self.parts.layout
    }

    pub fn load_state(&self) -> Result<HostState> {
        HostState::load(&self.parts.state_path)
    }

    fn save(&self, state: &HostState) -> Result<()> {
        state.save(&self.parts.state_path)
    }

    fn config_path(&self, state: &HostState) -> PathBuf {
        state
            .config_path
            .clone()
            .unwrap_or_else(|| self.parts.layout.default_config())
    }

    fn claim_file(&self, state: &HostState) -> PathBuf {
        let config = self.config_path(state);
        config
            .parent()
            .map(|d| d.join("first-owner-claim.txt"))
            .unwrap_or_else(|| self.parts.layout.config_dir().join("first-owner-claim.txt"))
    }

    fn spec(&self, state: &HostState) -> ServiceSpec {
        ServiceSpec::for_host(
            self.parts.names.clone(),
            &self.parts.layout,
            &self.config_path(state),
            state.autostart,
        )
    }

    fn api(&self, state: &HostState) -> Result<Box<dyn HostApi>> {
        let port = state
            .port
            .context("Paracord on this computer isn't set up yet")?;
        let config = HostConfig::load(&self.config_path(state))?;
        Ok((self.parts.api)(port, &config, &self.claim_file(state)))
    }

    // ── Preflight ───────────────────────────────────────────────────────────

    /// Spec §2.3 against the real machine.
    pub fn preflight(&self) -> Result<HostPreflight> {
        let probes = SystemProbes {
            runner: self.parts.runner.clone(),
        };
        self.preflight_with(&probes)
    }

    pub fn preflight_with(&self, probes: &dyn PreflightProbes) -> Result<HostPreflight> {
        let state = self.load_state()?;
        Ok(preflight::run(probes, &state, self.parts.layout.root()))
    }

    // ── Setup (spec §2.6) ───────────────────────────────────────────────────

    /// Run the Rust setup rows, emitting `host://progress`. Rows 1 and 2
    /// always; rows 4 and 5 only once row 3 (claim + escrow, from JS) is
    /// recorded, so the first backup carries the key escrow. Call it again
    /// after row 3, and again for **Try again**: finished steps are skipped.
    ///
    /// A step that fails is reported through `emit` and stops the run; the
    /// return value is `Err` only when the app's own state couldn't be read
    /// or written.
    pub fn setup(&self, port: u16, emit: &dyn Fn(HostProgress)) -> Result<()> {
        let mut state = self.load_state()?;
        if state.port.is_none() {
            state.port = Some(port);
        }
        let port = state.port.unwrap_or(port);

        // Row 1.
        if !self.step(&mut state, 1, HostSetupStep::Install, true, emit, |h, s| {
            h.do_install(s)
        })? {
            return Ok(());
        }
        if !self.step(&mut state, 1, HostSetupStep::Init, true, emit, |h, s| {
            h.do_init(s, port)
        })? {
            return Ok(());
        }
        let service_in_place = state.has_step(steps::SERVICE)
            && self
                .parts
                .manager
                .status()
                .map(|s| s.installed())
                .unwrap_or(false);
        if !self.step(
            &mut state,
            1,
            HostSetupStep::Service,
            service_in_place,
            emit,
            |h, s| h.do_service(s, port),
        )? {
            return Ok(());
        }
        // Never skipped: "started once" says nothing about now.
        if !self.step(&mut state, 1, HostSetupStep::Start, false, emit, |h, s| {
            h.do_start(s)
        })? {
            return Ok(());
        }
        // Row 2.
        if !self.step(&mut state, 2, HostSetupStep::Storage, true, emit, |h, s| {
            h.do_storage(s)
        })? {
            return Ok(());
        }
        if !state.has_step(steps::ESCROW) {
            // Row 3 is the page's; it calls this again when it is done.
            return Ok(());
        }
        // Row 4: a reading of the server's current state, so it is never
        // skipped (a resumed setup shows today's answer).
        if !self.step(&mut state, 4, HostSetupStep::Reach, false, emit, |h, s| {
            h.do_reach(s)
        })? {
            return Ok(());
        }
        // Row 5.
        self.step(&mut state, 5, HostSetupStep::Backup, true, emit, |h, s| {
            h.do_backup(s)
        })?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn step(
        &self,
        state: &mut HostState,
        row: u8,
        step: HostSetupStep,
        skip_if_done: bool,
        emit: &dyn Fn(HostProgress),
        work: impl FnOnce(&Self, &mut HostState) -> std::result::Result<Done, Failure>,
    ) -> Result<bool> {
        let name = step_name(step);
        let event =
            |state: HostProgressState, detail: Option<String>, code: Option<String>| HostProgress {
                row,
                step,
                state,
                detail,
                code,
            };
        if skip_if_done && state.has_step(name) {
            emit(event(HostProgressState::Ok, None, None));
            return Ok(true);
        }
        emit(event(HostProgressState::Run, None, None));
        match work(self, state) {
            Ok(done) => {
                state.record_step(name);
                self.save(state)?;
                emit(event(done.state, done.detail, done.code));
                Ok(true)
            }
            Err(fail) => {
                self.save(state)?;
                emit(event(
                    HostProgressState::Fail,
                    Some(fail.detail),
                    Some(fail.code.to_string()),
                ));
                Ok(false)
            }
        }
    }

    fn do_install(&self, state: &mut HostState) -> std::result::Result<Done, Failure> {
        let layout = &self.parts.layout;
        let copy_failed = |e: &dyn std::fmt::Display| {
            failure(
                "install_failed",
                format!("Couldn't copy Paracord's server files ({e})."),
            )
        };
        for dir in [
            layout.root().to_path_buf(),
            layout.bin_dir(),
            layout.logs_dir(),
        ] {
            fsutil::create_private_dir_all(&dir).map_err(|e| copy_failed(&e))?;
        }
        fsutil::install_binary(&self.parts.sidecar, &layout.binary())
            .map_err(|e| copy_failed(&e))?;
        let version = sidecar::version(self.parts.runner.as_ref(), &layout.binary())
            .map_err(|e| copy_failed(&format!("couldn't read its version: {e}")))?;
        state.installed_version = Some(version);
        Ok(Done::ok())
    }

    fn do_init(&self, state: &mut HostState, port: u16) -> std::result::Result<Done, Failure> {
        let config_path = self.config_path(state);
        if !config_path.exists() {
            let output = self
                .parts
                .runner
                .run(&sidecar::init_invocation(&self.parts.layout, port))
                .map_err(|e| {
                    failure(
                        "init_failed",
                        format!("Couldn't run Paracord's server ({e})."),
                    )
                })?;
            if !output.success() {
                return Err(failure("init_failed", output.reason_line()));
            }
            if !config_path.exists() {
                return Err(failure(
                    "init_failed",
                    format!("Setup finished without writing {}.", config_path.display()),
                ));
            }
            state.instance_id = sidecar::instance_id_from_init(&output);
        }
        let config =
            HostConfig::load(&config_path).map_err(|e| failure("init_failed", format!("{e:#}")))?;
        if config.instance_id.is_some() {
            state.instance_id = config.instance_id;
        }
        state.enabled = true;
        state.port = Some(port);
        Ok(Done::ok())
    }

    fn do_service(&self, state: &mut HostState, port: u16) -> std::result::Result<Done, Failure> {
        self.parts.manager.install(&self.spec(state)).map_err(|e| {
            failure(
                "service_failed",
                format!("Couldn't register Paracord to run in the background ({e:#})."),
            )
        })?;
        let mut done = Done::ok();
        if self.parts.manage_firewall {
            // Not fatal either way: the server reports `firewall_blocked`
            // and the app offers **Allow** (spec §2.4).
            done.code = match firewall::allow(
                self.parts.runner.as_ref(),
                &self.parts.layout.binary(),
                port,
            ) {
                Ok(FirewallOutcome::Allowed) => None,
                Ok(FirewallOutcome::Declined) => Some("firewall_declined".into()),
                Err(e) => {
                    done.detail = Some(format!("{e:#}"));
                    Some("firewall_failed".into())
                }
            };
        }
        Ok(done)
    }

    /// Start the service unless it already answers, then wait for `/health`.
    fn start_and_wait(
        &self,
        state: &HostState,
        timeout: Duration,
    ) -> std::result::Result<(), Failure> {
        let api = self.api(state).map_err(|e| {
            failure(
                "start_failed",
                format!("Paracord on this computer didn't start ({e:#})."),
            )
        })?;
        if api.healthy() {
            return Ok(());
        }
        self.parts.manager.start(&self.spec(state)).map_err(|e| {
            failure(
                "start_failed",
                format!("Paracord on this computer didn't start ({e:#})."),
            )
        })?;
        match self.wait_up(api.as_ref(), timeout) {
            Ok(()) => Ok(()),
            Err(NotUp::StorageKey(reason)) => Err(failure(
                "storage_key",
                format!("Paracord on this computer can't open its storage key: {reason}"),
            )),
            Err(NotUp::Timeout) => Err(failure(
                "start_timeout",
                "Paracord on this computer didn't start.",
            )),
        }
    }

    fn do_start(&self, state: &mut HostState) -> std::result::Result<Done, Failure> {
        self.start_and_wait(state, self.parts.timing.start_timeout)?;
        Ok(Done::ok())
    }

    /// Poll `/health`; about once a second also ask the service manager, so an
    /// exit 78 is reported at once instead of after the timeout.
    fn wait_up(&self, api: &dyn HostApi, timeout: Duration) -> std::result::Result<(), NotUp> {
        let started = Instant::now();
        let mut last_status_check = Instant::now();
        loop {
            if api.healthy() {
                return Ok(());
            }
            if last_status_check.elapsed() >= Duration::from_secs(1) || started.elapsed() >= timeout
            {
                last_status_check = Instant::now();
                if let Ok(status) = self.parts.manager.status() {
                    if status.exit_code == Some(EXIT_STORAGE_KEY_UNAVAILABLE)
                        && status.state != ServiceState::Running
                    {
                        let reason = logs::storage_key_reason(&self.parts.layout.server_log())
                            .unwrap_or_else(|| "the reason isn't in the log".into());
                        return Err(NotUp::StorageKey(reason));
                    }
                }
            }
            if started.elapsed() >= timeout {
                return Err(NotUp::Timeout);
            }
            std::thread::sleep(self.parts.timing.health_poll);
        }
    }

    fn do_storage(&self, state: &mut HostState) -> std::result::Result<Done, Failure> {
        let status = self.api(state).and_then(|api| api.status()).map_err(|e| {
            failure(
                "status_unavailable",
                format!("Couldn't read the status of Paracord on this computer ({e:#})."),
            )
        })?;
        if !storage_ok(&status) {
            return Err(failure(
                "storage_unencrypted",
                "Paracord on this computer is running without encryption.",
            ));
        }
        Ok(Done::ok())
    }

    fn do_reach(&self, state: &mut HostState) -> std::result::Result<Done, Failure> {
        let api = match self.api(state) {
            Ok(api) => api,
            Err(e) => return Ok(Self::reach_unavailable(&e)),
        };
        let started = Instant::now();
        loop {
            let reach = match api.status() {
                Ok(status) => status.reachability,
                Err(e) => return Ok(Self::reach_unavailable(&e)),
            };
            if reach.state != ReachabilityState::Asking
                || started.elapsed() >= self.parts.timing.reach_timeout
            {
                let (progress, detail) = reach_copy(&reach);
                return Ok(Done {
                    state: progress,
                    detail: Some(detail),
                    code: Some(reach_code(reach.state)),
                });
            }
            std::thread::sleep(self.parts.timing.reach_poll);
        }
    }

    fn reach_unavailable(e: &anyhow::Error) -> Done {
        Done {
            state: HostProgressState::Warn,
            detail: Some(format!(
                "Couldn't ask Paracord on this computer about your router ({e:#})."
            )),
            code: Some("status_unavailable".into()),
        }
    }

    fn do_backup(&self, state: &mut HostState) -> std::result::Result<Done, Failure> {
        self.api(state)
            .and_then(|api| api.backup_now())
            .map_err(|e| {
                failure(
                    "backup_failed",
                    format!("The first backup didn't finish ({e:#})."),
                )
            })?;
        Ok(Done::ok())
    }

    // ── Row 3's Rust calls ──────────────────────────────────────────────────

    /// `host_claim`: post the claim with the token from the claim file.
    pub fn claim(&self, owner: &NewOwnerClaim) -> Result<serde_json::Value> {
        let mut state = self.load_state()?;
        if !state.enabled {
            bail!("Paracord on this computer isn't set up yet.");
        }
        if state.has_step(steps::CLAIM) {
            bail!("This server already has an owner. Sign in instead.");
        }
        let path = self.claim_file(&state);
        let token = std::fs::read_to_string(&path)
            .with_context(|| {
                format!(
                    "The server's one-time setup code isn't there ({}); it may have been used already",
                    path.display()
                )
            })?
            .trim()
            .to_string();
        if token.is_empty() {
            bail!(
                "The server's one-time setup code is empty ({}).",
                path.display()
            );
        }
        let response = self.api(&state)?.claim(&token, owner)?;
        state.record_step(steps::CLAIM);
        self.save(&state)?;
        Ok(response)
    }

    /// `host_write_escrow`. An escrow that already exists (409, a resumed
    /// setup) counts as written: it is this owner's, written once.
    pub fn write_escrow(&self, wrapping_key: &str) -> Result<()> {
        let mut state = self.load_state()?;
        match self.api(&state)?.write_escrow(wrapping_key)? {
            EscrowOutcome::Written | EscrowOutcome::AlreadyPresent => {}
        }
        state.record_step(steps::ESCROW);
        self.save(&state)
    }

    // ── Status and Settings (spec §2.9) ─────────────────────────────────────

    pub fn status(&self) -> Result<HostStatus> {
        let state = self.load_state()?;
        self.api(&state)?.status()
    }

    /// `host_retry_reachability`: ask the router again, then re-read row 4
    /// (emitted as `host://progress` row 4, which the setup screen and
    /// Settings both listen to).
    pub fn retry_reachability(&self, emit: &dyn Fn(HostProgress)) -> Result<()> {
        let mut state = self.load_state()?;
        self.api(&state)?.retry_reachability()?;
        self.step(&mut state, 4, HostSetupStep::Reach, false, emit, |h, s| {
            h.do_reach(s)
        })?;
        Ok(())
    }

    /// Windows: ask for the firewall rule again (the **Allow** chip).
    pub fn allow_firewall(&self) -> Result<FirewallOutcome> {
        if !cfg!(windows) {
            bail!("Only Windows needs a firewall rule for Paracord on this computer.");
        }
        let state = self.load_state()?;
        let port = state
            .port
            .context("Paracord on this computer isn't set up yet")?;
        firewall::allow(
            self.parts.runner.as_ref(),
            &self.parts.layout.binary(),
            port,
        )
    }

    pub fn backup_now(&self) -> Result<BackupNowResponse> {
        let state = self.load_state()?;
        self.api(&state)?.backup_now()
    }

    pub fn info(&self) -> Result<HostInfo> {
        let state = self.load_state()?;
        let (service, service_error) = if state.enabled {
            match self.parts.manager.status() {
                Ok(s) => (Some(s), None),
                Err(e) => (None, Some(format!("{e:#}"))),
            }
        } else {
            (None, None)
        };
        let storage_key_problem = service
            .as_ref()
            .filter(|s| {
                s.exit_code == Some(EXIT_STORAGE_KEY_UNAVAILABLE)
                    && s.state != ServiceState::Running
            })
            .map(|_| {
                logs::storage_key_reason(&self.parts.layout.server_log())
                    .unwrap_or_else(|| "the reason isn't in the log".into())
            });
        Ok(HostInfo {
            enabled: state.enabled,
            port: state.port,
            autostart: state.autostart,
            installed_version: state.installed_version.clone(),
            completed_steps: state.setup.completed_steps.clone(),
            service,
            service_error,
            home_url: state
                .enabled
                .then_some(state.port)
                .flatten()
                .map(|p| format!("https://127.0.0.1:{p}")),
            storage_key_problem,
            update_failure: state.update.clone().filter(|u| u.failure.is_some()),
            held_version: state.held_version.clone(),
        })
    }

    /// **Start**: start and wait for `/health`.
    pub fn start(&self) -> Result<()> {
        let state = self.load_state()?;
        if !state.enabled {
            bail!("Paracord on this computer isn't set up yet.");
        }
        self.start_and_wait(&state, self.parts.timing.start_timeout)
            .map_err(|f| anyhow::anyhow!(f.detail))
    }

    /// **Stop**.
    pub fn stop(&self) -> Result<()> {
        let status = self.parts.manager.status()?;
        if matches!(status.state, ServiceState::Running | ServiceState::Starting) {
            self.parts.manager.stop()?;
        }
        Ok(())
    }

    /// "Starts when you sign in to this computer".
    pub fn set_autostart(&self, enabled: bool) -> Result<()> {
        let mut state = self.load_state()?;
        if state.enabled && self.parts.manager.status()?.installed() {
            let mut spec = self.spec(&state);
            spec.autostart = enabled;
            self.parts.manager.set_autostart(&spec, enabled)?;
        }
        state.autostart = enabled;
        self.save(&state)
    }

    /// **Remove from this computer**: the service always; the data (host
    /// root, storage key, `host.json`) only when asked. With data kept, a
    /// later Host resumes on the same server.
    pub fn remove(&self, delete_data: bool) -> Result<()> {
        let mut state = self.load_state()?;
        self.parts.manager.remove()?;
        if self.parts.manage_firewall {
            // Declining leaves a rule for a binary that no longer runs; that
            // allows nothing, so it is not a reason to stop.
            let _ = firewall::remove(self.parts.runner.as_ref());
        }
        if delete_data {
            if let Ok(config) = HostConfig::load(&self.config_path(&state)) {
                if let Some((service, account)) = &config.keychain {
                    (self.parts.keychain_delete)(service, account).map_err(|e| {
                        anyhow::anyhow!(
                            "Couldn't delete the server's storage key from the system keychain ({e}). The server's files were kept."
                        )
                    })?;
                }
            }
            match std::fs::remove_dir_all(self.parts.layout.root()) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(e).with_context(|| {
                        format!("couldn't delete {}", self.parts.layout.root().display())
                    })
                }
            }
            match std::fs::remove_file(&self.parts.state_path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e).context("couldn't delete host.json"),
            }
        } else {
            state.enabled = false;
            state.forget_steps(&[
                steps::SERVICE,
                steps::START,
                steps::STORAGE,
                steps::REACH,
                steps::BACKUP,
            ]);
            self.save(&state)
        }
    }

    /// **Show details**: the last `lines` lines of `logs/server.log`.
    pub fn logs_tail(&self, lines: u32) -> Result<String> {
        match logs::tail(&self.parts.layout.server_log(), lines as usize) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                bail!("Paracord on this computer hasn't written a log yet.")
            }
            Err(e) => Err(e).context("couldn't read the server log"),
        }
    }

    // ── Restore (spec §4.8) ─────────────────────────────────────────────────

    /// Restore `archive` into a new generation under `<root>/restores/` and
    /// make its config the active one. Fresh computer: install and init
    /// first (rows 1, 2, 4, 5 then run through [`Host::setup`]; the claim and
    /// escrow came with the archive). Existing host: stopped, restored,
    /// started again.
    pub fn restore(&self, archive: &Path, wrapping_key: &str) -> Result<()> {
        let mut state = self.load_state()?;
        if !self.config_path(&state).exists() {
            return self.restore_fresh(state, archive, wrapping_key);
        }
        let was_installed = self.parts.manager.status()?.installed();
        self.stop()?;
        self.restore_generation(&mut state, archive, Some(wrapping_key))?;
        state.record_step(steps::CLAIM);
        state.record_step(steps::ESCROW);
        state.forget_steps(&[steps::START, steps::STORAGE, steps::REACH, steps::BACKUP]);
        self.save(&state)?;
        if was_installed {
            self.parts.manager.install(&self.spec(&state))?;
            self.start_and_wait(&state, self.parts.timing.start_timeout)
                .map_err(|f| anyhow::anyhow!(f.detail))?;
        }
        Ok(())
    }

    /// Restore on a computer that has never hosted: install, `init`, then
    /// take back the storage key `init` generated before restoring, because
    /// `restore-backup --escrow-key-stdin` refuses to replace a different key
    /// in the source (S4). Nothing was ever encrypted with that key: the
    /// server has not started, so no database exists yet. If anything fails,
    /// the half-made host root is removed so the next attempt starts clean.
    fn restore_fresh(
        &self,
        mut state: HostState,
        archive: &Path,
        wrapping_key: &str,
    ) -> Result<()> {
        let port = match state.port {
            Some(port) => port,
            None => (DEFAULT_PORT..=LAST_PORT)
                .find(|p| preflight::port_bindable(*p))
                .context("Every port Paracord could use (8443 to 8463) is taken.")?,
        };
        // Never clean up over data this call didn't make.
        if self.parts.layout.data_dir().join("paracord.db").exists() {
            bail!("This computer already has a server database; restoring over it is refused.");
        }
        let attempt = (|| -> Result<HostState> {
            let mut state = state.clone();
            state.port = Some(port);
            self.do_install(&mut state)
                .map_err(|f| anyhow::anyhow!(f.detail))?;
            state.record_step(steps::INSTALL);
            self.do_init(&mut state, port)
                .map_err(|f| anyhow::anyhow!(f.detail))?;
            state.record_step(steps::INIT);
            let config = HostConfig::load(&self.config_path(&state))?;
            if let Some((service, account)) = &config.keychain {
                (self.parts.keychain_delete)(service, account).map_err(|e| {
                    anyhow::anyhow!("Couldn't make room for the restored storage key ({e}).")
                })?;
            }
            self.restore_generation(&mut state, archive, Some(wrapping_key))?;
            state.record_step(steps::CLAIM);
            state.record_step(steps::ESCROW);
            Ok(state)
        })();
        match attempt {
            Ok(done) => self.save(&done),
            Err(e) => {
                let _ = std::fs::remove_dir_all(self.parts.layout.root());
                state.enabled = false;
                state.port = None;
                state.installed_version = None;
                state.instance_id = None;
                state.config_path = None;
                state.setup = Default::default();
                self.save(&state)?;
                Err(e)
            }
        }
    }

    fn restore_generation(
        &self,
        state: &mut HostState,
        archive: &Path,
        escrow_key: Option<&str>,
    ) -> Result<()> {
        let restores = self.parts.layout.restores_dir();
        fsutil::create_private_dir_all(&restores)?;
        let output_dir = restores.join(chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string());
        let output = self.parts.runner.run(&sidecar::restore_invocation(
            &self.parts.layout,
            &self.config_path(state),
            archive,
            &output_dir,
            escrow_key,
        ))?;
        if !output.success() {
            bail!("The restore didn't finish: {}", output.reason_line());
        }
        let config = output_dir.join("paracord.toml");
        if !config.is_file() {
            bail!("The restore finished without writing {}.", config.display());
        }
        state.config_path = Some(config);
        Ok(())
    }

    // ── Launch and update (spec §2.8) ───────────────────────────────────────

    /// At app start with hosting enabled: update the binary when the bundled
    /// one is newer, then start the service if autostart is on and it isn't
    /// running. No polling afterwards.
    pub fn on_launch(&self) -> Result<HostLaunch> {
        let state = self.load_state()?;
        if !state.enabled {
            return Ok(HostLaunch {
                info: self.info()?,
                update: UpdateOutcome::None,
                start_error: None,
            });
        }
        let update = match &state.update {
            Some(UpdateRecord {
                from_version,
                to_version,
                failure: Some(detail),
                ..
            }) => UpdateOutcome::Failed {
                from: from_version.clone(),
                to: to_version.clone(),
                detail: detail.clone(),
            },
            _ => self.update_if_newer()?,
        };
        let mut start_error = None;
        let state = self.load_state()?;
        if !matches!(update, UpdateOutcome::Failed { .. }) && state.autostart {
            let running = self
                .parts
                .manager
                .status()
                .map(|s| matches!(s.state, ServiceState::Running | ServiceState::Starting))
                .unwrap_or(false);
            if !running {
                start_error = self
                    .start_and_wait(&state, self.parts.timing.start_timeout)
                    .err()
                    .map(|f| f.detail);
            }
        }
        Ok(HostLaunch {
            info: self.info()?,
            update,
            start_error,
        })
    }

    /// The update procedure, when the bundled binary is newer than the
    /// installed one and not a held version.
    pub fn update_if_newer(&self) -> Result<UpdateOutcome> {
        let mut state = self.load_state()?;
        let bundled = match sidecar::version(self.parts.runner.as_ref(), &self.parts.sidecar) {
            Ok(v) => v,
            Err(e) => {
                return Ok(UpdateOutcome::NotStarted {
                    detail: format!("The app's bundled server couldn't be read ({e:#})."),
                })
            }
        };
        let Some(installed) = state.installed_version.clone() else {
            return Ok(UpdateOutcome::None);
        };
        if sidecar::compare_versions(&bundled, &installed) != Some(std::cmp::Ordering::Greater)
            || state.held_version.as_deref() == Some(bundled.as_str())
        {
            return Ok(UpdateOutcome::None);
        }

        // 1. A backup from before the update, from the running server.
        if let Err(f) = self.start_and_wait(&state, self.parts.timing.start_timeout) {
            return Ok(UpdateOutcome::NotStarted {
                detail: format!(
                    "Paracord on this computer wasn't running, so it couldn't be backed up before updating ({}). Nothing was changed.",
                    f.detail
                ),
            });
        }
        let backup = match self.api(&state).and_then(|api| api.backup_now()) {
            Ok(b) => b,
            Err(e) => {
                return Ok(UpdateOutcome::NotStarted {
                    detail: format!(
                        "The backup before the update didn't finish ({e:#}). Nothing was changed."
                    ),
                })
            }
        };
        state.update = Some(UpdateRecord {
            from_version: installed.clone(),
            to_version: bundled.clone(),
            backup_name: backup.name,
            failure: None,
        });
        self.save(&state)?;

        // 2. Stop, keep the old binary as .previous, copy the new one in, start.
        let layout = &self.parts.layout;
        let swapped = self
            .parts
            .manager
            .stop()
            .and_then(|()| {
                fsutil::replace_with(&layout.binary(), &layout.previous_binary())
                    .context("couldn't keep the current server as .previous")
            })
            .and_then(|()| {
                fsutil::install_binary(&self.parts.sidecar, &layout.binary())
                    .context("couldn't copy the new server in")
            });
        let result = swapped.map_err(|e| format!("{e:#}")).and_then(|()| {
            self.start_and_wait(&state, self.parts.timing.update_timeout)
                .map_err(|f| f.detail)
        });
        match result {
            Ok(()) => {
                state.installed_version = Some(bundled.clone());
                state.update = None;
                self.save(&state)?;
                Ok(UpdateOutcome::Updated {
                    from: installed,
                    to: bundled,
                })
            }
            Err(detail) => {
                let detail =
                    format!("Paracord on this computer didn't start after the update. {detail}");
                if let Some(record) = state.update.as_mut() {
                    record.failure = Some(detail.clone());
                }
                self.save(&state)?;
                Ok(UpdateOutcome::Failed {
                    from: installed,
                    to: bundled,
                    detail,
                })
            }
        }
    }

    /// **Restore the backup from before the update**: stop, put `.previous`
    /// back, restore the pre-update archive with it, start. The new version
    /// is held so the next launch doesn't try it again by itself.
    pub fn rollback_update(&self) -> Result<()> {
        let mut state = self.load_state()?;
        let record = state.update.clone().context("There's no update to undo.")?;
        let layout = &self.parts.layout;
        if !layout.previous_binary().is_file() {
            bail!(
                "The server from before the update isn't there anymore ({}).",
                layout.previous_binary().display()
            );
        }
        self.stop()?;
        fsutil::replace_with(&layout.previous_binary(), &layout.binary())
            .context("couldn't put the previous server back")?;
        let config = HostConfig::load(&self.config_path(&state))?;
        let archive = config.backup_dir.join(&record.backup_name);
        self.restore_generation(&mut state, &archive, None)?;
        state.installed_version = Some(record.from_version.clone());
        state.held_version = Some(record.to_version.clone());
        state.update = None;
        self.save(&state)?;
        self.parts.manager.install(&self.spec(&state))?;
        self.start_and_wait(&state, self.parts.timing.update_timeout)
            .map_err(|f| anyhow::anyhow!(f.detail))
    }
}

// The rigs run a shell-script stand-in for the host binary.
#[cfg(all(test, unix))]
#[path = "host_tests.rs"]
mod tests;
