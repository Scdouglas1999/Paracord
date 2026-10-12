//! The OS credential store, from the app's side: the preflight roundtrip probe
//! (spec §2.3) and deleting the storage key when the owner removes the server
//! with its data.
//!
//! The key itself is generated, stored and verified by the host binary
//! (`paracord-host init --profile desktop-host`, which provisions through
//! `at_rest_boot` in the server crate). This module mirrors that module's
//! probe on purpose: the same service name, a uniquely named
//! `probe:<uuid>` account, the value read back through a *fresh* entry (a
//! mock store would answer the cached one), then deleted.

/// `[at_rest] keychain_service` of the desktop-host profile.
pub const KEYCHAIN_SERVICE: &str = "Paracord";

/// `[at_rest] keychain_account` of the desktop-host profile.
pub fn storage_key_account(instance_id: &str) -> String {
    format!("host-storage-key:{instance_id}")
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
mod platform {
    fn store_name() -> &'static str {
        if cfg!(target_os = "linux") {
            "Secret Service"
        } else if cfg!(target_os = "macos") {
            "Keychain"
        } else {
            "Credential Manager"
        }
    }

    fn describe(error: &keyring::Error) -> String {
        match error {
            keyring::Error::NoStorageAccess(e) | keyring::Error::PlatformFailure(e) => format!(
                "the system keychain is locked or not running ({}: {e})",
                store_name()
            ),
            keyring::Error::NoEntry => "the system keychain has no such entry".into(),
            other => format!("the system keychain refused ({}: {other})", store_name()),
        }
    }

    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account).map_err(|e| describe(&e))
    }

    pub fn probe(service: &str) -> Result<(), String> {
        let account = format!("probe:{}", uuid::Uuid::new_v4());
        let value = format!("probe-{}", uuid::Uuid::new_v4());
        let written = (|| {
            entry(service, &account)?
                .set_password(&value)
                .map_err(|e| describe(&e))?;
            match entry(service, &account)?.get_password() {
                Ok(back) if back == value => Ok(()),
                Ok(_) => Err(
                    "the system keychain returned a different value than was stored".to_string(),
                ),
                Err(e) => Err(format!(
                    "the system keychain did not keep the entry ({})",
                    describe(&e)
                )),
            }
        })();
        let deleted = delete(service, &account);
        written?;
        deleted.map_err(|e| format!("the system keychain kept a probe entry ({e})"))
    }

    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    pub fn probe(_: &str) -> Result<(), String> {
        Err("this platform has no supported system keychain".into())
    }
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Err("this platform has no supported system keychain".into())
    }
}

/// Write, read back and delete a probe entry. `Err` is the reason, in words.
pub fn probe(service: &str) -> Result<(), String> {
    platform::probe(service)
}

/// Delete an entry; a missing one is not an error.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    platform::delete(service, account)
}
