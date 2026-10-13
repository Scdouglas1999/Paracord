//! `paracord-server escrow-key`: the owner's recovery phrase → the escrow key
//! that `restore-backup --escrow-key-stdin` takes (docs/setup-spec.md §4.7,
//! §4.8), for restoring an encrypted server by hand:
//!
//! ```text
//! paracord-server escrow-key --archive backup.tar.gz \
//!   | paracord-server -c paracord.toml restore-backup --archive backup.tar.gz \
//!       --output-dir restored --escrow-key-stdin
//! ```
//!
//! The phrase is read from standard input (one line), never from the command
//! line. It is the identity private key itself (256 bits + an 8-bit SHA-256
//! checksum as 24 BIP39 words; the client's `lib/credential/phrase.ts`), and
//! the escrow key is `HKDF-SHA256(ikm = private key, salt =
//! "paracord/host-storage-escrow/v1", info = instance id)`. With `--archive`
//! the instance id comes from the archive's escrow, and the phrase is checked
//! against the escrow's owner public key first, so a wrong phrase is named as
//! such instead of failing later as an unreadable escrow. Only the key is
//! printed (b64url, one line).

use anyhow::{bail, Context, Result};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::cli::EscrowKeyArgs;

/// The standard BIP39 English list, byte for byte (pinned by its SHA-256 in
/// the tests). A wire format: never respelled.
const WORDLIST: &str = include_str!("../data/bip39-english.txt");

/// Phrases shown while the client's copy said "artifact" (word 103) still
/// parse, exactly as `BIP39_WORD_ALIASES` in the client does.
const ALIASES: &[(&str, &str)] = &[("artifact", "artefact")];

pub fn run(args: &EscrowKeyArgs) -> Result<()> {
    let escrow = match &args.archive {
        Some(archive) => Some(
            paracord_core::backup::read_archive_manifest(archive)
                .with_context(|| format!("{} is not a Paracord backup", archive.display()))?
                .recovery
                .and_then(|r| r.key_escrow)
                .context(
                    "this archive carries no escrowed storage key (it was made before the owner escrowed one), so no recovery phrase can unlock it",
                )?,
        ),
        None => None,
    };
    let instance_id = match (&args.instance_id, &escrow) {
        (Some(id), _) => id.clone(),
        (None, Some(escrow)) => escrow.instance_id.clone(),
        (None, None) => bail!("give --archive (the backup to restore) or --instance-id"),
    };
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .context("cannot read the recovery phrase from standard input")?;
    let key = escrow_key_for(
        &line,
        &instance_id,
        escrow.as_ref().map(|e| e.owner_public_key.as_str()),
    );
    let public_key = args.json.then(|| {
        private_key_from_phrase(&line).map(|mut private_key| {
            let public_key = public_key_hex(&private_key);
            private_key.fill(0);
            public_key
        })
    });
    line.replace_range(.., &" ".repeat(line.len()));
    let key = key?;
    match public_key {
        // The escrow endpoint wants the identity key the escrow key came from.
        Some(public_key) => println!(
            "{}",
            serde_json::json!({ "wrapping_key": key, "owner_public_key": public_key? })
        ),
        None => println!("{key}"),
    }
    Ok(())
}

/// The b64url escrow key for `phrase` and `instance_id`; with
/// `owner_public_key`, refuses a phrase that is not the owner's.
pub fn escrow_key_for(
    phrase: &str,
    instance_id: &str,
    owner_public_key: Option<&str>,
) -> Result<String> {
    if instance_id.trim().is_empty() {
        bail!("the instance id is empty");
    }
    let mut private_key = private_key_from_phrase(phrase)?;
    let result = (|| {
        if let Some(expected) = owner_public_key {
            let public_key = public_key_hex(&private_key);
            if !public_key.eq_ignore_ascii_case(expected.trim()) {
                bail!(
                    "that recovery phrase is not the one of this server's owner (its key is {public_key}; the archive's escrow was made for {expected})"
                );
            }
        }
        let mut escrow_key = paracord_util::at_rest::derive_escrow_key(&private_key, instance_id);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(escrow_key);
        escrow_key.fill(0);
        Ok(encoded)
    })();
    private_key.fill(0);
    result
}

