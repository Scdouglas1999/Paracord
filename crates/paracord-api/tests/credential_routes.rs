//! One password (docs/setup-spec.md §3.3–§3.11, §9.1): every credential route
//! against the real router, the shared test vectors, and the downgrade paths a
//! hostile or old client could try.
//!
//! This binary must never call `common::allow_legacy_signup()`: it checks that
//! the legacy sign-up routes refuse.

mod common;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::http::{Method, StatusCode};
use base64::Engine;
use chrono::{Duration, Utc};
use common::{build_json_request, build_test_app, dispatch_json, TestApp, TestAppOptions};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const REGISTER: &str = "paracord/credential/v2/register";
const RESET: &str = "paracord/credential/v2/reset";
const CLAIM_TOKEN: &str = "CREDENTIALCLAIMTOKEN0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// S2's own vector, generated from the spec's exact definitions with the
/// client's scrypt (`@noble/hashes`) and Node's AES-GCM / Ed25519, before S1's
/// shared vectors existed. Kept as a second, independently produced case.
const S2_VECTOR: &str = r#"{
  "password": "Correct horse battery staple ✓",
  "salt_b64url": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  "kdf": "scrypt:17:8:1",
  "master_hex": "da6c8f36bdd256296baa852c14478d1cfcb217553da38e664ee6c30a951e4e9e",
  "auth_key_b64url": "VhcIR9friijLbvz4DfT4LqO5Fzdd7-sdMUJMw07fNsU",
  "wrap_key_hex": "ab878dd01e6ece0f9be6be3064a66ec4c487dae73305060c8a1578fcab21299a",
  "identity_sk_hex": "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
  "public_key_hex": "2543b92ff1095511476adc8369db6ddc933665a11978dda1404ee1066ca9559d",
  "iv_hex": "a0a1a2a3a4a5a6a7a8a9aaab",
  "wrapped_key_b64url": "oKGio6SlpqeoqaqryX259Smwc89CMPc--gnwdP_ffFNN-MtNH9gzVtG4dTZaRga1q60YerrbMxcsqvp1",
  "proof": {
    "nonce": "0000000000000000000000000000000000000000000000000000000000000000",
    "timestamp": 1760000000,
    "origin": "https://paracord.test",
    "register_signature_hex": "70ce7147d5e25cf8ed17c1a4fe473bd44365583cdefa024dbc6ed2635db7b8faa1c0c7ec5188fc1bd734eeacd9c836ebe63d52e46b058785cb15d0f7e4a90903",
    "reset_signature_hex": "6357c3aa026150257e579f4be8623f28cc7875821507c3ae932dda290c3adba7b72e6228bcb09cf94938d27162f2e56eeb710cf25ef2c13e9215e066a1ed8905"
  }
}"#;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("hex"))
        .collect()
}

/// A client-side credential stand-in: the server only ever sees the salt, the
/// KDF and the auth key, so fixed bytes are as good as a derived key here.
#[derive(Clone)]
struct Cred {
    salt: [u8; 32],
    auth_key: [u8; 32],
    log_n: u8,
}

