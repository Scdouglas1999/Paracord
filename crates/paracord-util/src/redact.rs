//! Helpers for keeping secrets out of logs and error messages.

/// Redact any userinfo (`user:password@`) from a database (or other) URL so
/// credentials never reach logs, error messages, or terminal output.
///
/// Returns the URL with the userinfo component replaced by `***`
/// (e.g. `postgres://user:pw@host/db` -> `postgres://***@host/db`). A URL with
/// no userinfo (such as `sqlite://data.db`) is returned unchanged, as is input
/// that does not look like `scheme://authority/...`.
pub fn redact_db_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let authority_start = scheme_end + 3;
    let rest = &url[authority_start..];
    // The authority ends at the first path/query/fragment delimiter.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // The last `@` within the authority separates userinfo from the host, so a
    // password that itself contains `@` is still fully stripped.
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    format!(
        "{}://***@{}{}",
        &url[..scheme_end],
        &authority[at + 1..],
        &rest[authority_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::redact_db_url;

    #[test]
    fn redacts_postgres_credentials() {
        assert_eq!(
            redact_db_url("postgres://user:s3cret@db.internal:5432/paracord"),
            "postgres://***@db.internal:5432/paracord"
        );
    }

    #[test]
    fn strips_password_containing_at_sign() {
        assert_eq!(
            redact_db_url("postgres://user:p@ss@host/db"),
            "postgres://***@host/db"
        );
    }

    #[test]
    fn leaves_urls_without_userinfo_unchanged() {
        assert_eq!(
            redact_db_url("postgres://db.internal:5432/paracord"),
            "postgres://db.internal:5432/paracord"
        );
        assert_eq!(redact_db_url("sqlite://data.db"), "sqlite://data.db");
        assert_eq!(redact_db_url("sqlite::memory:"), "sqlite::memory:");
    }

    #[test]
    fn preserves_query_and_fragment() {
        assert_eq!(
            redact_db_url("postgres://u:p@host/db?sslmode=require#frag"),
            "postgres://***@host/db?sslmode=require#frag"
        );
    }
}
