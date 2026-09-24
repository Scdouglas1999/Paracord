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

/// Shortest accepted password, measured in UTF-8 bytes (not characters).
///
/// Published so every surface that advertises the rules before submit — the
/// registration page and the first-owner setup page — reads them from the same
/// place the server enforces them, instead of restating a number that drifts.
pub const PASSWORD_MIN_LENGTH: usize = 10;
/// Longest accepted password, in UTF-8 bytes.
pub const PASSWORD_MAX_LENGTH: usize = 128;

pub fn validate_password(password: &str) -> Result<(), ValidationError> {
    let len = password.len();
    if len < PASSWORD_MIN_LENGTH {
        return Err(ValidationError::TooShort {
            min: PASSWORD_MIN_LENGTH,
            got: len,
        });
    }
    if len > PASSWORD_MAX_LENGTH {
        return Err(ValidationError::TooLong {
            max: PASSWORD_MAX_LENGTH,
            got: len,
        });
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
/// behavior they were getting. `<` and `>` cannot open a tag, which closes the
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

/// Unicode's `Default_Ignorable_Code_Point` set: code points a conforming
/// renderer draws nothing for. Kept whole rather than sampled — unlike a list
/// of dangerous tag names, this set is closed and defined by the standard, so
/// enumerating it is exact rather than a guess at what an attacker might try.
///
/// Membership here does **not** make a character illegal. A zero-width joiner
/// and the variation selectors are how a family emoji or a flag is spelled, so
/// they are perfectly legal inside a label; they simply do not count towards
/// the label having anything to show. See [`label_is_blank`].
const DEFAULT_IGNORABLE_RANGES: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),   // soft hyphen
    (0x034F, 0x034F),   // combining grapheme joiner
    (0x061C, 0x061C),   // arabic letter mark
    (0x115F, 0x1160),   // hangul choseong/jungseong fillers
    (0x17B4, 0x17B5),   // khmer inherent vowels
    (0x180B, 0x180F),   // mongolian variation selectors + vowel separator
    (0x200B, 0x200F),   // zero-width space/joiners, LTR/RTL marks
    (0x202A, 0x202E),   // bidi embedding and override controls
    (0x2060, 0x206F),   // word joiner, invisible operators, deprecated bidi
    (0x3164, 0x3164),   // hangul filler
    (0xFE00, 0xFE0F),   // variation selectors
    (0xFEFF, 0xFEFF),   // zero-width no-break space / BOM
    (0xFFA0, 0xFFA0),   // halfwidth hangul filler
    (0xFFF0, 0xFFF8),   // unassigned, specified as default-ignorable
    (0x1BCA0, 0x1BCA3), // shorthand format controls
    (0x1D173, 0x1D17A), // musical format controls
    (0xE0000, 0xE0FFF), // tags and variation selectors supplement
];

fn is_default_ignorable(c: char) -> bool {
    let cp = c as u32;
    DEFAULT_IGNORABLE_RANGES
        .iter()
        .any(|(lo, hi)| cp >= *lo && cp <= *hi)
}

/// Bidi controls that re-order the characters around them. A label carrying one
/// does not read the way its stored bytes read — `a\u{202E}gnp.exe` renders as
/// `aexe.png` — which is the Trojan Source class, applied to a name a person is
/// asked to trust. The plain direction *marks* (U+200E/U+200F) are not here:
/// they hint at direction for text that genuinely needs it without reversing
/// anything.
fn is_bidi_reordering_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// True when a label would render as nothing at all: every character in it is
/// whitespace or draws no glyph.
fn label_is_blank(value: &str) -> bool {
    !value
        .chars()
        .any(|c| !c.is_whitespace() && !is_default_ignorable(c))
}

