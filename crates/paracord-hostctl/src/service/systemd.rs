//! Linux: a systemd user unit, `~/.config/systemd/user/paracord-host.service`
//! (spec §2.4). It starts when the user signs in (no lingering: the Secret
//! Service keyring is only unlocked in a signed-in session).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

use super::{ServiceManager, ServiceNames, ServiceSpec, ServiceState, ServiceStatus};
use crate::fsutil;
use crate::runner::{run_checked, CommandRunner, Invocation};

/// `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`.
pub fn user_unit_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Ok(dir.join("systemd/user"));
        }
    }
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .context("HOME is not set, so the systemd user unit directory is unknown")?;
    Ok(PathBuf::from(home).join(".config/systemd/user"))
}

/// Quote one `ExecStart=` word: `%` and `$` are specifier/variable syntax and
/// are doubled; a word with whitespace, quotes or backslashes is
/// double-quoted with C escapes.
fn exec_word(word: &str) -> String {
    let escaped = word.replace('%', "%%").replace('$', "$$");
    let needs_quotes = escaped.is_empty()
        || escaped
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\' || c == ';');
    if !needs_quotes {
        return escaped;
    }
    let mut out = String::from("\"");
    for c in escaped.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A path value (`WorkingDirectory=`): specifiers doubled, no quoting.
fn path_value(path: &str) -> String {
    path.replace('%', "%%")
}

/// The unit file text (spec §2.4, verbatim layout).
pub fn render_unit(spec: &ServiceSpec) -> String {
    let exec = std::iter::once(spec.program.to_string_lossy().into_owned())
        .chain(spec.args.iter().cloned())
        .map(|w| exec_word(&w))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "[Unit]\n\
         Description={description}\n\
         After=default.target\n\
         \n\
         [Service]\n\
         Type=exec\n\
         WorkingDirectory={working_dir}\n\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         RestartPreventExitStatus=78\n\
         Nice=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        description = spec.names.description.replace('\n', " "),
        working_dir = path_value(&spec.working_dir.to_string_lossy()),
    )
}

pub struct SystemdUserManager {
    names: ServiceNames,
    runner: Arc<dyn CommandRunner>,
    unit_dir: PathBuf,
}

impl SystemdUserManager {
    pub fn new(names: ServiceNames, runner: Arc<dyn CommandRunner>, unit_dir: PathBuf) -> Self {
        Self {
            names,
            runner,
            unit_dir,
        }
    }

    pub fn unit_path(&self) -> PathBuf {
        self.unit_dir.join(self.names.systemd_unit_file())
    }

    fn systemctl(&self, args: &[&str]) -> Invocation {
        Invocation::new(
            "systemctl",
            std::iter::once("--user").chain(args.iter().copied()),
        )
    }

    fn checked(&self, args: &[&str]) -> Result<()> {
        run_checked(self.runner.as_ref(), &self.systemctl(args)).map(|_| ())
    }

    fn unchecked(&self, args: &[&str]) {
        let _ = self.runner.run(&self.systemctl(args));
    }
}

impl ServiceManager for SystemdUserManager {
    fn install(&self, spec: &ServiceSpec) -> Result<()> {
        std::fs::create_dir_all(&self.unit_dir)
            .with_context(|| format!("couldn't create {}", self.unit_dir.display()))?;
        let path = self.unit_path();
        fsutil::write_atomic(&path, render_unit(spec).as_bytes(), 0o644)
            .with_context(|| format!("couldn't write {}", path.display()))?;
        self.checked(&["daemon-reload"])?;
        self.set_autostart(spec, spec.autostart)
    }

    fn set_autostart(&self, _spec: &ServiceSpec, enabled: bool) -> Result<()> {
        let unit = self.names.systemd_unit_file();
        self.checked(&[if enabled { "enable" } else { "disable" }, &unit])
    }

    fn start(&self, _spec: &ServiceSpec) -> Result<()> {
        let unit = self.names.systemd_unit_file();
        // A unit that hit its start limit refuses `start` until this is
        // cleared; clearing a healthy unit does nothing.
        self.unchecked(&["reset-failed", &unit]);
        self.checked(&["start", &unit])
    }

    fn stop(&self) -> Result<()> {
        self.checked(&["stop", &self.names.systemd_unit_file()])
    }

    fn remove(&self) -> Result<()> {
        let unit = self.names.systemd_unit_file();
        self.unchecked(&["stop", &unit]);
        self.unchecked(&["disable", &unit]);
        let path = self.unit_path();
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("couldn't delete {}", path.display())),
        }
        self.checked(&["daemon-reload"])?;
        self.unchecked(&["reset-failed", &unit]);
        Ok(())
    }

    fn status(&self) -> Result<ServiceStatus> {
        let unit = self.names.systemd_unit_file();
        let output = run_checked(
            self.runner.as_ref(),
            &self.systemctl(&[
                "show",
                &unit,
                "--no-pager",
                "--property=LoadState,ActiveState,SubState,UnitFileState,ExecMainStatus",
            ]),
        )?;
        Ok(parse_show(&output.stdout))
    }
}

