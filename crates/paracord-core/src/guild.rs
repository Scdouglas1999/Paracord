use rand::Rng;

use crate::error::CoreError;
use crate::permissions;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

/// Bound on `spaces.icon_hash`.
///
/// The column is `TEXT` on purpose — it legitimately holds an inline `data:`
/// URL as well as a hash — but it was not bounded at all: whatever the caller
/// sent was stored verbatim and then broadcast in `GUILD_UPDATE` to every
/// session in the guild, each writer materialising its own copy. One 2 MiB
/// PATCH therefore cost ~2 MiB of transient egress allocation *per connected
/// session*. 256 KiB of base64 is roughly 192 KiB of image, comfortably more
/// than any space icon needs and small enough that the fan-out copy is not a
/// weapon.
pub(crate) const MAX_ICON_LEN: usize = 256 * 1024;

/// Bound on the two free-form JSON settings blobs, which are stored and
/// broadcast on exactly the same path as the icon. A real `hub_settings` or
/// `bot_settings` object is a few kilobytes; 64 KiB holds a large bot roster
/// with room to spare.
pub(crate) const MAX_SETTINGS_LEN: usize = 64 * 1024;

/// Reject an over-long value before it reaches the column, and therefore before
/// it reaches the `GUILD_UPDATE` fan-out.
pub(crate) fn ensure_within_len(
    value: Option<&str>,
    max: usize,
    field: &str,
) -> Result<(), CoreError> {
    match value {
        Some(v) if v.len() > max => Err(CoreError::BadRequest(format!(
            "{field} must be {max} bytes or fewer"
        ))),
        _ => Ok(()),
    }
}

/// Generate a random invite code.
pub fn generate_invite_code(length: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Create a full guild with owner membership, @everyone role, and default channels.
///
/// The six writes are all-or-nothing: if any step after the guild row fails, the
/// guild is deleted again (every child table cascades off `spaces.id`) and the
/// original error is returned. A partial guild is unrecoverable for the user —
/// without the owner's member row they can neither enter it nor delete it.
///
/// This is a compensating rollback, not a real transaction: `paracord-db`
/// exposes only `&DbPool` entry points, so the writes cannot share one `sqlx`
/// transaction from here. A concurrent reader can still observe the half-built
/// guild during the failure window.
pub async fn create_guild_full(
    pool: &DbPool,
    guild_id: i64,
    name: &str,
    owner_id: i64,
    icon_hash: Option<&str>,
) -> Result<paracord_db::guilds::GuildRow, CoreError> {
    ensure_within_len(icon_hash, MAX_ICON_LEN, "icon")?;

    let guild =
        paracord_db::guilds::create_guild(pool, guild_id, name, owner_id, icon_hash).await?;

    match seed_new_guild(pool, guild_id, owner_id).await {
        Ok(()) => Ok(guild),
        Err(err) => {
            if let Err(cleanup_err) = paracord_db::guilds::delete_guild(pool, guild_id).await {
                tracing::error!(
                    guild_id,
                    error = %cleanup_err,
                    "failed to roll back a partially created guild; it is left unusable"
                );
            }
            Err(err)
        }
    }
}

/// Populate a freshly created guild with its owner membership, default role and
/// starter channels. Split out of [`create_guild_full`] so every failure path
/// funnels through one rollback.
async fn seed_new_guild(pool: &DbPool, guild_id: i64, owner_id: i64) -> Result<(), CoreError> {
    // Add owner as member
    paracord_db::members::add_member(pool, owner_id, guild_id).await?;

    // Create the default Member role (role id = guild id).
    let default_perms = Permissions::default().bits();
    paracord_db::roles::create_role(pool, guild_id, guild_id, "Member", default_perms).await?;

    // Assign Member role to owner
    paracord_db::roles::add_member_role(pool, owner_id, guild_id, guild_id).await?;

    // Create #general text channel
    let general_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(pool, general_id, guild_id, "general", 0, 0, None, None)
        .await?;

    // Create General voice channel
    let voice_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(pool, voice_id, guild_id, "General", 2, 1, None, None)
        .await?;

    Ok(())
}

/// Delete a guild, only allowed by the owner.
pub async fn delete_guild(pool: &DbPool, guild_id: i64, user_id: i64) -> Result<(), CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if guild.owner_id != user_id {
        return Err(CoreError::Forbidden);
    }

    paracord_db::guilds::delete_guild(pool, guild_id).await?;
    Ok(())
}

