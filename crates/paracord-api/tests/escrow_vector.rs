//! The storage-key escrow vector (docs/setup-spec.md §4.7) shared with the
//! client: `tests/fixtures/credential_vectors.json` `escrow[]`, written by
//! `client/src/lib/credential/vectors.reference.mjs` from node:crypto alone.
//! The server derives the same escrow key from the owner's identity key and
//! opens the reference's sealed storage key, and only for its own instance.

use paracord_util::at_rest::{derive_escrow_key, open_escrow, EscrowError};
use paracord_util::hex::{hex_decode, hex_encode};
use serde_json::Value;

fn vectors() -> Value {
    let raw = include_str!("fixtures/credential_vectors.json");
    serde_json::from_str(raw).expect("credential vectors parse")
}

fn bytes(v: &Value, field: &str) -> Vec<u8> {
    hex_decode(
        v[field]
            .as_str()
            .unwrap_or_else(|| panic!("{field} missing")),
    )
    .unwrap_or_else(|| panic!("{field} is not hex"))
}

#[test]
fn escrow_vector_matches_the_server_derivation() {
    let all = vectors();
    assert_eq!(
        all["labels"]["escrow_salt"],
        "paracord/host-storage-escrow/v1"
    );
    let cases = all["escrow"].as_array().expect("escrow vectors");
    assert!(!cases.is_empty());
    for case in cases {
        let instance = case["instance_id"].as_str().unwrap();
        let identity = bytes(case, "private_key_hex");
        assert_eq!(
            hex_encode(&identity),
            all["wrap"][0]["private_key_hex"].as_str().unwrap(),
            "the escrow vector uses the credential vectors' identity"
        );

        let key = derive_escrow_key(&identity, instance);
        assert_eq!(hex_encode(&key), case["escrow_key_hex"].as_str().unwrap());
        // What the client sends as `wrapping_key`.
        use base64::Engine as _;
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
            case["wrapping_key"].as_str().unwrap()
        );

        let iv = bytes(case, "iv_hex");
        let ciphertext = bytes(case, "ciphertext_hex");
        let opened = open_escrow(&iv, &ciphertext, &key, instance).expect("opens");
        assert_eq!(
            hex_encode(&opened),
            case["storage_key_hex"].as_str().unwrap()
        );
        assert_eq!(
            open_escrow(&iv, &ciphertext, &key, "another-instance"),
            Err(EscrowError::WrongKey)
        );
    }
}