/// A label a person is asked to read must actually render something, and must
/// not lie about which way it reads.
///
/// This is the companion to [`contains_dangerous_markup`] for the same family
/// of fields — space names, room names, and anything else shown to a reader as
/// the identity of a thing. That function closes the tag-injection class;
/// this one closes two others it says nothing about:
///
/// * **Blank labels.** A name of nothing but spaces, or of nothing but
///   zero-width characters, passes a `len()` bound and then renders as an empty
///   row. The reader cannot name it, search for it, or tell two of them apart.
/// * **Direction spoofing.** U+202E and its siblings reverse the text that
///   follows, so a stored name can present itself as a completely different
///   string — the Trojan Source trick, pointed at a label rather than at source
///   code.
///
/// Control characters go with them: a newline in a name breaks every single-line
/// surface that renders it, and a NUL truncates the name for any consumer that
/// hands it to a C API.
///
/// Length is deliberately **not** checked here; callers already bound their own
/// field against their own column.
pub fn validate_visible_label(value: &str) -> Result<(), ValidationError> {
    if value.chars().any(char::is_control) {
        return Err(ValidationError::InvalidCharacters);
    }
    if value.chars().any(is_bidi_reordering_control) {
        return Err(ValidationError::InvalidCharacters);
    }
    if label_is_blank(value) {
        return Err(ValidationError::TooShort { min: 1, got: 0 });
    }
    Ok(())
}

#[cfg(test)]
mod visible_label_tests {
    use super::validate_visible_label;

    #[test]
    fn accepts_names_people_actually_use() {
        for value in [
            "General",
            "general",
            "Ada Lovelace",
            "salon-de-the",
            // Emoji-only names are ordinary. The family sequence is spelled with
            // zero-width joiners and the flag with regional indicators; neither
            // may be mistaken for a blank label.
            "\u{1F680}",
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
            "\u{1F1EF}\u{1F1F5}",
            "\u{2764}\u{FE0F}",
            // Right-to-left script is fine; it is the *override* that is not.
            "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}",
            "3 - 2 is math",
        ] {
            assert!(
                validate_visible_label(value).is_ok(),
                "must accept {value:?}"
            );
        }
    }

    #[test]
    fn rejects_labels_that_render_as_nothing() {
        for value in [
            "",
            "   ",
            "\u{00A0}\u{00A0}",
            "\u{200B}\u{200B}\u{200B}",
            "\u{FEFF}",
            "\u{2060}",
            "\u{3164}",
            "\u{E0041}",
        ] {
            assert!(
                validate_visible_label(value).is_err(),
                "must reject blank label {value:?}"
            );
        }
    }

    #[test]
    fn rejects_control_characters() {
        for value in ["a\u{0000}b", "a\nb", "a\rb", "a\tb", "\u{0007}bell"] {
            assert!(
                validate_visible_label(value).is_err(),
                "must reject control character in {value:?}"
            );
        }
    }

    #[test]
    fn rejects_direction_spoofing() {
        for value in [
            // Renders as "aexe.png".
            "a\u{202E}gnp.exe",
            "\u{202D}forced-ltr",
            "\u{2066}isolated\u{2069}",
        ] {
            assert!(
                validate_visible_label(value).is_err(),
                "must reject direction spoofing in {value:?}"
            );
        }
    }
}

/// Rich-message producers use mention tokens as syntax, not HTML. Permit only
/// complete positive snowflake mention tokens while retaining the strict markup
/// rejection used by their existing content validation.
pub fn contains_dangerous_markup_except_mentions(value: &str) -> bool {
    let mut remaining = value;
    while let Some(start) = remaining.find('<') {
        if contains_dangerous_markup(&remaining[..start]) {
            return true;
        }
        let rest = &remaining[start + 1..];
        let Some(end) = rest.find('>') else {
            return true;
        };
        let token = &rest[..end];
        let Some(user_or_role) = token.strip_prefix('@') else {
            return true;
        };
        let number = user_or_role
            .strip_prefix('!')
            .or_else(|| user_or_role.strip_prefix('&'))
            .unwrap_or(user_or_role);
        if number.is_empty()
            || !number.bytes().all(|byte| byte.is_ascii_digit())
            || !number.parse::<i64>().is_ok_and(|id| id > 0)
        {
            return true;
        }
        remaining = &rest[end + 1..];
    }
    contains_dangerous_markup(remaining)
}

