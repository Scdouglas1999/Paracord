//! Snowflake ids on the media control plane.
//!
//! Every other surface in Paracord sends snowflakes as JSON **strings**, and
//! for a hard reason: an id is a 64-bit integer, `JSON.parse` turns a bare
//! number into an IEEE-754 double, and today's snowflakes are past 2^53. A
//! browser that reads `{"userId":357608638640033792}` gets
//! `357608638640033800` — an account that does not exist. It never throws; the
//! id is simply wrong, and every lookup keyed on it quietly misses.
//!
//! The media control plane was the one place still sending bare numbers, so a
//! browser's own control messages named the wrong people: sender keys were
//! wrapped for an id nobody had, and a participant snapshot could not be
//! matched against the voice roster. These helpers put it back on the house
//! rule.
//!
//! Reading is deliberately tolerant of both shapes. The wire is spoken by a
//! browser, by the desktop client's Rust engine and by another server's
//! federation link, and they are not all upgraded in the same instant.

use serde::de::{Deserializer, Error as DeError, Unexpected, Visitor};
use serde::ser::Serializer;
use std::fmt;

/// Serialize a snowflake as a JSON string.
pub fn serialize<S: Serializer>(id: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&id.to_string())
}

/// Read a snowflake written either as a string (current) or as a bare number
/// (older peers).
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    deserializer.deserialize_any(SnowflakeVisitor)
}

struct SnowflakeVisitor;

impl<'de> Visitor<'de> for SnowflakeVisitor {
    type Value = i64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a snowflake id as a string or an integer")
    }

    fn visit_str<E: DeError>(self, value: &str) -> Result<i64, E> {
        value
            .parse::<i64>()
            .map_err(|_| E::invalid_value(Unexpected::Str(value), &self))
    }

    fn visit_i64<E: DeError>(self, value: i64) -> Result<i64, E> {
        Ok(value)
    }

    fn visit_u64<E: DeError>(self, value: u64) -> Result<i64, E> {
        i64::try_from(value).map_err(|_| E::invalid_value(Unexpected::Unsigned(value), &self))
    }

    fn visit_f64<E: DeError>(self, value: f64) -> Result<i64, E> {
        // A double that already lost the low bits cannot be recovered, but
        // refusing it would drop the whole message; take what is there.
        Ok(value as i64)
    }
}

/// The same rule for a list of `(snowflake, bytes)` pairs — the shape sender
/// keys are announced in.
pub mod pairs {
    use serde::de::{Deserializer, SeqAccess, Visitor};
    use serde::ser::{SerializeSeq, Serializer};
    use serde::Deserialize;
    use std::fmt;

    pub fn serialize<S: Serializer>(
        pairs: &[(i64, Vec<u8>)],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(pairs.len()))?;
        for (id, bytes) in pairs {
            seq.serialize_element(&(id.to_string(), bytes))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<(i64, Vec<u8>)>, D::Error> {
        deserializer.deserialize_seq(PairsVisitor)
    }

    struct PairsVisitor;

    #[derive(Deserialize)]
    struct Pair(#[serde(with = "super")] i64, Vec<u8>);

    impl<'de> Visitor<'de> for PairsVisitor {
        type Value = Vec<(i64, Vec<u8>)>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a list of [snowflake, bytes] pairs")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(Pair(id, bytes)) = seq.next_element::<Pair>()? {
                out.push((id, bytes));
            }
            Ok(out)
        }
    }

    #[cfg(test)]
    mod tests {
        use serde::{Deserialize, Serialize};

        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Holder {
            #[serde(with = "super")]
            keys: Vec<(i64, Vec<u8>)>,
        }

        #[test]
        fn recipient_ids_travel_as_strings_and_read_back_from_either_shape() {
            let holder = Holder {
                keys: vec![(357608638640033792, vec![1, 2, 3])],
            };
            let json = serde_json::to_string(&holder).unwrap();
            assert!(
                json.contains("\"357608638640033792\""),
                "recipient id must be a string: {json}"
            );
            assert_eq!(serde_json::from_str::<Holder>(&json).unwrap(), holder);

            let legacy = r#"{"keys":[[357608638640033792,[1,2,3]]]}"#;
            assert_eq!(serde_json::from_str::<Holder>(legacy).unwrap(), holder);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Holder {
        #[serde(with = "super")]
        user_id: i64,
    }

    /// The id a browser reads must survive `JSON.parse`, which means it has to
    /// arrive quoted: 357608638640033792 as a bare number comes back as
    /// 357608638640033800.
    #[test]
    fn a_snowflake_is_written_as_a_string() {
        let json = serde_json::to_string(&Holder {
            user_id: 357608638640033792,
        })
        .unwrap();
        assert_eq!(json, r#"{"user_id":"357608638640033792"}"#);
    }

    #[test]
    fn a_snowflake_reads_back_from_a_string_or_a_number() {
        assert_eq!(
            serde_json::from_str::<Holder>(r#"{"user_id":"357608638640033792"}"#)
                .unwrap()
                .user_id,
            357608638640033792
        );
        assert_eq!(
            serde_json::from_str::<Holder>(r#"{"user_id":357608638640033792}"#)
                .unwrap()
                .user_id,
            357608638640033792
        );
    }

    #[test]
    fn a_non_numeric_string_is_refused() {
        assert!(serde_json::from_str::<Holder>(r#"{"user_id":"not-an-id"}"#).is_err());
    }
}