/// Parse `systemctl show` key=value output (not localized).
pub fn parse_show(text: &str) -> ServiceStatus {
    let props: HashMap<&str, &str> = text
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect();
    let load = props.get("LoadState").copied().unwrap_or("");
    if load == "not-found" || load.is_empty() {
        return ServiceStatus::not_installed();
    }
    let active = props.get("ActiveState").copied().unwrap_or("");
    let sub = props.get("SubState").copied().unwrap_or("");
    let exit_code = props
        .get("ExecMainStatus")
        .and_then(|v| v.parse::<i32>().ok())
        .filter(|code| *code != 0);
    let state = match active {
        "active" | "reloading" => ServiceState::Running,
        "activating" if sub == "auto-restart" => ServiceState::Starting,
        "activating" => ServiceState::Starting,
        "failed" => ServiceState::Failed,
        _ => ServiceState::Stopped,
    };
    let enabled = matches!(
        props.get("UnitFileState").copied().unwrap_or(""),
        "enabled" | "enabled-runtime" | "linked" | "alias"
    );
    ServiceStatus {
        state,
        enabled,
        exit_code: if state == ServiceState::Running {
            None
        } else {
            exit_code
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::HostLayout;
    use crate::runner::fake::{ok, FakeRunner};
    use std::path::Path;

    fn spec(root: &str) -> ServiceSpec {
        let layout = HostLayout::new(root);
        ServiceSpec::for_host(
            ServiceNames::production(),
            &layout,
            &layout.default_config(),
            true,
        )
    }

    #[test]
    fn words_with_spaces_and_specifiers_are_quoted() {
        let unit = render_unit(&spec("/home/sam o'neil/100%/host"));
        assert!(unit.contains(
            "ExecStart=\"/home/sam o'neil/100%%/host/bin/paracord-host\" -c \"/home/sam o'neil/100%%/host/config/paracord.toml\""
        ), "{unit}");
        assert!(unit.contains("WorkingDirectory=/home/sam o'neil/100%%/host\n"));
        assert_eq!(exec_word("$HOME"), "$$HOME");
    }

    #[test]
    fn install_writes_the_unit_reloads_and_enables_without_starting() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new());
        let manager = SystemdUserManager::new(
            ServiceNames::production(),
            runner.clone(),
            dir.path().join("systemd/user"),
        );
        let spec = spec("/h");
        manager.install(&spec).unwrap();
        assert_eq!(
            std::fs::read_to_string(manager.unit_path()).unwrap(),
            render_unit(&spec)
        );
        assert_eq!(
            runner.lines(),
            [
                "systemctl --user daemon-reload",
                "systemctl --user enable paracord-host.service"
            ]
        );
        manager.start(&spec).unwrap();
        manager.set_autostart(&spec, false).unwrap();
        manager.stop().unwrap();
        manager.remove().unwrap();
        assert!(!manager.unit_path().exists());
        assert_eq!(
            runner.lines()[2..],
            [
                "systemctl --user reset-failed paracord-host.service",
                "systemctl --user start paracord-host.service",
                "systemctl --user disable paracord-host.service",
                "systemctl --user stop paracord-host.service",
                "systemctl --user stop paracord-host.service",
                "systemctl --user disable paracord-host.service",
                "systemctl --user daemon-reload",
                "systemctl --user reset-failed paracord-host.service",
            ]
        );
    }

    #[test]
    fn status_reads_systemctl_show() {
        let runner = Arc::new(FakeRunner::new());
        runner.respond(|inv| {
            (inv.args.get(1).map(String::as_str) == Some("show")).then(|| {
                ok("LoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\nExecMainStatus=78\n")
            })
        });
        let manager =
            SystemdUserManager::new(ServiceNames::production(), runner, Path::new("/x").into());
        let status = manager.status().unwrap();
        assert_eq!(
            status,
            ServiceStatus {
                state: ServiceState::Failed,
                enabled: true,
                exit_code: Some(78)
            }
        );
    }

    #[test]
    fn show_parsing_covers_every_state() {
        assert_eq!(
            parse_show("LoadState=not-found\nActiveState=inactive\n").state,
            ServiceState::NotInstalled
        );
        let running = parse_show("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=disabled\nExecMainStatus=0\n");
        assert_eq!(running.state, ServiceState::Running);
        assert!(!running.enabled);
        assert_eq!(running.exit_code, None);
        let restarting = parse_show("LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\nExecMainStatus=1\n");
        assert_eq!(restarting.state, ServiceState::Starting);
        assert_eq!(restarting.exit_code, Some(1));
        assert_eq!(
            parse_show("LoadState=loaded\nActiveState=inactive\nSubState=dead\n").state,
            ServiceState::Stopped
        );
    }
}