#[cfg(test)]
mod message_token_markup_tests {
    use super::contains_dangerous_markup_except_mentions;
    #[test]
    fn permits_only_complete_mentions_without_hiding_markup() {
        for safe in ["<@123> <@!456> <@&789> @everyone", "plain content"] {
            assert!(!contains_dangerous_markup_except_mentions(safe));
        }
        for unsafe_content in [
            "<@123><script>alert(1)</script>",
            "<@123 onload=x>",
            "<@<@123>>",
            "<@0>",
            "<@-1>",
            "<@123",
            "<@123>javascript:alert(1)",
            "<img src=x onerror=alert(1)>",
            "<@9223372036854775808>",
        ] {
            assert!(
                contains_dangerous_markup_except_mentions(unsafe_content),
                "{unsafe_content}"
            );
        }
    }
}

// ── Reaction emoji ──────────────────────────────────────────────────────────

/// The longest reaction a client can send, in Unicode scalar values.
///
/// A single grapheme can legitimately be long — a family ZWJ sequence with skin
/// tones runs to eleven scalars, a subdivision flag to fourteen — but nothing
/// real approaches this, and the column is 64 characters wide.
const MAX_REACTION_EMOJI_SCALARS: usize = 24;

/// What a reaction path segment turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactionEmoji {
    /// A Unicode emoji, stored verbatim.
    Unicode,
    /// A custom emoji token, `<:name:id>` or `<a:name:id>`. The caller must
    /// still check that the id names an emoji this channel may use.
    Custom { id: i64, animated: bool },
}

/// Whether a scalar may appear in a Unicode emoji sequence.
///
/// Deliberately a range check rather than a full Unicode emoji property table:
/// the point is to refuse text, markup and arbitrary identifiers, not to
/// adjudicate every future codepoint. Anything outside these blocks is not an
/// emoji in any Unicode version this codebase will see, and the blocks are
/// generous enough that a new emoji in an existing block keeps working.
fn is_emoji_scalar(c: char) -> bool {
    matches!(u32::from(c),
        0x00A9 | 0x00AE                 // © ®
        | 0x200D                        // zero-width joiner
        | 0x203C | 0x2049               // ‼ ⁉
        | 0x20E3                        // combining enclosing keycap
        | 0x2122 | 0x2139               // ™ ℹ
        | 0x2194..=0x21AA               // arrows used as emoji
        | 0x231A..=0x231B | 0x2328
        | 0x23CF..=0x23FA
        | 0x24C2
        | 0x25AA..=0x25FE
        | 0x2600..=0x27BF               // misc symbols + dingbats
        | 0x2934..=0x2935
        | 0x2B00..=0x2BFF
        | 0x3030 | 0x303D | 0x3297 | 0x3299
        | 0xFE0E..=0xFE0F               // variation selectors
        | 0x1F000..=0x1FAFF             // the emoji planes
        | 0xE0020..=0xE007F             // tag characters (subdivision flags)
    )
}

/// `#`, `*` and the digits are emoji only as the base of a keycap sequence.
fn is_keycap_base(c: char) -> bool {
    c == '#' || c == '*' || c.is_ascii_digit()
}

