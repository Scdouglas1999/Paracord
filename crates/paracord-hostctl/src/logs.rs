//! The tail of the server log for **Show details** (spec §1.7, §2.8).

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Never return more than this many lines.
pub const MAX_LINES: usize = 1000;
/// Only the end of the file is read.
const MAX_BYTES: u64 = 1 << 20;

/// The last `lines` lines of `path` (at most [`MAX_LINES`]).
pub fn tail(path: &Path, lines: usize) -> std::io::Result<String> {
    let lines = lines.clamp(1, MAX_LINES);
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut all: Vec<&str> = text.lines().collect();
    if start > 0 && !all.is_empty() {
        // The first line was cut by the byte window.
        all.remove(0);
    }
    let from = all.len().saturating_sub(lines);
    let mut out = all[from..].join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

/// The most telling line about a storage-key failure (exit 78), else the
/// last line of the log.
pub fn storage_key_reason(path: &Path) -> Option<String> {
    let text = tail(path, 200).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines
        .iter()
        .rev()
        .find(|l| l.contains("at-rest key"))
        .or_else(|| lines.last())
        .map(|l| {
            // "… at-rest key: the system keychain is locked …" → the part after
            // the label, which is the reason in words.
            match l.find("at-rest key:") {
                Some(i) => l[i + "at-rest key:".len()..].trim().to_string(),
                None => l.to_string(),
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_returns_the_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        let body: String = (1..=300).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, body).unwrap();
        let out = tail(&path, 200).unwrap();
        assert_eq!(out.lines().count(), 200);
        assert!(out.starts_with("line 101\n"));
        assert!(out.ends_with("line 300\n"));
        assert_eq!(tail(&path, 0).unwrap(), "line 300\n");
    }

    #[test]
    fn storage_key_reason_finds_the_at_rest_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        std::fs::write(
            &path,
            "INFO starting\nERROR at-rest key: the system keychain is locked or not running (Secret Service: no bus)\nINFO exiting\n",
        )
        .unwrap();
        assert_eq!(
            storage_key_reason(&path).unwrap(),
            "the system keychain is locked or not running (Secret Service: no bus)"
        );
    }
}
