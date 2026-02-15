/// Encode bytes to lowercase hex string.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Decode hex string to bytes. Returns None if invalid hex.
pub fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    let mut i = 0;
    while i < value.len() {
        let byte = u8::from_str_radix(&value[i..i + 2], 16).ok()?;
        out.push(byte);
        i += 2;
    }
    Some(out)
}
