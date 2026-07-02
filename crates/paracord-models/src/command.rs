use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i16)]
pub enum ApplicationCommandType {
    ChatInput = 1,
    User = 2,
    Message = 3,
}

impl Serialize for ApplicationCommandType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i16(*self as i16)
    }
}

impl<'de> Deserialize<'de> for ApplicationCommandType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i16::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::ChatInput),
            2 => Ok(Self::User),
            3 => Ok(Self::Message),
            _ => Err(serde::de::Error::custom(format!(
                "unknown ApplicationCommandType: {value}"
            ))),
        }
    }
}

impl Default for ApplicationCommandType {
    fn default() -> Self {
        Self::ChatInput
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i16)]
pub enum CommandOptionType {
    SubCommand = 1,
    SubCommandGroup = 2,
    String = 3,
    Integer = 4,
    Boolean = 5,
    User = 6,
    Channel = 7,
    Role = 8,
    Mentionable = 9,
    Number = 10,
    Attachment = 11,
}

impl Serialize for CommandOptionType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i16(*self as i16)
    }
}

impl<'de> Deserialize<'de> for CommandOptionType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i16::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::SubCommand),
            2 => Ok(Self::SubCommandGroup),
            3 => Ok(Self::String),
            4 => Ok(Self::Integer),
            5 => Ok(Self::Boolean),
            6 => Ok(Self::User),
            7 => Ok(Self::Channel),
            8 => Ok(Self::Role),
            9 => Ok(Self::Mentionable),
            10 => Ok(Self::Number),
            11 => Ok(Self::Attachment),
            _ => Err(serde::de::Error::custom(format!(
                "unknown CommandOptionType: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOptionChoice {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOption {
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub option_type: CommandOptionType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub choices: Vec<CommandOptionChoice>,
    #[serde(default)]
    pub options: Vec<CommandOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(default)]
    pub autocomplete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationCommand {
    pub id: i64,
    pub application_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<i64>,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub options: Vec<CommandOption>,
    #[serde(rename = "type", default)]
    pub command_type: ApplicationCommandType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_member_permissions: Option<i64>,
    #[serde(default = "default_true")]
    pub dm_permission: bool,
    #[serde(default)]
    pub nsfw: bool,
    pub version: i64,
}

fn default_true() -> bool {
    true
}
