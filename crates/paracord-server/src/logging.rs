//! Logging for the server and for `paracord-host` (docs/setup-spec.md §2.8).
//!
//! Stdout always gets the compact format. With `--log-file` the same lines
//! are also written to a file with daily rotation (seven rotated files kept)
//! and are passed through [`redact`] first: the file outlives the process, is
//! shown in the app's "Show details", and must never contain a password, key,
//! claim token or the host control token.

use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use chrono::NaiveDate;
use regex::Regex;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Rotated files kept besides the live one.
pub const KEEP_ROTATED: usize = 7;

const REDACTED: &str = "[redacted]";

static KNOWN_SECRETS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Tell the log writer a literal value (the control token, a key) that must be
/// replaced wherever it appears, in addition to the pattern rules.
pub fn register_secret(secret: &str) {
    if secret.len() < 8 {
        return;
    }
    if let Ok(mut known) = KNOWN_SECRETS.lock() {
        if !known.iter().any(|s| s == secret) {
            known.push(secret.to_string());
        }
    }
}

struct Rules {
    authorization: Regex,
    assignment: Regex,
    blob: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        // `Authorization: Host abc` / `Bearer abc`: the scheme word is not the
        // secret, the word after it is.
        authorization: Regex::new(r#"(?i)(authorization\s*[:=]\s*)\S+(\s+\S+)?"#).unwrap(),
        // `token=abc`, `"password": "abc"`, `#claim=abc`, `wrapping_key: abc`.
        assignment: Regex::new(
            r#"(?i)\b((?:[a-z_-]*token|[a-z_-]*password|passphrase|[a-z_-]*secret|claim|[a-z_]*key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)"#,
        )
        .unwrap(),
        // Anything that looks like an opaque credential on its own.
        blob: Regex::new(r"[A-Za-z0-9_-]{40,}").unwrap(),
    })
}

/// Remove secrets from text bound for a log file.
pub fn redact(text: &str) -> Cow<'_, str> {
    let rules = rules();
    let mut out = Cow::Borrowed(text);
    if let Ok(known) = KNOWN_SECRETS.lock() {
        for secret in known.iter() {
            if out.contains(secret.as_str()) {
                out = Cow::Owned(out.replace(secret.as_str(), REDACTED));
            }
        }
    }
    for (regex, replacement) in [
        (&rules.authorization, format!("${{1}}{REDACTED}")),
        (&rules.assignment, format!("${{1}}{REDACTED}")),
        (&rules.blob, REDACTED.to_string()),
    ] {
        if regex.is_match(&out) {
            out = Cow::Owned(regex.replace_all(&out, replacement.as_str()).into_owned());
        }
    }
    out
}

// ── Daily rotation ──────────────────────────────────────────────────────────

struct State {
    path: PathBuf,
    file: File,
    /// The day the live file's lines belong to.
    day: NaiveDate,
    keep: usize,
}

fn rotated_name(path: &Path, day: NaiveDate) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{day}"));
    path.with_file_name(name)
}

fn open_append(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn local_today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

impl State {
    fn open(path: &Path, keep: usize, today: NaiveDate) -> io::Result<Self> {
        // A live file left from an earlier day is that day's log: rotate it
        // now instead of mixing two days.
        let existing_day = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| chrono::DateTime::<chrono::Local>::from(t).date_naive());
        if let Some(day) = existing_day.filter(|d| *d < today) {
            fs::rename(path, rotated_name(path, day))?;
        }
        let state = State {
            path: path.to_path_buf(),
            file: open_append(path)?,
            day: today,
            keep,
        };
        state.prune();
        Ok(state)
    }

    fn rotate(&mut self, today: NaiveDate) -> io::Result<()> {
        self.file.flush()?;
        fs::rename(&self.path, rotated_name(&self.path, self.day))?;
        self.file = open_append(&self.path)?;
        self.day = today;
        self.prune();
        Ok(())
    }

    /// Delete rotated files beyond `keep`, oldest first.
    fn prune(&self) {
        let Some(dir) = self.path.parent() else {
            return;
        };
        let Some(base) = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
        else {
            return;
        };
        let prefix = format!("{base}.");
        let mut rotated: Vec<(NaiveDate, PathBuf)> = fs::read_dir(if dir.as_os_str().is_empty() {
            Path::new(".")
        } else {
            dir
        })
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let day = name.strip_prefix(&prefix)?.parse::<NaiveDate>().ok()?;
            Some((day, entry.path()))
        })
        .collect();
        rotated.sort_by_key(|(day, _)| std::cmp::Reverse(*day));
        for (_, old) in rotated.into_iter().skip(self.keep) {
            let _ = fs::remove_file(old);
        }
    }

    fn write(&mut self, today: NaiveDate, buf: &[u8]) -> io::Result<usize> {
        if today > self.day {
            self.rotate(today)?;
        }
        let text = String::from_utf8_lossy(buf);
        let clean = redact(&text);
        self.file.write_all(clean.as_bytes())?;
        Ok(buf.len())
    }
}

/// A shared handle on the live log file; cheap to clone.
#[derive(Clone)]
pub struct RotatingLog {
    state: Arc<Mutex<State>>,
}

impl RotatingLog {
    pub fn open(path: &Path, keep: usize) -> io::Result<Self> {
        Self::open_at(path, keep, local_today())
    }

