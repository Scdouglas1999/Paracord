//! Running the platform's service tools (`systemctl`, `schtasks`, `launchctl`,
//! `netsh`, `powershell`) and the host binary. Everything goes through
//! [`CommandRunner`] so tests can record the exact commands without touching
//! the machine's service manager.

use std::io::{self, Write};
use std::path::Path;
use std::process::{Command, Stdio};

/// What a finished command produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandOutput {
    /// `None` when the process was killed by a signal.
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }

    /// The last non-empty line of stderr, else of stdout: the "reason line" a
    /// failing command prints (spec §2.6 `init`).
    pub fn reason_line(&self) -> String {
        last_line(&self.stderr)
            .or_else(|| last_line(&self.stdout))
            .unwrap_or_else(|| match self.status {
                Some(code) => format!("exited with status {code}"),
                None => "was stopped by a signal".to_string(),
            })
    }

    /// `"<program>: <reason>"`-style summary for error messages.
    pub fn describe_failure(&self, what: &str) -> String {
        format!("{what} failed: {}", self.reason_line())
    }
}

fn last_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// One command invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    /// Bytes written to stdin, if any.
    pub stdin: Option<Vec<u8>>,
}

impl Invocation {
    pub fn new<I, S>(program: &str, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            program: program.to_string(),
            args: args.into_iter().map(Into::into).collect(),
            stdin: None,
        }
    }

    pub fn with_stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// `program arg arg` for logs and test assertions (stdin never shown).
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub trait CommandRunner: Send + Sync {
    /// Run to completion. An `Err` means the program could not be started.
    fn run(&self, invocation: &Invocation) -> io::Result<CommandOutput>;
}

/// Runs real processes. On Windows they get `CREATE_NO_WINDOW`, so no console
/// flashes up from the desktop app.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, invocation: &Invocation) -> io::Result<CommandOutput> {
        let mut command = Command::new(&invocation.program);
        command
            .args(&invocation.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if invocation.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = spawn_retrying_busy(&mut command).map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("couldn't run {} ({e})", invocation.program),
            )
        })?;
        if let Some(bytes) = &invocation.stdin {
            if let Some(mut stdin) = child.stdin.take() {
                // A program that exits without reading its input closes the
                // pipe; its exit status is the answer, not the write error.
                match stdin.write_all(bytes) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::BrokenPipe => {}
                    Err(e) => return Err(e),
                }
            }
        }
        let output = child.wait_with_output()?;
        Ok(CommandOutput {
            status: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Spawn, retrying `ETXTBSY` for a moment. Running a binary just after
/// writing it (setup's `install` then `--version`) races with any other
/// thread's fork: the child holds the write descriptor until it execs, and
/// the kernel refuses to execute a file open for writing.
fn spawn_retrying_busy(command: &mut Command) -> io::Result<std::process::Child> {
    const ETXTBSY: i32 = 26;
    let mut attempts = 0;
    loop {
        match command.spawn() {
            Err(e)
                if cfg!(target_os = "linux")
                    && e.raw_os_error() == Some(ETXTBSY)
                    && attempts < 50 =>
            {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

/// Run and require exit status 0; the error carries the reason line.
pub fn run_checked(
    runner: &dyn CommandRunner,
    invocation: &Invocation,
) -> anyhow::Result<CommandOutput> {
    let output = runner.run(invocation)?;
    if !output.success() {
        anyhow::bail!(output.describe_failure(&invocation.program));
    }
    Ok(output)
}

/// A path as a command argument.
pub fn path_arg(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
pub(crate) mod fake {
    //! A runner that records invocations and answers from a script.

    use super::*;
    use std::sync::Mutex;

    type Responder = Box<dyn Fn(&Invocation) -> Option<CommandOutput> + Send + Sync>;

    #[derive(Default)]
    pub struct FakeRunner {
        pub calls: Mutex<Vec<Invocation>>,
        responders: Mutex<Vec<Responder>>,
    }

    impl FakeRunner {
        pub fn new() -> Self {
            Self::default()
        }

        /// The first matching responder answers; unmatched calls succeed with
        /// empty output.
        pub fn respond(
            &self,
            f: impl Fn(&Invocation) -> Option<CommandOutput> + Send + Sync + 'static,
        ) {
            self.responders.lock().unwrap().push(Box::new(f));
        }

        pub fn lines(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(Invocation::display)
                .collect()
        }
    }

    pub fn ok(stdout: &str) -> CommandOutput {
        CommandOutput {
            status: Some(0),
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }

    pub fn fail(code: i32, stderr: &str) -> CommandOutput {
        CommandOutput {
            status: Some(code),
            stdout: String::new(),
            stderr: stderr.to_string(),
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, invocation: &Invocation) -> io::Result<CommandOutput> {
            self.calls.lock().unwrap().push(invocation.clone());
            for responder in self.responders.lock().unwrap().iter() {
                if let Some(output) = responder(invocation) {
                    return Ok(output);
                }
            }
            Ok(ok(""))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_line_is_the_last_thing_said() {
        let out = CommandOutput {
            status: Some(1),
            stdout: "Initializing\n".into(),
            stderr: "warning: x\nError: already initialized\n\n".into(),
        };
        assert_eq!(out.reason_line(), "Error: already initialized");
        let silent = CommandOutput {
            status: Some(3),
            ..Default::default()
        };
        assert_eq!(silent.reason_line(), "exited with status 3");
    }
}
