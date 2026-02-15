use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use ed25519_dalek::{Signature, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use paracord_util::hex::{hex_decode, hex_encode};
use rand::Rng;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("token expired")]
    TokenExpired,
    #[error("invalid token")]
    InvalidToken,
    #[error("registration disabled")]
    RegistrationDisabled,
    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub exp: usize,
    pub iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pub_key: Option<String>,
}

pub fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AuthError::Internal(e.to_string()))
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, AuthError> {
    let parsed = PasswordHash::new(hash).map_err(|e| AuthError::Internal(e.to_string()))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

pub fn create_token(user_id: i64, secret: &str, expiry_secs: u64) -> Result<String, AuthError> {
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: user_id,
        iat: now,
        exp: now + expiry_secs as usize,
        pub_key: None,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AuthError::Internal(e.to_string()))
}

pub fn create_token_with_pubkey(
    user_id: i64,
    public_key: &str,
    secret: &str,
    expiry_secs: u64,
) -> Result<String, AuthError> {
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: user_id,
        iat: now,
        exp: now + expiry_secs as usize,
        pub_key: Some(public_key.to_string()),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AuthError::Internal(e.to_string()))
}

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, AuthError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AuthError::InvalidToken)
}

/// Generate a challenge nonce (32 random bytes as hex)
pub fn generate_challenge() -> (String, i64) {
    let mut nonce_bytes = [0u8; 32];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = hex_encode(&nonce_bytes);
    let timestamp = chrono::Utc::now().timestamp();
    (nonce, timestamp)
}

/// Verify a signed challenge.
/// The client signs: "nonce:timestamp:server_origin" as UTF-8 bytes.
pub fn verify_challenge(
    public_key_hex: &str,
    nonce: &str,
    timestamp: i64,
    server_origin: &str,
    signature_hex: &str,
) -> Result<bool, AuthError> {
    // Check timestamp freshness (within 60 seconds)
    let now = chrono::Utc::now().timestamp();
    if (now - timestamp).abs() > 60 {
        return Ok(false);
    }

    // Build the message
    let message = format!("{}:{}:{}", nonce, timestamp, server_origin);

    // Decode public key
    let public_key_bytes =
        hex_decode(public_key_hex).ok_or(AuthError::Internal("invalid public key hex".into()))?;
    let key_bytes: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| AuthError::Internal("invalid public key length".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| AuthError::Internal("invalid public key".into()))?;

    // Decode signature
    let sig_bytes =
        hex_decode(signature_hex).ok_or(AuthError::Internal("invalid signature hex".into()))?;
    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|_| AuthError::Internal("invalid signature".into()))?;

    // Verify
    Ok(verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .is_ok())
}

