use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ApplicationCommandRow {
    pub id: i64,
    pub application_id: i64,
    pub guild_id: Option<i64>,
    pub name: String,
    pub description: String,
    pub options: Option<String>,
    pub cmd_type: i16,
    pub default_member_permissions: Option<i64>,
    pub dm_permission: bool,
    pub nsfw: bool,
    pub version: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const SELECT_COLS: &str = "id, application_id, guild_id, name, description, options, type, default_member_permissions, CASE WHEN dm_permission THEN 1 ELSE 0 END AS dm_permission, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, version, created_at, updated_at";

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ApplicationCommandRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            application_id: row.try_get("application_id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            options: row.try_get("options")?,
            cmd_type: row.try_get("type")?,
            default_member_permissions: row.try_get("default_member_permissions")?,
            dm_permission: bool_from_any_row(row, "dm_permission")?,
            nsfw: bool_from_any_row(row, "nsfw")?,
            version: row.try_get("version")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

pub async fn create_command(
    pool: &DbPool,
    id: i64,
    application_id: i64,
    guild_id: Option<i64>,
    name: &str,
    description: &str,
    options: Option<&str>,
    cmd_type: i16,
    default_member_permissions: Option<i64>,
    dm_permission: bool,
    nsfw: bool,
) -> Result<ApplicationCommandRow, DbError> {
    let sql = format!(
        "INSERT INTO application_commands (id, application_id, guild_id, name, description, options, type, default_member_permissions, dm_permission, nsfw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING {SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, ApplicationCommandRow>(&sql)
        .bind(id)
        .bind(application_id)
        .bind(guild_id)
        .bind(name)
        .bind(description)
        .bind(options)
        .bind(cmd_type)
        .bind(default_member_permissions)
        .bind(dm_permission)
        .bind(nsfw)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn get_command(pool: &DbPool, id: i64) -> Result<Option<ApplicationCommandRow>, DbError> {
    let sql = format!("SELECT {SELECT_COLS} FROM application_commands WHERE id = $1");
    let row = sqlx::query_as::<_, ApplicationCommandRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn list_global_commands(
    pool: &DbPool,
    application_id: i64,
) -> Result<Vec<ApplicationCommandRow>, DbError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM application_commands WHERE application_id = $1 AND guild_id IS NULL ORDER BY name"
    );
    let rows = sqlx::query_as::<_, ApplicationCommandRow>(&sql)
        .bind(application_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn list_guild_commands(
    pool: &DbPool,
    application_id: i64,
    guild_id: i64,
) -> Result<Vec<ApplicationCommandRow>, DbError> {
    let sql = format!(
        "SELECT {SELECT_COLS} FROM application_commands WHERE application_id = $1 AND guild_id = $2 ORDER BY name"
    );
    let rows = sqlx::query_as::<_, ApplicationCommandRow>(&sql)
        .bind(application_id)
        .bind(guild_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn update_command(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    description: Option<&str>,
    options: Option<&str>,
    default_member_permissions: Option<i64>,
    dm_permission: Option<bool>,
    nsfw: Option<bool>,
) -> Result<ApplicationCommandRow, DbError> {
    let sql = format!(
        "UPDATE application_commands SET
            name = COALESCE($2, name),
            description = COALESCE($3, description),
            options = COALESCE($4, options),
            default_member_permissions = COALESCE($5, default_member_permissions),
            dm_permission = COALESCE($6, dm_permission),
            nsfw = COALESCE($7, nsfw),
            version = version + 1,
            updated_at = $8
         WHERE id = $1
         RETURNING {SELECT_COLS}"
    );
    let row = sqlx::query_as::<_, ApplicationCommandRow>(&sql)
        .bind(id)
        .bind(name)
        .bind(description)
        .bind(options)
        .bind(default_member_permissions)
        .bind(dm_permission)
        .bind(nsfw)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn delete_command(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM application_commands WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn bulk_overwrite_global_commands(
    pool: &DbPool,
    application_id: i64,
    commands: &[(i64, &str, &str, Option<&str>, i16, Option<i64>, bool, bool)],
) -> Result<Vec<ApplicationCommandRow>, DbError> {
    // Wrap in a transaction for atomicity
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM application_commands WHERE application_id = $1 AND guild_id IS NULL")
        .bind(application_id)
        .execute(&mut *tx)
        .await?;

    let insert_sql = format!(
        "INSERT INTO application_commands (id, application_id, guild_id, name, description, options, type, default_member_permissions, dm_permission, nsfw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING {SELECT_COLS}"
    );

    let mut results = Vec::with_capacity(commands.len());
    for &(
        id,
        name,
        description,
        options,
        cmd_type,
        default_member_permissions,
        dm_permission,
        nsfw,
    ) in commands
    {
        let row = sqlx::query_as::<_, ApplicationCommandRow>(&insert_sql)
            .bind(id)
            .bind(application_id)
            .bind(None::<i64>) // global command
            .bind(name)
            .bind(description)
            .bind(options)
            .bind(cmd_type)
            .bind(default_member_permissions)
            .bind(dm_permission)
            .bind(nsfw)
            .fetch_one(&mut *tx)
            .await?;
        results.push(row);
    }

    tx.commit().await?;
    Ok(results)
}

pub async fn bulk_overwrite_guild_commands(
    pool: &DbPool,
    application_id: i64,
    guild_id: i64,
    commands: &[(i64, &str, &str, Option<&str>, i16, Option<i64>, bool, bool)],
) -> Result<Vec<ApplicationCommandRow>, DbError> {
    // Wrap in a transaction for atomicity
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM application_commands WHERE application_id = $1 AND guild_id = $2")
        .bind(application_id)
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;

    let insert_sql = format!(
        "INSERT INTO application_commands (id, application_id, guild_id, name, description, options, type, default_member_permissions, dm_permission, nsfw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING {SELECT_COLS}"
    );

    let mut results = Vec::with_capacity(commands.len());
    for &(
        id,
        name,
        description,
        options,
        cmd_type,
        default_member_permissions,
        dm_permission,
        nsfw,
    ) in commands
    {
        let row = sqlx::query_as::<_, ApplicationCommandRow>(&insert_sql)
            .bind(id)
            .bind(application_id)
            .bind(Some(guild_id))
            .bind(name)
            .bind(description)
            .bind(options)
            .bind(cmd_type)
            .bind(default_member_permissions)
            .bind(dm_permission)
            .bind(nsfw)
            .fetch_one(&mut *tx)
            .await?;
        results.push(row);
    }

    tx.commit().await?;
    Ok(results)
}

pub async fn list_guild_available_commands(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<ApplicationCommandRow>, DbError> {
    // Returns both global commands (for bots installed in this guild) and
    // guild-scoped commands for this guild.
    let sql =
        "SELECT c.id, c.application_id, c.guild_id, c.name, c.description, c.options, c.type, \
         c.default_member_permissions, \
         CASE WHEN c.dm_permission THEN 1 ELSE 0 END AS dm_permission, \
         CASE WHEN c.nsfw THEN 1 ELSE 0 END AS nsfw, \
         c.version, c.created_at, c.updated_at \
         FROM application_commands c \
         INNER JOIN bot_guild_installs bgi ON bgi.bot_app_id = c.application_id \
         WHERE bgi.guild_id = $1 AND (c.guild_id IS NULL OR c.guild_id = $1) \
         ORDER BY c.name";
    let rows = sqlx::query_as::<_, ApplicationCommandRow>(sql)
        .bind(guild_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_pool, run_migrations};

    async fn setup_app(pool: &DbPool, owner_id: i64, app_id: i64, bot_user_id: i64) {
        crate::users::create_user(pool, owner_id, "owner", 1, "owner@example.com", "hash")
            .await
            .unwrap();
        crate::users::create_user(pool, bot_user_id, "botuser", 2, "bot@example.com", "hash")
            .await
            .unwrap();
        crate::bot_applications::create_bot_application(
            pool,
            app_id,
            "test-bot",
            Some("desc"),
            owner_id,
            bot_user_id,
            "tokhash",
            None,
            0,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn create_and_list_global_command() {
        let pool = create_pool("sqlite::memory:", 1).await.unwrap();
        run_migrations(&pool).await.unwrap();
        setup_app(&pool, 1, 100, 2).await;

        let created = create_command(
            &pool,
            500,
            100,
            None,
            "ping",
            "Ping command",
            None,
            1,
            None,
            true,
            false,
        )
        .await
        .unwrap();

        assert_eq!(created.name, "ping");
        assert_eq!(created.application_id, 100);
        assert!(created.guild_id.is_none());

        let listed = list_global_commands(&pool, 100).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, 500);
    }
}