    fn open_at(path: &Path, keep: usize, today: NaiveDate) -> io::Result<Self> {
        Ok(Self {
            state: Arc::new(Mutex::new(State::open(path, keep, today)?)),
        })
    }

    #[cfg(test)]
    fn write_at(&self, today: NaiveDate, buf: &[u8]) -> io::Result<usize> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("log lock poisoned"))?
            .write(today, buf)
    }
}

pub struct LogWriter(RotatingLog);

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .state
            .lock()
            .map_err(|_| io::Error::other("log lock poisoned"))?
            .write(local_today(), buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0
            .state
            .lock()
            .map_err(|_| io::Error::other("log lock poisoned"))?
            .file
            .flush()
    }
}

impl<'a> MakeWriter<'a> for RotatingLog {
    type Writer = LogWriter;
    fn make_writer(&'a self) -> Self::Writer {
        LogWriter(self.clone())
    }
}

/// Install the global subscriber: stdout, plus `log_file` when given.
pub fn init(log_file: Option<&Path>, ansi: bool, default_filter: &str) -> Result<()> {
    let filter =
        || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
    let stdout = tracing_subscriber::fmt::layer()
        .compact()
        .with_target(false)
        .with_ansi(ansi)
        .with_filter(filter());
    let file = match log_file {
        Some(path) => {
            let log = RotatingLog::open(path, KEEP_ROTATED)
                .with_context(|| format!("cannot open the log file {}", path.display()))?;
            Some(
                tracing_subscriber::fmt::layer()
                    .compact()
                    .with_target(false)
                    .with_ansi(false)
                    .with_writer(log)
                    .with_filter(filter()),
            )
        }
        None => None,
    };
    tracing_subscriber::registry()
        .with(stdout)
        .with(file)
        .init();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn secrets_are_removed_from_log_lines() {
        let cases = [
            ("login token=abcdef0123456789 ok", "token=[redacted]"),
            (
                "control_token: s3cr3t-value here",
                "control_token: [redacted]",
            ),
            (
                r#"{"password": "hunter2hunter2"}"#,
                r#""password": [redacted]"#,
            ),
            (
                "Open https://x/setup-server#claim=AAAA_bbbb-CCCC1234 now",
                "#claim=[redacted]",
            ),
            ("Authorization: Host abc123def", "Authorization: [redacted]"),
            ("wrapping_key=Zm9vYmFy", "wrapping_key=[redacted]"),
            (
                "stored 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "stored [redacted]",
            ),
        ];
        for (input, expected_fragment) in cases {
            let out = redact(input);
            assert!(out.contains(expected_fragment), "{input} -> {out}");
        }
        let out = redact("login token=abcdef0123456789 ok");
        assert!(!out.contains("abcdef0123456789"), "{out}");
        let out = redact("Authorization: Host abc123def");
        assert!(!out.contains("abc123def"), "{out}");
    }

    #[test]
    fn ordinary_lines_pass_through_untouched() {
        let line = "Listening on https://0.0.0.0:8443 (instance 3f2b9c1e-0a4d-4e1b-8c55-2f6d1f0a9b77, key_source keychain)";
        assert!(matches!(redact(line), Cow::Borrowed(_)), "{}", redact(line));
    }

    #[test]
    fn registered_secrets_are_removed_wherever_they_appear() {
        register_secret("host-token-9f8e7d6c");
        let out = redact("sent Host host-token-9f8e7d6c to 127.0.0.1");
        assert!(!out.contains("host-token-9f8e7d6c"), "{out}");
    }

    #[test]
    fn rotates_daily_and_keeps_seven() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("host.log");
        let log = RotatingLog::open_at(&path, KEEP_ROTATED, day("2026-01-01")).unwrap();
        for d in 1..=12 {
            let today = day("2026-01-01") + chrono::Duration::days(d - 1);
            log.write_at(today, format!("line for day {d}\n").as_bytes())
                .unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        // The live file plus the seven newest rotated days (Jan 5 .. Jan 11).
        assert_eq!(names.len(), 8, "{names:?}");
        assert!(names.contains(&"host.log".to_string()));
        assert!(names.contains(&"host.log.2026-01-11".to_string()));
        assert!(names.contains(&"host.log.2026-01-05".to_string()));
        assert!(!names.contains(&"host.log.2026-01-04".to_string()));
        assert_eq!(fs::read_to_string(&path).unwrap(), "line for day 12\n");
        assert_eq!(
            fs::read_to_string(path.with_file_name("host.log.2026-01-11")).unwrap(),
            "line for day 11\n"
        );
    }

    #[test]
    fn the_file_never_receives_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.log");
        let log = RotatingLog::open_at(&path, KEEP_ROTATED, day("2026-02-02")).unwrap();
        log.write_at(
            day("2026-02-02"),
            b"INFO claim link http://x/setup-server#claim=0123456789abcdef\n",
        )
        .unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(!contents.contains("0123456789abcdef"), "{contents}");
        assert!(contents.contains("#claim=[redacted]"), "{contents}");
    }

    #[test]
    fn a_stale_live_file_is_rotated_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.log");
        fs::write(&path, "old\n").unwrap();
        let tomorrow = local_today() + chrono::Duration::days(1);
        let log = RotatingLog::open_at(&path, KEEP_ROTATED, tomorrow).unwrap();
        log.write_at(tomorrow, b"new\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        assert_eq!(
            fs::read_to_string(rotated_name(&path, local_today())).unwrap(),
            "old\n"
        );
    }
}
