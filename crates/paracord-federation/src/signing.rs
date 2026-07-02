use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;

use crate::{hex_decode, hex_encode, FederationError};

/// Generate a new ed25519 keypair. Returns (signing_key, public_key_hex).
pub fn generate_keypair() -> (SigningKey, String) {
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    let signing_key = SigningKey::from_bytes(&secret);
    let public_hex = hex_encode(&signing_key.verifying_key().to_bytes());
    (signing_key, public_hex)
}

/// Export a signing key as a hex string (64 hex chars = 32 bytes).
pub fn signing_key_to_hex(key: &SigningKey) -> String {
    hex_encode(&key.to_bytes())
}

/// Import a signing key from a hex string.
pub fn signing_key_from_hex(hex: &str) -> Result<SigningKey, FederationError> {
    let bytes = hex_decode(hex).ok_or(FederationError::MissingSigningKey)?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| FederationError::MissingSigningKey)?;
    Ok(SigningKey::from_bytes(&arr))
}

/// Sign arbitrary bytes with the given signing key, returning the signature as hex.
pub fn sign(key: &SigningKey, payload: &[u8]) -> String {
    let sig = key.sign(payload);
    hex_encode(&sig.to_bytes())
}

/// Verify a signature given the payload, signature hex, and public key hex.
pub fn verify(
    payload: &[u8],
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<(), FederationError> {
    let sig_bytes = hex_decode(signature_hex).ok_or(FederationError::InvalidSignature)?;
    let pk_bytes = hex_decode(public_key_hex).ok_or(FederationError::InvalidSignature)?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|_| FederationError::InvalidSignature)?;
    let pk_arr: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| FederationError::InvalidSignature)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_arr).map_err(|_| FederationError::InvalidSignature)?;
    verifying_key
        .verify(payload, &signature)
        .map_err(|_| FederationError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypair_round_trip() {
        let (key, public_hex) = generate_keypair();
        let hex = signing_key_to_hex(&key);
        let restored = signing_key_from_hex(&hex).unwrap();
        assert_eq!(hex_encode(&restored.verifying_key().to_bytes()), public_hex);
    }

    #[test]
    fn sign_and_verify() {
        let (key, public_hex) = generate_keypair();
        let payload = b"hello federation";
        let sig = sign(&key, payload);
        verify(payload, &sig, &public_hex).unwrap();
    }

    #[test]
    fn verify_rejects_tampered_payload() {
        let (key, public_hex) = generate_keypair();
        let sig = sign(&key, b"original");
        let result = verify(b"tampered", &sig, &public_hex);
        assert!(result.is_err());
    }

    #[test]
    fn verify_rejects_wrong_length_signature() {
        let (_key, public_hex) = generate_keypair();
        // 4 hex chars = 2 bytes, far short of a 64-byte ed25519 signature.
        let result = verify(b"payload", "abcd", &public_hex);
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }

    #[test]
    fn verify_rejects_non_hex_signature() {
        let (_key, public_hex) = generate_keypair();
        let result = verify(b"payload", "zzzz", &public_hex);
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }

    #[test]
    fn verify_rejects_empty_signature() {
        let (_key, public_hex) = generate_keypair();
        let result = verify(b"payload", "", &public_hex);
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }

    #[test]
    fn verify_rejects_multibyte_signature_without_panic() {
        let (_key, public_hex) = generate_keypair();
        // Even byte-length multi-byte UTF-8 input must return an error, never
        // panic on a mid-codepoint slice.
        let result = verify(b"payload", "ffé", &public_hex);
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }

    #[test]
    fn verify_rejects_all_zero_public_key() {
        let (key, _public_hex) = generate_keypair();
        let sig = sign(&key, b"payload");
        // 32 zero bytes is not a valid ed25519 point (small-order / rejected).
        let zero_pk = hex_encode(&[0u8; 32]);
        let result = verify(b"payload", &sig, &zero_pk);
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }

    #[test]
    fn verify_rejects_wrong_length_public_key() {
        let (key, _public_hex) = generate_keypair();
        let sig = sign(&key, b"payload");
        // Valid hex but only 2 bytes, not 32.
        let result = verify(b"payload", &sig, "abcd");
        assert!(matches!(result, Err(FederationError::InvalidSignature)));
    }
}
