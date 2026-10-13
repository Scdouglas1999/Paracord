//! The Linux `.desktop` entry that makes `paracord://` links open this app.
//!
//! `tauri-plugin-deep-link` writes its handler with `Exec="/path/app" %u`:
//! the path is always wrapped in double quotes. The Desktop Entry spec allows
//! that, but `xdg-open`'s generic path (the one a desktop without GNOME, KDE or
//! XFCE detection takes: i3, sway, a bare window manager) runs `command -v` on
//! the first word of `Exec=` without unquoting it, finds no file called
//! `"/path/app"` and gives up with "no method available". `gio open` copes,
//! which is why it passed while `xdg-open` did not.
//!
//! So this app writes the entry itself, following the spec's quoting rules
//! exactly: an argument is quoted only when it contains a reserved character,
//! which an ordinary install path never does, and `%u` is the last word.

use std::path::Path;

/// Characters that force an `Exec=` argument into double quotes (Desktop Entry
/// Specification, "The Exec key": space, tab, newline, quotes, backslash, and
/// the shell metacharacters it lists).
const RESERVED: &[char] = &[
    ' ', '\t', '\n', '"', '\'', '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')',
    '`',
];

/// One program path as an `Exec=` argument, ready to sit in the file.
///
/// Unquoted when it can be. When quoting is needed, `"`, `` ` ``, `$` and `\`
/// are backslash-escaped inside the quotes, and then every backslash is
/// doubled again, because the file format's own string escaping is applied
/// before the Exec parser sees the value. A literal `%` is written `%%`.
pub fn exec_argument(path: &str) -> String {
    let path = path.replace('%', "%%");
    if !path.contains(RESERVED) {
        return path;
    }
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                // Exec-level escape, itself escaped for the file format.
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            // The backslash being escaped is doubled again by the file format.
            '\\' => quoted.push_str("\\\\\\\\"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// The whole `Exec=` value: the program, then `%u` (one URL).
pub fn exec_line(program: &Path) -> String {
    format!("{} %u", exec_argument(&program.to_string_lossy()))
}

/// The contents of the handler `.desktop` file.
pub fn desktop_entry(name: &str, program: &Path, schemes: &[&str]) -> String {
    let mimes: String = schemes
        .iter()
        .map(|scheme| format!("x-scheme-handler/{scheme};"))
        .collect();
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\nTerminal=false\nMimeType={mimes}\nNoDisplay=true\n",
        exec = exec_line(program),
    )
}

/// Write the handler entry (when it differs) and make it the default for the
/// schemes. Replaces what the plugin's own `register_all` would have written,
/// under the same file name so a quoted entry from an earlier run is
/// overwritten.
#[cfg(target_os = "linux")]
pub fn register(app: &tauri::AppHandle, schemes: &[&str]) -> Result<(), String> {
    use std::process::Command;
    use tauri::Manager;

    let bin = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let file_name = format!(
        "{}-handler.desktop",
        bin.file_name().unwrap_or_default().to_string_lossy()
    );
    // An AppImage runs from a temporary mount; the file the owner launched is
    // the one that must be called.
    let program = app.env().appimage.map_or(bin, std::path::PathBuf::from);
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| file_name.clone());

    let dir = app
        .path()
        .data_dir()
        .map_err(|e| e.to_string())?
        .join("applications");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&file_name);
    let wanted = desktop_entry(&name, &program, schemes);
    let current = std::fs::read_to_string(&target).ok();
    if current.as_deref() != Some(wanted.as_str()) {
        std::fs::write(&target, wanted).map_err(|e| e.to_string())?;
    }

    // Both are best effort in the sense that a minimal desktop may lack one;
    // a missing tool is reported, never hidden.
    Command::new("update-desktop-database")
        .arg(&dir)
        .status()
        .map_err(|e| format!("update-desktop-database: {e}"))?;
    for scheme in schemes {
        Command::new("xdg-mime")
            .args(["default", &file_name, &format!("x-scheme-handler/{scheme}")])
            .status()
            .map_err(|e| format!("xdg-mime: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader of `Exec=` that follows the specification, in the two layers
    /// the spec describes: the key-file string escapes first (`\\` is one
    /// backslash), then the argument quoting (`"..."` with backslash-escaped
    /// `"`, `` ` ``, `$`, `\`), then field codes. Unquoted words split on
    /// spaces. This is what `gio`/GLib do.
    fn parse_exec(value: &str) -> Vec<String> {
        let mut unescaped = String::new();
        let mut chars = value.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('\\') => unescaped.push('\\'),
                    Some('s') => unescaped.push(' '),
                    Some('n') => unescaped.push('\n'),
                    Some('t') => unescaped.push('\t'),
                    Some('r') => unescaped.push('\r'),
                    other => panic!("unknown key-file escape \\{other:?}"),
                }
            } else {
                unescaped.push(c);
            }
        }
        let mut words: Vec<String> = Vec::new();
        let mut word = String::new();
        let mut in_word = false;
        let mut quoted = false;
        let mut it = unescaped.chars().peekable();
        while let Some(c) = it.next() {
            if quoted {
                match c {
                    '"' => quoted = false,
                    '\\' => word.push(it.next().expect("dangling escape")),
                    _ => word.push(c),
                }
            } else {
                match c {
                    '"' => {
                        quoted = true;
                        in_word = true;
                    }
                    ' ' => {
                        if in_word {
                            words.push(std::mem::take(&mut word));
                            in_word = false;
                        }
                    }
                    '\\' | '\'' | '`' | '$' | '>' | '<' | '~' | '|' | '&' | ';' | '*' | '?'
                    | '#' | '(' | ')' => panic!("reserved character {c:?} outside quotes"),
                    _ => {
                        word.push(c);
                        in_word = true;
                    }
                }
            }
        }
        assert!(!quoted, "unterminated quote");
        if in_word {
            words.push(word);
        }
        words.into_iter().map(|w| w.replace("%%", "%")).collect()
    }

    fn exec_of(entry: &str) -> &str {
        entry
            .lines()
            .find_map(|line| line.strip_prefix("Exec="))
            .expect("an Exec line")
    }

    #[test]
    fn an_ordinary_path_is_not_quoted_so_xdg_open_can_find_it() {
        let entry = desktop_entry(
            "Paracord",
            Path::new("/opt/paracord/paracord-desktop"),
            &["paracord"],
        );
        let exec = exec_of(&entry);
        assert_eq!(exec, "/opt/paracord/paracord-desktop %u");
        // The first word is what `xdg-open` runs `command -v` on: no quotes.
        assert!(!exec.split(' ').next().unwrap().contains('"'));
    }

    #[test]
    fn the_exec_line_parses_to_the_program_and_one_url_field() {
        for program in [
            "/opt/paracord/paracord-desktop",
            "/home/a b/Applications/Paracord.AppImage",
            "/home/me/it's here/paracord",
            "/home/me/say \"hi\"/paracord",
            "/home/me/$HOME/`x`/paracord",
            "/home/me/back\\slash/paracord",
            "/home/me/100%/paracord",
        ] {
            let entry = desktop_entry("Paracord", Path::new(program), &["paracord"]);
            assert_eq!(
                parse_exec(exec_of(&entry)),
                vec![program.to_string(), "%u".to_string()],
                "Exec line was {}",
                exec_of(&entry)
            );
        }
    }

    #[test]
    fn only_a_path_that_needs_quotes_gets_them() {
        assert_eq!(exec_argument("/usr/bin/paracord"), "/usr/bin/paracord");
        assert_eq!(exec_argument("/a b/c"), "\"/a b/c\"");
    }

    #[test]
    fn the_entry_registers_the_scheme_and_stays_out_of_menus() {
        let entry = desktop_entry("Paracord", Path::new("/usr/bin/paracord"), &["paracord"]);
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nMimeType=x-scheme-handler/paracord;\n"));
        assert!(entry.contains("\nNoDisplay=true\n"));
        assert!(entry.contains("\nTerminal=false\n"));
    }
}
