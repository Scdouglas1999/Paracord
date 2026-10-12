//! macOS: a LaunchAgent `~/Library/LaunchAgents/com.paracord.desktop.host.plist`
//! (spec §2.4), loaded into the user's GUI domain with `launchctl bootstrap`.
//!
//! Autostart off is `launchctl disable gui/<uid>/<label>`, which only stops
//! loading at the next sign-in; **Start** with autostart off enables the
//! label for the bootstrap and disables it again after.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

use super::{xml_escape, ServiceManager, ServiceNames, ServiceSpec, ServiceState, ServiceStatus};
use crate::fsutil;
use crate::runner::{path_arg, run_checked, CommandRunner, Invocation};

/// `~/Library/LaunchAgents`.
pub fn launch_agents_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .context("HOME is not set, so ~/Library/LaunchAgents is unknown")?;
    Ok(PathBuf::from(home).join("Library/LaunchAgents"))
}

/// The user id for `gui/<uid>`.
#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// The LaunchAgent property list (spec §2.4).
pub fn render_plist(spec: &ServiceSpec) -> String {
    let mut arguments = String::new();
    for word in std::iter::once(spec.program.to_string_lossy().into_owned())
        .chain(spec.args.iter().cloned())
    {
        arguments.push_str(&format!("\t\t<string>{}</string>\n", xml_escape(&word)));
    }
    let log = xml_escape(&spec.launchd_log.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
{arguments}	</array>
	<key>WorkingDirectory</key>
	<string>{working_dir}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#,
        label = xml_escape(&spec.names.launchd_label),
        working_dir = xml_escape(&spec.working_dir.to_string_lossy()),
    )
}

pub struct LaunchAgentManager {
    names: ServiceNames,
    runner: Arc<dyn CommandRunner>,
    agents_dir: PathBuf,
    uid: u32,
}

impl LaunchAgentManager {
    pub fn new(
        names: ServiceNames,
        runner: Arc<dyn CommandRunner>,
        agents_dir: PathBuf,
        uid: u32,
    ) -> Self {
        Self {
            names,
            runner,
            agents_dir,
            uid,
        }
    }

    pub fn plist_path(&self) -> PathBuf {
        self.agents_dir
            .join(format!("{}.plist", self.names.launchd_label))
    }

    fn domain(&self) -> String {
        format!("gui/{}", self.uid)
    }

    fn target(&self) -> String {
        format!("gui/{}/{}", self.uid, self.names.launchd_label)
    }

    fn launchctl(&self, args: &[&str]) -> Invocation {
        Invocation::new("launchctl", args.iter().copied())
    }

    fn checked(&self, args: &[&str]) -> Result<()> {
        run_checked(self.runner.as_ref(), &self.launchctl(args)).map(|_| ())
    }

    fn loaded(&self) -> Result<Option<String>> {
        let output = self
            .runner
            .run(&self.launchctl(&["print", &self.target()]))?;
        Ok(output.success().then_some(output.stdout))
    }
}

impl ServiceManager for LaunchAgentManager {
    fn install(&self, spec: &ServiceSpec) -> Result<()> {
        std::fs::create_dir_all(&self.agents_dir)
            .with_context(|| format!("couldn't create {}", self.agents_dir.display()))?;
        // launchd opens the log paths itself and fails the job if the
        // directory is missing.
        if let Some(dir) = spec.launchd_log.parent() {
            fsutil::create_private_dir_all(dir)
                .with_context(|| format!("couldn't create {}", dir.display()))?;
        }
        let path = self.plist_path();
        fsutil::write_atomic(&path, render_plist(spec).as_bytes(), 0o644)
            .with_context(|| format!("couldn't write {}", path.display()))?;
        self.set_autostart(spec, spec.autostart)
    }

    fn set_autostart(&self, _spec: &ServiceSpec, enabled: bool) -> Result<()> {
        self.checked(&[if enabled { "enable" } else { "disable" }, &self.target()])
    }

    fn start(&self, spec: &ServiceSpec) -> Result<()> {
        let target = self.target();
        if self.loaded()?.is_some() {
            return self.checked(&["kickstart", "-k", &target]);
        }
        if !spec.autostart {
            self.checked(&["enable", &target])?;
        }
        let plist = path_arg(&self.plist_path());
        let result = self
            .checked(&["bootstrap", &self.domain(), &plist])
            .and_then(|()| self.checked(&["kickstart", &target]));
        if !spec.autostart {
            self.checked(&["disable", &target])?;
        }
        result
    }

    fn stop(&self) -> Result<()> {
        if self.loaded()?.is_none() {
            return Ok(());
        }
        self.checked(&["bootout", &self.target()])
    }

    fn remove(&self) -> Result<()> {
        let target = self.target();
        if self.loaded()?.is_some() {
            self.checked(&["bootout", &target])?;
        }
        // Drop a disabled override for a label that no longer exists.
        let _ = self.runner.run(&self.launchctl(&["enable", &target]));
        match std::fs::remove_file(self.plist_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => {
                Err(e).with_context(|| format!("couldn't delete {}", self.plist_path().display()))
            }
        }
    }

