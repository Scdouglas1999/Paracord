/// Sanitize a user-provided filename to prevent path traversal,
/// null byte injection, and other filesystem attacks.
pub fn sanitize_filename(name: &str) -> String {
    // 1. Take only the last path component (strip directories)
    let name = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(name);

    // 2. Remove null bytes and control characters (< 0x20)
    // 3. Remove dangerous characters: < > : " / \ | ? *
    let sanitized: String = name
        .chars()
        .filter(|&c| {
            c >= '\x20'
                && c != '\0'
                && !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        .collect();

    // 4. Strip leading dots (prevents hidden files / directory traversal)
    let sanitized = sanitized.trim_start_matches('.');

    // 5. Trim whitespace
    let sanitized = sanitized.trim();

    // 6. If empty after sanitization, return "unnamed"
    if sanitized.is_empty() {
        return "unnamed".to_string();
    }

    // 7. Truncate to 255 bytes (filesystem limit)
    let mut result = String::with_capacity(sanitized.len().min(255));
    for c in sanitized.chars() {
        if result.len() + c.len_utf8() > 255 {
            break;
        }
        result.push(c);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_path_traversal() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("..\\..\\windows\\system32\\config"), "config");
    }

    #[test]
    fn removes_null_bytes() {
        assert_eq!(sanitize_filename("file\0.txt"), "file.txt");
    }

    #[test]
    fn removes_control_chars() {
        assert_eq!(sanitize_filename("file\x01\x02.txt"), "file.txt");
    }

    #[test]
    fn removes_dangerous_chars() {
        assert_eq!(sanitize_filename("file<>:\"|?*.txt"), "file.txt");
    }

    #[test]
    fn strips_leading_dots() {
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename("...dots"), "dots");
    }

    #[test]
    fn returns_unnamed_for_empty() {
        assert_eq!(sanitize_filename(""), "unnamed");
        assert_eq!(sanitize_filename("..."), "unnamed");
        assert_eq!(sanitize_filename("../.."), "unnamed");
    }

    #[test]
    fn preserves_normal_filenames() {
        assert_eq!(sanitize_filename("photo.jpg"), "photo.jpg");
        assert_eq!(sanitize_filename("my document (1).pdf"), "my document (1).pdf");
    }

    #[test]
    fn truncates_to_255_bytes() {
        let long_name = "a".repeat(300) + ".txt";
        let result = sanitize_filename(&long_name);
        assert!(result.len() <= 255);
    }
}
