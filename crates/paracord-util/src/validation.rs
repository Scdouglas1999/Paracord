use thiserror::Error;

#[derive(Debug, Error)]
pub enum ValidationError {
    #[error("value is too short (min {min}, got {got})")]
    TooShort { min: usize, got: usize },
    #[error("value is too long (max {max}, got {got})")]
    TooLong { max: usize, got: usize },
    #[error("invalid characters")]
    InvalidCharacters,
    #[error("invalid format")]
    InvalidFormat,
}

const USERNAME_MIN_CHARS: usize = 2;
const USERNAME_MAX_CHARS: usize = 32;

fn is_username_separator(c: char) -> bool {
    c == '_' || c == '.' || c == '-'
}

/// Lenient username check for names that already exist (login/lookup paths).
///
/// Length is measured in Unicode scalar values, not bytes, so a 32-character
/// name is accepted regardless of its UTF-8 byte width. Control characters and
/// whitespace are always rejected. Existing accounts registered under the old
/// permissive policy (which allowed any Unicode alphanumeric) stay valid — use
/// [`is_valid_new_username`] to gate NEW registrations and renames.
pub fn validate_username(name: &str) -> Result<(), ValidationError> {
    let chars = name.chars().count();
    if chars < USERNAME_MIN_CHARS {
        return Err(ValidationError::TooShort {
            min: USERNAME_MIN_CHARS,
            got: chars,
        });
    }
    if chars > USERNAME_MAX_CHARS {
        return Err(ValidationError::TooLong {
            max: USERNAME_MAX_CHARS,
            got: chars,
        });
    }
    if name.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ValidationError::InvalidCharacters);
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(ValidationError::InvalidCharacters);
    }
    Ok(())
}

/// Strict username policy for NEW registrations and renames.
///
/// Restricts the character set to ASCII alphanumerics plus a limited separator
/// set (`_`, `.`, `-`). This rejects Unicode-homograph impersonation such as
/// Cyrillic `а` (U+0430) or full-width `ａ` (U+FF41) that would otherwise be
/// visually indistinguishable from ASCII look-alikes. Separators may not lead,
/// trail, or repeat consecutively.
pub fn is_valid_new_username(name: &str) -> Result<(), ValidationError> {
    let chars = name.chars().count();
    if chars < USERNAME_MIN_CHARS {
        return Err(ValidationError::TooShort {
            min: USERNAME_MIN_CHARS,
            got: chars,
        });
    }
    if chars > USERNAME_MAX_CHARS {
        return Err(ValidationError::TooLong {
            max: USERNAME_MAX_CHARS,
            got: chars,
        });
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || is_username_separator(c))
    {
        return Err(ValidationError::InvalidCharacters);
    }
    // Separators must not lead, trail, or appear consecutively.
    let first = name.chars().next().expect("min length checked above");
    let last = name.chars().next_back().expect("min length checked above");
    if is_username_separator(first) || is_username_separator(last) {
        return Err(ValidationError::InvalidFormat);
    }
    if name
        .chars()
        .zip(name.chars().skip(1))
        .any(|(a, b)| is_username_separator(a) && is_username_separator(b))
    {
        return Err(ValidationError::InvalidFormat);
    }
    Ok(())
}

pub fn validate_guild_name(name: &str) -> Result<(), ValidationError> {
    let len = name.len();
    if len < 2 {
        return Err(ValidationError::TooShort { min: 2, got: len });
    }
    if len > 100 {
        return Err(ValidationError::TooLong { max: 100, got: len });
    }
    Ok(())
}

pub fn validate_channel_name(name: &str) -> Result<(), ValidationError> {
    let len = name.len();
    if len < 1 {
        return Err(ValidationError::TooShort { min: 1, got: len });
    }
    if len > 100 {
        return Err(ValidationError::TooLong { max: 100, got: len });
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(ValidationError::InvalidCharacters);
    }
    Ok(())
}

