//! Regression coverage for HTML attribute extraction in the link-unfurl path.
//!
//! `extract_attr` used to locate the attribute in `tag.to_lowercase()` and then
//! slice the *original* `tag` with that offset. `str::to_lowercase` is not
//! length-preserving — `İ` (U+0130) lowercases to `i` + U+0307, one byte longer
//! — so a page whose `<meta>` tag carries such characters before the attribute
//! pushed the offset past the real one. The slice then landed mid-codepoint or
//! out of bounds and panicked.
//!
//! The path is reachable from any authenticated user: posting a message with a
//! URL spawns the unfurl task, which fetches the attacker's page and calls
//! `parse_og_tags` -> `extract_attr` on every `<meta>` tag it finds.

use paracord_api::opengraph::{test_extract_attr as extract_attr, test_parse_og_tags};

/// Enough leading `İ` that the lowercased offset runs past the end of the tag.
/// Each one contributes a byte of drift, and the attribute value is only two
/// bytes long.
#[test]
fn multibyte_lowercase_prefix_does_not_slice_past_the_tag() {
    let tag = format!("<meta {} content=\"ok\">", "İ".repeat(20));
    assert_eq!(extract_attr(&tag, "content").as_deref(), Some("ok"));
}

/// A single `İ` only drifts one byte, which is enough to land inside a
/// three-byte character in the attribute value.
#[test]
fn multibyte_lowercase_prefix_does_not_slice_mid_codepoint() {
    let tag = "<meta İ content=\"日本語テキスト\">";
    assert_eq!(
        extract_attr(tag, "content").as_deref(),
        Some("日本語テキスト")
    );
}

/// The end-to-end shape a hostile page would actually serve.
#[test]
fn hostile_meta_tag_parses_instead_of_panicking() {
    let html = format!(
        "<html><head>\
         <meta {drift} property=\"og:title\" content=\"Título\">\
         <meta {drift} property=\"og:description\" content=\"описание\">\
         </head></html>",
        drift = "İ".repeat(32),
    );
    let embed = test_parse_og_tags(&html, "https://attacker.example/page")
        .expect("a title/description pair must still yield an embed");
    assert_eq!(embed["title"], "Título");
    assert_eq!(embed["description"], "описание");
}

/// Every `İ` in the *value* is also drift for the next attribute searched on the
/// same tag, and `parse_og_tags` searches each tag three times (property, name,
/// content).
#[test]
fn multibyte_lowercase_inside_a_value_does_not_break_the_next_attribute() {
    let tag = "<meta property=\"İİİİİİİİİİ\" content=\"safe\">";
    assert_eq!(extract_attr(tag, "content").as_deref(), Some("safe"));
    assert_eq!(
        extract_attr(tag, "property").as_deref(),
        Some("İİİİİİİİİİ"),
        "the property value itself must come back intact"
    );
}

/// The lowercasing existed so `CONTENT=` matched `content`; the replacement is
/// an ASCII case-insensitive search, so that must still hold.
#[test]
fn attribute_names_are_still_matched_case_insensitively() {
    assert_eq!(
        extract_attr("<meta PROPERTY=\"og:title\" CONTENT='Hi'>", "content").as_deref(),
        Some("Hi")
    );
    assert_eq!(
        extract_attr("<meta Property=\"og:title\" Content=\"Hi\">", "property").as_deref(),
        Some("og:title")
    );
}

/// Attribute *values* must not be case-folded — only the name match is
/// case-insensitive.
#[test]
fn attribute_values_keep_their_original_case() {
    assert_eq!(
        extract_attr("<meta content=\"MiXeD CaSe\">", "content").as_deref(),
        Some("MiXeD CaSe")
    );
}

/// A tag that simply does not carry the attribute must return `None` rather than
/// matching on a truncated prefix.
#[test]
fn missing_attribute_returns_none() {
    assert!(extract_attr("<meta property=\"og:title\">", "content").is_none());
    assert!(extract_attr("<meta İİİ>", "content").is_none());
    assert!(extract_attr("", "content").is_none());
}
