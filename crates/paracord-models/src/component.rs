use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ComponentType {
    ActionRow = 1,
    Button = 2,
    StringSelect = 3,
    TextInput = 4,
    UserSelect = 5,
    RoleSelect = 6,
    MentionableSelect = 7,
    ChannelSelect = 8,
}

impl Serialize for ComponentType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for ComponentType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u8::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::ActionRow),
            2 => Ok(Self::Button),
            3 => Ok(Self::StringSelect),
            4 => Ok(Self::TextInput),
            5 => Ok(Self::UserSelect),
            6 => Ok(Self::RoleSelect),
            7 => Ok(Self::MentionableSelect),
            8 => Ok(Self::ChannelSelect),
            _ => Err(serde::de::Error::custom(format!(
                "unknown ComponentType: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ButtonStyle {
    Primary = 1,
    Secondary = 2,
    Success = 3,
    Danger = 4,
    Link = 5,
}

impl Serialize for ButtonStyle {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for ButtonStyle {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u8::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::Primary),
            2 => Ok(Self::Secondary),
            3 => Ok(Self::Success),
            4 => Ok(Self::Danger),
            5 => Ok(Self::Link),
            _ => Err(serde::de::Error::custom(format!(
                "unknown ButtonStyle: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TextInputStyle {
    Short = 1,
    Paragraph = 2,
}

impl Serialize for TextInputStyle {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> Deserialize<'de> for TextInputStyle {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u8::deserialize(deserializer)?;
        match value {
            1 => Ok(Self::Short),
            2 => Ok(Self::Paragraph),
            _ => Err(serde::de::Error::custom(format!(
                "unknown TextInputStyle: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectOption {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub default: bool,
}

/// A flat component struct that uses `component_type` to distinguish variants.
///
/// Using a flat struct avoids serde `tag` conflicts with the integer `type`
/// discriminator. Fields that don't apply to a given component type are simply
/// `None` / empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    #[serde(rename = "type")]
    pub component_type: ComponentType,
    /// Child components (only for ActionRow)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<Component>,
    /// Custom identifier for the component (buttons, selects, text inputs)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
    /// Button style
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<u8>,
    /// Button/select label or text input label
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Emoji for buttons
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<ComponentEmoji>,
    /// URL for link-style buttons
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Whether the component is disabled
    #[serde(default)]
    pub disabled: bool,
    /// Options for string select menus
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SelectOption>,
    /// Placeholder text for selects and text inputs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Minimum number of selected values (selects)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_values: Option<u32>,
    /// Maximum number of selected values (selects)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_values: Option<u32>,
    /// Minimum input length (text inputs)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    /// Maximum input length (text inputs)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// Whether the text input is required
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// Pre-filled value for text inputs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentEmoji {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub animated: bool,
}
