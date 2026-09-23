//! Whether this server asks the home router to let people outside the network
//! in (`[network] auto_port_forward`), and changing that from the admin page.
//!
//! The router is asked once, at startup, before the database is even open, so
//! the setting lives in the config file rather than in `server_settings`. An
//! admin change is written back into that file and takes effect on the next
//! start; until then the page says a restart is needed.
//!
//! Process-wide for the same reason as [`crate::share_address`]: it is a fact
//! about how this process was started, learned before the app state exists.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

/// The environment variable that overrides the config file's value.
pub const ENV_OVERRIDE: &str = "PARACORD_AUTO_PORT_FORWARD";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouterAccess {
    /// What this process started with: whether it asked the router.
    pub running: bool,
    /// What the config file says now. Differs from `running` after an admin
    /// change, until the next restart.
    pub saved: bool,
    /// True when `PARACORD_AUTO_PORT_FORWARD` decides the value, so a change
    /// written to the config file would have no effect.
    pub env_override: bool,
    /// True when the server only listens on this computer, so there is nothing
    /// for the router to forward whatever the setting says.
    pub loopback_bind: bool,
    /// The config file a change is written to. `None` when the process was not
    /// started from one (tests).
    pub config_path: Option<PathBuf>,
}

/// The admin page's view of [`RouterAccess`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RouterAccessView {
    /// Whether the running server asked the router to let people in.
    pub running: bool,
    /// Whether it will ask after the next restart.
    pub saved: bool,
    pub restart_required: bool,
    /// Set when the environment variable decides this and the page cannot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_by: Option<&'static str>,
    pub loopback_bind: bool,
}

impl RouterAccess {
    pub fn view(&self) -> RouterAccessView {
        RouterAccessView {
            running: self.running,
            saved: self.saved,
            restart_required: self.running != self.saved,
            locked_by: self.env_override.then_some(ENV_OVERRIDE),
            loopback_bind: self.loopback_bind,
        }
    }
}

fn cell() -> &'static RwLock<RouterAccess> {
    static CELL: OnceLock<RwLock<RouterAccess>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(RouterAccess::default()))
}

/// Record how startup configured the router request.
pub fn init(access: RouterAccess) {
    match cell().write() {
        Ok(mut guard) => *guard = access,
        Err(poisoned) => *poisoned.into_inner() = access,
    }
}

pub fn current() -> RouterAccess {
    match cell().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error(
        "This is set by the PARACORD_AUTO_PORT_FORWARD environment variable where the server is started, so it can't be changed here. Change it there, then restart the server."
    )]
    EnvOverride,
    #[error("This server was not started from a config file, so there is nowhere to save this.")]
    NoConfigFile,
    #[error("Paracord couldn't save this to its config file ({path}): {reason}. Set auto_port_forward under [network] in that file by hand, then restart the server.")]
    Write { path: String, reason: String },
}

/// Write `[network] auto_port_forward = <enabled>` into the config file and
/// remember it as the saved value. The running server is not changed.
pub fn save_choice(enabled: bool) -> Result<RouterAccess, SaveError> {
    let state = current();
    if state.env_override {
        return Err(SaveError::EnvOverride);
    }
    let path = state.config_path.clone().ok_or(SaveError::NoConfigFile)?;
    let write_error = |reason: String| SaveError::Write {
        path: path.display().to_string(),
        reason,
    };
    let text = std::fs::read_to_string(&path).map_err(|e| write_error(e.to_string()))?;
    let updated = set_bool_key(&text, "network", "auto_port_forward", enabled);
    replace_file_contents(&path, &updated).map_err(|e| write_error(e.to_string()))?;

    let mut next = state;
    next.saved = enabled;
    init(next.clone());
    Ok(next)
}

