use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use ed25519_dalek::{Signature, VerifyingKey};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
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
    pub sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pub_key: Option<String>,
}

fn create_token_internal(
    user_id: i64,
    public_key: Option<&str>,
    secret: &str,
    expiry_secs: u64,
    session_id: Option<&str>,
    jti: Option<&str>,
) -> Result<String, AuthError> {
    let now = chrono::Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: user_id,
        iat: now,
        exp: now + expiry_secs as usize,
        sid: session_id.map(str::to_string),
        jti: jti.map(str::to_string),
        pub_key: public_key.map(str::to_string),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AuthError::Internal(e.to_string()))
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
    create_token_internal(user_id, None, secret, expiry_secs, None, None)
}

pub fn create_token_with_pubkey(
    user_id: i64,
    public_key: &str,
    secret: &str,
    expiry_secs: u64,
) -> Result<String, AuthError> {
    create_token_internal(user_id, Some(public_key), secret, expiry_secs, None, None)
}

pub fn create_session_token(
    user_id: i64,
    public_key: Option<&str>,
    secret: &str,
    expiry_secs: u64,
    session_id: &str,
    jti: &str,
) -> Result<String, AuthError> {
    create_token_internal(
        user_id,
        public_key,
        secret,
        expiry_secs,
        Some(session_id),
        Some(jti),
    )
}

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, AuthError> {
    let validation = Validation::new(Algorithm::HS256);
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_tokens_include_sid_and_jti_claims() {
        let secret = "test-secret";
        let token =
            create_session_token(42, None, secret, 60, "sid-1", "jti-1").expect("create token");
        let claims = validate_token(&token, secret).expect("validate token");
        assert_eq!(claims.sub, 42);
        assert_eq!(claims.sid.as_deref(), Some("sid-1"));
        assert_eq!(claims.jti.as_deref(), Some("jti-1"));
    }

    #[test]
    fn legacy_tokens_do_not_require_session_claims() {
        let secret = "test-secret";
        let token = create_token(7, secret, 60).expect("create token");
        let claims = validate_token(&token, secret).expect("validate token");
        assert_eq!(claims.sub, 7);
        assert!(claims.sid.is_none());
        assert!(claims.jti.is_none());
    }

    #[test]
    fn create_token_produces_valid_jwt() {
        let secret = "my-secret-key";
        let token = create_token(1, secret, 3600).expect("create token");
        assert!(!token.is_empty());
        let claims = validate_token(&token, secret).expect("validate");
        assert_eq!(claims.sub, 1);
    }

    #[test]
    fn validate_token_wrong_secret_fails() {
        let token = create_token(1, "secret-a", 3600).expect("create token");
        let result = validate_token(&token, "secret-b");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AuthError::InvalidToken));
    }

    #[test]
    fn validate_token_garbage_input_fails() {
        let result = validate_token("not.a.real.token", "secret");
        assert!(matches!(result.unwrap_err(), AuthError::InvalidToken));
    }

    #[test]
    fn token_with_pubkey_roundtrips() {
        let secret = "test-secret";
        let token = create_token_with_pubkey(5, "deadbeef", secret, 3600).expect("create token");
        let claims = validate_token(&token, secret).expect("validate");
        assert_eq!(claims.sub, 5);
        assert_eq!(claims.pub_key.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn token_expiry_is_set_correctly() {
        let secret = "test-secret";
        let token = create_token(1, secret, 7200).expect("create token");
        let claims = validate_token(&token, secret).expect("validate");
        assert!(claims.exp > claims.iat);
        assert_eq!(claims.exp - claims.iat, 7200);
    }

    #[test]
    fn hash_and_verify_password() {
        let password = "my_secure_password";
        let hashed = hash_password(password).expect("hash");
        assert_ne!(hashed, password);
        assert!(verify_password(password, &hashed).expect("verify"));
    }

    #[test]
    fn verify_password_wrong_input_returns_false() {
        let hashed = hash_password("correct_password").expect("hash");
        let result = verify_password("wrong_password", &hashed).expect("verify");
        assert!(!result);
    }

    #[test]
    fn verify_password_invalid_hash_returns_error() {
        let result = verify_password("anything", "not-a-valid-hash");
        assert!(result.is_err());
    }

    #[test]
    fn hex_encode_decode_roundtrip() {
        let original = b"hello world";
        let encoded = hex_encode(original);
        assert_eq!(encoded, "68656c6c6f20776f726c64");
        let decoded = hex_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn hex_decode_odd_length_returns_none() {
        assert!(hex_decode("abc").is_none());
    }

    #[test]
    fn hex_decode_invalid_chars_returns_none() {
        assert!(hex_decode("zzzz").is_none());
    }

    #[test]
    fn generate_challenge_produces_valid_nonce() {
        let (nonce, timestamp) = generate_challenge();
        // Nonce should be 64 hex chars (32 bytes)
        assert_eq!(nonce.len(), 64);
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(timestamp > 0);
    }

    #[test]
    fn generate_challenge_produces_unique_nonces() {
        let (nonce1, _) = generate_challenge();
        let (nonce2, _) = generate_challenge();
        assert_ne!(nonce1, nonce2);
    }
}
