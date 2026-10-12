//! Windows: a per-user Scheduled Task `\Paracord\Paracord on this computer`
//! (spec §2.4), registered with `schtasks /Create /XML` (no elevation).
//!
//! Autostart off disables the task's logon trigger rather than the whole task:
//! a disabled task refuses `schtasks /Run`, which would make **Start** in
//! Settings fail whenever "Starts when you sign in" is off.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};

use super::{xml_escape, ServiceManager, ServiceNames, ServiceSpec, ServiceState, ServiceStatus};
use crate::fsutil;
use crate::runner::{path_arg, run_checked, CommandRunner, Invocation};

/// `DOMAIN\user` of the signed-in user, for the trigger and principal.
pub fn current_user_id() -> Result<String> {
    let user = std::env::var("USERNAME")
        .ok()
        .filter(|u| !u.is_empty())
        .context("USERNAME is not set, so the Scheduled Task has no user to run as")?;
    Ok(
        match std::env::var("USERDOMAIN").ok().filter(|d| !d.is_empty()) {
            Some(domain) => format!("{domain}\\{user}"),
            None => user,
        },
    )
}

/// Quote one argument the way `CommandLineToArgvW` reads it back.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The task definition (Task Scheduler schema 1.2). Written to disk as UTF-16
/// LE with a BOM, which is what `schtasks /XML` reads reliably.
pub fn render_task_xml(spec: &ServiceSpec, user_id: &str) -> String {
    let arguments = spec
        .args
        .iter()
        .map(|a| quote_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let user = xml_escape(user_id);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{description}</Description>
    <URI>{uri}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>{autostart}</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{working_dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
        description = xml_escape(&spec.names.description),
        uri = xml_escape(&spec.names.task_path()),
        autostart = spec.autostart,
        command = xml_escape(&spec.program.to_string_lossy()),
        arguments = xml_escape(&arguments),
        working_dir = xml_escape(&spec.working_dir.to_string_lossy()),
    )
}

/// UTF-16 LE with a byte-order mark.
pub fn utf16le_with_bom(text: &str) -> Vec<u8> {
    std::iter::once(0xFEFFu16)
        .chain(text.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

pub struct ScheduledTaskManager {
    names: ServiceNames,
    runner: Arc<dyn CommandRunner>,
    /// Where the XML is written for `schtasks /Create` (deleted after).
    scratch_dir: PathBuf,
    user_id: String,
}

impl ScheduledTaskManager {
    pub fn new(
        names: ServiceNames,
        runner: Arc<dyn CommandRunner>,
        scratch_dir: PathBuf,
        user_id: String,
    ) -> Self {
        Self {
            names,
            runner,
            scratch_dir,
            user_id,
        }
    }

    fn schtasks(&self, args: &[&str]) -> Invocation {
        Invocation::new("schtasks", args.iter().copied())
    }

    /// The PowerShell that prints `missing`, or `state=`, `result=` and
    /// `triggers=` lines. `Get-ScheduledTask` reports the State enum by name
    /// whatever the display language, unlike `schtasks /Query`.
    fn status_script(&self) -> String {
        let quote = |s: &str| s.replace('\'', "''");
        format!(
            "$t = Get-ScheduledTask -TaskPath '{folder}' -TaskName '{name}' -ErrorAction SilentlyContinue; \
             if ($null -eq $t) {{ 'missing' }} else {{ \
             $i = $t | Get-ScheduledTaskInfo; \
             $n = @($t.Triggers | Where-Object {{ $_.Enabled }}).Count; \
             \"state=$($t.State)\"; \"result=$($i.LastTaskResult)\"; \"triggers=$n\" }}",
            folder = quote(&self.names.task_folder),
            name = quote(&self.names.task_name),
        )
    }
}

impl ServiceManager for ScheduledTaskManager {
    fn install(&self, spec: &ServiceSpec) -> Result<()> {
        fsutil::create_private_dir_all(&self.scratch_dir)
            .with_context(|| format!("couldn't create {}", self.scratch_dir.display()))?;
        let xml_path = self
            .scratch_dir
            .join(format!(".{}.task.xml", uuid::Uuid::new_v4().simple()));
        fsutil::write_private_atomic(
            &xml_path,
            &utf16le_with_bom(&render_task_xml(spec, &self.user_id)),
        )
        .with_context(|| format!("couldn't write {}", xml_path.display()))?;
        let task = self.names.task_path();
        let xml = path_arg(&xml_path);
        let result = run_checked(
            self.runner.as_ref(),
            &self.schtasks(&["/Create", "/XML", &xml, "/TN", &task, "/F"]),
        );
        let _ = std::fs::remove_file(&xml_path);
        result.map(|_| ())
    }

    fn set_autostart(&self, spec: &ServiceSpec, enabled: bool) -> Result<()> {
        let mut spec = spec.clone();
        spec.autostart = enabled;
        self.install(&spec)
    }

    fn start(&self, _spec: &ServiceSpec) -> Result<()> {
        let task = self.names.task_path();
        run_checked(
            self.runner.as_ref(),
            &self.schtasks(&["/Run", "/TN", &task]),
        )
        .map(|_| ())
    }

    fn stop(&self) -> Result<()> {
        let task = self.names.task_path();
        run_checked(
            self.runner.as_ref(),
            &self.schtasks(&["/End", "/TN", &task]),
        )
        .map(|_| ())
    }

    fn remove(&self) -> Result<()> {
        if !self.status()?.installed() {
            return Ok(());
        }
        let task = self.names.task_path();
        let _ = self.runner.run(&self.schtasks(&["/End", "/TN", &task]));
        run_checked(
            self.runner.as_ref(),
            &self.schtasks(&["/Delete", "/TN", &task, "/F"]),
        )
        .map(|_| ())
    }

    fn status(&self) -> Result<ServiceStatus> {
        let output = run_checked(
            self.runner.as_ref(),
            &Invocation::new(
                "powershell.exe",
                [
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    self.status_script(),
                ],
            ),
        )?;
        Ok(parse_status(&output.stdout))
    }
}

/// `SCHED_S_TASK_HAS_NOT_RUN`, `SCHED_S_TASK_RUNNING`, `SCHED_S_TASK_TERMINATED`:
/// LastTaskResult values that are not a process exit status.
const NOT_AN_EXIT_STATUS: [i64; 3] = [0x41303, 0x41301, 0x41306];

pub fn parse_status(text: &str) -> ServiceStatus {
    let mut state = None;
    let mut result = None;
    let mut triggers = 0i64;
    for line in text.lines().map(str::trim) {
        if line == "missing" {
            return ServiceStatus::not_installed();
        }
        if let Some(v) = line.strip_prefix("state=") {
            state = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("result=") {
            result = v.parse::<i64>().ok();
        } else if let Some(v) = line.strip_prefix("triggers=") {
            triggers = v.parse().unwrap_or(0);
        }
    }
    let Some(state) = state else {
        return ServiceStatus::not_installed();
    };
    let service_state = match state.as_str() {
        "Running" => ServiceState::Running,
        "Queued" => ServiceState::Starting,
        _ => ServiceState::Stopped,
    };
    let exit_code = result
        .filter(|r| *r != 0 && !NOT_AN_EXIT_STATUS.contains(r))
        .and_then(|r| i32::try_from(r).ok())
        .filter(|_| service_state != ServiceState::Running);
    ServiceStatus {
        state: if exit_code.is_some() && service_state == ServiceState::Stopped {
            ServiceState::Failed
        } else {
            service_state
        },
        enabled: state != "Disabled" && triggers > 0,
        exit_code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::HostLayout;
    use crate::runner::fake::{ok, FakeRunner};

    fn spec(autostart: bool) -> ServiceSpec {
        let layout = HostLayout::new(r"C:\Users\Sam\AppData\Local\com.paracord.desktop\host");
        ServiceSpec::for_host(
            ServiceNames::production(),
            &layout,
            &layout.default_config(),
            autostart,
        )
    }

    #[test]
    fn arguments_quote_like_commandlinetoargvw() {
        assert_eq!(quote_arg("-c"), "-c");
        assert_eq!(quote_arg(r"C:\Program Files\x"), r#""C:\Program Files\x""#);
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote_arg(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn autostart_off_disables_only_the_trigger() {
        let xml = render_task_xml(&spec(false), r"PC\Sam");
        assert!(xml.contains("<LogonTrigger>\n      <Enabled>false</Enabled>"));
        assert!(xml.contains(
            "<AllowStartOnDemand>true</AllowStartOnDemand>\n    <Enabled>true</Enabled>"
        ));
    }

    #[test]
    fn the_xml_file_is_utf16_with_a_bom() {
        let bytes = utf16le_with_bom("<a/>");
        assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
    }

    #[test]
    fn install_registers_from_a_temp_xml_and_cleans_it_up() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        runner.respond(move |inv| {
            if inv.program == "schtasks" && inv.args[0] == "/Create" {
                seen2
                    .lock()
                    .unwrap()
                    .push(std::fs::read(&inv.args[2]).unwrap());
            }
            None
        });
        let manager = ScheduledTaskManager::new(
            ServiceNames::production(),
            runner.clone(),
            dir.path().to_path_buf(),
            r"PC\Sam".into(),
        );
        manager.install(&spec(true)).unwrap();
        let line = &runner.lines()[0];
        assert!(line.starts_with("schtasks /Create /XML "), "{line}");
        assert!(
            line.ends_with(r" /TN \Paracord\Paracord on this computer /F"),
            "{line}"
        );
        assert_eq!(
            seen.lock().unwrap()[0],
            utf16le_with_bom(&render_task_xml(&spec(true), r"PC\Sam"))
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        manager.start(&spec(true)).unwrap();
        manager.stop().unwrap();
        assert_eq!(
            runner.lines()[1..],
            [
                r"schtasks /Run /TN \Paracord\Paracord on this computer",
                r"schtasks /End /TN \Paracord\Paracord on this computer"
            ]
        );
    }

    #[test]
    fn remove_of_a_missing_task_does_nothing_else() {
        let runner = Arc::new(FakeRunner::new());
        runner.respond(|inv| (inv.program == "powershell.exe").then(|| ok("missing\r\n")));
        let manager = ScheduledTaskManager::new(
            ServiceNames::production(),
            runner.clone(),
            PathBuf::from("."),
            "u".into(),
        );
        manager.remove().unwrap();
        assert_eq!(runner.lines().len(), 1);
        assert!(runner.lines()[0].contains(
            "Get-ScheduledTask -TaskPath '\\Paracord\\' -TaskName 'Paracord on this computer'"
        ));
    }

    #[test]
    fn status_maps_task_states() {
        assert_eq!(parse_status("missing").state, ServiceState::NotInstalled);
        let running = parse_status("state=Running\r\nresult=267009\r\ntriggers=1\r\n");
        assert_eq!(running.state, ServiceState::Running);
        assert!(running.enabled);
        let never = parse_status("state=Ready\nresult=267011\ntriggers=0\n");
        assert_eq!(never.state, ServiceState::Stopped);
        assert!(!never.enabled);
        assert_eq!(never.exit_code, None);
        let key = parse_status("state=Ready\nresult=78\ntriggers=1\n");
        assert_eq!(key.state, ServiceState::Failed);
        assert_eq!(key.exit_code, Some(78));
        assert!(!parse_status("state=Disabled\nresult=0\ntriggers=1\n").enabled);
    }
}
