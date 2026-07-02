use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: i64,
    pub filename: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub url: String,
    pub proxy_url: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}
