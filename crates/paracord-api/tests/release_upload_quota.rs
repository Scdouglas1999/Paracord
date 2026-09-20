mod common;

use common::{build_test_app, TestAppOptions};
use paracord_api::routes::files::process_uploaded_file_with_id;

#[tokio::test]
async fn concurrent_pending_uploads_cannot_exceed_guild_quota() -> anyhow::Result<()> {
    let mut app = build_test_app(TestAppOptions {
        database_connections: 8,
        ..Default::default()
    })
    .await?;
    app.state.config.max_guild_storage_quota = 10;
    // The admin dashboard's `server_settings` row outranks the config value (so
    // a change takes effect without a restart), and the test database seeds that
    // row with the 5 GiB default. Setting only the config left the ceiling at
    // 5 GiB, and every one of the eight uploads below fitted under it.
    paracord_db::server_settings::set_setting(&app.db, "max_guild_storage_quota", "10").await?;
    paracord_db::users::create_user(
        &app.db,
        101,
        "uploader",
        1,
        "uploader@example.test",
        "fixture",
    )
    .await?;
    paracord_db::guilds::create_guild(&app.db, 201, "Upload quota", 101, None).await?;
    paracord_db::members::add_member(&app.db, 101, 201).await?;
    for channel in [301, 302] {
        paracord_db::channels::create_channel(&app.db, channel, 201, "files", 0, 0, None, None)
            .await?;
    }

    // Eight independent upload futures race across two channels in one guild.
    // A ten-byte quota may admit only two four-byte pending attachments, even
    // before a message is posted. The shared path is used by HTTP and QUIC.
    let uploads = futures_util::future::join_all((401..409).map(|id| {
        process_uploaded_file_with_id(
            &app.state,
            b"data",
            "file.bin",
            Some("application/octet-stream"),
            301 + id % 2,
            101,
            id,
        )
    }))
    .await;
    assert_eq!(uploads.iter().filter(|result| result.is_ok()).count(), 2);
    for (offset, result) in uploads.iter().enumerate() {
        let id = 401 + offset as i64;
        if result.is_err() {
            assert!(result.as_ref().unwrap_err().to_string().contains("quota"));
            assert!(paracord_db::attachments::get_attachment(&app.db, id)
                .await?
                .is_none());
            assert!(app
                .state
                .storage_backend
                .retrieve(&format!("attachments/{id}.bin"))
                .await
                .is_err());
        }
    }
    assert_eq!(
        paracord_db::guild_storage_policies::get_guild_storage_usage(&app.db, 201).await?,
        8
    );

    // Removal releases capacity; another guild's uploads do not consume it.
    let winner = 401 + uploads.iter().position(Result::is_ok).unwrap() as i64;
    paracord_db::attachments::delete_attachment(&app.db, winner).await?;
    process_uploaded_file_with_id(&app.state, b"data", "next.bin", None, 301, 101, 501).await?;
    paracord_db::guilds::create_guild(&app.db, 202, "Independent quota", 101, None).await?;
    paracord_db::members::add_member(&app.db, 101, 202).await?;
    paracord_db::channels::create_channel(&app.db, 303, 202, "files", 0, 0, None, None).await?;
    process_uploaded_file_with_id(&app.state, b"1234567890", "other.bin", None, 303, 101, 502)
        .await?;
    assert_eq!(
        paracord_db::guild_storage_policies::get_guild_storage_usage(&app.db, 201).await?,
        8
    );
    assert_eq!(
        paracord_db::guild_storage_policies::get_guild_storage_usage(&app.db, 202).await?,
        10
    );
    Ok(())
}