/// Update guild fields, requires MANAGE_GUILD permission.
#[allow(clippy::too_many_arguments)]
pub async fn update_guild(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
    hub_settings: Option<&str>,
    bot_settings: Option<&str>,
    visibility: Option<&str>,
    discovery_tags: Option<&str>,
    allowed_roles: Option<&str>,
) -> Result<paracord_db::guilds::GuildRow, CoreError> {
    // Length-check before the permission read: an over-long body is rejected
    // without spending a pool connection on it.
    ensure_within_len(icon_hash, MAX_ICON_LEN, "icon")?;
    ensure_within_len(hub_settings, MAX_SETTINGS_LEN, "hub_settings")?;
    ensure_within_len(bot_settings, MAX_SETTINGS_LEN, "bot_settings")?;

    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let perms =
        permissions::compute_guild_permissions(pool, guild_id, guild.owner_id, user_id).await?;
    permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;

    let mut updated = paracord_db::guilds::update_guild(
        pool,
        guild_id,
        name,
        description,
        icon_hash,
        hub_settings,
        bot_settings,
    )
    .await?;
    if visibility.is_some() || discovery_tags.is_some() || allowed_roles.is_some() {
        let next_visibility = visibility.unwrap_or(&updated.visibility);
        let next_discovery_tags = discovery_tags.unwrap_or(&updated.discovery_tags);
        // Non-role visibility must not retain stale role gates.
        let next_allowed_roles = if next_visibility != "roles" {
            Some("[]")
        } else {
            let effective = allowed_roles.unwrap_or(&updated.allowed_roles);
            if paracord_db::guilds::parse_allowed_role_ids(effective).is_empty() {
                return Err(CoreError::BadRequest(
                    "visibility \"roles\" requires at least one allowed role".into(),
                ));
            }
            Some(effective)
        };
        updated = paracord_db::guilds::update_space_visibility(
            pool,
            guild_id.into(),
            next_visibility,
            next_discovery_tags,
            next_allowed_roles,
        )
        .await?;
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_pool() -> DbPool {
        let pool = paracord_db::create_pool("sqlite::memory:", 1)
            .await
            .expect("create in-memory pool");
        paracord_db::run_migrations(&pool)
            .await
            .expect("run migrations");
        pool
    }

    #[tokio::test]
    async fn create_guild_full_seeds_owner_membership() {
        let pool = mem_pool().await;
        paracord_db::users::create_user(&pool, 1, "owner", 1, "owner@x", "h")
            .await
            .unwrap();

        let guild = create_guild_full(&pool, 100, "g", 1, None).await.unwrap();
        assert_eq!(guild.id, 100);
        assert!(paracord_db::members::get_member(&pool, 1, 100)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            paracord_db::channels::get_guild_channels(&pool, 100)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn create_guild_full_rolls_back_a_partial_guild() {
        let pool = mem_pool().await;
        paracord_db::users::create_user(&pool, 1, "owner", 1, "owner@x", "h")
            .await
            .unwrap();
        // Park a role on the id that create_guild_full will try to use for the new
        // guild's default role (role id == guild id), so the third write fails.
        paracord_db::guilds::create_guild(&pool, 100, "other", 1, None)
            .await
            .unwrap();
        paracord_db::roles::create_role(&pool, 200, 100, "squatter", 0)
            .await
            .unwrap();

        let result = create_guild_full(&pool, 200, "g", 1, None).await;
        assert!(result.is_err(), "the role insert must fail");
        assert!(
            paracord_db::guilds::get_guild(&pool, 200)
                .await
                .unwrap()
                .is_none(),
            "a guild whose owner is not a member must not survive; it can be \
             neither entered nor deleted"
        );
    }
}
