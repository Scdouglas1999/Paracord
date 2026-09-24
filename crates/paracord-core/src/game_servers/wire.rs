//! A bounds-checked reader over untrusted bytes. Every read checks what is
//! left first; nothing here indexes past the end or allocates more than the
//! packet already holds.

/// Why a reply could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    /// The reply ended before a field it promised.
    Truncated,
    /// A field is present but its value is impossible.
    Malformed(&'static str),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => f.write_str("the reply was cut short"),
            Self::Malformed(what) => f.write_str(what),
        }
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn bytes(&mut self, len: usize) -> Result<&'a [u8], WireError> {
        if self.remaining() < len {
            return Err(WireError::Truncated);
        }
        let out = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        Ok(out)
    }

    pub fn array<const N: usize>(&mut self) -> Result<[u8; N], WireError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.bytes(N)?);
        Ok(out)
    }

    pub fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.array::<1>()?[0])
    }

    pub fn u16_le(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    pub fn u16_be(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    pub fn i32_le(&mut self) -> Result<i32, WireError> {
        Ok(i32::from_le_bytes(self.array()?))
    }

    pub fn i64_be(&mut self) -> Result<i64, WireError> {
        Ok(i64::from_be_bytes(self.array()?))
    }

    pub fn f32_le(&mut self) -> Result<f32, WireError> {
        Ok(f32::from_le_bytes(self.array()?))
    }

    /// A NUL-terminated string of at most `max` bytes before the NUL. Invalid
    /// UTF-8 is replaced, not refused: server names are often Latin-1.
    pub fn cstring(&mut self, max: usize) -> Result<String, WireError> {
        let rest = &self.buf[self.pos..];
        let window = &rest[..rest.len().min(max + 1)];
        match window.iter().position(|byte| *byte == 0) {
            Some(end) => {
                let text = String::from_utf8_lossy(&window[..end]).into_owned();
                self.pos += end + 1;
                Ok(text)
            }
            None if rest.len() > max => Err(WireError::Malformed("a text field is too long")),
            None => Err(WireError::Truncated),
        }
    }

    /// A Minecraft VarInt: at most five bytes, little-endian groups of seven.
    pub fn varint(&mut self) -> Result<i32, WireError> {
        let mut value: u32 = 0;
        for index in 0..5 {
            let byte = self.u8()?;
            value |= u32::from(byte & 0x7f) << (7 * index);
            if byte & 0x80 == 0 {
                return Ok(value as i32);
            }
        }
        Err(WireError::Malformed("a length field is too long"))
    }
}

/// Encode a Minecraft VarInt.
pub fn write_varint(out: &mut Vec<u8>, value: i32) {
    let mut value = value as u32;
    loop {
        if value & !0x7f == 0 {
            out.push(value as u8);
            return;
        }
        out.push(((value & 0x7f) as u8) | 0x80);
        value >>= 7;
    }
}

/// Read a VarInt at the start of `buf` without consuming anything:
/// `Ok(None)` while more bytes are needed, `Ok(Some((value, width)))` once it
/// is complete.
pub fn peek_varint(buf: &[u8]) -> Result<Option<(i32, usize)>, WireError> {
    let mut value: u32 = 0;
    for index in 0..5 {
        let Some(&byte) = buf.get(index) else {
            return Ok(None);
        };
        value |= u32::from(byte & 0x7f) << (7 * index);
        if byte & 0x80 == 0 {
            return Ok(Some((value as i32, index + 1)));
        }
    }
    Err(WireError::Malformed("a length field is too long"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip() {
        for value in [
            0,
            1,
            127,
            128,
            255,
            25565,
            2_097_151,
            i32::MAX,
            -1,
            i32::MIN,
        ] {
            let mut out = Vec::new();
            write_varint(&mut out, value);
            assert!(out.len() <= 5);
            assert_eq!(Reader::new(&out).varint(), Ok(value), "{value}");
            assert_eq!(peek_varint(&out), Ok(Some((value, out.len()))));
            assert_eq!(peek_varint(&out[..out.len() - 1]), Ok(None));
        }
    }

    #[test]
    fn a_six_byte_varint_is_refused() {
        let bytes = [0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
        assert!(matches!(
            Reader::new(&bytes).varint(),
            Err(WireError::Malformed(_))
        ));
        assert!(matches!(peek_varint(&bytes), Err(WireError::Malformed(_))));
    }

    #[test]
    fn strings_need_their_terminator_within_the_limit() {
        let mut reader = Reader::new(b"abc\0def\0");
        assert_eq!(reader.cstring(8).as_deref(), Ok("abc"));
        assert_eq!(reader.cstring(3).as_deref(), Ok("def"));
        assert_eq!(Reader::new(b"abc").cstring(8), Err(WireError::Truncated));
        assert!(matches!(
            Reader::new(b"abcdefgh\0").cstring(4),
            Err(WireError::Malformed(_))
        ));
    }

    #[test]
    fn reads_past_the_end_are_errors() {
        let mut reader = Reader::new(&[1, 2, 3]);
        assert_eq!(reader.i32_le(), Err(WireError::Truncated));
        assert_eq!(reader.u16_be(), Ok(0x0102));
        assert_eq!(reader.u16_le(), Err(WireError::Truncated));
        assert_eq!(reader.u8(), Ok(3));
        assert_eq!(reader.u8(), Err(WireError::Truncated));
    }
}
