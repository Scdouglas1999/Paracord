//! Windows Firewall (spec §2.4): one elevated `netsh` rule pair for the host
//! binary, through a single UAC prompt. Declining is not fatal: the server
//! reports `firewall_blocked` and the app offers **Allow** again.
//!
//! The commands are built on every OS so they are unit-tested here; they are
//! only run on Windows.

use std::path::Path;

use anyhow::Result;

use crate::runner::{CommandRunner, Invocation};

/// The rule name (both protocols share it).
pub const RULE_NAME: &str = "Paracord on this computer";

/// What the UAC prompt led to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirewallOutcome {
    Allowed,
    /// The person said no to the prompt.
    Declined,
}

fn netsh_add(program: &Path, port: u16, protocol: &str) -> String {
    format!(
        "netsh advfirewall firewall add rule name=\"{RULE_NAME}\" dir=in action=allow program=\"{}\" protocol={protocol} localport={port} enable=yes",
        program.to_string_lossy()
    )
}

fn netsh_delete() -> String {
    format!("netsh advfirewall firewall delete rule name=\"{RULE_NAME}\"")
}

/// Run `cmd /c <command_line>` elevated and wait. A cancelled UAC prompt
/// (`ERROR_CANCELLED`, 1223) prints `declined`.
fn elevated(command_line: &str) -> Invocation {
    let quoted = command_line.replace('\'', "''");
    let script = format!(
        "try {{ $p = Start-Process -FilePath cmd.exe -ArgumentList '/c {quoted}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode }} \
         catch [System.ComponentModel.Win32Exception] {{ if ($_.Exception.NativeErrorCode -eq 1223) {{ 'declined'; exit 0 }} else {{ throw }} }}"
    );
    Invocation::new(
        "powershell.exe",
        [
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script,
        ],
    )
}

/// The invocation that replaces the rule pair for `program` on `port`.
pub fn allow_invocation(program: &Path, port: u16) -> Invocation {
    elevated(&format!(
        "{} >nul 2>&1 & {} && {}",
        netsh_delete(),
        netsh_add(program, port, "TCP"),
        netsh_add(program, port, "UDP")
    ))
}

/// The invocation that deletes the rule pair.
pub fn remove_invocation() -> Invocation {
    elevated(&netsh_delete())
}

fn outcome(runner: &dyn CommandRunner, invocation: &Invocation) -> Result<FirewallOutcome> {
    let output = runner.run(invocation)?;
    if output.success() && output.stdout.trim() == "declined" {
        return Ok(FirewallOutcome::Declined);
    }
    if !output.success() {
        anyhow::bail!(output.describe_failure("netsh"));
    }
    Ok(FirewallOutcome::Allowed)
}

/// Add (or replace) the rule pair; asks for elevation once.
pub fn allow(runner: &dyn CommandRunner, program: &Path, port: u16) -> Result<FirewallOutcome> {
    outcome(runner, &allow_invocation(program, port))
}

/// Does the rule exist? (Reading needs no elevation.)
pub fn rule_exists(runner: &dyn CommandRunner) -> bool {
    runner
        .run(&Invocation::new(
            "netsh",
            [
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={RULE_NAME}"),
            ],
        ))
        .map(|o| o.success())
        .unwrap_or(false)
}

/// Delete the rule pair if it exists; asks for elevation once.
pub fn remove(runner: &dyn CommandRunner) -> Result<FirewallOutcome> {
    if !rule_exists(runner) {
        return Ok(FirewallOutcome::Allowed);
    }
    outcome(runner, &remove_invocation())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::fake::{ok, FakeRunner};

    #[test]
    fn one_prompt_adds_tcp_and_udp_for_the_stable_binary() {
        let inv = allow_invocation(
            Path::new(
                r"C:\Users\Sam\AppData\Local\com.paracord.desktop\host\bin\paracord-host.exe",
            ),
            8443,
        );
        let script = &inv.args[3];
        assert!(script.contains("-Verb RunAs"));
        assert!(script.contains(r#"program="C:\Users\Sam\AppData\Local\com.paracord.desktop\host\bin\paracord-host.exe" protocol=TCP localport=8443"#));
        assert!(script.contains("protocol=UDP localport=8443"));
        assert!(script.contains(r#"delete rule name="Paracord on this computer""#));
    }

    #[test]
    fn a_declined_prompt_is_reported_not_failed() {
        let runner = FakeRunner::new();
        runner.respond(|_| Some(ok("declined\r\n")));
        assert_eq!(
            allow(&runner, Path::new("x"), 8443).unwrap(),
            FirewallOutcome::Declined
        );
    }

    #[test]
    fn single_quotes_in_paths_survive_powershell() {
        let inv = allow_invocation(
            Path::new(r"C:\Users\O'Neil\host\bin\paracord-host.exe"),
            8443,
        );
        assert!(inv.args[3].contains(r"C:\Users\O''Neil\host"));
    }
}
