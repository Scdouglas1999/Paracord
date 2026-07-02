use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::attachment::Attachment;
use crate::embed::Embed;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i16)]
pub enum MessageType {
    Default = 0,
    RecipientAdd = 1,
    RecipientRemove = 2,
    Call = 3,
    ChannelNameChange = 4,
    ChannelIconChange = 5,
    PinnedMessage = 6,
    GuildMemberJoin = 7,
    SystemMessage = 8,
    Reply = 19,
    Poll = 20,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub channel_id: i64,
    pub author: MessageAuthor,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub edited_timestamp: Option<DateTime<Utc>>,
    pub tts: bool,
    pub mention_everyone: bool,
    pub pinned: bool,
    pub message_type: MessageType,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    pub reactions: Vec<Reaction>,
    pub referenced_message: Option<Box<Message>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageAuthor {
    pub id: i64,
    pub username: String,
    pub discriminator: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: i32,
    pub me: bool,
}