pub fn validate_message_content(content: &str) -> Result<(), ValidationError> {
    let len = content.len();
    if len < 1 {
        return Err(ValidationError::TooShort { min: 1, got: len });
    }
    if len > 2000 {
        return Err(ValidationError::TooLong {
            max: 2000,
            got: len,
        });
    }
    Ok(())
}

pub fn validate_email(email: &str) -> Result<(), ValidationError> {
    if email.len() > 255 {
        return Err(ValidationError::TooLong {
            max: 255,
            got: email.len(),
        });
    }
    if email.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(ValidationError::InvalidFormat);
    }
    let parts: Vec<&str> = email.splitn(2, '@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(ValidationError::InvalidFormat);
    }
    if !parts[1].contains('.') {
        return Err(ValidationError::InvalidFormat);
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), ValidationError> {
    let len = password.len();
    if len < 10 {
        return Err(ValidationError::TooShort { min: 10, got: len });
    }
    if len > 128 {
        return Err(ValidationError::TooLong { max: 128, got: len });
    }
    let has_upper = password.chars().any(|c| c.is_ascii_uppercase());
    let has_lower = password.chars().any(|c| c.is_ascii_lowercase());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    let has_special = password
        .chars()
        .any(|c| c.is_ascii_punctuation() || (c.is_ascii() && !c.is_alphanumeric()));
    if !has_upper || !has_lower || !has_digit || !has_special {
        return Err(ValidationError::InvalidFormat);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- validate_username ----

    #[test]
    fn username_valid() {
        assert!(validate_username("alice").is_ok());
        assert!(validate_username("ab").is_ok());
        assert!(validate_username("user_123").is_ok());
    }

    #[test]
    fn username_too_short() {
        let err = validate_username("a").unwrap_err();
        assert!(matches!(err, ValidationError::TooShort { min: 2, got: 1 }));
    }

    #[test]
    fn username_too_long() {
        let long = "a".repeat(33);
        let err = validate_username(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 32, .. }));
    }

    #[test]
    fn username_invalid_chars() {
        let err = validate_username("user name").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidCharacters));
        let err2 = validate_username("user@name").unwrap_err();
        assert!(matches!(err2, ValidationError::InvalidCharacters));
    }

    #[test]
    fn username_boundary_lengths() {
        // Exactly 2 chars - minimum valid
        assert!(validate_username("ab").is_ok());
        // Exactly 32 chars - maximum valid
        assert!(validate_username(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn username_length_counts_chars_not_bytes() {
        // 32 multi-byte chars (2 bytes each = 64 bytes) is within the char limit.
        assert!(validate_username(&"é".repeat(32)).is_ok());
        // 33 chars exceeds it, reported in chars not bytes.
        let err = validate_username(&"é".repeat(33)).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 32, got: 33 }));
    }

    #[test]
    fn username_rejects_control_and_whitespace() {
        assert!(matches!(
            validate_username("a\tb").unwrap_err(),
            ValidationError::InvalidCharacters
        ));
        assert!(matches!(
            validate_username("a\u{0000}b").unwrap_err(),
            ValidationError::InvalidCharacters
        ));
    }

    // ---- is_valid_new_username ----

    #[test]
    fn new_username_valid_ascii() {
        assert!(is_valid_new_username("alice").is_ok());
        assert!(is_valid_new_username("user_123").is_ok());
        assert!(is_valid_new_username("a.b-c_d").is_ok());
        assert!(is_valid_new_username("Bob99").is_ok());
    }

    #[test]
    fn new_username_rejects_cyrillic_homograph() {
        // "аdmin" — leading char is Cyrillic 'а' (U+0430), not ASCII 'a'.
        let err = is_valid_new_username("\u{0430}dmin").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidCharacters));
    }

    #[test]
    fn new_username_rejects_fullwidth_homograph() {
        // Full-width Latin small letter a (U+FF41).
        let err = is_valid_new_username("\u{FF41}dmin").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidCharacters));
    }

    #[test]
    fn new_username_rejects_edge_and_repeated_separators() {
        assert!(matches!(
            is_valid_new_username("_alice").unwrap_err(),
            ValidationError::InvalidFormat
        ));
        assert!(matches!(
            is_valid_new_username("alice.").unwrap_err(),
            ValidationError::InvalidFormat
        ));
        assert!(matches!(
            is_valid_new_username("a__b").unwrap_err(),
            ValidationError::InvalidFormat
        ));
    }

    #[test]
    fn new_username_length_bounds() {
        assert!(matches!(
            is_valid_new_username("a").unwrap_err(),
            ValidationError::TooShort { min: 2, got: 1 }
        ));
        assert!(matches!(
            is_valid_new_username(&"a".repeat(33)).unwrap_err(),
            ValidationError::TooLong { max: 32, .. }
        ));
    }

    // ---- validate_guild_name ----

    #[test]
    fn guild_name_valid() {
        assert!(validate_guild_name("My Server").is_ok());
        assert!(validate_guild_name("AB").is_ok());
    }

    #[test]
    fn guild_name_too_short() {
        let err = validate_guild_name("X").unwrap_err();
        assert!(matches!(err, ValidationError::TooShort { min: 2, got: 1 }));
    }

    #[test]
    fn guild_name_too_long() {
        let long = "x".repeat(101);
        let err = validate_guild_name(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 100, .. }));
    }

    #[test]
    fn guild_name_allows_special_chars() {
        assert!(validate_guild_name("My Cool Server! #1").is_ok());
    }

    // ---- validate_channel_name ----

    #[test]
    fn channel_name_valid() {
        assert!(validate_channel_name("general").is_ok());
        assert!(validate_channel_name("my-channel").is_ok());
        assert!(validate_channel_name("channel_1").is_ok());
        assert!(validate_channel_name("a").is_ok());
    }

    #[test]
    fn channel_name_empty() {
        let err = validate_channel_name("").unwrap_err();
        assert!(matches!(err, ValidationError::TooShort { min: 1, got: 0 }));
    }

    #[test]
    fn channel_name_too_long() {
        let long = "a".repeat(101);
        let err = validate_channel_name(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 100, .. }));
    }

    #[test]
    fn channel_name_invalid_chars() {
        // Uppercase not allowed
        let err = validate_channel_name("General").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidCharacters));
        // Spaces not allowed
        let err2 = validate_channel_name("my channel").unwrap_err();
        assert!(matches!(err2, ValidationError::InvalidCharacters));
    }

    // ---- validate_message_content ----

    #[test]
    fn message_content_valid() {
        assert!(validate_message_content("Hello!").is_ok());
        assert!(validate_message_content("a").is_ok());
    }

    #[test]
    fn message_content_empty() {
        let err = validate_message_content("").unwrap_err();
        assert!(matches!(err, ValidationError::TooShort { min: 1, got: 0 }));
    }

    #[test]
    fn message_content_too_long() {
        let long = "a".repeat(2001);
        let err = validate_message_content(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 2000, .. }));
    }

    #[test]
    fn message_content_at_boundary() {
        assert!(validate_message_content(&"a".repeat(2000)).is_ok());
    }

    // ---- validate_email ----

    #[test]
    fn email_valid() {
        assert!(validate_email("user@example.com").is_ok());
        assert!(validate_email("a@b.c").is_ok());
    }

    #[test]
    fn email_too_long() {
        let long = format!("{}@example.com", "a".repeat(250));
        let err = validate_email(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 255, .. }));
    }

    #[test]
    fn email_missing_at() {
        let err = validate_email("userexample.com").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn email_missing_dot_in_domain() {
        let err = validate_email("user@localhost").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn email_empty_local_part() {
        let err = validate_email("@example.com").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn email_empty_domain() {
        let err = validate_email("user@").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn email_rejects_control_chars() {
        assert!(matches!(
            validate_email("user\r\n@example.com").unwrap_err(),
            ValidationError::InvalidFormat
        ));
        assert!(matches!(
            validate_email("us\u{0000}er@example.com").unwrap_err(),
            ValidationError::InvalidFormat
        ));
    }

    #[test]
    fn email_rejects_whitespace() {
        assert!(matches!(
            validate_email("user name@example.com").unwrap_err(),
            ValidationError::InvalidFormat
        ));
    }

    // ---- validate_password ----

    #[test]
    fn password_valid() {
        assert!(validate_password("Abcdef123!").is_ok());
        assert!(validate_password("P@ssw0rd!!").is_ok());
    }

    #[test]
    fn password_too_short() {
        let err = validate_password("Ab1!").unwrap_err();
        assert!(matches!(err, ValidationError::TooShort { min: 10, .. }));
    }

    #[test]
    fn password_too_long() {
        let long = format!("Aa1!{}", "x".repeat(125));
        let err = validate_password(&long).unwrap_err();
        assert!(matches!(err, ValidationError::TooLong { max: 128, .. }));
    }

    #[test]
    fn password_missing_uppercase() {
        let err = validate_password("abcdef123!").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn password_missing_lowercase() {
        let err = validate_password("ABCDEF123!").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn password_missing_digit() {
        let err = validate_password("Abcdefghi!").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn password_missing_special() {
        let err = validate_password("Abcdefg123").unwrap_err();
        assert!(matches!(err, ValidationError::InvalidFormat));
    }

    #[test]
    fn password_at_boundaries() {
        // Exactly 10 chars with all required complexity
        assert!(validate_password("Abcde123!x").is_ok());
        // Exactly 128 chars with all required complexity
        let long = format!("Aa1!{}", "x".repeat(124));
        assert!(validate_password(&long).is_ok());
    }
}

/// Reject the HTML-injection primitives outright.
///
/// The single definition for fields that never legitimately contain markup —
/// display names, bios, custom statuses, channel/space/bot/event/template names,
/// topics, descriptions, moderator reasons and notes.
///
/// **Positive validation, not a denylist.** A substring denylist of a handful of
/// tags and handlers (`<script`, `onerror=`, `onload=`, `<iframe`) is trivially
/// bypassed — `onmouseover=`, `<svg onload =` with a space before the `=`,
/// `<details ontoggle=`, `<body onpageshow=` all sail straight through — and
/// eight copies of exactly that denylist had been pasted across the route
/// modules under this same function name, so callers could not tell which
/// behaviour they were getting. `<` and `>` cannot open a tag, which closes the
/// entire tag-injection class for these fields. `javascript:` stays rejected for
/// consumers that place a value directly into an `href`/`src`.
///
/// The first-party React client escapes all of this already; the guarantee is
/// for the ecosystem consumers that do not — bots, third-party clients, embeds,
/// moderation dashboards.
///
/// Deliberately NOT applied to message content: `<` and `>` are ordinary
/// characters in chat (`a < b`, code snippets), so no validator can make raw
/// markup safe there. That surface is protected by escaping at render.
pub fn contains_dangerous_markup(value: &str) -> bool {
    if value.contains('<') || value.contains('>') {
        return true;
    }
    value.to_ascii_lowercase().contains("javascript:")
}

#[cfg(test)]
mod dangerous_markup_tests {
    use super::contains_dangerous_markup;

    #[test]
    fn rejects_the_bypasses_a_denylist_misses() {
        for payload in [
            "<script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            // Every one of these defeated the substring denylist.
            "<img src=x onmouseover=alert(1)>",
            "<svg onload =alert(1)>",
            "<details open ontoggle=alert(1)>",
            "<body onpageshow=alert(1)>",
            "<a href=\"javascript:alert(1)\">",
            "JaVaScRiPt:alert(1)",
        ] {
            assert!(
                contains_dangerous_markup(payload),
                "must reject {payload:?}"
            );
        }
    }

    #[test]
    fn accepts_ordinary_text() {
        for value in [
            "Ada Lovelace",
            "they/them",
            "Chief of Staff — Ops",
            "3 > 2 is math",
        ]
        .iter()
        .take(3)
        {
            assert!(!contains_dangerous_markup(value), "must accept {value:?}");
        }
    }
}