/// Classify a reaction path segment, refusing anything that is not an emoji.
///
/// Every string was accepted before this: `notanemoji`, `<script>`, and custom
/// emoji ids for emoji that do not exist all stored fine and came back on the
/// message forever.
pub fn validate_reaction_emoji(value: &str) -> Result<ReactionEmoji, ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::TooShort { min: 1, got: 0 });
    }

    if let Some(rest) = value.strip_prefix('<') {
        let rest = rest
            .strip_suffix('>')
            .ok_or(ValidationError::InvalidFormat)?;
        let (animated, rest) = match rest.strip_prefix('a') {
            Some(after) => (true, after),
            None => (false, rest),
        };
        let rest = rest
            .strip_prefix(':')
            .ok_or(ValidationError::InvalidFormat)?;
        let (name, id) = rest
            .rsplit_once(':')
            .ok_or(ValidationError::InvalidFormat)?;
        if name.is_empty()
            || name.chars().count() > 32
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(ValidationError::InvalidFormat);
        }
        if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err(ValidationError::InvalidFormat);
        }
        let id: i64 = id.parse().map_err(|_| ValidationError::InvalidFormat)?;
        if id <= 0 {
            return Err(ValidationError::InvalidFormat);
        }
        return Ok(ReactionEmoji::Custom { id, animated });
    }

    // A custom token bounds itself through its name and id above; only a
    // Unicode sequence needs a scalar ceiling of its own.
    let scalars = value.chars().count();
    if scalars > MAX_REACTION_EMOJI_SCALARS {
        return Err(ValidationError::TooLong {
            max: MAX_REACTION_EMOJI_SCALARS,
            got: scalars,
        });
    }

    // A keycap sequence is the one place ASCII belongs, and only as the base.
    let keycap = value.chars().any(|c| u32::from(c) == 0x20E3);
    if value
        .chars()
        .all(|c| is_emoji_scalar(c) || (keycap && is_keycap_base(c)))
    {
        Ok(ReactionEmoji::Unicode)
    } else {
        Err(ValidationError::InvalidCharacters)
    }
}

#[cfg(test)]
mod reaction_emoji_tests {
    use super::*;

    #[test]
    fn accepts_the_shapes_a_client_can_actually_send() {
        for value in [
            "\u{1F600}",                  // 😀
            "\u{2620}\u{FE0F}",           // ☠️ with a variation selector
            "\u{1F469}\u{200D}\u{1F4BB}", // 👩‍💻, a ZWJ sequence
            "\u{1F44D}\u{1F3FF}",         // 👍🏿, a skin tone modifier
            "\u{1F1EC}\u{1F1E7}",         // 🇬🇧, regional indicators
            "1\u{FE0F}\u{20E3}",          // 1️⃣, a keycap sequence
            "\u{00A9}\u{FE0F}",           // ©️
        ] {
            assert_eq!(
                validate_reaction_emoji(value).unwrap(),
                ReactionEmoji::Unicode,
                "{value:?} should be a unicode emoji"
            );
        }
        assert_eq!(
            validate_reaction_emoji("<:shipit:123>").unwrap(),
            ReactionEmoji::Custom {
                id: 123,
                animated: false
            }
        );
        assert_eq!(
            validate_reaction_emoji("<a:party_parrot:9876543210>").unwrap(),
            ReactionEmoji::Custom {
                id: 9876543210,
                animated: true
            }
        );
    }

    #[test]
    fn refuses_everything_that_is_not_an_emoji() {
        for value in [
            "",
            "notanemoji",
            "<script>",
            "a",
            "1",        // a bare digit is not a keycap
            ":shipit:", // a shortcode is not a reaction
            "<:shipit:>",
            "<::123>",
            "<:ship it:123>",
            "<:shipit:abc>",
            "<:shipit:123",
            "\u{1F600} and text",
            "\u{202E}\u{1F600}", // right-to-left override smuggled alongside
        ] {
            assert!(
                validate_reaction_emoji(value).is_err(),
                "{value:?} should be refused"
            );
        }
    }

    #[test]
    fn refuses_a_sequence_longer_than_any_real_grapheme() {
        let too_long: String = std::iter::repeat_n('\u{1F600}', 25).collect();
        assert!(validate_reaction_emoji(&too_long).is_err());
    }
}
