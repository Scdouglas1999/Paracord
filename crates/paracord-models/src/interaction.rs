use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::command::{ApplicationCommandType, CommandOptionType};
use crate::component::Component;
use crate::embed::Embed;
use crate::member::Member;
use crate::message::Message;
use crate::user::User;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum InteractionType {
    Ping = 1,
    ApplicationCommand = 2,
    MessageComponent = 3,
    ApplicationCommandAutocomplete = 4,
    ModalSubmit = 5,
}

impl Serialize for InteractionType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for InteractionType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u8::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::Ping),
            2 => Ok(Self::ApplicationCommand),
            3 => Ok(Self::MessageComponent),
            4 => Ok(Self::ApplicationCommandAutocomplete),
            5 => Ok(Self::ModalSubmit),
            _ => Err(serde::de::Error::custom(format!(
                "unknown InteractionType: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum InteractionCallbackType {
    Pong = 1,
    ChannelMessageWithSource = 4,
    DeferredChannelMessageWithSource = 5,
    DeferredUpdateMessage = 6,
    UpdateMessage = 7,
    ApplicationCommandAutocompleteResult = 8,
    Modal = 9,
}

impl Serialize for InteractionCallbackType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for InteractionCallbackType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u8::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::Pong),
            4 => Ok(Self::ChannelMessageWithSource),
            5 => Ok(Self::DeferredChannelMessageWithSource),
            6 => Ok(Self::DeferredUpdateMessage),
            7 => Ok(Self::UpdateMessage),
            8 => Ok(Self::ApplicationCommandAutocompleteResult),
            9 => Ok(Self::Modal),
            _ => Err(serde::de::Error::custom(format!(
                "unknown InteractionCallbackType: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedCommandOption {
    pub name: String,
    #[serde(rename = "type")]
    pub option_type: CommandOptionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Vec<ResolvedCommandOption>,
    #[serde(default)]
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionData {
    /// Command ID (for application command interactions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    /// Command name (for application command interactions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Command type (for application command interactions)
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub command_type: Option<ApplicationCommandType>,
    /// Resolved command options
    #[serde(default)]
    pub options: Vec<ResolvedCommandOption>,
    /// Custom ID (for message component and modal interactions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
    /// Component type (for message component interactions)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_type: Option<u8>,
    /// Selected values (for select menu interactions)
    #[serde(default)]
    pub values: Vec<String>,
    /// Target ID (for user/message context menu commands)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<i64>,
    /// Modal components (for modal submit)
    #[serde(default)]
    pub components: Vec<Component>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interaction {
    pub id: i64,
    pub application_id: i64,
    #[serde(rename = "type")]
    pub interaction_type: InteractionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InteractionData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member: Option<Member>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    pub token: String,
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Box<Message>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionResponse {
    #[serde(rename = "type")]
    pub response_type: InteractionCallbackType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InteractionCallbackData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutocompleteChoice {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionCallbackData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embeds: Vec<Embed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<Component>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    /// For autocomplete responses
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<AutocompleteChoice>,
    /// Modal title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Modal custom_id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
}