/// 24 words → the 32-byte identity private key. Numbering ("1." or "1)") as
/// in the saved phrase file is ignored. The checksum is the first byte of the
/// key's SHA-256; the legacy XOR fold the client still accepts is accepted.
pub fn private_key_from_phrase(phrase: &str) -> Result<[u8; 32]> {
    let words: Vec<String> = phrase
        .split_whitespace()
        .filter(|token| {
            !token
                .trim_end_matches(['.', ')'])
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .map(|w| w.to_lowercase())
        .collect();
    if words.len() != 24 {
        bail!(
            "a recovery phrase is exactly 24 words; this has {}",
            words.len()
        );
    }
    let list: Vec<&str> = WORDLIST.lines().collect();
    let mut bytes = [0_u8; 33];
    let mut written = 0;
    let mut bits = 0_u32;
    let mut accumulator = 0_u32;
    for word in &words {
        let word = ALIASES
            .iter()
            .find(|(alias, _)| alias == word)
            .map(|(_, real)| *real)
            .unwrap_or(word.as_str());
        let index = list
            .iter()
            .position(|w| *w == word)
            .with_context(|| format!("\"{word}\" isn't a recovery phrase word"))?;
        accumulator = ((accumulator << 11) | index as u32) & 0x00ff_ffff;
        bits += 11;
        while bits >= 8 {
            bits -= 8;
            bytes[written] = ((accumulator >> bits) & 0xff) as u8;
            written += 1;
        }
    }
    let mut private_key = [0_u8; 32];
    private_key.copy_from_slice(&bytes[..32]);
    let checksum = bytes[32];
    bytes.fill(0);
    let legacy = private_key.iter().fold(0_u8, |acc, b| acc ^ b);
    if Sha256::digest(private_key)[0] != checksum && legacy != checksum {
        private_key.fill(0);
        bail!("that recovery phrase doesn't check out; look for a mistyped word");
    }
    Ok(private_key)
}

fn to_hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn public_key_hex(private_key: &[u8; 32]) -> String {
    let signing = ed25519_dalek::SigningKey::from_bytes(private_key);
    to_hex(signing.verifying_key().to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors the client and the API tests share (vectors.reference.mjs).
    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../paracord-api/tests/fixtures/credential_vectors.json"
        ))
        .unwrap()
    }

    #[test]
    fn the_wordlist_is_the_standard_bip39_list() {
        let digest = to_hex(Sha256::digest(WORDLIST.as_bytes()));
        assert_eq!(
            digest,
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        );
        assert_eq!(WORDLIST.lines().count(), 2048);
    }

    #[test]
    fn the_phrase_vector_is_the_identity_key() {
        let v = vectors();
        let phrase = &v["phrase"][0];
        let key = private_key_from_phrase(phrase["phrase"].as_str().unwrap()).unwrap();
        assert_eq!(to_hex(key), phrase["private_key_hex"].as_str().unwrap());
        assert_eq!(public_key_hex(&key), phrase["public_key"].as_str().unwrap());
    }

    #[test]
    fn the_phrase_gives_the_escrow_vector_key() {
        let v = vectors();
        let phrase = v["phrase"][0]["phrase"].as_str().unwrap();
        let escrow = &v["escrow"][0];
        assert_eq!(
            escrow["private_key_hex"], v["phrase"][0]["private_key_hex"],
            "the escrow vector uses the phrase vector's identity"
        );
        let key = escrow_key_for(
            phrase,
            escrow["instance_id"].as_str().unwrap(),
            Some(v["phrase"][0]["public_key"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(key, escrow["wrapping_key"].as_str().unwrap());
    }

    #[test]
    fn numbering_case_and_the_old_spelling_are_accepted() {
        let v = vectors();
        let phrase = v["phrase"][0]["phrase"].as_str().unwrap();
        let numbered: String = phrase
            .split(' ')
            .enumerate()
            .map(|(i, w)| format!("{}. {} ", i + 1, w.to_uppercase()))
            .collect();
        assert_eq!(
            private_key_from_phrase(&numbered).unwrap(),
            private_key_from_phrase(phrase).unwrap()
        );
        // "artifact" parses as word 103 ("artefact").
        let mut words = vec!["abandon"; 23];
        words.insert(0, "artifact");
        let err = private_key_from_phrase(&words.join(" "))
            .unwrap_err()
            .to_string();
        assert!(err.contains("doesn't check out"), "{err}");
    }

    #[test]
    fn wrong_phrases_are_named() {
        let v = vectors();
        let phrase = v["phrase"][0]["phrase"].as_str().unwrap();
        let err = escrow_key_for(phrase, "id", Some(&"00".repeat(32)))
            .unwrap_err()
            .to_string();
        assert!(err.contains("not the one of this server's owner"), "{err}");

        let err = private_key_from_phrase("spot flush pizza")
            .unwrap_err()
            .to_string();
        assert!(err.contains("exactly 24 words"), "{err}");

        let typo = phrase.replacen("pizza", "pizzza", 1);
        let err = private_key_from_phrase(&typo).unwrap_err().to_string();
        assert!(
            err.contains("\"pizzza\" isn't a recovery phrase word"),
            "{err}"
        );

        let swapped = phrase.replacen("spot flush", "flush spot", 1);
        let err = private_key_from_phrase(&swapped).unwrap_err().to_string();
        assert!(err.contains("doesn't check out"), "{err}");
    }
}
