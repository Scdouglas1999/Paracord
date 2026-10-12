//! `paracord-host` as the desktop app runs it (docs/setup-spec.md §2.1, §2.5,
//! §2.7, §2.8): the real binary, a scratch root, the profile golden file, the
//! control token on a live instance and the log file.
//!
//! The router is never asked for anything: `PARACORD_AUTO_PORT_FORWARD=false`
//! on every start.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const HOST: &str = env!("CARGO_BIN_EXE_paracord-host");
const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn host(args: &[&str]) -> Command {
    let mut command = Command::new(HOST);
    command
        .args(args)
        .env("PARACORD_AUTO_PORT_FORWARD", "false")
        .env("PARACORD_LOG_ANSI", "false")
        .env_remove("PARACORD_AT_REST_KEY_SOURCE")
        .env_remove("PARACORD_AT_REST_KEY")
        .stdin(Stdio::null());
    command
}

fn init(root: &Path, port: &str, key_source: Option<&str>) -> Output {
    let mut command = host(&[
        "init",
        "--profile",
        "desktop-host",
        "--root",
        &root.to_string_lossy(),
        "--port",
        port,
    ]);
    if let Some(source) = key_source {
        command
            .env("PARACORD_AT_REST_KEY_SOURCE", source)
            .env("PARACORD_AT_REST_KEY", KEY);
    }
    command.output().expect("run paracord-host")
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// `golden` keys must all appear in `actual` with equal values.
fn assert_subset(golden: &toml::Value, actual: &toml::Value, path: &str) {
    match golden {
        toml::Value::Table(table) => {
            for (key, expected) in table {
                let found = actual
                    .get(key)
                    .unwrap_or_else(|| panic!("{path}.{key} is missing from the generated config"));
                assert_subset(expected, found, &format!("{path}.{key}"));
            }
        }
        other => assert_eq!(other, actual, "{path}"),
    }
}

#[test]
fn init_writes_the_desktop_host_profile() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("host");
    let out = init(&root, "8443", Some("env"));
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let config_path = root.join("config").join("paracord.toml");
    let actual: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path).unwrap())
        .expect("the generated config is valid TOML");
    let root_str = root.to_string_lossy().replace('\\', "/");
    let golden = include_str!("golden/desktop-host.toml").replace("<ROOT>", &root_str);
    assert_subset(&toml::from_str(&golden).unwrap(), &actual, "");

    // Per-instance values.
    let id = actual["host"]["instance_id"].as_str().unwrap();
    assert_eq!(id.len(), 36, "{id}");
    assert_eq!(&id[14..15], "4", "a version 4 UUID: {id}");
    assert!(!actual["server"]["server_name"].as_str().unwrap().is_empty());
    assert!(actual["auth"]["jwt_secret"].as_str().unwrap().len() >= 32);

    for dir in ["config", "data", "data/certs", "data/backups", "logs"] {
        assert!(root.join(dir).is_dir(), "{dir}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&config_path), 0o600);
        assert_eq!(mode(&root.join("config")), 0o700);
        assert_eq!(mode(&root), 0o700);
    }
}

#[test]
fn init_refuses_a_second_time() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("host");
    assert!(init(&root, "8443", Some("env")).status.success());
    let before = std::fs::read_to_string(root.join("config/paracord.toml")).unwrap();

    let again = init(&root, "9443", Some("env"));
    assert!(!again.status.success());
    assert!(
        String::from_utf8_lossy(&again.stderr).contains("already initialized"),
        "{}",
        String::from_utf8_lossy(&again.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("config/paracord.toml")).unwrap(),
        before,
        "the first config is untouched"
    );
}

#[test]
fn init_writes_nothing_when_the_key_cannot_be_stored() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("host");
    // No key in the environment for the env source.
    let mut command = host(&[
        "init",
        "--profile",
        "desktop-host",
        "--root",
        &root.to_string_lossy(),
        "--port",
        "8443",
    ]);
    command.env("PARACORD_AT_REST_KEY_SOURCE", "env");
    let out = command.output().unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("PARACORD_AT_REST_KEY"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !root.join("config/paracord.toml").exists(),
        "a config that says enabled = true must not exist without a key"
    );
}

#[test]
fn root_and_port_belong_to_the_profile() {
    let out = host(&["init", "--root", "/tmp/not-used", "--port", "8443"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--profile desktop-host"));
}

// ── A live instance ────────────────────────────────────────────────────────

struct Running {
    child: Child,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tokio::test]
async fn a_started_host_guards_its_control_routes_and_keeps_secrets_out_of_its_log() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("host");
    let port = free_port();
    assert!(init(&root, &port.to_string(), Some("env")).status.success());

    let config = root.join("config").join("paracord.toml");
    let log_file: PathBuf = root.join("logs").join("server.log");
    let token_file = root.join("config").join("host-control.token");
    let child = host(&[
        "-c",
        &config.to_string_lossy(),
        "--log-file",
        &log_file.to_string_lossy(),
    ])
    .env("PARACORD_AT_REST_KEY_SOURCE", "env")
    .env("PARACORD_AT_REST_KEY", KEY)
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .expect("start paracord-host");
    let _running = Running { child };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = format!("https://127.0.0.1:{port}/api/v1/host/status");

    // Wait for the instance to answer (it refuses first: no token).
    let started = Instant::now();
    let first = loop {
        match client.get(&url).send().await {
            Ok(response) => break response,
            Err(err) => {
                assert!(
                    started.elapsed() < Duration::from_secs(90),
                    "paracord-host never answered: {err}\n--- log ---\n{}",
                    read(&log_file)
                );
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    };
    assert_eq!(first.status(), 401, "no token");
    let body: serde_json::Value = first.json().await.unwrap();
    assert_eq!(body["code"], "host_auth");

    let wrong = client
        .get(&url)
        .header("Authorization", "Host not-the-token")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);

    let token = read(&token_file);
    assert_eq!(token.trim().len(), 43, "32 bytes, base64url: {token:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&token_file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let good = client
        .get(&url)
        .header("Authorization", format!("Host {}", token.trim()))
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 200);
    let status: serde_json::Value = good.json().await.unwrap();
    assert_eq!(status["setup_required"], true, "{status}");
    assert_eq!(status["backups"]["enabled"], true, "{status}");
    assert_eq!(status["backups"]["keep"], 14, "{status}");
    let fingerprint = status["tls"]["fingerprint_sha256"].as_str().unwrap();
    assert_eq!(fingerprint.len(), 64, "{status}");
    assert_eq!(status["tls"]["self_signed"], true);

    // No plain-HTTP listener: HTTPS only, on the one port.
    let plain = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await;
    assert!(
        plain.map(|r| !r.status().is_success()).unwrap_or(true),
        "plain HTTP must not be served"
    );

    // The log file: written, and free of every secret this run knows.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let log = read(&log_file);
    assert!(!log.is_empty(), "the log file is written");
    assert!(
        !log.contains(token.trim()),
        "control token leaked into the log"
    );
    assert!(!log.contains(KEY), "storage key leaked into the log");
    assert!(
        !log.contains("#claim=") || log.contains("#claim=[redacted]"),
        "claim token leaked into the log:\n{log}"
    );
}
