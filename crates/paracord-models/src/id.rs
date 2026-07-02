use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! define_snowflake_id {
    ($name:ident) => {
        #[derive(
            Debug,
            Clone,
            Copy,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            Serialize,
            Deserialize,
            sqlx::Type,
        )]
        #[serde(transparent)]
        #[sqlx(transparent)]
        pub struct $name(pub i64);

        impl $name {
            #[inline]
            pub const fn new(value: i64) -> Self {
                Self(value)
            }

            #[inline]
            pub const fn get(self) -> i64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl From<i64> for $name {
            #[inline]
            fn from(value: i64) -> Self {
                Self(value)
            }
        }

        impl From<$name> for i64 {
            #[inline]
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

define_snowflake_id!(UserId);
define_snowflake_id!(GuildId);
define_snowflake_id!(ChannelId);
define_snowflake_id!(MessageId);
define_snowflake_id!(RoleId);
define_snowflake_id!(EmojiId);
