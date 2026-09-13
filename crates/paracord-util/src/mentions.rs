/// Parse user mentions from message content. Matches `<@id>` and `<@!id>` patterns.
pub fn parse_mentions(content: &str) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut i = 0;
    let bytes = content.as_bytes();
    while i + 2 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1] == b'@' {
            let start = if i + 2 < bytes.len() && bytes[i + 2] == b'!' {
                i + 3
            } else {
                i + 2
            };
            if let Some(end) = content[start..].find('>') {
                if let Ok(id) = content[start..start + end].parse::<i64>() {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                i = start + end + 1;
                continue;
            }
        }
        i += 1;
    }
    ids
}

/// Detects a mass-mention token (`@everyone` or `@here`) using word boundaries so
/// that embedded occurrences such as `foo@everyone.com` or `@everyone` glued to a
/// surrounding word do not trigger a guild-wide fan-out. A token matches only when
/// it is preceded by the start of input or whitespace and followed by the end of
/// input or a non-word character (anything other than an ASCII alphanumeric or `_`).
/// Trailing sentence punctuation (`@everyone!`, `@everyone.`) is therefore a valid
/// boundary, while a directly attached word character (`@everyoneish`) is not.
pub fn contains_mass_mention(content: &str) -> bool {
    fn is_word_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_'
    }
    for token in ["@everyone", "@here"] {
        let mut search_start = 0;
        while let Some(rel) = content[search_start..].find(token) {
            let idx = search_start + rel;
            let preceded_ok = idx == 0
                || content[..idx]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_whitespace());
            let after = &content[idx + token.len()..];
            let followed_ok = after.chars().next().is_none_or(|c| !is_word_char(c));
            if preceded_ok && followed_ok {
                return true;
            }
            search_start = idx + token.len();
        }
    }
    false
}

/// Explicit role tokens; user mentions and malformed IDs are not role tokens.
pub fn parse_role_mentions(content: &str) -> Vec<i64> {
    let mut ids = std::collections::BTreeSet::new();
    for (start, _) in content.match_indices("<@&") {
        let remaining = &content[start + 3..];
        if let Some(end) = remaining.find('>') {
            let token = &remaining[..end];
            if !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_digit()) {
                if let Ok(id) = token.parse::<i64>() {
                    if id > 0 {
                        ids.insert(id);
                    }
                }
            }
        }
    }
    ids.into_iter().collect()
}
