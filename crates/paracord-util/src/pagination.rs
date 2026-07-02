use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CursorParams {
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub limit: Option<u32>,
}

impl CursorParams {
    pub fn limit(&self) -> u32 {
        self.limit.unwrap_or(50).min(100)
    }
}

impl Default for CursorParams {
    fn default() -> Self {
        Self {
            before: None,
            after: None,
            limit: Some(50),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CursorResponse<T: Serialize> {
    pub items: Vec<T>,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
pub struct PaginationParams {
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub limit: Option<i32>,
}

impl PaginationParams {
    pub fn limit(&self) -> i32 {
        self.limit.unwrap_or(50).clamp(1, 100)
    }
}

impl Default for PaginationParams {
    fn default() -> Self {
        Self {
            before: None,
            after: None,
            limit: Some(50),
        }
    }
}