    fn status(&self) -> Result<ServiceStatus> {
        if !self.plist_path().exists() {
            return Ok(ServiceStatus::not_installed());
        }
        let disabled = run_checked(
            self.runner.as_ref(),
            &self.launchctl(&["print-disabled", &self.domain()]),
        )?;
        let enabled = !label_disabled(&disabled.stdout, &self.names.launchd_label);
        let Some(printed) = self.loaded()? else {
            return Ok(ServiceStatus {
                state: ServiceState::Stopped,
                enabled,
                exit_code: None,
            });
        };
        let (state, exit_code) = parse_print(&printed);
        Ok(ServiceStatus {
            state,
            enabled,
            exit_code,
        })
    }
}

/// `launchctl print-disabled` lists `"label" => disabled` (or `=> true` on
/// older systems) for disabled labels.
pub fn label_disabled(text: &str, label: &str) -> bool {
    let needle = format!("\"{label}\"");
    text.lines().any(|line| {
        let line = line.trim();
        line.starts_with(&needle)
            && line
                .split("=>")
                .nth(1)
                .map(|v| matches!(v.trim(), "disabled" | "true"))
                .unwrap_or(false)
    })
}

/// `launchctl print gui/<uid>/<label>`: `state = running`, `last exit code = N`.
pub fn parse_print(text: &str) -> (ServiceState, Option<i32>) {
    let mut running = false;
    let mut exit_code = None;
    for line in text.lines().map(str::trim) {
        if let Some(v) = line.strip_prefix("state = ") {
            running = v.trim() == "running";
        } else if let Some(v) = line.strip_prefix("last exit code = ") {
            exit_code = v.trim().parse::<i32>().ok().filter(|c| *c != 0);
        }
    }
    if running {
        (ServiceState::Running, None)
    } else if exit_code.is_some() {
        (ServiceState::Failed, exit_code)
    } else {
        (ServiceState::Stopped, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::HostLayout;
    use crate::runner::fake::{fail, ok, FakeRunner};

    fn spec(autostart: bool) -> ServiceSpec {
        let layout =
            HostLayout::new("/Users/sam/Library/Application Support/com.paracord.desktop/host");
        ServiceSpec::for_host(
            ServiceNames::production(),
            &layout,
            &layout.default_config(),
            autostart,
        )
    }

    fn manager(runner: Arc<FakeRunner>, dir: &std::path::Path) -> LaunchAgentManager {
        LaunchAgentManager::new(ServiceNames::production(), runner, dir.to_path_buf(), 501)
    }

    #[test]
    fn start_with_autostart_off_enables_only_for_the_bootstrap() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new());
        runner.respond(|inv| (inv.args[0] == "print").then(|| fail(113, "Could not find service")));
        let m = manager(runner.clone(), dir.path());
        let mut s = spec(false);
        s.launchd_log = dir.path().join("logs/launchd.log");
        m.install(&s).unwrap();
        assert!(dir.path().join("logs").is_dir());
        m.start(&s).unwrap();
        let plist = m.plist_path().to_string_lossy().into_owned();
        assert_eq!(
            runner.lines(),
            [
                "launchctl disable gui/501/com.paracord.desktop.host".to_string(),
                "launchctl print gui/501/com.paracord.desktop.host".to_string(),
                "launchctl enable gui/501/com.paracord.desktop.host".to_string(),
                format!("launchctl bootstrap gui/501 {plist}"),
                "launchctl kickstart gui/501/com.paracord.desktop.host".to_string(),
                "launchctl disable gui/501/com.paracord.desktop.host".to_string(),
            ]
        );
    }

    #[test]
    fn start_when_loaded_restarts_it() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new());
        runner.respond(|inv| (inv.args[0] == "print").then(|| ok("state = running\n")));
        let m = manager(runner.clone(), dir.path());
        m.start(&spec(true)).unwrap();
        m.stop().unwrap();
        assert_eq!(
            runner.lines(),
            [
                "launchctl print gui/501/com.paracord.desktop.host",
                "launchctl kickstart -k gui/501/com.paracord.desktop.host",
                "launchctl print gui/501/com.paracord.desktop.host",
                "launchctl bootout gui/501/com.paracord.desktop.host",
            ]
        );
    }

    #[test]
    fn status_reads_print_and_print_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new());
        runner.respond(|inv| match inv.args[0].as_str() {
            "print-disabled" => Some(ok("disabled services = {\n\t\"com.paracord.desktop.host\" => disabled\n}\n")),
            "print" => Some(ok("gui/501/com.paracord.desktop.host = {\n\tstate = not running\n\tlast exit code = 78\n}\n")),
            _ => None,
        });
        let m = manager(runner, dir.path());
        assert_eq!(m.status().unwrap().state, ServiceState::NotInstalled);
        std::fs::write(m.plist_path(), "x").unwrap();
        assert_eq!(
            m.status().unwrap(),
            ServiceStatus {
                state: ServiceState::Failed,
                enabled: false,
                exit_code: Some(78)
            }
        );
    }

    #[test]
    fn disabled_parsing() {
        let text = "\t\"com.other\" => disabled\n\t\"com.paracord.desktop.host\" => enabled\n";
        assert!(!label_disabled(text, "com.paracord.desktop.host"));
        assert!(label_disabled(
            "\"com.paracord.desktop.host\" => true",
            "com.paracord.desktop.host"
        ));
        assert!(!label_disabled(
            "\"com.paracord.desktop.host-test-1\" => disabled",
            "com.paracord.desktop.host"
        ));
    }
}
