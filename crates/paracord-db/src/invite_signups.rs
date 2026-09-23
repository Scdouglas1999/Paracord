//! Accounts created with an invite while the instance was invite-only.
//!
//! See the `invite_signups` migration for why this is tracked separately from
//! an invite's `uses`.

use crate::{datetime_to_db_text, DbError, DbPool};
use chrono::Utc;

/// Take one of `invite_code`'s account slots for `user_id`.
///
/// `max_accounts` is the invite's `max_uses`; zero or less means no limit.
/// Returns `false` when the invite has already created that many accounts.
/// Called before the account row is inserted, so a refused registration
/// never leaves an account behind; [`release`] gives the slot back if the
/// insert then fails.
pub async fn reserve(
    pool: &DbPool,
    invite_code: &str,
    user_id: i64,
    max_accounts: i64,
) -> Result<bool, DbError> {
    let inserted = sqlx::query(
        "INSERT INTO invite_signups (user_id, invite_code, created_at)
         SELECT $1, $2, $3
         WHERE $4 <= 0
            OR (SELECT COUNT(*) FROM invite_signups WHERE invite_code = $2) < $4",
    )
    .bind(user_id)
    .bind(invite_code)
    .bind(datetime_to_db_text(Utc::now()))
    .bind(max_accounts)
    .execute(pool)
    .await?;
    Ok(inserted.rows_affected() == 1)
}

/// Give back a slot taken by [`reserve`] for an account that was never created.
pub async fn release(pool: &DbPool, user_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM invite_signups WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// How many accounts `invite_code` has created.
pub async fn count_for_invite(pool: &DbPool, invite_code: &str) -> Result<i64, DbError> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM invite_signups WHERE invite_code = $1")
            .bind(invite_code)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_limited_invite_creates_at_most_its_uses_in_accounts() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();

        assert!(reserve(&pool, "abc", 1, 2).await.unwrap());
        assert!(reserve(&pool, "abc", 2, 2).await.unwrap());
        assert!(!reserve(&pool, "abc", 3, 2).await.unwrap());
        assert_eq!(count_for_invite(&pool, "abc").await.unwrap(), 2);

        // Another invite has its own slots, and no limit means no limit.
        assert!(reserve(&pool, "other", 4, 0).await.unwrap());
        assert!(reserve(&pool, "other", 5, 0).await.unwrap());

        // A released slot can be taken again.
        release(&pool, 2).await.unwrap();
        assert!(reserve(&pool, "abc", 6, 2).await.unwrap());
    }
}