impl Cred {
    fn new(seed: u8) -> Self {
        Self {
            salt: [seed; 32],
            auth_key: [seed.wrapping_add(100); 32],
            log_n: 17,
        }
    }
    fn json(&self) -> Value {
        json!({
            "salt": b64(&self.salt),
            "kdf": { "alg": "scrypt", "log_n": self.log_n, "r": 8, "p": 1 },
            "auth_key": b64(&self.auth_key),
        })
    }
    fn auth(&self) -> String {
        b64(&self.auth_key)
    }
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn public_hex(key: &SigningKey) -> String {
    hex(key.verifying_key().as_bytes())
}

fn wrapped(seed: u8) -> String {
    b64(&[seed; 60])
}

async fn send(
    app: &TestApp,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let request = build_json_request(method, path, body, token).expect("request");
    dispatch_json(&app.app, request).await.expect("dispatch")
}

async fn post(app: &TestApp, path: &str, body: Value, token: Option<&str>) -> (StatusCode, Value) {
    send(app, Method::POST, path, Some(body), token).await
}

async fn challenge(app: &TestApp) -> (String, i64, String) {
    let (status, body) = post(app, "/api/v1/auth/challenge", json!({}), None).await;
    assert_eq!(status, StatusCode::OK, "challenge: {body}");
    (
        body["nonce"].as_str().unwrap().to_string(),
        body["timestamp"].as_i64().unwrap(),
        body["server_origin"].as_str().unwrap().to_string(),
    )
}

/// A fresh proof: `"<purpose>:<nonce>:<timestamp>:<origin>"` signed by `key`.
async fn proof(app: &TestApp, key: &SigningKey, purpose: &str) -> Value {
    let (nonce, timestamp, origin) = challenge(app).await;
    let message = format!("{purpose}:{nonce}:{timestamp}:{origin}");
    json!({
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": hex(&key.sign(message.as_bytes()).to_bytes()),
    })
}

async fn identity(app: &TestApp, key: &SigningKey, purpose: &str, wrap_seed: u8) -> Value {
    json!({
        "public_key": public_hex(key),
        "wrapped_key": wrapped(wrap_seed),
        "wrap_alg": "aes256gcm-v2",
        "proof": proof(app, key, purpose).await,
    })
}

async fn register(app: &TestApp, name: &str, cred: &Cred, key: &SigningKey) -> (StatusCode, Value) {
    let body = json!({
        "username": name,
        "email": format!("{name}@example.com"),
        "credential": cred.json(),
        "identity": identity(app, key, REGISTER, 7).await,
    });
    post(app, "/api/v1/auth/credential/register", body, None).await
}

/// Register and return the session token and user id.
async fn registered(app: &TestApp, name: &str, cred: &Cred, key: &SigningKey) -> (String, i64) {
    let (status, body) = register(app, name, cred, key).await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    (
        body["token"].as_str().unwrap().to_string(),
        body["user"]["id"].as_str().unwrap().parse().unwrap(),
    )
}

async fn login(app: &TestApp, identifier: &str, auth_key: &str) -> (StatusCode, Value) {
    post(
        app,
        "/api/v1/auth/credential/login",
        json!({ "identifier": identifier, "auth_key": auth_key }),
        None,
    )
    .await
}

async fn params(app: &TestApp, identifier: &str) -> Value {
    let (status, body) = post(
        app,
        "/api/v1/auth/credential/params",
        json!({ "identifier": identifier }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "params: {body}");
    body
}

async fn credential(app: &TestApp, user_id: i64) -> paracord_db::credentials::CredentialRow {
    paracord_db::credentials::get(&app.db, user_id)
        .await
        .unwrap()
        .expect("credential row")
}

/// A legacy (v1) account with a password and a live session.
async fn legacy_account(app: &TestApp, name: &str, password: &str) -> (String, i64) {
    let id = paracord_util::snowflake::generate(1);
    let hash = paracord_core::auth::hash_password(password).unwrap();
    let user = paracord_db::users::create_user(
        &app.db,
        id,
        name,
        0,
        &format!("{name}@example.com"),
        &hash,
    )
    .await
    .unwrap();
    (session_for(app, user.id).await, user.id)
}

async fn session_for(app: &TestApp, user_id: i64) -> String {
    let session_id = format!("sess-{}", Uuid::new_v4().simple());
    let jti = format!("jti-{}", Uuid::new_v4().simple());
    paracord_db::sessions::create_session(
        &app.db,
        &session_id,
        user_id,
        &Uuid::new_v4().simple().to_string(),
        &jti,
        None,
        None,
        None,
        None,
        Utc::now() + Duration::days(1),
    )
    .await
    .unwrap();
    paracord_core::auth::create_session_token(
        user_id,
        None,
        &app.jwt_secret,
        3600,
        &session_id,
        &jti,
    )
    .unwrap()
}

async fn me(app: &TestApp, token: &str) -> StatusCode {
    send(app, Method::GET, "/api/v1/users/@me", None, Some(token))
        .await
        .0
}

async fn app() -> TestApp {
    build_test_app(TestAppOptions::default()).await.unwrap()
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/// Check one vector against the spec's definitions (§3.2, §3.3): HKDF from
/// `master`, the AES-256-GCM wrap with its AAD, the public key, and the proof
/// signatures through the server's own verifier.
fn check_vector(vector: &Value) {
    let master = unhex(vector["master_hex"].as_str().unwrap());
    let hk = Hkdf::<Sha256>::new(None, &master);
    let mut auth = [0u8; 32];
    hk.expand(b"paracord/credential/v2/auth", &mut auth)
        .unwrap();
    let mut wrap = [0u8; 32];
    hk.expand(b"paracord/credential/v2/wrap", &mut wrap)
        .unwrap();
    assert_eq!(b64(&auth), vector["auth_key_b64url"].as_str().unwrap());
    assert_eq!(hex(&wrap), vector["wrap_key_hex"].as_str().unwrap());

    let public_key = vector["public_key_hex"].as_str().unwrap();
    let wrapped = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(vector["wrapped_key_b64url"].as_str().unwrap())
        .unwrap();
    assert_eq!(wrapped.len(), 60, "iv12 || ciphertext32 || tag16");
    assert_eq!(hex(&wrapped[..12]), vector["iv_hex"].as_str().unwrap());
    let aad = format!("paracord/identity/v2|{public_key}");
    let secret = Aes256Gcm::new_from_slice(&wrap)
        .unwrap()
        .decrypt(
            Nonce::from_slice(&wrapped[..12]),
            Payload {
                msg: &wrapped[12..],
                aad: aad.as_bytes(),
            },
        )
        .expect("the wrapped identity opens with the wrap key and the v2 AAD");
    assert_eq!(hex(&secret), vector["identity_sk_hex"].as_str().unwrap());
    let signing = SigningKey::from_bytes(&secret.try_into().unwrap());
    assert_eq!(public_hex(&signing), public_key);

    // The wrap key, not the auth key, opens it: the server's key is useless.
    assert!(Aes256Gcm::new_from_slice(&auth)
        .unwrap()
        .decrypt(
            Nonce::from_slice(&wrapped[..12]),
            Payload {
                msg: &wrapped[12..],
                aad: aad.as_bytes(),
            },
        )
        .is_err());

    let proof = &vector["proof"];
    for (purpose, field) in [
        (REGISTER, "register_signature_hex"),
        (RESET, "reset_signature_hex"),
    ] {
        assert!(paracord_core::credential::verify_proof_signature(
            purpose,
            public_key,
            proof["nonce"].as_str().unwrap(),
            proof["timestamp"].as_i64().unwrap(),
            proof["origin"].as_str().unwrap(),
            proof[field].as_str().unwrap(),
        ));
    }
    assert!(!paracord_core::credential::verify_proof_signature(
        REGISTER,
        public_key,
        proof["nonce"].as_str().unwrap(),
        proof["timestamp"].as_i64().unwrap(),
        proof["origin"].as_str().unwrap(),
        proof["reset_signature_hex"].as_str().unwrap(),
    ));

    // The KDF salt input is SHA-256("paracord/credential/v2/salt" || salt);
    // the server never runs scrypt, but its stored salt must decode to 32 bytes.
    let salt = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(vector["salt_b64url"].as_str().unwrap())
        .unwrap();
    assert_eq!(salt.len(), 32);
    let _scrypt_salt = Sha256::digest([b"paracord/credential/v2/salt".as_slice(), &salt].concat());
    assert_eq!(vector["kdf"].as_str().unwrap(), "scrypt:17:8:1");
}

#[test]
fn s2_vector_matches_the_spec_definitions() {
    check_vector(&serde_json::from_str(S2_VECTOR).unwrap());
}

/// S1's shared vectors (`client/src/lib/credential/vectors.json`, copied to
/// `tests/fixtures/credential_vectors.json`) satisfy the same definitions, byte
/// for byte, through the server's own code: the salt hash and HKDF from each
/// `master`, the wrapped identity and its AAD, every proof, the full register
/// body, and the KDF policy cases. (Their `master` values were also recomputed
/// with an independent scrypt when S2 reconciled them.)
#[test]
fn shared_vectors_match() {
    let raw = include_str!("fixtures/credential_vectors.json");
    let v: Value = serde_json::from_str(raw).expect("shared vectors parse");
    let labels = &v["labels"];
    assert_eq!(labels["salt"], "paracord/credential/v2/salt");
    assert_eq!(labels["auth_info"], "paracord/credential/v2/auth");
    assert_eq!(labels["wrap_info"], "paracord/credential/v2/wrap");
    assert_eq!(labels["aad_prefix"], "paracord/identity/v2|");
    assert_eq!(labels["wrap_alg"], "aes256gcm-v2");

    for d in v["derivation"].as_array().unwrap() {
        let name = d["name"].as_str().unwrap();
        let password = d["password"].as_str().unwrap();
        let nfkc: String = unicode_nfkc(password);
        assert_eq!(hex(nfkc.as_bytes()), d["password_utf8_hex"], "{name}: NFKC");
        let salt = unhex(d["salt_hex"].as_str().unwrap());
        assert_eq!(b64(&salt), d["salt"], "{name}: salt encoding");
        let scrypt_salt =
            Sha256::digest([b"paracord/credential/v2/salt".as_slice(), &salt].concat());
        assert_eq!(hex(&scrypt_salt), d["scrypt_salt_hex"], "{name}: salt hash");
        let kdf: paracord_contracts::credential::KdfParams =
            serde_json::from_value(d["kdf"].clone()).unwrap();
        assert_eq!(kdf.to_db_text(), d["kdf_text"].as_str().unwrap());
        let hk = Hkdf::<Sha256>::new(None, &unhex(d["master_hex"].as_str().unwrap()));
        let mut auth = [0u8; 32];
        hk.expand(b"paracord/credential/v2/auth", &mut auth)
            .unwrap();
        let mut wrap = [0u8; 32];
        hk.expand(b"paracord/credential/v2/wrap", &mut wrap)
            .unwrap();
        assert_eq!(hex(&auth), d["auth_key_hex"], "{name}: auth key");
        assert_eq!(b64(&auth), d["auth_key"], "{name}: auth key b64url");
        assert_eq!(hex(&wrap), d["wrap_key_hex"], "{name}: wrap key");
        // The server's decoder accepts exactly this encoding.
        assert_eq!(
            paracord_core::credential::decode_auth_key(d["auth_key"].as_str().unwrap()),
            Some(auth)
        );
    }

    for w in v["wrap"].as_array().unwrap() {
        let wrap = unhex(w["wrap_key_hex"].as_str().unwrap());
        let public_key = w["public_key"].as_str().unwrap();
        let aad = format!("paracord/identity/v2|{public_key}");
        assert_eq!(w["aad"], aad.as_str());
        let wrapped = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(w["wrapped_key"].as_str().unwrap())
            .unwrap();
        assert_eq!(wrapped.len(), 60);
        assert_eq!(hex(&wrapped[..12]), w["iv_hex"]);
        let secret = Aes256Gcm::new_from_slice(&wrap)
            .unwrap()
            .decrypt(
                Nonce::from_slice(&wrapped[..12]),
                Payload {
                    msg: &wrapped[12..],
                    aad: aad.as_bytes(),
                },
            )
            .expect("the shared wrapped identity opens");
        assert_eq!(hex(&secret), w["private_key_hex"]);
        let signing = SigningKey::from_bytes(&secret.try_into().unwrap());
        assert_eq!(public_hex(&signing), public_key);
        assert!(
            paracord_core::credential::check_wrapped_key(w["wrapped_key"].as_str().unwrap())
                .is_ok()
        );
    }

    for p in v["proofs"].as_array().unwrap() {
        let purpose = p["purpose"].as_str().unwrap();
        let nonce = p["nonce"].as_str().unwrap();
        let timestamp = p["timestamp"].as_i64().unwrap();
        let origin = p["origin"].as_str().unwrap();
        assert_eq!(
            paracord_core::credential::proof_message(purpose, nonce, timestamp, origin),
            p["message"].as_str().unwrap()
        );
        let public_key = p["public_key"].as_str().unwrap();
        let signature = p["signature"].as_str().unwrap();
        assert!(
            paracord_core::credential::verify_proof_signature(
                purpose, public_key, nonce, timestamp, origin, signature
            ),
            "{purpose}"
        );
        let other = if purpose == REGISTER { RESET } else { REGISTER };
        assert!(!paracord_core::credential::verify_proof_signature(
            other, public_key, nonce, timestamp, origin, signature
        ));
    }

    // The register vector carries the credential and identity parts of the
    // request body (no username): each must be its contract type and pass.
    let credential: paracord_contracts::credential::NewCredential =
        serde_json::from_value(v["register"]["credential"].clone()).expect("credential contract");
    let new_identity: paracord_contracts::credential::NewIdentity =
        serde_json::from_value(v["register"]["identity"].clone()).expect("identity contract");
    paracord_core::credential::check_credential(&credential).expect("credential passes");
    let identity =
        paracord_core::credential::check_identity(&new_identity).expect("identity passes");
    let proof = &new_identity.proof;
    assert!(paracord_core::credential::verify_proof_signature(
        REGISTER,
        &identity.public_key,
        &proof.nonce,
        proof.timestamp,
        v["register"]["origin"].as_str().unwrap(),
        &proof.signature,
    ));

    let policy = &v["kdf_policy"];
    for (cases, allowed) in [
        (&policy["accept"], true),
        (&policy["refuse_weaker"], false),
        (&policy["refuse_heavier"], false),
    ] {
        for case in cases.as_array().unwrap() {
            let kdf: paracord_contracts::credential::KdfParams =
                serde_json::from_value(case.clone()).unwrap();
            assert_eq!(
                paracord_core::credential::check_kdf(&kdf).is_ok(),
                allowed,
                "{case}"
            );
        }
    }
}

/// NFKC as the client applies it, for the vector check above.
fn unicode_nfkc(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    value.nfkc().collect()
}

#[tokio::test]
async fn the_vector_credential_registers_and_signs_in() {
    let app = app().await;
    let vector: Value = serde_json::from_str(S2_VECTOR).unwrap();
    let secret: [u8; 32] = unhex(vector["identity_sk_hex"].as_str().unwrap())
        .try_into()
        .unwrap();
    let signing = SigningKey::from_bytes(&secret);
    let body = json!({
        "username": "vector",
        "email": "vector@example.com",
        "credential": {
            "salt": vector["salt_b64url"],
            "kdf": { "alg": "scrypt", "log_n": 17, "r": 8, "p": 1 },
            "auth_key": vector["auth_key_b64url"],
        },
        "identity": {
            "public_key": vector["public_key_hex"],
            "wrapped_key": vector["wrapped_key_b64url"],
            "wrap_alg": "aes256gcm-v2",
            "proof": proof(&app, &signing, REGISTER).await,
        },
    });
    let (status, body) = post(&app, "/api/v1/auth/credential/register", body, None).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["user"]["public_key"], vector["public_key_hex"]);

    let p = params(&app, "vector@example.com").await;
    assert_eq!(p["version"], 2);
    assert_eq!(p["salt"], vector["salt_b64url"]);
    assert_eq!(p["epoch"], 1);
    let (status, body) = login(
        &app,
        "vector@example.com",
        vector["auth_key_b64url"].as_str().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = body["token"].as_str().unwrap();
    let (status, backup) = send(
        &app,
        Method::GET,
        "/api/v1/users/@me/key-backup",
        None,
        Some(token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(backup["wrapped_key"], vector["wrapped_key_b64url"]);
    assert_eq!(backup["public_key"], vector["public_key_hex"]);
    assert_eq!(backup["wrap_alg"], "aes256gcm-v2");
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

#[tokio::test]
async fn params_do_not_reveal_who_exists() {
    let app = app().await;
    let cred = Cred {
        log_n: 18,
        ..Cred::new(1)
    };
    let (_, v2_id) = registered(&app, "paramsv2", &cred, &key(1)).await;
    legacy_account(&app, "paramsv1", "Legacy-password-1").await;
    // A key-only account (`/auth/verify` sign-up shape).
    let key_only = paracord_db::users::create_user_from_pubkey(
        &app.db,
        paracord_util::snowflake::generate(1),
        &public_hex(&key(9)),
        "keyonly",
        None,
    )
    .await
    .unwrap();
    assert_eq!(credential(&app, key_only.id).await.version, 0);

    let real = params(&app, "paramsv2@example.com").await;
    assert_eq!(
        real,
        json!({
            "version": 2,
            "kdf": { "alg": "scrypt", "log_n": 18, "r": 8, "p": 1 },
            "salt": b64(&cred.salt),
            "epoch": 1,
        })
    );
    assert_eq!(credential(&app, v2_id).await.epoch, 1);
    assert_eq!(
        params(&app, "paramsv1@example.com").await,
        json!({ "version": 1 })
    );

    let unknown = params(&app, "nobody@example.com").await;
    let key_only_params = params(&app, &key_only.email).await;
    for fake in [&unknown, &key_only_params] {
        let keys: Vec<_> = fake.as_object().unwrap().keys().collect();
        let real_keys: Vec<_> = real.as_object().unwrap().keys().collect();
        assert_eq!(keys, real_keys, "same shape as a real account");
        assert_eq!(fake["version"], 2);
        assert_eq!(
            fake["kdf"],
            json!({ "alg": "scrypt", "log_n": 17, "r": 8, "p": 1 })
        );
        assert_eq!(fake["epoch"], 1);
        let salt = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(fake["salt"].as_str().unwrap())
            .unwrap();
        assert_eq!(salt.len(), 32);
    }
    // Stable per identifier (a retry looks like the same account), case-blind.
    assert_eq!(params(&app, "Nobody@Example.com").await, unknown);
    assert_ne!(
        params(&app, "nobody2@example.com").await["salt"],
        unknown["salt"]
    );
    assert_eq!(
        unknown["salt"],
        paracord_core::credential::fake_salt(&app.jwt_secret, "nobody@example.com")
    );
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

#[tokio::test]
async fn register_stores_the_credential_identity_and_backup() {
    let app = app().await;
    let cred = Cred::new(2);
    let signing = key(2);
    let (token, user_id) = registered(&app, "signup", &cred, &signing).await;

    let row = credential(&app, user_id).await;
    assert_eq!(row.version, 2);
    assert_eq!(row.epoch, 1);
    assert_eq!(row.kdf.as_deref(), Some("scrypt:17:8:1"));
    assert_eq!(row.salt.as_deref(), Some(b64(&cred.salt).as_str()));
    assert_eq!(
        row.public_key.as_deref(),
        Some(public_hex(&signing).as_str())
    );
    assert!(row.password_hash.starts_with("$argon2id$"));
    assert!(
        !paracord_core::auth::verify_password(&cred.auth(), &row.password_hash).unwrap(),
        "the stored hash is over the raw key, never a typed string"
    );

    let (status, backup) = send(
        &app,
        Method::GET,
        "/api/v1/users/@me/key-backup",
        None,
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        backup,
        json!({
            "public_key": public_hex(&signing),
            "wrapped_key": wrapped(7),
            "wrap_alg": "aes256gcm-v2",
            "epoch": 1,
            "recovery_confirmed": false,
        })
    );
    let (status, _) = post(
        &app,
        "/api/v1/users/@me/key-backup/recovery-confirmed",
        json!({}),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, backup) = send(
        &app,
        Method::GET,
        "/api/v1/users/@me/key-backup",
        None,
        Some(&token),
    )
    .await;
    assert_eq!(backup["recovery_confirmed"], true);

    // No backup: 404, not an empty body.
    let (legacy_token, _) = legacy_account(&app, "nobackup", "Legacy-password-1").await;
    let (status, _) = send(
        &app,
        Method::GET,
        "/api/v1/users/@me/key-backup",
        None,
        Some(&legacy_token),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn register_refuses_bad_material_and_bad_proofs() {
    let app = app().await;
    let signing = key(3);
    let base = |cred: Value, identity: Value| {
        json!({
            "username": "badsignup",
            "email": "badsignup@example.com",
            "credential": cred,
            "identity": identity,
        })
    };

    // Below the KDF floor, short keys, wrong wrap, wrong-length wrapped key.
    let mut weak = Cred::new(3).json();
    weak["kdf"]["log_n"] = json!(16);
    let mut short_key = Cred::new(3).json();
    short_key["auth_key"] = json!(b64(&[1u8; 31]));
    let mut short_salt = Cred::new(3).json();
    short_salt["salt"] = json!(b64(&[1u8; 16]));
    for cred in [weak, short_key, short_salt] {
        let body = base(cred, identity(&app, &signing, REGISTER, 1).await);
        let (status, body) = post(&app, "/api/v1/auth/credential/register", body, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let mut bad_wrap = identity(&app, &signing, REGISTER, 1).await;
    bad_wrap["wrapped_key"] = json!(b64(&[1u8; 59]));
    let mut bad_alg = identity(&app, &signing, REGISTER, 1).await;
    bad_alg["wrap_alg"] = json!("aes256gcm");
    let mut upper = identity(&app, &signing, REGISTER, 1).await;
    upper["public_key"] = json!(public_hex(&signing).to_uppercase());
    for identity in [bad_wrap, bad_alg, upper] {
        let body = base(Cred::new(3).json(), identity);
        let (status, body) = post(&app, "/api/v1/auth/credential/register", body, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    // A plain key sign-in signature is not a credential proof.
    let (nonce, timestamp, origin) = challenge(&app).await;
    let mut plain = identity(&app, &signing, REGISTER, 1).await;
    plain["proof"] = json!({
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": hex(&signing.sign(format!("{nonce}:{timestamp}:{origin}").as_bytes()).to_bytes()),
    });
    let (status, _) = post(
        &app,
        "/api/v1/auth/credential/register",
        base(Cred::new(3).json(), plain),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Nor is a proof for another purpose, or one signed by another key.
    let mut reset_purpose = identity(&app, &signing, RESET, 1).await;
    reset_purpose["public_key"] = json!(public_hex(&signing));
    let (status, _) = post(
        &app,
        "/api/v1/auth/credential/register",
        base(Cred::new(3).json(), reset_purpose),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut other_key = identity(&app, &key(4), REGISTER, 1).await;
    other_key["public_key"] = json!(public_hex(&signing));
    let (status, _) = post(
        &app,
        "/api/v1/auth/credential/register",
        base(Cred::new(3).json(), other_key),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Nothing was created by any of those.
    assert!(
        paracord_db::users::get_user_by_email(&app.db, "badsignup@example.com")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_proof_nonce_is_single_use() {
    let app = app().await;
    let signing = key(5);
    let identity = identity(&app, &signing, REGISTER, 1).await;
    let first = json!({
        "username": "nonceone",
        "email": "nonceone@example.com",
        "credential": Cred::new(5).json(),
        "identity": identity.clone(),
    });
    let (status, body) = post(&app, "/api/v1/auth/credential/register", first, None).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let replay = json!({
        "username": "noncetwo",
        "email": "noncetwo@example.com",
        "credential": Cred::new(6).json(),
        "identity": identity,
    });
    let (status, _) = post(&app, "/api/v1/auth/credential/register", replay, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn register_does_not_reveal_taken_names_or_keys() {
    let app = app().await;
    registered(&app, "taken", &Cred::new(8), &key(8)).await;
    // Same public key, new name; same name, new key: one generic answer.
    let (status, a) = register(&app, "fresh", &Cred::new(9), &key(8)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, b) = register(&app, "taken", &Cred::new(9), &key(9)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(a, b);
    assert_eq!(a["message"], "bad request: Unable to complete registration");
}

#[tokio::test]
async fn register_honors_the_invite_gate() {
    let app = app().await;
    registered(&app, "firstone", &Cred::new(10), &key(10)).await;
    app.state.runtime.write().await.registration_mode =
        paracord_core::registration::RegistrationMode::InviteOnly;
    let (status, body) = register(&app, "noinvite", &Cred::new(11), &key(11)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "INVITE_REQUIRED");
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

#[tokio::test]
async fn login_checks_the_auth_key_with_one_answer_for_every_failure() {
    let app = app().await;
    let cred = Cred::new(12);
    registered(&app, "signin", &cred, &key(12)).await;

    let (status, body) = login(&app, "signin@example.com", &cred.auth()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
    assert!(body["user"]["id"].as_str().is_some());

    let (wrong_status, wrong) = login(&app, "signin@example.com", &b64(&[0u8; 32])).await;
    let (unknown_status, unknown) = login(&app, "ghost@example.com", &cred.auth()).await;
    assert_eq!(wrong_status, StatusCode::UNAUTHORIZED);
    assert_eq!(unknown_status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        wrong, unknown,
        "a wrong key and a missing account look alike"
    );

    // A malformed key is refused before any lookup.
    let (status, _) = login(&app, "signin@example.com", "not-a-key").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A legacy account is pointed at its own path.
    legacy_account(&app, "oldsignin", "Legacy-password-1").await;
    let (status, body) = login(&app, "oldsignin@example.com", &cred.auth()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "credential_legacy");
}

#[tokio::test]
async fn login_takes_the_mfa_ticket_branch() {
    let app = app().await;
    let cred = Cred::new(13);
    let (_, user_id) = registered(&app, "mfaone", &cred, &key(13)).await;
    let secret = match totp_rs::Secret::generate_secret().to_encoded() {
        totp_rs::Secret::Encoded(encoded) => encoded,
        other => format!("{other}"),
    };
    paracord_db::mfa::upsert_mfa_secret(&app.db, user_id, &secret)
        .await
        .unwrap();
    paracord_db::mfa::enable_mfa(&app.db, user_id)
        .await
        .unwrap();
    let code_hash = format!("{:x}", Sha256::digest(b"AAAABBBBCCCCDDDD"));
    paracord_db::mfa::store_backup_codes(&app.db, user_id, &[code_hash])
        .await
        .unwrap();

    let (status, body) = login(&app, "mfaone@example.com", &cred.auth()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["token"], "");
    assert_eq!(body["user"]["mfa_required"], true);
    let ticket = body["user"]["mfa_ticket"].as_str().unwrap();
    let (status, body) = post(
        &app,
        "/api/v1/auth/mfa/login",
        json!({ "ticket": ticket, "code": "AAAA-BBBB-CCCC-DDDD" }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
}

// ---------------------------------------------------------------------------
// Downgrade attempts and legacy refusals (§3.10, §3.13)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn legacy_routes_refuse_one_password_accounts() {
    let app = app().await;
    let cred = Cred::new(14);
    let (token, user_id) = registered(&app, "nodowngrade", &cred, &key(14)).await;

    // The legacy sign-in, with anything a client could hold: the auth key as
    // text, or a password.
    for password in [cred.auth(), "Correct-horse-9".to_string()] {
        let (status, body) = post(
            &app,
            "/api/v1/auth/login",
            json!({ "email": "nodowngrade@example.com", "password": password }),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "credential_upgraded");
        assert_eq!(
            body["message"],
            "This account uses one-password sign-in. Update Paracord to sign in."
        );
    }

    // The legacy password change.
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/password",
        Some(json!({ "current_password": cred.auth(), "new_password": "Brand-new-password-1" })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "credential_upgraded");

    // The legacy email reset with a typed password.
    let raw = "a".repeat(64);
    let created = paracord_db::password_reset::create_reset_token_for_address(
        &app.db,
        &format!("{:x}", Sha256::digest(raw.as_bytes())),
        user_id,
        "nodowngrade@example.com",
        Utc::now() + Duration::minutes(30),
    )
    .await
    .unwrap();
    assert!(created);
    let (status, body) = post(
        &app,
        "/api/v1/auth/reset-password",
        json!({ "token": raw, "new_password": "Brand-new-password-1" }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "credential_upgraded");

    // A one-password account cannot "move" again.
    let (status, body) = post(
        &app,
        "/api/v1/auth/credential/upgrade",
        json!({
            "current_password": "whatever-it-was",
            "credential": Cred::new(15).json(),
            "identity": identity(&app, &key(14), REGISTER, 2).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "credential_upgraded");

    // Nothing moved: still version 2, same epoch, same key, and it still signs in.
    let row = credential(&app, user_id).await;
    assert_eq!((row.version, row.epoch), (2, 1));
    assert_eq!(row.salt.as_deref(), Some(b64(&cred.salt).as_str()));
    let (status, _) = login(&app, "nodowngrade@example.com", &cred.auth()).await;
    assert_eq!(status, StatusCode::OK);
    let params = params(&app, "nodowngrade@example.com").await;
    assert_eq!(params["version"], 2);
}

#[tokio::test]
async fn legacy_sign_up_routes_say_update() {
    let app = app().await;
    let (status, body) = post(
        &app,
        "/api/v1/auth/register",
        json!({
            "username": "oldclient",
            "email": "oldclient@example.com",
            "password": "Old-client-password-1",
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "{body}");
    assert_eq!(body["code"], "client_update_required");
    assert_eq!(
        body["message"],
        "Update Paracord to create an account on this server."
    );

    let pending = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let (status, body) = post(
        &pending,
        "/api/v1/setup/claim",
        json!({
            "token": CLAIM_TOKEN,
            "username": "owner",
            "password": "Owner-password-1",
            "instance_name": "Old",
            "initial_space_name": "Old",
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::GONE, "{body}");
    assert_eq!(body["code"], "client_update_required");
}

#[tokio::test]
async fn options_and_password_requirements_describe_one_password() {
    let app = app().await;
    let (status, body) = send(&app, Method::GET, "/api/v1/auth/options", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["credential_version"], 2);
    assert_eq!(body["min_password_length"], 10);
    let (status, body) = send(
        &app,
        Method::GET,
        "/api/v1/setup/password-requirements",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "min_length": 10,
            "max_length": 128,
            "requires_uppercase": false,
            "requires_lowercase": false,
            "requires_digit": false,
            "requires_symbol": false,
            "length_unit": "utf8_bytes",
            "enforced_by": "client",
        })
    );
}

// ---------------------------------------------------------------------------
// The v1 move (§3.11)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_legacy_account_moves_to_one_password_and_keeps_its_sessions() {
    let app = app().await;
    let (token, user_id) = legacy_account(&app, "mover", "Legacy-password-1").await;
    let other_session = session_for(&app, user_id).await;
    let cred = Cred::new(16);
    let signing = key(16);

    // Wrong legacy password: nothing changes.
    let (status, _) = post(
        &app,
        "/api/v1/auth/credential/upgrade",
        json!({
            "current_password": "Not-the-password-1",
            "credential": cred.json(),
            "identity": identity(&app, &signing, REGISTER, 3).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(credential(&app, user_id).await.version, 1);

    let (status, body) = post(
        &app,
        "/api/v1/auth/credential/upgrade",
        json!({
            "current_password": "Legacy-password-1",
            "credential": cred.json(),
            "identity": identity(&app, &signing, REGISTER, 3).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "epoch": 1 }));

    let row = credential(&app, user_id).await;
    assert_eq!((row.version, row.epoch), (2, 1));
    assert_eq!(
        row.public_key.as_deref(),
        Some(public_hex(&signing).as_str())
    );
    // Sessions are kept.
    assert_eq!(me(&app, &token).await, StatusCode::OK);
    assert_eq!(me(&app, &other_session).await, StatusCode::OK);
    // The new path signs in; the old one says update.
    let (status, _) = login(&app, "mover@example.com", &cred.auth()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = post(
        &app,
        "/api/v1/auth/login",
        json!({ "email": "mover@example.com", "password": "Legacy-password-1" }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "credential_upgraded");
}

#[tokio::test]
async fn the_move_keeps_an_existing_identity_and_refuses_another() {
    let app = app().await;
    let (token, user_id) = legacy_account(&app, "haskey", "Legacy-password-1").await;
    let mine = key(17);
    paracord_db::users::update_user_public_key(&app.db, user_id, &public_hex(&mine))
        .await
        .unwrap();

    let (status, body) = post(
        &app,
        "/api/v1/auth/credential/upgrade",
        json!({
            "current_password": "Legacy-password-1",
            "credential": Cred::new(17).json(),
            "identity": identity(&app, &key(18), REGISTER, 3).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "identity_mismatch");
    assert_eq!(credential(&app, user_id).await.version, 1);

    let (status, body) = post(
        &app,
        "/api/v1/auth/credential/upgrade",
        json!({
            "current_password": "Legacy-password-1",
            "credential": Cred::new(17).json(),
            "identity": identity(&app, &mine, REGISTER, 3).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn concurrent_moves_let_exactly_one_win() {
    let app = build_test_app(TestAppOptions {
        database_connections: 4,
        ..Default::default()
    })
    .await
    .unwrap();
    let (token, user_id) = legacy_account(&app, "racer", "Legacy-password-1").await;
    let signing = key(19);
    let mut bodies = Vec::new();
    for seed in [20u8, 21, 22, 23] {
        bodies.push(json!({
            "current_password": "Legacy-password-1",
            "credential": Cred::new(seed).json(),
            "identity": identity(&app, &signing, REGISTER, seed).await,
        }));
    }
    let results = futures_util::future::join_all(
        bodies
            .into_iter()
            .map(|body| post(&app, "/api/v1/auth/credential/upgrade", body, Some(&token))),
    )
    .await;
    let wins = results.iter().filter(|(s, _)| *s == StatusCode::OK).count();
    assert_eq!(wins, 1, "{results:?}");
    for (status, body) in results.iter().filter(|(s, _)| *s != StatusCode::OK) {
        assert_eq!(*status, StatusCode::CONFLICT, "{body}");
        assert!(
            body["code"] == "credential_upgraded" || body["code"] == "credential_changed",
            "{body}"
        );
    }
    let row = credential(&app, user_id).await;
    assert_eq!((row.version, row.epoch), (2, 1));
    let backup = paracord_db::key_backups::get(&app.db, user_id)
        .await
        .unwrap()
        .unwrap();
    // The stored credential and backup belong to the same winning request.
    let winner = [20u8, 21, 22, 23]
        .into_iter()
        .find(|seed| row.salt.as_deref() == Some(b64(&[*seed; 32]).as_str()))
        .expect("the stored salt is one of the requests'");
    assert_eq!(backup.wrapped_key, wrapped(winner));
}

// ---------------------------------------------------------------------------
// Change and recovery
// ---------------------------------------------------------------------------

#[tokio::test]
async fn change_replaces_the_credential_rewraps_and_signs_out_elsewhere() {
    let app = app().await;
    let old = Cred::new(24);
    let (token, user_id) = registered(&app, "changer", &old, &key(24)).await;
    let elsewhere = login(&app, "changer@example.com", &old.auth()).await.1["token"]
        .as_str()
        .unwrap()
        .to_string();
    post(
        &app,
        "/api/v1/users/@me/key-backup/recovery-confirmed",
        json!({}),
        Some(&token),
    )
    .await;

    let new = Cred::new(25);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(json!({
            "current_auth_key": b64(&[0u8; 32]),
            "credential": new.json(),
            "wrapped_key": wrapped(25),
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(json!({
            "current_auth_key": old.auth(),
            "credential": new.json(),
            "wrapped_key": wrapped(25),
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "epoch": 2 }));

    assert_eq!(me(&app, &token).await, StatusCode::OK, "this session stays");
    assert_eq!(me(&app, &elsewhere).await, StatusCode::UNAUTHORIZED);
    assert_eq!(
        login(&app, "changer@example.com", &old.auth()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, "changer@example.com", &new.auth()).await.0,
        StatusCode::OK
    );
    let p = params(&app, "changer@example.com").await;
    assert_eq!(
        (p["salt"].as_str().unwrap(), p["epoch"].as_i64().unwrap()),
        (b64(&new.salt).as_str(), 2)
    );

    let backup = paracord_db::key_backups::get(&app.db, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backup.wrapped_key, wrapped(25));
    assert_eq!(backup.credential_epoch, 2);
    assert_eq!(
        backup.public_key,
        public_hex(&key(24)),
        "the identity is kept"
    );
    assert!(backup.recovery_confirmed, "the same phrase still applies");

    // A legacy account is told to move first.
    let (legacy_token, _) = legacy_account(&app, "oldchanger", "Legacy-password-1").await;
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(json!({
            "current_auth_key": old.auth(),
            "credential": new.json(),
            "wrapped_key": wrapped(25),
        })),
        Some(&legacy_token),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "credential_legacy");
}

#[tokio::test]
async fn change_requires_the_second_factor_when_on() {
    let app = app().await;
    let old = Cred::new(26);
    let (token, user_id) = registered(&app, "mfachange", &old, &key(26)).await;
    let secret = match totp_rs::Secret::generate_secret().to_encoded() {
        totp_rs::Secret::Encoded(encoded) => encoded,
        other => format!("{other}"),
    };
    paracord_db::mfa::upsert_mfa_secret(&app.db, user_id, &secret)
        .await
        .unwrap();
    paracord_db::mfa::enable_mfa(&app.db, user_id)
        .await
        .unwrap();
    paracord_db::mfa::store_backup_codes(
        &app.db,
        user_id,
        &[format!("{:x}", Sha256::digest(b"AAAABBBBCCCCDDDD"))],
    )
    .await
    .unwrap();
    let body = |code: Option<&str>| {
        json!({
            "current_auth_key": old.auth(),
            "credential": Cred::new(27).json(),
            "wrapped_key": wrapped(27),
            "mfa_code": code,
        })
    };
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(body(None)),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(body(Some("ZZZZ-ZZZZ-ZZZZ-ZZZZ"))),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(credential(&app, user_id).await.epoch, 1);
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/v1/users/@me/credential",
        Some(body(Some("AAAA-BBBB-CCCC-DDDD"))),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Sign in with the identity key (`/auth/challenge` + `/auth/verify`).
async fn key_sign_in(app: &TestApp, key: &SigningKey, username: &str) -> String {
    let (nonce, timestamp, origin) = challenge(app).await;
    let signature = hex(&key
        .sign(format!("{nonce}:{timestamp}:{origin}").as_bytes())
        .to_bytes());
    let (status, body) = post(
        app,
        "/api/v1/auth/verify",
        json!({
            "public_key": public_hex(key),
            "nonce": nonce,
            "timestamp": timestamp,
            "signature": signature,
            "username": username,
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "key sign-in: {body}");
    body["token"].as_str().unwrap().to_string()
}

/// `/auth/verify` for recovery only (`existing_account_only`).
async fn recovery_sign_in(app: &TestApp, key: &SigningKey, username: &str) -> (StatusCode, Value) {
    let (nonce, timestamp, origin) = challenge(app).await;
    let signature = hex(&key
        .sign(format!("{nonce}:{timestamp}:{origin}").as_bytes())
        .to_bytes());
    post(
        app,
        "/api/v1/auth/verify",
        json!({
            "public_key": public_hex(key),
            "nonce": nonce,
            "timestamp": timestamp,
            "signature": signature,
            "username": username,
            "existing_account_only": true,
        }),
        None,
    )
    .await
}

#[tokio::test]
async fn recovery_with_an_unknown_phrase_makes_no_account() {
    let app = app().await;
    let signing = key(31);
    registered(&app, "known", &Cred::new(31), &signing).await;

    // A phrase whose key no account holds: refused, and nothing is created.
    let stranger = key(32);
    let (status, body) = recovery_sign_in(&app, &stranger, "stranger").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "no_account_for_key");
    assert_eq!(
        body["message"],
        "No account on this server uses that recovery phrase."
    );
    assert!(
        paracord_db::users::get_user_by_public_key(&app.db, &public_hex(&stranger))
            .await
            .unwrap()
            .is_none()
    );

    // The account's own phrase still signs in.
    let (status, body) = recovery_sign_in(&app, &signing, "known").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["token"].is_string());
}

#[tokio::test]
async fn the_phrase_holder_resets_the_password() {
    let app = app().await;
    let old = Cred::new(28);
    let signing = key(28);
    let (first_token, user_id) = registered(&app, "forgot", &old, &signing).await;

    let token = key_sign_in(&app, &signing, "forgot").await;
    let new = Cred::new(29);

    // A register-purpose proof, or one by another key, is not a reset proof.
    for (purpose, by) in [(REGISTER, &signing), (RESET, &key(30))] {
        let (status, _) = post(
            &app,
            "/api/v1/users/@me/credential/reset",
            json!({
                "credential": new.json(),
                "wrapped_key": wrapped(29),
                "proof": proof(&app, by, purpose).await,
            }),
            Some(&token),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(credential(&app, user_id).await.epoch, 1);

    let (status, body) = post(
        &app,
        "/api/v1/users/@me/credential/reset",
        json!({
            "credential": new.json(),
            "wrapped_key": wrapped(29),
            "proof": proof(&app, &signing, RESET).await,
        }),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "epoch": 2 }));
    assert_eq!(me(&app, &first_token).await, StatusCode::UNAUTHORIZED);
    assert_eq!(me(&app, &token).await, StatusCode::OK);
    assert_eq!(
        login(&app, "forgot@example.com", &new.auth()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        login(&app, "forgot@example.com", &old.auth()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let backup = paracord_db::key_backups::get(&app.db, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (backup.wrapped_key, backup.credential_epoch),
        (wrapped(29), 2)
    );
    assert_eq!(backup.public_key, public_hex(&signing));
}

#[tokio::test]
async fn start_over_by_email_installs_a_new_identity() {
    let app = app().await;
    let old = Cred::new(31);
    let old_key = key(31);
    let (token, user_id) = registered(&app, "startover", &old, &old_key).await;
    post(
        &app,
        "/api/v1/users/@me/key-backup/recovery-confirmed",
        json!({}),
        Some(&token),
    )
    .await;
    let raw = "b".repeat(64);
    assert!(paracord_db::password_reset::create_reset_token_for_address(
        &app.db,
        &format!("{:x}", Sha256::digest(raw.as_bytes())),
        user_id,
        "startover@example.com",
        Utc::now() + Duration::minutes(30),
    )
    .await
    .unwrap());

    let new = Cred::new(32);
    let new_key = key(32);
    let (status, body) = post(
        &app,
        "/api/v1/auth/reset-password",
        json!({
            "token": raw,
            "credential": new.json(),
            "identity": identity(&app, &new_key, RESET, 32).await,
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["epoch"], 2);

    let row = credential(&app, user_id).await;
    assert_eq!((row.version, row.epoch), (2, 2));
    assert_eq!(
        row.public_key.as_deref(),
        Some(public_hex(&new_key).as_str())
    );
    let backup = paracord_db::key_backups::get(&app.db, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backup.public_key, public_hex(&new_key));
    assert_eq!(backup.wrapped_key, wrapped(32));
    assert!(
        !backup.recovery_confirmed,
        "a new identity has a new phrase"
    );
    assert_eq!(me(&app, &token).await, StatusCode::UNAUTHORIZED);
    assert_eq!(
        login(&app, "startover@example.com", &new.auth()).await.0,
        StatusCode::OK
    );

    // The token is spent.
    let (status, _) = post(
        &app,
        "/api/v1/auth/reset-password",
        json!({
            "token": "b".repeat(64),
            "credential": Cred::new(33).json(),
            "identity": identity(&app, &key(33), RESET, 33).await,
        }),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_credential_claim_builds_the_owner_and_the_friends_server() {
    let app = build_test_app(TestAppOptions {
        instance_setup_complete: false,
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(paracord_db::instance_setup::set_claim_token(
        &app.db,
        &paracord_core::instance_setup::hash_claim_token(CLAIM_TOKEN),
        paracord_db::instance_setup::TOKEN_SOURCE_CONFIG,
        Utc::now(),
    )
    .await
    .unwrap());
    let cred = Cred::new(34);
    let signing = key(34);
    let body = |token: &str, identity: Value| {
        json!({
            "token": token,
            "username": "sam",
            "email": "sam@example.com",
            "display_name": "Sam",
            "instance_name": "Friday Night Crew",
            "initial_space_name": "Friday Night Crew",
            "initial_space_hue": 150,
            "initial_space_template": "friends",
            "credential": cred.json(),
            "identity": identity,
        })
    };

    let (status, _) = post(
        &app,
        "/api/v1/setup/credential-claim",
        body("WRONG", identity(&app, &signing, REGISTER, 34).await),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut bad_hue = body(CLAIM_TOKEN, identity(&app, &signing, REGISTER, 34).await);
    bad_hue["initial_space_hue"] = json!(360);
    let (status, _) = post(&app, "/api/v1/setup/credential-claim", bad_hue, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, claimed) = post(
        &app,
        "/api/v1/setup/credential-claim",
        body(CLAIM_TOKEN, identity(&app, &signing, REGISTER, 34).await),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{claimed}");
    assert_eq!(claimed["instance_name"], "Friday Night Crew");
    assert!(claimed["token"].as_str().is_some_and(|t| !t.is_empty()));
    let owner_id: i64 = claimed["user"]["id"].as_str().unwrap().parse().unwrap();
    let space_id: i64 = claimed["space"]["id"].as_str().unwrap().parse().unwrap();

    let row = credential(&app, owner_id).await;
    assert_eq!((row.version, row.epoch), (2, 1));
    assert_eq!(
        row.public_key.as_deref(),
        Some(public_hex(&signing).as_str())
    );
    assert!(paracord_db::key_backups::get(&app.db, owner_id)
        .await
        .unwrap()
        .is_some());
    let owner = paracord_db::users::get_user_by_id(&app.db, owner_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(owner.flags & paracord_core::USER_FLAG_ADMIN, 0);

    let space = paracord_db::guilds::get_guild(&app.db, space_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(space.name, "Friday Night Crew");
    assert_eq!(space.hue, Some(150));
    let mut channels = paracord_db::channels::get_guild_channels(&app.db, space_id)
        .await
        .unwrap();
    channels.sort_by_key(|c| c.position);
    let shape: Vec<(String, i16, Option<String>)> = channels
        .into_iter()
        .map(|c| (c.name.unwrap_or_default(), c.channel_type, c.topic))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("general".into(), 0, Some("Say hi to everyone".into())),
            (
                "clips".into(),
                0,
                Some("Share highlights and screenshots".into())
            ),
            ("plans".into(), 0, Some("What's happening this week".into())),
            ("Lounge".into(), 2, None),
            ("Gaming".into(), 2, None),
        ]
    );

    let setup = paracord_db::instance_setup::get(&app.db).await.unwrap();
    assert!(!setup.is_pending());
    assert!(setup.claim_token_hash.is_none(), "single use");
    assert_eq!(
        login(&app, "sam@example.com", &cred.auth()).await.0,
        StatusCode::OK
    );
}
