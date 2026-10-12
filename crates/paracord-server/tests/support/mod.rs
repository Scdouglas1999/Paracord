//! Running the real `paracord-server` binary against a scratch directory.
#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// The identity private key of the S1 credential vectors
/// (`client/src/lib/credential/vectors.json`, `wrap[0]`) and its public key.
pub const VECTOR_IDENTITY_PRIVATE_KEY: &str =
    "d2cb3a96fd540c24f68825716fdb1e8c2549542d67fd5d25107635c2959f8d9c";
pub const VECTOR_IDENTITY_PUBLIC_KEY: &str =
    "ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4";

/// A scratch server directory; the binary runs with it as its working
/// directory, so the generated config's `./data/...` paths land inside.
pub struct Scratch {
    pub dir: tempfile::TempDir,
}

impl Scratch {
    pub fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("scratch dir"),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn config(&self) -> PathBuf {
        self.path().join("config/paracord.toml")
    }

    pub fn db(&self) -> PathBuf {
        self.path().join("data/paracord.db")
    }

    pub fn db_url(&self) -> String {
        format!("sqlite://{}?mode=rwc", self.db().display())
    }

    /// `paracord-server` with no inherited `PARACORD_*` settings and no way to
    /// reach a session bus, so nothing here can touch a real keychain.
    pub fn server(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_paracord-server"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("PARACORD_") {
                command.env_remove(key);
            }
        }
        command
            .current_dir(self.path())
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                "unix:path=/nonexistent/paracord-test-bus",
            )
            .env("PARACORD_LOG_ANSI", "false")
            .env("RUST_LOG", "warn,paracord_server=info")
            .args(["-c", "config/paracord.toml"]);
        command
    }

    pub fn config_text(&self) -> String {
        std::fs::read_to_string(self.config()).expect("config")
    }

    pub fn config_toml(&self) -> toml::Value {
        toml::from_str(&self.config_text()).expect("config parses")
    }

    /// Replace `key = …` inside `[section]` of the config file.
    pub fn set_config(&self, section: &str, key: &str, raw: &str) {
        let mut out = Vec::new();
        let mut current = String::new();
        let mut done = false;
        let text = self.config_text();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                if current == section && !done {
                    out.push(format!("{key} = {raw}"));
                    done = true;
                }
                current = trimmed.trim_matches(['[', ']']).to_string();
            } else if current == section && !trimmed.starts_with('#') {
                if let Some((lhs, _)) = trimmed.split_once('=') {
                    if lhs.trim() == key {
                        out.push(format!("{key} = {raw}"));
                        done = true;
                        continue;
                    }
                }
            }
            out.push(line.to_string());
        }
        if !done {
            assert_eq!(current, section, "section [{section}] not found");
            out.push(format!("{key} = {raw}"));
        }
        std::fs::write(self.config(), out.join("\n") + "\n").expect("write config");
    }

    /// `init` with stored-data encryption left off, like a server from before
    /// encryption existed.
    pub fn init_plaintext(&self) {
        let output = self
            .server()
            .env("PARACORD_AT_REST_ENABLED", "false")
            .arg("init")
            .output()
            .expect("run init");
        assert_success(&output, "init");
        assert_eq!(
            self.config_toml()["at_rest"]["enabled"].as_bool(),
            Some(false)
        );
    }
}

/// Environment for a full start on loopback ports that do not collide.
pub fn listen_env(command: &mut Command, port: u16) -> &mut Command {
    command
        .env("PARACORD_BIND_ADDRESS", format!("127.0.0.1:{port}"))
        .env("PARACORD_TLS_ENABLED", "false")
        .env("PARACORD_VOICE_PORT", (port + 1).to_string())
        .env("PARACORD_AUTO_PORT_FORWARD", "false")
        .env(
            "PARACORD_JWT_SECRET",
            "at-rest-test-jwt-secret-0123456789abcdef0123456789",
        )
}

pub fn assert_success(output: &Output, what: &str) {
    assert!(
        output.status.success(),
        "{what} failed ({:?})\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Run to completion, killing it after `limit`.
pub fn run_with_timeout(command: &mut Command, limit: Duration) -> Output {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let deadline = Instant::now() + limit;
    loop {
        if child.try_wait().expect("wait").is_some() {
            return child.wait_with_output().expect("output");
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let output = child.wait_with_output().expect("output");
            panic!(
                "did not exit within {limit:?}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Run with `input` on standard input.
pub fn run_with_stdin(command: &mut Command, input: &str) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().expect("output")
}

/// Start the server and wait until `/api/v1/health` answers 200.
pub fn start_until_healthy(command: &mut Command, port: u16) -> Child {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server");
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some(status) = child.try_wait().expect("wait") {
            let mut stderr = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .ok();
            panic!("server exited early ({status}):\n{stderr}");
        }
        if health_ok(port) {
            return child;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("server did not become healthy");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200")
}

pub fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub fn unhex(raw: &str) -> Vec<u8> {
    paracord_util::hex::hex_decode(raw).expect("hex")
}

pub fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The key a `file` source holds.
pub fn read_key_file(path: &Path) -> [u8; 32] {
    paracord_util::at_rest::parse_master_key(&std::fs::read_to_string(path).expect("key file"))
        .expect("a storage key")
}
