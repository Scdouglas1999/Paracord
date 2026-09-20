mod common;

use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
use paracord_api::routes::files::process_uploaded_file_with_id;
use paracord_util::at_rest::FileCryptor;

#[tokio::test]
async fn duplicate_transfer_ids_cannot_overwrite_committed_encrypted_bytes() {
    let mut app = build_test_app(TestAppOptions::default()).await.unwrap();
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "quicowner", "Ownerpass123!")
            .await
            .unwrap();
    let owner = paracord_core::auth::validate_token(&token, &app.jwt_secret)
        .unwrap()
        .sub;
    let guild = paracord_util::snowflake::generate(1);
    let channel = paracord_util::snowflake::generate(1);
    let attachment = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&app.db, guild, "QUIC files", owner, None)
        .await
        .unwrap();
    paracord_db::members::add_member(&app.db, owner, guild)
        .await
        .unwrap();
    paracord_db::channels::create_channel(&app.db, channel, guild, "files", 0, 0, None, None)
        .await
        .unwrap();
    let cryptor = FileCryptor::from_master_key(&[53; 32], false);
    app.state.config.file_cryptor = Some(cryptor.clone());
    // Independent server runtimes can race the same signed transfer against
    // one database/storage backend; its database key must arbitrate *before*
    // either losing attempt can write the winner's storage object.
    let (first, second) = tokio::join!(
        process_uploaded_file_with_id(
            &app.state,
            b"first payload",
            "file.bin",
            Some("application/octet-stream"),
            channel,
            owner,
            attachment
        ),
        process_uploaded_file_with_id(
            &app.state,
            b"different second payload",
            "file.bin",
            Some("application/octet-stream"),
            channel,
            owner,
            attachment
        ),
    );
    assert_ne!(
        first.is_ok(),
        second.is_ok(),
        "exactly one transfer may commit"
    );
    let expected: &[u8] = if first.is_ok() {
        b"first payload"
    } else {
        b"different second payload"
    };
    let key = format!("attachments/{attachment}.bin");
    let stored = app.state.storage_backend.retrieve(&key).await.unwrap();
    assert!(FileCryptor::payload_is_encrypted(&stored));
    assert_eq!(
        cryptor
            .decrypt_with_aad(&stored, format!("attachment:{attachment}").as_bytes())
            .unwrap(),
        expected
    );
    assert!(process_uploaded_file_with_id(
        &app.state,
        b"replacement",
        "file.bin",
        Some("application/octet-stream"),
        channel,
        owner,
        attachment
    )
    .await
    .is_err());
    assert_eq!(
        app.state.storage_backend.retrieve(&key).await.unwrap(),
        stored
    );

    let outsider_token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "quicoutsider", "Otherpass123!")
            .await
            .unwrap();
    let outsider = paracord_core::auth::validate_token(&outsider_token, &app.jwt_secret)
        .unwrap()
        .sub;
    let denied = paracord_util::snowflake::generate(1);
    assert!(process_uploaded_file_with_id(
        &app.state,
        b"not allowed",
        "file.bin",
        Some("application/octet-stream"),
        channel,
        outsider,
        denied
    )
    .await
    .is_err());
    assert!(paracord_db::attachments::get_attachment(&app.db, denied)
        .await
        .unwrap()
        .is_none());
}
