mod common;

use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
use paracord_util::at_rest::FileCryptor;
use tower::ServiceExt;

#[tokio::test]
async fn attachment_reads_enforce_encryption_policy_and_preserve_authorized_migration() {
    for allow_plaintext in [false, true] {
        let mut app = build_test_app(TestAppOptions::default()).await.unwrap();
        let token = create_authenticated_user_token(
            &app.db,
            &app.jwt_secret,
            "encryptedfiles",
            "FileOwner123!",
        )
        .await
        .unwrap();
        let owner = paracord_core::auth::validate_token(&token, &app.jwt_secret)
            .unwrap()
            .sub;
        let guild = paracord_util::snowflake::generate(1);
        let channel = paracord_util::snowflake::generate(1);
        let message = paracord_util::snowflake::generate(1);
        let attachment = paracord_util::snowflake::generate(1);
        paracord_db::guilds::create_guild(&app.db, guild, "Files", owner, None)
            .await
            .unwrap();
        paracord_db::members::add_member(&app.db, owner, guild)
            .await
            .unwrap();
        paracord_db::channels::create_channel(&app.db, channel, guild, "files", 0, 0, None, None)
            .await
            .unwrap();
        paracord_db::messages::create_message(&app.db, message, channel, owner, "file", 0, None)
            .await
            .unwrap();
        paracord_db::attachments::create_attachment(
            &app.db,
            attachment,
            Some(message),
            "test.txt",
            Some("text/plain"),
            9,
            "",
            None,
            None,
            Some(owner),
            Some(channel),
            None,
            None,
        )
        .await
        .unwrap();
        let cryptor = FileCryptor::from_master_key(&[42; 32], allow_plaintext);
        app.state.config.file_cryptor = Some(cryptor.clone());
        let router = paracord_api::build_router(&app.state).with_state(app.state.clone());
        let key = format!("attachments/{attachment}.txt");
        let aad = format!("attachment:{attachment}");
        let plaintext = b"test data";
        app.state
            .storage_backend
            .store(&key, plaintext)
            .await
            .unwrap();
        let download = || {
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v1/attachments/{attachment}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        let response = router.clone().oneshot(download()).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let stored = app.state.storage_backend.retrieve(&key).await.unwrap();
        if allow_plaintext {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body.as_ref(), plaintext);
            assert!(FileCryptor::payload_is_encrypted(&stored));
            assert_eq!(
                cryptor.decrypt_with_aad(&stored, aad.as_bytes()).unwrap(),
                plaintext
            );
        } else {
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert!(!body
                .windows(plaintext.len())
                .any(|window| window == plaintext));
            assert_eq!(
                stored, plaintext,
                "strict rejection cannot bless a plaintext replacement"
            );
        }
        let encrypted = cryptor.encrypt_with_aad(plaintext, aad.as_bytes()).unwrap();
        app.state
            .storage_backend
            .store(&key, &encrypted)
            .await
            .unwrap();
        let response = router.clone().oneshot(download()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 4096).await.unwrap().as_ref(),
            plaintext
        );
        // A ciphertext copied from another attachment must fail authentication.
        let relocated = cryptor
            .encrypt_with_aad(plaintext, b"attachment:other")
            .unwrap();
        app.state
            .storage_backend
            .store(&key, &relocated)
            .await
            .unwrap();
        let response = router.oneshot(download()).await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