/// Replace the file's contents while keeping who may read it. The config holds
/// the JWT secret, so it must never pass through a more permissive file.
fn replace_file_contents(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let permissions = std::fs::metadata(path)?.permissions();
        let mut tmp_name = path.as_os_str().to_owned();
        tmp_name.push(".saving");
        let tmp = PathBuf::from(tmp_name);
        let _ = std::fs::remove_file(&tmp);
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            std::fs::set_permissions(&tmp, permissions)?;
            std::fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
    #[cfg(not(unix))]
    {
        // Rewritten in place: on Windows a renamed replacement would take the
        // directory's inherited ACL and lose the owner-only one on this file.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    }
}

/// Set `key = true|false` inside `[section]` of a TOML document, as text, so
/// every comment and every other line survives untouched.
///
/// An existing (uncommented) assignment is replaced in place. A section without
/// the key gets it right under its header, and a document without the section
/// gets the section appended.
pub fn set_bool_key(text: &str, section: &str, key: &str, value: bool) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let assignment = format!("{key} = {value}");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();

    let mut current: Option<String> = None;
    let mut header_index: Option<usize> = None;
    let mut replaced = false;
    for (index, line) in lines.iter_mut().enumerate() {
        let trimmed = line.trim();
        if let Some(name) = section_name(trimmed) {
            current = Some(name.to_string());
            if name == section && header_index.is_none() {
                header_index = Some(index);
            }
            continue;
        }
        if current.as_deref() != Some(section) || trimmed.starts_with('#') {
            continue;
        }
        let Some((lhs, _)) = trimmed.split_once('=') else {
            continue;
        };
        if lhs.trim() == key {
            let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
            *line = format!("{indent}{assignment}");
            replaced = true;
            break;
        }
    }

    if !replaced {
        match header_index {
            Some(index) => lines.insert(index + 1, assignment),
            None => {
                if lines.last().is_some_and(|last| !last.trim().is_empty()) {
                    lines.push(String::new());
                }
                lines.push(format!("[{section}]"));
                lines.push(assignment);
            }
        }
    }

    let mut out = lines.join(newline);
    if text.is_empty() || text.ends_with('\n') || !replaced {
        out.push_str(newline);
    }
    out
}

/// `[name]` → `name`, ignoring a trailing comment. `None` for anything that is
/// not a table header (including `[[array]]` headers, which never hold these keys).
fn section_name(trimmed: &str) -> Option<&str> {
    let without_comment = trimmed.split('#').next().unwrap_or("").trim();
    let inner = without_comment.strip_prefix('[')?.strip_suffix(']')?;
    if inner.starts_with('[') {
        return None;
    }
    Some(inner.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATED: &str = "[auth]\nregistration_enabled = true\n\n[network]\n# Ask your router.\nauto_port_forward = false\nport_forward_lease_seconds = 3600\n\n[tls]\nenabled = true\n";

    #[test]
    fn replaces_the_key_in_its_own_section_and_nowhere_else() {
        let out = set_bool_key(GENERATED, "network", "auto_port_forward", true);
        assert!(out.contains("[network]\n# Ask your router.\nauto_port_forward = true\n"));
        assert_eq!(out.matches("auto_port_forward").count(), 1);
        assert!(out.contains("[tls]\nenabled = true\n"));
        assert_eq!(out.len(), GENERATED.len() - 1, "only false -> true changed");
    }

    #[test]
    fn a_commented_line_is_not_the_setting() {
        let text = "[network]\n# auto_port_forward = true\n";
        let out = set_bool_key(text, "network", "auto_port_forward", false);
        assert_eq!(
            out,
            "[network]\nauto_port_forward = false\n# auto_port_forward = true\n"
        );
    }

    #[test]
    fn a_key_of_the_same_name_in_another_section_is_left_alone() {
        let text = "[other]\nauto_port_forward = true\n";
        let out = set_bool_key(text, "network", "auto_port_forward", false);
        assert_eq!(
            out,
            "[other]\nauto_port_forward = true\n\n[network]\nauto_port_forward = false\n"
        );
    }

    #[test]
    fn keeps_windows_line_endings_and_a_header_comment() {
        let text = "[network] # router\r\nauto_port_forward = true\r\n";
        let out = set_bool_key(text, "network", "auto_port_forward", false);
        assert_eq!(out, "[network] # router\r\nauto_port_forward = false\r\n");
    }

    #[test]
    fn a_dotted_subsection_is_a_different_section() {
        let text = "[network.extra]\nauto_port_forward = true\n";
        let out = set_bool_key(text, "network", "auto_port_forward", true);
        assert!(out.ends_with("[network]\nauto_port_forward = true\n"));
        assert!(out.starts_with("[network.extra]\nauto_port_forward = true\n"));
    }

    #[test]
    fn the_view_reports_a_pending_restart_and_an_env_lock() {
        let access = RouterAccess {
            running: false,
            saved: true,
            env_override: true,
            loopback_bind: false,
            config_path: None,
        };
        let view = access.view();
        assert!(view.restart_required);
        assert_eq!(view.locked_by, Some(ENV_OVERRIDE));
    }
}
