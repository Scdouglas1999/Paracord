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

pub fn validate_username(name: &str) -> Result<(), ValidationError> {
    let len = name.len();
    if len < 2 {
        return Err(ValidationError::TooShort { min: 2, got: len });
    }
    if len > 32 {
        return Err(ValidationError::TooLong { max: 32, got: len });
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(ValidationError::InvalidCharacters);
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
