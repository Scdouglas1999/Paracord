//! Turning what a game server says about itself into plain text.

/// Longest name, map, version or message of the day kept, in characters.
pub const MAX_TEXT_CHARS: usize = 200;

/// Plain text: Minecraft `§` formatting codes removed, control characters
/// dropped, each line trimmed with its spaces collapsed, blank lines removed,
/// and the whole clipped to [`MAX_TEXT_CHARS`]. Lines stay separated by `\n`.
pub fn plain_text(raw: &str) -> String {
    let mut stripped = String::with_capacity(raw.len().min(4 * MAX_TEXT_CHARS));
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '\u{a7}' {
            // The code character after the section sign goes too.
            chars.next();
            continue;
        }
        if ch == '\n' {
            stripped.push('\n');
        } else if ch.is_control() {
            stripped.push(' ');
        } else {
            stripped.push(ch);
        }
    }
    let lines: Vec<String> = stripped
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect();
    clip(&lines.join("\n"), MAX_TEXT_CHARS)
}

/// Plain text, or `None` when nothing is left.
pub fn plain_option(raw: &str) -> Option<String> {
    Some(plain_text(raw)).filter(|text| !text.is_empty())
}

/// At most `max` characters.
pub fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => text[..end].trim_end().to_string(),
        None => text.to_string(),
    }
}

/// The first line of some plain text.
pub fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatting_codes_and_controls_are_removed() {
        assert_eq!(
            plain_text("\u{a7}6\u{a7}lLantern \u{a7}rSMP\u{a7}"),
            "Lantern SMP"
        );
        assert_eq!(
            plain_text("  one \t two \r\n\n   \u{a7}bthree  "),
            "one two\nthree"
        );
        assert_eq!(plain_option("\u{a7}k\u{a7}r  "), None);
    }

    #[test]
    fn long_text_is_clipped_on_a_character_boundary() {
        let long = "é".repeat(MAX_TEXT_CHARS + 50);
        let plain = plain_text(&long);
        assert_eq!(plain.chars().count(), MAX_TEXT_CHARS);
        assert_eq!(clip("abc", 2), "ab");
        assert_eq!(clip("ab", 5), "ab");
    }
}
