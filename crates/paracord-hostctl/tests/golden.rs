//! Golden files for the three service definitions (spec §2.4). They render on
//! every OS from explicit specs; on its own OS each one is also rebuilt from
//! `ServiceSpec::for_host`, so the paths the app really uses are covered by
//! the CI job of that OS.
//!
//! Regenerate after an intended change with
//! `UPDATE_GOLDEN=1 cargo test -p paracord-hostctl --test golden` and read the diff.

use std::path::{Path, PathBuf};

use paracord_hostctl::service::{launchd, schtasks, systemd};
use paracord_hostctl::{ServiceNames, ServiceSpec};

fn golden(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing ({e}); run with UPDATE_GOLDEN=1",
            path.display()
        )
    });
    assert_eq!(actual, expected, "{} differs", path.display());
}

fn spec(root: &str, sep: &str, exe: &str) -> ServiceSpec {
    let p = |parts: &[&str]| {
        PathBuf::from(
            std::iter::once(root)
                .chain(parts.iter().copied())
                .collect::<Vec<_>>()
                .join(sep),
        )
    };
    ServiceSpec {
        names: ServiceNames::production(),
        program: p(&["bin", &format!("paracord-host{exe}")]),
        args: vec![
            "-c".into(),
            p(&["config", "paracord.toml"])
                .to_string_lossy()
                .into_owned(),
            "--log-file".into(),
            p(&["logs", "server.log"]).to_string_lossy().into_owned(),
        ],
        working_dir: PathBuf::from(root),
        launchd_log: p(&["logs", "launchd.log"]),
        autostart: true,
    }
}

const LINUX_ROOT: &str = "/home/sam/.local/share/com.paracord.desktop/host";
const MACOS_ROOT: &str = "/Users/sam/Library/Application Support/com.paracord.desktop/host";
const WINDOWS_ROOT: &str = r"C:\Users\Sam\AppData\Local\com.paracord.desktop\host";

fn linux_spec() -> ServiceSpec {
    spec(LINUX_ROOT, "/", "")
}
fn macos_spec() -> ServiceSpec {
    spec(MACOS_ROOT, "/", "")
}
fn windows_spec() -> ServiceSpec {
    spec(WINDOWS_ROOT, "\\", ".exe")
}

#[test]
fn systemd_user_unit() {
    golden(
        "paracord-host.service",
        &systemd::render_unit(&linux_spec()),
    );
}

#[test]
fn scheduled_task_xml() {
    golden(
        "paracord-host-task.xml",
        &schtasks::render_task_xml(&windows_spec(), r"SAMS-PC\Sam"),
    );
}

#[test]
fn launch_agent_plist() {
    golden(
        "com.paracord.desktop.host.plist",
        &launchd::render_plist(&macos_spec()),
    );
}

#[test]
fn the_unit_is_the_spec_text() {
    // §2.4 verbatim, with <host> filled in.
    let unit = systemd::render_unit(&linux_spec());
    assert!(unit.contains(&format!(
        "ExecStart={LINUX_ROOT}/bin/paracord-host -c {LINUX_ROOT}/config/paracord.toml --log-file {LINUX_ROOT}/logs/server.log\n"
    )));
    for line in [
        "Description=Paracord on this computer",
        "After=default.target",
        "Type=exec",
        "Restart=on-failure",
        "RestartSec=5",
        "RestartPreventExitStatus=78",
        "Nice=5",
        "WantedBy=default.target",
    ] {
        assert!(unit.lines().any(|l| l == line), "missing {line}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn for_host_on_linux_matches_the_golden() {
    let layout = paracord_hostctl::HostLayout::new(LINUX_ROOT);
    let real = ServiceSpec::for_host(
        ServiceNames::production(),
        &layout,
        &layout.default_config(),
        true,
    );
    assert_eq!(real, linux_spec());
}

#[cfg(target_os = "macos")]
#[test]
fn for_host_on_macos_matches_the_golden() {
    let layout = paracord_hostctl::HostLayout::new(MACOS_ROOT);
    let real = ServiceSpec::for_host(
        ServiceNames::production(),
        &layout,
        &layout.default_config(),
        true,
    );
    assert_eq!(real, macos_spec());
}

#[cfg(windows)]
#[test]
fn for_host_on_windows_matches_the_golden() {
    let layout = paracord_hostctl::HostLayout::new(WINDOWS_ROOT);
    let real = ServiceSpec::for_host(
        ServiceNames::production(),
        &layout,
        &layout.default_config(),
        true,
    );
    assert_eq!(real, windows_spec());
}
