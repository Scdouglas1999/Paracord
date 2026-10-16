//! Running the host binary for one-shot work: `--version`, `init` and
//! `restore-backup`.

use std::cmp::Ordering;
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::layout::HostLayout;
use crate::runner::{path_arg, CommandOutput, CommandRunner, Invocation};

/// `paracord-host --version` prints `paracord-server 3.4.0`; the version is
/// the last word.
pub fn version(runner: &dyn CommandRunner, binary: &Path) -> Result<String> {
    let output = runner.run(&Invocation::new(&path_arg(binary), ["--version"]))?;
    if !output.success() {
        bail!(output.describe_failure("--version"));
    }
    let word = output
        .stdout
        .split_whitespace()
        .last()
        .context("--version printed nothing")?;
    if parse_version(word).is_none() {
        bail!("--version printed {word:?}, which is not a version");
    }
    Ok(word.to_string())
}

/// `major.minor.patch[-pre]` as numbers plus "is a pre-release".
fn parse_version(text: &str) -> Option<(Vec<u64>, bool)> {
    let (core, pre) = match text.split_once('-') {
        Some((core, _)) => (core, true),
        None => (text.split('+').next().unwrap_or(text), false),
    };
    let parts: Option<Vec<u64>> = core.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty()).map(|p| (p, pre))
}

/// Compare two versions; `None` if either does not parse. A pre-release is
/// older than its release.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (mut a, a_pre) = parse_version(a)?;
    let (mut b, b_pre) = parse_version(b)?;
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    Some(a.cmp(&b).then(match (a_pre, b_pre) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => Ordering::Equal,
    }))
}

/// `paracord-host --log-file <log> init --profile desktop-host --root <root> --port <port>`.
pub fn init_invocation(layout: &HostLayout, port: u16) -> Invocation {
    Invocation::new(
        &path_arg(&layout.binary()),
        [
            "--log-file".to_string(),
            path_arg(&layout.server_log()),
            "init".to_string(),
            "--profile".to_string(),
            "desktop-host".to_string(),
            "--root".to_string(),
            path_arg(layout.root()),
            "--port".to_string(),
            port.to_string(),
        ],
    )
}

/// `paracord-host forget-storage-key`: the host binary deletes the storage
/// key it made (on macOS a keychain item belongs to the program that made it).
pub fn forget_storage_key_invocation(binary: &Path, service: &str, account: &str) -> Invocation {
    Invocation::new(
        &path_arg(binary),
        [
            "forget-storage-key".to_string(),
            "--service".to_string(),
            service.to_string(),
            "--account".to_string(),
            account.to_string(),
        ],
    )
}

/// The `instance_id:` line of `init`'s four printed lines (S6).
pub fn instance_id_from_init(output: &CommandOutput) -> Option<String> {
    output.stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix("instance_id:")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// `paracord-host -c <config> --log-file <log> restore-backup --archive <a> --output-dir <dir> [--escrow-key-stdin]`.
pub fn restore_invocation(
    layout: &HostLayout,
    config: &Path,
    archive: &Path,
    output_dir: &Path,
    escrow_key: Option<&str>,
) -> Invocation {
    let mut args = vec![
        "-c".to_string(),
        path_arg(config),
        "--log-file".to_string(),
        path_arg(&layout.server_log()),
        "restore-backup".to_string(),
        "--archive".to_string(),
        path_arg(archive),
        "--output-dir".to_string(),
        path_arg(output_dir),
    ];
    match escrow_key {
        Some(key) => {
            args.push("--escrow-key-stdin".to_string());
            Invocation::new(&path_arg(&layout.binary()), args)
                .with_stdin(format!("{key}\n").into_bytes())
        }
        None => Invocation::new(&path_arg(&layout.binary()), args),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::fake::{ok, FakeRunner};

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("3.10.0", "3.9.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("3.4.0", "3.4"), Some(Ordering::Equal));
        assert_eq!(
            compare_versions("3.4.0-rc.1", "3.4.0"),
            Some(Ordering::Less)
        );
        assert_eq!(compare_versions("x", "3.4.0"), None);
    }

    #[test]
    fn version_reads_the_last_word() {
        let runner = FakeRunner::new();
        runner.respond(|_| Some(ok("paracord-server 3.4.0\n")));
        assert_eq!(
            version(&runner, Path::new("/h/bin/paracord-host")).unwrap(),
            "3.4.0"
        );
        assert_eq!(runner.lines(), ["/h/bin/paracord-host --version"]);
    }

    #[test]
    fn init_line_and_instance_id() {
        let layout = HostLayout::new("/h");
        assert_eq!(
            init_invocation(&layout, 8443).display(),
            format!(
                "/h/bin/paracord-host{} --log-file /h/logs/server.log init --profile desktop-host --root /h --port 8443",
                std::env::consts::EXE_SUFFIX
            )
        );
        let printed = ok("Initialized Paracord on this computer\n  root:        /h\n  config:      /h/config/paracord.toml\n  port:        8443\n  instance_id: 2b0e-77\n");
        assert_eq!(instance_id_from_init(&printed).as_deref(), Some("2b0e-77"));
    }

    #[test]
    fn restore_sends_the_escrow_key_on_stdin_only() {
        let layout = HostLayout::new("/h");
        let inv = restore_invocation(
            &layout,
            Path::new("/h/config/paracord.toml"),
            Path::new("/b/a.tar.gz"),
            Path::new("/h/restores/x"),
            Some("KEY"),
        );
        assert!(inv.display().ends_with(
            "restore-backup --archive /b/a.tar.gz --output-dir /h/restores/x --escrow-key-stdin"
        ));
        assert!(!inv.display().contains("KEY"));
        assert_eq!(inv.stdin.as_deref(), Some(&b"KEY\n"[..]));
    }
}
