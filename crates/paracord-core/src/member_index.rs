use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use paracord_db::DbPool;

/// In-memory index of all server member IDs for O(1) lookups.
#[derive(Clone)]
pub struct MemberIndex {
    inner: Arc<RwLock<HashSet<i64>>>,
}

impl MemberIndex {
    /// Load all member IDs from the database at startup.
    pub async fn load(pool: &DbPool) -> Self {
        let ids = paracord_db::members::get_all_member_ids(pool)
            .await
            .unwrap_or_default();
        let count = ids.len();
        let set: HashSet<i64> = ids.into_iter().collect();
        tracing::info!("MemberIndex loaded {} members from database", count);
        Self {
            inner: Arc::new(RwLock::new(set)),
        }
    }

    pub async fn contains(&self, user_id: i64) -> bool {
        self.inner.read().await.contains(&user_id)
    }

    pub async fn insert(&self, user_id: i64) {
        self.inner.write().await.insert(user_id);
    }

    pub async fn remove(&self, user_id: i64) {
        self.inner.write().await.remove(&user_id);
    }

    /// Snapshot of all member IDs.
    pub async fn all_member_ids(&self) -> HashSet<i64> {
        self.inner.read().await.clone()
    }
}
